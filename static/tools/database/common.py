#!/usr/bin/env python3
"""
Shared database-build primitives for Speciedex.

Expected location:
    static/tools/database/common.py

The canonical source of truth remains static/data/taxonomy/. SQLite shards,
MariaDB-compatible logical shards, browser indexes, terminal datasets,
statistics, manifests, checksums, and update streams are all deterministic
derived products generated from the same normalized records.

This module intentionally uses only the Python standard library so repository
builds remain portable across local workstations, GitHub Actions, Termux, and
minimal server environments.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
"""

from __future__ import annotations

import contextlib
import csv
import gzip
import hashlib
import io
import json
import math
import os
import re
import shutil
import sqlite3
import tempfile
import time
import unicodedata
from collections import Counter
from dataclasses import asdict, dataclass, is_dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import (
    Any,
    BinaryIO,
    Callable,
    Iterable,
    Iterator,
    Mapping,
    MutableMapping,
    Sequence,
    TextIO,
    TypeVar,
)


SCHEMA_VERSION = 2
CANONICAL_SCHEMA_VERSION = 1

DEFAULT_MAX_FILE_BYTES = 90 * 1024 * 1024
DEFAULT_TARGET_FILE_BYTES = 72 * 1024 * 1024
DEFAULT_ROWS_PER_SHARD = 100_000
DEFAULT_INSERT_BATCH_SIZE = 500
DEFAULT_HASH_CHUNK_SIZE = 1024 * 1024

SUPPORTED_INPUT_SUFFIXES = {
    ".json",
    ".jsonl",
    ".ndjson",
    ".json.gz",
    ".jsonl.gz",
    ".ndjson.gz",
    ".csv",
    ".csv.gz",
}

TAXONOMIC_RANKS = (
    "domain",
    "kingdom",
    "phylum",
    "class",
    "order",
    "family",
    "genus",
    "species",
    "subspecies",
    "variety",
    "form",
    "unranked",
)

CANONICAL_TAXONOMY_FIELDS = (
    "domain",
    "kingdom",
    "phylum",
    "class_name",
    "order_name",
    "family",
    "genus",
    "species",
)

IDENTIFIER_RE = re.compile(r"[^a-z0-9_]+")
WHITESPACE_RE = re.compile(r"\s+")
SAFE_PROVIDER_RE = re.compile(r"[^a-z0-9._-]+")
ISO_DATETIME_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"
)

T = TypeVar("T")


class DatabaseBuildError(RuntimeError):
    """Base exception for shared database-build failures."""


class InputRecordError(DatabaseBuildError):
    """Raised when an input record cannot be parsed or normalized."""


class ManifestError(DatabaseBuildError):
    """Raised when a manifest is missing or structurally invalid."""


class IntegrityError(DatabaseBuildError):
    """Raised when generated data fails an integrity check."""


