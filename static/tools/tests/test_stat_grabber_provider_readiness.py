"""Regression tests for deployment provider readiness reporting."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
STAT_GRABBER = REPO_ROOT / "static" / "tools" / "stat-grabber.py"
REGISTRY = REPO_ROOT / "static" / "tools" / "providers.json"


def _load_stat_grabber():
    spec = importlib.util.spec_from_file_location("speciedex_stat_grabber", STAT_GRABBER)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_missing_dwca_archive_is_not_eligible(tmp_path):
    module = _load_stat_grabber()
    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    definition = next(
        item for item in registry["providers"]
        if item["name"] == "darwin_core_archive"
    )
    definition = dict(definition)
    definition["path"] = str(tmp_path / "missing-dwca")
    eligible, reason = module.provider_available(definition)
    assert eligible is False
    assert "missing dataset" in reason


def test_present_dwca_directory_is_eligible(tmp_path):
    module = _load_stat_grabber()
    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    definition = next(
        item for item in registry["providers"]
        if item["name"] == "darwin_core_archive"
    )
    archive = tmp_path / "dwca"
    archive.mkdir()
    (archive / "taxon.txt").write_text("id\tscientificName\n1\tTest species\n", encoding="utf-8")
    definition = dict(definition)
    definition["path"] = str(archive)
    eligible, reason = module.provider_available(definition)
    assert eligible is True
    assert reason == ""
