from pathlib import Path
from provider_conformance import run_provider

REPO_ROOT = Path(__file__).resolve().parents[3]

def test_world_flora_online_adapter_conformance():
    result = run_provider(REPO_ROOT, "world_flora_online")
    assert result["status"] == "passed"
    assert result["records"] >= 1
