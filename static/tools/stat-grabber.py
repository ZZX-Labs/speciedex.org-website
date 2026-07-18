#!/usr/bin/env python3
"""
Speciedex.org
static/tools/stat-grabber.py

Fetch taxonomic totals from public biodiversity APIs and write normalized
statistics into static/data/.

Default output:

    static/data/statistics.json
    static/data/statistics-sources.json
    static/data/statistics-history.json

The script is designed for local execution and scheduled GitHub Actions runs.

Examples:

    python3 static/tools/stat-grabber.py

    python3 static/tools/stat-grabber.py --verbose

    python3 static/tools/stat-grabber.py \
        --output static/data/statistics.json \
        --history static/data/statistics-history.json

Copyright (c) 2026 ZZX-Laboratories

Licensed under the MIT License.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import random
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


PROGRAM_NAME = "Speciedex Stat Grabber"
PROGRAM_VERSION = "1.0.0"

DEFAULT_TIMEOUT = 30
DEFAULT_RETRIES = 4
DEFAULT_BACKOFF = 2.0
DEFAULT_HISTORY_LIMIT = 672

GBIF_BASE_URL = "https://api.gbif.org/v1"

TAXONOMIC_RANKS = {
    "species": "SPECIES",
    "genera": "GENUS",
    "families": "FAMILY",
    "orders": "ORDER",
    "classes": "CLASS",
    "phyla": "PHYLUM",
    "kingdoms": "KINGDOM",
}

LOGGER = logging.getLogger("speciedex.stat_grabber")


@dataclass(frozen=True)
class ProviderResult:
    provider: str
    endpoint: str
    retrieved_at: str
    success: bool
    counts: dict[str, int]
    error: str | None = None


class APIError(RuntimeError):
    """Raised when a remote API returns unusable data."""


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_timestamp(value: datetime | None = None) -> str:
    timestamp = value or utc_now()
    return timestamp.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def repository_root() -> Path:
    return Path(__file__).resolve().parents[2]


def default_data_directory() -> Path:
    return repository_root() / "static" / "data"


def parse_arguments() -> argparse.Namespace:
    data_directory = default_data_directory()

    parser = argparse.ArgumentParser(
        prog="stat-grabber.py",
        description=(
            "Fetch global taxonomic totals and update Speciedex statistics."
        ),
    )

    parser.add_argument(
        "--output",
        type=Path,
        default=data_directory / "statistics.json",
        help="Normalized statistics output file.",
    )

    parser.add_argument(
        "--sources-output",
        type=Path,
        default=data_directory / "statistics-sources.json",
        help="Provider status and raw source metadata output file.",
    )

    parser.add_argument(
        "--history",
        type=Path,
        default=data_directory / "statistics-history.json",
        help="Historical statistics output file.",
    )

    parser.add_argument(
        "--history-limit",
        type=int,
        default=DEFAULT_HISTORY_LIMIT,
        help="Maximum number of history snapshots to retain.",
    )

    parser.add_argument(
        "--timeout",
        type=int,
        default=DEFAULT_TIMEOUT,
        help="HTTP timeout in seconds.",
    )

    parser.add_argument(
        "--retries",
        type=int,
        default=DEFAULT_RETRIES,
        help="Maximum attempts per API request.",
    )

    parser.add_argument(
        "--backoff",
        type=float,
        default=DEFAULT_BACKOFF,
        help="Exponential retry backoff base in seconds.",
    )

    parser.add_argument(
        "--user-agent",
        default=(
            "Speciedex.org-StatGrabber/"
            f"{PROGRAM_VERSION} "
            "(https://speciedex.org; biodiversity statistics)"
        ),
        help="HTTP User-Agent header.",
    )

    parser.add_argument(
        "--allow-zero",
        action="store_true",
        help="Allow zero-valued API totals to replace cached totals.",
    )

    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Fetch and display results without writing files.",
    )

    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable verbose logging.",
    )

    return parser.parse_args()


def configure_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )


def atomic_write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)

    serialized = json.dumps(
        data,
        ensure_ascii=False,
        indent=4,
        sort_keys=False,
    ) + "\n"

    temporary_path: Path | None = None

    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary_file:
            temporary_file.write(serialized)
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
            temporary_path = Path(temporary_file.name)

        temporary_path.replace(path)

    finally:
        if temporary_path and temporary_path.exists():
            temporary_path.unlink(missing_ok=True)


def read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default

    try:
        with path.open("r", encoding="utf-8") as file:
            return json.load(file)

    except (OSError, json.JSONDecodeError) as error:
        LOGGER.warning("Unable to read %s: %s", path, error)
        return default


def request_json(
    url: str,
    *,
    timeout: int,
    retries: int,
    backoff: float,
    user_agent: str,
) -> dict[str, Any]:
    request = Request(
        url,
        method="GET",
        headers={
            "Accept": "application/json",
            "User-Agent": user_agent,
        },
    )

    last_error: Exception | None = None

    for attempt in range(1, retries + 1):
        try:
            LOGGER.debug("GET %s", url)

            with urlopen(request, timeout=timeout) as response:
                status = getattr(response, "status", 200)

                if status < 200 or status >= 300:
                    raise APIError(f"HTTP {status}")

                charset = response.headers.get_content_charset() or "utf-8"
                body = response.read().decode(charset)

            payload = json.loads(body)

            if not isinstance(payload, dict):
                raise APIError("API response was not a JSON object")

            return payload

        except (
            HTTPError,
            URLError,
            TimeoutError,
            json.JSONDecodeError,
            APIError,
            OSError,
        ) as error:
            last_error = error

            if attempt >= retries:
                break

            delay = backoff ** (attempt - 1)
            delay += random.uniform(0, min(1.0, delay / 4))

            LOGGER.warning(
                "Request failed (%s/%s): %s; retrying in %.2f seconds",
                attempt,
                retries,
                error,
                delay,
            )

            time.sleep(delay)

    raise APIError(f"Request failed after {retries} attempts: {last_error}")


def parse_integer(value: Any, field_name: str) -> int:
    if isinstance(value, bool):
        raise APIError(f"{field_name} is not an integer")

    try:
        parsed = int(value)
    except (TypeError, ValueError) as error:
        raise APIError(f"{field_name} is not an integer") from error

    if parsed < 0:
        raise APIError(f"{field_name} is negative")

    return parsed


def gbif_rank_count(
    rank: str,
    *,
    timeout: int,
    retries: int,
    backoff: float,
    user_agent: str,
) -> tuple[int, str]:
    query = urlencode(
        {
            "rank": rank,
            "limit": 0,
        }
    )

    endpoint = f"{GBIF_BASE_URL}/species/search?{query}"

    payload = request_json(
        endpoint,
        timeout=timeout,
        retries=retries,
        backoff=backoff,
        user_agent=user_agent,
    )

    count = parse_integer(payload.get("count"), "count")

    return count, endpoint


def fetch_gbif(
    *,
    timeout: int,
    retries: int,
    backoff: float,
    user_agent: str,
) -> ProviderResult:
    counts: dict[str, int] = {}
    endpoints: list[str] = []
    retrieved_at = iso_timestamp()

    try:
        for output_name, gbif_rank in TAXONOMIC_RANKS.items():
            count, endpoint = gbif_rank_count(
                gbif_rank,
                timeout=timeout,
                retries=retries,
                backoff=backoff,
                user_agent=user_agent,
            )

            counts[output_name] = count
            endpoints.append(endpoint)

            LOGGER.info(
                "GBIF %-9s %s",
                output_name,
                f"{count:,}",
            )

        return ProviderResult(
            provider="GBIF",
            endpoint=GBIF_BASE_URL,
            retrieved_at=retrieved_at,
            success=True,
            counts=counts,
        )

    except APIError as error:
        return ProviderResult(
            provider="GBIF",
            endpoint=GBIF_BASE_URL,
            retrieved_at=retrieved_at,
            success=False,
            counts=counts,
            error=str(error),
        )


def sanitize_counts(
    counts: dict[str, Any],
    *,
    allow_zero: bool,
) -> dict[str, int]:
    sanitized: dict[str, int] = {}

    for name in TAXONOMIC_RANKS:
        value = counts.get(name)

        if value is None:
            continue

        try:
            parsed = parse_integer(value, name)
        except APIError:
            continue

        if parsed == 0 and not allow_zero:
            continue

        sanitized[name] = parsed

    return sanitized


def merge_with_previous(
    current_counts: dict[str, int],
    previous_document: dict[str, Any],
    *,
    allow_zero: bool,
) -> tuple[dict[str, int], list[str]]:
    previous_counts = sanitize_counts(
        previous_document,
        allow_zero=True,
    )

    merged: dict[str, int] = {}
    cached_fields: list[str] = []

    for name in TAXONOMIC_RANKS:
        current_value = current_counts.get(name)

        if current_value is not None:
            if current_value > 0 or allow_zero:
                merged[name] = current_value
                continue

        previous_value = previous_counts.get(name)

        if previous_value is not None:
            merged[name] = previous_value
            cached_fields.append(name)
        else:
            merged[name] = 0

    return merged, cached_fields


def build_statistics_document(
    counts: dict[str, int],
    provider_results: list[ProviderResult],
    cached_fields: list[str],
) -> dict[str, Any]:
    successful_providers = [
        result.provider
        for result in provider_results
        if result.success
    ]

    failed_providers = [
        result.provider
        for result in provider_results
        if not result.success
    ]

    return {
        "species": counts["species"],
        "kingdoms": counts["kingdoms"],
        "phyla": counts["phyla"],
        "classes": counts["classes"],
        "orders": counts["orders"],
        "families": counts["families"],
        "genera": counts["genera"],
        "last_updated": iso_timestamp(),
        "source": successful_providers[0] if successful_providers else "cache",
        "sources": successful_providers,
        "failed_sources": failed_providers,
        "cached_fields": cached_fields,
        "generator": {
            "name": PROGRAM_NAME,
            "version": PROGRAM_VERSION,
        },
    }


def build_sources_document(
    provider_results: list[ProviderResult],
) -> dict[str, Any]:
    return {
        "generated_at": iso_timestamp(),
        "providers": [
            {
                "name": result.provider,
                "endpoint": result.endpoint,
                "retrieved_at": result.retrieved_at,
                "success": result.success,
                "counts": result.counts,
                "error": result.error,
            }
            for result in provider_results
        ],
    }


def update_history(
    history_path: Path,
    statistics: dict[str, Any],
    *,
    history_limit: int,
) -> list[dict[str, Any]]:
    existing = read_json(history_path, [])

    if not isinstance(existing, list):
        existing = []

    snapshot = {
        "timestamp": statistics["last_updated"],
        "source": statistics["source"],
        "species": statistics["species"],
        "genera": statistics["genera"],
        "families": statistics["families"],
        "orders": statistics["orders"],
        "classes": statistics["classes"],
        "phyla": statistics["phyla"],
        "kingdoms": statistics["kingdoms"],
    }

    if existing and isinstance(existing[-1], dict):
        previous = existing[-1]

        comparable_fields = [
            "species",
            "genera",
            "families",
            "orders",
            "classes",
            "phyla",
            "kingdoms",
        ]

        unchanged = all(
            previous.get(field) == snapshot.get(field)
            for field in comparable_fields
        )

        if unchanged:
            existing[-1] = snapshot
        else:
            existing.append(snapshot)
    else:
        existing.append(snapshot)

    if history_limit > 0:
        existing = existing[-history_limit:]

    return existing


def print_summary(statistics: dict[str, Any]) -> None:
    print(f"{PROGRAM_NAME} {PROGRAM_VERSION}")
    print(f"Updated:  {statistics['last_updated']}")
    print(f"Source:   {statistics['source']}")
    print()

    for name in TAXONOMIC_RANKS:
        value = statistics.get(name, 0)
        print(f"{name.capitalize():<10} {value:>15,}")

    if statistics["cached_fields"]:
        print()
        print(
            "Cached fields: "
            + ", ".join(statistics["cached_fields"])
        )


def main() -> int:
    arguments = parse_arguments()
    configure_logging(arguments.verbose)

    if arguments.history_limit < 0:
        LOGGER.error("--history-limit cannot be negative")
        return 2

    previous_document = read_json(arguments.output, {})

    if not isinstance(previous_document, dict):
        previous_document = {}

    provider_results = [
        fetch_gbif(
            timeout=arguments.timeout,
            retries=arguments.retries,
            backoff=arguments.backoff,
            user_agent=arguments.user_agent,
        )
    ]

    combined_counts: dict[str, int] = {}

    for result in provider_results:
        if not result.success:
            LOGGER.error(
                "%s failed: %s",
                result.provider,
                result.error,
            )
            continue

        for name, value in result.counts.items():
            combined_counts[name] = value

    merged_counts, cached_fields = merge_with_previous(
        combined_counts,
        previous_document,
        allow_zero=arguments.allow_zero,
    )

    statistics = build_statistics_document(
        merged_counts,
        provider_results,
        cached_fields,
    )

    sources = build_sources_document(provider_results)

    history = update_history(
        arguments.history,
        statistics,
        history_limit=arguments.history_limit,
    )

    print_summary(statistics)

    if arguments.dry_run:
        LOGGER.info("Dry run enabled; no files were written")
        return 0

    atomic_write_json(arguments.output, statistics)
    atomic_write_json(arguments.sources_output, sources)
    atomic_write_json(arguments.history, history)

    LOGGER.info("Updated %s", arguments.output)
    LOGGER.info("Updated %s", arguments.sources_output)
    LOGGER.info("Updated %s", arguments.history)

    if not any(result.success for result in provider_results):
        LOGGER.warning(
            "All providers failed; cached values were retained"
        )
        return 1

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        raise SystemExit(130)
