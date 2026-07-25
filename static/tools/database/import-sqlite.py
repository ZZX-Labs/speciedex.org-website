#!/usr/bin/env python3
"""
Import Speciedex SQLite shards back into canonical JSONL.

Expected location:
    static/tools/database/import-sqlite.py

The importer reads manifest-managed SQLite shards, validates their paths,
checksums, schema, metadata, row counts, and integrity, then emits a
deterministic canonical JSONL stream with rejected-record and summary reports.

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
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterator, Mapping, Sequence

from common import (
    SQLITE_COLUMNS,
    atomic_write_json,
    clean_text,
    load_manifest,
    sha256_file,
    sqlite_rows,
    utc_now,
    validate_canonical_record,
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
    imported_records: int = 0
    rejected_records: int = 0
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
    path = (root / relative).resolve()
    try:
        path.relative_to(root.resolve())
    except ValueError as error:
        raise SQLiteImportError(
            f"Manifest path escapes SQLite root: {relative}",
            EXIT_CONFIGURATION,
        ) from error
    return path


def sqlite_table_exists(connection: sqlite3.Connection, table: str) -> bool:
    row = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (table,),
    ).fetchone()
    return row is not None


def sqlite_columns(connection: sqlite3.Connection, table: str) -> set[str]:
    return {
        clean_text(row[1])
        for row in connection.execute(f'PRAGMA table_info("{table}")')
    }


class SQLiteImporter:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.root = args.sqlite_root.resolve()
        self.output = args.output.resolve()
        self.rejected_path = args.rejected.resolve()
        self.summary_path = args.summary.resolve()
        self.logger = logging.getLogger("speciedex.database.import_sqlite")
        self.started = time.monotonic()
        self.results: list[ShardImportResult] = []
        self.issues: list[str] = []
        self.rejected: list[dict[str, Any]] = []
        self.records: list[dict[str, Any]] = []
        self.seen_ids: set[str] = set()

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

        manifest = self.root / "manifest.json"
        if not manifest.is_file():
            raise SQLiteImportError(
                f"SQLite manifest not found: {manifest}",
                EXIT_CONFIGURATION,
            )

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
                "reason": reason,
                "record": dict(record or {}),
            }
        )

    def inspect_sqlite(
        self,
        path: Path,
        result: ShardImportResult,
    ) -> None:
        uri = f"file:{path}?mode=ro"
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
                    f"SQLite integrity failure: {path}: {result.integrity}",
                    result,
                )

            required_tables = {"taxa", "metadata"}
            present_tables = {
                clean_text(row[0])
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
            result.schema_ok = required_tables.issubset(present_tables)
            if not result.schema_ok:
                missing = sorted(required_tables - present_tables)
                self.add_issue(
                    f"SQLite schema missing table(s) in {path}: {missing}",
                    result,
                )
                return

            present_columns = sqlite_columns(connection, "taxa")
            missing_columns = [
                column for column in SQLITE_COLUMNS
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
            metadata_id = metadata.get("shard_id", "")
            result.metadata_ok = (
                not metadata_id or metadata_id == result.shard_id
            )
            if not result.metadata_ok:
                self.add_issue(
                    f"SQLite metadata shard_id mismatch for {path}: "
                    f"manifest={result.shard_id}, metadata={metadata_id}",
                    result,
                )

            rows = int(
                connection.execute("SELECT COUNT(*) FROM taxa").fetchone()[0]
            )
            if result.manifest_records is not None:
                result.row_count_ok = rows == result.manifest_records
                if not result.row_count_ok:
                    self.add_issue(
                        f"SQLite row-count mismatch for {path}: "
                        f"manifest={result.manifest_records}, actual={rows}",
                        result,
                    )
        finally:
            connection.close()

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
            manifest_sha256=clean_text(shard.get("sha256")),
        )

        if not identifier:
            self.add_issue("Manifest shard is missing an id.", result)
        if not relative:
            self.add_issue(
                f"SQLite shard {identifier or '<unknown>'} has no path.",
                result,
            )
            return result

        path = safe_path(self.root, relative)
        result.path = path.as_posix()
        result.exists = path.is_file()

        if not result.exists:
            self.add_issue(f"Missing SQLite shard: {path}", result)
            return result

        result.actual_sha256 = sha256_file(path)
        if result.manifest_sha256 and self.args.verify_checksums:
            result.checksum_ok = (
                result.actual_sha256.casefold()
                == result.manifest_sha256.casefold()
            )
            if not result.checksum_ok:
                self.add_issue(f"Checksum mismatch: {path}", result)
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
                    f"Unable to inspect SQLite shard {path}: {error}"
                ) from error
            return result

        try:
            for row_number, record in enumerate(sqlite_rows(path), 1):
                try:
                    validation_errors = validate_canonical_record(record)
                    if validation_errors:
                        raise ValueError("; ".join(validation_errors))

                    record_id = clean_text(record.get("speciedex_id"))
                    if self.args.deduplicate and record_id in self.seen_ids:
                        if self.args.duplicate_policy == "error":
                            raise ValueError(
                                f"duplicate speciedex_id: {record_id}"
                            )
                        if self.args.duplicate_policy == "first":
                            continue
                        if self.args.duplicate_policy == "last":
                            self.records = [
                                existing
                                for existing in self.records
                                if clean_text(existing.get("speciedex_id"))
                                != record_id
                            ]

                    if record_id:
                        self.seen_ids.add(record_id)

                    self.records.append(dict(record))
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

        parsed_total = result.imported_records + result.rejected_records
        if (
            result.manifest_records is not None
            and parsed_total != result.manifest_records
        ):
            self.add_issue(
                f"Manifest row-count mismatch for {path}: "
                f"manifest={result.manifest_records}, parsed={parsed_total}",
                result,
            )

        result.duration_seconds = round(time.monotonic() - started, 6)
        return result

    def write_outputs(self) -> None:
        if self.args.sort:
            self.records.sort(
                key=lambda record: clean_text(record.get("speciedex_id"))
            )

        if self.args.dry_run:
            self.logger.info(
                "Dry run: would write %d imported and %d rejected records.",
                len(self.records),
                len(self.rejected),
            )
            return

        write_jsonl(
            self.output,
            self.records,
            gzip_output=self.output.name.casefold().endswith(".gz"),
        )
        write_jsonl(
            self.rejected_path,
            self.rejected,
            gzip_output=self.rejected_path.name.casefold().endswith(".gz"),
        )

        elapsed = time.monotonic() - self.started
        summary = {
            "schema_version": 2,
            "generated_at": utc_now(),
            "sqlite_root": self.root.as_posix(),
            "output": self.output.as_posix(),
            "rejected_output": self.rejected_path.as_posix(),
            "valid": not self.issues,
            "duration_seconds": round(elapsed, 6),
            "duration": human_duration(elapsed),
            "options": {
                "strict": self.args.strict,
                "verify_checksums": self.args.verify_checksums,
                "verify_output": self.args.verify_output,
                "deduplicate": self.args.deduplicate,
                "duplicate_policy": self.args.duplicate_policy,
                "sort": self.args.sort,
            },
            "totals": {
                "shards": len(self.results),
                "imported_records": len(self.records),
                "rejected_records": len(self.rejected),
                "issues": len(self.issues),
            },
            "issues": self.issues,
            "shards": [asdict(result) for result in self.results],
        }
        atomic_write_json(self.summary_path, summary)

    def verify_output(self) -> None:
        if self.args.dry_run or not self.args.verify_output:
            return

        if self.output.name.casefold().endswith(".gz"):
            with gzip.open(self.output, "rt", encoding="utf-8") as handle:
                actual = sum(1 for line in handle if line.strip())
        else:
            with self.output.open("r", encoding="utf-8") as handle:
                actual = sum(1 for line in handle if line.strip())

        if actual != len(self.records):
            raise SQLiteImportError(
                f"Output count mismatch: expected {len(self.records)}, "
                f"found {actual}"
            )

        with self.summary_path.open("r", encoding="utf-8") as handle:
            summary = json.load(handle)
        if not isinstance(summary, dict):
            raise SQLiteImportError(
                "Import summary is not a JSON object."
            )

    def run(self) -> int:
        self.configure_logging()

        try:
            self.validate()
            manifest = load_manifest(self.root / "manifest.json")
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

            self.write_outputs()
            self.verify_output()

        except KeyboardInterrupt:
            self.logger.error("SQLite import interrupted.")
            return EXIT_INTERRUPTED
        except SQLiteImportError as error:
            self.logger.error("%s", error)
            return error.exit_code
        except Exception as error:
            self.logger.error("SQLite import failed: %s", error)
            if self.args.verbose:
                self.logger.exception("Detailed failure")
            return EXIT_CONFIGURATION

        if self.issues and self.args.fail_on_issue:
            for issue in self.issues:
                self.logger.error("%s", issue)
            return EXIT_INVALID

        self.logger.info(
            "Imported %d records from %d SQLite shard(s) with "
            "%d rejected records in %s.",
            len(self.records),
            len(self.results),
            len(self.rejected),
            human_duration(time.monotonic() - self.started),
        )
        return EXIT_SUCCESS


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Import SQLite shards back into canonical JSONL.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--sqlite-root",
        type=Path,
        default=DEFAULT_SQLITE_ROOT,
        help="Directory containing SQLite shards and manifest.json.",
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
        help="Stop immediately on integrity, parsing, or validation errors.",
    )
    parser.add_argument(
        "--verify-checksums",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Verify shard SHA-256 checksums when present in the manifest.",
    )
    parser.add_argument(
        "--verify-output",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Re-read generated output and verify record counts.",
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
        help="Sort output deterministically by speciedex_id.",
    )
    parser.add_argument(
        "--fail-on-issue",
        action="store_true",
        help="Return a nonzero status when nonfatal issues were recorded.",
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
        parser.error("--verbose and --quiet cannot be used together.")

    return args


def main(argv: Sequence[str] | None = None) -> int:
    return SQLiteImporter(parse_args(argv)).run()


if __name__ == "__main__":
    raise SystemExit(main())
