#!/usr/bin/env python3
from __future__ import annotations
import argparse
import json
import subprocess
import sys
from pathlib import Path
from common import atomic_write_json, iter_canonical_records, stable_json, utc_now, write_jsonl

def run(script: Path, *arguments: str) -> None:
    subprocess.run([sys.executable, str(script), *arguments], check=True)

def main() -> int:
    parser = argparse.ArgumentParser(description="Update all Speciedex database products atomically.")
    parser.add_argument("--taxonomy-root", type=Path, default=Path("static/data/taxonomy"))
    parser.add_argument("--db-root", type=Path, default=Path("static/data/db"))
    args = parser.parse_args()

    here = Path(__file__).resolve().parent
    previous_hashes = {}
    species_index = args.db_root / "indexes/species.json"
    if species_index.exists():
        try:
            previous = json.loads(species_index.read_text(encoding="utf-8"))
            previous_hashes = {
                identifier: stable_json(record)
                for identifier, record in previous.items()
            }
        except Exception:
            previous_hashes = {}

    run(here / "build-sqlite-shards.py", "--taxonomy-root", str(args.taxonomy_root), "--output", str(args.db_root / "sqlite"))
    run(here / "build-mariadb-shards.py", "--taxonomy-root", str(args.taxonomy_root), "--output", str(args.db_root / "mariadb"))
    run(here / "build-db-indexes.py", "--taxonomy-root", str(args.taxonomy_root), "--output", str(args.db_root / "indexes"))
    run(here / "verify-shards.py", "--db-root", str(args.db_root))
    run(here / "verify-database-parity.py", "--db-root", str(args.db_root))
    run(here / "build-db-manifests.py", "--db-root", str(args.db_root))

    additions = []
    current_ids = set()
    for record in iter_canonical_records(args.taxonomy_root):
        current_ids.add(record["speciedex_id"])
        compact = {
            "id": record["speciedex_id"],
            "scientific_name": record["scientific_name"],
            "common_name": record["common_name"],
            "rank": record["rank"],
            "provider": record["provider"],
            "indexed_at": record["indexed_at"],
        }
        if previous_hashes.get(record["speciedex_id"]) != stable_json(compact):
            additions.append(record)

    deletions = sorted(set(previous_hashes) - current_ids)
    stamp = utc_now().replace(":", "").replace("-", "")
    updates_root = args.db_root / "updates"
    additions_name = f"additions-{stamp}.jsonl.gz"
    deletions_name = f"deletions-{stamp}.json"
    write_jsonl(updates_root / additions_name, additions, gzip_output=True)
    atomic_write_json(updates_root / deletions_name, deletions)
    manifest = {
        "schema_version": 1,
        "generated_at": utc_now(),
        "latest": {
            "additions": additions_name,
            "deletions": deletions_name,
        },
        "counts": {
            "additions_or_changes": len(additions),
            "deletions": len(deletions),
        },
    }
    atomic_write_json(updates_root / "manifest.json", manifest)
    print("Updated all Speciedex database products.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
