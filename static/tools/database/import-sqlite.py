#!/usr/bin/env python3
"""
Import Speciedex SQLite shards back into canonical JSONL.

Expected location:
    static/tools/database/import-sqlite.py

The importer reads manifest-managed SQLite shards, validates safe paths,
checksums, file sizes, schema, metadata, row counts, and integrity, then emits
a deterministic canonical JSONL stream with rejected-record and summary reports.

This is a controlled import path for reviewing database-derived changes before
they are reconciled into static/data/taxonomy/. It does not make SQLite
authoritative and does not overwrite canonical archive volumes directly.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
"""

from __future__ import annotations

import argparse
import gzip
import json
import logging
import re
import sqlite3
import tempfile
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterator, Mapping, Sequence

from common import (
    CANONICAL_SCHEMA_VERSION,
    SCHEMA_VERSION,
    SQLITE_COLUMNS,
    atomic_write_json,
    clean_text,
    load_manifest,
    sha256_file,
    stable_json,
    utc_now,
    validate_canonical_record,
    validate_manifest,
    write_jsonl,
)


EXIT_SUCCESS = 0
EXIT_INVALID = 1
EXIT_CONFIGURATION = 2
EXIT_INTERRUPTED = 130

DEFAULT_SQLITE_ROOT = Path("static/data/db/sqlite")
DEFAULT_OUTPUT = Path(
    "static/data/taxonomy/imported/sqlite-import.jsonl"
)
DEFAULT_REJECTED = Path(
    "static/data/taxonomy/imported/sqlite-import-rejected.jsonl"
)
DEFAULT_SUMMARY = Path(
    "static/data/taxonomy/imported/sqlite-import-summary.json"
)

MANIFEST_FILENAME = "manifest.json"
REQUIRED_TABLES = frozenset({"taxa", "metadata"})


class SQLiteImportError(RuntimeError):
    def __init__(self, message: str, exit_code: int = EXIT_INVALID) -> None:
        super().__init__(message)
        self.exit_code = exit_code


@dataclass
class ShardImportResult:
    shard_id: str
    path: str
    exists: bool = False
    manifest_records: int | None = None
    actual_records: int | None = None
    imported_records: int = 0
    rejected_records: int = 0
    duplicate_records: int = 0
    manifest_bytes: int | None = None
    actual_bytes: int | None = None
    size_ok: bool | None = None
    manifest_sha256: str = ""
    actual_sha256: str = ""
    checksum_ok: bool | None = None
    integrity: str = ""
    schema_ok: bool | None = None
    metadata_ok: bool | None = None
    row_count_ok: bool | None = None
    issues: list[str] = field(default_factory=list)
    duration_seconds: float = 0.0


