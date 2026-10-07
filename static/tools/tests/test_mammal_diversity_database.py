from pathlib import Path
from provider_conformance import run_provider

REPO_ROOT = Path(__file__).resolve().parents[3]

def test_mammal_diversity_database_adapter_conformance():
    result = run_provider(REPO_ROOT, "mammal_diversity_database")
    assert result["status"] == "passed"
    assert result["records"] >= 1
