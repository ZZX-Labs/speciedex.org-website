#!/usr/bin/env python3
from __future__ import annotations
import argparse
import gzip
import re
from pathlib import Path
from common import SQLITE_COLUMNS, load_manifest, write_jsonl

VALUE_RE = re.compile(r"\((.*)\),?$")

def split_sql_values(row: str):
    values, current, quoted, escape = [], [], False, False
    for char in row:
        if escape:
            current.append(char)
            escape = False
        elif char == "\\":
            current.append(char)
            escape = True
        elif char == "'":
            current.append(char)
            quoted = not quoted
        elif char == "," and not quoted:
            values.append("".join(current).strip())
            current = []
        else:
            current.append(char)
    values.append("".join(current).strip())
    return values

def decode_sql(value: str):
    if value.upper() == "NULL":
        return None
    if value.startswith("'") and value.endswith("'"):
        return value[1:-1].replace("''", "'").replace("\\\\", "\\")
    try:
        return float(value) if "." in value else int(value)
    except ValueError:
        return value

def iter_rows(path: Path):
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        collecting = False
        for line in handle:
            stripped = line.strip()
            if stripped.startswith("INSERT INTO `taxa`"):
                collecting = True
                continue
            if not collecting:
                continue
            if stripped.startswith("ON DUPLICATE KEY UPDATE"):
                collecting = False
                continue
            match = VALUE_RE.match(stripped.rstrip(","))
            if not match:
                continue
            values = [decode_sql(item) for item in split_sql_values(match.group(1))]
            if len(values) != len(SQLITE_COLUMNS):
                raise ValueError(f"{path}: column/value count mismatch")
            yield dict(zip(SQLITE_COLUMNS, values))

def main() -> int:
    parser = argparse.ArgumentParser(description="Import MariaDB logical shards into canonical JSONL.")
    parser.add_argument("--mariadb-root", type=Path, default=Path("static/data/db/mariadb"))
    parser.add_argument("--output", type=Path, default=Path("static/data/taxonomy/imported/mariadb-import.jsonl"))
    args = parser.parse_args()

    manifest = load_manifest(args.mariadb_root / "manifest.json")
    def records():
        for shard in manifest.get("shards", []):
            yield from iter_rows(args.mariadb_root / shard["path"])

    count = write_jsonl(args.output, records())
    print(f"Imported {count} records from MariaDB logical shards.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
