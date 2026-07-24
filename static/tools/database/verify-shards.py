#!/usr/bin/env python3
from __future__ import annotations
import argparse
import gzip
import sqlite3
from pathlib import Path
from common import atomic_write_json, load_manifest, sha256_file, utc_now

def main() -> int:
    parser = argparse.ArgumentParser(description="Verify Speciedex database shard integrity.")
    parser.add_argument("--db-root", type=Path, default=Path("static/data/db"))
    parser.add_argument("--max-bytes", type=int, default=90 * 1024 * 1024)
    parser.add_argument("--report", type=Path, default=Path("static/data/db/reports/shards.json"))
    args = parser.parse_args()

    issues = []
    checks = []

    for kind in ("sqlite", "mariadb"):
        manifest = load_manifest(args.db_root / kind / "manifest.json")
        for shard in manifest.get("shards", []):
            path = args.db_root / kind / shard["path"]
            entry = {
                "kind": kind,
                "id": shard["id"],
                "path": path.as_posix(),
                "exists": path.exists(),
            }
            if not path.exists():
                issues.append(f"Missing {kind} shard: {path}")
                checks.append(entry)
                continue
            entry["bytes"] = path.stat().st_size
            entry["sha256"] = sha256_file(path)
            entry["checksum_ok"] = entry["sha256"] == shard["sha256"]
            entry["size_ok"] = entry["bytes"] <= args.max_bytes
            if not entry["checksum_ok"]:
                issues.append(f"Checksum mismatch: {path}")
            if not entry["size_ok"]:
                issues.append(f"Shard exceeds maximum size: {path}")
            if kind == "sqlite":
                connection = sqlite3.connect(path)
                try:
                    entry["integrity"] = connection.execute("PRAGMA integrity_check").fetchone()[0]
                    entry["rows"] = connection.execute("SELECT COUNT(*) FROM taxa").fetchone()[0]
                finally:
                    connection.close()
                if entry["integrity"] != "ok":
                    issues.append(f"SQLite integrity failure: {path}")
            else:
                try:
                    with gzip.open(path, "rt", encoding="utf-8") as handle:
                        first = handle.readline()
                    entry["gzip_ok"] = first.startswith("-- Speciedex")
                except OSError:
                    entry["gzip_ok"] = False
                if not entry["gzip_ok"]:
                    issues.append(f"MariaDB gzip failure: {path}")
            checks.append(entry)

    report = {
        "generated_at": utc_now(),
        "valid": not issues,
        "issues": issues,
        "checks": checks,
    }
    atomic_write_json(args.report, report)
    if issues:
        print("\n".join(issues))
        return 1
    print("All database shards passed integrity, checksum, and size checks.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
