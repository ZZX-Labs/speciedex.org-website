from __future__ import annotations
import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]

def test_every_registry_provider_has_module_schema_and_dedicated_test():
    providers = json.loads((REPO_ROOT / "static/tools/providers.json").read_text(encoding="utf-8"))["providers"]
    assert len(providers) == 77
    names = [item["name"] for item in providers]
    assert len(names) == len(set(names))
    for item in providers:
        module = REPO_ROOT / "static/tools" / (item["module"].replace(".", "/") + ".py")
        schema = REPO_ROOT / item["response_schema_path"]
        test = REPO_ROOT / "static/tools/tests" / f"test_{item['name']}.py"
        assert module.is_file(), item["name"]
        assert schema.is_file(), item["name"]
        assert test.is_file(), item["name"]

def test_openalex_is_classified_as_live_api():
    providers = json.loads((REPO_ROOT / "static/tools/providers.json").read_text(encoding="utf-8"))["providers"]
    item = next(value for value in providers if value["name"] == "openalex")
    assert item["adapter"] == "openalex"
    assert item["runtime_mode"] == "live_api"
    assert "path" not in item
