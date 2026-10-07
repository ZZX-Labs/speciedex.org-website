from __future__ import annotations

import json
import os
from collections import Counter
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable


TRUE_VALUES = {"1", "true", "yes", "on", "enabled", "available"}
FALSE_VALUES = {"0", "false", "no", "off", "disabled", "unavailable"}


class ProviderService:
    """Canonical provider-registry service used by the terminal API.

    The registry under ``static/tools/providers.json`` is authoritative.  The
    older files under ``static/data/db`` are browser snapshots and must never
    replace the canonical registry merely because they happen to exist.
    """

    def __init__(self, repo_root: Path) -> None:
        self.repo_root = repo_root.resolve()
        self.registry_path = self.repo_root / "static/tools/providers.json"
        self.taxonomy_root = self.repo_root / "static/data/taxonomy"
        self.conformance_path = self.repo_root / "static/data/provider-conformance.json"
        self._registry_mtime_ns: int | None = None
        self._conformance_mtime_ns: int | None = None
        self._conformance_map: dict[str, dict[str, Any]] = {}
        self._providers: list[dict[str, Any]] = []
        self._provider_map: dict[str, dict[str, Any]] = {}
        self._record_counts: dict[str, int] | None = None

    def _read_registry(self) -> list[dict[str, Any]]:
        if not self.registry_path.exists():
            return []
        stat = self.registry_path.stat()
        if self._providers and self._registry_mtime_ns == stat.st_mtime_ns:
            return self._providers

        data = json.loads(self.registry_path.read_text(encoding="utf-8"))
        raw = data.get("providers", data) if isinstance(data, dict) else data
        providers = [dict(item) for item in raw if isinstance(item, dict)]
        self._providers = providers
        self._provider_map = {
            str(item.get("name") or item.get("id") or "").strip().lower(): item
            for item in providers
            if str(item.get("name") or item.get("id") or "").strip()
        }
        self._registry_mtime_ns = stat.st_mtime_ns
        self._record_counts = None
        return self._providers

    def _read_conformance(self) -> dict[str, dict[str, Any]]:
        if not self.conformance_path.exists():
            return {}
        stat = self.conformance_path.stat()
        if self._conformance_map and self._conformance_mtime_ns == stat.st_mtime_ns:
            return self._conformance_map
        try:
            data = json.loads(self.conformance_path.read_text(encoding="utf-8"))
        except Exception:
            return {}
        results = data.get("results", []) if isinstance(data, dict) else []
        self._conformance_map = {
            str(item.get("provider") or "").strip().lower(): dict(item)
            for item in results
            if isinstance(item, dict) and str(item.get("provider") or "").strip()
        }
        self._conformance_mtime_ns = stat.st_mtime_ns
        return self._conformance_map

    @staticmethod
    def _bool(value: Any, default: bool | None = None) -> bool | None:
        if isinstance(value, bool):
            return value
        if value is None or value == "":
            return default
        text = str(value).strip().lower()
        if text in TRUE_VALUES:
            return True
        if text in FALSE_VALUES:
            return False
        return default

    def _configured_path_status(self, definition: dict[str, Any]) -> tuple[bool, str | None]:
        configured = definition.get("path")
        if not configured:
            return True, None
        path = Path(str(configured))
        if not path.is_absolute():
            path = self.repo_root / path
        if path.exists():
            return True, None
        return False, f"dataset_missing:{path.relative_to(self.repo_root) if path.is_relative_to(self.repo_root) else path}"

    def _credential_status(self, definition: dict[str, Any]) -> tuple[bool, list[str]]:
        runtime_mode = str(definition.get("runtime_mode") or "").strip().lower()
        ingest_requires_credentials = self._bool(
            definition.get("credentials_required_for_ingest"),
            runtime_mode not in {"local_dataset", "darwin_core_archive"},
        )
        if ingest_requires_credentials is False:
            return True, []
        required = definition.get("required_env") or []
        if isinstance(required, str):
            required = [part.strip() for part in required.replace(",", " ").split() if part.strip()]
        missing = [str(name) for name in required if not os.getenv(str(name))]
        return not missing, missing

    def _availability(self, definition: dict[str, Any]) -> tuple[bool, str, list[str]]:
        enabled = self._bool(definition.get("enabled"), True) is not False
        if not enabled:
            return False, "disabled", []
        path_ok, path_reason = self._configured_path_status(definition)
        creds_ok, missing_env = self._credential_status(definition)
        if not path_ok:
            return False, "missing_dataset", [path_reason or "dataset_missing"]
        if not creds_ok:
            return False, "needs_credentials", [f"missing_env:{name}" for name in missing_env]
        return True, "ready", []

    def _volume_paths(self) -> Iterable[Path]:
        manifest_path = self.taxonomy_root / "manifest.json"
        if manifest_path.exists():
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                for entry in manifest.get("volumes", []):
                    rel = entry.get("file") if isinstance(entry, dict) else None
                    if rel:
                        path = self.taxonomy_root / str(rel)
                        if path.exists():
                            yield path
                return
            except Exception:
                pass
        yield from sorted((self.taxonomy_root / "volumes").glob("*.jsonl"))

    def record_counts(self) -> dict[str, int]:
        if self._record_counts is not None:
            return dict(self._record_counts)
        counts: Counter[str] = Counter()
        for path in self._volume_paths():
            try:
                handle = path.open("r", encoding="utf-8")
            except OSError:
                continue
            with handle:
                for line in handle:
                    try:
                        record = json.loads(line)
                    except (json.JSONDecodeError, TypeError):
                        continue
                    if not isinstance(record, dict):
                        continue
                    source = record.get("initial_source") or {}
                    provider = (
                        source.get("provider") if isinstance(source, dict) else None
                    ) or record.get("provider")
                    if provider:
                        counts[str(provider).strip().lower()] += 1
        self._record_counts = dict(counts)
        return dict(self._record_counts)

    def _decorate(self, definition: dict[str, Any], index: int, counts: dict[str, int]) -> dict[str, Any]:
        provider = dict(definition)
        provider_id = str(provider.get("name") or provider.get("id") or f"provider-{index + 1}").strip()
        available, status, reasons = self._availability(provider)
        enabled = self._bool(provider.get("enabled"), True) is not False
        conformance = self._read_conformance().get(provider_id.lower(), {})
        adapter_conformant = str(conformance.get("status") or "").lower() == "passed"
        provider.setdefault("id", provider_id)
        provider.setdefault("name", provider_id)
        provider.setdefault("label", provider_id)
        provider["index"] = index
        provider["enabled"] = enabled
        provider["available"] = available
        provider["eligible"] = enabled
        provider["executable"] = available
        provider["status"] = status
        provider["availability_reasons"] = reasons
        provider["adapter_conformant"] = adapter_conformant
        provider["adapter_conformance_status"] = conformance.get("status", "unknown")
        provider["adapter_conformance_mode"] = conformance.get("mode", "")
        provider["adapter_conformance_records"] = int(conformance.get("records") or 0)
        provider["upstream_verification_status"] = str((provider.get("verification") or {}).get("status") or "unverified")
        provider["records"] = int(counts.get(provider_id.lower(), 0))
        provider.setdefault("capabilities", self._capabilities(provider))
        provider.setdefault("protocols", self._protocols(provider))
        provider.setdefault("endpoints", self._endpoints(provider))
        return provider

    @staticmethod
    def _capabilities(provider: dict[str, Any]) -> list[str]:
        caps = ["registry", "archive_search", "provider_filter"]
        adapter = str(provider.get("adapter") or "").lower()
        if adapter and adapter not in {"file_jsonl", "generic_jsonl", "darwin_core_archive"}:
            caps.append("upstream_ingest")
        if provider.get("api_url") or provider.get("base_url"):
            caps.append("api")
        if provider.get("path"):
            caps.append("local_dataset")
        return caps

    @staticmethod
    def _protocols(provider: dict[str, Any]) -> list[str]:
        protocols: list[str] = []
        if provider.get("api_url") or provider.get("base_url"):
            protocols.append("https")
        if provider.get("path"):
            protocols.append("file")
        return protocols

    @staticmethod
    def _endpoints(provider: dict[str, Any]) -> list[str]:
        result: list[str] = []
        for key in ("api_url", "base_url", "site_url"):
            value = provider.get(key)
            if value and value not in result:
                result.append(str(value))
        return result

    def all(self) -> list[dict[str, Any]]:
        providers = self._read_registry()
        counts = self.record_counts()
        return [self._decorate(item, index, counts) for index, item in enumerate(providers)]

    def get(self, provider_id: str) -> dict[str, Any] | None:
        needle = str(provider_id or "").strip().lower()
        if not needle:
            return None
        for provider in self.all():
            if needle in {
                str(provider.get("id") or "").lower(),
                str(provider.get("name") or "").lower(),
                str(provider.get("label") or "").lower(),
            }:
                return provider
        return None

    def list(self, query: dict[str, list[str]] | None = None) -> dict[str, Any]:
        query = query or {}
        providers = self.all()
        total = len(providers)

        def first(name: str, default: str = "") -> str:
            values = query.get(name) or []
            return str(values[0]) if values else default

        needle = (first("q") or first("query") or first("search")).strip().lower()
        if needle:
            providers = [
                item for item in providers
                if needle in " ".join(
                    str(item.get(key) or "")
                    for key in ("id", "name", "label", "role", "adapter", "module", "region_code")
                ).lower()
            ]

        for field in ("status", "role", "adapter", "region", "region_code", "type", "category"):
            value = first(field).strip().lower()
            if value:
                providers = [item for item in providers if str(item.get(field) or "").strip().lower() == value]

        for field in ("enabled", "available"):
            if field in query:
                wanted = self._bool(first(field), None)
                if wanted is not None:
                    providers = [item for item in providers if bool(item.get(field)) is wanted]

        sort = (first("sort", "priority") or "priority").strip().lower()
        direction = (first("direction") or first("order") or "desc").strip().lower()
        reverse = direction != "asc"
        sort_keys = {
            "name": lambda p: str(p.get("label") or p.get("name") or "").lower(),
            "id": lambda p: str(p.get("id") or "").lower(),
            "priority": lambda p: int(p.get("priority") or 0),
            "records": lambda p: int(p.get("records") or 0),
            "status": lambda p: str(p.get("status") or ""),
        }
        providers.sort(key=sort_keys.get(sort, sort_keys["priority"]), reverse=reverse)

        try:
            offset = max(0, int(first("offset", "0")))
        except ValueError:
            offset = 0
        try:
            limit = max(1, min(10000, int(first("limit", "10000"))))
        except ValueError:
            limit = 1000

        filtered = len(providers)
        page = providers[offset: offset + limit]
        enabled = sum(1 for item in self.all() if item.get("enabled"))
        available = sum(1 for item in self.all() if item.get("available"))
        return {
            "source": str(self.registry_path.relative_to(self.repo_root)),
            "count": len(page),
            "total": total,
            "filtered": filtered,
            "limit": limit,
            "offset": offset,
            "providers": page,
            "summary": {
                "registered": total,
                "enabled": enabled,
                "eligible": enabled,
                "available": available,
                "with_archive_records": sum(1 for item in self.all() if int(item.get("records") or 0) > 0),
                "archive_records": sum(int(item.get("records") or 0) for item in self.all()),
                "adapter_conformant": sum(1 for item in self.all() if item.get("adapter_conformant")),
                "upstream_verified": sum(1 for item in self.all() if item.get("upstream_verification_status") == "verified"),
            },
        }


    def _statistics_sources(self) -> dict[str, Any]:
        path = self.repo_root / "static/data/statistics-sources.json"
        if not path.exists():
            return {"providers": [], "skipped": []}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {"providers": [], "skipped": []}
        except Exception:
            return {"providers": [], "skipped": []}

    @staticmethod
    def _page(records: list[dict[str, Any]], query: dict[str, list[str]] | None = None, key: str = "records") -> dict[str, Any]:
        query = query or {}
        def first(name: str, default: str) -> str:
            values = query.get(name) or []
            return str(values[0]) if values else default
        try:
            offset = max(0, int(first("offset", "0")))
        except ValueError:
            offset = 0
        try:
            limit = max(1, min(10000, int(first("limit", "10000"))))
        except ValueError:
            limit = 1000
        page = records[offset: offset + limit]
        return {
            key: page,
            "records": page,
            "count": len(page),
            "total": len(records),
            "limit": limit,
            "offset": offset,
        }

    def enabled(self, query: dict[str, list[str]] | None = None) -> dict[str, Any]:
        records = [item for item in self.all() if item.get("enabled")]
        payload = self._page(records, query, "enabled")
        payload["providers"] = payload["records"]
        return payload

    def eligible(self, query: dict[str, list[str]] | None = None) -> dict[str, Any]:
        records = [item for item in self.all() if item.get("eligible")]
        # Eligibility means build inclusion. Runtime execution is represented by
        # `available`/`executable`, so missing optional datasets do not erase a
        # configured provider from the terminal.
        for item in records:
            item.setdefault("reasons", item.get("availability_reasons", []))
            item.setdefault("readiness", 1.0 if item.get("available") else 0.5)
            item.setdefault("licensed", True)
            item.setdefault("authenticated", not any(str(x).startswith("missing_env:") for x in item.get("availability_reasons", [])))
        payload = self._page(records, query, "eligible")
        payload["providers"] = payload["records"]
        return payload

    def documentation(self, query: dict[str, list[str]] | None = None) -> dict[str, Any]:
        rows: list[dict[str, Any]] = []
        for provider in self.all():
            provider_id = provider["id"]
            candidates = [
                ("api", provider.get("api_documentation_url")),
                ("documentation", provider.get("documentation_url")),
                ("schema", provider.get("schema_documentation_url")),
            ]
            emitted: set[str] = set()
            for category, url in candidates:
                if not url or str(url) in emitted:
                    continue
                emitted.add(str(url))
                rows.append({
                    "id": f"{provider_id}:{category}",
                    "provider": provider_id,
                    "provider_id": provider_id,
                    "title": f"{provider.get('label') or provider_id} {category.replace('_', ' ').title()}",
                    "type": category,
                    "category": category,
                    "url": str(url),
                    "available": True,
                    "official": True,
                    "current": True,
                    "status": "current",
                    "searchable": True,
                })
            schema_path = provider.get("response_schema_path")
            if schema_path:
                local = self.repo_root / str(schema_path)
                rows.append({
                    "id": f"{provider_id}:response-schema",
                    "provider": provider_id,
                    "provider_id": provider_id,
                    "title": f"{provider.get('label') or provider_id} Response Schema",
                    "type": "schema",
                    "category": "schema",
                    "path": str(schema_path),
                    "available": local.exists(),
                    "official": False,
                    "current": True,
                    "status": "current" if local.exists() else "missing",
                    "searchable": local.exists(),
                })
        needle = ((query or {}).get("q") or (query or {}).get("query") or [""])[0].strip().lower()
        if needle:
            rows = [row for row in rows if needle in json.dumps(row, sort_keys=True).lower()]
        payload = self._page(rows, query, "documentation")
        return payload

    def statistics(self, query: dict[str, list[str]] | None = None) -> dict[str, Any]:
        source_data = self._statistics_sources()
        runs = {
            str(item.get("provider") or "").lower(): item
            for item in source_data.get("providers", [])
            if isinstance(item, dict)
        }
        skipped = {
            str(item.get("provider") or "").lower(): item
            for item in source_data.get("skipped", [])
            if isinstance(item, dict)
        }
        rows: list[dict[str, Any]] = []
        for provider in self.all():
            pid = provider["id"]
            run = runs.get(pid.lower(), {})
            skip = skipped.get(pid.lower(), {})
            errors = 1 if run.get("error") or skip.get("reason") else 0
            requests = int(run.get("requests") or 0)
            records = int(provider.get("records") or 0)
            rows.append({
                "id": pid,
                "provider": pid,
                "provider_id": pid,
                "records": records,
                "species": records,
                "taxa": records,
                "assertions": int(run.get("matched") or 0) + int(run.get("created") or 0) + int(run.get("revised") or 0),
                "errors": errors,
                "warnings": 1 if skip.get("reason") else 0,
                "requests": requests,
                "successes": max(0, requests - errors),
                "success_rate": (max(0, requests - errors) / requests) if requests else (1.0 if provider.get("available") else 0.0),
                "availability": 1.0 if provider.get("available") else 0.0,
                "available": bool(provider.get("available")),
                "enabled": bool(provider.get("enabled")),
                "active": records > 0,
                "healthy": bool(provider.get("available")) and not errors,
                "degraded": bool(errors),
                "status": "healthy" if provider.get("available") and not errors else provider.get("status", "unknown"),
                "source": "statistics-sources.json" if run or skip else "provider-registry",
                "error": run.get("error") or skip.get("reason"),
            })
        payload = self._page(rows, query, "statistics")
        return payload

    def errors(self, query: dict[str, list[str]] | None = None) -> dict[str, Any]:
        source_data = self._statistics_sources()
        rows: list[dict[str, Any]] = []
        for item in source_data.get("providers", []):
            if not isinstance(item, dict) or not item.get("error"):
                continue
            pid = str(item.get("provider") or "unknown")
            rows.append({
                "id": f"{pid}:provider-run",
                "provider": pid,
                "provider_id": pid,
                "message": str(item.get("error")),
                "error": str(item.get("error")),
                "stage": "ingest",
                "status": "error",
                "source": "statistics-sources.json",
            })
        for item in source_data.get("skipped", []):
            if not isinstance(item, dict):
                continue
            pid = str(item.get("provider") or "unknown")
            reason = str(item.get("reason") or "provider skipped")
            rows.append({
                "id": f"{pid}:skipped",
                "provider": pid,
                "provider_id": pid,
                "message": reason,
                "error": reason,
                "stage": "availability",
                "status": "skipped",
                "source": "statistics-sources.json",
            })
        payload = self._page(rows, query, "errors")
        return payload

    def latency(self, query: dict[str, list[str]] | None = None) -> dict[str, Any]:
        rows = [{
            "id": item["id"],
            "provider": item["id"],
            "provider_id": item["id"],
            "latency": 0,
            "latency_ms": 0,
            "measured": False,
            "status": item.get("status", "unknown"),
            "available": item.get("available", False),
            "endpoint": (item.get("endpoints") or [""])[0],
            "endpoints": item.get("endpoints", []),
            "protocols": item.get("protocols", []),
        } for item in self.all()]
        return self._page(rows, query, "latency")

    def overlap(self, query: dict[str, list[str]] | None = None) -> dict[str, Any]:
        # Canonical archive records currently retain one initial source and
        # additional assertions in the revision ledger.  Until a materialized
        # cross-provider identity table is published, return a valid empty
        # comparison set rather than fabricated overlap values.
        return self._page([], query, "overlap")

    def assertions(self, query: dict[str, list[str]] | None = None) -> dict[str, Any]:
        rows: list[dict[str, Any]] = []
        revisions = self.taxonomy_root / "revisions"
        for path in sorted(revisions.glob("*.jsonl")):
            try:
                handle = path.open("r", encoding="utf-8")
            except OSError:
                continue
            with handle:
                for line in handle:
                    try:
                        item = json.loads(line)
                    except Exception:
                        continue
                    if not isinstance(item, dict) or not item.get("provider"):
                        continue
                    assertion = item.get("assertion") if isinstance(item.get("assertion"), dict) else {}
                    rows.append({
                        "id": f"{item.get('provider')}:{item.get('provider_id')}:{item.get('changed_at')}",
                        "provider": item.get("provider"),
                        "provider_id": item.get("provider_id"),
                        "speciedex_id": item.get("speciedex_id"),
                        "event": item.get("event"),
                        "changed_at": item.get("changed_at"),
                        "scientific_name": assertion.get("scientific_name"),
                        "rank": assertion.get("rank"),
                        "status": assertion.get("status"),
                        "assertion": assertion,
                    })
        needle = ((query or {}).get("provider") or [""])[0].strip().lower()
        if needle:
            rows = [row for row in rows if str(row.get("provider") or "").lower() == needle]
        return self._page(rows, query, "assertions")

    def category_detail(self, category: str, identifier: str) -> dict[str, Any] | None:
        category = str(category).strip().lower()
        identifier = str(identifier).strip().lower()
        if category in {"enabled", "eligible", "statistics", "latency"}:
            payload = getattr(self, category)({"limit": ["1000"]})
            for item in payload.get("records", []):
                if identifier in {str(item.get("id") or "").lower(), str(item.get("provider") or "").lower(), str(item.get("name") or "").lower()}:
                    return item
            return None
        if category in {"documentation", "errors", "assertions", "overlap"}:
            payload = getattr(self, category)({"limit": ["1000"]})
            for item in payload.get("records", []):
                if identifier in {str(item.get("id") or "").lower(), str(item.get("provider") or "").lower(), str(item.get("provider_id") or "").lower()}:
                    return item
            return None
        return None
