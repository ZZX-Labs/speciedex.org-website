#!/usr/bin/env python3
from __future__ import annotations
import argparse
from collections import defaultdict
from pathlib import Path
from common import atomic_write_json, iter_canonical_records, utc_now

def main() -> int:
    parser = argparse.ArgumentParser(description="Build Speciedex browser indexes.")
    parser.add_argument("--taxonomy-root", type=Path, default=Path("static/data/taxonomy"))
    parser.add_argument("--output", type=Path, default=Path("static/data/db/indexes"))
    args = parser.parse_args()

    args.output.mkdir(parents=True, exist_ok=True)
    species = {}
    names = defaultdict(list)
    providers = defaultdict(list)
    taxonomy = defaultdict(lambda: defaultdict(list))
    shard_index = []

    count = 0
    for record in iter_canonical_records(args.taxonomy_root):
        count += 1
        identifier = record["speciedex_id"]
        compact = {
            "id": identifier,
            "scientific_name": record["scientific_name"],
            "common_name": record["common_name"],
            "rank": record["rank"],
            "provider": record["provider"],
            "indexed_at": record["indexed_at"],
        }
        species[identifier] = compact
        for value in (
            record["scientific_name"],
            record["canonical_name"],
            record["common_name"],
        ):
            key = value.casefold().strip()
            if key:
                names[key].append(identifier)
        providers[record["provider"] or "unknown"].append(identifier)
        for rank in ("domain", "kingdom", "phylum", "class_name", "order_name", "family", "genus"):
            value = record.get(rank, "")
            if value:
                taxonomy[rank][value].append(identifier)

    atomic_write_json(args.output / "species.json", species)
    atomic_write_json(args.output / "names.json", dict(sorted(names.items())))
    atomic_write_json(args.output / "providers.json", dict(sorted(providers.items())))
    atomic_write_json(
        args.output / "taxonomy.json",
        {rank: dict(sorted(values.items())) for rank, values in taxonomy.items()},
    )
    manifest = {
        "schema_version": 1,
        "generated_at": utc_now(),
        "source": args.taxonomy_root.as_posix(),
        "records": count,
        "indexes": [
            "species.json",
            "names.json",
            "providers.json",
            "taxonomy.json",
        ],
    }
    atomic_write_json(args.output / "manifest.json", manifest)
    print(f"Built browser indexes for {count} records.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
