#!/usr/bin/env python3
"""
Normalize raw-provider or canonical Speciedex taxonomy records for Icon Forge.

The normalizer accepts JSON, JSONL, and NDJSON inputs. It understands both
provider-shaped records and the canonical Speciedex archive representation,
including:

    * speciedex_id
    * initial_source
    * nested taxonomy mappings
    * canonical parent and accepted identifiers
    * provider/source assertions
    * lineage arrays, mappings, tuples, or pipe-delimited strings

By default, every lineage node is emitted as its own deterministic taxonomic
record. A species such as Panthera leo therefore emits domain, kingdom, phylum,
class, order, family, genus, and species records.

Expected location:
    static/tools/icon-forge/normalize-taxonomy.py

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import tempfile
import unicodedata
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TextIO


SUPPORTED_SUFFIXES = {".json", ".jsonl", ".ndjson"}

IGNORED_FILENAMES = {
    "manifest.json",
    "scheduler.json",
    "statistics.json",
    "statistics-history.json",
    "statistics-sources.json",
    "build-state.json",
    "build-summary.json",
    "generation-report.json",
    "icon-manifest.json",
    "sprite-index.json",
}

IGNORED_DIRECTORY_NAMES = {
    ".git",
    "__pycache__",
    "normalized",
    "rejected",
    "provider-state",
    "icons",
    "db",
}

RANK_ALIASES = {
    "super_kingdom": "superkingdom",
    "sub_kingdom": "subkingdom",
    "infra_kingdom": "infrakingdom",
    "super_phylum": "superphylum",
    "sub_phylum": "subphylum",
    "infra_phylum": "infraphylum",
    "micro_phylum": "microphylum",
    "super_class": "superclass",
    "sub_class": "subclass",
    "infra_class": "infraclass",
    "super_order": "superorder",
    "sub_order": "suborder",
    "infra_order": "infraorder",
    "parv_order": "parvorder",
    "super_family": "superfamily",
    "sub_family": "subfamily",
    "sub_tribe": "subtribe",
    "sub_genus": "subgenus",
    "sub_species": "subspecies",
    "forma": "form",
    "forma_specialis": "form",
    "f_sp": "form",
    "var": "variety",
    "varietas": "variety",
}

RANK_ORDER = {
    "life": -3,
    "biota": -2,
    "realm": -1,
    "domain": 0,
    "superkingdom": 0,
    "kingdom": 1,
    "subkingdom": 2,
    "infrakingdom": 3,
    "superphylum": 4,
    "phylum": 5,
    "division": 5,
    "subphylum": 6,
    "subdivision": 6,
    "infraphylum": 7,
    "microphylum": 8,
    "superclass": 9,
    "class": 10,
    "subclass": 11,
    "infraclass": 12,
    "cohort": 13,
    "magnorder": 14,
    "superorder": 15,
    "order": 16,
    "suborder": 17,
    "infraorder": 18,
    "parvorder": 19,
    "superfamily": 20,
    "family": 21,
    "subfamily": 22,
    "tribe": 23,
    "subtribe": 24,
    "genus": 25,
    "subgenus": 26,
    "section": 27,
    "subsection": 28,
    "series": 29,
    "species": 30,
    "subspecies": 31,
    "variety": 32,
    "form": 33,
    "cultivar": 34,
    "strain": 35,
    "isolate": 36,
    "clone": 37,
    "clade": 50,
    "taxon": 60,
    "unranked": 100,
}

CANONICAL_BACKBONE = (
    "domain",
    "kingdom",
    "phylum",
    "class",
    "order",
    "family",
    "genus",
    "species",
)


@dataclass
class NormalizationReport:
    schema_version: int = 1
    input: str = ""
    output: str = ""
    rejected: str = ""
    terminal_only: bool = False
    source_files: int = 0
    source_records: int = 0
    expanded_candidates: int = 0
    unique_taxa: int = 0
    rejected_records: int = 0
    rank_counts: dict[str, int] = field(default_factory=dict)
    source_counts: dict[str, int] = field(default_factory=dict)


def clean_text(value: Any) -> str:
    if value is None:
        return ""

    if isinstance(value, bool):
        return "true" if value else "false"

    text = unicodedata.normalize("NFKC", str(value)).strip()
    return re.sub(r"\s+", " ", text)


def clean_rank(value: Any) -> str:
    rank = (
        clean_text(value)
        .lower()
        .replace("-", "_")
        .replace(" ", "_")
    ) or "unranked"

    rank = re.sub(r"_+", "_", rank)
    return RANK_ALIASES.get(rank, rank)


def normalize_value(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {
            clean_text(key): normalize_value(item)
            for key, item in sorted(
                value.items(),
                key=lambda pair: clean_text(pair[0]),
            )
        }

    if isinstance(value, (list, tuple, set)):
        return [normalize_value(item) for item in value]

    if isinstance(value, str):
        return clean_text(value)

    return value


def canonical_json(value: Any) -> str:
    return json.dumps(
        normalize_value(value),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def nested_mapping(raw: Mapping[str, Any], *keys: str) -> Mapping[str, Any]:
    for key in keys:
        value = raw.get(key)
        if isinstance(value, Mapping):
            return value

    return {}


def first_text(*values: Any) -> str:
    for value in values:
        if isinstance(value, Mapping):
            value = (
                value.get("name")
                or value.get("label")
                or value.get("value")
                or value.get("scientific_name")
                or value.get("canonical_name")
            )

        if isinstance(value, (list, tuple)):
            for item in value:
                text = first_text(item)
                if text:
                    return text
            continue

        text = clean_text(value)
        if text:
            return text

    return ""


def synthetic_id(
    *,
    namespace: str,
    rank: str,
    name: str,
    lineage: Sequence[Mapping[str, Any]],
) -> str:
    material = canonical_json(
        {
            "namespace": namespace or "speciedex",
            "rank": clean_rank(rank),
            "name": clean_text(name),
            "lineage": [
                {
                    "rank": clean_rank(node.get("rank")),
                    "name": clean_text(node.get("name")),
                }
                for node in lineage
            ],
        }
    )

    digest = hashlib.sha256(material.encode("utf-8")).hexdigest()
    return f"{namespace or 'speciedex'}:taxon:{digest}"


def guess_rank_by_position(
    index: int,
    total: int,
    terminal_rank: str,
) -> str:
    terminal_rank = clean_rank(terminal_rank)

    try:
        terminal_index = CANONICAL_BACKBONE.index(terminal_rank)
    except ValueError:
        terminal_index = len(CANONICAL_BACKBONE) - 1

    start = max(0, terminal_index - total + 1)
    position = min(start + index, terminal_index)

    if index == total - 1:
        return terminal_rank

    return CANONICAL_BACKBONE[position]


def node_name(value: Any) -> str:
    if isinstance(value, Mapping):
        return first_text(
            value.get("name"),
            value.get("scientific_name"),
            value.get("canonical_name"),
            value.get("taxon"),
            value.get("value"),
            value.get("label"),
        )

    return clean_text(value)


def node_identifier(value: Any) -> str:
    if not isinstance(value, Mapping):
        return ""

    return first_text(
        value.get("id"),
        value.get("speciedex_id"),
        value.get("taxon_id"),
        value.get("key"),
        value.get("identifier"),
    )


def taxonomy_node_identifier(
    raw: Mapping[str, Any],
    rank: str,
    value: Any,
) -> str:
    identifier = node_identifier(value)
    if identifier:
        return identifier

    compact_rank = clean_rank(rank)
    candidates = (
        f"{compact_rank}_id",
        f"{compact_rank}_key",
        f"{compact_rank}_speciedex_id",
    )

    for key in candidates:
        identifier = first_text(raw.get(key))
        if identifier:
            return identifier

    return ""


def normalize_lineage(
    raw: Any,
    scientific_name: str,
    taxon_rank: str,
    *,
    record: Mapping[str, Any] | None = None,
) -> list[dict[str, str]]:
    lineage: list[dict[str, str]] = []
    record = record or {}

    if isinstance(raw, str):
        names = [
            clean_text(part)
            for part in re.split(r"\s*[|;>]\s*", raw)
            if clean_text(part)
        ]

        for index, name in enumerate(names):
            lineage.append(
                {
                    "rank": guess_rank_by_position(
                        index,
                        len(names),
                        taxon_rank,
                    ),
                    "name": name,
                }
            )

    elif isinstance(raw, Mapping):
        ordered_items = sorted(
            raw.items(),
            key=lambda item: (
                RANK_ORDER.get(clean_rank(item[0]), 1000),
                clean_rank(item[0]),
            ),
        )

        for rank_name, taxon_value in ordered_items:
            rank = clean_rank(rank_name)

            if rank in {
                "rank",
                "status",
                "parent",
                "accepted",
                "scientific_name",
                "canonical_name",
                "common_name",
            }:
                continue

            name = node_name(taxon_value)
            if not name:
                continue

            node: dict[str, str] = {
                "rank": rank,
                "name": name,
            }

            identifier = taxonomy_node_identifier(
                record,
                rank,
                taxon_value,
            )
            if identifier:
                node["id"] = identifier

            lineage.append(node)

    elif isinstance(raw, list):
        total = len(raw)

        for index, item in enumerate(raw):
            if isinstance(item, Mapping):
                name = node_name(item)
                if not name:
                    continue

                item_rank = clean_rank(
                    item.get("rank")
                    or item.get("taxon_rank")
                    or guess_rank_by_position(
                        index,
                        total,
                        taxon_rank,
                    )
                )

                node = {
                    "rank": item_rank,
                    "name": name,
                }

                identifier = node_identifier(item)
                if identifier:
                    node["id"] = identifier

                lineage.append(node)

            elif isinstance(item, (list, tuple)) and len(item) >= 2:
                node = {
                    "rank": clean_rank(item[0]),
                    "name": clean_text(item[1]),
                }

                if len(item) >= 3 and clean_text(item[2]):
                    node["id"] = clean_text(item[2])

                lineage.append(node)

            else:
                name = clean_text(item)
                if name:
                    lineage.append(
                        {
                            "rank": guess_rank_by_position(
                                index,
                                total,
                                taxon_rank,
                            ),
                            "name": name,
                        }
                    )

    terminal_identifier = first_text(
        record.get("speciedex_id"),
        record.get("id"),
        record.get("identifier"),
    )

    if (
        not lineage
        or lineage[-1]["name"].casefold()
        != scientific_name.casefold()
    ):
        terminal = {
            "rank": taxon_rank,
            "name": scientific_name,
        }
        if terminal_identifier:
            terminal["id"] = terminal_identifier
        lineage.append(terminal)
    else:
        lineage[-1]["rank"] = taxon_rank
        if terminal_identifier and not lineage[-1].get("id"):
            lineage[-1]["id"] = terminal_identifier

    deduped: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()

    for node in lineage:
        rank = clean_rank(node.get("rank"))
        name = clean_text(node.get("name"))

        if not name:
            continue

        identity = (rank, name.casefold())
        identifier = clean_text(node.get("id"))

        if identity in seen:
            for existing in reversed(deduped):
                if (
                    existing["rank"] == rank
                    and existing["name"].casefold() == name.casefold()
                ):
                    if identifier and not existing.get("id"):
                        existing["id"] = identifier
                    break
            continue

        normalized = {
            "rank": rank,
            "name": name,
        }
        if identifier:
            normalized["id"] = identifier

        deduped.append(normalized)
        seen.add(identity)

    deduped.sort(
        key=lambda node: (
            RANK_ORDER.get(clean_rank(node.get("rank")), 1000),
            clean_text(node.get("name")).casefold(),
        )
    )

    return deduped


def extract_common_name(raw: Mapping[str, Any]) -> str:
    direct = first_text(
        raw.get("common_name"),
        raw.get("vernacular_name"),
        raw.get("preferred_common_name"),
        raw.get("english_name"),
    )
    if direct:
        return direct

    common_names = raw.get("common_names")

    if isinstance(common_names, Mapping):
        return first_text(
            common_names.get("en"),
            common_names.get("eng"),
            common_names.get("english"),
            *common_names.values(),
        )

    return first_text(common_names)


def extract_initial_source(raw: Mapping[str, Any]) -> Mapping[str, Any]:
    return nested_mapping(
        raw,
        "initial_source",
        "source",
        "provider_source",
    )


def extract_source(raw: Mapping[str, Any]) -> str:
    initial_source = extract_initial_source(raw)

    source_value = raw.get("source")
    if isinstance(source_value, Mapping):
        source_value = None

    source = first_text(
        raw.get("provider"),
        source_value,
        raw.get("initial_provider"),
        initial_source.get("provider"),
        initial_source.get("name"),
        initial_source.get("source"),
    )

    if source:
        return source.lower()

    assertions = raw.get("source_assertions")
    if isinstance(assertions, list):
        for assertion in assertions:
            if isinstance(assertion, Mapping):
                source = first_text(
                    assertion.get("provider"),
                    assertion.get("source"),
                    assertion.get("name"),
                )
                if source:
                    return source.lower()

    return "speciedex"


def extract_source_id(raw: Mapping[str, Any]) -> str:
    initial_source = extract_initial_source(raw)

    source_id = first_text(
        raw.get("source_id"),
        raw.get("provider_id"),
        raw.get("provider_record_id"),
        raw.get("key"),
        raw.get("taxon_id"),
        initial_source.get("provider_id"),
        initial_source.get("provider_record_id"),
        initial_source.get("source_id"),
        initial_source.get("record_id"),
        initial_source.get("id"),
    )

    if source_id:
        return source_id

    assertions = raw.get("source_assertions")
    if isinstance(assertions, list):
        for assertion in assertions:
            if not isinstance(assertion, Mapping):
                continue
            source_id = first_text(
                assertion.get("provider_id"),
                assertion.get("source_id"),
                assertion.get("record_id"),
                assertion.get("id"),
            )
            if source_id:
                return source_id

    return ""


def normalize_status(value: Any) -> str:
    status = clean_text(value).lower()
    return status or "accepted"


def normalize_record(raw: Mapping[str, Any]) -> dict[str, Any]:
    taxonomy = nested_mapping(
        raw,
        "taxonomy",
        "classification",
        "higher_classification",
    )

    scientific_name = first_text(
        raw.get("scientific_name"),
        raw.get("canonical_name"),
        raw.get("name"),
        raw.get("taxon"),
        taxonomy.get("scientific_name"),
        taxonomy.get("canonical_name"),
        taxonomy.get("name"),
    )

    if not scientific_name:
        raise ValueError(
            "missing scientific_name, canonical_name, name, or taxon"
        )

    taxon_rank = clean_rank(
        first_text(
            raw.get("rank"),
            raw.get("taxon_rank"),
            taxonomy.get("rank"),
        )
    )

    source = extract_source(raw)
    source_id = extract_source_id(raw)

    lineage_source: Any = (
        raw.get("lineage")
        or raw.get("higher_taxonomy")
        or raw.get("classification_path")
        or taxonomy
        or []
    )

    lineage = normalize_lineage(
        lineage_source,
        scientific_name,
        taxon_rank,
        record=raw,
    )

    identifier = first_text(
        raw.get("speciedex_id"),
        raw.get("id"),
        raw.get("identifier"),
        raw.get("taxon_key"),
    )

    if not identifier and source_id:
        identifier = f"{source}:{source_id}"

    if not identifier:
        identifier = synthetic_id(
            namespace=source or "speciedex",
            rank=taxon_rank,
            name=scientific_name,
            lineage=lineage,
        )

    if lineage:
        lineage[-1]["id"] = identifier

    traits = raw.get("traits")
    if traits is None:
        traits = raw.get("attributes")
    if traits is None:
        traits = raw.get("metadata")
    if not isinstance(traits, Mapping):
        traits = {}

    parent_id = first_text(
        raw.get("parent_speciedex_id"),
        raw.get("parent_id"),
        raw.get("parent_key"),
        raw.get("parent_taxon_id"),
    )

    accepted_id = first_text(
        raw.get("accepted_speciedex_id"),
        raw.get("accepted_id"),
        raw.get("accepted_key"),
        raw.get("accepted_taxon_id"),
    )

    return {
        "id": identifier,
        "source": source,
        "source_id": source_id,
        "scientific_name": scientific_name,
        "canonical_name": first_text(
            raw.get("canonical_name"),
            taxonomy.get("canonical_name"),
            scientific_name,
        ),
        "common_name": extract_common_name(raw),
        "rank": taxon_rank,
        "status": normalize_status(
            raw.get("status")
            or raw.get("taxonomic_status")
            or raw.get("accepted_status")
        ),
        "parent_id": parent_id,
        "accepted_id": accepted_id,
        "lineage": lineage,
        "traits": normalize_value(traits),
    }


def assign_lineage_identifiers(
    record: Mapping[str, Any],
) -> list[dict[str, str]]:
    raw_lineage = list(record.get("lineage") or [])
    terminal_name = clean_text(record.get("scientific_name"))
    terminal_rank = clean_rank(record.get("rank"))
    terminal_id = clean_text(record.get("id"))

    identified: list[dict[str, str]] = []

    for index, node in enumerate(raw_lineage):
        rank = clean_rank(node.get("rank"))
        name = clean_text(node.get("name"))

        if not name:
            continue

        is_terminal = (
            rank == terminal_rank
            and name.casefold() == terminal_name.casefold()
        )

        identifier = clean_text(node.get("id"))
        if is_terminal and terminal_id:
            identifier = terminal_id

        prefix = [
            {
                "rank": item["rank"],
                "name": item["name"],
            }
            for item in identified
        ] + [{"rank": rank, "name": name}]

        if not identifier:
            identifier = synthetic_id(
                namespace="speciedex",
                rank=rank,
                name=name,
                lineage=prefix,
            )

        identified.append(
            {
                "rank": rank,
                "name": name,
                "id": identifier,
            }
        )

    if not identified:
        identified.append(
            {
                "rank": terminal_rank,
                "name": terminal_name,
                "id": terminal_id
                or synthetic_id(
                    namespace=clean_text(record.get("source")) or "speciedex",
                    rank=terminal_rank,
                    name=terminal_name,
                    lineage=[
                        {
                            "rank": terminal_rank,
                            "name": terminal_name,
                        }
                    ],
                ),
            }
        )

    return identified


def expand_lineage_records(
    record: Mapping[str, Any],
) -> list[dict[str, Any]]:
    lineage = assign_lineage_identifiers(record)
    terminal_name = clean_text(record.get("scientific_name"))
    terminal_rank = clean_rank(record.get("rank"))
    expanded: list[dict[str, Any]] = []

    for index, node in enumerate(lineage):
        node_name = clean_text(node.get("name"))
        node_rank = clean_rank(node.get("rank"))
        node_id = clean_text(node.get("id"))

        is_terminal = (
            node_name.casefold() == terminal_name.casefold()
            and node_rank == terminal_rank
        )

        lineage_prefix = [
            {
                "rank": prefix["rank"],
                "name": prefix["name"],
                "id": prefix["id"],
            }
            for prefix in lineage[: index + 1]
        ]

        inferred_parent_id = (
            clean_text(lineage[index - 1].get("id"))
            if index > 0
            else ""
        )

        expanded.append(
            {
                "id": node_id,
                "source": (
                    clean_text(record.get("source"))
                    if is_terminal
                    else "speciedex"
                ),
                "source_id": (
                    clean_text(record.get("source_id"))
                    if is_terminal
                    else ""
                ),
                "scientific_name": node_name,
                "canonical_name": (
                    clean_text(record.get("canonical_name"))
                    if is_terminal
                    else node_name
                ),
                "common_name": (
                    clean_text(record.get("common_name"))
                    if is_terminal
                    else ""
                ),
                "rank": node_rank,
                "status": (
                    normalize_status(record.get("status"))
                    if is_terminal
                    else "accepted"
                ),
                "parent_id": (
                    clean_text(record.get("parent_id"))
                    if is_terminal and clean_text(record.get("parent_id"))
                    else inferred_parent_id
                ),
                "accepted_id": (
                    clean_text(record.get("accepted_id"))
                    if is_terminal
                    else ""
                ),
                "lineage": lineage_prefix,
                "traits": (
                    normalize_value(record.get("traits") or {})
                    if is_terminal
                    else {}
                ),
            }
        )

    return expanded


def record_identity_key(record: Mapping[str, Any]) -> str:
    identifier = clean_text(record.get("id"))
    if identifier:
        return identifier

    return synthetic_id(
        namespace=clean_text(record.get("source")) or "speciedex",
        rank=clean_rank(record.get("rank")),
        name=clean_text(record.get("scientific_name")),
        lineage=list(record.get("lineage") or []),
    )


def merge_records(
    existing: Mapping[str, Any],
    incoming: Mapping[str, Any],
) -> dict[str, Any]:
    existing_rank = clean_rank(existing.get("rank"))
    incoming_rank = clean_rank(incoming.get("rank"))
    existing_name = clean_text(existing.get("scientific_name"))
    incoming_name = clean_text(incoming.get("scientific_name"))

    if (
        existing_rank != incoming_rank
        or existing_name.casefold() != incoming_name.casefold()
    ):
        raise ValueError(
            "identity collision: "
            f"{record_identity_key(existing)!r} maps to both "
            f"{existing_rank}/{existing_name!r} and "
            f"{incoming_rank}/{incoming_name!r}"
        )

    merged = dict(existing)

    for key in (
        "source",
        "source_id",
        "canonical_name",
        "common_name",
        "parent_id",
        "accepted_id",
    ):
        if not clean_text(merged.get(key)) and clean_text(incoming.get(key)):
            merged[key] = incoming[key]

    existing_traits = dict(merged.get("traits") or {})
    incoming_traits = dict(incoming.get("traits") or {})

    for key, value in incoming_traits.items():
        existing_traits.setdefault(key, value)

    merged["traits"] = existing_traits

    existing_lineage = list(merged.get("lineage") or [])
    incoming_lineage = list(incoming.get("lineage") or [])

    if len(incoming_lineage) > len(existing_lineage):
        merged["lineage"] = incoming_lineage

    accepted_statuses = {
        "accepted",
        "valid",
        "provisionally accepted",
        "reference",
    }

    if (
        normalize_status(merged.get("status")) not in accepted_statuses
        and normalize_status(incoming.get("status")) in accepted_statuses
    ):
        merged["status"] = normalize_status(incoming.get("status"))

    return merged


def iter_records(path: Path) -> Iterable[Mapping[str, Any]]:
    suffix = path.suffix.lower()

    if suffix in {".jsonl", ".ndjson"}:
        with path.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, 1):
                if not line.strip():
                    continue

                try:
                    payload = json.loads(line)
                except json.JSONDecodeError as error:
                    raise ValueError(
                        f"{path}:{line_number}: invalid JSON: {error}"
                    ) from error

                if not isinstance(payload, Mapping):
                    raise ValueError(
                        f"{path}:{line_number}: record must be an object"
                    )

                yield payload

        return

    if suffix == ".json":
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            raise ValueError(f"{path}: invalid JSON: {error}") from error

        if isinstance(payload, Mapping):
            container = None
            for key in ("taxa", "records", "data", "items", "results"):
                value = payload.get(key)
                if isinstance(value, list):
                    container = value
                    break

            payload = container if container is not None else [payload]

        if not isinstance(payload, list):
            raise ValueError(
                f"{path}: JSON root must be an object or array"
            )

        for index, item in enumerate(payload, 1):
            if not isinstance(item, Mapping):
                raise ValueError(
                    f"{path}: item {index} must be an object"
                )
            yield item

        return

    raise ValueError(f"unsupported input format: {path.suffix}")


def manifest_volume_files(root: Path) -> list[Path]:
    manifest_path = root / "manifest.json"
    if not manifest_path.is_file():
        return []

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []

    if not isinstance(manifest, Mapping):
        return []

    volumes = manifest.get("volumes")
    if not isinstance(volumes, list):
        return []

    paths: list[Path] = []

    for entry in volumes:
        if isinstance(entry, str):
            candidate_value = entry
        elif isinstance(entry, Mapping):
            candidate_value = first_text(
                entry.get("path"),
                entry.get("file"),
                entry.get("filename"),
                entry.get("name"),
            )
        else:
            continue

        if not candidate_value:
            continue

        candidate = Path(candidate_value)
        candidates = (
            candidate,
            root / candidate,
            root.parent / candidate,
        )

        resolved = next(
            (
                item.resolve()
                for item in candidates
                if item.is_file()
                and item.suffix.lower() in SUPPORTED_SUFFIXES
            ),
            None,
        )

        if resolved is not None:
            paths.append(resolved)

    return sorted(set(paths))


def collect_input_files(
    path: Path,
    *,
    excluded: set[Path] | None = None,
) -> list[Path]:
    path = path.resolve()
    excluded = {item.resolve() for item in (excluded or set())}

    if path.is_file():
        if path.suffix.lower() not in SUPPORTED_SUFFIXES:
            raise ValueError(f"unsupported input format: {path.suffix}")
        return [path]

    if not path.exists():
        raise FileNotFoundError(f"input path does not exist: {path}")

    manifest_files = manifest_volume_files(path)
    if manifest_files:
        return [
            candidate
            for candidate in manifest_files
            if candidate not in excluded
        ]

    files: list[Path] = []

    for candidate in path.rglob("*"):
        if not candidate.is_file():
            continue

        resolved = candidate.resolve()

        if resolved in excluded:
            continue

        if candidate.suffix.lower() not in SUPPORTED_SUFFIXES:
            continue

        if candidate.name in IGNORED_FILENAMES:
            continue

        relative_parts = candidate.relative_to(path).parts[:-1]
        if any(part in IGNORED_DIRECTORY_NAMES for part in relative_parts):
            continue

        files.append(resolved)

    return sorted(set(files))


def rank_sort_key(
    record: Mapping[str, Any],
) -> tuple[int, str, str, str]:
    rank = clean_rank(record.get("rank"))
    name = clean_text(record.get("scientific_name")).casefold()
    lineage = canonical_json(record.get("lineage") or [])
    identifier = clean_text(record.get("id"))

    return (
        RANK_ORDER.get(rank, 1000),
        lineage,
        name,
        identifier,
    )


def atomic_text_writer(path: Path) -> tuple[Path, TextIO]:
    path.parent.mkdir(parents=True, exist_ok=True)

    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
        text=True,
    )

    handle = os.fdopen(
        descriptor,
        "w",
        encoding="utf-8",
        newline="\n",
    )

    return Path(temporary_name), handle


def write_json_atomic(path: Path, payload: Any) -> None:
    temporary, handle = atomic_text_writer(path)

    try:
        with handle:
            json.dump(
                payload,
                handle,
                indent=2,
                ensure_ascii=False,
                sort_keys=True,
            )
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())

        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Normalize raw-provider or canonical Speciedex records and "
            "emit every lineage node for Icon Forge."
        ),
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )

    parser.add_argument(
        "--input",
        required=True,
        type=Path,
        help=(
            "Input file or directory. A taxonomy root with manifest.json "
            "uses its declared archive volumes automatically."
        ),
    )
    parser.add_argument(
        "--output",
        required=True,
        type=Path,
        help="Output normalized JSONL file.",
    )
    parser.add_argument(
        "--rejected",
        required=True,
        type=Path,
        help="Output JSONL file for rejected records and errors.",
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=None,
        help="Optional normalization report JSON.",
    )
    parser.add_argument(
        "--terminal-only",
        action="store_true",
        help=(
            "Emit only original terminal records. By default every lineage "
            "node is emitted as its own taxon."
        ),
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Return failure when any source record is rejected.",
    )
    parser.add_argument(
        "--expected-min-records",
        type=int,
        default=1,
        help="Require at least this many unique output taxa.",
    )

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    input_path = args.input.resolve()
    output_path = args.output.resolve()
    rejected_path = args.rejected.resolve()
    report_path = args.report.resolve() if args.report else None

    if args.expected_min_records < 1:
        raise SystemExit("--expected-min-records must be at least 1.")

    excluded = {output_path, rejected_path}
    if report_path is not None:
        excluded.add(report_path)

    files = collect_input_files(
        input_path,
        excluded=excluded,
    )

    if not files:
        raise SystemExit(
            f"No supported taxonomy files found under {input_path}"
        )

    records_by_identity: dict[str, dict[str, Any]] = {}
    report = NormalizationReport(
        input=input_path.as_posix(),
        output=output_path.as_posix(),
        rejected=rejected_path.as_posix(),
        terminal_only=args.terminal_only,
        source_files=len(files),
    )

    rejected_temporary, rejected_handle = atomic_text_writer(rejected_path)

    try:
        with rejected_handle:
            for source_file in files:
                try:
                    for raw_record in iter_records(source_file):
                        report.source_records += 1

                        try:
                            normalized = normalize_record(raw_record)
                            candidates = (
                                [normalized]
                                if args.terminal_only
                                else expand_lineage_records(normalized)
                            )

                            for candidate in candidates:
                                identity = record_identity_key(candidate)
                                existing = records_by_identity.get(identity)

                                if existing is None:
                                    records_by_identity[identity] = candidate
                                else:
                                    records_by_identity[identity] = merge_records(
                                        existing,
                                        candidate,
                                    )

                                report.expanded_candidates += 1

                        except Exception as error:
                            rejected_handle.write(
                                json.dumps(
                                    {
                                        "source_file": source_file.as_posix(),
                                        "error": str(error),
                                        "record": raw_record,
                                    },
                                    ensure_ascii=False,
                                    sort_keys=True,
                                )
                                + "\n"
                            )
                            report.rejected_records += 1

                except Exception as error:
                    rejected_handle.write(
                        json.dumps(
                            {
                                "source_file": source_file.as_posix(),
                                "error": str(error),
                            },
                            ensure_ascii=False,
                            sort_keys=True,
                        )
                        + "\n"
                    )
                    report.rejected_records += 1

            rejected_handle.flush()
            os.fsync(rejected_handle.fileno())

        rejected_temporary.replace(rejected_path)
    finally:
        rejected_temporary.unlink(missing_ok=True)

    ordered_records = sorted(
        records_by_identity.values(),
        key=rank_sort_key,
    )

    report.unique_taxa = len(ordered_records)

    for record in ordered_records:
        rank = clean_rank(record.get("rank"))
        source = clean_text(record.get("source")) or "unknown"
        report.rank_counts[rank] = report.rank_counts.get(rank, 0) + 1
        report.source_counts[source] = (
            report.source_counts.get(source, 0) + 1
        )

    output_temporary, output_handle = atomic_text_writer(output_path)

    try:
        with output_handle:
            for record in ordered_records:
                output_handle.write(
                    json.dumps(
                        record,
                        ensure_ascii=False,
                        sort_keys=True,
                    )
                    + "\n"
                )

            output_handle.flush()
            os.fsync(output_handle.fileno())

        output_temporary.replace(output_path)
    finally:
        output_temporary.unlink(missing_ok=True)

    if report_path is not None:
        write_json_atomic(
            report_path,
            {
                "schema_version": report.schema_version,
                "input": report.input,
                "output": report.output,
                "rejected": report.rejected,
                "terminal_only": report.terminal_only,
                "source_files": report.source_files,
                "source_records": report.source_records,
                "expanded_candidates": report.expanded_candidates,
                "unique_taxa": report.unique_taxa,
                "rejected_records": report.rejected_records,
                "rank_counts": dict(
                    sorted(
                        report.rank_counts.items(),
                        key=lambda item: (
                            RANK_ORDER.get(item[0], 1000),
                            item[0],
                        ),
                    )
                ),
                "source_counts": dict(
                    sorted(report.source_counts.items())
                ),
            },
        )

    print(
        f"source_files={report.source_files} "
        f"source_records={report.source_records} "
        f"expanded_candidates={report.expanded_candidates} "
        f"unique_taxa={report.unique_taxa} "
        f"rejected={report.rejected_records}"
    )

    for rank, count in sorted(
        report.rank_counts.items(),
        key=lambda item: (
            RANK_ORDER.get(item[0], 1000),
            item[0],
        ),
    ):
        print(f"rank.{rank}={count}")

    if report.unique_taxa < args.expected_min_records:
        print(
            "Normalization output is below the required minimum: "
            f"{report.unique_taxa} < {args.expected_min_records}"
        )
        return 1

    if args.strict and report.rejected_records:
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
