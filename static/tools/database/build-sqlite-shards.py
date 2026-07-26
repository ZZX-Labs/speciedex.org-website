#!/usr/bin/env python3
"""
Build deterministic Speciedex SQLite database shards.

Expected location:
    static/tools/database/build-sqlite-shards.py

This tool converts canonical Speciedex taxonomy archive records into SQLite
shards suitable for terminal search, statistics, offline browsing, analysis,
and downstream website data generation.

Canonical archive discovery is intentionally conservative. By default the tool
reads only archive volumes declared by static/data/taxonomy/manifest.json, or
falls back to supported files directly beneath static/data/taxonomy/volumes/.
It does not recursively interpret unrelated taxonomy metadata, provider state,
scheduler files, reports, or rejected records as taxa.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import logging
import os
import shutil
import sqlite3
import sys
import tempfile
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Sequence


EXIT_SUCCESS = 0
EXIT_VALIDATION = 1
EXIT_BUILD = 2
EXIT_VERIFICATION = 3
EXIT_INTERRUPTED = 130

STATE_FILENAME = "build-state.json"
SUMMARY_FILENAME = "build-summary.json"
MANIFEST_FILENAME = "manifest.json"
SHARD_PATTERN = "speciedex-*.sqlite3"
SOURCE_MODES = ("auto", "manifest", "volumes", "recursive")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00",
        "Z",
    )


def clean_text(value: Any) -> str:
    return str(value or "").strip()


def human_duration(seconds: float) -> str:
    seconds = max(0, int(round(seconds)))
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
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
            json.dump(
                payload,
                handle,
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
            temporary = Path(handle.name)
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink(missing_ok=True)


def load_common() -> dict[str, Any]:
    """
    Import shared database helpers lazily.

    Lazy loading keeps --help functional when this script is inspected outside
    the repository. Normal execution still requires common.py beside it.
    """
    try:
        from common import (
            DEFAULT_MAX_FILE_BYTES,
            DEFAULT_ROWS_PER_SHARD,
            DEFAULT_TARGET_FILE_BYTES,
            build_sqlite_shard,
            canonical_record,
            chunk_records,
            is_supported_input,
            iter_canonical_records,
            iter_records,
            provider_hint_from_path,
            remove_generated_files,
            validate_canonical_record,
            write_manifest,
        )
    except ModuleNotFoundError as error:
        raise RuntimeError(
            "Unable to import static/tools/database/common.py. Keep this file "
            "beside common.py and run it from the Speciedex repository."
        ) from error

    return {
        "DEFAULT_MAX_FILE_BYTES": DEFAULT_MAX_FILE_BYTES,
        "DEFAULT_ROWS_PER_SHARD": DEFAULT_ROWS_PER_SHARD,
        "DEFAULT_TARGET_FILE_BYTES": DEFAULT_TARGET_FILE_BYTES,
        "build_sqlite_shard": build_sqlite_shard,
        "canonical_record": canonical_record,
        "chunk_records": chunk_records,
        "is_supported_input": is_supported_input,
        "iter_canonical_records": iter_canonical_records,
        "iter_records": iter_records,
        "provider_hint_from_path": provider_hint_from_path,
        "remove_generated_files": remove_generated_files,
        "validate_canonical_record": validate_canonical_record,
        "write_manifest": write_manifest,
    }


def default_values() -> tuple[int, int, int]:
    try:
        common = load_common()
        return (
            int(common["DEFAULT_ROWS_PER_SHARD"]),
            int(common["DEFAULT_TARGET_FILE_BYTES"]),
            int(common["DEFAULT_MAX_FILE_BYTES"]),
        )
    except RuntimeError:
        return (
            100_000,
            72 * 1024 * 1024,
            90 * 1024 * 1024,
        )


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
    """
    Resolve canonical archive volume paths from common manifest layouts.

    Only paths that resolve beneath taxonomy_root are accepted.
    """
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
                raise ValueError(
                    f"Manifest volume escapes taxonomy root: {raw}"
                ) from error

            paths.add(candidate)

    return sorted(paths, key=lambda item: item.as_posix())


@dataclass
class ShardSummary:
    shard_id: str
    filename: str
    records: int
    bytes: int
    sha256: str
    started_at: str
    finished_at: str
    duration_seconds: float
    integrity: str = "not-checked"
    analyzed: bool = False
    vacuumed: bool = False


@dataclass
class BuildState:
    schema_version: int = 2
    status: str = "pending"
    started_at: str = ""
    finished_at: str = ""
    taxonomy_root: str = ""
    output: str = ""
    source_mode: str = ""
    source_files: list[str] = field(default_factory=list)
    expected_records: int | None = None
    current_shard: str = ""
    completed_shards: list[dict[str, Any]] = field(default_factory=list)
    total_records: int = 0
    last_error: str = ""
    interrupted: bool = False


class SQLiteShardBuildError(RuntimeError):
    def __init__(self, message: str, exit_code: int = EXIT_BUILD) -> None:
        super().__init__(message)
        self.exit_code = exit_code


class SQLiteShardBuilder:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.taxonomy_root = args.taxonomy_root.resolve()
        self.output = args.output.resolve()
        self.state_path = (
            args.state_file or self.output / STATE_FILENAME
        ).resolve()
        self.summary_path = (
            args.summary_file or self.output / SUMMARY_FILENAME
        ).resolve()
        self.archive_manifest_path = (
            args.archive_manifest
            or self.taxonomy_root / MANIFEST_FILENAME
        ).resolve()

        self.started = time.monotonic()
        self.logger = logging.getLogger(
            "speciedex.database.sqlite_shards"
        )
        self.shards: list[dict[str, Any]] = []
        self.shard_summaries: list[ShardSummary] = []
        self.source_files: list[Path] = []
        self.source_mode = args.source_mode
        self.archive_manifest: dict[str, Any] | None = None
        self.expected_records: int | None = args.expect_records

        self.state = BuildState(
            status="pending",
            started_at=utc_now(),
            taxonomy_root=str(self.taxonomy_root),
            output=str(self.output),
            source_mode=self.source_mode,
            expected_records=self.expected_records,
        )

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
            raise SQLiteShardBuildError(
                f"Unable to read archive manifest "
                f"{self.archive_manifest_path}: {error}",
                EXIT_VALIDATION,
            ) from error

        if not isinstance(value, dict):
            raise SQLiteShardBuildError(
                f"Archive manifest must contain a JSON object: "
                f"{self.archive_manifest_path}",
                EXIT_VALIDATION,
            )

        return value

    def discover_sources(self) -> None:
        common = load_common()
        requested = self.args.source_mode
        manifest = self.load_archive_manifest()
        self.archive_manifest = manifest

        manifest_paths: list[Path] = []
        if manifest is not None:
            try:
                manifest_paths = manifest_volume_paths(
                    manifest,
                    self.taxonomy_root,
                )
            except ValueError as error:
                raise SQLiteShardBuildError(
                    str(error),
                    EXIT_VALIDATION,
                ) from error

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
                raise SQLiteShardBuildError(
                    f"--source-mode manifest requires "
                    f"{self.archive_manifest_path}.",
                    EXIT_VALIDATION,
                )
            if not manifest_paths:
                raise SQLiteShardBuildError(
                    "Archive manifest does not declare any volume paths.",
                    EXIT_VALIDATION,
                )
            self.source_files = manifest_paths
            self.source_mode = "manifest"

        elif requested == "volumes":
            if not volume_paths:
                raise SQLiteShardBuildError(
                    f"No supported canonical volume files found beneath "
                    f"{volumes_root}.",
                    EXIT_VALIDATION,
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
                raise SQLiteShardBuildError(
                    "No canonical archive volumes were found. Expected volume "
                    "paths in taxonomy/manifest.json or supported files beneath "
                    "taxonomy/volumes/. Use --source-mode recursive only for "
                    "legacy repositories after reviewing its broader scope.",
                    EXIT_VALIDATION,
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
                raise SQLiteShardBuildError(
                    "Canonical archive volume(s) are missing: "
                    + ", ".join(str(path) for path in missing),
                    EXIT_VALIDATION,
                )

            if unsupported:
                raise SQLiteShardBuildError(
                    "Canonical archive manifest references unsupported "
                    "input file(s): "
                    + ", ".join(str(path) for path in unsupported),
                    EXIT_VALIDATION,
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
            raise SQLiteShardBuildError(
                "--expect-records conflicts with the archive manifest: "
                f"argument={self.expected_records}, "
                f"manifest={manifest_expected}.",
                EXIT_VALIDATION,
            )

        self.state.source_mode = self.source_mode
        self.state.source_files = [
            (
                path.relative_to(self.taxonomy_root).as_posix()
                if path.is_relative_to(self.taxonomy_root)
                else path.as_posix()
            )
            for path in self.source_files
        ]
        self.state.expected_records = self.expected_records

    def validate(self) -> None:
        try:
            load_common()
        except RuntimeError as error:
            raise SQLiteShardBuildError(
                str(error),
                EXIT_VALIDATION,
            ) from error

        if not self.taxonomy_root.exists():
            raise SQLiteShardBuildError(
                f"Taxonomy root does not exist: {self.taxonomy_root}",
                EXIT_VALIDATION,
            )

        if not self.taxonomy_root.is_dir():
            raise SQLiteShardBuildError(
                f"Taxonomy root is not a directory: {self.taxonomy_root}",
                EXIT_VALIDATION,
            )

        if self.args.rows_per_shard < 1:
            raise SQLiteShardBuildError(
                "--rows-per-shard must be at least 1.",
                EXIT_VALIDATION,
            )

        if self.args.target_bytes < 1:
            raise SQLiteShardBuildError(
                "--target-bytes must be at least 1.",
                EXIT_VALIDATION,
            )

        if self.args.max_bytes < 1:
            raise SQLiteShardBuildError(
                "--max-bytes must be at least 1.",
                EXIT_VALIDATION,
            )

        if self.args.target_bytes > self.args.max_bytes:
            raise SQLiteShardBuildError(
                "--target-bytes cannot exceed --max-bytes.",
                EXIT_VALIDATION,
            )

        self.discover_sources()
        self.output.mkdir(parents=True, exist_ok=True)

        probe = self.output / ".speciedex-write-test"
        try:
            probe.write_text("ok\n", encoding="utf-8")
            probe.unlink()
        except OSError as error:
            raise SQLiteShardBuildError(
                f"Output directory is not writable: "
                f"{self.output}: {error}",
                EXIT_VALIDATION,
            ) from error

        usage = shutil.disk_usage(self.output)
        if usage.free < self.args.minimum_free_bytes:
            raise SQLiteShardBuildError(
                f"Insufficient free disk space under {self.output}: "
                f"{usage.free} bytes available, "
                f"{self.args.minimum_free_bytes} required.",
                EXIT_VALIDATION,
            )

    def load_previous_state(self) -> BuildState | None:
        if not self.state_path.is_file():
            return None

        try:
            payload = json.loads(
                self.state_path.read_text(encoding="utf-8")
            )
        except (OSError, json.JSONDecodeError) as error:
            self.logger.warning(
                "Unable to read previous build state: %s",
                error,
            )
            return None

        if not isinstance(payload, dict):
            return None

        allowed = set(BuildState.__dataclass_fields__)
        compatible = {
            key: value
            for key, value in payload.items()
            if key in allowed
        }

        try:
            return BuildState(**compatible)
        except TypeError:
            self.logger.warning(
                "Ignoring incompatible previous build state."
            )
            return None

    def save_state(self) -> None:
        self.state.completed_shards = [
            asdict(summary) for summary in self.shard_summaries
        ]
        atomic_write_json(self.state_path, asdict(self.state))

    def clean_outputs(self) -> None:
        if self.args.resume or not self.args.clean:
            return

        if self.args.dry_run:
            self.logger.info(
                "Dry run: would remove existing generated outputs."
            )
            return

        common = load_common()
        common["remove_generated_files"](
            self.output,
            (
                SHARD_PATTERN,
                MANIFEST_FILENAME,
                SUMMARY_FILENAME,
                STATE_FILENAME,
            ),
        )

    def restore_completed_shards(self) -> set[str]:
        if not self.args.resume:
            return set()

        previous = self.load_previous_state()
        if previous is None:
            return set()

        if Path(previous.taxonomy_root).resolve() != self.taxonomy_root:
            raise SQLiteShardBuildError(
                "Resume state taxonomy_root does not match this build.",
                EXIT_VALIDATION,
            )

        if previous.source_mode and previous.source_mode != self.source_mode:
            raise SQLiteShardBuildError(
                "Resume state source mode does not match this build.",
                EXIT_VALIDATION,
            )

        completed: set[str] = set()

        for entry in previous.completed_shards:
            shard_id = clean_text(entry.get("shard_id"))
            filename = clean_text(entry.get("filename"))
            if not shard_id or not filename:
                continue

            path = self.output / filename
            if not path.is_file():
                continue

            expected_bytes = int(entry.get("bytes", 0) or 0)
            expected_sha256 = clean_text(entry.get("sha256"))

            if expected_bytes and path.stat().st_size != expected_bytes:
                self.logger.warning(
                    "Resume shard %s has a size mismatch; rebuilding.",
                    shard_id,
                )
                continue

            if expected_sha256 and sha256_file(path) != expected_sha256:
                self.logger.warning(
                    "Resume shard %s has a checksum mismatch; rebuilding.",
                    shard_id,
                )
                continue

            summary = ShardSummary(
                shard_id=shard_id,
                filename=filename,
                records=int(entry.get("records", 0) or 0),
                bytes=path.stat().st_size,
                sha256=sha256_file(path),
                started_at=clean_text(entry.get("started_at")),
                finished_at=clean_text(entry.get("finished_at")),
                duration_seconds=float(
                    entry.get("duration_seconds", 0) or 0
                ),
                integrity=clean_text(
                    entry.get("integrity")
                ) or "not-checked",
                analyzed=bool(entry.get("analyzed", False)),
                vacuumed=bool(entry.get("vacuumed", False)),
            )

            self.shard_summaries.append(summary)
            self.shards.append(
                {
                    "id": shard_id,
                    "shard_id": shard_id,
                    "path": filename,
                    "filename": filename,
                    "records": summary.records,
                    "bytes": summary.bytes,
                    "sha256": summary.sha256,
                }
            )
            self.state.total_records += summary.records
            completed.add(shard_id)

        self.logger.info(
            "Resume mode restored %d completed shard(s).",
            len(completed),
        )
        return completed

    def sqlite_integrity_check(self, path: Path) -> str:
        try:
            connection = sqlite3.connect(
                f"file:{path.resolve()}?mode=ro",
                uri=True,
            )
            try:
                row = connection.execute(
                    "PRAGMA integrity_check"
                ).fetchone()
            finally:
                connection.close()
        except sqlite3.Error as error:
            raise SQLiteShardBuildError(
                f"Unable to verify SQLite shard {path}: {error}",
                EXIT_VERIFICATION,
            ) from error

        result = clean_text(row[0] if row else "")
        if result.casefold() != "ok":
            raise SQLiteShardBuildError(
                f"SQLite integrity check failed for {path}: {result}",
                EXIT_VERIFICATION,
            )

        return result

    def sqlite_record_count(self, path: Path) -> int:
        try:
            connection = sqlite3.connect(
                f"file:{path.resolve()}?mode=ro",
                uri=True,
            )
            try:
                row = connection.execute(
                    "SELECT COUNT(*) FROM taxa"
                ).fetchone()
            finally:
                connection.close()
        except sqlite3.Error as error:
            raise SQLiteShardBuildError(
                f"Unable to count SQLite shard records in {path}: {error}",
                EXIT_VERIFICATION,
            ) from error

        return int(row[0] if row else 0)

    def optimize_sqlite(self, path: Path) -> tuple[bool, bool]:
        analyzed = False
        vacuumed = False

        if not self.args.analyze and not self.args.vacuum:
            return analyzed, vacuumed

        try:
            connection = sqlite3.connect(path)
            try:
                if self.args.analyze:
                    connection.execute("ANALYZE")
                    analyzed = True
                if self.args.vacuum:
                    connection.execute("VACUUM")
                    vacuumed = True
                connection.commit()
            finally:
                connection.close()
        except sqlite3.Error as error:
            raise SQLiteShardBuildError(
                f"Unable to optimize SQLite shard {path}: {error}",
                EXIT_BUILD,
            ) from error

        return analyzed, vacuumed

    def iter_source_records(self) -> Iterator[dict[str, Any]]:
        common = load_common()

        if self.source_mode == "recursive":
            yield from common["iter_canonical_records"](
                self.taxonomy_root,
                strict=self.args.strict,
                deduplicate=self.args.deduplicate,
            )
            return

        seen: set[str] = set()

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
                        raise SQLiteShardBuildError(
                            f"{relative}: {'; '.join(errors)}",
                            EXIT_VALIDATION,
                        )
                    if "missing scientific_name" in errors:
                        continue

                identifier = clean_text(record.get("speciedex_id"))
                if self.args.deduplicate:
                    if identifier in seen:
                        continue
                    seen.add(identifier)

                yield record

    def build_shards(self) -> None:
        common = load_common()
        completed_ids = self.restore_completed_shards()

        chunks = common["chunk_records"](
            self.iter_source_records(),
            rows_per_shard=self.args.rows_per_shard,
            target_bytes=self.args.target_bytes,
        )

        for index, records in enumerate(chunks, 1):
            shard_id = f"{index:06d}"
            filename = f"speciedex-{shard_id}.sqlite3"
            destination = self.output / filename

            if shard_id in completed_ids and destination.is_file():
                self.logger.info(
                    "Skipping completed shard %s during resume.",
                    shard_id,
                )
                continue

            self.state.current_shard = shard_id
            self.state.status = "running"
            self.save_state()

            started_at = utc_now()
            started = time.monotonic()

            if self.args.dry_run:
                record_count = len(records)
                metadata: dict[str, Any] = {
                    "id": shard_id,
                    "shard_id": shard_id,
                    "path": filename,
                    "filename": filename,
                    "records": record_count,
                    "bytes": 0,
                    "sha256": "",
                }
                analyzed = False
                vacuumed = False
                integrity = "not-checked"
                self.logger.info(
                    "Dry run: would build shard %s with %d record(s).",
                    shard_id,
                    record_count,
                )
            else:
                metadata = dict(
                    common["build_sqlite_shard"](
                        records,
                        destination,
                        shard_id=shard_id,
                        analyze=False,
                        vacuum=False,
                    )
                )

                analyzed, vacuumed = self.optimize_sqlite(destination)
                integrity = (
                    self.sqlite_integrity_check(destination)
                    if self.args.verify_each
                    else "not-checked"
                )
                record_count = self.sqlite_record_count(destination)

                if record_count != len(records):
                    destination.unlink(missing_ok=True)
                    raise SQLiteShardBuildError(
                        f"Shard {filename} record count mismatch: "
                        f"input={len(records)}, sqlite={record_count}.",
                        EXIT_BUILD,
                    )

            elapsed = time.monotonic() - started
            size = 0 if self.args.dry_run else destination.stat().st_size
            digest = "" if self.args.dry_run else sha256_file(destination)

            if size > self.args.max_bytes:
                destination.unlink(missing_ok=True)
                raise SQLiteShardBuildError(
                    f"Shard {filename} exceeds maximum size: "
                    f"{size} > {self.args.max_bytes} bytes.",
                    EXIT_BUILD,
                )

            metadata.update(
                {
                    "id": shard_id,
                    "shard_id": shard_id,
                    "path": filename,
                    "filename": filename,
                    "records": record_count,
                    "bytes": size,
                    "sha256": digest,
                }
            )
            self.shards.append(metadata)

            summary = ShardSummary(
                shard_id=shard_id,
                filename=filename,
                records=record_count,
                bytes=size,
                sha256=digest,
                started_at=started_at,
                finished_at=utc_now(),
                duration_seconds=round(elapsed, 6),
                integrity=integrity,
                analyzed=analyzed,
                vacuumed=vacuumed,
            )
            self.shard_summaries.append(summary)
            self.state.total_records += record_count
            self.save_state()

            if (
                self.args.progress_every
                and index % self.args.progress_every == 0
            ):
                self.logger.info(
                    "Built %d shard(s), %d record(s).",
                    index,
                    self.state.total_records,
                )

        if (
            self.expected_records is not None
            and self.state.total_records != self.expected_records
        ):
            raise SQLiteShardBuildError(
                "Canonical archive record count does not match generated "
                f"SQLite shards: expected={self.expected_records}, "
                f"built={self.state.total_records}.",
                EXIT_VERIFICATION,
            )

    def write_manifest(self) -> dict[str, Any]:
        common = load_common()

        source_description = (
            self.archive_manifest_path.as_posix()
            if self.source_mode == "manifest"
            else (
                (self.taxonomy_root / "volumes").as_posix()
                if self.source_mode == "volumes"
                else self.taxonomy_root.as_posix()
            )
        )

        extra = {
            "source_mode": self.source_mode,
            "source_files": self.state.source_files,
            "expected_records": self.expected_records,
            "rows_per_shard": self.args.rows_per_shard,
            "target_bytes": self.args.target_bytes,
            "max_bytes": self.args.max_bytes,
            "strict": self.args.strict,
            "deduplicate": self.args.deduplicate,
            "analyze": self.args.analyze,
            "vacuum": self.args.vacuum,
        }

        if self.args.dry_run:
            manifest = {
                "schema_version": 2,
                "kind": "sqlite",
                "generated_at": utc_now(),
                "source": source_description,
                "shards": self.shards,
                "totals": {
                    "shards": len(self.shards),
                    "records": sum(
                        int(item.get("records", 0))
                        for item in self.shards
                    ),
                    "bytes": 0,
                },
                **extra,
            }
            self.logger.info(
                "Dry run: would write %s",
                self.output / MANIFEST_FILENAME,
            )
            return manifest

        return common["write_manifest"](
            self.output / MANIFEST_FILENAME,
            kind="sqlite",
            shards=self.shards,
            source=source_description,
            extra=extra,
        )

    def verify_outputs(self, manifest: Mapping[str, Any]) -> None:
        if self.args.dry_run or not self.args.verify:
            return

        manifest_path = self.output / MANIFEST_FILENAME
        if not manifest_path.is_file():
            raise SQLiteShardBuildError(
                f"Generated manifest not found: {manifest_path}",
                EXIT_VERIFICATION,
            )

        try:
            persisted = json.loads(
                manifest_path.read_text(encoding="utf-8")
            )
        except json.JSONDecodeError as error:
            raise SQLiteShardBuildError(
                f"Generated manifest contains invalid JSON: {error}",
                EXIT_VERIFICATION,
            ) from error

        if not isinstance(persisted, Mapping):
            raise SQLiteShardBuildError(
                "Generated manifest must be a JSON object.",
                EXIT_VERIFICATION,
            )

        shard_paths = sorted(self.output.glob(SHARD_PATTERN))
        expected_shards = int(
            manifest.get("totals", {}).get("shards", len(self.shards))
        )

        if len(shard_paths) != expected_shards:
            raise SQLiteShardBuildError(
                f"Shard count mismatch: manifest={expected_shards}, "
                f"files={len(shard_paths)}",
                EXIT_VERIFICATION,
            )

        manifest_entries = {
            clean_text(
                shard.get("filename", shard.get("path"))
            ): shard
            for shard in manifest.get("shards", [])
            if isinstance(shard, Mapping)
        }

        actual_records = 0

        for path in shard_paths:
            self.sqlite_integrity_check(path)
            actual_records += self.sqlite_record_count(path)

            if path.stat().st_size > self.args.max_bytes:
                raise SQLiteShardBuildError(
                    f"Shard exceeds maximum size: {path}",
                    EXIT_VERIFICATION,
                )

            entry = manifest_entries.get(path.name)
            if entry is None:
                raise SQLiteShardBuildError(
                    f"Shard missing from manifest: {path.name}",
                    EXIT_VERIFICATION,
                )

            expected_size = int(entry.get("bytes", -1))
            if expected_size != path.stat().st_size:
                raise SQLiteShardBuildError(
                    f"Shard size mismatch for {path.name}: "
                    f"manifest={expected_size}, "
                    f"actual={path.stat().st_size}.",
                    EXIT_VERIFICATION,
                )

            expected_digest = clean_text(entry.get("sha256"))
            actual_digest = sha256_file(path)
            if expected_digest != actual_digest:
                raise SQLiteShardBuildError(
                    f"Shard checksum mismatch for {path.name}: "
                    f"manifest={expected_digest}, actual={actual_digest}.",
                    EXIT_VERIFICATION,
                )

        manifest_records = int(
            manifest.get("totals", {}).get("records", actual_records)
        )

        if manifest_records != actual_records:
            raise SQLiteShardBuildError(
                f"Record count mismatch: manifest={manifest_records}, "
                f"sqlite={actual_records}.",
                EXIT_VERIFICATION,
            )

        if (
            self.expected_records is not None
            and actual_records != self.expected_records
        ):
            raise SQLiteShardBuildError(
                f"Archive-to-SQLite record count mismatch: "
                f"archive={self.expected_records}, "
                f"sqlite={actual_records}.",
                EXIT_VERIFICATION,
            )

    def write_summary(
        self,
        manifest: Mapping[str, Any] | None,
        exit_code: int,
    ) -> None:
        elapsed = time.monotonic() - self.started

        payload = {
            "schema_version": 2,
            "status": self.state.status,
            "exit_code": exit_code,
            "started_at": self.state.started_at,
            "finished_at": self.state.finished_at or utc_now(),
            "duration_seconds": round(elapsed, 6),
            "duration": human_duration(elapsed),
            "taxonomy_root": str(self.taxonomy_root),
            "output": str(self.output),
            "source_mode": self.source_mode,
            "source_files": self.state.source_files,
            "expected_records": self.expected_records,
            "options": {
                "rows_per_shard": self.args.rows_per_shard,
                "target_bytes": self.args.target_bytes,
                "max_bytes": self.args.max_bytes,
                "clean": self.args.clean,
                "resume": self.args.resume,
                "verify": self.args.verify,
                "verify_each": self.args.verify_each,
                "strict": self.args.strict,
                "deduplicate": self.args.deduplicate,
                "analyze": self.args.analyze,
                "vacuum": self.args.vacuum,
                "dry_run": self.args.dry_run,
            },
            "totals": (
                dict(manifest.get("totals", {}))
                if isinstance(manifest, Mapping)
                else {
                    "shards": len(self.shards),
                    "records": self.state.total_records,
                }
            ),
            "shards": [
                asdict(summary) for summary in self.shard_summaries
            ],
            "last_error": self.state.last_error,
            "interrupted": self.state.interrupted,
        }

        atomic_write_json(self.summary_path, payload)

    def run(self) -> int:
        self.configure_logging()
        manifest: Mapping[str, Any] | None = None

        try:
            self.validate()
            self.clean_outputs()
            self.build_shards()
            manifest = self.write_manifest()
            self.verify_outputs(manifest)

            self.state.status = "success"
            self.state.finished_at = utc_now()
            self.state.current_shard = ""
            self.save_state()
            self.write_summary(manifest, EXIT_SUCCESS)

        except KeyboardInterrupt:
            self.state.status = "interrupted"
            self.state.interrupted = True
            self.state.finished_at = utc_now()
            self.state.last_error = "Build interrupted by user."
            self.save_state()
            self.write_summary(manifest, EXIT_INTERRUPTED)
            self.logger.error("SQLite shard build interrupted.")
            return EXIT_INTERRUPTED

        except SQLiteShardBuildError as error:
            self.state.status = "failed"
            self.state.finished_at = utc_now()
            self.state.last_error = str(error)
            self.save_state()
            self.write_summary(manifest, error.exit_code)
            self.logger.error("%s", error)
            return error.exit_code

        except Exception as error:
            self.state.status = "failed"
            self.state.finished_at = utc_now()
            self.state.last_error = f"{type(error).__name__}: {error}"
            self.save_state()
            self.write_summary(manifest, EXIT_BUILD)
            self.logger.error(
                "SQLite shard build failed: %s",
                error,
            )
            if self.args.verbose:
                self.logger.exception("Detailed failure")
            return EXIT_BUILD

        totals = manifest.get("totals", {}) if manifest else {}
        self.logger.info(
            "Built %s SQLite shard(s) with %s record(s) in %s.",
            totals.get("shards", len(self.shards)),
            totals.get("records", self.state.total_records),
            human_duration(time.monotonic() - self.started),
        )
        return EXIT_SUCCESS


def parse_args(
    argv: Sequence[str] | None = None,
) -> argparse.Namespace:
    default_rows, default_target, default_max = default_values()

    parser = argparse.ArgumentParser(
        description=(
            "Build deterministic Speciedex SQLite shards from canonical "
            "taxonomy archive volumes."
        ),
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )

    parser.add_argument(
        "--taxonomy-root",
        type=Path,
        default=Path("static/data/taxonomy"),
        help="Root directory containing the canonical taxonomy archive.",
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
            "Archive source discovery mode. auto prefers manifest-declared "
            "volumes, then taxonomy/volumes. recursive is legacy-only."
        ),
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("static/data/db/sqlite"),
        help="Destination directory for generated SQLite shards.",
    )
    parser.add_argument(
        "--rows-per-shard",
        type=int,
        default=default_rows,
        help="Maximum logical records per shard.",
    )
    parser.add_argument(
        "--target-bytes",
        type=int,
        default=default_target,
        help="Approximate target logical shard size.",
    )
    parser.add_argument(
        "--max-bytes",
        type=int,
        default=default_max,
        help="Maximum allowed SQLite shard file size.",
    )
    parser.add_argument(
        "--minimum-free-bytes",
        type=int,
        default=256 * 1024 * 1024,
        help="Minimum required free disk space beneath the output directory.",
    )
    parser.add_argument(
        "--expect-records",
        type=int,
        default=None,
        help=(
            "Expected canonical record count. When omitted, the value is "
            "read from the archive manifest when available."
        ),
    )
    parser.add_argument(
        "--state-file",
        type=Path,
        default=None,
        help="Path to persistent build-state JSON.",
    )
    parser.add_argument(
        "--summary-file",
        type=Path,
        default=None,
        help="Path to build-summary JSON.",
    )
    parser.add_argument(
        "--clean",
        action="store_true",
        help="Remove existing generated SQLite outputs before building.",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Reuse validated completed shards from the build-state file.",
    )
    parser.add_argument(
        "--verify",
        action="store_true",
        help=(
            "Verify generated manifest, shard counts, SQLite row counts, "
            "sizes, checksums, and integrity."
        ),
    )
    parser.add_argument(
        "--verify-each",
        action="store_true",
        help="Run PRAGMA integrity_check immediately after each shard build.",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Fail on malformed or incomplete canonical taxonomy records.",
    )
    parser.add_argument(
        "--deduplicate",
        action="store_true",
        help="Keep only the first occurrence of each speciedex_id.",
    )
    parser.add_argument(
        "--analyze",
        action="store_true",
        help="Run ANALYZE on every generated SQLite shard.",
    )
    parser.add_argument(
        "--vacuum",
        action="store_true",
        help="Run VACUUM on every generated SQLite shard.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Read and chunk records without writing SQLite files.",
    )
    parser.add_argument(
        "--progress-every",
        type=int,
        default=10,
        help="Emit progress after this many shards; use 0 to disable.",
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

    if args.rows_per_shard < 1:
        parser.error("--rows-per-shard must be at least 1.")

    if args.target_bytes < 1:
        parser.error("--target-bytes must be at least 1.")

    if args.max_bytes < 1:
        parser.error("--max-bytes must be at least 1.")

    if args.target_bytes > args.max_bytes:
        parser.error("--target-bytes cannot exceed --max-bytes.")

    if args.minimum_free_bytes < 0:
        parser.error("--minimum-free-bytes cannot be negative.")

    if args.expect_records is not None and args.expect_records < 0:
        parser.error("--expect-records cannot be negative.")

    if args.progress_every < 0:
        parser.error("--progress-every cannot be negative.")

    if args.verbose and args.quiet:
        parser.error("--verbose and --quiet cannot be used together.")

    if args.clean and args.resume:
        parser.error("--clean and --resume cannot be used together.")

    return args


def main(argv: Sequence[str] | None = None) -> int:
    return SQLiteShardBuilder(parse_args(argv)).run()


if __name__ == "__main__":
    raise SystemExit(main())