def utc_now() -> str:
    """Return a stable RFC3339 UTC timestamp."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00",
        "Z",
    )


def clean_text(value: Any) -> str:
    """Normalize Unicode, trim, and collapse whitespace."""
    if value is None:
        return ""
    return WHITESPACE_RE.sub(
        " ",
        unicodedata.normalize("NFKC", str(value)).strip(),
    )


def clean_key(value: Any) -> str:
    """Convert arbitrary text into a compact lowercase identifier."""
    key = clean_text(value).casefold().replace("-", "_").replace(" ", "_")
    key = IDENTIFIER_RE.sub("", key)
    return re.sub(r"_+", "_", key).strip("_")


def clean_provider(value: Any) -> str:
    provider = clean_text(value).casefold().replace(" ", "-")
    provider = SAFE_PROVIDER_RE.sub("-", provider)
    return re.sub(r"-+", "-", provider).strip("-")


def normalized_lookup_key(value: Any) -> str:
    """Create a Unicode-aware, case-insensitive lookup key."""
    return clean_text(value).casefold()


def stable_json(value: Any, *, pretty: bool = False) -> str:
    """Serialize JSON deterministically."""
    if pretty:
        return json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            indent=2,
        )
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_text(text: str) -> str:
    return sha256_bytes(text.encode("utf-8"))


def hash_file(
    path: Path,
    algorithm: str = "sha256",
    *,
    chunk_size: int = DEFAULT_HASH_CHUNK_SIZE,
) -> str:
    try:
        digest = hashlib.new(algorithm)
    except ValueError as error:
        raise ValueError(f"Unsupported hash algorithm: {algorithm}") from error

    with path.open("rb") as handle:
        while True:
            chunk = handle.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def sha256_file(path: Path, chunk_size: int = DEFAULT_HASH_CHUNK_SIZE) -> str:
    return hash_file(path, "sha256", chunk_size=chunk_size)


def file_metadata(path: Path, *, algorithms: Sequence[str] = ("sha256",)) -> dict[str, Any]:
    metadata: dict[str, Any] = {
        "path": path.as_posix(),
        "bytes": path.stat().st_size,
    }
    for algorithm in algorithms:
        metadata[algorithm] = hash_file(path, algorithm)
    return metadata


def ensure_parent(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def atomic_write_bytes(path: Path, data: bytes) -> None:
    ensure_parent(path)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "wb",
            delete=False,
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
        ) as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
            temporary = Path(handle.name)
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink(missing_ok=True)


def atomic_write_text(path: Path, text: str) -> None:
    ensure_parent(path)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            newline="\n",
            delete=False,
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
        ) as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
            temporary = Path(handle.name)
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink(missing_ok=True)


def atomic_write_json(path: Path, value: Any) -> None:
    atomic_write_text(path, stable_json(value, pretty=True) + "\n")


def atomic_copy(source: Path, destination: Path) -> None:
    ensure_parent(destination)
    temporary = destination.with_name(f".{destination.name}.tmp")
    temporary.unlink(missing_ok=True)
    shutil.copy2(source, temporary)
    os.replace(temporary, destination)


def safe_relative(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return path.resolve().as_posix()


def _compound_suffix(path: Path) -> str:
    name = path.name.casefold()
    for suffix in sorted(SUPPORTED_INPUT_SUFFIXES, key=len, reverse=True):
        if name.endswith(suffix):
            return suffix
    return path.suffix.casefold()


def is_supported_input(path: Path) -> bool:
    return _compound_suffix(path) in SUPPORTED_INPUT_SUFFIXES


def iter_input_files(root: Path) -> Iterator[Path]:
    """
    Yield deterministic supported source files.

    Generated database trees, hidden temporary files, and common cache
    directories are ignored.
    """
    root = root.resolve()

    if root.is_file():
        if is_supported_input(root):
            yield root
        return

    if not root.exists():
        raise FileNotFoundError(root)

    excluded_parts = {
        ".git",
        ".github",
        "__pycache__",
        "node_modules",
        "db",
        "indexes",
        "reports",
    }

    for path in sorted(root.rglob("*"), key=lambda item: item.as_posix()):
        if not path.is_file():
            continue
        relative_parts = set(path.relative_to(root).parts)
        if relative_parts & excluded_parts:
            continue
        if path.name.startswith(".") or path.name.endswith(".tmp"):
            continue
        if is_supported_input(path):
            yield path


@contextlib.contextmanager
def open_text_input(path: Path) -> Iterator[TextIO]:
    if path.name.casefold().endswith(".gz"):
        with gzip.open(path, "rt", encoding="utf-8-sig", newline="") as handle:
            yield handle
    else:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            yield handle


def _records_from_json(value: Any) -> Iterator[Mapping[str, Any]]:
    if isinstance(value, list):
        for item in value:
            if isinstance(item, Mapping):
                yield item
        return

    if isinstance(value, Mapping):
        for key in (
            "records",
            "items",
            "taxa",
            "species",
            "results",
            "data",
            "features",
        ):
            nested = value.get(key)
            if isinstance(nested, list):
                for item in nested:
                    if key == "features" and isinstance(item, Mapping):
                        properties = item.get("properties")
                        if isinstance(properties, Mapping):
                            merged = dict(properties)
                            geometry = item.get("geometry")
                            if isinstance(geometry, Mapping):
                                merged.setdefault("geometry", geometry)
                            yield merged
                        else:
                            yield item
                    elif isinstance(item, Mapping):
                        yield item
                return
        yield value


def iter_records(path: Path) -> Iterator[Mapping[str, Any]]:
    suffix = _compound_suffix(path)

    if suffix in {".json", ".json.gz"}:
        with open_text_input(path) as handle:
            value = json.load(handle)
        yield from _records_from_json(value)
        return

    if suffix in {".csv", ".csv.gz"}:
        with open_text_input(path) as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                yield dict(row)
        return

    with open_text_input(path) as handle:
        for line_number, line in enumerate(handle, 1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                value = json.loads(stripped)
            except json.JSONDecodeError as error:
                raise InputRecordError(
                    f"{path}:{line_number}: invalid JSON: {error}"
                ) from error

            if isinstance(value, Mapping):
                yield value
            elif isinstance(value, list):
                yield from _records_from_json(value)
            else:
                raise InputRecordError(
                    f"{path}:{line_number}: expected object or array"
                )


def first(record: Mapping[str, Any], *keys: str, fallback: Any = "") -> Any:
    for key in keys:
        value = record.get(key)
        if value not in (None, ""):
            return value
    return fallback


def nested_first(record: Mapping[str, Any], paths: Sequence[Sequence[str]], fallback: Any = "") -> Any:
    for path in paths:
        current: Any = record
        found = True
        for key in path:
            if not isinstance(current, Mapping) or key not in current:
                found = False
                break
            current = current[key]
        if found and current not in (None, ""):
            return current
    return fallback


def parse_coordinate(value: Any, *, minimum: float, maximum: float) -> float | None:
    if value in (None, ""):
        return None
    try:
        coordinate = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(coordinate):
        return None
    if coordinate < minimum or coordinate > maximum:
        return None
    return coordinate


def normalize_datetime(value: Any, *, fallback: str | None = None) -> str:
    text = clean_text(value)
    if not text:
        return fallback or utc_now()

    if text.endswith("+00:00"):
        text = text[:-6] + "Z"

    if ISO_DATETIME_RE.match(text):
        return text

    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return text

    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00",
        "Z",
    )


def provider_hint_from_path(path: Path) -> str:
    stem = path.name
    for suffix in sorted(SUPPORTED_INPUT_SUFFIXES, key=len, reverse=True):
        if stem.casefold().endswith(suffix):
            stem = stem[: -len(suffix)]
            break
    return clean_provider(stem)


def derive_speciedex_id(
    *,
    provider: str,
    scientific_name: str,
    rank: str,
    canonical_name: str,
    provider_taxon_id: str = "",
) -> str:
    seed = stable_json(
        {
            "provider": clean_provider(provider),
            "provider_taxon_id": clean_text(provider_taxon_id),
            "scientific_name": clean_text(scientific_name).casefold(),
            "canonical_name": clean_text(canonical_name).casefold(),
            "rank": clean_key(rank) or "unranked",
        }
    )
    return f"spx:{sha256_text(seed)[:24]}"


def canonical_record(
    record: Mapping[str, Any],
    *,
    source_file: str = "",
    provider_hint: str = "",
) -> dict[str, Any]:
    """
    Normalize a provider record into the canonical Speciedex record schema.

    Original provider content is retained in payload_json. record_hash excludes
    volatile payload ordering and itself.
    """
    scientific_name = clean_text(
        first(
            record,
            "scientific_name",
            "scientificName",
            "canonical_name",
            "canonicalName",
            "accepted_name",
            "acceptedName",
            "name",
        )
    )

    canonical_name = clean_text(
        first(
            record,
            "canonical_name",
            "canonicalName",
            fallback=scientific_name,
        )
    ) or scientific_name

    common_name = clean_text(
        first(
            record,
            "common_name",
            "commonName",
            "vernacular_name",
            "vernacularName",
            "preferred_common_name",
            "preferredCommonName",
        )
    )

    rank = clean_key(
        first(
            record,
            "rank",
            "taxon_rank",
            "taxonRank",
            fallback="unranked",
        )
    ) or "unranked"

    provider = clean_provider(
        first(
            record,
            "provider",
            "provider_name",
            "providerName",
            "dataset",
            fallback=provider_hint,
        )
    )

    source = clean_text(
        first(
            record,
            "source",
            "source_name",
            "sourceName",
            fallback=provider,
        )
    )

    status = clean_key(
        first(
            record,
            "status",
            "taxonomic_status",
            "taxonomicStatus",
            "acceptance_status",
            fallback="unknown",
        )
    ) or "unknown"

    provider_taxon_id = clean_text(
        first(
            record,
            "taxon_id",
            "taxonId",
            "key",
            "provider_taxon_id",
            "providerTaxonId",
        )
    )

    taxon_id = clean_text(
        first(
            record,
            "speciedex_id",
            "speciedexId",
        )
    )
    if not taxon_id:
        taxon_id = derive_speciedex_id(
            provider=provider,
            scientific_name=scientific_name,
            rank=rank,
            canonical_name=canonical_name,
            provider_taxon_id=provider_taxon_id,
        )

    geometry_coordinates = nested_first(
        record,
        (("geometry", "coordinates"),),
        fallback=None,
    )

    geometry_longitude = None
    geometry_latitude = None
    if isinstance(geometry_coordinates, Sequence) and not isinstance(
        geometry_coordinates,
        (str, bytes),
    ) and len(geometry_coordinates) >= 2:
        geometry_longitude = geometry_coordinates[0]
        geometry_latitude = geometry_coordinates[1]

    indexed_at = normalize_datetime(
        first(
            record,
            "indexed_at",
            "indexedAt",
            "updated_at",
            "updatedAt",
            "modified",
            "created_at",
            "createdAt",
            fallback=utc_now(),
        )
    )

    normalized: dict[str, Any] = {
        "speciedex_id": taxon_id,
        "provider_taxon_id": provider_taxon_id,
        "scientific_name": scientific_name,
        "canonical_name": canonical_name,
        "common_name": common_name,
        "rank": rank,
        "status": status,
        "provider": provider,
        "source": source,
        "domain": clean_text(first(record, "domain")),
        "kingdom": clean_text(first(record, "kingdom")),
        "phylum": clean_text(first(record, "phylum")),
        "class_name": clean_text(
            first(record, "class", "class_name", "className")
        ),
        "order_name": clean_text(
            first(record, "order", "order_name", "orderName")
        ),
        "family": clean_text(first(record, "family")),
        "genus": clean_text(first(record, "genus")),
        "species": clean_text(
            first(
                record,
                "species",
                fallback=scientific_name if rank == "species" else "",
            )
        ),
        "parent_id": clean_text(
            first(record, "parent_id", "parentId", "parentNameUsageID")
        ),
        "accepted_id": clean_text(
            first(
                record,
                "accepted_id",
                "acceptedId",
                "accepted_taxon_id",
                "acceptedTaxonId",
                "acceptedNameUsageID",
            )
        ),
        "authorship": clean_text(
            first(
                record,
                "authorship",
                "scientific_name_authorship",
                "scientificNameAuthorship",
            )
        ),
        "license": clean_text(first(record, "license", "licence")),
        "country": clean_text(
            first(record, "country", "country_code", "countryCode")
        ),
        "region": clean_text(
            first(record, "region", "stateProvince", "locality")
        ),
        "latitude": parse_coordinate(
            first(
                record,
                "latitude",
                "lat",
                "decimalLatitude",
                fallback=geometry_latitude,
            ),
            minimum=-90.0,
            maximum=90.0,
        ),
        "longitude": parse_coordinate(
            first(
                record,
                "longitude",
                "lon",
                "lng",
                "decimalLongitude",
                fallback=geometry_longitude,
            ),
            minimum=-180.0,
            maximum=180.0,
        ),
        "indexed_at": indexed_at,
        "source_file": clean_text(source_file),
        "payload_json": stable_json(record),
    }

    hash_payload = {
        key: value
        for key, value in normalized.items()
        if key not in {"payload_json", "record_hash"}
    }
    normalized["record_hash"] = sha256_text(stable_json(hash_payload))
    return normalized


def validate_canonical_record(record: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []

    identifier = clean_text(record.get("speciedex_id"))
    if not identifier:
        errors.append("missing speciedex_id")

    if not clean_text(record.get("scientific_name")):
        errors.append("missing scientific_name")

    if not clean_text(record.get("canonical_name")):
        errors.append("missing canonical_name")

    if not clean_text(record.get("rank")):
        errors.append("missing rank")

    latitude = record.get("latitude")
    longitude = record.get("longitude")
    if latitude is not None and not (-90 <= float(latitude) <= 90):
        errors.append("latitude outside -90..90")
    if longitude is not None and not (-180 <= float(longitude) <= 180):
        errors.append("longitude outside -180..180")

    record_hash = clean_text(record.get("record_hash"))
    if record_hash and not re.fullmatch(r"[0-9a-f]{64}", record_hash):
        errors.append("invalid record_hash")

    return errors


def iter_canonical_records(
    taxonomy_root: Path,
    *,
    strict: bool = False,
    deduplicate: bool = False,
) -> Iterator[dict[str, Any]]:
    seen: set[str] = set()

    for path in iter_input_files(taxonomy_root):
        provider_hint = provider_hint_from_path(path)
        relative = (
            path.relative_to(taxonomy_root).as_posix()
            if taxonomy_root.is_dir()
            else path.name
        )

        for raw in iter_records(path):
            record = canonical_record(
                raw,
                source_file=relative,
                provider_hint=provider_hint,
            )
            errors = validate_canonical_record(record)
            if errors:
                if strict:
                    raise InputRecordError(
                        f"{relative}: {'; '.join(errors)}"
                    )
                if "missing scientific_name" in errors:
                    continue

            identifier = record["speciedex_id"]
            if deduplicate:
                if identifier in seen:
                    continue
                seen.add(identifier)

            yield record


SQLITE_COLUMNS = (
    "speciedex_id",
    "provider_taxon_id",
    "scientific_name",
    "canonical_name",
    "common_name",
    "rank",
    "status",
    "provider",
    "source",
    "domain",
    "kingdom",
    "phylum",
    "class_name",
    "order_name",
    "family",
    "genus",
    "species",
    "parent_id",
    "accepted_id",
    "authorship",
    "license",
    "country",
    "region",
    "latitude",
    "longitude",
    "indexed_at",
    "source_file",
    "record_hash",
    "payload_json",
)

SQLITE_SCHEMA = """
PRAGMA journal_mode=DELETE;
PRAGMA synchronous=FULL;
PRAGMA foreign_keys=ON;
PRAGMA temp_store=MEMORY;

