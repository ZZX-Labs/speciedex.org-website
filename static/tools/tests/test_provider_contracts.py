from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path

TOOLS_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = TOOLS_ROOT.parents[1]
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

from providers.common import BaseProvider
from terminal.config import APIConfig
from terminal.server import TerminalAPIServer


def registry() -> list[dict]:
    data = json.loads((TOOLS_ROOT / "providers.json").read_text(encoding="utf-8"))
    return data["providers"]


def test_registry_contains_all_configured_providers() -> None:
    providers = registry()
    assert len(providers) >= 70
    names = [item["name"] for item in providers]
    assert len(names) == len(set(names))
    assert all(item.get("enabled") is True for item in providers)


def test_every_provider_module_imports_and_implements_contract() -> None:
    for definition in registry():
        module = importlib.import_module(definition["module"])
        provider_class = getattr(module, "Provider", None)
        assert provider_class is not None, definition["name"]
        assert issubclass(provider_class, BaseProvider), definition["name"]
        assert callable(getattr(provider_class, "fetch", None)), definition["name"]


def test_browser_provider_snapshots_match_registry() -> None:
    definitions = registry()
    expected = len(definitions)
    registry_names = {item["name"] for item in definitions}

    # static/data/db/providers.json is the browser provider->Speciedex-ID
    # membership index, not a second copy of the provider registry.  It is
    # therefore intentionally a mapping and can contain fewer than all 77
    # providers when only a subset currently has canonical records.
    db = json.loads((REPO_ROOT / "static/data/db/providers.json").read_text(encoding="utf-8"))
    assert isinstance(db, dict)
    if "expected_providers" in db:
        # Newer DB builds wrap the optional materialized provider membership
        # list with generation metadata.  The list may legitimately be empty
        # before provider-backed canonical records are materialized.
        assert int(db["expected_providers"]) == expected
        materialized = db.get("providers", [])
        assert isinstance(materialized, list)
        assert all(
            isinstance(item, str) and item in registry_names
            or isinstance(item, dict) and str(item.get("provider") or item.get("id") or "") in registry_names
            for item in materialized
        )
    else:
        # Legacy browser index: provider name -> Speciedex-ID list.
        assert set(db).issubset(registry_names)
        assert all(isinstance(values, list) for values in db.values())

    # The static API provider catalogue is the browser registry snapshot.
    api = json.loads((REPO_ROOT / "api/speciedex/v1/providers.json").read_text(encoding="utf-8"))
    assert api["count"] == expected == len(api["providers"])
    assert {item["id"] for item in api["providers"]} == registry_names


def test_terminal_provider_routes_and_jsonl_search() -> None:
    config = APIConfig(repo_root=REPO_ROOT)
    server = TerminalAPIServer(config)
    providers = server.router.dispatch("GET", "/providers", {"limit": ["1000"]}, b"")
    assert providers.status == 200
    assert providers.payload["total"] == len(registry())

    detail = server.router.dispatch("GET", "/providers/gbif", {}, b"")
    assert detail.status == 200
    assert detail.payload["id"] == "gbif"

    result = server.router.dispatch("GET", "/search", {"q": ["Animalia"], "limit": ["5"]}, b"")
    assert result.status == 200
    assert result.payload["source"] in {"sqlite", "taxonomy_jsonl"}
    assert result.payload["count"] >= 1


def test_provider_fanout_returns_an_envelope_for_every_provider() -> None:
    config = APIConfig(repo_root=REPO_ROOT)
    server = TerminalAPIServer(config)
    response = server.router.dispatch(
        "POST",
        "/provider-search",
        {},
        json.dumps({"q": "Animalia", "limit_per_provider": 2, "workers": 16}).encode(),
    )
    assert response.status == 200
    payload = response.payload
    assert payload["provider_count"] == len(registry())
    assert len(payload["providers"]) == len(registry())
    assert {item["provider"] for item in payload["providers"]} == {item["name"] for item in registry()}
    assert all(item["status"] in {"ok", "empty", "error"} for item in payload["providers"])


def test_all_provider_widget_routes_exist_and_return_structured_payloads() -> None:
    config = APIConfig(repo_root=REPO_ROOT)
    server = TerminalAPIServer(config)
    provider_count = len(registry())
    categories = {
        "enabled": provider_count,
        "eligible": provider_count,
        "assertions": 1,
        "documentation": provider_count,
        "errors": 1,
        "latency": provider_count,
        "overlap": 0,
        "statistics": provider_count,
    }
    for category, minimum in categories.items():
        response = server.router.dispatch("GET", f"/providers/{category}", {"limit": ["10000"]}, b"")
        assert response.status == 200, category
        assert "records" in response.payload, category
        assert response.payload["total"] >= minimum, category

    species = server.router.dispatch("GET", "/providers/species", {"provider": ["gbif"], "limit": ["3"]}, b"")
    assert species.status == 200
    assert len(species.payload["records"]) == 3
    assert all((record.get("initial_source") or {}).get("provider") == "gbif" for record in species.payload["records"])


def test_static_api_build_contains_provider_widget_snapshots() -> None:
    config = APIConfig(repo_root=REPO_ROOT)
    server = TerminalAPIServer(config)
    server.generate_static()
    expected = [
        "enabled", "eligible", "assertions", "documentation",
        "errors", "latency", "overlap", "statistics",
    ]
    for category in expected:
        path = config.static_api_root / "providers" / f"{category}.json"
        assert path.exists(), category
        payload = json.loads(path.read_text(encoding="utf-8"))

        if category != "assertions":
            assert "records" in payload, category
            continue

        # Assertions are deliberately sharded so the public Git repository
        # never recreates the former ~80 MB monolith.  The stable
        # assertions.json endpoint is now a volume index; each volume keeps
        # the ordinary records/assertions arrays for existing consumers.
        assert payload.get("schema") == "speciedex-provider-assertions-volume-index-v1"
        assert payload.get("sharded") is True
        volumes = payload.get("volumes") or []
        assert len(volumes) == payload.get("volume_count")
        assert volumes
        assert sum(int(item.get("count", 0)) for item in volumes) == int(payload.get("count", payload.get("total", 0)))
        for item in volumes:
            volume_path = config.static_api_root / str(item["path"])
            assert volume_path.exists(), volume_path
            volume = json.loads(volume_path.read_text(encoding="utf-8"))
            assert "records" in volume and "assertions" in volume
            assert len(volume["records"]) == int(item["count"])


def test_terminal_manifest_has_no_missing_assets_or_dependencies() -> None:
    manifest = json.loads((REPO_ROOT / "static/js/terminal/manifest.json").read_text(encoding="utf-8"))
    modules = manifest["modules"]
    names = [item["name"] for item in modules]
    assert len(names) == len(set(names))
    assert "animation" in names
    for module in modules:
        assert (REPO_ROOT / "static/js/terminal" / module["path"]).exists(), module["path"]
        for dependency in module.get("dependencies", []):
            assert dependency in names, (module["name"], dependency)
