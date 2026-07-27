#!/usr/bin/env python3
"""
Speciedex.org
Generate ordered page-partial manifests.

Scans:

    _partials/pages/<page>/*.html

Writes:

    _partials/pages/<page>/manifest.json

The browser include loader consumes these manifests so each page shell needs only:

    <div data-page-includes></div>
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Iterable

SCRIPT_PATH = Path(__file__).resolve()
DEFAULT_REPO_ROOT = SCRIPT_PATH.parents[2]
DEFAULT_PAGES_ROOT = Path("_partials/pages")
MANIFEST_NAME = "manifest.json"
HTML_SUFFIXES = {".html", ".htm"}
IGNORED_HTML_NAMES = {"index.html", "index.htm"}
PAGE_SEGMENT_PATTERN = re.compile(r"^[a-z0-9_-]+$", re.IGNORECASE)


def natural_key(value: str) -> tuple[object, ...]:
    """Return a deterministic natural-sort key."""
    parts = re.split(r"(\d+)", value.lower())
    return tuple(int(part) if part.isdigit() else part for part in parts)


def validate_page_name(page_name: str) -> str:
    normalized = page_name.strip().strip("/").lower()
    if not normalized:
        raise ValueError("Page name cannot be empty.")

    segments = normalized.split("/")
    if any(not PAGE_SEGMENT_PATTERN.fullmatch(segment) for segment in segments):
        raise ValueError(f"Invalid page name: {page_name!r}")

    return "/".join(segments)


def discover_page_directories(pages_root: Path) -> list[Path]:
    if not pages_root.is_dir():
        return []

    directories: list[Path] = []

    for candidate in pages_root.rglob("*"):
        if not candidate.is_dir():
            continue

        if any(
            child.is_file()
            and child.suffix.lower() in HTML_SUFFIXES
            and child.name.lower() not in IGNORED_HTML_NAMES
            for child in candidate.iterdir()
        ):
            directories.append(candidate)

    return sorted(
        directories,
        key=lambda path: natural_key(path.relative_to(pages_root).as_posix()),
    )


def discover_components(page_directory: Path) -> list[str]:
    components = [
        child.name
        for child in page_directory.iterdir()
        if child.is_file()
        and child.suffix.lower() in HTML_SUFFIXES
        and child.name.lower() not in IGNORED_HTML_NAMES
    ]

    return sorted(components, key=natural_key)


def build_manifest(page_name: str, components: Iterable[str]) -> dict[str, object]:
    return {
        "page": page_name,
        "components": list(components),
    }


def serialize_manifest(manifest: dict[str, object]) -> str:
    return json.dumps(manifest, indent=4, ensure_ascii=False) + "\n"


def process_page(
    pages_root: Path,
    page_directory: Path,
    *,
    check: bool,
    quiet: bool,
) -> bool:
    page_name = validate_page_name(
        page_directory.relative_to(pages_root).as_posix()
    )
    components = discover_components(page_directory)

    if not components:
        return True

    manifest = build_manifest(page_name, components)
    expected = serialize_manifest(manifest)
    manifest_path = page_directory / MANIFEST_NAME

    if check:
        current = ""
        if manifest_path.is_file():
            current = manifest_path.read_text(encoding="utf-8")

        valid = current == expected
        if not quiet:
            status = "OK" if valid else "STALE"
            print(f"{status}: {manifest_path}")
        return valid

    manifest_path.write_text(expected, encoding="utf-8", newline="\n")
    if not quiet:
        print(f"WROTE: {manifest_path} ({len(components)} components)")
    return True


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate manifest.json files for Speciedex page partials."
    )
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=DEFAULT_REPO_ROOT,
        help="Repository root. Defaults to the root inferred from this script.",
    )
    parser.add_argument(
        "--pages-root",
        type=Path,
        default=DEFAULT_PAGES_ROOT,
        help="Page-partial root relative to the repository root.",
    )
    parser.add_argument(
        "--page",
        action="append",
        default=[],
        help="Generate only this page path. May be supplied more than once.",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Validate manifests without writing files.",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress normal status output.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    repo_root = args.repo_root.resolve()
    pages_root = (repo_root / args.pages_root).resolve()

    if not pages_root.is_dir():
        print(f"Page-partial directory does not exist: {pages_root}", file=sys.stderr)
        return 2

    if args.page:
        page_directories = []
        for raw_page in args.page:
            page_name = validate_page_name(raw_page)
            page_directory = pages_root / page_name
            if not page_directory.is_dir():
                print(
                    f"Page-partial directory does not exist: {page_directory}",
                    file=sys.stderr,
                )
                return 2
            page_directories.append(page_directory)
    else:
        page_directories = discover_page_directories(pages_root)

    if not page_directories:
        if not args.quiet:
            print(f"No page-partial directories found under {pages_root}")
        return 0

    valid = True
    for page_directory in page_directories:
        valid = process_page(
            pages_root,
            page_directory,
            check=args.check,
            quiet=args.quiet,
        ) and valid

    return 0 if valid else 1


if __name__ == "__main__":
    raise SystemExit(main())
