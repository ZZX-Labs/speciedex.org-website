#!/usr/bin/env python3
from __future__ import annotations
import argparse
from pathlib import Path
from common import canonical_record, iter_records, stable_json, write_jsonl

def main() -> int:
    parser = argparse.ArgumentParser(description="Reconcile imported database records into canonical taxonomy JSONL.")
    parser.add_argument("inputs", nargs="+", type=Path)
    parser.add_argument("--output", type=Path, default=Path("static/data/taxonomy/reconciled/database-reconciled.jsonl"))
    parser.add_argument("--conflicts", type=Path, default=Path("static/data/taxonomy/reconciled/conflicts.jsonl"))
    args = parser.parse_args()

    merged = {}
    conflicts = []
    for path in args.inputs:
        for raw in iter_records(path):
            record = canonical_record(raw, source_file=path.as_posix())
            identifier = record["speciedex_id"]
            existing = merged.get(identifier)
            if existing and existing["record_hash"] != record["record_hash"]:
                conflicts.append({
                    "speciedex_id": identifier,
                    "existing": existing,
                    "incoming": record,
                })
                # Latest indexed_at wins deterministically.
                if record["indexed_at"] >= existing["indexed_at"]:
                    merged[identifier] = record
            else:
                merged[identifier] = record

    count = write_jsonl(args.output, (merged[key] for key in sorted(merged)))
    write_jsonl(args.conflicts, conflicts)
    print(f"Reconciled {count} records with {len(conflicts)} conflicts.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
