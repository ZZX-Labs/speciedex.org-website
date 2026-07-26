#!/usr/bin/env python3
"""
Speciedex.org
static/tools/core/hashing.py

Deterministic hashing utilities for the Speciedex taxonomic ingestion system.

This module owns:

- stable JSON hashing,
- canonical taxon identity hashing,
- provider assertion hashing,
- lineage hashing,
- scientific-name hashing,
- source-record hashing,
- conflict hashing,
- file and stream hashing,
- hash verification,
- Speciedex identifier generation,
- compatibility wrappers for archive and provider code.

All hashes are deterministic across processes and operating systems provided
the same normalized input data is supplied.

Copyright (c) 2026 ZZX-Laboratories

Licensed under the MIT License.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import math
from dataclasses import asdict, dataclass, is_dataclass
from pathlib import Path
from typing import Any, BinaryIO, Iterable, Mapping, Sequence

from providers.common import Taxon


HASH_SCHEMA_VERSION = 1

DEFAULT_ALGORITHM = "sha256"
DEFAULT_CHUNK_SIZE = 1024 * 1024

SUPPORTED_ALGORITHMS = {
    "md5",
    "sha1",
    "sha224",
    "sha256",
    "sha384",
    "sha512",
    "sha3_224",
    "sha3_256",
    "sha3_384",
    "sha3_512",
    "blake2b",
    "blake2s",
}

SPECIEDEX_ID_PREFIX = "spx"
ASSERTION_ID_PREFIX = "spx-assertion"
CONFLICT_ID_PREFIX = "spx-conflict"
LINEAGE_ID_PREFIX = "spx-lineage"
NAME_ID_PREFIX = "spx-name"

HASH_IDENTIFIER_SEPARATOR = ":"
HASH_DIGEST_HEX_CASE = "lower"

VOLATILE_ASSERTION_FIELDS = frozenset(
    {
        "retrieved_at",
        "retrievedAt",
        "fetched_at",
        "fetchedAt",
        "downloaded_at",
        "downloadedAt",
        "request_id",
        "requestId",
        "request_count",
        "requestCount",
    }
)

VOLATILE_REVISION_FIELDS = frozenset(
    {
        "changed_at",
        "created_at",
        "retrieved_at",
        "revision_file",
        "line_number",
        "offset",
    }
)


@dataclass(slots=True, frozen=True)
class HashVerification:
    """Structured digest verification result."""

    valid: bool
    algorithm: str
    actual: str
    expected: str
    reason: str = ""

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible verification result."""

        return {
            "schema_version": HASH_SCHEMA_VERSION,
            "valid": self.valid,
            "algorithm": self.algorithm,
            "actual": self.actual,
            "expected": self.expected,
            "reason": self.reason,
        }



class HashingError(ValueError):
    """Raised when a hash operation cannot be completed safely."""


def normalize_space(value: Any) -> str:
    """Collapse leading, trailing, and repeated whitespace."""

    return " ".join(
        str(
            value
            if value is not None
            else ""
        ).strip().split()
    )


def normalize_key(value: Any) -> str:
    """Normalize text for deterministic comparisons."""

    return normalize_space(
        value
    ).casefold()


def get_hasher(
    algorithm: str = DEFAULT_ALGORITHM,
) -> Any:
    """Return a hashlib-compatible hash object."""

    normalized = normalize_key(
        algorithm
    ).replace(
        "-",
        "_",
    )

    if normalized not in SUPPORTED_ALGORITHMS:
        raise HashingError(
            f"Unsupported hash algorithm: "
            f"{algorithm!r}."
        )

    try:
        return hashlib.new(
            normalized
        )
    except ValueError as error:
        raise HashingError(
            f"Hash algorithm is unavailable: "
            f"{algorithm!r}."
        ) from error


