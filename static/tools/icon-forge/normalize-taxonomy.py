#!/usr/bin/env python3
"""
Speciedex taxonomy normalizer.

Reads JSON, JSONL, or NDJSON taxonomic source records and writes a canonical
Speciedex JSONL stream for the icon-generation pipeline.

Critical behavior:
    Every lineage node is emitted as its own taxonomic record.

For example, a single species record with this lineage:

    Eukaryota
    Animalia
    Chordata
    Mammalia
    Carnivora
    Felidae
    Panthera
    Panthera leo

produces eight normalized records:

    domain/Eukaryota
    kingdom/Animalia
    phylum/Chordata
    class/Mammalia
    order/Carnivora
    family/Felidae
    genus/Panthera
    species/Panthera leo

Expected location:
    static/tools/icon-forge/normalize-taxonomy.py
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import unicodedata
from pathlib import Path
from typing import Any, Iterable, Mapping

SUPPORTED_SUFFIXES = {".json", ".jsonl", ".ndjson"}

RANK_ALIASES = {
    "super_kingdom": "superkingdom",
    "sub_kingdom": "subkingdom",
    "super_phylum": "superphylum",
    "sub_phylum": "subphylum",
    "infra_phylum": "infraphylum",
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
    "life": -2,
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


def clean_text(value: Any) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).strip()
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

    if isinstance(value, list):
        return [normalize_value(item) for item in value]

    if isinstance(value, tuple):
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


def synthetic_id(
    *,
    source: str,
    rank: str,
    name: str,
    lineage: list[dict[str, str]],
) -> str:
    material = canonical_json(
        {
            "source": source,
            "rank": rank,
            "name": name,
            "lineage": lineage,
        }
    )

    digest = hashlib.sha256(
        material.encode("utf-8")
    ).hexdigest()

    prefix = source or "speciedex"
    return f"{prefix}:taxon:{digest}"


def guess_rank_by_position(
    index: int,
    total: int,
    taxon_rank: str,
) -> str:
    canonical_backbone = [
        "domain",
        "kingdom",
        "phylum",
        "class",
        "order",
        "family",
        "genus",
        "species",
    ]

    if total <= len(canonical_backbone):
        offset = max(0, len(canonical_backbone) - total)
        guessed = canonical_backbone[min(index + offset, len(canonical_backbone) - 1)]
    else:
        guessed = canonical_backbone[min(index, len(canonical_backbone) - 1)]

    if index == total - 1:
        return taxon_rank

    return guessed


def normalize_lineage(
    raw: Any,
    scientific_name: str,
    taxon_rank: str,
) -> list[dict[str, str]]:
    lineage: list[dict[str, str]] = []

    if isinstance(raw, str):
        names = [
            clean_text(part)
            for part in raw.split("|")
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
            key=lambda item: RANK_ORDER.get(
                clean_rank(item[0]),
                1000,
            ),
        )

        for rank_name, taxon_name in ordered_items:
            name = clean_text(taxon_name)

            if name:
                lineage.append(
                    {
                        "rank": clean_rank(rank_name),
                        "name": name,
                    }
                )

    elif isinstance(raw, list):
        total = len(raw)

        for index, item in enumerate(raw):
            if isinstance(item, Mapping):
                name = clean_text(
                    item.get("name")
                    or item.get("scientific_name")
                    or item.get("canonical_name")
                )

                if not name:
                    continue

                item_rank = clean_rank(
                    item.get("rank")
                    or guess_rank_by_position(
                        index,
                        total,
                        taxon_rank,
                    )
                )

                row = {
                    "rank": item_rank,
                    "name": name,
                }

                identifier = clean_text(
                    item.get("id")
                    or item.get("taxon_id")
                    or item.get("key")
                )

                if identifier:
                    row["id"] = identifier

                lineage.append(row)

            elif isinstance(item, (list, tuple)) and len(item) >= 2:
                lineage.append(
                    {
                        "rank": clean_rank(item[0]),
                        "name": clean_text(item[1]),
                    }
                )

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

    if (
        not lineage
        or lineage[-1]["name"].casefold()
        != scientific_name.casefold()
    ):
        lineage.append(
            {
                "rank": taxon_rank,
                "name": scientific_name,
            }
        )
    else:
        lineage[-1]["rank"] = taxon_rank

    deduped: list[dict[str, str]] = []

    for node in lineage:
        node_rank = clean_rank(node.get("rank"))
        node_name = clean_text(node.get("name"))

        if not node_name:
            continue

        normalized = {
            "rank": node_rank,
            "name": node_name,
        }

        node_id = clean_text(node.get("id"))

        if node_id:
            normalized["id"] = node_id

        if not deduped:
            deduped.append(normalized)
            continue

        previous = deduped[-1]

        if (
            previous["rank"] == normalized["rank"]
            and previous["name"].casefold()
            == normalized["name"].casefold()
        ):
            if "id" not in previous and "id" in normalized:
                previous["id"] = normalized["id"]

            continue

        deduped.append(normalized)

    return deduped


def normalize_record(raw: Mapping[str, Any]) -> dict[str, Any]:
    scientific_name = clean_text(
        raw.get("scientific_name")
        or raw.get("canonical_name")
        or raw.get("name")
        or raw.get("taxon")
    )

    if not scientific_name:
        raise ValueError(
            "missing scientific_name, canonical_name, name, or taxon"
        )

    taxon_rank = clean_rank(raw.get("rank"))
    source = clean_text(
        raw.get("source")
        or raw.get("provider")
    ).lower()

    source_id = clean_text(
        raw.get("source_id")
        or raw.get("key")
        or raw.get("taxon_id")
    )

    lineage = normalize_lineage(
        raw.get("lineage", []),
        scientific_name,
        taxon_rank,
    )

    identifier = clean_text(
        raw.get("id")
        or (
            f"{source}:{source_id}"
            if source and source_id
            else ""
        )
    )

    if not identifier:
        identifier = synthetic_id(
            source=source,
            rank=taxon_rank,
            name=scientific_name,
            lineage=lineage,
        )

    return {
        "id": identifier,
        "source": source,
        "source_id": source_id,
        "scientific_name": scientific_name,
        "canonical_name": clean_text(
            raw.get("canonical_name")
            or scientific_name
        ),
        "common_name": clean_text(raw.get("common_name")),
        "rank": taxon_rank,
        "status": clean_text(
            raw.get("status")
            or "accepted"
        ).lower(),
        "parent_id": clean_text(raw.get("parent_id")),
        "accepted_id": clean_text(raw.get("accepted_id")),
        "lineage": lineage,
        "traits": normalize_value(
            raw.get("traits", {})
        ),
    }


def expand_lineage_records(
    record: Mapping[str, Any],
) -> list[dict[str, Any]]:
    source = clean_text(record.get("source")).lower()
    lineage = list(record.get("lineage") or [])
    terminal_name = clean_text(record.get("scientific_name"))
    terminal_rank = clean_rank(record.get("rank"))
    expanded: list[dict[str, Any]] = []

    for index, node in enumerate(lineage):
        node_name = clean_text(node.get("name"))
        node_rank = clean_rank(node.get("rank"))

        if not node_name:
            continue

        lineage_prefix = [
            {
                key: value
                for key, value in prefix_node.items()
                if key in {"rank", "name", "id"}
            }
            for prefix_node in lineage[: index + 1]
        ]

        node_id = clean_text(node.get("id"))

        if not node_id:
            if (
                node_name.casefold() == terminal_name.casefold()
                and node_rank == terminal_rank
            ):
                node_id = clean_text(record.get("id"))

        if not node_id:
            node_id = synthetic_id(
                source=source,
                rank=node_rank,
                name=node_name,
                lineage=lineage_prefix,
            )

        parent_id = ""

        if index > 0:
            parent = lineage[index - 1]
            parent_id = clean_text(parent.get("id"))

            if not parent_id:
                parent_id = synthetic_id(
                    source=source,
                    rank=clean_rank(parent.get("rank")),
                    name=clean_text(parent.get("name")),
                    lineage=lineage[:index],
                )

        is_terminal = (
            node_name.casefold() == terminal_name.casefold()
            and node_rank == terminal_rank
        )

        expanded.append(
            {
                "id": node_id,
                "source": source,
                "source_id": (
                    clean_text(record.get("source_id"))
                    if is_terminal
                    else ""
                ),
                "scientific_name": node_name,
                "canonical_name": node_name,
                "common_name": (
                    clean_text(record.get("common_name"))
                    if is_terminal
                    else ""
                ),
                "rank": node_rank,
                "status": (
                    clean_text(record.get("status") or "accepted").lower()
                    if is_terminal
                    else "accepted"
                ),
                "parent_id": parent_id,
                "accepted_id": (
                    clean_text(record.get("accepted_id"))
                    if is_terminal
                    else ""
                ),
                "lineage": lineage_prefix,
                "traits": (
                    normalize_value(record.get("traits", {}))
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
        source=clean_text(record.get("source")).lower(),
        rank=clean_rank(record.get("rank")),
        name=clean_text(record.get("scientific_name")),
        lineage=list(record.get("lineage") or []),
    )


def merge_records(
    existing: dict[str, Any],
    incoming: Mapping[str, Any],
) -> dict[str, Any]:
    merged = dict(existing)

    if not merged.get("common_name") and incoming.get("common_name"):
        merged["common_name"] = incoming["common_name"]

    if not merged.get("source_id") and incoming.get("source_id"):
        merged["source_id"] = incoming["source_id"]

    if not merged.get("parent_id") and incoming.get("parent_id"):
        merged["parent_id"] = incoming["parent_id"]

    if not merged.get("accepted_id") and incoming.get("accepted_id"):
        merged["accepted_id"] = incoming["accepted_id"]

    existing_traits = dict(merged.get("traits") or {})
    incoming_traits = dict(incoming.get("traits") or {})

    for key, value in incoming_traits.items():
        existing_traits.setdefault(key, value)

    merged["traits"] = existing_traits

    if len(incoming.get("lineage") or []) > len(merged.get("lineage") or []):
        merged["lineage"] = list(incoming.get("lineage") or [])

    if (
        merged.get("status") != "accepted"
        and incoming.get("status") == "accepted"
    ):
        merged["status"] = "accepted"

    return merged


def iter_records(path: Path) -> Iterable[Mapping[str, Any]]:
    suffix = path.suffix.lower()

    if suffix in {".jsonl", ".ndjson"}:
        with path.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, 1):
                if not line.strip():
                    continue

                payload = json.loads(line)

                if not isinstance(payload, Mapping):
                    raise ValueError(
                        f"{path}:{line_number}: record must be an object"
                    )

                yield payload

        return

    if suffix == ".json":
        payload = json.loads(
            path.read_text(encoding="utf-8")
        )

        if isinstance(payload, Mapping):
            payload = (
                payload.get("taxa")
                or payload.get("records")
                or [payload]
            )

        if not isinstance(payload, list):
            raise ValueError(
                f"{path}: JSON root must be an object or array"
            )

        for item in payload:
            if not isinstance(item, Mapping):
                raise ValueError(
                    f"{path}: each record must be an object"
                )

            yield item

        return

    raise ValueError(
        f"unsupported input format: {path.suffix}"
    )


def collect_input_files(path: Path) -> list[Path]:
    if path.is_file():
        return [path]

    if not path.exists():
        raise FileNotFoundError(
            f"input path does not exist: {path}"
        )

    return sorted(
        candidate
        for candidate in path.rglob("*")
        if candidate.is_file()
        and candidate.suffix.lower() in SUPPORTED_SUFFIXES
    )


def rank_sort_key(record: Mapping[str, Any]) -> tuple[int, str]:
    rank = clean_rank(record.get("rank"))
    name = clean_text(record.get("scientific_name")).casefold()

    return (
        RANK_ORDER.get(rank, 1000),
        name,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Normalize taxonomic records and emit every lineage node "
            "for Speciedex Icon Forge."
        )
    )

    parser.add_argument(
        "--input",
        required=True,
        help="Input file or directory containing JSON/JSONL/NDJSON records.",
    )

    parser.add_argument(
        "--output",
        required=True,
        help="Output normalized JSONL file.",
    )

    parser.add_argument(
        "--rejected",
        required=True,
        help="Output JSONL file for rejected records and errors.",
    )

    parser.add_argument(
        "--terminal-only",
        action="store_true",
        help=(
            "Emit only original terminal records. By default every lineage "
            "node is emitted as its own taxon."
        ),
    )

    return parser


def main() -> int:
    args = build_parser().parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)
    rejected_path = Path(args.rejected)

    files = collect_input_files(input_path)

    output_path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    rejected_path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    source_record_count = 0
    expanded_record_count = 0
    rejected_count = 0
    records_by_identity: dict[str, dict[str, Any]] = {}

    with rejected_path.open(
        "w",
        encoding="utf-8",
    ) as rejected_handle:
        for source_file in files:
            try:
                for raw_record in iter_records(source_file):
                    source_record_count += 1

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

                            expanded_record_count += 1

                    except Exception as exc:
                        rejected_handle.write(
                            json.dumps(
                                {
                                    "source_file": source_file.as_posix(),
                                    "error": str(exc),
                                    "record": raw_record,
                                },
                                ensure_ascii=False,
                            )
                            + "\n"
                        )

                        rejected_count += 1

            except Exception as exc:
                rejected_handle.write(
                    json.dumps(
                        {
                            "source_file": source_file.as_posix(),
                            "error": str(exc),
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )

                rejected_count += 1

    ordered_records = sorted(
        records_by_identity.values(),
        key=rank_sort_key,
    )

    with output_path.open(
        "w",
        encoding="utf-8",
    ) as output_handle:
        for record in ordered_records:
            output_handle.write(
                json.dumps(
                    record,
                    ensure_ascii=False,
                    sort_keys=True,
                )
                + "\n"
            )

    rank_counts: dict[str, int] = {}

    for record in ordered_records:
        rank = clean_rank(record.get("rank"))
        rank_counts[rank] = rank_counts.get(rank, 0) + 1

    print(
        f"source_records={source_record_count} "
        f"expanded_candidates={expanded_record_count} "
        f"unique_taxa={len(ordered_records)} "
        f"rejected={rejected_count}"
    )

    for rank, count in sorted(
        rank_counts.items(),
        key=lambda item: (
            RANK_ORDER.get(item[0], 1000),
            item[0],
        ),
    ):
        print(f"rank.{rank}={count}")

    return 1 if rejected_count and not ordered_records else 0


if __name__ == "__main__":
    raise SystemExit(main())
