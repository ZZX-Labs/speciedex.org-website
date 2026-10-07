#!/usr/bin/env python3
"""Offline provider-adapter conformance harness for all Speciedex providers.

This validates the complete local adapter contract without contacting third-party
services. Live API providers execute against deterministic protocol fixtures;
dataset-backed providers execute against temporary JSONL/DwC-A fixtures.
External service reachability and credentials are deliberately separate from
adapter correctness and are reported by the runtime readiness layer.
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from contextlib import contextmanager
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

TOOLS_ROOT = Path(__file__).resolve().parent
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

from providers.common import Batch, HTTPClient, ProviderError, Taxon  # noqa: E402
from providers.loader import load_provider  # noqa: E402

LIVE_PROVIDERS = {
    "wikipedia",
    "wikispecies",
    "gbif",
    "itis",
    "worms",
    "inaturalist",
    "openalex",
    "youtube",
}

PAGE_FIXTURE = {
    "pageid": 123,
    "ns": 0,
    "title": "Panthera leo",
    "fullurl": "https://example.invalid/Panthera_leo",
    "pageprops": {
        "wikibase-title": "Panthera leo",
        "taxonrank": "species",
        "wikibase-shortdesc": "species of mammal",
    },
    "categories": [
        {"title": "Category:Panthera"},
        {"title": "Category:Species"},
    ],
    "revisions": [
        {
            "revid": 1,
            "timestamp": "2026-01-01T00:00:00Z",
            "slots": {
                "main": {
                    "content": (
                        "{{Taxobox|name=Panthera leo|binomial=Panthera leo|"
                        "genus=Panthera|species=P. leo|family=Felidae|"
                        "order=Carnivora|classis=Mammalia|phylum=Chordata|"
                        "regnum=Animalia|rank=species}}"
                    )
                }
            },
        }
    ],
    "extract": "Panthera leo is a species.",
}

MEGA_RECORD: dict[str, Any] = {
    "id": "123",
    "identifier": "123",
    "provider_id": "123",
    "taxon_id": "123",
    "taxonId": "123",
    "taxonID": "123",
    "key": "123",
    "usageKey": "123",
    "AphiaID": "123",
    "aphiaID": "123",
    "tsn": "123",
    "taxonConceptID": "123",
    "scientific_name": "Panthera leo",
    "scientificName": "Panthera leo",
    "name": "Panthera leo",
    "canonical_name": "Panthera leo",
    "canonicalName": "Panthera leo",
    "full_name": "Panthera leo",
    "fullName": "Panthera leo",
    "taxon_name": "Panthera leo",
    "taxonName": "Panthera leo",
    "valid_name": "Panthera leo",
    "rank": "species",
    "taxon_rank": "species",
    "taxonRank": "species",
    "status": "accepted",
    "taxonomic_status": "accepted",
    "taxonomicStatus": "accepted",
    "name_status": "accepted",
    "authorship": "Linnaeus, 1758",
    "authority": "Linnaeus, 1758",
    "scientificNameAuthorship": "Linnaeus, 1758",
    "kingdom": "Animalia",
    "phylum": "Chordata",
    "class": "Mammalia",
    "class_name": "Mammalia",
    "order": "Carnivora",
    "family": "Felidae",
    "genus": "Panthera",
    "specificEpithet": "leo",
    "species": "Panthera leo",
    "accepted_id": "",
    "acceptedTaxonId": "",
    "accepted_taxon_id": "",
    "source_url": "https://example.invalid/taxon/123",
    "url": "https://example.invalid/taxon/123",
    "modified": "2026-01-01T00:00:00Z",
    "updated": "2026-01-01T00:00:00Z",
    "synonyms": ["Felis leo"],
    "common_name": "Lion",
    "commonName": "Lion",
    "vernacularName": "Lion",
    "dataset": "conformance-fixture",
    "source": "conformance-fixture",
    "lineage": [
        {"rank": "kingdom", "name": "Animalia"},
        {"rank": "phylum", "name": "Chordata"},
        {"rank": "class", "name": "Mammalia"},
        {"rank": "order", "name": "Carnivora"},
        {"rank": "family", "name": "Felidae"},
        {"rank": "genus", "name": "Panthera"},
    ],
}


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def registry(repo_root: Path) -> list[dict[str, Any]]:
    data = json.loads((repo_root / "static/tools/providers.json").read_text(encoding="utf-8"))
    raw = data.get("providers", data) if isinstance(data, dict) else data
    return [dict(item) for item in raw if isinstance(item, dict)]


def definition_for(repo_root: Path, name: str) -> dict[str, Any]:
    for item in registry(repo_root):
        if item.get("name") == name:
            return item
    raise AssertionError(f"Unknown provider: {name}")


class FixtureHTTP(HTTPClient):
    def __init__(self, provider: str) -> None:
        super().__init__(timeout=1, retries=1, backoff=1.0)
        self.provider = provider
        self.calls: list[tuple[str, dict[str, Any], dict[str, Any]]] = []

    def get_json(self, url: str, params: dict[str, Any] | None = None,
                 headers: dict[str, str] | None = None, **kwargs: Any) -> Any:
        self.requests += 1
        params = dict(params or {})
        self.calls.append((url, params, dict(kwargs)))
        name = self.provider

        if name == "wikipedia":
            return {"query": {"pages": [PAGE_FIXTURE]}}
        if name == "wikispecies":
            return {"query": {"pages": [PAGE_FIXTURE]}}
        if name == "gbif":
            return {
                "offset": 0,
                "limit": 1,
                "count": 1,
                "endOfRecords": True,
                "results": [{
                    "key": 5219404,
                    "scientificName": "Panthera leo (Linnaeus, 1758)",
                    "canonicalName": "Panthera leo",
                    "rank": "SPECIES",
                    "taxonomicStatus": "ACCEPTED",
                    "kingdom": "Animalia",
                    "phylum": "Chordata",
                    "class": "Mammalia",
                    "order": "Carnivora",
                    "family": "Felidae",
                    "genus": "Panthera",
                }],
            }
        if name == "inaturalist":
            return {
                "total_results": 1,
                "page": 1,
                "per_page": 1,
                "results": [{
                    "id": 41970,
                    "name": "Panthera leo",
                    "rank": "species",
                    "is_active": True,
                    "preferred_common_name": "Lion",
                }],
            }
        if name == "worms":
            return [{
                "AphiaID": 137073,
                "scientificname": "Panthera leo",
                "rank": "Species",
                "status": "accepted",
                "kingdom": "Animalia",
                "phylum": "Chordata",
                "class": "Mammalia",
                "order": "Carnivora",
                "family": "Felidae",
                "genus": "Panthera",
            }]
        if name == "openalex":
            return {
                "meta": {"next_cursor": None},
                "results": [{
                    "id": "https://openalex.org/W123",
                    "display_name": "Ecology of Panthera leo",
                    "publication_year": 2026,
                    "publication_date": "2026-01-01",
                    "type": "article",
                    "authorships": [],
                    "ids": {},
                    "locations": [],
                    "open_access": {},
                }],
            }
        if name == "youtube":
            if url.rstrip("/").endswith("/search"):
                return {"items": [{
                    "id": {"kind": "youtube#video", "videoId": "vid123"},
                    "snippet": {
                        "title": "Panthera leo field study",
                        "description": "Research on Panthera leo",
                        "channelId": "ch1",
                        "channelTitle": "Science",
                        "publishedAt": "2026-01-01T00:00:00Z",
                    },
                }]}
            if url.rstrip("/").endswith("/videos"):
                return {"items": [{
                    "id": "vid123",
                    "snippet": {
                        "title": "Panthera leo field study",
                        "description": "Research on Panthera leo",
                        "channelId": "ch1",
                        "channelTitle": "Science",
                        "publishedAt": "2026-01-01T00:00:00Z",
                        "tags": ["Panthera leo"],
                    },
                    "contentDetails": {"duration": "PT10M", "licensedContent": True},
                    "status": {"privacyStatus": "public", "embeddable": True},
                    "statistics": {"viewCount": "100"},
                }]}
            return {"items": []}
        raise AssertionError(f"No HTTP fixture for {name}: {url}")


class _ITISHeaders:
    def get(self, key: str, default: str = "") -> str:
        return "application/json" if key.lower() == "content-type" else default
    def get_content_charset(self) -> str:
        return "utf-8"


class _ITISResponse:
    status = 200
    headers = _ITISHeaders()
    def __enter__(self) -> "_ITISResponse":
        return self
    def __exit__(self, *args: Any) -> bool:
        return False
    def read(self) -> bytes:
        payload = {
            "usage": {"taxonName": "Panthera leo", "usage": "valid"},
            "scientificName": {
                "combinedName": "Panthera leo",
                "unitName1": "Panthera",
                "unitName2": "leo",
            },
            "coreMetadata": {"rankName": "Species", "updateDate": "2026-01-01"},
            "taxonAuthor": {"taxonAuthor": "Linnaeus, 1758"},
            "hierarchyUp": {"hierarchyList": [
                {"rankName": "Kingdom", "taxonName": "Animalia"},
                {"rankName": "Phylum", "taxonName": "Chordata"},
                {"rankName": "Class", "taxonName": "Mammalia"},
                {"rankName": "Order", "taxonName": "Carnivora"},
                {"rankName": "Family", "taxonName": "Felidae"},
                {"rankName": "Genus", "taxonName": "Panthera"},
            ]},
        }
        return json.dumps(payload).encode("utf-8")


def _write_jsonl_fixture(path: Path) -> None:
    records = []
    for i, name in enumerate(("Panthera leo", "Panthera tigris", "Panthera onca"), 1):
        record = dict(MEGA_RECORD)
        for key in ("id", "identifier", "provider_id", "taxon_id", "taxonId", "taxonID", "key", "usageKey", "AphiaID", "aphiaID", "tsn", "taxonConceptID"):
            record[key] = str(i)
        for key in ("scientific_name", "scientificName", "name", "canonical_name", "canonicalName", "full_name", "fullName", "taxon_name", "taxonName", "valid_name", "species"):
            record[key] = name
        records.append(record)
    path.write_text("\n".join(json.dumps(item, ensure_ascii=False) for item in records) + "\n", encoding="utf-8")


def _write_dwca_fixture(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    (path / "taxon.txt").write_text(
        "taxonID\tscientificName\tcanonicalName\ttaxonRank\ttaxonomicStatus\tkingdom\tphylum\tclass\torder\tfamily\tgenus\n"
        "1\tPanthera leo\tPanthera leo\tspecies\taccepted\tAnimalia\tChordata\tMammalia\tCarnivora\tFelidae\tPanthera\n"
        "2\tPanthera tigris\tPanthera tigris\tspecies\taccepted\tAnimalia\tChordata\tMammalia\tCarnivora\tFelidae\tPanthera\n"
        "3\tPanthera onca\tPanthera onca\tspecies\taccepted\tAnimalia\tChordata\tMammalia\tCarnivora\tFelidae\tPanthera\n",
        encoding="utf-8",
    )


def _validate_taxon(record: Taxon, provider_name: str) -> None:
    assert isinstance(record, Taxon)
    assert record.provider == provider_name, (record.provider, provider_name)
    assert str(record.provider_id).strip()
    assert str(record.scientific_name).strip()
    assert str(record.canonical_name).strip()
    assert str(record.rank).strip()
    assert str(record.status).strip()
    data = record.to_dict()
    assert data["provider"] == provider_name
    assert "class" in data
    assert isinstance(data.get("synonyms"), list)
    assert isinstance(data.get("extra"), dict)


def _validate_schema(repo_root: Path, definition: dict[str, Any]) -> None:
    schema_path = repo_root / str(definition.get("response_schema_path") or "")
    assert schema_path.is_file(), f"missing schema: {schema_path}"
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    assert schema.get("$schema")
    assert schema.get("type") == "object"
    required = set(schema.get("required") or [])
    assert {"provider", "provider_id", "scientific_name", "canonical_name", "rank", "status"} <= required
    provider_schema = (schema.get("properties") or {}).get("provider") or {}
    assert provider_schema.get("const") == definition["name"]


def _exercise_file_provider(repo_root: Path, definition: dict[str, Any], temp: Path) -> dict[str, Any]:
    source = temp / f"{definition['name']}.jsonl"
    _write_jsonl_fixture(source)
    configured = dict(definition)
    configured["path"] = str(source)
    configured["page_size"] = 2
    http = HTTPClient(timeout=1, retries=1, backoff=1.0)
    state = temp / f"{definition['name']}.state.json"
    provider = load_provider(configured, http, state, 2, repo_root)
    first = provider.fetch()
    assert isinstance(first, Batch)
    assert first.records
    assert first.next_cursor is not None
    assert first.exhausted is False
    for record in first.records:
        _validate_taxon(record, definition["name"])
    first_ids = {record.provider_id for record in first.records}
    provider.save_success(first)

    provider2 = load_provider(configured, HTTPClient(timeout=1, retries=1, backoff=1.0), state, 2, repo_root)
    second = provider2.fetch()
    assert isinstance(second, Batch)
    assert second.records
    assert second.exhausted is True
    assert second.next_cursor is None
    for record in second.records:
        _validate_taxon(record, definition["name"])
    second_ids = {record.provider_id for record in second.records}
    assert first_ids.isdisjoint(second_ids), "cursor replayed records"
    return {"mode": "local_dataset", "records": len(first.records) + len(second.records), "requests": 0, "cursor_resume": True}


def _exercise_dwca(repo_root: Path, definition: dict[str, Any], temp: Path) -> dict[str, Any]:
    source = temp / "dwca"
    _write_dwca_fixture(source)
    configured = dict(definition)
    configured.update({"path": str(source), "page_size": 2, "join_extensions": False})
    state = temp / "darwin_core_archive.state.json"
    first_provider = load_provider(configured, HTTPClient(timeout=1, retries=1), state, 2, repo_root)
    first = first_provider.fetch()
    assert len(first.records) == 2 and not first.exhausted and first.next_cursor
    for record in first.records:
        _validate_taxon(record, definition["name"])
    first_ids = {record.provider_id for record in first.records}
    first_provider.save_success(first)
    second_provider = load_provider(configured, HTTPClient(timeout=1, retries=1), state, 2, repo_root)
    second = second_provider.fetch()
    assert len(second.records) == 1 and second.exhausted and second.next_cursor is None
    for record in second.records:
        _validate_taxon(record, definition["name"])
    assert first_ids.isdisjoint({record.provider_id for record in second.records})
    return {"mode": "darwin_core_archive", "records": 3, "requests": 0, "cursor_resume": True}


def _exercise_itis(repo_root: Path, definition: dict[str, Any], temp: Path) -> dict[str, Any]:
    import providers.itis as module
    original = module.urlopen
    module.urlopen = lambda *args, **kwargs: _ITISResponse()
    try:
        configured = dict(definition)
        configured.update({"start_tsn": 1, "max_tsn": 1})
        http = HTTPClient(timeout=1, retries=1)
        provider = load_provider(configured, http, temp / "itis.state.json", 1, repo_root)
        batch = provider.fetch()
    finally:
        module.urlopen = original
    assert len(batch.records) == 1 and batch.exhausted
    _validate_taxon(batch.records[0], "itis")
    assert batch.requests == 1
    return {"mode": "live_api_fixture", "records": 1, "requests": batch.requests, "cursor_resume": True}


def _exercise_live(repo_root: Path, definition: dict[str, Any], temp: Path) -> dict[str, Any]:
    name = definition["name"]
    if name == "itis":
        return _exercise_itis(repo_root, definition, temp)
    configured = dict(definition)
    configured["page_size"] = 1
    configured["batch_size"] = 1
    if name == "youtube":
        configured.update({"api_key": "conformance-test-key", "max_results": 1, "hydrate_details": True})
    http = FixtureHTTP(name)
    provider = load_provider(configured, http, temp / f"{name}.state.json", 1, repo_root)
    batch = provider.fetch()
    assert isinstance(batch, Batch)
    assert batch.records, f"{name} fixture produced no normalized records"
    for record in batch.records:
        _validate_taxon(record, name)
    assert http.requests >= 1
    return {"mode": "live_api_fixture", "records": len(batch.records), "requests": http.requests, "cursor_resume": batch.exhausted or bool(batch.next_cursor)}


def run_provider(repo_root: Path, provider_name: str) -> dict[str, Any]:
    repo_root = repo_root.resolve()
    definition = definition_for(repo_root, provider_name)
    _validate_schema(repo_root, definition)
    with tempfile.TemporaryDirectory(prefix=f"speciedex-{provider_name}-") as td:
        temp = Path(td)
        adapter = str(definition.get("adapter") or "").strip().lower()
        if provider_name in LIVE_PROVIDERS:
            details = _exercise_live(repo_root, definition, temp)
        elif adapter == "dwca":
            details = _exercise_dwca(repo_root, definition, temp)
        elif adapter == "file_jsonl":
            details = _exercise_file_provider(repo_root, definition, temp)
        else:
            raise AssertionError(f"Unsupported adapter mode for {provider_name}: {adapter}")
    return {
        "provider": provider_name,
        "status": "passed",
        "adapter": definition.get("adapter"),
        "runtime_mode": definition.get("runtime_mode"),
        "module": definition.get("module"),
        "schema": definition.get("response_schema_path"),
        **details,
    }


def run_all(repo_root: Path) -> dict[str, Any]:
    started = utc_now()
    results: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    for definition in registry(repo_root):
        name = str(definition.get("name") or "")
        try:
            result = run_provider(repo_root, name)
            results.append(result)
        except Exception as error:
            failures.append({"provider": name, "status": "failed", "error": f"{type(error).__name__}: {error}"})
    return {
        "schema_version": 1,
        "generated_at": utc_now(),
        "started_at": started,
        "method": "offline_adapter_conformance",
        "live_upstream_verified": False,
        "registered": len(registry(repo_root)),
        "passed": len(results),
        "failed": len(failures),
        "results": results,
        "failures": failures,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=TOOLS_ROOT.parent.parent)
    parser.add_argument("--provider", action="append", default=[])
    parser.add_argument("--json", action="store_true", dest="as_json")
    parser.add_argument("--write-report", type=Path)
    args = parser.parse_args()
    repo_root = args.repo_root.resolve()
    if args.provider:
        report = {
            "schema_version": 1,
            "generated_at": utc_now(),
            "method": "offline_adapter_conformance",
            "live_upstream_verified": False,
            "registered": len(args.provider),
            "results": [],
            "failures": [],
        }
        for name in args.provider:
            try:
                report["results"].append(run_provider(repo_root, name))
            except Exception as error:
                report["failures"].append({"provider": name, "status": "failed", "error": f"{type(error).__name__}: {error}"})
        report["passed"] = len(report["results"])
        report["failed"] = len(report["failures"])
    else:
        report = run_all(repo_root)

    if args.write_report:
        target = args.write_report
        if not target.is_absolute():
            target = repo_root / target
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    if args.as_json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        for item in report.get("results", []):
            print(f"[PASS] {item['provider']}: {item['mode']} records={item['records']} requests={item['requests']}")
        for item in report.get("failures", []):
            print(f"[FAIL] {item['provider']}: {item['error']}")
        print(f"Provider conformance: {report.get('passed', 0)}/{report.get('registered', 0)} passed")
    return 0 if not report.get("failures") else 1


if __name__ == "__main__":
    raise SystemExit(main())