CREATE TABLE IF NOT EXISTS taxa (
    speciedex_id TEXT PRIMARY KEY,
    provider_taxon_id TEXT NOT NULL DEFAULT '',
    scientific_name TEXT NOT NULL,
    canonical_name TEXT NOT NULL,
    common_name TEXT NOT NULL DEFAULT '',
    rank TEXT NOT NULL,
    status TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    domain TEXT NOT NULL DEFAULT '',
    kingdom TEXT NOT NULL DEFAULT '',
    phylum TEXT NOT NULL DEFAULT '',
    class_name TEXT NOT NULL DEFAULT '',
    order_name TEXT NOT NULL DEFAULT '',
    family TEXT NOT NULL DEFAULT '',
    genus TEXT NOT NULL DEFAULT '',
    species TEXT NOT NULL DEFAULT '',
    parent_id TEXT NOT NULL DEFAULT '',
    accepted_id TEXT NOT NULL DEFAULT '',
    authorship TEXT NOT NULL DEFAULT '',
    license TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT '',
    region TEXT NOT NULL DEFAULT '',
    latitude REAL,
    longitude REAL,
    indexed_at TEXT NOT NULL,
    source_file TEXT NOT NULL DEFAULT '',
    record_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_taxa_scientific_name
    ON taxa(scientific_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_taxa_canonical_name
    ON taxa(canonical_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_taxa_common_name
    ON taxa(common_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_taxa_rank ON taxa(rank);
CREATE INDEX IF NOT EXISTS idx_taxa_status ON taxa(status);
CREATE INDEX IF NOT EXISTS idx_taxa_provider ON taxa(provider);
CREATE INDEX IF NOT EXISTS idx_taxa_domain ON taxa(domain);
CREATE INDEX IF NOT EXISTS idx_taxa_kingdom ON taxa(kingdom);
CREATE INDEX IF NOT EXISTS idx_taxa_phylum ON taxa(phylum);
CREATE INDEX IF NOT EXISTS idx_taxa_class_name ON taxa(class_name);
CREATE INDEX IF NOT EXISTS idx_taxa_order_name ON taxa(order_name);
CREATE INDEX IF NOT EXISTS idx_taxa_family ON taxa(family);
CREATE INDEX IF NOT EXISTS idx_taxa_genus ON taxa(genus);
CREATE INDEX IF NOT EXISTS idx_taxa_parent_id ON taxa(parent_id);
CREATE INDEX IF NOT EXISTS idx_taxa_accepted_id ON taxa(accepted_id);
CREATE INDEX IF NOT EXISTS idx_taxa_indexed_at ON taxa(indexed_at);
CREATE INDEX IF NOT EXISTS idx_taxa_record_hash ON taxa(record_hash);

CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


MARIADB_SCHEMA = """CREATE TABLE IF NOT EXISTS `taxa` (
    `speciedex_id` VARCHAR(191) NOT NULL,
    `provider_taxon_id` VARCHAR(191) NOT NULL DEFAULT '',
    `scientific_name` TEXT NOT NULL,
    `canonical_name` TEXT NOT NULL,
    `common_name` TEXT NOT NULL,
    `rank` VARCHAR(64) NOT NULL,
    `status` VARCHAR(64) NOT NULL,
    `provider` VARCHAR(191) NOT NULL,
    `source` VARCHAR(191) NOT NULL,
    `domain` VARCHAR(191) NOT NULL,
    `kingdom` VARCHAR(191) NOT NULL,
    `phylum` VARCHAR(191) NOT NULL,
    `class_name` VARCHAR(191) NOT NULL,
    `order_name` VARCHAR(191) NOT NULL,
    `family` VARCHAR(191) NOT NULL,
    `genus` VARCHAR(191) NOT NULL,
    `species` VARCHAR(255) NOT NULL,
    `parent_id` VARCHAR(191) NOT NULL,
    `accepted_id` VARCHAR(191) NOT NULL,
    `authorship` TEXT NOT NULL,
    `license` TEXT NOT NULL,
    `country` VARCHAR(64) NOT NULL,
    `region` VARCHAR(191) NOT NULL,
    `latitude` DOUBLE NULL,
    `longitude` DOUBLE NULL,
    `indexed_at` VARCHAR(64) NOT NULL,
    `source_file` TEXT NOT NULL,
    `record_hash` CHAR(64) NOT NULL,
    `payload_json` LONGTEXT NOT NULL,
    PRIMARY KEY (`speciedex_id`),
    KEY `idx_taxa_scientific_name` (`scientific_name`(191)),
    KEY `idx_taxa_canonical_name` (`canonical_name`(191)),
    KEY `idx_taxa_common_name` (`common_name`(191)),
    KEY `idx_taxa_rank` (`rank`),
    KEY `idx_taxa_status` (`status`),
    KEY `idx_taxa_provider` (`provider`),
    KEY `idx_taxa_family` (`family`),
    KEY `idx_taxa_genus` (`genus`),
    KEY `idx_taxa_parent_id` (`parent_id`),
    KEY `idx_taxa_accepted_id` (`accepted_id`),
    KEY `idx_taxa_indexed_at` (`indexed_at`),
    KEY `idx_taxa_record_hash` (`record_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"""


@dataclass(frozen=True)
class ShardInfo(Mapping[str, Any]):
    """
    Metadata for a generated database shard.

    Implements Mapping so both legacy code (`shard.records`) and newer builders
    (`shard.get("records")`) remain compatible.
    """

    id: str
    path: str
    records: int
    bytes: int
    sha256: str
    first_id: str
    last_id: str
    first_indexed_at: str
    last_indexed_at: str
    providers: list[str]
    ranks: list[str]

    @property
    def shard_id(self) -> str:
        return self.id

    @property
    def filename(self) -> str:
        return self.path

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["shard_id"] = self.id
        value["filename"] = self.path
        return value

    def __getitem__(self, key: str) -> Any:
        aliases = {
            "shard_id": "id",
            "filename": "path",
            "rows": "records",
        }
        attribute = aliases.get(key, key)
        if not hasattr(self, attribute):
            raise KeyError(key)
        return getattr(self, attribute)

    def __iter__(self) -> Iterator[str]:
        return iter(self.to_dict())

    def __len__(self) -> int:
        return len(self.to_dict())

    def get(self, key: str, default: Any = None) -> Any:
        try:
            return self[key]
        except KeyError:
            return default


def record_tuple(record: Mapping[str, Any]) -> tuple[Any, ...]:
    return tuple(record.get(column) for column in SQLITE_COLUMNS)


def shard_info_from_records(
    records: Sequence[Mapping[str, Any]],
    destination: Path,
    shard_id: str,
) -> ShardInfo:
    providers = sorted(
        {
            clean_text(record.get("provider"))
            for record in records
            if clean_text(record.get("provider"))
        }
    )
    ranks = sorted(
        {
            clean_text(record.get("rank"))
            for record in records
            if clean_text(record.get("rank"))
        }
    )
    indexed = sorted(
        clean_text(record.get("indexed_at"))
        for record in records
        if clean_text(record.get("indexed_at"))
    )
    identifiers = [
        clean_text(record.get("speciedex_id"))
        for record in records
    ]

    return ShardInfo(
        id=shard_id,
        path=destination.name,
        records=len(records),
        bytes=destination.stat().st_size,
        sha256=sha256_file(destination),
        first_id=identifiers[0] if identifiers else "",
        last_id=identifiers[-1] if identifiers else "",
        first_indexed_at=indexed[0] if indexed else "",
        last_indexed_at=indexed[-1] if indexed else "",
        providers=providers,
        ranks=ranks,
    )


def build_sqlite_shard(
    records: Sequence[Mapping[str, Any]],
    destination: Path,
    *,
    shard_id: str,
    analyze: bool = True,
    vacuum: bool = True,
) -> ShardInfo:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.tmp")
    temporary.unlink(missing_ok=True)

    connection = sqlite3.connect(temporary)
    try:
        connection.executescript(SQLITE_SCHEMA)
        placeholders = ",".join("?" for _ in SQLITE_COLUMNS)
        columns = ",".join(f'"{column}"' for column in SQLITE_COLUMNS)

        connection.executemany(
            f"INSERT OR REPLACE INTO taxa ({columns}) VALUES ({placeholders})",
            (record_tuple(record) for record in records),
        )

        metadata = {
            "schema_version": str(SCHEMA_VERSION),
            "canonical_schema_version": str(CANONICAL_SCHEMA_VERSION),
            "shard_id": shard_id,
            "built_at": utc_now(),
            "records": str(len(records)),
        }
        connection.executemany(
            "INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)",
            metadata.items(),
        )
        connection.commit()

        if analyze:
            connection.execute("ANALYZE")
            connection.commit()

        if vacuum:
            connection.execute("VACUUM")
            connection.commit()

        integrity = connection.execute("PRAGMA integrity_check").fetchone()
        if not integrity or clean_text(integrity[0]).casefold() != "ok":
            raise IntegrityError(
                f"SQLite integrity check failed for shard {shard_id}: {integrity}"
            )
    except Exception:
        connection.close()
        temporary.unlink(missing_ok=True)
        raise
    finally:
        with contextlib.suppress(Exception):
            connection.close()

    os.replace(temporary, destination)
    return shard_info_from_records(records, destination, shard_id)


def sql_quote(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            return "NULL"
        return repr(value)
    text = str(value).replace("\\", "\\\\").replace("'", "''")
    return "'" + text + "'"


def build_mariadb_shard(
    records: Sequence[Mapping[str, Any]],
    destination: Path,
    *,
    shard_id: str,
    insert_batch_size: int = DEFAULT_INSERT_BATCH_SIZE,
) -> ShardInfo:
    if insert_batch_size < 1:
        raise ValueError("insert_batch_size must be at least 1")

    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.tmp")
    temporary.unlink(missing_ok=True)

    columns = ",".join(f"`{column}`" for column in SQLITE_COLUMNS)
    opener: Callable[..., TextIO]

    if destination.name.casefold().endswith(".gz"):
        opener = gzip.open
    else:
        opener = open  # type: ignore[assignment]

    try:
        with opener(
            temporary,
            "wt",
            encoding="utf-8",
            newline="\n",
        ) as handle:
            handle.write("-- Speciedex MariaDB logical shard\n")
            handle.write(f"-- schema_version: {SCHEMA_VERSION}\n")
            handle.write(f"-- shard_id: {shard_id}\n")
            handle.write(f"-- built_at: {utc_now()}\n")
            handle.write("SET NAMES utf8mb4;\n")
            handle.write("SET FOREIGN_KEY_CHECKS=0;\n")
            handle.write("START TRANSACTION;\n")

            for start in range(0, len(records), insert_batch_size):
                batch = records[start : start + insert_batch_size]
                handle.write(f"INSERT INTO `taxa` ({columns}) VALUES\n")
                rows = []
                for record in batch:
                    row = ",".join(
                        sql_quote(record.get(column))
                        for column in SQLITE_COLUMNS
                    )
                    rows.append(f"({row})")
                handle.write(",\n".join(rows))
                handle.write("\nON DUPLICATE KEY UPDATE ")
                handle.write(
                    ",".join(
                        f"`{column}`=VALUES(`{column}`)"
                        for column in SQLITE_COLUMNS
                        if column != "speciedex_id"
                    )
                )
                handle.write(";\n")

            handle.write("COMMIT;\n")
            handle.write("SET FOREIGN_KEY_CHECKS=1;\n")
    except Exception:
        temporary.unlink(missing_ok=True)
        raise

    os.replace(temporary, destination)
    return shard_info_from_records(records, destination, shard_id)


def estimate_record_bytes(record: Mapping[str, Any]) -> int:
    return len(stable_json(record).encode("utf-8")) + 256


def chunk_records(
    records: Iterable[Mapping[str, Any]],
    *,
    rows_per_shard: int = DEFAULT_ROWS_PER_SHARD,
    target_bytes: int = DEFAULT_TARGET_FILE_BYTES,
) -> Iterator[list[Mapping[str, Any]]]:
    if rows_per_shard < 1:
        raise ValueError("rows_per_shard must be at least 1")
    if target_bytes < 1:
        raise ValueError("target_bytes must be at least 1")

    chunk: list[Mapping[str, Any]] = []
    estimated = 0

    for record in records:
        size = estimate_record_bytes(record)

        if chunk and (
            len(chunk) >= rows_per_shard
            or estimated + size > target_bytes
        ):
            yield chunk
            chunk = []
            estimated = 0

        chunk.append(record)
        estimated += size

    if chunk:
        yield chunk


def coerce_shard_mapping(shard: Any) -> dict[str, Any]:
    if isinstance(shard, ShardInfo):
        return shard.to_dict()
    if is_dataclass(shard):
        return asdict(shard)
    if isinstance(shard, Mapping):
        return dict(shard)
    raise TypeError(f"Unsupported shard metadata type: {type(shard).__name__}")


def write_manifest(
    path: Path,
    *,
    kind: str,
    shards: Sequence[Any],
    source: str,
    extra: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    normalized_shards = [coerce_shard_mapping(shard) for shard in shards]

    for shard in normalized_shards:
        if "id" not in shard and "shard_id" in shard:
            shard["id"] = shard["shard_id"]
        if "path" not in shard and "filename" in shard:
            shard["path"] = shard["filename"]
        if "shard_id" not in shard and "id" in shard:
            shard["shard_id"] = shard["id"]
        if "filename" not in shard and "path" in shard:
            shard["filename"] = shard["path"]

    manifest: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "kind": clean_text(kind),
        "generated_at": utc_now(),
        "source": clean_text(source),
        "shards": normalized_shards,
        "totals": {
            "shards": len(normalized_shards),
            "records": sum(
                int(shard.get("records", shard.get("rows", 0)) or 0)
                for shard in normalized_shards
            ),
            "bytes": sum(
                int(shard.get("bytes", 0) or 0)
                for shard in normalized_shards
            ),
        },
    }

    if extra:
        manifest.update(dict(extra))

    atomic_write_json(path, manifest)
    return manifest


def load_manifest(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ManifestError(f"Manifest not found: {path}") from error
    except json.JSONDecodeError as error:
        raise ManifestError(f"Invalid manifest JSON at {path}: {error}") from error

    if not isinstance(value, dict):
        raise ManifestError(f"{path}: manifest must be an object")

    return value


def validate_manifest(value: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []
    if "schema_version" not in value:
        errors.append("missing schema_version")
    if "generated_at" not in value:
        errors.append("missing generated_at")
    if "totals" in value and not isinstance(value["totals"], Mapping):
        errors.append("totals must be an object")
    if "shards" in value and not isinstance(value["shards"], list):
        errors.append("shards must be an array")
    return errors


def sqlite_rows(
    path: Path,
    *,
    where: str = "",
    parameters: Sequence[Any] = (),
) -> Iterator[dict[str, Any]]:
    uri = f"file:{path.resolve()}?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    connection.row_factory = sqlite3.Row
    try:
        query = "SELECT * FROM taxa"
        if where:
            query += f" WHERE {where}"
        query += " ORDER BY speciedex_id"
        for row in connection.execute(query, tuple(parameters)):
            yield dict(row)
    finally:
        connection.close()


def sqlite_integrity(path: Path, *, quick: bool = False) -> str:
    pragma = "quick_check" if quick else "integrity_check"
    uri = f"file:{path.resolve()}?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    try:
        row = connection.execute(f"PRAGMA {pragma}").fetchone()
    finally:
        connection.close()
    result = clean_text(row[0] if row else "")
    if result.casefold() != "ok":
        raise IntegrityError(f"{path}: SQLite {pragma} failed: {result}")
    return result


def write_jsonl(
    path: Path,
    records: Iterable[Mapping[str, Any]],
    *,
    gzip_output: bool = False,
) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.unlink(missing_ok=True)

    use_gzip = gzip_output or path.name.casefold().endswith(".gz")
    opener: Callable[..., TextIO] = gzip.open if use_gzip else open  # type: ignore[assignment]
    count = 0

    try:
        with opener(
            temporary,
            "wt",
            encoding="utf-8",
            newline="\n",
        ) as handle:
            for record in records:
                handle.write(stable_json(record))
                handle.write("\n")
                count += 1
        os.replace(temporary, path)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise

    return count


def load_provider_names(records: Iterable[Mapping[str, Any]]) -> list[str]:
    return sorted(
        {
            clean_provider(record.get("provider"))
            for record in records
            if clean_provider(record.get("provider"))
        }
    )


def record_statistics(records: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    total = 0
    providers: Counter[str] = Counter()
    ranks: Counter[str] = Counter()
    statuses: Counter[str] = Counter()
    kingdoms: Counter[str] = Counter()

    for record in records:
        total += 1
        providers[clean_provider(record.get("provider")) or "unknown"] += 1
        ranks[clean_key(record.get("rank")) or "unranked"] += 1
        statuses[clean_key(record.get("status")) or "unknown"] += 1
        kingdoms[clean_text(record.get("kingdom")) or "unknown"] += 1

    return {
        "records": total,
        "providers": dict(sorted(providers.items())),
        "ranks": dict(sorted(ranks.items())),
        "statuses": dict(sorted(statuses.items())),
        "kingdoms": dict(sorted(kingdoms.items())),
    }


def remove_generated_files(
    directory: Path,
    patterns: Sequence[str],
    *,
    remove_empty_directories: bool = False,
) -> None:
    directory.mkdir(parents=True, exist_ok=True)

    candidates: set[Path] = set()
    for pattern in patterns:
        candidates.update(directory.glob(pattern))

    for path in sorted(candidates, key=lambda item: len(item.parts), reverse=True):
        if path.is_file() or path.is_symlink():
            path.unlink(missing_ok=True)
        elif path.is_dir() and remove_empty_directories:
            with contextlib.suppress(OSError):
                path.rmdir()


def check_max_file_size(
    paths: Iterable[Path],
    maximum: int,
) -> list[dict[str, Any]]:
    if maximum < 0:
        raise ValueError("maximum cannot be negative")

    violations: list[dict[str, Any]] = []
    for path in sorted(paths, key=lambda item: item.as_posix()):
        if not path.is_file():
            continue
        size = path.stat().st_size
        if size > maximum:
            violations.append(
                {
                    "path": path.as_posix(),
                    "bytes": size,
                    "maximum": maximum,
                    "excess": size - maximum,
                }
            )
    return violations


def verify_checksum_manifest(
    root: Path,
    checksums: Mapping[str, Mapping[str, Any]],
) -> list[dict[str, Any]]:
    failures: list[dict[str, Any]] = []

    for relative, expected in sorted(checksums.items()):
        path = root / relative
        if not path.is_file():
            failures.append(
                {
                    "path": relative,
                    "error": "missing",
                }
            )
            continue

        expected_sha256 = clean_text(expected.get("sha256"))
        if expected_sha256:
            actual = sha256_file(path)
            if actual != expected_sha256:
                failures.append(
                    {
                        "path": relative,
                        "error": "sha256-mismatch",
                        "expected": expected_sha256,
                        "actual": actual,
                    }
                )

        expected_bytes = expected.get("bytes")
        if isinstance(expected_bytes, int):
            actual_bytes = path.stat().st_size
            if actual_bytes != expected_bytes:
                failures.append(
                    {
                        "path": relative,
                        "error": "size-mismatch",
                        "expected": expected_bytes,
                        "actual": actual_bytes,
                    }
                )

    return failures


__all__ = [
    "CANONICAL_SCHEMA_VERSION",
    "CANONICAL_TAXONOMY_FIELDS",
    "DEFAULT_HASH_CHUNK_SIZE",
    "DEFAULT_INSERT_BATCH_SIZE",
    "DEFAULT_MAX_FILE_BYTES",
    "DEFAULT_ROWS_PER_SHARD",
    "DEFAULT_TARGET_FILE_BYTES",
    "DatabaseBuildError",
    "InputRecordError",
    "IntegrityError",
    "MARIADB_SCHEMA",
    "ManifestError",
    "SCHEMA_VERSION",
    "SQLITE_COLUMNS",
    "SQLITE_SCHEMA",
    "SUPPORTED_INPUT_SUFFIXES",
    "ShardInfo",
    "TAXONOMIC_RANKS",
    "atomic_copy",
    "atomic_write_bytes",
    "atomic_write_json",
    "atomic_write_text",
    "build_mariadb_shard",
    "build_sqlite_shard",
    "canonical_record",
    "check_max_file_size",
    "chunk_records",
    "clean_key",
    "clean_provider",
    "clean_text",
    "coerce_shard_mapping",
    "derive_speciedex_id",
    "estimate_record_bytes",
    "file_metadata",
    "first",
    "hash_file",
    "is_supported_input",
    "iter_canonical_records",
    "iter_input_files",
    "iter_records",
    "load_manifest",
    "load_provider_names",
    "nested_first",
    "normalize_datetime",
    "normalized_lookup_key",
    "open_text_input",
    "parse_coordinate",
    "provider_hint_from_path",
    "record_statistics",
    "record_tuple",
    "remove_generated_files",
    "safe_relative",
    "sha256_bytes",
    "sha256_file",
    "sha256_text",
    "shard_info_from_records",
    "sql_quote",
    "sqlite_integrity",
    "sqlite_rows",
    "stable_json",
    "utc_now",
    "validate_canonical_record",
    "validate_manifest",
    "verify_checksum_manifest",
    "write_jsonl",
    "write_manifest",
]
