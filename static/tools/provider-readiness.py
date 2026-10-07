#!/usr/bin/env python3
"""Fail acceptance if any registered provider was skipped, failed or rejected rows."""
import argparse
import json
from pathlib import Path
from providers.readiness import check_scan


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--scan-report", type=Path)
    args = parser.parse_args()
    root = args.repo_root.resolve()
    definitions = json.loads((root / "static/tools/providers.json").read_text())["providers"]
    path = args.scan_report or root / "static/data/statistics-sources.json"
    report = check_scan(definitions, json.loads(path.read_text()))
    print(json.dumps(report, indent=2))
    return 0 if report["all_operational"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