def canonicalize_json_value(
    value: Any,
) -> Any:
    """
    Convert arbitrary supported values into deterministic JSON-compatible data.

    Mapping keys are converted to strings and sorted by their normalized text.
    Sets and frozensets are sorted by canonical JSON representation.
    Dataclasses are converted using dataclasses.asdict().
    Path values are rendered as POSIX paths.
    Bytes are represented as lowercase hexadecimal strings.
    """

    if value is None:
        return None

    if isinstance(
        value,
        (
            str,
            int,
            bool,
        ),
    ):
        return value

    if isinstance(
        value,
        float,
    ):
        if not math.isfinite(value):
            raise HashingError(
                "Non-finite floating-point values "
                "cannot be canonicalized."
            )
        return value

    if isinstance(
        value,
        (
            bytes,
            bytearray,
            memoryview,
        ),
    ):
        return {
            "__type__": "bytes",
            "hex": bytes(value).hex(),
        }

    if isinstance(
        value,
        Path,
    ):
        return value.as_posix()

    if is_dataclass(
        value
    ):
        return canonicalize_json_value(
            asdict(value)
        )

    if hasattr(
        value,
        "to_dict",
    ) and callable(
        value.to_dict
    ):
        return canonicalize_json_value(
            value.to_dict()
        )

    if isinstance(
        value,
        Mapping,
    ):
        items = sorted(
            value.items(),
            key=lambda item: normalize_space(
                item[0]
            ),
        )

        result: dict[str, Any] = {}

        for key, item in items:
            normalized_key = normalize_space(
                key
            )

            if normalized_key in result:
                raise HashingError(
                    "Canonical JSON mapping contains "
                    "colliding normalized keys: "
                    f"{normalized_key!r}."
                )

            result[normalized_key] = (
                canonicalize_json_value(
                    item
                )
            )

        return result

    if isinstance(
        value,
        (
            set,
            frozenset,
        ),
    ):
        normalized_items = [
            canonicalize_json_value(
                item
            )
            for item in value
        ]

        return sorted(
            normalized_items,
            key=lambda item: json.dumps(
                item,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ),
        )

    if isinstance(
        value,
        Sequence,
    ) and not isinstance(
        value,
        (
            str,
            bytes,
            bytearray,
        ),
    ):
        return [
            canonicalize_json_value(
                item
            )
            for item in value
        ]

    if isinstance(
        value,
        Iterable,
    ):
        return [
            canonicalize_json_value(
                item
            )
            for item in value
        ]

    return normalize_space(
        value
    )


