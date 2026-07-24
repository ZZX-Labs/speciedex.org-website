#!/usr/bin/env python3
from __future__ import annotations
import argparse
import subprocess
import sys
from pathlib import Path

def main() -> int:
    parser = argparse.ArgumentParser(description="Build the complete Speciedex database layer.")
    parser.add_argument("--taxonomy-root", type=Path, default=Path("static/data/taxonomy"))
    parser.add_argument("--db-root", type=Path, default=Path("static/data/db"))
    args = parser.parse_args()

    script = Path(__file__).resolve().parent / "update-databases.py"
    subprocess.run(
        [
            sys.executable,
            str(script),
            "--taxonomy-root",
            str(args.taxonomy_root),
            "--db-root",
            str(args.db_root),
        ],
        check=True,
    )
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
