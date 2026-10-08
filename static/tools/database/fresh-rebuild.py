#!/usr/bin/env python3
"""
Purge generated Speciedex database products and rebuild them from the
canonical taxonomy archive.

This tool intentionally preserves static/data/taxonomy, including canonical
volumes, provider assertion revisions, conflicts, references, and provider
state. Only generated database/index products beneath static/data/db are
removed.
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path


def inside(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def parse_args() -> argparse.Namespace:
    repo_root = Path(__file__).resolve().parents[3]
    parser = argparse.ArgumentParser(
        description="Freshly rebuild generated Speciedex database products.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=repo_root,
        help="Speciedex repository root.",
    )
    parser.add_argument(
        "--taxonomy-root",
        type=Path,
        default=Path("static/data/taxonomy"),
        help="Canonical taxonomy archive relative to the repository root.",
    )
    parser.add_argument(
        "--db-root",
        type=Path,
        default=Path("static/data/db"),
        help="Generated database root relative to the repository root.",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Confirm deletion of generated database products.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the purge/rebuild plan without deleting or rebuilding.",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable verbose output from the database updater.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    repo_root = args.repo_root.resolve()
    taxonomy_root = (
        args.taxonomy_root if args.taxonomy_root.is_absolute()
        else repo_root / args.taxonomy_root
    ).resolve()
    db_root = (
        args.db_root if args.db_root.is_absolute()
        else repo_root / args.db_root
    ).resolve()

    updater = repo_root / "static/tools/database/update-databases.py"

    if not repo_root.is_dir():
        raise SystemExit(f"Repository root does not exist: {repo_root}")
    if not taxonomy_root.is_dir():
        raise SystemExit(f"Canonical taxonomy root does not exist: {taxonomy_root}")
    if not updater.is_file():
        raise SystemExit(f"Database updater not found: {updater}")
    if not inside(db_root, repo_root):
        raise SystemExit("Refusing to purge a database path outside the repository.")
    if db_root == taxonomy_root or inside(taxonomy_root, db_root):
        raise SystemExit("Refusing to purge a path that contains canonical taxonomy data.")

    print(f"Canonical taxonomy preserved: {taxonomy_root}")
    print(f"Generated database purge target: {db_root}")

    command = [
        sys.executable,
        str(updater),
        "--taxonomy-root",
        str(taxonomy_root),
        "--db-root",
        str(db_root),
        "--clean",
        "--verify",
        "--publish",
        "--strict-records",
        "--include-canonical-name",
        "--include-taxonomy",
        "--shard-indexes",
    ]
    if args.verbose:
        command.append("--verbose")

    if args.dry_run:
        print("DRY RUN: would delete generated database products and run:")
        print(" ".join(command))
        return 0

    if not args.yes:
        raise SystemExit(
            "Refusing to delete generated database products without --yes. "
            "Canonical taxonomy data would be preserved."
        )

    if db_root.exists():
        shutil.rmtree(db_root)
    db_root.mkdir(parents=True, exist_ok=True)

    return subprocess.run(command, cwd=repo_root, check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())
