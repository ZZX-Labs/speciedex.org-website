from pathlib import Path
from provider_conformance import run_provider

REPO_ROOT = Path(__file__).resolve().parents[3]

def test_youtube_adapter_conformance():
    result = run_provider(REPO_ROOT, "youtube")
    assert result["status"] == "passed"
    assert result["records"] >= 1
