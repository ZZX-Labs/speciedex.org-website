#!/usr/bin/env python3
from __future__ import annotations
import argparse
from pathlib import Path
from common import atomic_write_json, load_manifest, sha256_file, utc_now

def main() -> int:
    parser = argparse.ArgumentParser(description="Build top-level Speciedex database manifests.")
    parser.add_argument("--db-root", type=Path, default=Path("static/data/db"))
    args = parser.parse_args()

    sqlite_manifest = load_manifest(args.db_root / "sqlite/manifest.json")
    mariadb_manifest = load_manifest(args.db_root / "mariadb/manifest.json")
    index_manifest = load_manifest(args.db_root / "indexes/manifest.json")

    files = []
    checksums = {}
    for path in sorted(args.db_root.rglob("*")):
        if not path.is_file() or path.name == "checksums.json":
            continue
        relative = path.relative_to(args.db_root).as_posix()
        files.append(relative)
        checksums[relative] = {
            "sha256": sha256_file(path),
            "bytes": path.stat().st_size,
        }

    manifest = {
        "schema_version": 1,
        "generated_at": utc_now(),
        "canonical_source": "../taxonomy/",
        "sqlite": "sqlite/manifest.json",
        "mariadb": "mariadb/manifest.json",
        "indexes": "indexes/manifest.json",
        "updates": "updates/manifest.json",
        "parity": {
            "sqlite_records": sqlite_manifest["totals"]["records"],
            "mariadb_records": mariadb_manifest["totals"]["records"],
            "equal": sqlite_manifest["totals"]["records"] == mariadb_manifest["totals"]["records"],
        },
        "files": files,
    }
    atomic_write_json(args.db_root / "manifest.json", manifest)
    atomic_write_json(args.db_root / "checksums.json", {
        "generated_at": utc_now(),
        "algorithm": "sha256",
        "files": checksums,
    })
    atomic_write_json(args.db_root / "build-state.json", {
        "generated_at": utc_now(),
        "sqlite": sqlite_manifest["totals"],
        "mariadb": mariadb_manifest["totals"],
        "indexes": index_manifest,
        "complete": manifest["parity"]["equal"],
    })
    print("Built top-level database manifests and checksums.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
