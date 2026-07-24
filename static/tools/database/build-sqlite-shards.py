#!/usr/bin/env python3
from __future__ import annotations
import argparse
from pathlib import Path
from common import (
    DEFAULT_MAX_FILE_BYTES, DEFAULT_ROWS_PER_SHARD, DEFAULT_TARGET_FILE_BYTES,
    build_sqlite_shard, check_max_file_size, chunk_records,
    iter_canonical_records, remove_generated_files, write_manifest,
)

def main() -> int:
    parser = argparse.ArgumentParser(description="Build Speciedex SQLite shards.")
    parser.add_argument("--taxonomy-root", type=Path, default=Path("static/data/taxonomy"))
    parser.add_argument("--output", type=Path, default=Path("static/data/db/sqlite"))
    parser.add_argument("--rows-per-shard", type=int, default=DEFAULT_ROWS_PER_SHARD)
    parser.add_argument("--target-bytes", type=int, default=DEFAULT_TARGET_FILE_BYTES)
    parser.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_FILE_BYTES)
    args = parser.parse_args()

    args.output.mkdir(parents=True, exist_ok=True)
    remove_generated_files(args.output, ("speciedex-*.sqlite3", "manifest.json"))
    shards = []
    for index, records in enumerate(
        chunk_records(
            iter_canonical_records(args.taxonomy_root),
            rows_per_shard=args.rows_per_shard,
            target_bytes=args.target_bytes,
        ),
        1,
    ):
        shard_id = f"{index:06d}"
        destination = args.output / f"speciedex-{shard_id}.sqlite3"
        shards.append(build_sqlite_shard(records, destination, shard_id=shard_id))

    manifest = write_manifest(
        args.output / "manifest.json",
        kind="sqlite",
        shards=shards,
        source=args.taxonomy_root.as_posix(),
    )
    violations = check_max_file_size(args.output.glob("*.sqlite3"), args.max_bytes)
    if violations:
        raise SystemExit(f"SQLite shard size violations: {violations}")
    print(f"Built {manifest['totals']['shards']} SQLite shards with {manifest['totals']['records']} records.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
