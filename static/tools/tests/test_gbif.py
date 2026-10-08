from pathlib import Path

from provider_conformance import FixtureHTTP, definition_for, run_provider
from providers.loader import load_provider

REPO_ROOT = Path(__file__).resolve().parents[3]


def test_gbif_adapter_conformance():
    result = run_provider(REPO_ROOT, "gbif")
    assert result["status"] == "passed"
    assert result["records"] >= 1


def test_gbif_unfiltered_catalogue_uses_species_search(tmp_path):
    definition = definition_for(REPO_ROOT, "gbif")
    http = FixtureHTTP("gbif")
    provider = load_provider(
        definition,
        http,
        tmp_path / "gbif.state.json",
        1,
        REPO_ROOT,
    )
    batch = provider.fetch()
    assert batch.records
    assert http.calls
    assert http.calls[0][0].rstrip("/").endswith("/species/search")
    assert http.calls[0][1]["offset"] == 0
    assert http.calls[0][1]["limit"] == 1
