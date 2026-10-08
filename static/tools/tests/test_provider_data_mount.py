from __future__ import annotations

import json
from pathlib import Path
import importlib.util
import sys

MODULE_PATH = Path(__file__).resolve().parents[1] / "provider-data-mount.py"
spec = importlib.util.spec_from_file_location("provider_data_mount", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
assert spec and spec.loader
sys.modules[spec.name] = module
spec.loader.exec_module(module)


def write_registry(root: Path) -> None:
    path = root / "static/tools/providers.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        "providers": [
            {"name": "alpha", "path": "static/data/import/alpha.jsonl"},
            {"name": "beta", "path": "static/data/import/beta/data.jsonl"},
            {"name": "live", "base_url": "https://example.invalid"},
        ]
    }), encoding="utf-8")


def test_mounts_private_import_tree_without_overwriting_local(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    private = tmp_path / "private"
    write_registry(repo)
    (repo / "static/data/import").mkdir(parents=True)
    (repo / "static/data/import/alpha.jsonl").write_text("local\n", encoding="utf-8")
    (private / "import/beta").mkdir(parents=True)
    (private / "import/beta/data.jsonl").write_text("private\n", encoding="utf-8")

    result = module.mount(
        repo_root=repo,
        source_root=private,
        registry_path=Path("static/tools/providers.json"),
        report_path=Path(".runtime/report.json"),
        state_path=Path(".runtime/state.json"),
        copy_mode=False,
    )

    assert result["requirements"] == 2
    assert result["mounted"] == 1
    assert result["local_present"] == 1
    assert result["missing"] == 0
    assert (repo / "static/data/import/alpha.jsonl").read_text() == "local\n"
    target = repo / "static/data/import/beta/data.jsonl"
    assert target.is_symlink()
    assert target.read_text() == "private\n"


def test_missing_private_repo_is_inventory_only(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    write_registry(repo)
    result = module.mount(
        repo_root=repo,
        source_root=None,
        registry_path=Path("static/tools/providers.json"),
        report_path=None,
        state_path=Path(".runtime/state.json"),
        copy_mode=False,
    )
    assert result["requirements"] == 2
    assert result["mounted"] == 0
    assert result["missing"] == 2


def test_unmount_removes_only_created_symlinks(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    private = tmp_path / "private"
    write_registry(repo)
    (private / "import").mkdir(parents=True)
    (private / "import/alpha.jsonl").write_text("a\n", encoding="utf-8")
    (private / "import/beta").mkdir(parents=True)
    (private / "import/beta/data.jsonl").write_text("b\n", encoding="utf-8")
    module.mount(
        repo_root=repo,
        source_root=private,
        registry_path=Path("static/tools/providers.json"),
        report_path=None,
        state_path=Path(".runtime/state.json"),
        copy_mode=False,
    )
    result = module.unmount(repo_root=repo, state_path=Path(".runtime/state.json"))
    assert result["removed"] == 2
    assert not (repo / "static/data/import/alpha.jsonl").exists()
    assert not (repo / "static/data/import/beta/data.jsonl").exists()