def human_duration(seconds: float) -> str:
    seconds = max(0, int(round(seconds)))
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def integer_or_none(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and re.fullmatch(r"-?\d+", value.strip()):
        return int(value.strip())
    return None


def shard_id(shard: Mapping[str, Any]) -> str:
    return clean_text(shard.get("id") or shard.get("shard_id"))


def shard_path(shard: Mapping[str, Any]) -> str:
    return clean_text(shard.get("path") or shard.get("filename"))


def safe_path(root: Path, relative: str) -> Path:
    if not relative:
        raise SQLiteImportError(
            "Manifest shard path cannot be empty.",
            EXIT_CONFIGURATION,
        )

    candidate = Path(relative)
    if candidate.is_absolute():
        raise SQLiteImportError(
            f"Manifest shard path must be relative: {relative}",
            EXIT_CONFIGURATION,
        )

    resolved_root = root.resolve()
    resolved = (resolved_root / candidate).resolve()

    try:
        resolved.relative_to(resolved_root)
    except ValueError as error:
        raise SQLiteImportError(
            f"Manifest path escapes SQLite root: {relative}",
            EXIT_CONFIGURATION,
        ) from error

    return resolved


def quote_identifier(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def sqlite_columns(
    connection: sqlite3.Connection,
    table: str,
) -> list[str]:
    return [
        clean_text(row[1])
        for row in connection.execute(
            f"PRAGMA table_info({quote_identifier(table)})"
        )
    ]


def stream_sqlite_rows(path: Path) -> Iterator[dict[str, Any]]:
    uri = f"file:{path.resolve()}?mode=ro&immutable=1"
    connection = sqlite3.connect(uri, uri=True)
    connection.row_factory = sqlite3.Row

    try:
        columns = ",".join(
            quote_identifier(column) for column in SQLITE_COLUMNS
        )
        query = (
            f"SELECT {columns} FROM taxa "
            "ORDER BY speciedex_id COLLATE BINARY"
        )
        for row in connection.execute(query):
            yield dict(row)
    finally:
        connection.close()


def verify_jsonl_count(path: Path) -> int:
    opener = (
        gzip.open
        if path.name.casefold().endswith(".gz")
        else open
    )
    count = 0

    with opener(path, "rt", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                value = json.loads(stripped)
            except json.JSONDecodeError as error:
                raise SQLiteImportError(
                    f"{path}:{line_number}: invalid JSON: {error}"
                ) from error
            if not isinstance(value, Mapping):
                raise SQLiteImportError(
                    f"{path}:{line_number}: expected JSON object"
                )
            count += 1

    return count


class SQLiteImporter:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.root = args.sqlite_root.resolve()
        self.manifest_path = (
            args.manifest or self.root / MANIFEST_FILENAME
        ).resolve()
        self.output = args.output.resolve()
        self.rejected_path = args.rejected.resolve()
        self.summary_path = args.summary.resolve()
        self.logger = logging.getLogger(
            "speciedex.database.import_sqlite"
        )
        self.started = time.monotonic()

        self.results: list[ShardImportResult] = []
        self.issues: list[str] = []
        self.rejected: list[dict[str, Any]] = []
        self.records_by_id: dict[str, dict[str, Any]] = {}
        self.record_order: list[str] = []
        self.anonymous_records: list[dict[str, Any]] = []
        self.total_accepted_rows = 0

    def configure_logging(self) -> None:
        level = logging.DEBUG if self.args.verbose else logging.INFO
        if self.args.quiet:
            level = logging.WARNING

        logging.basicConfig(
            level=level,
            format="%(asctime)s %(levelname)s %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )

    def add_issue(
        self,
        message: str,
        result: ShardImportResult | None = None,
    ) -> None:
        self.issues.append(message)
        if result is not None:
            result.issues.append(message)

    def validate(self) -> None:
        if not self.root.exists():
            raise SQLiteImportError(
                f"SQLite root does not exist: {self.root}",
                EXIT_CONFIGURATION,
            )

        if not self.root.is_dir():
            raise SQLiteImportError(
                f"SQLite root is not a directory: {self.root}",
                EXIT_CONFIGURATION,
            )

        if not self.manifest_path.is_file():
            raise SQLiteImportError(
                f"SQLite manifest not found: {self.manifest_path}",
                EXIT_CONFIGURATION,
            )

        try:
            self.manifest_path.relative_to(self.root)
        except ValueError:
            if not self.args.allow_external_manifest:
                raise SQLiteImportError(
                    "Manifest must be beneath --sqlite-root unless "
                    "--allow-external-manifest is supplied.",
                    EXIT_CONFIGURATION,
                )

        destinations = {
            self.output,
            self.rejected_path,
            self.summary_path,
        }
        if len(destinations) != 3:
            raise SQLiteImportError(
                "--output, --rejected, and --summary must be distinct paths.",
                EXIT_CONFIGURATION,
            )

        for destination in destinations:
            destination.parent.mkdir(parents=True, exist_ok=True)
            probe: Path | None = None
            try:
                with tempfile.NamedTemporaryFile(
                    "w",
                    encoding="utf-8",
                    delete=False,
                    dir=destination.parent,
                    prefix=".speciedex-import-write-test.",
                ) as handle:
                    handle.write("ok\n")
                    probe = Path(handle.name)
            except OSError as error:
                raise SQLiteImportError(
                    f"Destination directory is not writable: "
                    f"{destination.parent}: {error}",
                    EXIT_CONFIGURATION,
                ) from error
            finally:
                if probe is not None:
                    probe.unlink(missing_ok=True)

    def reject(
        self,
        *,
        path: Path,
        shard_identifier: str,
        row_number: int,
        reason: str,
        record: Mapping[str, Any] | None = None,
    ) -> None:
        self.rejected.append(
            {
                "shard_id": shard_identifier,
                "source_file": path.as_posix(),
                "row_number": row_number,
                "reason": clean_text(reason),
                "record": dict(record or {}),
            }
        )

    def inspect_sqlite(
        self,
        path: Path,
        result: ShardImportResult,
    ) -> None:
        uri = f"file:{path.resolve()}?mode=ro&immutable=1"
        connection = sqlite3.connect(uri, uri=True)

        try:
            integrity_row = connection.execute(
                "PRAGMA integrity_check"
            ).fetchone()
            result.integrity = clean_text(
                integrity_row[0] if integrity_row else ""
            )

            if result.integrity.casefold() != "ok":
                self.add_issue(
                    f"SQLite integrity failure: "
                    f"{path}: {result.integrity}",
                    result,
                )

            present_tables = {
                clean_text(row[0])
                for row in connection.execute(
                    "SELECT name FROM sqlite_master "
                    "WHERE type='table'"
                )
            }
            result.schema_ok = REQUIRED_TABLES.issubset(present_tables)

            if not result.schema_ok:
                missing = sorted(REQUIRED_TABLES - present_tables)
                self.add_issue(
                    f"SQLite schema missing table(s) in {path}: "
                    f"{missing}",
                    result,
                )
                return

            present_columns = sqlite_columns(connection, "taxa")
            missing_columns = [
                column
                for column in SQLITE_COLUMNS
                if column not in present_columns
            ]

            if missing_columns:
                result.schema_ok = False
                self.add_issue(
                    f"SQLite taxa schema missing column(s) in {path}: "
                    f"{missing_columns}",
                    result,
                )

            metadata = {
                clean_text(row[0]): clean_text(row[1])
                for row in connection.execute(
                    "SELECT key, value FROM metadata"
                )
            }

            metadata_issues: list[str] = []
            metadata_id = metadata.get("shard_id", "")
            if metadata_id and metadata_id != result.shard_id:
                metadata_issues.append(
                    f"shard_id manifest={result.shard_id}, "
                    f"metadata={metadata_id}"
                )

            metadata_records = integer_or_none(metadata.get("records"))
            if (
                metadata_records is not None
                and result.manifest_records is not None
                and metadata_records != result.manifest_records
            ):
                metadata_issues.append(
                    f"records manifest={result.manifest_records}, "
                    f"metadata={metadata_records}"
                )

            metadata_schema = integer_or_none(
                metadata.get("schema_version")
            )
            if (
                metadata_schema is not None
                and metadata_schema != SCHEMA_VERSION
            ):
                metadata_issues.append(
                    f"schema_version expected={SCHEMA_VERSION}, "
                    f"metadata={metadata_schema}"
                )

            metadata_canonical = integer_or_none(
                metadata.get("canonical_schema_version")
            )
            if (
                metadata_canonical is not None
                and metadata_canonical != CANONICAL_SCHEMA_VERSION
            ):
                metadata_issues.append(
                    "canonical_schema_version "
                    f"expected={CANONICAL_SCHEMA_VERSION}, "
                    f"metadata={metadata_canonical}"
                )

            result.metadata_ok = not metadata_issues
            for issue in metadata_issues:
                self.add_issue(
                    f"SQLite metadata mismatch for {path}: {issue}",
                    result,
                )

            row = connection.execute(
                "SELECT COUNT(*) FROM taxa"
            ).fetchone()
            result.actual_records = int(row[0] if row else 0)

            if result.manifest_records is not None:
                result.row_count_ok = (
                    result.actual_records
                    == result.manifest_records
                )
                if not result.row_count_ok:
                    self.add_issue(
                        f"SQLite row-count mismatch for {path}: "
                        f"manifest={result.manifest_records}, "
                        f"actual={result.actual_records}",
                        result,
                    )

        finally:
            connection.close()

    def accept_record(
        self,
        record: dict[str, Any],
        result: ShardImportResult,
    ) -> None:
        record_id = clean_text(record.get("speciedex_id"))

        if not self.args.deduplicate:
            synthetic = f"@row:{len(self.record_order):020d}"
            self.records_by_id[synthetic] = record
            self.record_order.append(synthetic)
            self.total_accepted_rows += 1
            return

        if not record_id:
            self.anonymous_records.append(record)
            self.total_accepted_rows += 1
            return

        if record_id not in self.records_by_id:
            self.records_by_id[record_id] = record
            self.record_order.append(record_id)
            self.total_accepted_rows += 1
            return

        result.duplicate_records += 1

        if self.args.duplicate_policy == "first":
            return

        if self.args.duplicate_policy == "last":
            self.records_by_id[record_id] = record
            return

        raise ValueError(f"duplicate speciedex_id: {record_id}")

    def import_shard(
        self,
        shard: Mapping[str, Any],
    ) -> ShardImportResult:
        started = time.monotonic()
        identifier = shard_id(shard)
        relative = shard_path(shard)

        result = ShardImportResult(
            shard_id=identifier,
            path=relative,
            manifest_records=integer_or_none(
                shard.get("records", shard.get("rows"))
            ),
            manifest_bytes=integer_or_none(shard.get("bytes")),
            manifest_sha256=clean_text(shard.get("sha256")),
        )

        if not identifier:
            self.add_issue(
                "Manifest shard is missing an id.",
                result,
            )

        if not relative:
            self.add_issue(
                f"SQLite shard {identifier or '<unknown>'} "
                "has no path.",
                result,
            )
            result.duration_seconds = round(
                time.monotonic() - started,
                6,
            )
            return result

        path = safe_path(self.root, relative)
        result.path = path.as_posix()
        result.exists = path.is_file()

        if not result.exists:
            self.add_issue(
                f"Missing SQLite shard: {path}",
                result,
            )
            result.duration_seconds = round(
                time.monotonic() - started,
                6,
            )
            return result

        result.actual_bytes = path.stat().st_size
        if result.manifest_bytes is not None:
            result.size_ok = (
                result.actual_bytes == result.manifest_bytes
            )
            if not result.size_ok:
                self.add_issue(
                    f"File-size mismatch for {path}: "
                    f"manifest={result.manifest_bytes}, "
                    f"actual={result.actual_bytes}",
                    result,
                )
                if self.args.strict:
                    result.duration_seconds = round(
                        time.monotonic() - started,
                        6,
                    )
                    return result

        result.actual_sha256 = sha256_file(path)
        if result.manifest_sha256 and self.args.verify_checksums:
            result.checksum_ok = (
                result.actual_sha256.casefold()
                == result.manifest_sha256.casefold()
            )
            if not result.checksum_ok:
                self.add_issue(
                    f"Checksum mismatch: {path}",
                    result,
                )
                if self.args.strict:
                    result.duration_seconds = round(
                        time.monotonic() - started,
                        6,
                    )
                    return result

        try:
            self.inspect_sqlite(path, result)
        except sqlite3.Error as error:
            self.add_issue(
                f"Unable to inspect SQLite shard {path}: {error}",
                result,
            )
            if self.args.strict:
                raise SQLiteImportError(
                    f"Unable to inspect SQLite shard "
                    f"{path}: {error}"
                ) from error
            result.duration_seconds = round(
                time.monotonic() - started,
                6,
            )
            return result

        if (
            self.args.strict
            and (
                result.integrity.casefold() != "ok"
                or result.schema_ok is False
                or result.metadata_ok is False
                or result.row_count_ok is False
            )
        ):
            result.duration_seconds = round(
                time.monotonic() - started,
                6,
            )
            return result

        if result.schema_ok is False:
            result.duration_seconds = round(
                time.monotonic() - started,
                6,
            )
            return result

        try:
            for row_number, record in enumerate(
                stream_sqlite_rows(path),
                1,
            ):
                try:
                    validation_errors = validate_canonical_record(
                        record
                    )
                    if validation_errors:
                        raise ValueError(
                            "; ".join(validation_errors)
                        )

                    self.accept_record(
                        dict(record),
                        result,
                    )
                    result.imported_records += 1

                except Exception as error:
                    result.rejected_records += 1
                    self.reject(
                        path=path,
                        shard_identifier=identifier,
                        row_number=row_number,
                        reason=str(error),
                        record=record,
                    )
                    if self.args.strict:
                        raise SQLiteImportError(
                            f"{path}: row {row_number}: {error}"
                        ) from error

        except sqlite3.Error as error:
            self.add_issue(
                f"Failed reading SQLite shard {path}: {error}",
                result,
            )
            if self.args.strict:
                raise SQLiteImportError(
                    f"Failed reading SQLite shard {path}: {error}"
                ) from error

        parsed_total = (
            result.imported_records
            + result.rejected_records
        )
        if (
            result.actual_records is not None
            and parsed_total != result.actual_records
        ):
            self.add_issue(
                f"SQLite parsed row-count mismatch for {path}: "
                f"actual={result.actual_records}, "
                f"parsed={parsed_total}",
                result,
            )

        result.duration_seconds = round(
            time.monotonic() - started,
            6,
        )
        return result

    def output_records(self) -> list[dict[str, Any]]:
        records = [
            self.records_by_id[key]
            for key in self.record_order
            if key in self.records_by_id
        ]
        records.extend(self.anonymous_records)

        if self.args.sort:
            records.sort(
                key=lambda record: (
                    clean_text(
                        record.get("speciedex_id")
                    ),
                    clean_text(
                        record.get("record_hash")
                    ),
                    stable_json(record),
                )
            )

        return records

    def build_summary(
        self,
        records: Sequence[Mapping[str, Any]],
        exit_code: int,
    ) -> dict[str, Any]:
        elapsed = time.monotonic() - self.started
        return {
            "schema_version": 3,
            "generated_at": utc_now(),
            "status": (
                "success"
                if exit_code == EXIT_SUCCESS
                else "failed"
            ),
            "exit_code": exit_code,
            "sqlite_root": self.root.as_posix(),
            "manifest": self.manifest_path.as_posix(),
            "output": self.output.as_posix(),
            "rejected_output": self.rejected_path.as_posix(),
            "valid": not self.issues and not self.rejected,
            "duration_seconds": round(elapsed, 6),
            "duration": human_duration(elapsed),
            "options": {
                "strict": self.args.strict,
                "verify_checksums": self.args.verify_checksums,
                "verify_output": self.args.verify_output,
                "deduplicate": self.args.deduplicate,
                "duplicate_policy": self.args.duplicate_policy,
                "sort": self.args.sort,
                "fail_on_issue": self.args.fail_on_issue,
                "dry_run": self.args.dry_run,
            },
            "totals": {
                "shards": len(self.results),
                "source_rows_accepted": self.total_accepted_rows,
                "output_records": len(records),
                "rejected_records": len(self.rejected),
                "duplicate_records": sum(
                    result.duplicate_records
                    for result in self.results
                ),
                "issues": len(self.issues),
            },
            "issues": self.issues,
            "shards": [
                asdict(result) for result in self.results
            ],
        }

    def write_outputs(
        self,
        records: Sequence[Mapping[str, Any]],
        exit_code: int,
    ) -> None:
        if self.args.dry_run:
            self.logger.info(
                "Dry run: would write %d imported and "
                "%d rejected records.",
                len(records),
                len(self.rejected),
            )
            return

        write_jsonl(
            self.output,
            records,
            gzip_output=(
                self.output.name.casefold().endswith(".gz")
            ),
        )
        write_jsonl(
            self.rejected_path,
            self.rejected,
            gzip_output=(
                self.rejected_path.name.casefold().endswith(".gz")
            ),
        )
        atomic_write_json(
            self.summary_path,
            self.build_summary(records, exit_code),
        )

    def verify_output(
        self,
        records: Sequence[Mapping[str, Any]],
    ) -> None:
        if self.args.dry_run or not self.args.verify_output:
            return

        actual_records = verify_jsonl_count(self.output)
        if actual_records != len(records):
            raise SQLiteImportError(
                f"Output count mismatch: "
                f"expected={len(records)}, actual={actual_records}"
            )

        actual_rejected = verify_jsonl_count(
            self.rejected_path
        )
        if actual_rejected != len(self.rejected):
            raise SQLiteImportError(
                f"Rejected output count mismatch: "
                f"expected={len(self.rejected)}, "
                f"actual={actual_rejected}"
            )

        try:
            summary = json.loads(
                self.summary_path.read_text(encoding="utf-8")
            )
        except json.JSONDecodeError as error:
            raise SQLiteImportError(
                f"Import summary is invalid JSON: {error}"
            ) from error

        if not isinstance(summary, Mapping):
            raise SQLiteImportError(
                "Import summary is not a JSON object."
            )

        summary_records = integer_or_none(
            summary.get("totals", {}).get("output_records")
            if isinstance(summary.get("totals"), Mapping)
            else None
        )
        if summary_records != len(records):
            raise SQLiteImportError(
                f"Summary output count mismatch: "
                f"summary={summary_records}, "
                f"actual={len(records)}"
            )

    def run(self) -> int:
        self.configure_logging()
        records: list[dict[str, Any]] = []
        exit_code = EXIT_SUCCESS

        try:
            self.validate()
            manifest = load_manifest(self.manifest_path)
            manifest_errors = validate_manifest(manifest)
            if manifest_errors:
                raise SQLiteImportError(
                    "Invalid SQLite manifest: "
                    + "; ".join(manifest_errors),
                    EXIT_CONFIGURATION,
                )

            kind = clean_text(manifest.get("kind"))
            if kind and kind != "sqlite":
                raise SQLiteImportError(
                    f"Manifest kind must be 'sqlite', found: {kind}",
                    EXIT_CONFIGURATION,
                )

            shards = manifest.get("shards", [])
            if not isinstance(shards, list):
                raise SQLiteImportError(
                    "SQLite manifest shards must be an array.",
                    EXIT_CONFIGURATION,
                )

            seen_ids: set[str] = set()
            seen_paths: set[str] = set()

            for position, shard in enumerate(shards, 1):
                if not isinstance(shard, Mapping):
                    self.add_issue(
                        f"Manifest shard {position} is not an object."
                    )
                    continue

                identifier = shard_id(shard)
                relative = shard_path(shard)

                if identifier and identifier in seen_ids:
                    self.add_issue(
                        f"Duplicate manifest shard id: {identifier}"
                    )
                    continue

                if relative and relative in seen_paths:
                    self.add_issue(
                        f"Duplicate manifest shard path: {relative}"
                    )
                    continue

                if identifier:
                    seen_ids.add(identifier)
                if relative:
                    seen_paths.add(relative)

                result = self.import_shard(shard)
                self.results.append(result)

            records = self.output_records()

            if self.issues and self.args.fail_on_issue:
                exit_code = EXIT_INVALID

            self.write_outputs(records, exit_code)
            self.verify_output(records)

        except KeyboardInterrupt:
            self.logger.error("SQLite import interrupted.")
            return EXIT_INTERRUPTED

        except SQLiteImportError as error:
            exit_code = error.exit_code
            self.logger.error("%s", error)
            if not self.args.dry_run:
                try:
                    records = self.output_records()
                    atomic_write_json(
                        self.summary_path,
                        self.build_summary(records, exit_code),
                    )
                except Exception:
                    pass
            return exit_code

        except Exception as error:
            exit_code = EXIT_CONFIGURATION
            self.logger.error(
                "SQLite import failed: %s",
                error,
            )
            if self.args.verbose:
                self.logger.exception("Detailed failure")
            if not self.args.dry_run:
                try:
                    records = self.output_records()
                    atomic_write_json(
                        self.summary_path,
                        self.build_summary(records, exit_code),
                    )
                except Exception:
                    pass
            return exit_code

        if exit_code != EXIT_SUCCESS:
            for issue in self.issues:
                self.logger.error("%s", issue)
            return exit_code

        self.logger.info(
            "Imported %d records from %d SQLite shard(s) "
            "with %d rejected records in %s.",
            len(records),
            len(self.results),
            len(self.rejected),
            human_duration(time.monotonic() - self.started),
        )
        return EXIT_SUCCESS


def parse_args(
    argv: Sequence[str] | None = None,
) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Import manifest-managed SQLite shards into a "
            "canonical review JSONL stream."
        ),
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )

    parser.add_argument(
        "--sqlite-root",
        type=Path,
        default=DEFAULT_SQLITE_ROOT,
        help="Directory containing SQLite shards and manifest.json.",
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=None,
        help="SQLite shard manifest; defaults to sqlite-root/manifest.json.",
    )
    parser.add_argument(
        "--allow-external-manifest",
        action="store_true",
        help="Allow --manifest to be outside --sqlite-root.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help="Canonical imported JSONL destination.",
    )
    parser.add_argument(
        "--rejected",
        type=Path,
        default=DEFAULT_REJECTED,
        help="Rejected-record JSONL destination.",
    )
    parser.add_argument(
        "--summary",
        type=Path,
        default=DEFAULT_SUMMARY,
        help="Import-summary JSON destination.",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Stop on integrity, schema, metadata, or record errors.",
    )
    parser.add_argument(
        "--verify-checksums",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Verify shard SHA-256 checksums when present.",
    )
    parser.add_argument(
        "--verify-output",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Re-read generated JSONL outputs and verify counts.",
    )
    parser.add_argument(
        "--deduplicate",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="Deduplicate records by speciedex_id.",
    )
    parser.add_argument(
        "--duplicate-policy",
        choices=("first", "last", "error"),
        default="last",
        help="Policy applied when deduplication finds duplicate IDs.",
    )
    parser.add_argument(
        "--sort",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Sort output deterministically.",
    )
    parser.add_argument(
        "--fail-on-issue",
        action="store_true",
        help="Return nonzero when nonfatal issues were recorded.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Parse and validate without writing output files.",
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

    if args.verbose and args.quiet:
        parser.error(
            "--verbose and --quiet cannot be used together."
        )

    if not args.deduplicate and args.duplicate_policy != "last":
        parser.error(
            "--duplicate-policy only applies when --deduplicate is enabled."
        )

    return args


def main(argv: Sequence[str] | None = None) -> int:
    return SQLiteImporter(parse_args(argv)).run()


if __name__ == "__main__":
    raise SystemExit(main())
