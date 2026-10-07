from pathlib import Path
from provider_conformance import run_provider

REPO_ROOT = Path(__file__).resolve().parents[3]

def test_world_spider_catalog_adapter_conformance():
    result = run_provider(REPO_ROOT, "world_spider_catalog")
    assert result["status"] == "passed"
    assert result["records"] >= 1
