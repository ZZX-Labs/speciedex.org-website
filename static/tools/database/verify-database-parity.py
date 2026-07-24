#!/usr/bin/env python3
from __future__ import annotations
import argparse
import gzip
import re
import sqlite3
from pathlib import Path
from common import atomic_write_json, load_manifest, utc_now

INSERT_RE = re.compile(r"^\(", re.MULTILINE)

def sqlite_count(path: Path) -> int:
    connection = sqlite3.connect(path)
    try:
        return int(connection.execute("SELECT COUNT(*) FROM taxa").fetchone()[0])
    finally:
        connection.close()

def mariadb_count(path: Path) -> int:
    count = 0
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        for line in handle:
            if line.startswith("("):
                count += 1
    return count

def main() -> int:
    parser = argparse.ArgumentParser(description="Verify SQLite/MariaDB shard parity.")
    parser.add_argument("--db-root", type=Path, default=Path("static/data/db"))
    parser.add_argument("--report", type=Path, default=Path("static/data/db/reports/parity.json"))
    args = parser.parse_args()

    sqlite_manifest = load_manifest(args.db_root / "sqlite/manifest.json")
    mariadb_manifest = load_manifest(args.db_root / "mariadb/manifest.json")
    sqlite_shards = sqlite_manifest.get("shards", [])
    mariadb_shards = mariadb_manifest.get("shards", [])
    issues = []

    if len(sqlite_shards) != len(mariadb_shards):
        issues.append("Shard counts differ.")

    results = []
    for sqlite_info, mariadb_info in zip(sqlite_shards, mariadb_shards):
        sqlite_path = args.db_root / "sqlite" / sqlite_info["path"]
        mariadb_path = args.db_root / "mariadb" / mariadb_info["path"]
        sqlite_rows = sqlite_count(sqlite_path)
        mariadb_rows = mariadb_count(mariadb_path)
        equal = sqlite_rows == mariadb_rows == sqlite_info["records"] == mariadb_info["records"]
        if not equal:
            issues.append(f"Row-count mismatch for shard {sqlite_info['id']}.")
        results.append({
            "id": sqlite_info["id"],
            "sqlite_rows": sqlite_rows,
            "mariadb_rows": mariadb_rows,
            "manifest_sqlite_rows": sqlite_info["records"],
            "manifest_mariadb_rows": mariadb_info["records"],
            "equal": equal,
        })

    report = {
        "generated_at": utc_now(),
        "equal": not issues,
        "issues": issues,
        "shards": results,
    }
    atomic_write_json(args.report, report)
    if issues:
        print("\n".join(issues))
        return 1
    print("SQLite and MariaDB shard row counts are in parity.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
