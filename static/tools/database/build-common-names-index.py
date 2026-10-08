#!/usr/bin/env python3
"""Build the compact common-name lookup used by the terminal splash reader.

The canonical archive remains authoritative for taxon identity. This index only
collects provider-supplied common/vernacular names for canonical species and
subspecies so the public splash can enrich a randomly selected record without
loading the full provider revision history into the browser.
"""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

COMMON_NAME_FIELDS = (
    "common_name", "commonName", "vernacular_name", "vernacularName",
    "preferred_common_name", "preferredCommonName", "english_name",
    "englishName", "local_name", "localName", "fao_english_name",
    "faoEnglishName",
)
COMMON_NAME_LIST_FIELDS = (
    "common_names", "commonNames", "vernacular_names", "vernacularNames",
    "english_names", "englishNames", "fao_names", "faoNames",
)
COMMON_NAME_ITEM_FIELDS = (
    "name", "value", "label", "common_name", "commonName",
    "vernacular_name", "vernacularName", "english_name", "englishName",
    "local_name", "localName",
)


def clean(value: Any) -> str:
    return str(value or "").strip()


def key(value: Any) -> str:
    return " ".join(clean(value).casefold().split())


def ordered_unique(values: Iterable[Any]) -> list[str]:
    output: list[str] = []
    seen: set[str] = set()
    for value in values:
        text = clean(value)
        normalized = key(text)
        if not text or not normalized or normalized in seen:
            continue
        seen.add(normalized)
        output.append(text)
    return output


def list_values(value: Any) -> list[str]:
    output: list[str] = []

    def visit(item: Any) -> None:
        if item is None:
            return
        if isinstance(item, (str, int, float)):
            text = clean(item)
            if text:
                output.append(text)
            return
        if isinstance(item, Mapping):
            for field in COMMON_NAME_ITEM_FIELDS:
                text = clean(item.get(field))
                if text:
                    output.append(text)
                    return
            return
        if isinstance(item, Sequence) and not isinstance(item, (str, bytes)):
            for child in item:
                visit(child)

    visit(value)
    return ordered_unique(output)


def containers(record: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    output: list[Mapping[str, Any]] = []

    def add(value: Any) -> None:
        if isinstance(value, Mapping) and value not in output:
            output.append(value)

    add(record)
    add(record.get("assertion"))
    add(record.get("extra"))
    add(record.get("raw"))
    for parent in list(output):
        add(parent.get("extra"))
        add(parent.get("raw"))
    return output


def extract_names(record: Mapping[str, Any], scientific_name: str = "") -> list[str]:
    values: list[str] = []
    for container in containers(record):
        for field in COMMON_NAME_FIELDS:
            text = clean(container.get(field))
            if text:
                values.append(text)
        for field in COMMON_NAME_LIST_FIELDS:
            values.extend(list_values(container.get(field)))

    scientific = key(scientific_name)
    return [name for name in ordered_unique(values) if key(name) != scientific]


def iter_jsonl(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            text = line.strip()
            if not text:
                continue
            try:
                value = json.loads(text)
            except json.JSONDecodeError as error:
                raise RuntimeError(f"{path}:{line_number}: invalid JSON: {error}") from error
            if isinstance(value, Mapping):
                yield value


def atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent)
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            handle.write("\n")
        os.replace(temporary, path)
    except Exception:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def build(taxonomy_root: Path) -> tuple[dict[str, list[str]], int, int]:
    canonical: dict[str, str] = {}
    names: dict[str, list[str]] = {}
    canonical_records = 0
    revision_records = 0

    for path in sorted((taxonomy_root / "volumes").glob("*.jsonl")):
        for record in iter_jsonl(path):
            rank = key(record.get("rank"))
            if rank not in {"species", "subspecies"}:
                continue
            identifier = clean(record.get("speciedex_id"))
            if not identifier:
                continue
            scientific = clean(record.get("scientific_name") or record.get("canonical_name"))
            canonical[identifier] = scientific
            canonical_records += 1
            base = extract_names(record, scientific)
            if base:
                names[identifier] = base

    for path in sorted((taxonomy_root / "revisions").glob("*.jsonl")):
        for event in iter_jsonl(path):
            revision_records += 1
            identifier = clean(event.get("speciedex_id") or event.get("speciedexId"))
            if identifier not in canonical:
                continue
            assertion = event.get("assertion")
            source = assertion if isinstance(assertion, Mapping) else event
            found = extract_names(source, canonical[identifier])
            if found:
                names[identifier] = ordered_unique([*names.get(identifier, []), *found])

    return dict(sorted(names.items())), canonical_records, revision_records


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--taxonomy-root", type=Path, default=Path("static/data/taxonomy")
    )
    parser.add_argument(
        "--output", type=Path,
        default=Path("static/data/db/indexes/common-names.json")
    )
    args = parser.parse_args()

    taxonomy_root = args.taxonomy_root.resolve()
    names, canonical_records, revision_records = build(taxonomy_root)
    payload = {
        "schema_version": 1,
        "kind": "speciedex-common-names-index",
        "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "canonical_species_records": canonical_records,
        "revision_records_scanned": revision_records,
        "count": len(names),
        "names": names,
    }
    atomic_write_json(args.output.resolve(), payload)
    print(
        f"Wrote {len(names):,} common-name entries from "
        f"{canonical_records:,} canonical species/subspecies and "
        f"{revision_records:,} revision records to {args.output}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
