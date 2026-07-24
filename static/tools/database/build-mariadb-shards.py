#!/usr/bin/env python3
from __future__ import annotations
import argparse
from pathlib import Path
from common import (
    DEFAULT_MAX_FILE_BYTES, DEFAULT_ROWS_PER_SHARD, DEFAULT_TARGET_FILE_BYTES,
    MARIADB_SCHEMA, atomic_write_text, build_mariadb_shard,
    check_max_file_size, chunk_records, iter_canonical_records,
    remove_generated_files, write_manifest,
)

def main() -> int:
    parser = argparse.ArgumentParser(description="Build Speciedex MariaDB logical shards.")
    parser.add_argument("--taxonomy-root", type=Path, default=Path("static/data/taxonomy"))
    parser.add_argument("--output", type=Path, default=Path("static/data/db/mariadb"))
    parser.add_argument("--rows-per-shard", type=int, default=DEFAULT_ROWS_PER_SHARD)
    parser.add_argument("--target-bytes", type=int, default=DEFAULT_TARGET_FILE_BYTES)
    parser.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_FILE_BYTES)
    args = parser.parse_args()

    args.output.mkdir(parents=True, exist_ok=True)
    remove_generated_files(args.output, ("speciedex-*.sql.gz", "manifest.json", "schema.sql"))
    atomic_write_text(args.output / "schema.sql", MARIADB_SCHEMA + "\n")
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
        destination = args.output / f"speciedex-{shard_id}.sql.gz"
        shards.append(build_mariadb_shard(records, destination, shard_id=shard_id))

    manifest = write_manifest(
        args.output / "manifest.json",
        kind="mariadb-logical",
        shards=shards,
        source=args.taxonomy_root.as_posix(),
        extra={"schema": "schema.sql", "compression": "gzip"},
    )
    violations = check_max_file_size(args.output.glob("*.sql.gz"), args.max_bytes)
    if violations:
        raise SystemExit(f"MariaDB shard size violations: {violations}")
    print(f"Built {manifest['totals']['shards']} MariaDB shards with {manifest['totals']['records']} records.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
