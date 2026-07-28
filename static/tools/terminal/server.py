from __future__ import annotations

import json
import logging
import mimetypes
import threading
import urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from .cache import TTLCache
from .config import APIConfig
from .database import Database
from .manifests import ManifestService
from .models import APIResponse, HealthReport
from .providers import ProviderService
from .rate_limit import RateLimiter
from .router import Router
from .search import SearchService
from .static_builder import StaticAPIBuilder
from .stats import StatsService
from .stream import StreamService

LOGGER = logging.getLogger("speciedex.terminal.api")


class TerminalAPIServer:
    def __init__(self, config: APIConfig) -> None:
        self.config = config
        self.database = Database(config.sqlite_path)
        self.search = SearchService(self.database, config.max_results)
        self.stats = StatsService(self.database, config.taxonomy_root)
        self.providers = ProviderService(config.repo_root)
        self.stream = StreamService(config.taxonomy_root, config.stream_interval_ms)
        self.manifests = ManifestService(config.repo_root)
        self.cache = TTLCache(limit=512, ttl=30)
        self.rate_limiter = RateLimiter(config.rate_limit_per_minute)
        self.router = Router()
        self._httpd: ThreadingHTTPServer | None = None
        self._register_routes()

    def _register_routes(self) -> None:
        self.router.add("GET", "/health", lambda q, b: APIResponse(200, self.health_payload()))
        self.router.add("GET", "/stats", lambda q, b: APIResponse(200, self.stats.collect()))
        self.router.add("GET", "/providers", lambda q, b: APIResponse(200, self.providers.list()))
        self.router.add("GET", "/routes", lambda q, b: APIResponse(200, self.routes_payload()))
        self.router.add("GET", "/search", self._search)
        self.router.add("POST", "/search", self._search_post)
        self.router.add("GET", "/manifests", self._manifests)
        self.router.add("GET", "/checksums", self._manifests)
        self.router.add("GET", "/benchmark", lambda q, b: APIResponse(200, {"ok": True}))
        self.router.add("GET", "/", lambda q, b: APIResponse(200, self.routes_payload()))

    def _search(self, query: dict[str, list[str]], body: bytes) -> APIResponse:
        term = (query.get("q") or query.get("query") or [""])[0]
        limit = int((query.get("limit") or ["100"])[0])
        offset = int((query.get("offset") or ["0"])[0])
        return APIResponse(200, self.search.search(term, limit, offset))

    def _search_post(self, query: dict[str, list[str]], body: bytes) -> APIResponse:
        payload = json.loads(body.decode("utf-8") or "{}")
        return APIResponse(
            200,
            self.search.search(
                str(payload.get("q") or payload.get("query") or ""),
                int(payload.get("limit", 100)),
                int(payload.get("offset", 0)),
            ),
        )

    def _manifests(self, query: dict[str, list[str]], body: bytes) -> APIResponse:
        payload = self.manifests.build([
            self.config.taxonomy_root,
            self.config.static_api_root,
        ])
        return APIResponse(200, payload)

    def health_payload(self) -> dict[str, Any]:
        report = self.check()
        return report.to_dict()

    def check(self) -> HealthReport:
        checks: dict[str, Any] = {
            "repo_root": {"ok": self.config.repo_root.exists(), "path": str(self.config.repo_root)},
            "taxonomy_root": {"ok": self.config.taxonomy_root.exists(), "path": str(self.config.taxonomy_root)},
            "sqlite": {"ok": self.config.sqlite_path.exists(), "path": str(self.config.sqlite_path)},
            "static_api_root": {"ok": True, "path": str(self.config.static_api_root)},
        }
        required = ("repo_root",)
        ok = all(checks[name]["ok"] for name in required)
        return HealthReport(ok=ok, checks=checks)

    def routes_payload(self) -> dict[str, Any]:
        return {
            "name": "Speciedex Terminal API",
            "version": "1.0.0",
            "prefix": self.config.api_prefix,
            "routes": [
                {"method": method, "path": path}
                for method, path in sorted(self.router.routes)
            ] + [
                {"method": "GET", "path": "/stream"},
                {"method": "GET", "path": "/static/*"},
            ],
        }

    def generate_static(self) -> dict[str, Any]:
        result = StaticAPIBuilder(self).build()
        manifest = self.manifests.write(
            self.config.static_api_root / "manifest.json",
            [self.config.static_api_root],
        )
        result["manifest"] = manifest
        return result

    def serve_forever(self) -> None:
        outer = self

        class Handler(BaseHTTPRequestHandler):
            server_version = "SpeciedexTerminalAPI/1.0"

            def log_message(self, format: str, *args: object) -> None:
                LOGGER.info("%s - %s", self.address_string(), format % args)

            def _cors(self) -> None:
                origin = self.headers.get("Origin", "*")
                allowed = "*" if "*" in outer.config.cors_origins else origin
                self.send_header("Access-Control-Allow-Origin", allowed)
                self.send_header("Access-Control-Allow-Headers", "Accept, Content-Type, Authorization")
                self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")

            def _send_json(self, response: APIResponse) -> None:
                payload = json.dumps(response.payload, default=str, separators=(",", ":")).encode("utf-8")
                self.send_response(response.status)
                self._cors()
                for key, value in (response.headers or {}).items():
                    self.send_header(key, value)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(payload)

            def _client_key(self) -> str:
                forwarded = self.headers.get("X-Forwarded-For")
                return forwarded.split(",", 1)[0].strip() if forwarded else self.client_address[0]

            def do_OPTIONS(self) -> None:
                self.send_response(204)
                self._cors()
                self.end_headers()

            def do_HEAD(self) -> None:
                self.do_GET()

            def do_GET(self) -> None:
                if not outer.rate_limiter.allow(self._client_key()):
                    self._send_json(APIResponse(429, {"error": "rate_limited"}))
                    return

                parsed = urllib.parse.urlsplit(self.path)
                prefix = outer.config.api_prefix.rstrip("/")
                if not parsed.path.startswith(prefix):
                    self._send_json(APIResponse(404, {"error": "not_found"}))
                    return

                relative = parsed.path[len(prefix):] or "/"
                query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)

                if relative.rstrip("/") == "/stream":
                    self.send_response(200)
                    self._cors()
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Connection", "keep-alive")
                    self.end_headers()
                    try:
                        limit = int((query.get("limit") or ["100"])[0])
                        for chunk in outer.stream.iter_records(limit=max(1, min(10000, limit))):
                            self.wfile.write(chunk.encode("utf-8"))
                            self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        pass
                    return

                response = outer.router.dispatch("GET", relative, query, b"")
                self._send_json(response)

            def do_POST(self) -> None:
                if not outer.rate_limiter.allow(self._client_key()):
                    self._send_json(APIResponse(429, {"error": "rate_limited"}))
                    return
                parsed = urllib.parse.urlsplit(self.path)
                prefix = outer.config.api_prefix.rstrip("/")
                if not parsed.path.startswith(prefix):
                    self._send_json(APIResponse(404, {"error": "not_found"}))
                    return
                relative = parsed.path[len(prefix):] or "/"
                query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
                length = min(int(self.headers.get("Content-Length", "0") or 0), 10 * 1024 * 1024)
                body = self.rfile.read(length)
                try:
                    response = outer.router.dispatch("POST", relative, query, body)
                except (ValueError, json.JSONDecodeError) as error:
                    response = APIResponse(400, {"error": "bad_request", "message": str(error)})
                except Exception as error:
                    LOGGER.exception("Unhandled API error")
                    response = APIResponse(500, {"error": "internal_error", "message": str(error)})
                self._send_json(response)

        self._httpd = ThreadingHTTPServer((self.config.host, self.config.port), Handler)
        LOGGER.info(
            "Speciedex Terminal API listening on http://%s:%s%s/",
            self.config.host,
            self.config.port,
            self.config.api_prefix,
        )
        try:
            self._httpd.serve_forever(poll_interval=0.5)
        finally:
            self._httpd.server_close()

    def shutdown(self) -> None:
        if self._httpd:
            self._httpd.shutdown()
