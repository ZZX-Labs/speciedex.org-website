#!/usr/bin/env python3
"""Evaluate one registry-wide provider scan under an explicit acceptance policy."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from providers.readiness import check_scan


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--scan-report", type=Path)
    parser.add_argument(
        "--policy",
        choices=("strict", "publishable", "report-only"),
        default="strict",
        help=(
            "strict requires all registered providers to pass; publishable requires "
            "complete registry accounting, at least one passing source and no "
            "structural scan failure; report-only never fails the process"
        ),
    )
    args = parser.parse_args()

    root = args.repo_root.resolve()
    definitions = json.loads((root / "static/tools/providers.json").read_text(encoding="utf-8"))["providers"]
    path = args.scan_report or root / "static/data/statistics-sources.json"
    report = check_scan(definitions, json.loads(path.read_text(encoding="utf-8")))
    report["acceptance_policy"] = args.policy

    if args.policy == "strict":
        accepted = bool(report["all_operational"])
    elif args.policy == "publishable":
        accepted = bool(report["publishable"])
    else:
        accepted = True

    report["accepted"] = accepted
    print(json.dumps(report, indent=2))
    return 0 if accepted else 1


if __name__ == "__main__":
    raise SystemExit(main())