def stable_json_bytes(
    value: Any,
) -> bytes:
    """Return canonical UTF-8 JSON bytes."""

    normalized = canonicalize_json_value(
        value
    )

    return json.dumps(
        normalized,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode(
        "utf-8"
    )


def stable_json_text(
    value: Any,
) -> str:
    """Return canonical compact JSON text."""

    return stable_json_bytes(
        value
    ).decode(
        "utf-8"
    )


def digest_bytes(
    value: bytes,
    *,
    algorithm: str = DEFAULT_ALGORITHM,
) -> str:
    """Hash bytes and return a lowercase hexadecimal digest."""

    hasher = get_hasher(
        algorithm
    )

    hasher.update(
        value
    )

    return hasher.hexdigest()


def digest_text(
    value: Any,
    *,
    algorithm: str = DEFAULT_ALGORITHM,
    encoding: str = "utf-8",
) -> str:
    """Hash text and return a lowercase hexadecimal digest."""

    return digest_bytes(
        str(
            value
            if value is not None
            else ""
        ).encode(
            encoding
        ),
        algorithm=algorithm,
    )


def stable_json_hash(
    value: Any,
    *,
    algorithm: str = DEFAULT_ALGORITHM,
) -> str:
    """Hash canonical JSON-compatible data."""

    return digest_bytes(
        stable_json_bytes(
            value
        ),
        algorithm=algorithm,
    )


def file_hash(
    path: Path,
    *,
    algorithm: str = DEFAULT_ALGORITHM,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
) -> str:
    """Hash a file without loading it entirely into memory."""

    source = Path(
        path
    )

    if not source.is_file():
        raise FileNotFoundError(
            f"Cannot hash missing file: "
            f"{source}"
        )

    if chunk_size < 1:
        raise ValueError(
            "chunk_size must be positive."
        )

    hasher = get_hasher(
        algorithm
    )

    with source.open(
        "rb"
    ) as handle:
        for chunk in iter(
            lambda: handle.read(
                chunk_size
            ),
            b"",
        ):
            hasher.update(
                chunk
            )

    return hasher.hexdigest()


def stream_hash(
    stream: BinaryIO,
    *,
    algorithm: str = DEFAULT_ALGORITHM,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
) -> str:
    """Hash a binary stream from its current position."""

    if chunk_size < 1:
        raise ValueError(
            "chunk_size must be positive."
        )

    hasher = get_hasher(
        algorithm
    )

    while True:
        chunk = stream.read(
            chunk_size
        )

        if not chunk:
            break

        if not isinstance(
            chunk,
            (
                bytes,
                bytearray,
                memoryview,
            ),
        ):
            raise TypeError(
                "stream_hash requires a binary stream."
            )

        hasher.update(
            bytes(chunk)
        )

    return hasher.hexdigest()


def verify_digest(
    actual: str,
    expected: str,
) -> bool:
    """Compare hexadecimal digests safely."""

    actual_text = normalize_key(
        actual
    )

    expected_text = normalize_key(
        expected
    )

    if (
        not actual_text
        or not expected_text
    ):
        return False

    return hmac.compare_digest(
        actual_text,
        expected_text,
    )


def verify_file_hash(
    path: Path,
    expected: str,
    *,
    algorithm: str = DEFAULT_ALGORITHM,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
) -> bool:
    """Verify a file against an expected hexadecimal digest."""

    return verify_digest(
        file_hash(
            path,
            algorithm=algorithm,
            chunk_size=chunk_size,
        ),
        expected,
    )


def name_payload(
    scientific_name: Any,
    *,
    canonical_name: Any = "",
    authorship: Any = "",
    rank: Any = "",
) -> dict[str, str]:
    """Build the normalized payload used for scientific-name hashing."""

    scientific = normalize_space(
        scientific_name
    )

    canonical = (
        normalize_space(
            canonical_name
        )
        or scientific
    )

    return {
        "schema_version": (
            HASH_SCHEMA_VERSION
        ),
        "scientific_name": normalize_key(
            scientific
        ),
        "canonical_name": normalize_key(
            canonical
        ),
        "authorship": normalize_key(
            authorship
        ),
        "rank": normalize_key(
            rank
        ),
    }


def name_hash(
    scientific_name: Any,
    *,
    canonical_name: Any = "",
    authorship: Any = "",
    rank: Any = "",
    algorithm: str = DEFAULT_ALGORITHM,
) -> str:
    """Return a deterministic scientific-name digest."""

    return stable_json_hash(
        name_payload(
            scientific_name,
            canonical_name=canonical_name,
            authorship=authorship,
            rank=rank,
        ),
        algorithm=algorithm,
    )


def name_identifier(
    scientific_name: Any,
    *,
    canonical_name: Any = "",
    authorship: Any = "",
    rank: Any = "",
    algorithm: str = DEFAULT_ALGORITHM,
) -> str:
    """Return a namespaced scientific-name identifier."""

    digest = name_hash(
        scientific_name,
        canonical_name=canonical_name,
        authorship=authorship,
        rank=rank,
        algorithm=algorithm,
    )

    return (
        f"{NAME_ID_PREFIX}:"
        f"{normalize_key(algorithm)}:"
        f"{digest}"
    )


def lineage_payload(
    lineage: Mapping[str, Any]
    | Iterable[tuple[Any, Any]]
    | Iterable[Mapping[str, Any]],
) -> list[tuple[str, str]]:
    """
    Build a deterministic ordered lineage payload.

    Mapping inputs are ordered by a fixed major-rank sequence, followed by any
    additional ranks alphabetically.
    """

    rank_order = (
        "domain",
        "superkingdom",
        "kingdom",
        "subkingdom",
        "infrakingdom",
        "superphylum",
        "phylum",
        "subphylum",
        "infraphylum",
        "superclass",
        "class",
        "subclass",
        "infraclass",
        "superorder",
        "order",
        "suborder",
        "infraorder",
        "parvorder",
        "superfamily",
        "family",
        "subfamily",
        "tribe",
        "subtribe",
        "genus",
        "subgenus",
        "species",
        "subspecies",
        "variety",
        "form",
        "strain",
        "cultivar",
        "virus",
        "clade",
        "unranked",
    )

    order_index = {
        rank: index
        for index, rank in enumerate(
            rank_order
        )
    }

    pairs: list[
        tuple[str, str]
    ] = []

    if isinstance(
        lineage,
        Mapping,
    ):
        source_items = list(
            lineage.items()
        )

    else:
        source_items = []

        for item in lineage:
            if isinstance(
                item,
                Mapping,
            ):
                rank = (
                    item.get("rank")
                    or item.get("taxonRank")
                    or item.get("rankName")
                )

                name = (
                    item.get("name")
                    or item.get("scientificName")
                    or item.get("canonicalName")
                )

                source_items.append(
                    (
                        rank,
                        name,
                    )
                )

            else:
                try:
                    rank, name = item
                except (
                    TypeError,
                    ValueError,
                ):
                    continue

                source_items.append(
                    (
                        rank,
                        name,
                    )
                )

    for rank, name in source_items:
        normalized_rank = normalize_key(
            rank
        ).replace(
            " ",
            "_",
        )

        normalized_name = normalize_key(
            name
        )

        if (
            not normalized_rank
            or not normalized_name
        ):
            continue

        pairs.append(
            (
                normalized_rank,
                normalized_name,
            )
        )

    deduplicated = {
        rank: name
        for rank, name in pairs
    }

    return sorted(
        deduplicated.items(),
        key=lambda item: (
            order_index.get(
                item[0],
                len(order_index),
            ),
            item[0],
        ),
    )


def lineage_hash(
    lineage: Mapping[str, Any]
    | Iterable[tuple[Any, Any]]
    | Iterable[Mapping[str, Any]],
    *,
    algorithm: str = DEFAULT_ALGORITHM,
) -> str:
    """Return a deterministic lineage digest."""

    payload = {
        "schema_version": (
            HASH_SCHEMA_VERSION
        ),
        "lineage": lineage_payload(
            lineage
        ),
    }

    return stable_json_hash(
        payload,
        algorithm=algorithm,
    )


def lineage_identifier(
    lineage: Mapping[str, Any]
    | Iterable[tuple[Any, Any]]
    | Iterable[Mapping[str, Any]],
    *,
    algorithm: str = DEFAULT_ALGORITHM,
) -> str:
    """Return a namespaced lineage identifier."""

    digest = lineage_hash(
        lineage,
        algorithm=algorithm,
    )

    return (
        f"{LINEAGE_ID_PREFIX}:"
        f"{normalize_key(algorithm)}:"
        f"{digest}"
    )


def taxon_identity_payload(
    record: Taxon | Mapping[str, Any],
) -> dict[str, Any]:
    """Build the deterministic canonical taxon identity payload."""

    if isinstance(
        record,
        Taxon,
    ):
        canonical_name_value = (
            record.canonical_name
        )

        scientific_name_value = (
            record.scientific_name
        )

        rank_value = record.rank
        authorship_value = (
            record.authorship
        )

        lineage = {
            "kingdom": record.kingdom,
            "phylum": record.phylum,
            "class": record.class_name,
            "order": record.order,
            "family": record.family,
            "genus": record.genus,
        }

    elif isinstance(
        record,
        Mapping,
    ):
        taxonomy = record.get(
            "taxonomy",
            {},
        )

        if not isinstance(
            taxonomy,
            Mapping,
        ):
            taxonomy = {}

        canonical_name_value = (
            record.get(
                "canonical_name",
                record.get(
                    "canonicalName",
                    "",
                ),
            )
        )

        scientific_name_value = (
            record.get(
                "scientific_name",
                record.get(
                    "scientificName",
                    "",
                ),
            )
        )

        rank_value = record.get(
            "rank",
            record.get(
                "taxonRank",
                "",
            ),
        )

        authorship_value = (
            record.get(
                "authorship",
                record.get(
                    "authority",
                    "",
                ),
            )
        )

        lineage = {
            "kingdom": (
                taxonomy.get(
                    "kingdom",
                    record.get(
                        "kingdom",
                        "",
                    ),
                )
            ),
            "phylum": (
                taxonomy.get(
                    "phylum",
                    record.get(
                        "phylum",
                        "",
                    ),
                )
            ),
            "class": (
                taxonomy.get(
                    "class",
                    record.get(
                        "class_name",
                        record.get(
                            "class",
                            "",
                        ),
                    ),
                )
            ),
            "order": (
                taxonomy.get(
                    "order",
                    record.get(
                        "order",
                        "",
                    ),
                )
            ),
            "family": (
                taxonomy.get(
                    "family",
                    record.get(
                        "family",
                        "",
                    ),
                )
            ),
            "genus": (
                taxonomy.get(
                    "genus",
                    record.get(
                        "genus",
                        "",
                    ),
                )
            ),
        }

    else:
        raise TypeError(
            "taxon_identity_payload requires "
            "a Taxon or mapping."
        )

    canonical_value = (
        normalize_key(
            canonical_name_value
        )
        or normalize_key(
            scientific_name_value
        )
    )

    return {
        "schema_version": (
            HASH_SCHEMA_VERSION
        ),
        "canonical_name": canonical_value,
        "rank": normalize_key(
            rank_value
        ),
        "authorship": normalize_key(
            authorship_value
        ),
        "lineage": lineage_payload(
            lineage
        ),
    }


def taxon_hash(
    record: Taxon | Mapping[str, Any],
    *,
    algorithm: str = DEFAULT_ALGORITHM,
) -> str:
    """Return the deterministic canonical taxon digest."""

    return stable_json_hash(
        taxon_identity_payload(
            record
        ),
        algorithm=algorithm,
    )


def speciedex_id(
    record: Taxon | Mapping[str, Any],
    *,
    algorithm: str = DEFAULT_ALGORITHM,
) -> str:
    """Return the permanent deterministic Speciedex taxon identifier."""

    digest = taxon_hash(
        record,
        algorithm=algorithm,
    )

    return (
        f"{SPECIEDEX_ID_PREFIX}:"
        f"{normalize_key(algorithm)}:"
        f"{digest}"
    )


def assertion_payload(
    record: Taxon | Mapping[str, Any],
) -> dict[str, Any]:
    """
    Build the deterministic provider assertion payload.

    Retrieval timestamps are excluded so re-fetching an unchanged assertion
    does not create a new hash.
    """

    if isinstance(
        record,
        Taxon,
    ):
        payload = record.to_dict()

    elif isinstance(
        record,
        Mapping,
    ):
        payload = dict(
            record
        )

    else:
        raise TypeError(
            "assertion_payload requires "
            "a Taxon or mapping."
        )

    excluded_fields = (
        VOLATILE_ASSERTION_FIELDS
    )

    normalized_payload = {
        str(key): value
        for key, value in payload.items()
        if str(key) not in excluded_fields
    }

    extra = normalized_payload.get(
        "extra"
    )

    if isinstance(
        extra,
        Mapping,
    ):
        normalized_payload["extra"] = {
            str(key): value
            for key, value in extra.items()
            if str(key)
            not in excluded_fields
        }

    return canonicalize_json_value(
        normalized_payload
    )


def assertion_hash(
    record: Taxon | Mapping[str, Any],
    *,
    algorithm: str = DEFAULT_ALGORITHM,
) -> str:
    """Return the deterministic provider assertion digest."""

    return stable_json_hash(
        assertion_payload(
            record
        ),
        algorithm=algorithm,
    )


def assertion_identifier(
    record: Taxon | Mapping[str, Any],
    *,
    algorithm: str = DEFAULT_ALGORITHM,
) -> str:
    """Return a namespaced provider assertion identifier."""

    digest = assertion_hash(
        record,
        algorithm=algorithm,
    )

    return (
        f"{ASSERTION_ID_PREFIX}:"
        f"{normalize_key(algorithm)}:"
        f"{digest}"
    )


def source_record_hash(
    provider: Any,
    provider_id: Any,
    raw_record: Any,
    *,
    algorithm: str = DEFAULT_ALGORITHM,
) -> str:
    """Hash one provider source record with its source identity."""

    payload = {
        "schema_version": (
            HASH_SCHEMA_VERSION
        ),
        "provider": normalize_key(
            provider
        ),
        "provider_id": normalize_space(
            provider_id
        ),
        "raw": raw_record,
    }

    return stable_json_hash(
        payload,
        algorithm=algorithm,
    )


def provider_hash(
    provider: Any,
    provider_id: Any,
    *,
    algorithm: str = DEFAULT_ALGORITHM,
) -> str:
    """Hash a provider/source identifier pair."""

    payload = {
        "provider": normalize_key(
            provider
        ),
        "provider_id": normalize_space(
            provider_id
        ),
    }

    return stable_json_hash(
        payload,
        algorithm=algorithm,
    )


def conflict_payload(
    *,
    provider: Any,
    provider_id: Any,
    canonical_name: Any,
    rank: Any,
    candidates: Iterable[Any],
    reason: Any = "",
    kingdom: Any = "",
) -> dict[str, Any]:
    """Build a deterministic conflict payload excluding timestamps."""

    normalized_candidates = sorted(
        {
            normalize_space(
                candidate
            )
            for candidate in candidates
            if normalize_space(
                candidate
            )
        }
    )

    return {
        "schema_version": (
            HASH_SCHEMA_VERSION
        ),
        "provider": normalize_key(
            provider
        ),
        "provider_id": normalize_space(
            provider_id
        ),
        "canonical_name": normalize_key(
            canonical_name
        ),
        "rank": normalize_key(
            rank
        ),
        "kingdom": normalize_key(
            kingdom
        ),
        "candidates": normalized_candidates,
        "reason": normalize_space(
            reason
        ),
    }


def conflict_hash(
    *,
    provider: Any,
    provider_id: Any,
    canonical_name: Any,
    rank: Any,
    candidates: Iterable[Any],
    reason: Any = "",
    kingdom: Any = "",
    algorithm: str = DEFAULT_ALGORITHM,
) -> str:
    """Return a deterministic reconciliation conflict digest."""

    return stable_json_hash(
        conflict_payload(
            provider=provider,
            provider_id=provider_id,
            canonical_name=canonical_name,
            rank=rank,
            candidates=candidates,
            reason=reason,
            kingdom=kingdom,
        ),
        algorithm=algorithm,
    )


def conflict_identifier(
    *,
    provider: Any,
    provider_id: Any,
    canonical_name: Any,
    rank: Any,
    candidates: Iterable[Any],
    reason: Any = "",
    kingdom: Any = "",
    algorithm: str = DEFAULT_ALGORITHM,
) -> str:
    """Return a namespaced deterministic conflict identifier."""

    digest = conflict_hash(
        provider=provider,
        provider_id=provider_id,
        canonical_name=canonical_name,
        rank=rank,
        candidates=candidates,
        reason=reason,
        kingdom=kingdom,
        algorithm=algorithm,
    )

    return (
        f"{CONFLICT_ID_PREFIX}:"
        f"{normalize_key(algorithm)}:"
        f"{digest}"
    )


def revision_hash(
    revision: Mapping[str, Any],
    *,
    algorithm: str = DEFAULT_ALGORITHM,
) -> str:
    """
    Hash a revision event while excluding volatile timestamps and locations.
    """

    excluded = (
        VOLATILE_REVISION_FIELDS
    )

    payload = {
        str(key): value
        for key, value in revision.items()
        if str(key) not in excluded
    }

    return stable_json_hash(
        payload,
        algorithm=algorithm,
    )


def manifest_hash(
    manifest: Mapping[str, Any],
    *,
    algorithm: str = DEFAULT_ALGORITHM,
    exclude_generated_at: bool = True,
) -> str:
    """Return a deterministic archive manifest digest."""

    payload = dict(
        manifest
    )

    if exclude_generated_at:
        payload.pop(
            "generated_at",
            None,
        )

        revision_journal = payload.get(
            "revision_journal"
        )

        if isinstance(
            revision_journal,
            Mapping,
        ):
            payload[
                "revision_journal"
            ] = {
                key: value
                for key, value
                in revision_journal.items()
                if key != "generated_at"
            }

        conflict_journal = payload.get(
            "conflict_journal"
        )

        if isinstance(
            conflict_journal,
            Mapping,
        ):
            payload[
                "conflict_journal"
            ] = {
                key: value
                for key, value
                in conflict_journal.items()
                if key != "generated_at"
            }

    return stable_json_hash(
        payload,
        algorithm=algorithm,
    )


def short_hash(
    value: Any,
    *,
    length: int = 16,
    algorithm: str = DEFAULT_ALGORITHM,
) -> str:
    """Return a shortened deterministic JSON hash."""

    if length < 4:
        raise ValueError(
            "length must be at least 4."
        )

    digest = stable_json_hash(
        value,
        algorithm=algorithm,
    )

    return digest[
        : min(
            length,
            len(digest),
        )
    ]


def hash_record_set(
    records: Iterable[Any],
    *,
    algorithm: str = DEFAULT_ALGORITHM,
    order_sensitive: bool = True,
) -> str:
    """
    Hash a collection of records.

    When order_sensitive is False, individual record hashes are sorted before
    the final collection hash is calculated.
    """

    digests = [
        stable_json_hash(
            record,
            algorithm=algorithm,
        )
        for record in records
    ]

    if not order_sensitive:
        digests.sort()

    return stable_json_hash(
        {
            "schema_version": (
                HASH_SCHEMA_VERSION
            ),
            "algorithm": normalize_key(
                algorithm
            ),
            "records": digests,
        },
        algorithm=algorithm,
    )


def hash_matches(
    value: Any,
    expected: str,
    *,
    algorithm: str = DEFAULT_ALGORITHM,
) -> bool:
    """Verify canonical JSON-compatible data against an expected digest."""

    return verify_digest(
        stable_json_hash(
            value,
            algorithm=algorithm,
        ),
        expected,
    )

def normalize_algorithm(
    algorithm: Any = DEFAULT_ALGORITHM,
) -> str:
    """Return the canonical hashlib algorithm name."""

    normalized = normalize_key(
        algorithm
    ).replace(
        "-",
        "_",
    )

    if normalized not in SUPPORTED_ALGORITHMS:
        raise HashingError(
            f"Unsupported hash algorithm: "
            f"{algorithm!r}."
        )

    return normalized


def digest_size(
    algorithm: str = DEFAULT_ALGORITHM,
) -> int:
    """Return the digest size in bytes for one supported algorithm."""

    return int(
        get_hasher(
            algorithm
        ).digest_size
    )


def digest_hex_length(
    algorithm: str = DEFAULT_ALGORITHM,
) -> int:
    """Return the lowercase hexadecimal digest length."""

    return digest_size(
        algorithm
    ) * 2


def validate_hex_digest(
    digest: Any,
    *,
    algorithm: str = DEFAULT_ALGORITHM,
    allow_uppercase: bool = True,
) -> str:
    """Validate and normalize a hexadecimal digest."""

    normalized_algorithm = normalize_algorithm(
        algorithm
    )

    text = normalize_space(
        digest
    )

    if allow_uppercase:
        text = text.casefold()

    expected_length = digest_hex_length(
        normalized_algorithm
    )

    if len(text) != expected_length:
        raise HashingError(
            f"Invalid {normalized_algorithm} digest "
            f"length: expected {expected_length}, "
            f"received {len(text)}."
        )

    try:
        bytes.fromhex(
            text
        )
    except ValueError as error:
        raise HashingError(
            "Digest contains non-hexadecimal characters."
        ) from error

    return text


def verify_digest_strict(
    actual: Any,
    expected: Any,
    *,
    algorithm: str = DEFAULT_ALGORITHM,
) -> HashVerification:
    """Validate and compare two digests with a structured result."""

    normalized_algorithm = normalize_algorithm(
        algorithm
    )

    try:
        actual_text = validate_hex_digest(
            actual,
            algorithm=normalized_algorithm,
        )
    except HashingError as error:
        return HashVerification(
            valid=False,
            algorithm=normalized_algorithm,
            actual=normalize_space(
                actual
            ),
            expected=normalize_space(
                expected
            ),
            reason=str(error),
        )

    try:
        expected_text = validate_hex_digest(
            expected,
            algorithm=normalized_algorithm,
        )
    except HashingError as error:
        return HashVerification(
            valid=False,
            algorithm=normalized_algorithm,
            actual=actual_text,
            expected=normalize_space(
                expected
            ),
            reason=str(error),
        )

    valid = hmac.compare_digest(
        actual_text,
        expected_text,
    )

    return HashVerification(
        valid=valid,
        algorithm=normalized_algorithm,
        actual=actual_text,
        expected=expected_text,
        reason=(
            ""
            if valid
            else "Digest mismatch."
        ),
    )


def parse_hash_identifier(
    value: Any,
) -> tuple[str, str, str]:
    """
    Parse a namespaced identifier into prefix, algorithm, and digest.

    Accepted format: ``prefix:algorithm:hex-digest``.
    """

    text = normalize_space(
        value
    )

    parts = text.rsplit(
        HASH_IDENTIFIER_SEPARATOR,
        2,
    )

    if len(parts) != 3:
        raise HashingError(
            "Hash identifier must contain "
            "prefix, algorithm, and digest."
        )

    prefix, algorithm, digest = parts

    if not prefix:
        raise HashingError(
            "Hash identifier prefix is empty."
        )

    normalized_algorithm = normalize_algorithm(
        algorithm
    )

    normalized_digest = validate_hex_digest(
        digest,
        algorithm=normalized_algorithm,
    )

    return (
        prefix,
        normalized_algorithm,
        normalized_digest,
    )


def verify_hash_identifier(
    value: Any,
    *,
    expected_prefix: str | None = None,
) -> bool:
    """Return whether a namespaced hash identifier is structurally valid."""

    try:
        prefix, _, _ = parse_hash_identifier(
            value
        )
    except HashingError:
        return False

    if (
        expected_prefix is not None
        and prefix
        != normalize_space(
            expected_prefix
        )
    ):
        return False

    return True


def build_hash_identifier(
    prefix: Any,
    digest: Any,
    *,
    algorithm: str = DEFAULT_ALGORITHM,
) -> str:
    """Build a validated namespaced hash identifier."""

    normalized_prefix = normalize_space(
        prefix
    )

    if not normalized_prefix:
        raise HashingError(
            "Hash identifier prefix is required."
        )

    normalized_algorithm = normalize_algorithm(
        algorithm
    )

    normalized_digest = validate_hex_digest(
        digest,
        algorithm=normalized_algorithm,
    )

    return HASH_IDENTIFIER_SEPARATOR.join(
        (
            normalized_prefix,
            normalized_algorithm,
            normalized_digest,
        )
    )


def stream_hash_preserving_position(
    stream: BinaryIO,
    *,
    algorithm: str = DEFAULT_ALGORITHM,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
) -> str:
    """Hash a seekable stream and restore its original position."""

    try:
        position = stream.tell()
    except (
        AttributeError,
        OSError,
    ) as error:
        raise HashingError(
            "Stream position cannot be determined."
        ) from error

    try:
        return stream_hash(
            stream,
            algorithm=algorithm,
            chunk_size=chunk_size,
        )
    finally:
        try:
            stream.seek(
                position
            )
        except (
            AttributeError,
            OSError,
        ) as error:
            raise HashingError(
                "Stream position could not be restored."
            ) from error


def directory_manifest(
    root: Path | str,
    *,
    algorithm: str = DEFAULT_ALGORITHM,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    include_hidden: bool = True,
) -> dict[str, str]:
    """Return deterministic relative-path hashes for every file in a tree."""

    base = Path(
        root
    )

    if not base.is_dir():
        raise NotADirectoryError(
            f"Cannot hash missing directory: {base}"
        )

    result: dict[str, str] = {}

    for path in sorted(
        candidate
        for candidate in base.rglob("*")
        if candidate.is_file()
    ):
        relative = path.relative_to(
            base
        )

        if (
            not include_hidden
            and any(
                part.startswith(".")
                for part in relative.parts
            )
        ):
            continue

        result[
            relative.as_posix()
        ] = file_hash(
            path,
            algorithm=algorithm,
            chunk_size=chunk_size,
        )

    return result


def directory_hash(
    root: Path | str,
    *,
    algorithm: str = DEFAULT_ALGORITHM,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    include_hidden: bool = True,
) -> str:
    """Hash a directory from relative paths and file digests."""

    manifest = directory_manifest(
        root,
        algorithm=algorithm,
        chunk_size=chunk_size,
        include_hidden=include_hidden,
    )

    return stable_json_hash(
        {
            "schema_version": HASH_SCHEMA_VERSION,
            "algorithm": normalize_algorithm(
                algorithm
            ),
            "files": manifest,
        },
        algorithm=algorithm,
    )


def hash_capabilities() -> dict[str, Any]:
    """Return supported hashing capability metadata."""

    algorithms = {}

    for algorithm in sorted(
        SUPPORTED_ALGORITHMS
    ):
        hasher = get_hasher(
            algorithm
        )

        algorithms[
            algorithm
        ] = {
            "digest_size": (
                hasher.digest_size
            ),
            "hex_length": (
                hasher.digest_size * 2
            ),
            "block_size": (
                hasher.block_size
            ),
        }

    return {
        "schema_version": HASH_SCHEMA_VERSION,
        "default_algorithm": DEFAULT_ALGORITHM,
        "default_chunk_size": DEFAULT_CHUNK_SIZE,
        "algorithms": algorithms,
    }


__all__ = [
    "ASSERTION_ID_PREFIX",
    "CONFLICT_ID_PREFIX",
    "DEFAULT_ALGORITHM",
    "DEFAULT_CHUNK_SIZE",
    "HASH_DIGEST_HEX_CASE",
    "HASH_IDENTIFIER_SEPARATOR",
    "HASH_SCHEMA_VERSION",
    "LINEAGE_ID_PREFIX",
    "NAME_ID_PREFIX",
    "SPECIEDEX_ID_PREFIX",
    "SUPPORTED_ALGORITHMS",
    "VOLATILE_ASSERTION_FIELDS",
    "VOLATILE_REVISION_FIELDS",
    "HashVerification",
    "HashingError",
    "assertion_hash",
    "assertion_identifier",
    "assertion_payload",
    "build_hash_identifier",
    "canonicalize_json_value",
    "conflict_hash",
    "conflict_identifier",
    "conflict_payload",
    "digest_bytes",
    "digest_hex_length",
    "digest_size",
    "digest_text",
    "directory_hash",
    "directory_manifest",
    "file_hash",
    "get_hasher",
    "hash_capabilities",
    "hash_matches",
    "hash_record_set",
    "lineage_hash",
    "lineage_identifier",
    "lineage_payload",
    "manifest_hash",
    "name_hash",
    "name_identifier",
    "name_payload",
    "normalize_algorithm",
    "normalize_key",
    "normalize_space",
    "parse_hash_identifier",
    "provider_hash",
    "revision_hash",
    "short_hash",
    "source_record_hash",
    "speciedex_id",
    "stable_json_bytes",
    "stable_json_hash",
    "stable_json_text",
    "stream_hash",
    "stream_hash_preserving_position",
    "taxon_hash",
    "taxon_identity_payload",
    "validate_hex_digest",
    "verify_digest",
    "verify_digest_strict",
    "verify_file_hash",
    "verify_hash_identifier",
]
