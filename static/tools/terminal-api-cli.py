#!/usr/bin/env python3
"""Command-line client and maintenance interface for the Speciedex Terminal API."""
from __future__ import annotations

import argparse
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

TOOLS_ROOT = Path(__file__).resolve().parent
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

from terminal.config import APIConfig
from terminal.server import TerminalAPIServer


def request_json(base_url: str, path: str, params: dict[str, str]) -> object:
    url = urllib.parse.urljoin(base_url.rstrip("/") + "/", path.lstrip("/"))
    if params:
        url += "?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="terminal-api-cli.py")
    parser.add_argument("--repo-root", type=Path)
    parser.add_argument("--config", type=Path)
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve")
    serve.add_argument("--host")
    serve.add_argument("--port", type=int)

    sub.add_parser("check")
    sub.add_parser("build-static")

    call = sub.add_parser("call")
    call.add_argument("path")
    call.add_argument("params", nargs="*")
    call.add_argument("--base-url", default="http://127.0.0.1:8765/api/speciedex/v1/")

    return parser


def main() -> int:
    args = build_parser().parse_args()
    config = APIConfig.load(args.config, args.repo_root)
    server = TerminalAPIServer(config)

    if args.command == "serve":
        if args.host:
            config.host = args.host
        if args.port:
            config.port = args.port
        server.serve_forever()
        return 0

    if args.command == "check":
        report = server.check()
        print(report.to_json())
        return 0 if report.ok else 1

    if args.command == "build-static":
        print(json.dumps(server.generate_static(), indent=2, sort_keys=True))
        return 0

    params: dict[str, str] = {}
    for item in args.params:
        key, separator, value = item.partition("=")
        params[key] = value if separator else "true"
    print(json.dumps(request_json(args.base_url, args.path, params), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
