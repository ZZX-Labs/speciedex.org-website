from __future__ import annotations

import json
import sqlite3
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Iterable

from .database import Database


_FIELD_TOKEN = re.compile(r"^(provider|source|rank|kingdom|phylum|class|order|family|genus|status):(.+)$", re.I)


class SearchService:
    """Search the canonical taxonomy archive with SQLite acceleration when present.

    The production archive is JSONL-first.  SQLite is therefore an optional
    accelerator, not a hard dependency.  Provider fan-out uses a single lazy
    archive load and concurrent provider shards so all configured providers
    return deterministic envelopes instead of disappearing from the UI.
    """

    def __init__(self, database: Database, taxonomy_root: Path, max_results: int = 500) -> None:
        self.database = database
        self.taxonomy_root = taxonomy_root
        self.max_results = max(1, max_results)
        self._lock = threading.RLock()
        self._archive_loaded = False
        self._records: list[dict[str, Any]] = []
        self._by_provider: dict[str, list[dict[str, Any]]] = {}

    def _volume_paths(self) -> Iterable[Path]:
        manifest_path = self.taxonomy_root / "manifest.json"
        if manifest_path.exists():
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                yielded = False
                for item in manifest.get("volumes", []):
                    rel = item.get("file") if isinstance(item, dict) else None
                    if not rel:
                        continue
                    path = (self.taxonomy_root / str(rel)).resolve()
                    if not path.is_relative_to(self.taxonomy_root.resolve()):raise ValueError("Unsafe volume path")
                    if path.exists():
                        yielded = True
                        yield path
                if yielded:
                    return
            except Exception:
                pass
        yield from sorted((self.taxonomy_root / "volumes").glob("*.jsonl"))

    @staticmethod
    def _provider(record: dict[str, Any]) -> str:
        source = record.get("initial_source") or {}
        value = source.get("provider") if isinstance(source, dict) else None
        return str(value or record.get("provider") or "").strip().lower()

    def _ensure_archive(self) -> None:
        manifest=self.taxonomy_root/'manifest.json'
        signature=manifest.stat().st_mtime_ns if manifest.exists() else None
        if self._archive_loaded and getattr(self,'_signature',None)==signature:return
        self._archive_loaded=False
        with self._lock:
            if self._archive_loaded:
                return
            records: list[dict[str, Any]] = []
            by_provider: dict[str, list[dict[str, Any]]] = {}
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
                        records.append(record)
                        provider = self._provider(record)
                        if provider:
                            by_provider.setdefault(provider, []).append(record)
            self._records = records
            self._by_provider = by_provider
            self._archive_loaded = True
            self._signature=signature

    @staticmethod
    def _flatten(record: dict[str, Any]) -> str:
        parts: list[str] = []

        def walk(value: Any) -> None:
            if value is None:
                return
            if isinstance(value, dict):
                for child in value.values():
                    walk(child)
            elif isinstance(value, (list, tuple, set)):
                for child in value:
                    walk(child)
            elif isinstance(value, (str, int, float, bool)):
                parts.append(str(value))

        walk(record)
        return " ".join(parts).lower()

    @staticmethod
    def _field_value(record: dict[str, Any], field: str) -> str:
        if field in {"provider", "source"}:
            return SearchService._provider(record)
        if field == "class":
            field = "class"
        if field in record:
            return str(record.get(field) or "").lower()
        taxonomy = record.get("taxonomy") or {}
        if isinstance(taxonomy, dict):
            return str(taxonomy.get(field) or "").lower()
        return ""

    @staticmethod
    def _parse(query: str) -> tuple[list[str], dict[str, list[str]]]:
        terms: list[str] = []
        fields: dict[str, list[str]] = {}
        # Terminal field queries are intentionally simple and shell-like. Quoted
        # multiword terms remain usable because the final text match is substring based.
        for raw in re.findall(r'[^\s"]+|"[^"]*"', query):
            token = raw.strip().strip('"').strip()
            if not token:
                continue
            match = _FIELD_TOKEN.match(token)
            if match:
                fields.setdefault(match.group(1).lower(), []).append(match.group(2).strip().strip('"').lower())
            else:
                terms.append(token.lower())
        return terms, fields

    def _match(self, record: dict[str, Any], terms: list[str], fields: dict[str, list[str]]) -> bool:
        for field, wanted_values in fields.items():
            actual = self._field_value(record, field)
            if not all(wanted in actual for wanted in wanted_values):
                return False
        if not terms:
            return True
        haystack = self._flatten(record)
        return all(term in haystack for term in terms)

    def _search_records(
        self,
        records: Iterable[dict[str, Any]],
        query: str,
        limit: int,
        offset: int,
    ) -> tuple[list[dict[str, Any]], int]:
        terms, fields = self._parse(query)
        matched: list[dict[str, Any]] = []
        total = 0
        end = offset + limit
        for record in records:
            if not self._match(record, terms, fields):
                continue
            if offset <= total < end:
                matched.append(record)
            total += 1
        return matched, total

    def _expected_archive_count(self) -> int | None:
        manifest_path = self.taxonomy_root / "manifest.json"
        if not manifest_path.exists():
            return None
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            value = manifest.get("total_primary_records")
            return int(value) if value is not None else None
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            return None

    def _search_sqlite(self, query: str, limit: int, offset: int, provider: str | None) -> dict[str, Any] | None:
        if not self.database.path.exists():
            return None

        # Field-qualified terminal expressions are interpreted by the canonical
        # JSONL matcher. Passing them literally to LIKE would make SQLite return
        # a false negative (for example ``rank:species Panthera``).
        _, fields = self._parse(query)
        if fields:
            return None

        try:
            table = self.database.find_taxon_table()
            if not table:
                return None
            columns = self.database.columns(table)

            # SQLite is an accelerator, never the authority. If an index exists
            # but is empty or stale relative to the taxonomy manifest, bypass it
            # rather than allowing it to mask records in the JSONL archive.
            count_rows = self.database.query(f"SELECT COUNT(*) AS count FROM {table}")
            sqlite_count = int(count_rows[0].get("count", 0)) if count_rows else 0
            expected_count = self._expected_archive_count()
            if sqlite_count <= 0:
                return None
            if expected_count is not None and sqlite_count < expected_count:
                return None
        except (FileNotFoundError, OSError, TypeError, ValueError, sqlite3.Error):
            return None

        searchable = [
            name for name in (
                "scientific_name", "canonical_name", "name", "common_name",
                "vernacular_name", "speciedex_id", "id", "provider"
            ) if name in columns
        ]
        if not searchable:
            searchable = columns[:3]
        if not searchable:
            return None
        if provider and "provider" not in columns:
            return None

        clauses = ["(" + " OR ".join(f"CAST({column} AS TEXT) LIKE ?" for column in searchable) + ")"]
        params: list[Any] = [f"%{query}%"] * len(searchable)
        if provider:
            clauses.append("LOWER(CAST(provider AS TEXT)) = ?")
            params.append(provider.lower())
        where = " AND ".join(clauses)
        total_rows = self.database.query(
            f"SELECT COUNT(*) AS count FROM {table} WHERE {where}",
            tuple(params),
        )
        total = int(total_rows[0].get("count", 0)) if total_rows else 0
        if total <= 0:
            return None
        rows = self.database.query(
            f"SELECT * FROM {table} WHERE {where} LIMIT ? OFFSET ?",
            tuple(params + [limit, offset]),
        )
        return {
            "query": query,
            "count": len(rows),
            "total": total,
            "limit": limit,
            "offset": offset,
            "provider": provider,
            "source": "sqlite",
            "records": rows,
        }

    def search(
        self,
        query: str,
        limit: int = 100,
        offset: int = 0,
        provider: str | None = None,
    ) -> dict[str, Any]:
        started = time.perf_counter()
        query = query.strip()
        limit = min(self.max_results, max(1, int(limit)))
        offset = max(0, int(offset))
        provider = str(provider or "").strip().lower() or None
        if not query:
            return {"query": query, "count": 0, "total": 0, "records": [], "source": "none"}

        sqlite_result = self._search_sqlite(query, limit, offset, provider)
        if sqlite_result is not None:
            sqlite_result["elapsed_ms"] = round((time.perf_counter() - started) * 1000, 3)
            return sqlite_result

        self._ensure_archive()
        records: Iterable[dict[str, Any]] = self._by_provider.get(provider, []) if provider else self._records
        matched, total = self._search_records(records, query, limit, offset)
        return {
            "query": query,
            "count": len(matched),
            "total": total,
            "limit": limit,
            "offset": offset,
            "provider": provider,
            "source": "taxonomy_jsonl",
            "records": matched,
            "elapsed_ms": round((time.perf_counter() - started) * 1000, 3),
        }

    def list_records(
        self,
        limit: int = 100,
        offset: int = 0,
        provider: str | None = None,
        filters: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        started = time.perf_counter()
        limit = min(self.max_results, max(1, int(limit)))
        offset = max(0, int(offset))
        provider = str(provider or "").strip().lower() or None
        self._ensure_archive()
        records = self._by_provider.get(provider, []) if provider else self._records
        filters = {str(k).lower(): str(v).lower() for k, v in (filters or {}).items() if str(v).strip()}
        selected: list[dict[str, Any]] = []
        total = 0
        for record in records:
            matched = True
            for field, wanted in filters.items():
                if field in {"q", "query", "limit", "offset", "provider"}:
                    continue
                if wanted not in self._field_value(record, field):
                    matched = False
                    break
            if not matched:
                continue
            if offset <= total < offset + limit:
                selected.append(record)
            total += 1
        return {
            "count": len(selected),
            "total": total,
            "limit": limit,
            "offset": offset,
            "provider": provider,
            "source": "taxonomy_jsonl",
            "records": selected,
            "elapsed_ms": round((time.perf_counter() - started) * 1000, 3),
        }

    def get_record(self, identifier: str) -> dict[str, Any] | None:
        needle = str(identifier or "").strip().lower()
        if not needle:
            return None
        self._ensure_archive()
        for record in self._records:
            source = record.get("initial_source") or {}
            candidates = {
                str(record.get("speciedex_id") or "").lower(),
                str(record.get("id") or "").lower(),
                str(record.get("scientific_name") or "").lower(),
                str(record.get("canonical_name") or "").lower(),
            }
            if isinstance(source, dict):
                candidates.add(str(source.get("provider_id") or "").lower())
            if needle in candidates:
                return record
        return None

    def fanout(
        self,
        query: str,
        provider_names: list[str],
        limit_per_provider: int = 20,
        workers: int = 16,
    ) -> dict[str, Any]:
        started = time.perf_counter()
        query = str(query or "").strip()
        if not query:
            return {"query": query, "providers": [], "count": 0, "total": 0, "records": []}
        self._ensure_archive()
        names = list(dict.fromkeys(str(name).strip().lower() for name in provider_names if str(name).strip()))
        limit_per_provider = max(1, min(self.max_results, int(limit_per_provider)))
        workers = max(1, min(32, int(workers), len(names) or 1))

        def one(name: str) -> dict[str, Any]:
            records = self._by_provider.get(name, [])
            matched, total = self._search_records(records, query, limit_per_provider, 0)
            return {
                "provider": name,
                "status": "ok" if total else "empty",
                "count": len(matched),
                "total": total,
                "records": matched,
                "source": "taxonomy_jsonl",
            }

        results_by_name: dict[str, dict[str, Any]] = {}
        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="speciedex-provider-search") as executor:
            futures = {executor.submit(one, name): name for name in names}
            for future in as_completed(futures):
                name = futures[future]
                try:
                    results_by_name[name] = future.result()
                except Exception as error:
                    results_by_name[name] = {
                        "provider": name,
                        "status": "error",
                        "count": 0,
                        "total": 0,
                        "records": [],
                        "source": "taxonomy_jsonl",
                        "error": str(error),
                    }
        provider_results = [results_by_name[name] for name in names]
        flat = [record for result in provider_results for record in result.get("records", [])]
        return {
            "query": query,
            "mode": "provider_fanout",
            "provider_count": len(provider_results),
            "providers": provider_results,
            "count": len(flat),
            "total": sum(int(item.get("total") or 0) for item in provider_results),
            "records": flat,
            "elapsed_ms": round((time.perf_counter() - started) * 1000, 3),
        }
