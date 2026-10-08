#!/usr/bin/env python3
"""Mount private Speciedex provider exports into the public repo at runtime.

The public provider registry intentionally points file-backed adapters at
``static/data/import``.  This utility lets GitHub Actions keep those large or
licensed/raw source exports in a separate private repository while preserving
all existing provider adapter paths.

No provider data is copied into Git history by this tool.  By default it creates
symlinks only for missing targets and records every link it created so the
runtime mount can be audited or removed safely.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any, Iterable

IMPORT_PREFIX = Path("static/data/import")
DEFAULT_REGISTRY = Path("static/tools/providers.json")
DEFAULT_STATE = Path(".runtime/provider-data-mount-state.json")


@dataclass(frozen=True)
class Requirement:
    provider: str
    registry_path: str
    relative_path: str


def _inside(path: Path, root: Path) -> bool:
    try:
        path.resolve(strict=False).relative_to(root.resolve(strict=False))
        return True
    except ValueError:
        return False


def load_requirements(repo_root: Path, registry_path: Path) -> list[Requirement]:
    path = registry_path if registry_path.is_absolute() else repo_root / registry_path
    payload = json.loads(path.read_text(encoding="utf-8"))
    definitions = payload.get("providers") if isinstance(payload, dict) else None
    if not isinstance(definitions, list):
        raise SystemExit(f"Provider registry has no providers list: {path}")

    requirements: list[Requirement] = []
    seen_targets: dict[str, str] = {}

    for definition in definitions:
        if not isinstance(definition, dict):
            continue
        provider = str(definition.get("name") or "").strip()
        configured = str(definition.get("path") or "").strip()
        if not provider or not configured:
            continue

        target = Path(configured)
        if target.is_absolute():
            raise SystemExit(
                f"Provider {provider!r} uses an absolute dataset path; "
                "private mounts require repository-relative paths."
            )
        try:
            relative = target.relative_to(IMPORT_PREFIX)
        except ValueError:
            # A file-backed provider outside static/data/import is not part of
            # the private import-data contract and must remain locally managed.
            continue

        key = target.as_posix()
        previous = seen_targets.get(key)
        if previous and previous != provider:
            raise SystemExit(
                f"Provider dataset path collision: {previous!r} and {provider!r} "
                f"both use {key!r}."
            )
        seen_targets[key] = provider
        requirements.append(
            Requirement(provider=provider, registry_path=key, relative_path=relative.as_posix())
        )

    requirements.sort(key=lambda item: item.provider)
    return requirements


def candidate_import_roots(source_root: Path) -> list[Path]:
    """Return supported private-repository layouts in priority order."""
    candidates = [
        source_root / "import",
        source_root / "static" / "data" / "import",
        source_root / "providers" / "import",
        source_root,
    ]
    unique: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        key = str(candidate.resolve(strict=False))
        if key not in seen:
            seen.add(key)
            unique.append(candidate)
    return unique


def select_source_root(source_root: Path, requirements: Iterable[Requirement]) -> tuple[Path, int]:
    requirements = list(requirements)
    best_root = source_root
    best_count = -1
    for candidate in candidate_import_roots(source_root):
        if not candidate.exists():
            count = 0
        else:
            count = sum((candidate / item.relative_path).exists() for item in requirements)
        if count > best_count:
            best_root, best_count = candidate, count
    return best_root, max(best_count, 0)


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def mount(
    *,
    repo_root: Path,
    source_root: Path | None,
    registry_path: Path,
    report_path: Path | None,
    state_path: Path,
    copy_mode: bool,
) -> dict[str, Any]:
    repo_root = repo_root.resolve()
    requirements = load_requirements(repo_root, registry_path)
    import_root = (repo_root / IMPORT_PREFIX).resolve(strict=False)
    import_root.mkdir(parents=True, exist_ok=True)

    selected_root: Path | None = None
    source_matches = 0
    if source_root is not None and source_root.exists():
        selected_root, source_matches = select_source_root(source_root.resolve(), requirements)

    mounted: list[dict[str, str]] = []
    local_present: list[dict[str, str]] = []
    missing: list[dict[str, str]] = []

    for requirement in requirements:
        target = repo_root / requirement.registry_path
        if not _inside(target, import_root):
            raise SystemExit(f"Unsafe provider import target: {target}")

        if target.exists() or target.is_symlink():
            local_present.append(
                {
                    "provider": requirement.provider,
                    "path": requirement.registry_path,
                    "kind": "existing",
                }
            )
            continue

        source = selected_root / requirement.relative_path if selected_root is not None else None
        if source is None or not source.exists():
            missing.append(
                {
                    "provider": requirement.provider,
                    "path": requirement.registry_path,
                }
            )
            continue

        if not _inside(source, selected_root):
            raise SystemExit(f"Unsafe provider-data source path: {source}")

        target.parent.mkdir(parents=True, exist_ok=True)
        if copy_mode:
            if source.is_dir():
                shutil.copytree(source, target)
            else:
                shutil.copy2(source, target)
            kind = "copy"
        else:
            target.symlink_to(source.resolve(), target_is_directory=source.is_dir())
            kind = "symlink"

        mounted.append(
            {
                "provider": requirement.provider,
                "path": requirement.registry_path,
                "source": str(source),
                "kind": kind,
            }
        )

    state = {
        "schema_version": 1,
        "repo_root": str(repo_root),
        "import_root": str(import_root),
        "created": mounted,
    }
    _write_json(state_path if state_path.is_absolute() else repo_root / state_path, state)

    payload: dict[str, Any] = {
        "schema_version": 1,
        "requirements": len(requirements),
        "source_repository_available": bool(source_root is not None and source_root.exists()),
        "selected_source_root": str(selected_root) if selected_root is not None else None,
        "source_matches": source_matches,
        "mounted": len(mounted),
        "local_present": len(local_present),
        "available_after_mount": len(mounted) + len(local_present),
        "missing": len(missing),
        "mounted_providers": mounted,
        "local_providers": local_present,
        "missing_providers": missing,
    }

    if report_path is not None:
        target = report_path if report_path.is_absolute() else repo_root / report_path
        _write_json(target, payload)

    return payload


def unmount(*, repo_root: Path, state_path: Path) -> dict[str, Any]:
    repo_root = repo_root.resolve()
    path = state_path if state_path.is_absolute() else repo_root / state_path
    if not path.is_file():
        return {"schema_version": 1, "removed": 0, "state_found": False}

    payload = json.loads(path.read_text(encoding="utf-8"))
    created = payload.get("created", []) if isinstance(payload, dict) else []
    removed = 0

    for item in created:
        if not isinstance(item, dict):
            continue
        target_text = str(item.get("path") or "").strip()
        kind = str(item.get("kind") or "")
        if not target_text:
            continue
        target = repo_root / target_text
        if kind == "symlink":
            if target.is_symlink():
                target.unlink()
                removed += 1
        elif kind == "copy":
            # Copies are only removed when they are still untracked runtime
            # products.  Never delete a pre-existing local dataset.
            if target.is_dir():
                shutil.rmtree(target)
                removed += 1
            elif target.exists():
                target.unlink()
                removed += 1

    path.unlink(missing_ok=True)
    return {"schema_version": 1, "removed": removed, "state_found": True}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--registry", default=str(DEFAULT_REGISTRY))
    parser.add_argument("--source-root", default="")
    parser.add_argument("--report", default="")
    parser.add_argument("--state", default=str(DEFAULT_STATE))
    parser.add_argument("--copy", action="store_true", help="Copy datasets instead of symlinking them.")
    parser.add_argument("--unmount", action="store_true", help="Remove only runtime mounts created by a prior run.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    repo_root = Path(args.repo_root)
    state_path = Path(args.state)

    if args.unmount:
        result = unmount(repo_root=repo_root, state_path=state_path)
    else:
        source_root = Path(args.source_root) if str(args.source_root).strip() else None
        report_path = Path(args.report) if str(args.report).strip() else None
        result = mount(
            repo_root=repo_root,
            source_root=source_root,
            registry_path=Path(args.registry),
            report_path=report_path,
            state_path=state_path,
            copy_mode=bool(args.copy),
        )

    json.dump(result, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
