#!/usr/bin/env python3
"""Offline integrity self-test for the Speciedex site, terminal, and provider registry.

This test intentionally does not call third-party networks. It verifies the local
provider contract, browser snapshots, canonical taxonomy fallback, terminal
module graph, provider fan-out envelopes, and critical public assets.
"""
from __future__ import annotations

import argparse
import importlib
import json
import sys
from pathlib import Path
from typing import Any

TOOLS_ROOT = Path(__file__).resolve().parent
REPO_ROOT = TOOLS_ROOT.parents[1]
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

from providers.common import BaseProvider
from terminal.config import APIConfig
from terminal.server import TerminalAPIServer


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Speciedex offline integration self-tests.")
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    args = parser.parse_args()

    checks: list[dict[str, Any]] = []

    def check(name: str, ok: bool, **detail: Any) -> None:
        checks.append({"name": name, "ok": bool(ok), **detail})

    registry = load_json(TOOLS_ROOT / "providers.json")["providers"]
    names = [item["name"] for item in registry]
    check(
        "provider-registry",
        len(registry) >= 70 and len(names) == len(set(names)) and all(item.get("enabled") is True for item in registry),
        providers=len(registry),
    )

    import_errors: list[str] = []
    for definition in registry:
        try:
            module = importlib.import_module(definition["module"])
            cls = getattr(module, "Provider", None)
            if cls is None or not issubclass(cls, BaseProvider) or not callable(getattr(cls, "fetch", None)):
                import_errors.append(definition["name"])
        except Exception as exc:  # pragma: no cover - diagnostic path
            import_errors.append(f"{definition['name']}: {exc}")
    check("provider-modules", not import_errors, imported=len(registry) - len(import_errors), errors=import_errors)

    conformance_path = REPO_ROOT / "static/data/provider-conformance.json"
    conformance = load_json(conformance_path) if conformance_path.exists() else {}
    conformance_records = conformance.get("results", []) if isinstance(conformance, dict) else []
    conformant_names = {
        str(item.get("provider")) for item in conformance_records
        if isinstance(item, dict) and item.get("status") == "passed"
    }
    check(
        "provider-conformance-report",
        set(names) == conformant_names and len(conformant_names) == len(registry),
        conformant=len(conformant_names),
    )

    schema_missing: list[str] = []
    test_missing: list[str] = []
    for definition in registry:
        name = definition["name"]
        schema_path = REPO_ROOT / str(definition.get("response_schema_path") or "")
        if not schema_path.is_file():
            schema_missing.append(name)
        dedicated_test = TOOLS_ROOT / "tests" / f"test_{name}.py"
        if not dedicated_test.is_file():
            test_missing.append(name)
    check(
        "provider-schemas-tests",
        not schema_missing and not test_missing,
        schemas=len(registry) - len(schema_missing),
        dedicated_tests=len(registry) - len(test_missing),
        errors=[*(f"missing-schema:{name}" for name in schema_missing), *(f"missing-test:{name}" for name in test_missing)],
    )

    db_snapshot = load_json(REPO_ROOT / "static/data/db/providers.json")
    api_snapshot = load_json(REPO_ROOT / "api/speciedex/v1/providers.json")
    registry_names = {item["name"] for item in registry}
    if isinstance(db_snapshot, dict) and "expected_providers" in db_snapshot:
        db_materialized = db_snapshot.get("providers", [])
        db_provider_index_ok = (
            int(db_snapshot.get("expected_providers", -1)) == len(registry)
            and isinstance(db_materialized, list)
            and all(
                (isinstance(item, str) and item in registry_names)
                or (isinstance(item, dict) and str(item.get("provider") or item.get("id") or "") in registry_names)
                for item in db_materialized
            )
        )
        db_indexed_provider_count = len(db_materialized)
    else:
        db_provider_index_ok = (
            isinstance(db_snapshot, dict)
            and set(db_snapshot).issubset(registry_names)
            and all(isinstance(values, list) for values in db_snapshot.values())
        )
        db_indexed_provider_count = len(db_snapshot) if isinstance(db_snapshot, dict) else None
    api_provider_registry_ok = (
        api_snapshot.get("count") == len(registry)
        and len(api_snapshot.get("providers", [])) == len(registry)
        and {item.get("id") for item in api_snapshot.get("providers", [])} == registry_names
    )
    check(
        "provider-snapshots",
        db_provider_index_ok and api_provider_registry_ok,
        db_indexed_providers=db_indexed_provider_count,
        api_count=api_snapshot.get("count"),
    )

    config = APIConfig(repo_root=REPO_ROOT)
    server = TerminalAPIServer(config)
    provider_response = server.router.dispatch("GET", "/providers", {"limit": ["10000"]}, b"")
    search_response = server.router.dispatch("GET", "/search", {"q": ["Animalia"], "limit": ["3"]}, b"")
    fanout_response = server.router.dispatch(
        "POST",
        "/provider-search",
        {},
        json.dumps({"q": "Animalia", "limit_per_provider": 1, "workers": 16}).encode("utf-8"),
    )
    fanout = fanout_response.payload if fanout_response.status == 200 else {}
    check(
        "terminal-api",
        provider_response.status == 200
        and provider_response.payload.get("total") == len(registry)
        and search_response.status == 200
        and search_response.payload.get("count", 0) >= 1
        and fanout_response.status == 200
        and fanout.get("provider_count") == len(registry)
        and len(fanout.get("providers", [])) == len(registry),
        search_source=search_response.payload.get("source") if search_response.status == 200 else None,
        provider_count=fanout.get("provider_count"),
    )

    widget_categories = [
        "enabled", "eligible", "assertions", "documentation",
        "errors", "latency", "overlap", "statistics",
    ]
    widget_failures: list[str] = []
    for category in widget_categories:
        response = server.router.dispatch("GET", f"/providers/{category}", {"limit": ["10000"]}, b"")
        if response.status != 200 or "records" not in response.payload:
            widget_failures.append(category)
    species = server.router.dispatch("GET", "/providers/species", {"provider": ["gbif"], "limit": ["3"]}, b"")
    if species.status != 200 or len(species.payload.get("records", [])) != 3:
        widget_failures.append("species")
    check("provider-widget-routes", not widget_failures, routes=9, failures=widget_failures)

    manifest = load_json(REPO_ROOT / "static/js/terminal/manifest.json")
    modules = manifest.get("modules", [])
    module_names = [item.get("name") for item in modules]
    graph_errors: list[str] = []
    for module in modules:
        path = REPO_ROOT / "static/js/terminal" / str(module.get("path") or "")
        if not path.exists():
            graph_errors.append(f"missing:{module.get('path')}")
        for dependency in module.get("dependencies", []):
            if dependency not in module_names:
                graph_errors.append(f"dependency:{module.get('name')}->{dependency}")
    check(
        "terminal-module-graph",
        len(module_names) == len(set(module_names)) and "animation" in module_names and not graph_errors,
        modules=len(modules),
        errors=graph_errors,
    )

    critical_assets = [
        "static/data/taxonomy/manifest.json",
        "static/js/terminal/visualization/terminal-cmatrix.js",
        "static/js/terminal/visualization/terminal-zmatrix.js",
        "static/logos/speciedex/logo.png",
        "static/images/taxonomy-classes/manifest.json",
        "api/speciedex/v1/providers/assertions.json",
        "_partials/terminal.html",
    ]
    missing_assets = [item for item in critical_assets if not (REPO_ROOT / item).exists()]
    check("critical-assets", not missing_assets, missing=missing_assets)

    passed = sum(1 for item in checks if item["ok"])
    result = {
        "ok": passed == len(checks),
        "version": "2026.10.08-r7",
        "passed": passed,
        "total": len(checks),
        "checks": checks,
    }
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        for item in checks:
            status = "PASS" if item["ok"] else "FAIL"
            detail = " ".join(f"{k}={v}" for k, v in item.items() if k not in {"name", "ok", "errors", "failures", "missing"})
            print(f"[{status}] {item['name']} {detail}".rstrip())
            for key in ("errors", "failures", "missing"):
                for value in item.get(key, []):
                    print(f"        {key}: {value}")
        print(f"Speciedex self-test: {passed}/{len(checks)} passed")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
