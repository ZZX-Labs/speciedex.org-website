#!/usr/bin/env python3
from __future__ import annotations
import argparse
from pathlib import Path
from common import load_manifest, sqlite_rows, write_jsonl

def main() -> int:
    parser = argparse.ArgumentParser(description="Import SQLite shards back into canonical JSONL.")
    parser.add_argument("--sqlite-root", type=Path, default=Path("static/data/db/sqlite"))
    parser.add_argument("--output", type=Path, default=Path("static/data/taxonomy/imported/sqlite-import.jsonl"))
    args = parser.parse_args()

    manifest = load_manifest(args.sqlite_root / "manifest.json")
    def records():
        for shard in manifest.get("shards", []):
            yield from sqlite_rows(args.sqlite_root / shard["path"])

    count = write_jsonl(args.output, records())
    print(f"Imported {count} records from SQLite shards.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
