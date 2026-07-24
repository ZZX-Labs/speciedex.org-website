#!/usr/bin/env python3
"""
Shared database-build primitives for Speciedex.

The canonical source of truth remains static/data/taxonomy/. SQLite shards,
MariaDB-compatible logical shards, indexes, manifests, checksums, and update
streams are all derived products generated from the same normalized records.
"""

from __future__ import annotations

import csv
import gzip
import hashlib
import json
import os
import re
import shutil
import sqlite3
import tempfile
import unicodedata
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Sequence

SCHEMA_VERSION = 1
DEFAULT_MAX_FILE_BYTES = 90 * 1024 * 1024
DEFAULT_TARGET_FILE_BYTES = 72 * 1024 * 1024
DEFAULT_ROWS_PER_SHARD = 100_000
SUPPORTED_INPUT_SUFFIXES = {".json", ".jsonl", ".ndjson"}
IDENTIFIER_RE = re.compile(r"[^a-z0-9_]+")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def clean_text(value: Any) -> str:
    return re.sub(
        r"\s+",
        " ",
        unicodedata.normalize("NFKC", str(value or "")).strip(),
    )


def clean_key(value: Any) -> str:
    key = clean_text(value).lower().replace("-", "_").replace(" ", "_")
    return IDENTIFIER_RE.sub("", key)


def stable_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        newline="\n",
        delete=False,
        dir=path.parent,
        prefix=f".{path.name}.",
    ) as handle:
        handle.write(text)
        temp = Path(handle.name)
    os.replace(temp, path)


def atomic_write_json(path: Path, value: Any) -> None:
    atomic_write_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def iter_input_files(root: Path) -> Iterator[Path]:
    if root.is_file():
        if root.suffix.lower() in SUPPORTED_INPUT_SUFFIXES:
            yield root
        return
    for path in sorted(root.rglob("*")):
        if (
            path.is_file()
            and path.suffix.lower() in SUPPORTED_INPUT_SUFFIXES
            and "/db/" not in path.as_posix()
        ):
            yield path


def _records_from_json(value: Any) -> Iterator[Mapping[str, Any]]:
    if isinstance(value, list):
        for item in value:
            if isinstance(item, Mapping):
                yield item
        return
    if isinstance(value, Mapping):
        for key in ("records", "items", "taxa", "species", "results", "data"):
            nested = value.get(key)
            if isinstance(nested, list):
                yield from _records_from_json(nested)
                return
        yield value


def iter_records(path: Path) -> Iterator[Mapping[str, Any]]:
    suffix = path.suffix.lower()
    if suffix == ".json":
        with path.open("r", encoding="utf-8") as handle:
            yield from _records_from_json(json.load(handle))
        return
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            stripped = line.strip()
            if not stripped:
                continue
            value = json.loads(stripped)
            if isinstance(value, Mapping):
                yield value
            elif isinstance(value, list):
                yield from _records_from_json(value)
            else:
                raise TypeError(f"{path}:{line_number}: expected object or array")


def first(record: Mapping[str, Any], *keys: str, fallback: Any = "") -> Any:
    for key in keys:
        value = record.get(key)
        if value not in (None, ""):
            return value
    return fallback


