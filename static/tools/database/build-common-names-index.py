#!/usr/bin/env python3
"""Compatibility entry point for the unified scientific-name lookup builder."""
from __future__ import annotations
import argparse
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lookups"))
from species_lookup_builder import main

if __name__ == "__main__":
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--taxonomy-root", default="static/data/taxonomy")
    parser.add_argument("--output", default="static/data/db/indexes/common-names.json")
    known, rest = parser.parse_known_args()
    raise SystemExit(main([
        "--only", "common-names",
        "--taxonomy-root", known.taxonomy_root,
        "--compat-common-names", known.output,
        *rest,
    ]))
