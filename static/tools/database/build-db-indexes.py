#!/usr/bin/env python3
"""
Build browser-facing Speciedex database indexes.

Expected location:
    static/tools/database/build-db-indexes.py

The index builder reads canonical Speciedex taxonomy archive records and
generates compact, deterministic JSON indexes for browser and static-site use.

Generated files:

    species.json
    names.json
    providers.json
    taxonomy.json
    shards.json
    manifest.json

Optional sharding may also generate:

    shards/species-00000.json
    shards/species-00001.json
    ...

Canonical archive discovery is conservative by default. The builder reads
manifest-declared taxonomy volumes first, then files directly beneath
static/data/taxonomy/volumes/. Recursive taxonomy-tree scanning is available
only through --source-mode recursive for legacy repositories.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import shutil
import tempfile
import time
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Sequence


SCHEMA_VERSION = 3
DEFAULT_SHARD_SIZE = 25_000
DEFAULT_MINIMUM_FREE_BYTES = 64 * 1024 * 1024
MANIFEST_FILENAME = "manifest.json"
SOURCE_MODES = ("auto", "manifest", "volumes", "recursive")
GENERATED_INDEX_FILES = (
    "species.json",
    "names.json",
    "providers.json",
    "taxonomy.json",
    "shards.json",
    "manifest.json",
)
TAXONOMY_RANKS = (
    "domain",
    "kingdom",
    "phylum",
    "class_name",
    "order_name",
    "family",
    "genus",
)


def _common() -> dict[str, Any]:
    try:
        from common import (
            atomic_write_json,
            canonical_record,
            is_supported_input,
            iter_canonical_records,
            iter_records,
            provider_hint_from_path,
            stable_json,
            utc_now,
            validate_canonical_record,
        )
    except ModuleNotFoundError as error:
        raise RuntimeError(
            "Unable to import static/tools/database/common.py. Keep this file "
            "beside common.py and run it from the Speciedex repository."
        ) from error

    return {
        "atomic_write_json": atomic_write_json,
        "canonical_record": canonical_record,
        "is_supported_input": is_supported_input,
        "iter_canonical_records": iter_canonical_records,
        "iter_records": iter_records,
        "provider_hint_from_path": provider_hint_from_path,
        "stable_json": stable_json,
        "utc_now": utc_now,
        "validate_canonical_record": validate_canonical_record,
    }


def utc_now() -> str:
    return _common()["utc_now"]()


def clean_text(value: Any) -> str:
    return str(value or "").strip()


def normalized_key(value: Any) -> str:
    return " ".join(clean_text(value).casefold().split())


def unique_sorted(values: Iterable[str]) -> list[str]:
    return sorted(set(values))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def json_size(path: Path) -> int:
    return path.stat().st_size


def atomic_write_json(path: Path, payload: Any) -> None:
    _common()["atomic_write_json"](path, payload)


def load_json_object(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise IndexBuildError(f"JSON file not found: {path}") from error
    except json.JSONDecodeError as error:
        raise IndexBuildError(f"Invalid JSON in {path}: {error}") from error

    if not isinstance(value, dict):
        raise IndexBuildError(f"Expected JSON object in {path}.")

    return value


def manifest_record_count(manifest: Mapping[str, Any]) -> int | None:
    candidates: list[Any] = [
        manifest.get("total_primary_records"),
        manifest.get("total_records"),
        manifest.get("records"),
    ]

    totals = manifest.get("totals")
    if isinstance(totals, Mapping):
        candidates.extend(
            [
                totals.get("primary_records"),
                totals.get("records"),
                totals.get("taxa"),
            ]
        )

    archive = manifest.get("archive")
    if isinstance(archive, Mapping):
        candidates.extend(
            [
                archive.get("total_primary_records"),
                archive.get("records"),
            ]
        )

    for value in candidates:
        if value in (None, ""):
            continue
        if isinstance(value, bool):
            continue
        try:
            number = int(value)
        except (TypeError, ValueError):
            continue
        if number >= 0:
            return number

    return None


def _manifest_path_values(value: Any) -> Iterator[str]:
    if isinstance(value, str):
        yield value
        return

    if isinstance(value, Mapping):
        for key in ("path", "file", "filename", "relative_path"):
            candidate = value.get(key)
            if isinstance(candidate, str) and candidate.strip():
                yield candidate
                return
        return

    if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        for item in value:
            yield from _manifest_path_values(item)


def manifest_volume_paths(
    manifest: Mapping[str, Any],
    taxonomy_root: Path,
) -> list[Path]:
    containers: list[Any] = []

    for key in (
        "volumes",
        "volume_files",
        "archive_files",
        "files",
        "shards",
    ):
        if key in manifest:
            containers.append(manifest[key])

    archive = manifest.get("archive")
    if isinstance(archive, Mapping):
        for key in ("volumes", "files", "shards"):
            if key in archive:
                containers.append(archive[key])

    root = taxonomy_root.resolve()
    paths: set[Path] = set()

    for container in containers:
        for raw in _manifest_path_values(container):
            candidate = Path(raw)
            if not candidate.is_absolute():
                candidate = root / candidate
            candidate = candidate.resolve()

            try:
                candidate.relative_to(root)
            except ValueError as error:
                raise IndexBuildError(
                    f"Manifest volume escapes taxonomy root: {raw}"
                ) from error

            paths.add(candidate)

    return sorted(paths, key=lambda item: item.as_posix())


@dataclass
class IndexFile:
    filename: str
    records: int
    bytes: int
    sha256: str


@dataclass
class BuildSummary:
    schema_version: int = SCHEMA_VERSION
    status: str = "pending"
    generated_at: str = ""
    source_mode: str = ""
    source_files: list[str] = field(default_factory=list)
    expected_records: int | None = None
    source_records: int = 0
    indexed_records: int = 0
    skipped_records: int = 0
    duplicate_ids: int = 0
    name_keys: int = 0
    providers: int = 0
    taxonomy_values: dict[str, int] = field(default_factory=dict)
    sharded: bool = False
    shard_size: int | None = None
    duration_seconds: float = 0.0
    issues: list[str] = field(default_factory=list)


class IndexBuildError(RuntimeError):
    pass


class BrowserIndexBuilder:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.taxonomy_root = args.taxonomy_root.resolve()
        self.archive_manifest_path = (
            args.archive_manifest
            or self.taxonomy_root / MANIFEST_FILENAME
        ).resolve()
        self.output = args.output.resolve()
        self.shard_root = self.output / "shards"
        self.summary_path = (
            args.summary_file
            or self.output / "build-summary.json"
        ).resolve()
        self.logger = logging.getLogger(
            "speciedex.database.indexes"
        )
        self.started = time.monotonic()

        self.source_mode = args.source_mode
        self.source_files: list[Path] = []
        self.archive_manifest: dict[str, Any] | None = None
        self.expected_records: int | None = args.expect_records

        self.species: dict[str, dict[str, Any]] = {}
        self.names: defaultdict[str, list[str]] = defaultdict(list)
        self.providers: defaultdict[str, list[str]] = defaultdict(list)
        self.taxonomy: defaultdict[
            str,
            defaultdict[str, list[str]],
        ] = defaultdict(lambda: defaultdict(list))

        self.source_records = 0
        self.skipped_records = 0
        self.duplicate_ids = 0
        self.index_files: list[IndexFile] = []
        self.issues: list[str] = []

    def configure_logging(self) -> None:
        level = logging.DEBUG if self.args.verbose else logging.INFO
        if self.args.quiet:
            level = logging.WARNING

        logging.basicConfig(
            level=level,
            format="%(asctime)s %(levelname)s %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )

    def load_archive_manifest(self) -> dict[str, Any] | None:
        if not self.archive_manifest_path.is_file():
            return None

        try:
            value = json.loads(
                self.archive_manifest_path.read_text(encoding="utf-8")
            )
        except (OSError, json.JSONDecodeError) as error:
            raise IndexBuildError(
                f"Unable to read archive manifest "
                f"{self.archive_manifest_path}: {error}"
            ) from error

        if not isinstance(value, dict):
            raise IndexBuildError(
                f"Archive manifest must contain a JSON object: "
                f"{self.archive_manifest_path}"
            )

        return value

    def discover_sources(self) -> None:
        common = _common()
        requested = self.args.source_mode
        manifest = self.load_archive_manifest()
        self.archive_manifest = manifest

        manifest_paths: list[Path] = []
        if manifest is not None:
            manifest_paths = manifest_volume_paths(
                manifest,
                self.taxonomy_root,
            )

        volumes_root = self.taxonomy_root / "volumes"
        volume_paths = (
            sorted(
                (
                    path.resolve()
                    for path in volumes_root.iterdir()
                    if path.is_file()
                    and common["is_supported_input"](path)
                    and not path.name.startswith(".")
                    and not path.name.endswith(".tmp")
                ),
                key=lambda item: item.as_posix(),
            )
            if volumes_root.is_dir()
            else []
        )

        if requested == "manifest":
            if manifest is None:
                raise IndexBuildError(
                    f"--source-mode manifest requires "
                    f"{self.archive_manifest_path}."
                )
            if not manifest_paths:
                raise IndexBuildError(
                    "Archive manifest does not declare any volume paths."
                )
            self.source_files = manifest_paths
            self.source_mode = "manifest"

        elif requested == "volumes":
            if not volume_paths:
                raise IndexBuildError(
                    f"No supported canonical volume files found beneath "
                    f"{volumes_root}."
                )
            self.source_files = volume_paths
            self.source_mode = "volumes"

        elif requested == "recursive":
            self.source_files = []
            self.source_mode = "recursive"

        else:
            if manifest_paths:
                self.source_files = manifest_paths
                self.source_mode = "manifest"
            elif volume_paths:
                self.source_files = volume_paths
                self.source_mode = "volumes"
            else:
                raise IndexBuildError(
                    "No canonical archive volumes were found. Expected "
                    "manifest-declared files or supported files beneath "
                    "taxonomy/volumes/. Use --source-mode recursive only for "
                    "legacy repositories after reviewing its broader scope."
                )

        if self.source_mode != "recursive":
            missing = [
                path for path in self.source_files if not path.is_file()
            ]
            unsupported = [
                path
                for path in self.source_files
                if path.is_file()
                and not common["is_supported_input"](path)
            ]

            if missing:
                raise IndexBuildError(
                    "Canonical archive volume(s) are missing: "
                    + ", ".join(str(path) for path in missing)
                )

            if unsupported:
                raise IndexBuildError(
                    "Archive manifest references unsupported input file(s): "
                    + ", ".join(str(path) for path in unsupported)
                )

        manifest_expected = (
            manifest_record_count(manifest)
            if manifest is not None
            else None
        )

        if self.expected_records is None:
            self.expected_records = manifest_expected
        elif (
            manifest_expected is not None
            and self.expected_records != manifest_expected
        ):
            raise IndexBuildError(
                "--expect-records conflicts with the archive manifest: "
                f"argument={self.expected_records}, "
                f"manifest={manifest_expected}."
            )

    def validate(self) -> None:
        try:
            _common()
        except RuntimeError as error:
            raise IndexBuildError(str(error)) from error

        if not self.taxonomy_root.exists():
            raise IndexBuildError(
                f"Taxonomy root does not exist: {self.taxonomy_root}"
            )

        if not self.taxonomy_root.is_dir():
            raise IndexBuildError(
                f"Taxonomy root is not a directory: {self.taxonomy_root}"
            )

        if self.args.shard_size < 1:
            raise IndexBuildError("--shard-size must be at least 1.")

        self.discover_sources()
        self.output.mkdir(parents=True, exist_ok=True)
        self.summary_path.parent.mkdir(parents=True, exist_ok=True)

        for directory in {self.output, self.summary_path.parent}:
            probe: Path | None = None
            try:
                with tempfile.NamedTemporaryFile(
                    "w",
                    encoding="utf-8",
                    delete=False,
                    dir=directory,
                    prefix=".speciedex-write-test.",
                ) as handle:
                    handle.write("ok\n")
                    probe = Path(handle.name)
            except OSError as error:
                raise IndexBuildError(
                    f"Output directory is not writable: "
                    f"{directory}: {error}"
                ) from error
            finally:
                if probe is not None:
                    probe.unlink(missing_ok=True)

        usage = shutil.disk_usage(self.output)
        if usage.free < self.args.minimum_free_bytes:
            raise IndexBuildError(
                f"Insufficient free disk space under {self.output}: "
                f"{usage.free} bytes available, "
                f"{self.args.minimum_free_bytes} required."
            )

    def iter_source_records(self) -> Iterator[dict[str, Any]]:
        common = _common()

        if self.source_mode == "recursive":
            yield from common["iter_canonical_records"](
                self.taxonomy_root,
                strict=self.args.strict,
                deduplicate=False,
            )
            return

        for path in self.source_files:
            provider_hint = common["provider_hint_from_path"](path)
            relative = path.relative_to(self.taxonomy_root).as_posix()

            for raw in common["iter_records"](path):
                record = common["canonical_record"](
                    raw,
                    source_file=relative,
                    provider_hint=provider_hint,
                )
                errors = common["validate_canonical_record"](record)

                if errors:
                    if self.args.strict:
                        raise IndexBuildError(
                            f"{relative}: {'; '.join(errors)}"
                        )
                    if "missing scientific_name" in errors:
                        self.skipped_records += 1
                        self.issues.append(
                            f"{relative}: {'; '.join(errors)}"
                        )
                        continue

                yield record

    def compact_record(
        self,
        record: Mapping[str, Any],
    ) -> dict[str, Any]:
        identifier = clean_text(record.get("speciedex_id"))
        if not identifier:
            raise IndexBuildError(
                "Canonical record is missing speciedex_id."
            )

        scientific_name = clean_text(record.get("scientific_name"))
        if not scientific_name:
            raise IndexBuildError(
                f"Canonical record {identifier} is missing scientific_name."
            )

        compact: dict[str, Any] = {
            "id": identifier,
            "scientific_name": scientific_name,
            "common_name": clean_text(record.get("common_name")),
            "rank": clean_text(record.get("rank")),
            "status": clean_text(record.get("status")),
            "provider": clean_text(record.get("provider")),
            "indexed_at": clean_text(record.get("indexed_at")),
        }

        if self.args.include_canonical_name:
            compact["canonical_name"] = clean_text(
                record.get("canonical_name")
            )

        if self.args.include_taxonomy:
            for rank in TAXONOMY_RANKS:
                compact[rank] = clean_text(record.get(rank))

        return compact

    def ingest(self) -> None:
        for record in self.iter_source_records():
            self.source_records += 1

            try:
                compact = self.compact_record(record)
            except Exception as error:
                self.skipped_records += 1
                if self.args.strict:
                    raise
                self.issues.append(
                    f"record {self.source_records}: {error}"
                )
                self.logger.warning(
                    "Skipping invalid canonical record %d: %s",
                    self.source_records,
                    error,
                )
                continue

            identifier = compact["id"]

            if identifier in self.species:
                self.duplicate_ids += 1

                if self.args.duplicate_policy == "error":
                    raise IndexBuildError(
                        f"Duplicate speciedex_id encountered: {identifier}"
                    )

                if self.args.duplicate_policy == "first":
                    continue

            self.species[identifier] = compact

            for value in (
                record.get("scientific_name", ""),
                record.get("canonical_name", ""),
                record.get("common_name", ""),
            ):
                key = normalized_key(value)
                if key:
                    self.names[key].append(identifier)

            provider = clean_text(record.get("provider")) or "unknown"
            self.providers[provider].append(identifier)

            for rank in TAXONOMY_RANKS:
                value = clean_text(record.get(rank))
                if value:
                    self.taxonomy[rank][value].append(identifier)

            if (
                self.args.progress_every
                and self.source_records % self.args.progress_every == 0
            ):
                self.logger.info(
                    "Indexed %d source records...",
                    self.source_records,
                )

        if (
            self.expected_records is not None
            and self.source_records != self.expected_records
        ):
            raise IndexBuildError(
                "Canonical archive record count does not match index input: "
                f"expected={self.expected_records}, "
                f"read={self.source_records}."
            )

    def normalize_indexes(
        self,
    ) -> tuple[
        dict[str, dict[str, Any]],
        dict[str, list[str]],
        dict[str, list[str]],
        dict[str, dict[str, list[str]]],
    ]:
        species = dict(sorted(self.species.items()))

        names = {
            key: unique_sorted(values)
            for key, values in sorted(self.names.items())
        }

        providers = {
            key: unique_sorted(values)
            for key, values in sorted(self.providers.items())
        }

        taxonomy = {
            rank: {
                value: unique_sorted(identifiers)
                for value, identifiers in sorted(values.items())
            }
            for rank, values in sorted(self.taxonomy.items())
        }

        return species, names, providers, taxonomy

    def write_index(
        self,
        filename: str,
        payload: Any,
        *,
        records: int,
    ) -> Path:
        path = self.output / filename

        if self.args.dry_run:
            self.logger.info("Would write %s", path)
            return path

        atomic_write_json(path, payload)

        self.index_files.append(
            IndexFile(
                filename=filename,
                records=records,
                bytes=json_size(path),
                sha256=sha256_file(path),
            )
        )
        return path

    def clean_outputs(self) -> None:
        if not self.args.clean:
            return

        for filename in GENERATED_INDEX_FILES:
            path = self.output / filename
            self.logger.info("Removing generated index: %s", path)
            if not self.args.dry_run:
                path.unlink(missing_ok=True)

        if self.shard_root.exists():
            for path in self.shard_root.glob("species-*.json"):
                self.logger.info("Removing generated shard: %s", path)
                if not self.args.dry_run:
                    path.unlink(missing_ok=True)

    def write_shards(
        self,
        species: Mapping[str, Mapping[str, Any]],
    ) -> list[dict[str, Any]]:
        if not self.args.shard:
            return []

        self.shard_root.mkdir(parents=True, exist_ok=True)
        entries = list(species.items())
        shards: list[dict[str, Any]] = []

        for shard_number, start in enumerate(
            range(0, len(entries), self.args.shard_size)
        ):
            chunk = entries[start : start + self.args.shard_size]
            filename = f"species-{shard_number:05d}.json"
            relative = f"shards/{filename}"
            payload = dict(chunk)
            path = self.shard_root / filename

            if not self.args.dry_run:
                atomic_write_json(path, payload)

            descriptor = {
                "id": f"{shard_number:05d}",
                "filename": relative,
                "path": relative,
                "records": len(chunk),
                "first_id": chunk[0][0] if chunk else "",
                "last_id": chunk[-1][0] if chunk else "",
                "bytes": (
                    0 if self.args.dry_run else json_size(path)
                ),
                "sha256": (
                    "" if self.args.dry_run else sha256_file(path)
                ),
            }
            shards.append(descriptor)

        return shards

    def write_outputs(self) -> dict[str, Any]:
        species, names, providers, taxonomy = self.normalize_indexes()

        self.write_index(
            "species.json",
            species,
            records=len(species),
        )
        self.write_index(
            "names.json",
            names,
            records=len(names),
        )
        self.write_index(
            "providers.json",
            providers,
            records=len(providers),
        )
        self.write_index(
            "taxonomy.json",
            taxonomy,
            records=sum(
                len(values)
                for values in taxonomy.values()
            ),
        )

        shard_index = self.write_shards(species)

        if self.args.shard:
            self.write_index(
                "shards.json",
                {
                    "schema_version": SCHEMA_VERSION,
                    "generated_at": utc_now(),
                    "shard_size": self.args.shard_size,
                    "records": len(species),
                    "shards": shard_index,
                },
                records=len(shard_index),
            )

        source_files = [
            (
                path.relative_to(self.taxonomy_root).as_posix()
                if path.is_relative_to(self.taxonomy_root)
                else path.as_posix()
            )
            for path in self.source_files
        ]

        manifest = {
            "schema_version": SCHEMA_VERSION,
            "kind": "browser-indexes",
            "generated_at": utc_now(),
            "source": self.taxonomy_root.as_posix(),
            "source_mode": self.source_mode,
            "source_files": source_files,
            "expected_records": self.expected_records,
            "output": self.output.as_posix(),
            "totals": {
                "source_records": self.source_records,
                "records": len(species),
                "skipped_records": self.skipped_records,
                "duplicate_ids": self.duplicate_ids,
                "name_keys": len(names),
                "providers": len(providers),
                "taxonomy_values": sum(
                    len(values)
                    for values in taxonomy.values()
                ),
                "shards": len(shard_index),
            },
            "taxonomy_values": {
                rank: len(values)
                for rank, values in taxonomy.items()
            },
            "options": {
                "strict": self.args.strict,
                "duplicate_policy": self.args.duplicate_policy,
                "include_canonical_name": (
                    self.args.include_canonical_name
                ),
                "include_taxonomy": self.args.include_taxonomy,
                "sharded": bool(self.args.shard),
                "shard_size": (
                    self.args.shard_size
                    if self.args.shard
                    else None
                ),
            },
            "indexes": [
                asdict(index_file)
                for index_file in self.index_files
            ],
            "shards": shard_index,
            "issues": list(self.issues),
            "duration_seconds": round(
                time.monotonic() - self.started,
                6,
            ),
        }

        self.write_index(
            "manifest.json",
            manifest,
            records=len(species),
        )
        return manifest

    def verify_outputs(
        self,
        manifest: Mapping[str, Any],
    ) -> None:
        if self.args.dry_run or not self.args.verify:
            return

        required = [
            self.output / "species.json",
            self.output / "names.json",
            self.output / "providers.json",
            self.output / "taxonomy.json",
            self.output / "manifest.json",
        ]

        if self.args.shard:
            required.append(self.output / "shards.json")

        for path in required:
            if not path.is_file():
                raise IndexBuildError(
                    f"Expected index file was not created: {path}"
                )
            load_json_object(path)

        species = load_json_object(self.output / "species.json")
        names = load_json_object(self.output / "names.json")
        providers = load_json_object(self.output / "providers.json")
        taxonomy = load_json_object(self.output / "taxonomy.json")
        persisted_manifest = load_json_object(
            self.output / "manifest.json"
        )

        expected_records = int(
            manifest.get("totals", {}).get("records", -1)
        )
        if len(species) != expected_records:
            raise IndexBuildError(
                f"species.json record count mismatch: "
                f"manifest={expected_records}, actual={len(species)}."
            )

        if (
            len(names)
            != int(manifest.get("totals", {}).get("name_keys", -1))
        ):
            raise IndexBuildError(
                "names.json key count does not match manifest."
            )

        if (
            len(providers)
            != int(manifest.get("totals", {}).get("providers", -1))
        ):
            raise IndexBuildError(
                "providers.json key count does not match manifest."
            )

        actual_taxonomy_values = sum(
            len(values)
            for values in taxonomy.values()
            if isinstance(values, Mapping)
        )
        if (
            actual_taxonomy_values
            != int(
                manifest.get("totals", {}).get(
                    "taxonomy_values",
                    -1,
                )
            )
        ):
            raise IndexBuildError(
                "taxonomy.json value count does not match manifest."
            )

        if persisted_manifest.get("kind") != "browser-indexes":
            raise IndexBuildError(
                "Generated manifest kind is invalid."
            )

        index_descriptors = {
            clean_text(item.get("filename")): item
            for item in manifest.get("indexes", [])
            if isinstance(item, Mapping)
        }

        for path in required:
            if path.name == "manifest.json":
                continue

            descriptor = index_descriptors.get(path.name)
            if descriptor is None:
                raise IndexBuildError(
                    f"Manifest is missing index descriptor: {path.name}"
                )

            actual_size = path.stat().st_size
            expected_size = int(descriptor.get("bytes", -1))
            if actual_size != expected_size:
                raise IndexBuildError(
                    f"Index size mismatch for {path.name}: "
                    f"manifest={expected_size}, actual={actual_size}."
                )

            actual_digest = sha256_file(path)
            expected_digest = clean_text(
                descriptor.get("sha256")
            )
            if actual_digest != expected_digest:
                raise IndexBuildError(
                    f"Index checksum mismatch for {path.name}."
                )

        if self.args.shard:
            shards_index = load_json_object(
                self.output / "shards.json"
            )
            shard_entries = shards_index.get("shards")
            if not isinstance(shard_entries, list):
                raise IndexBuildError(
                    "shards.json shards must be an array."
                )

            total_shard_records = 0
            for entry in shard_entries:
                if not isinstance(entry, Mapping):
                    raise IndexBuildError(
                        "shards.json contains a non-object descriptor."
                    )

                relative = clean_text(
                    entry.get("path") or entry.get("filename")
                )
                shard_path = (self.output / relative).resolve()

                try:
                    shard_path.relative_to(self.output.resolve())
                except ValueError as error:
                    raise IndexBuildError(
                        f"Shard path escapes output root: {relative}"
                    ) from error

                payload = load_json_object(shard_path)
                expected = int(entry.get("records", -1))
                if len(payload) != expected:
                    raise IndexBuildError(
                        f"Shard count mismatch for {relative}: "
                        f"manifest={expected}, actual={len(payload)}."
                    )

                if shard_path.stat().st_size != int(
                    entry.get("bytes", -1)
                ):
                    raise IndexBuildError(
                        f"Shard size mismatch for {relative}."
                    )

                if sha256_file(shard_path) != clean_text(
                    entry.get("sha256")
                ):
                    raise IndexBuildError(
                        f"Shard checksum mismatch for {relative}."
                    )

                total_shard_records += len(payload)

            if total_shard_records != len(species):
                raise IndexBuildError(
                    "Species shard totals do not match species.json."
                )

    def build_summary(
        self,
        status: str,
    ) -> dict[str, Any]:
        elapsed = time.monotonic() - self.started
        return asdict(
            BuildSummary(
                status=status,
                generated_at=utc_now(),
                source_mode=self.source_mode,
                source_files=[
                    (
                        path.relative_to(
                            self.taxonomy_root
                        ).as_posix()
                        if path.is_relative_to(
                            self.taxonomy_root
                        )
                        else path.as_posix()
                    )
                    for path in self.source_files
                ],
                expected_records=self.expected_records,
                source_records=self.source_records,
                indexed_records=len(self.species),
                skipped_records=self.skipped_records,
                duplicate_ids=self.duplicate_ids,
                name_keys=len(self.names),
                providers=len(self.providers),
                taxonomy_values={
                    rank: len(values)
                    for rank, values in self.taxonomy.items()
                },
                sharded=bool(self.args.shard),
                shard_size=(
                    self.args.shard_size
                    if self.args.shard
                    else None
                ),
                duration_seconds=round(elapsed, 6),
                issues=list(self.issues),
            )
        )

    def write_summary(self, status: str) -> None:
        if self.args.dry_run:
            return

        atomic_write_json(
            self.summary_path,
            self.build_summary(status),
        )

    def run(self) -> int:
        self.configure_logging()

        try:
            self.validate()
            self.clean_outputs()
            self.ingest()
            manifest = self.write_outputs()
            self.verify_outputs(manifest)
            self.write_summary("success")

        except KeyboardInterrupt:
            self.logger.error("Index build interrupted.")
            try:
                self.write_summary("interrupted")
            except Exception:
                pass
            return 130

        except Exception as error:
            self.logger.error("Index build failed: %s", error)
            if self.args.verbose:
                self.logger.exception("Detailed failure")
            try:
                self.issues.append(str(error))
                self.write_summary("failed")
            except Exception:
                pass
            return 1

        elapsed = time.monotonic() - self.started

        if self.args.dry_run:
            self.logger.info(
                "Dry run completed for %d source records.",
                self.source_records,
            )
        else:
            self.logger.info(
                "Built browser indexes for %d records in %.2f seconds.",
                len(self.species),
                elapsed,
            )

        return 0


def parse_args(
    argv: Sequence[str] | None = None,
) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Build deterministic Speciedex browser indexes from "
            "canonical taxonomy archive volumes."
        ),
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )

    parser.add_argument(
        "--taxonomy-root",
        type=Path,
        default=Path("static/data/taxonomy"),
        help="Root directory containing canonical taxonomy records.",
    )
    parser.add_argument(
        "--archive-manifest",
        type=Path,
        default=None,
        help="Canonical archive manifest; defaults to taxonomy/manifest.json.",
    )
    parser.add_argument(
        "--source-mode",
        choices=SOURCE_MODES,
        default="auto",
        help=(
            "Source discovery mode. auto prefers manifest-declared volumes, "
            "then taxonomy/volumes. recursive is legacy-only."
        ),
    )
    parser.add_argument(
        "--expect-records",
        type=int,
        default=None,
        help=(
            "Expected canonical source record count. When omitted, the value "
            "is read from the archive manifest when available."
        ),
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("static/data/db/indexes"),
        help="Destination directory for generated browser indexes.",
    )
    parser.add_argument(
        "--summary-file",
        type=Path,
        default=None,
        help="Build-summary JSON destination.",
    )
    parser.add_argument(
        "--clean",
        action="store_true",
        help="Remove existing generated index files before rebuilding.",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Fail immediately on invalid records.",
    )
    parser.add_argument(
        "--duplicate-policy",
        choices=("first", "last", "error"),
        default="last",
        help="Policy applied to duplicate speciedex_id values.",
    )
    parser.add_argument(
        "--verify",
        action=argparse.BooleanOptionalAction,
        default=True,
        help=(
            "Verify generated JSON, counts, checksums, sizes, and shard totals."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Read and index records without writing files.",
    )
    parser.add_argument(
        "--shard",
        action="store_true",
        help="Write sharded species indexes for lower browser memory usage.",
    )
    parser.add_argument(
        "--shard-size",
        type=int,
        default=DEFAULT_SHARD_SIZE,
        help="Maximum number of species records per shard.",
    )
    parser.add_argument(
        "--include-canonical-name",
        action="store_true",
        help="Include canonical_name in compact species records.",
    )
    parser.add_argument(
        "--include-taxonomy",
        action="store_true",
        help="Include taxonomy rank fields in compact species records.",
    )
    parser.add_argument(
        "--minimum-free-bytes",
        type=int,
        default=DEFAULT_MINIMUM_FREE_BYTES,
        help="Minimum free disk space required beneath output.",
    )
    parser.add_argument(
        "--progress-every",
        type=int,
        default=100_000,
        help=(
            "Emit progress after this many source records; use 0 to disable."
        ),
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable verbose logging.",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress informational logging.",
    )

    args = parser.parse_args(argv)

    if args.shard_size < 1:
        parser.error("--shard-size must be at least 1.")

    if args.expect_records is not None and args.expect_records < 0:
        parser.error("--expect-records cannot be negative.")

    if args.minimum_free_bytes < 0:
        parser.error("--minimum-free-bytes cannot be negative.")

    if args.progress_every < 0:
        parser.error("--progress-every cannot be negative.")

    if args.verbose and args.quiet:
        parser.error(
            "--verbose and --quiet cannot be used together."
        )

    return args


def main(argv: Sequence[str] | None = None) -> int:
    return BrowserIndexBuilder(parse_args(argv)).run()


if __name__ == "__main__":
    raise SystemExit(main())
