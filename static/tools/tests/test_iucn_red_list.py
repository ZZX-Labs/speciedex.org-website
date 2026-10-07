from pathlib import Path
from provider_conformance import run_provider

REPO_ROOT = Path(__file__).resolve().parents[3]

def test_iucn_red_list_adapter_conformance():
    result = run_provider(REPO_ROOT, "iucn_red_list")
    assert result["status"] == "passed"
    assert result["records"] >= 1
