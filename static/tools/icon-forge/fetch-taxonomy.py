#!/usr/bin/env python3
"""
Speciedex taxonomy fetcher.

Populates static/data/taxonomy/raw/ with normalized source-shaped JSONL files
for the Speciedex Icon Forge pipeline.

Expected location:
    static/tools/icon-forge/fetch-taxonomy.py

The fetcher always supports a deterministic built-in bootstrap taxonomy so a
fresh repository can run the complete icon pipeline without external services.

Optional network-backed providers:
    gbif

Examples:
    python static/tools/icon-forge/fetch-taxonomy.py \
      --output-dir static/data/taxonomy/raw

    python static/tools/icon-forge/fetch-taxonomy.py \
      --output-dir static/data/taxonomy/raw \
      --providers bootstrap gbif

    python static/tools/icon-forge/fetch-taxonomy.py \
      --output-dir static/data/taxonomy/raw \
      --config static/config/taxonomy-sources.json \
      --providers bootstrap gbif
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Iterable, Mapping

USER_AGENT = "Speciedex-Icon-Forge/1.0 (+https://speciedex.org)"
GBIF_MATCH_URL = "https://api.gbif.org/v1/species/match"

DEFAULT_TIMEOUT = 30
DEFAULT_RETRIES = 3
DEFAULT_DELAY = 0.25

BOOTSTRAP_RECORDS: list[dict[str, Any]] = [
    {
        "id": "speciedex:domain:eukaryota",
        "source": "speciedex",
        "source_id": "domain:eukaryota",
        "scientific_name": "Eukaryota",
        "canonical_name": "Eukaryota",
        "rank": "domain",
        "status": "accepted",
        "lineage": [
            {"rank": "domain", "name": "Eukaryota"},
        ],
        "traits": {
            "cellularity": ["unicellular", "multicellular"],
        },
    },
    {
        "id": "speciedex:domain:bacteria",
        "source": "speciedex",
        "source_id": "domain:bacteria",
        "scientific_name": "Bacteria",
        "canonical_name": "Bacteria",
        "rank": "domain",
        "status": "accepted",
        "lineage": [
            {"rank": "domain", "name": "Bacteria"},
        ],
        "traits": {
            "cellularity": "unicellular",
        },
    },
    {
        "id": "speciedex:domain:archaea",
        "source": "speciedex",
        "source_id": "domain:archaea",
        "scientific_name": "Archaea",
        "canonical_name": "Archaea",
        "rank": "domain",
        "status": "accepted",
        "lineage": [
            {"rank": "domain", "name": "Archaea"},
        ],
        "traits": {
            "cellularity": "unicellular",
        },
    },
    {
        "id": "speciedex:kingdom:animalia",
        "source": "speciedex",
        "source_id": "kingdom:animalia",
        "scientific_name": "Animalia",
        "canonical_name": "Animalia",
        "rank": "kingdom",
        "status": "accepted",
        "lineage": [
            {"rank": "domain", "name": "Eukaryota"},
            {"rank": "kingdom", "name": "Animalia"},
        ],
        "traits": {
            "cellularity": "multicellular",
            "motility": "mobile",
        },
    },
    {
        "id": "speciedex:kingdom:plantae",
        "source": "speciedex",
        "source_id": "kingdom:plantae",
        "scientific_name": "Plantae",
        "canonical_name": "Plantae",
        "rank": "kingdom",
        "status": "accepted",
        "lineage": [
            {"rank": "domain", "name": "Eukaryota"},
            {"rank": "kingdom", "name": "Plantae"},
        ],
        "traits": {
            "cellularity": "multicellular",
            "motility": "sessile",
            "trophic_level": "autotroph",
        },
    },
    {
        "id": "speciedex:kingdom:fungi",
        "source": "speciedex",
        "source_id": "kingdom:fungi",
        "scientific_name": "Fungi",
        "canonical_name": "Fungi",
        "rank": "kingdom",
        "status": "accepted",
        "lineage": [
            {"rank": "domain", "name": "Eukaryota"},
            {"rank": "kingdom", "name": "Fungi"},
        ],
        "traits": {
            "cellularity": "multicellular",
            "motility": "sessile",
            "trophic_level": "heterotroph",
        },
    },
    {
        "id": "speciedex:species:panthera-leo",
        "source": "speciedex",
        "source_id": "species:panthera-leo",
        "scientific_name": "Panthera leo",
        "canonical_name": "Panthera leo",
        "common_name": "Lion",
        "rank": "species",
        "status": "accepted",
        "lineage": [
            {"rank": "domain", "name": "Eukaryota"},
            {"rank": "kingdom", "name": "Animalia"},
            {"rank": "phylum", "name": "Chordata"},
            {"rank": "class", "name": "Mammalia"},
            {"rank": "order", "name": "Carnivora"},
            {"rank": "family", "name": "Felidae"},
            {"rank": "genus", "name": "Panthera"},
            {"rank": "species", "name": "Panthera leo"},
        ],
        "traits": {
            "body_plan": "bilateral",
            "cellularity": "multicellular",
            "motility": "mobile",
            "trophic_level": "carnivore",
            "habitat": ["terrestrial", "grassland", "forest"],
        },
    },
]

DEFAULT_GBIF_QUERIES = [
    {"scientific_name": "Homo sapiens", "rank": "species"},
    {"scientific_name": "Panthera leo", "rank": "species"},
    {"scientific_name": "Panthera tigris", "rank": "species"},
    {"scientific_name": "Canis lupus", "rank": "species"},
    {"scientific_name": "Quercus robur", "rank": "species"},
    {"scientific_name": "Amanita muscaria", "rank": "species"},
]


def request_json(
    url: str,
    *,
    timeout: int,
    retries: int,
    delay: float,
) -> Any:
    last_error: Exception | None = None

    for attempt in range(1, retries + 1):
        request = urllib.request.Request(
            url,
            headers={
                "Accept": "application/json",
                "User-Agent": USER_AGENT,
            },
        )

        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))

        except (
            urllib.error.HTTPError,
            urllib.error.URLError,
            TimeoutError,
            json.JSONDecodeError,
        ) as exc:
            last_error = exc

            if attempt < retries:
                time.sleep(delay * attempt)

    raise RuntimeError(f"request failed after {retries} attempts: {url}: {last_error}")


def write_jsonl(path: Path, records: Iterable[Mapping[str, Any]]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)

    count = 0
    with path.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(
                json.dumps(
                    dict(record),
                    ensure_ascii=False,
                    sort_keys=True,
                )
                + "\n"
            )
            count += 1

    return count


def load_config(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {}

    if not path.exists():
        raise FileNotFoundError(f"config does not exist: {path}")

    payload = json.loads(path.read_text(encoding="utf-8"))

    if not isinstance(payload, dict):
        raise ValueError("config root must be a JSON object")

    return payload


def build_lineage_from_gbif(payload: Mapping[str, Any]) -> list[dict[str, str]]:
    ordered_fields = [
        ("domain", "domain"),
        ("kingdom", "kingdom"),
        ("phylum", "phylum"),
        ("class", "class"),
        ("order", "order"),
        ("family", "family"),
        ("genus", "genus"),
        ("species", "species"),
    ]

    lineage: list[dict[str, str]] = []

    for field, rank in ordered_fields:
        value = str(payload.get(field) or "").strip()
        if value:
            lineage.append({
                "rank": rank,
                "name": value,
            })

    scientific_name = str(
        payload.get("scientificName")
        or payload.get("canonicalName")
        or ""
    ).strip()

    rank = str(payload.get("rank") or "unranked").lower()

    if scientific_name:
        if not lineage or lineage[-1]["name"].casefold() != scientific_name.casefold():
            lineage.append({
                "rank": rank,
                "name": scientific_name,
            })

    return lineage


def fetch_gbif_record(
    query: Mapping[str, Any],
    *,
    timeout: int,
    retries: int,
    delay: float,
) -> dict[str, Any]:
    scientific_name = str(
        query.get("scientific_name")
        or query.get("name")
        or ""
    ).strip()

    if not scientific_name:
        raise ValueError("GBIF query requires scientific_name or name")

    params = {
        "name": scientific_name,
    }

    rank = str(query.get("rank") or "").strip()
    kingdom = str(query.get("kingdom") or "").strip()

    if rank:
        params["rank"] = rank

    if kingdom:
        params["kingdom"] = kingdom

    url = f"{GBIF_MATCH_URL}?{urllib.parse.urlencode(params)}"

    payload = request_json(
        url,
        timeout=timeout,
        retries=retries,
        delay=delay,
    )

    if not isinstance(payload, Mapping):
        raise ValueError(f"unexpected GBIF response for {scientific_name}")

    usage_key = payload.get("usageKey")
    canonical_name = str(
        payload.get("canonicalName")
        or payload.get("scientificName")
        or scientific_name
    ).strip()

    taxon_rank = str(payload.get("rank") or rank or "unranked").lower()
    status = str(payload.get("status") or "accepted").lower()

    return {
        "id": f"gbif:{usage_key}" if usage_key is not None else "",
        "source": "gbif",
        "source_id": str(usage_key or ""),
        "scientific_name": canonical_name,
        "canonical_name": canonical_name,
        "rank": taxon_rank,
        "status": status,
        "lineage": build_lineage_from_gbif(payload),
        "traits": dict(query.get("traits") or {}),
        "match": {
            "confidence": payload.get("confidence"),
            "match_type": payload.get("matchType"),
            "note": payload.get("note"),
        },
    }


def fetch_gbif(
    queries: Iterable[Mapping[str, Any]],
    *,
    timeout: int,
    retries: int,
    delay: float,
    strict: bool,
) -> tuple[list[dict[str, Any]], int]:
    records: list[dict[str, Any]] = []
    failures = 0

    for index, query in enumerate(queries, 1):
        try:
            record = fetch_gbif_record(
                query,
                timeout=timeout,
                retries=retries,
                delay=delay,
            )
            records.append(record)
            print(
                f"[gbif:{index}] {record['scientific_name']} "
                f"({record['rank']})"
            )

        except Exception as exc:
            failures += 1
            print(
                f"[gbif:{index}] ERROR: {exc}",
                file=sys.stderr,
            )

            if strict:
                raise

        time.sleep(delay)

    return records, failures


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Fetch raw taxonomy records for Speciedex Icon Forge."
    )

    parser.add_argument(
        "--output-dir",
        required=True,
        help="Directory receiving raw JSONL provider files.",
    )

    parser.add_argument(
        "--config",
        default="",
        help=(
            "Optional JSON configuration file. Supported keys: "
            "bootstrap_records and gbif_queries."
        ),
    )

    parser.add_argument(
        "--providers",
        nargs="+",
        choices=("bootstrap", "gbif"),
        default=("bootstrap",),
        help="Providers to run.",
    )

    parser.add_argument(
        "--timeout",
        type=int,
        default=DEFAULT_TIMEOUT,
    )

    parser.add_argument(
        "--retries",
        type=int,
        default=DEFAULT_RETRIES,
    )

    parser.add_argument(
        "--delay",
        type=float,
        default=DEFAULT_DELAY,
    )

    parser.add_argument(
        "--strict",
        action="store_true",
        help="Fail immediately when a provider request fails.",
    )

    return parser


def main() -> int:
    args = build_parser().parse_args()

    output_dir = Path(args.output_dir)
    config_path = Path(args.config) if args.config else None
    config = load_config(config_path)

    output_dir.mkdir(parents=True, exist_ok=True)

    total = 0
    failures = 0

    if "bootstrap" in args.providers:
        bootstrap_records = config.get(
            "bootstrap_records",
            BOOTSTRAP_RECORDS,
        )

        if not isinstance(bootstrap_records, list):
            raise ValueError("bootstrap_records must be an array")

        count = write_jsonl(
            output_dir / "speciedex-bootstrap.jsonl",
            bootstrap_records,
        )

        total += count
        print(f"bootstrap={count}")

    if "gbif" in args.providers:
        gbif_queries = config.get(
            "gbif_queries",
            DEFAULT_GBIF_QUERIES,
        )

        if not isinstance(gbif_queries, list):
            raise ValueError("gbif_queries must be an array")

        records, provider_failures = fetch_gbif(
            gbif_queries,
            timeout=args.timeout,
            retries=args.retries,
            delay=args.delay,
            strict=args.strict,
        )

        count = write_jsonl(
            output_dir / "gbif.jsonl",
            records,
        )

        total += count
        failures += provider_failures
        print(f"gbif={count} failures={provider_failures}")

    print(
        f"fetched={total} "
        f"failures={failures} "
        f"output_dir={output_dir.as_posix()}"
    )

    if total == 0:
        print(
            "No taxonomy records were fetched.",
            file=sys.stderr,
        )
        return 1

    return 1 if args.strict and failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