def canonical_record(
    record: Mapping[str, Any],
    *,
    source_file: str = "",
    provider_hint: str = "",
) -> dict[str, Any]:
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
        first(record, "canonical_name", "canonicalName", fallback=scientific_name)
    )
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
    rank = clean_key(first(record, "rank", "taxon_rank", "taxonRank", fallback="unranked")) or "unranked"
    provider = clean_text(
        first(
            record,
            "provider",
            "provider_name",
            "providerName",
            "source",
            "dataset",
            fallback=provider_hint,
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
    taxon_id = clean_text(
        first(
            record,
            "speciedex_id",
            "speciedexId",
            "taxon_id",
            "taxonId",
            "id",
            "key",
        )
    )
    if not taxon_id:
        seed = "|".join((provider, scientific_name, rank, canonical_name))
        taxon_id = f"spx:{hashlib.sha256(seed.encode('utf-8')).hexdigest()[:24]}"

    indexed_at = clean_text(
        first(
            record,
            "indexed_at",
            "indexedAt",
            "updated_at",
            "updatedAt",
            "created_at",
            "createdAt",
            fallback=utc_now(),
        )
    )

    normalized = {
        "speciedex_id": taxon_id,
        "scientific_name": scientific_name,
        "canonical_name": canonical_name or scientific_name,
        "common_name": common_name,
        "rank": rank,
        "status": status,
        "provider": provider,
        "source": clean_text(first(record, "source", "source_name", "sourceName", fallback=provider)),
        "domain": clean_text(first(record, "domain")),
        "kingdom": clean_text(first(record, "kingdom")),
        "phylum": clean_text(first(record, "phylum")),
        "class_name": clean_text(first(record, "class", "class_name", "className")),
        "order_name": clean_text(first(record, "order", "order_name", "orderName")),
        "family": clean_text(first(record, "family")),
        "genus": clean_text(first(record, "genus")),
        "species": clean_text(first(record, "species", fallback=scientific_name if rank == "species" else "")),
        "parent_id": clean_text(first(record, "parent_id", "parentId")),
        "accepted_id": clean_text(first(record, "accepted_id", "acceptedId", "accepted_taxon_id", "acceptedTaxonId")),
        "authorship": clean_text(first(record, "authorship", "scientific_name_authorship", "scientificNameAuthorship")),
        "license": clean_text(first(record, "license", "licence")),
        "country": clean_text(first(record, "country", "country_code", "countryCode")),
        "region": clean_text(first(record, "region")),
        "latitude": first(record, "latitude", "lat", fallback=None),
        "longitude": first(record, "longitude", "lon", "lng", fallback=None),
        "indexed_at": indexed_at,
        "source_file": source_file,
        "payload_json": stable_json(record),
    }
    for coordinate in ("latitude", "longitude"):
        try:
            normalized[coordinate] = (
                float(normalized[coordinate])
                if normalized[coordinate] not in (None, "")
                else None
            )
        except (TypeError, ValueError):
            normalized[coordinate] = None

    normalized["record_hash"] = sha256_bytes(
        stable_json(
            {
                key: value
                for key, value in normalized.items()
                if key not in {"payload_json", "record_hash"}
            }
        ).encode("utf-8")
    )
    return normalized


def iter_canonical_records(taxonomy_root: Path) -> Iterator[dict[str, Any]]:
    for path in iter_input_files(taxonomy_root):
        provider_hint = path.stem.replace("_", " ").replace("-", " ")
        relative = path.relative_to(taxonomy_root).as_posix() if taxonomy_root.is_dir() else path.name
        for record in iter_records(path):
            yield canonical_record(
                record,
                source_file=relative,
                provider_hint=provider_hint,
            )


SQLITE_COLUMNS = (
    "speciedex_id",
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
CREATE TABLE IF NOT EXISTS taxa (
    speciedex_id TEXT PRIMARY KEY,
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
CREATE INDEX IF NOT EXISTS idx_taxa_scientific_name ON taxa(scientific_name);
CREATE INDEX IF NOT EXISTS idx_taxa_canonical_name ON taxa(canonical_name);
CREATE INDEX IF NOT EXISTS idx_taxa_common_name ON taxa(common_name);
CREATE INDEX IF NOT EXISTS idx_taxa_rank ON taxa(rank);
CREATE INDEX IF NOT EXISTS idx_taxa_provider ON taxa(provider);
CREATE INDEX IF NOT EXISTS idx_taxa_family ON taxa(family);
CREATE INDEX IF NOT EXISTS idx_taxa_genus ON taxa(genus);
CREATE INDEX IF NOT EXISTS idx_taxa_indexed_at ON taxa(indexed_at);
CREATE INDEX IF NOT EXISTS idx_taxa_record_hash ON taxa(record_hash);
CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


@dataclass
class ShardInfo:
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


def record_tuple(record: Mapping[str, Any]) -> tuple[Any, ...]:
    return tuple(record.get(column) for column in SQLITE_COLUMNS)


def build_sqlite_shard(
    records: Sequence[Mapping[str, Any]],
    destination: Path,
    *,
    shard_id: str,
) -> ShardInfo:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp = destination.with_name(f".{destination.name}.tmp")
    if temp.exists():
        temp.unlink()
    connection = sqlite3.connect(temp)
    try:
        connection.executescript(SQLITE_SCHEMA)
        placeholders = ",".join("?" for _ in SQLITE_COLUMNS)
        columns = ",".join(SQLITE_COLUMNS)
        connection.executemany(
            f"INSERT OR REPLACE INTO taxa ({columns}) VALUES ({placeholders})",
            (record_tuple(record) for record in records),
        )
        metadata = {
            "schema_version": str(SCHEMA_VERSION),
            "shard_id": shard_id,
            "built_at": utc_now(),
            "records": str(len(records)),
        }
        connection.executemany(
            "INSERT OR REPLACE INTO metadata(key, value) VALUES (?, ?)",
            metadata.items(),
        )
        connection.commit()
        connection.execute("VACUUM")
        connection.commit()
    finally:
        connection.close()
    os.replace(temp, destination)
    stat = destination.stat()
    providers = sorted({clean_text(record.get("provider")) for record in records if clean_text(record.get("provider"))})
    ranks = sorted({clean_text(record.get("rank")) for record in records if clean_text(record.get("rank"))})
    indexed = sorted(clean_text(record.get("indexed_at")) for record in records if clean_text(record.get("indexed_at")))
    ids = [clean_text(record.get("speciedex_id")) for record in records]
    return ShardInfo(
        id=shard_id,
        path=destination.name,
        records=len(records),
        bytes=stat.st_size,
        sha256=sha256_file(destination),
        first_id=ids[0] if ids else "",
        last_id=ids[-1] if ids else "",
        first_indexed_at=indexed[0] if indexed else "",
        last_indexed_at=indexed[-1] if indexed else "",
        providers=providers,
        ranks=ranks,
    )


def sql_quote(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    return "'" + str(value).replace("\\", "\\\\").replace("'", "''") + "'"


MARIADB_SCHEMA = """CREATE TABLE IF NOT EXISTS taxa (
    speciedex_id VARCHAR(191) PRIMARY KEY,
    scientific_name TEXT NOT NULL,
    canonical_name TEXT NOT NULL,
    common_name TEXT NOT NULL,
    rank VARCHAR(64) NOT NULL,
    status VARCHAR(64) NOT NULL,
    provider VARCHAR(191) NOT NULL,
    source VARCHAR(191) NOT NULL,
    domain VARCHAR(191) NOT NULL,
    kingdom VARCHAR(191) NOT NULL,
    phylum VARCHAR(191) NOT NULL,
    class_name VARCHAR(191) NOT NULL,
    order_name VARCHAR(191) NOT NULL,
    family VARCHAR(191) NOT NULL,
    genus VARCHAR(191) NOT NULL,
    species VARCHAR(255) NOT NULL,
    parent_id VARCHAR(191) NOT NULL,
    accepted_id VARCHAR(191) NOT NULL,
    authorship TEXT NOT NULL,
    license TEXT NOT NULL,
    country VARCHAR(64) NOT NULL,
    region VARCHAR(191) NOT NULL,
    latitude DOUBLE NULL,
    longitude DOUBLE NULL,
    indexed_at VARCHAR(64) NOT NULL,
    source_file TEXT NOT NULL,
    record_hash CHAR(64) NOT NULL,
    payload_json LONGTEXT NOT NULL,
    INDEX idx_taxa_scientific_name (scientific_name(191)),
    INDEX idx_taxa_canonical_name (canonical_name(191)),
    INDEX idx_taxa_common_name (common_name(191)),
    INDEX idx_taxa_rank (rank),
    INDEX idx_taxa_provider (provider),
    INDEX idx_taxa_family (family),
    INDEX idx_taxa_genus (genus),
    INDEX idx_taxa_indexed_at (indexed_at),
    INDEX idx_taxa_record_hash (record_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
"""


def build_mariadb_shard(
    records: Sequence[Mapping[str, Any]],
    destination: Path,
    *,
    shard_id: str,
    insert_batch_size: int = 500,
) -> ShardInfo:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp = destination.with_name(f".{destination.name}.tmp")
    columns = ",".join(f"`{column}`" for column in SQLITE_COLUMNS)
    opener = gzip.open if destination.suffix == ".gz" else open
    mode = "wt"
    with opener(temp, mode, encoding="utf-8", newline="\n") as handle:
        handle.write("-- Speciedex MariaDB logical shard\n")
        handle.write(f"-- shard_id: {shard_id}\n")
        handle.write(f"-- built_at: {utc_now()}\n")
        handle.write("SET NAMES utf8mb4;\n")
        handle.write("START TRANSACTION;\n")
        for start in range(0, len(records), insert_batch_size):
            batch = records[start : start + insert_batch_size]
            handle.write(f"INSERT INTO `taxa` ({columns}) VALUES\n")
            rows = []
            for record in batch:
                rows.append(
                    "(" + ",".join(sql_quote(record.get(column)) for column in SQLITE_COLUMNS) + ")"
                )
            handle.write(",\n".join(rows))
            handle.write("\nON DUPLICATE KEY UPDATE ")
            handle.write(",".join(
                f"`{column}`=VALUES(`{column}`)"
                for column in SQLITE_COLUMNS
                if column != "speciedex_id"
            ))
            handle.write(";\n")
        handle.write("COMMIT;\n")
    os.replace(temp, destination)
    stat = destination.stat()
    providers = sorted({clean_text(record.get("provider")) for record in records if clean_text(record.get("provider"))})
    ranks = sorted({clean_text(record.get("rank")) for record in records if clean_text(record.get("rank"))})
    indexed = sorted(clean_text(record.get("indexed_at")) for record in records if clean_text(record.get("indexed_at")))
    ids = [clean_text(record.get("speciedex_id")) for record in records]
    return ShardInfo(
        id=shard_id,
        path=destination.name,
        records=len(records),
        bytes=stat.st_size,
        sha256=sha256_file(destination),
        first_id=ids[0] if ids else "",
        last_id=ids[-1] if ids else "",
        first_indexed_at=indexed[0] if indexed else "",
        last_indexed_at=indexed[-1] if indexed else "",
        providers=providers,
        ranks=ranks,
    )


def chunk_records(
    records: Iterable[Mapping[str, Any]],
    *,
    rows_per_shard: int = DEFAULT_ROWS_PER_SHARD,
    target_bytes: int = DEFAULT_TARGET_FILE_BYTES,
) -> Iterator[list[Mapping[str, Any]]]:
    chunk: list[Mapping[str, Any]] = []
    estimated = 0
    for record in records:
        size = len(stable_json(record).encode("utf-8")) + 256
        if chunk and (len(chunk) >= rows_per_shard or estimated + size > target_bytes):
            yield chunk
            chunk = []
            estimated = 0
        chunk.append(record)
        estimated += size
    if chunk:
        yield chunk


def write_manifest(
    path: Path,
    *,
    kind: str,
    shards: Sequence[ShardInfo],
    source: str,
    extra: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "kind": kind,
        "generated_at": utc_now(),
        "source": source,
        "shards": [asdict(shard) for shard in shards],
        "totals": {
            "shards": len(shards),
            "records": sum(shard.records for shard in shards),
            "bytes": sum(shard.bytes for shard in shards),
        },
    }
    if extra:
        manifest.update(extra)
    atomic_write_json(path, manifest)
    return manifest


def load_manifest(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise TypeError(f"{path}: manifest must be an object")
    return value


def sqlite_rows(path: Path) -> Iterator[dict[str, Any]]:
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    try:
        for row in connection.execute(
            "SELECT * FROM taxa ORDER BY speciedex_id"
        ):
            yield dict(row)
    finally:
        connection.close()


def write_jsonl(path: Path, records: Iterable[Mapping[str, Any]], *, gzip_output: bool = False) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    opener = gzip.open if gzip_output or path.suffix == ".gz" else open
    count = 0
    with opener(path, "wt", encoding="utf-8", newline="\n") as handle:
        for record in records:
            handle.write(stable_json(record))
            handle.write("\n")
            count += 1
    return count


def load_provider_names(records: Iterable[Mapping[str, Any]]) -> list[str]:
    return sorted(
        {
            clean_text(record.get("provider"))
            for record in records
            if clean_text(record.get("provider"))
        }
    )


def remove_generated_files(directory: Path, patterns: Sequence[str]) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    for pattern in patterns:
        for path in directory.glob(pattern):
            if path.is_file():
                path.unlink()


def check_max_file_size(paths: Iterable[Path], maximum: int) -> list[dict[str, Any]]:
    violations = []
    for path in paths:
        size = path.stat().st_size
        if size > maximum:
            violations.append(
                {
                    "path": path.as_posix(),
                    "bytes": size,
                    "maximum": maximum,
                }
            )
    return violations
