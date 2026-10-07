from pathlib import Path
from provider_conformance import run_provider

REPO_ROOT = Path(__file__).resolve().parents[3]

def test_ioc_world_bird_list_adapter_conformance():
    result = run_provider(REPO_ROOT, "ioc_world_bird_list")
    assert result["status"] == "passed"
    assert result["records"] >= 1
