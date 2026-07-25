#!/usr/bin/env python3
"""
Verify Speciedex SQLite and MariaDB shard integrity.

Expected location:
    static/tools/database/verify-shards.py

The verifier checks:

    * required component manifests
    * shard existence and path safety
    * declared and actual file sizes
    * SHA-256 checksums
    * SQLite integrity, schema, row counts, and metadata
    * MariaDB gzip integrity and logical SQL framing
    * duplicate shard identifiers and paths
    * manifest totals and cross-format parity
    * orphan shard files not referenced by manifests

A structured JSON report is always written unless --dry-run is used.

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
import sys
import time
from collections import Counter
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from common import (
    DEFAULT_MAX_FILE_BYTES,
    atomic_write_json,
    clean_text,
    load_manifest,
    sha256_file,
    utc_now,
)


EXIT_SUCCESS = 0
EXIT_INVALID = 1
EXIT_CONFIGURATION = 2
EXIT_INTERRUPTED = 130

DEFAULT_REPORT = Path("static/data/db/reports/shards.json")
SUPPORTED_KINDS = ("sqlite", "mariadb")
SQL_INSERT_RE = re.compile(r"^\s*INSERT\s+INTO\s+`?taxa`?\s*", re.IGNORECASE)
SHARD_HEADER_RE = re.compile(r"^--\s*Speciedex\b", re.IGNORECASE)


class ShardVerificationError(RuntimeError):
    def __init__(self, message: str, exit_code: int = EXIT_CONFIGURATION) -> None:
        super().__init__(message)
        self.exit_code = exit_code


@dataclass
class CheckResult:
    kind: str
    shard_id: str
    path: str
    exists: bool = False
    manifest_records: int | None = None
    manifest_bytes: int | None = None
    manifest_sha256: str = ""
    bytes: int | None = None
    sha256: str = ""
    checksum_ok: bool | None = None
    declared_size_ok: bool | None = None
    maximum_size_ok: bool | None = None
    rows: int | None = None
    row_count_ok: bool | None = None
    integrity: str = ""
    schema_ok: bool | None = None
    metadata_ok: bool | None = None
    gzip_ok: bool | None = None
    sql_header_ok: bool | None = None
    transaction_ok: bool | None = None
    insert_statements: int | None = None
    valid: bool = False
    issues: list[str] = field(default_factory=list)
    duration_seconds: float = 0.0


def human_duration(seconds: float) -> str:
    seconds = max(0, int(round(seconds)))
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def shard_identifier(shard: Mapping[str, Any]) -> str:
    return clean_text(shard.get("id") or shard.get("shard_id"))


def shard_filename(shard: Mapping[str, Any]) -> str:
    return clean_text(shard.get("path") or shard.get("filename"))


def integer_or_none(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        text = value.strip()
        if text and re.fullmatch(r"-?\d+", text):
            return int(text)
    return None


def safe_shard_path(root: Path, filename: str) -> Path:
    candidate = (root / filename).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError as error:
        raise ShardVerificationError(
            f"Manifest shard path escapes component directory: {filename}"
        ) from error
    return candidate


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


class ShardVerifier:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.db_root = args.db_root.resolve()
        self.report = args.report.resolve()
        self.logger = logging.getLogger("speciedex.database.verify_shards")
        self.started = time.monotonic()
        self.checks: list[CheckResult] = []
        self.issues: list[str] = []
        self.warnings: list[str] = []
        self.manifests: dict[str, dict[str, Any]] = {}
        self.referenced_files: dict[str, set[Path]] = {
            kind: set() for kind in args.kind
        }

    def configure_logging(self) -> None:
        level = logging.DEBUG if self.args.verbose else logging.INFO
        if self.args.quiet:
            level = logging.WARNING

        logging.basicConfig(
            level=level,
            format="%(asctime)s %(levelname)s %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )

    def validate_environment(self) -> None:
        if not self.db_root.exists():
            raise ShardVerificationError(
                f"Database root does not exist: {self.db_root}"
            )

        if not self.db_root.is_dir():
            raise ShardVerificationError(
                f"Database root is not a directory: {self.db_root}"
            )

        if self.args.max_bytes < 1:
            raise ShardVerificationError("--max-bytes must be at least 1.")

    def add_issue(self, message: str, check: CheckResult | None = None) -> None:
        self.issues.append(message)
        if check is not None:
            check.issues.append(message)

    def load_component_manifest(self, kind: str) -> dict[str, Any] | None:
        path = self.db_root / kind / "manifest.json"

        if not path.is_file():
            message = f"Missing {kind} manifest: {path}"
            if self.args.allow_missing_kind:
                self.warnings.append(message)
                self.logger.warning(message)
                return None
            self.add_issue(message)
            return None

        try:
            manifest = load_manifest(path)
        except Exception as error:
            self.add_issue(f"Unable to load {kind} manifest {path}: {error}")
            return None

        shards = manifest.get("shards")
        totals = manifest.get("totals")

        if not isinstance(shards, list):
            self.add_issue(f"{kind} manifest shards must be an array: {path}")
            return None

        if totals is not None and not isinstance(totals, Mapping):
            self.add_issue(f"{kind} manifest totals must be an object: {path}")

        self.manifests[kind] = manifest
        return manifest

    def verify_manifest_structure(
        self,
        kind: str,
        manifest: Mapping[str, Any],
    ) -> None:
        seen_ids: set[str] = set()
        seen_paths: set[str] = set()

        for position, shard in enumerate(manifest.get("shards", []), 1):
            if not isinstance(shard, Mapping):
                self.add_issue(
                    f"{kind} manifest shard {position} is not an object."
                )
                continue

            identifier = shard_identifier(shard)
            filename = shard_filename(shard)

            if not identifier:
                self.add_issue(
                    f"{kind} manifest shard {position} has no id."
                )
            elif identifier in seen_ids:
                self.add_issue(
                    f"Duplicate {kind} shard id in manifest: {identifier}"
                )
            else:
                seen_ids.add(identifier)

            if not filename:
                self.add_issue(
                    f"{kind} manifest shard {identifier or position} has no path."
                )
            elif filename in seen_paths:
                self.add_issue(
                    f"Duplicate {kind} shard path in manifest: {filename}"
                )
            else:
                seen_paths.add(filename)

    def verify_sqlite_shard(
        self,
        path: Path,
        shard: Mapping[str, Any],
        result: CheckResult,
    ) -> None:
        try:
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

                required_columns = {
                    "speciedex_id",
                    "scientific_name",
                    "canonical_name",
                    "rank",
                    "provider",
                    "indexed_at",
                    "record_hash",
                    "payload_json",
                }
                taxa_columns = sqlite_columns(connection, "taxa")
                if not required_columns.issubset(taxa_columns):
                    result.schema_ok = False
                    missing_columns = sorted(required_columns - taxa_columns)
                    self.add_issue(
                        f"SQLite taxa schema missing column(s) in {path}: "
                        f"{missing_columns}",
                        result,
                    )

                result.rows = int(
                    connection.execute("SELECT COUNT(*) FROM taxa").fetchone()[0]
                )
                if result.manifest_records is not None:
                    result.row_count_ok = result.rows == result.manifest_records
                    if not result.row_count_ok:
                        self.add_issue(
                            f"SQLite row-count mismatch for {path}: "
                            f"manifest={result.manifest_records}, "
                            f"actual={result.rows}",
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
            finally:
                connection.close()

        except sqlite3.Error as error:
            result.integrity = "error"
            result.schema_ok = False
            self.add_issue(
                f"Unable to inspect SQLite shard {path}: {error}",
                result,
            )

    def verify_mariadb_shard(
        self,
        path: Path,
        shard: Mapping[str, Any],
        result: CheckResult,
    ) -> None:
        first_nonempty = ""
        saw_start = False
        saw_commit = False
        insert_statements = 0

        try:
            with gzip.open(path, "rt", encoding="utf-8") as handle:
                for line_number, line in enumerate(handle, 1):
                    stripped = line.strip()

                    if not stripped:
                        continue

                    if not first_nonempty:
                        first_nonempty = stripped

                    upper = stripped.upper()
                    if upper.startswith("START TRANSACTION"):
                        saw_start = True
                    elif upper.startswith("COMMIT"):
                        saw_commit = True

                    if SQL_INSERT_RE.match(stripped):
                        insert_statements += 1

                    if (
                        self.args.max_sql_lines
                        and line_number >= self.args.max_sql_lines
                    ):
                        break

            result.gzip_ok = True
            result.sql_header_ok = bool(
                SHARD_HEADER_RE.match(first_nonempty)
            )
            result.transaction_ok = saw_start and saw_commit
            result.insert_statements = insert_statements

            if not result.sql_header_ok:
                self.add_issue(
                    f"MariaDB shard header is invalid: {path}",
                    result,
                )

            if not result.transaction_ok:
                self.add_issue(
                    f"MariaDB shard transaction framing is incomplete: {path}",
                    result,
                )

            if result.manifest_records not in (None, 0) and insert_statements == 0:
                self.add_issue(
                    f"MariaDB shard contains no taxa INSERT statements: {path}",
                    result,
                )

        except (OSError, EOFError, UnicodeError) as error:
            result.gzip_ok = False
            self.add_issue(
                f"MariaDB gzip failure: {path}: {error}",
                result,
            )

    def verify_shard(
        self,
        kind: str,
        component_root: Path,
        shard: Mapping[str, Any],
    ) -> CheckResult:
        started = time.monotonic()
        identifier = shard_identifier(shard)
        filename = shard_filename(shard)

        result = CheckResult(
            kind=kind,
            shard_id=identifier,
            path=filename,
            manifest_records=integer_or_none(
                shard.get("records", shard.get("rows"))
            ),
            manifest_bytes=integer_or_none(shard.get("bytes")),
            manifest_sha256=clean_text(shard.get("sha256")),
        )

        if not filename:
            self.add_issue(
                f"{kind} shard {identifier or '<unknown>'} has no path.",
                result,
            )
            result.duration_seconds = time.monotonic() - started
            return result

        try:
            path = safe_shard_path(component_root, filename)
        except ShardVerificationError as error:
            self.add_issue(str(error), result)
            result.duration_seconds = time.monotonic() - started
            return result

        result.path = path.as_posix()
        self.referenced_files[kind].add(path)
        result.exists = path.is_file()

        if not result.exists:
            self.add_issue(f"Missing {kind} shard: {path}", result)
            result.duration_seconds = time.monotonic() - started
            return result

        result.bytes = path.stat().st_size
        result.sha256 = sha256_file(path)

        if result.manifest_sha256:
            result.checksum_ok = (
                result.sha256.casefold()
                == result.manifest_sha256.casefold()
            )
            if not result.checksum_ok:
                self.add_issue(f"Checksum mismatch: {path}", result)

        if result.manifest_bytes is not None:
            result.declared_size_ok = result.bytes == result.manifest_bytes
            if not result.declared_size_ok:
                self.add_issue(
                    f"Declared size mismatch for {path}: "
                    f"manifest={result.manifest_bytes}, actual={result.bytes}",
                    result,
                )

        result.maximum_size_ok = result.bytes <= self.args.max_bytes
        if not result.maximum_size_ok:
            self.add_issue(
                f"Shard exceeds maximum size: {path} "
                f"({result.bytes} > {self.args.max_bytes})",
                result,
            )

        if kind == "sqlite":
            self.verify_sqlite_shard(path, shard, result)
        else:
            self.verify_mariadb_shard(path, shard, result)

        result.valid = not result.issues
        result.duration_seconds = round(time.monotonic() - started, 6)
        return result

    def verify_component(self, kind: str) -> None:
        manifest = self.load_component_manifest(kind)
        if manifest is None:
            return

        self.verify_manifest_structure(kind, manifest)
        component_root = self.db_root / kind

        for shard in manifest.get("shards", []):
            if not isinstance(shard, Mapping):
                continue
            result = self.verify_shard(kind, component_root, shard)
            self.checks.append(result)

    def verify_manifest_totals(self) -> None:
        for kind, manifest in sorted(self.manifests.items()):
            totals = manifest.get("totals", {})
            if not isinstance(totals, Mapping):
                continue

            component_checks = [
                check for check in self.checks if check.kind == kind
            ]
            declared_shards = integer_or_none(totals.get("shards"))
            declared_records = integer_or_none(totals.get("records"))
            declared_bytes = integer_or_none(totals.get("bytes"))

            if (
                declared_shards is not None
                and declared_shards != len(component_checks)
            ):
                self.add_issue(
                    f"{kind} manifest shard total mismatch: "
                    f"manifest={declared_shards}, checks={len(component_checks)}"
                )

            known_records = [
                check.rows if kind == "sqlite" else check.manifest_records
                for check in component_checks
            ]
            if declared_records is not None and all(
                value is not None for value in known_records
            ):
                actual_records = sum(int(value) for value in known_records)
                if declared_records != actual_records:
                    self.add_issue(
                        f"{kind} manifest record total mismatch: "
                        f"manifest={declared_records}, actual={actual_records}"
                    )

            known_bytes = [
                check.bytes for check in component_checks if check.bytes is not None
            ]
            if (
                declared_bytes is not None
                and len(known_bytes) == len(component_checks)
            ):
                actual_bytes = sum(known_bytes)
                if declared_bytes != actual_bytes:
                    self.add_issue(
                        f"{kind} manifest byte total mismatch: "
                        f"manifest={declared_bytes}, actual={actual_bytes}"
                    )

    def verify_cross_format_parity(self) -> None:
        if not self.args.parity:
            return

        sqlite_manifest = self.manifests.get("sqlite")
        mariadb_manifest = self.manifests.get("mariadb")
        if not sqlite_manifest or not mariadb_manifest:
            return

        sqlite_records = integer_or_none(
            sqlite_manifest.get("totals", {}).get("records")
        )
        mariadb_records = integer_or_none(
            mariadb_manifest.get("totals", {}).get("records")
        )

        if sqlite_records is None or mariadb_records is None:
            self.add_issue(
                "Unable to compare SQLite/MariaDB parity because record totals "
                "are missing."
            )
            return

        if sqlite_records != mariadb_records:
            self.add_issue(
                "SQLite/MariaDB record parity failure: "
                f"sqlite={sqlite_records}, mariadb={mariadb_records}"
            )

    def detect_orphans(self) -> None:
        if not self.args.check_orphans:
            return

        patterns = {
            "sqlite": "speciedex-*.sqlite3",
            "mariadb": "speciedex-*.sql.gz",
        }

        for kind in self.args.kind:
            component_root = self.db_root / kind
            if not component_root.exists():
                continue

            referenced = self.referenced_files[kind]
            for path in sorted(component_root.glob(patterns[kind])):
                resolved = path.resolve()
                if resolved not in referenced:
                    message = f"Orphan {kind} shard not in manifest: {path}"
                    if self.args.orphans_are_errors:
                        self.add_issue(message)
                    else:
                        self.warnings.append(message)

    def report_payload(self) -> dict[str, Any]:
        elapsed = time.monotonic() - self.started
        by_kind = Counter(check.kind for check in self.checks)
        valid_by_kind = Counter(
            check.kind for check in self.checks if check.valid
        )

        return {
            "schema_version": 2,
            "generated_at": utc_now(),
            "database_root": self.db_root.as_posix(),
            "valid": not self.issues,
            "duration_seconds": round(elapsed, 6),
            "duration": human_duration(elapsed),
            "options": {
                "kinds": list(self.args.kind),
                "max_bytes": self.args.max_bytes,
                "parity": self.args.parity,
                "check_orphans": self.args.check_orphans,
                "orphans_are_errors": self.args.orphans_are_errors,
                "max_sql_lines": self.args.max_sql_lines,
            },
            "totals": {
                "checks": len(self.checks),
                "passed": sum(1 for check in self.checks if check.valid),
                "failed": sum(1 for check in self.checks if not check.valid),
                "issues": len(self.issues),
                "warnings": len(self.warnings),
                "by_kind": dict(sorted(by_kind.items())),
                "valid_by_kind": dict(sorted(valid_by_kind.items())),
            },
            "issues": self.issues,
            "warnings": self.warnings,
            "checks": [asdict(check) for check in self.checks],
        }

    def write_report(self) -> None:
        if self.args.dry_run:
            self.logger.info("Dry run: report not written.")
            return
        atomic_write_json(self.report, self.report_payload())

    def run(self) -> int:
        self.configure_logging()

        try:
            self.validate_environment()

            for kind in self.args.kind:
                self.verify_component(kind)

            self.verify_manifest_totals()
            self.verify_cross_format_parity()
            self.detect_orphans()
            self.write_report()

        except KeyboardInterrupt:
            self.logger.error("Shard verification interrupted.")
            return EXIT_INTERRUPTED
        except ShardVerificationError as error:
            self.logger.error("%s", error)
            return error.exit_code
        except Exception as error:
            self.logger.error("Shard verification failed: %s", error)
            if self.args.verbose:
                self.logger.exception("Detailed failure")
            return EXIT_CONFIGURATION

        if self.issues:
            for issue in self.issues:
                self.logger.error("%s", issue)
            self.logger.error(
                "%d shard verification issue(s) detected. Report: %s",
                len(self.issues),
                self.report,
            )
            return EXIT_INVALID

        self.logger.info(
            "All %d database shard(s) passed integrity, checksum, size, "
            "schema, and parity checks in %s.",
            len(self.checks),
            human_duration(time.monotonic() - self.started),
        )
        return EXIT_SUCCESS


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Verify Speciedex database shard integrity.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )

    parser.add_argument(
        "--db-root",
        type=Path,
        default=Path("static/data/db"),
        help="Root directory containing SQLite and MariaDB components.",
    )
    parser.add_argument(
        "--kind",
        action="append",
        choices=SUPPORTED_KINDS,
        default=None,
        help="Component kind to verify. May be supplied multiple times.",
    )
    parser.add_argument(
        "--max-bytes",
        type=int,
        default=DEFAULT_MAX_FILE_BYTES,
        help="Maximum permitted shard file size.",
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=DEFAULT_REPORT,
        help="Destination JSON verification report.",
    )
    parser.add_argument(
        "--parity",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Compare SQLite and MariaDB manifest record totals.",
    )
    parser.add_argument(
        "--check-orphans",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Detect shard files not referenced by component manifests.",
    )
    parser.add_argument(
        "--orphans-are-errors",
        action="store_true",
        help="Treat orphan shard files as verification failures.",
    )
    parser.add_argument(
        "--allow-missing-kind",
        action="store_true",
        help="Warn instead of failing when a requested component is absent.",
    )
    parser.add_argument(
        "--max-sql-lines",
        type=int,
        default=0,
        help=(
            "Maximum MariaDB SQL lines to inspect per shard; use 0 to scan "
            "the complete gzip stream."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Run checks without writing the JSON report.",
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

    if args.kind is None:
        args.kind = list(SUPPORTED_KINDS)
    else:
        args.kind = list(dict.fromkeys(args.kind))

    if args.max_bytes < 1:
        parser.error("--max-bytes must be at least 1.")

    if args.max_sql_lines < 0:
        parser.error("--max-sql-lines cannot be negative.")

    if args.verbose and args.quiet:
        parser.error("--verbose and --quiet cannot be used together.")

    return args


def main(argv: Sequence[str] | None = None) -> int:
    return ShardVerifier(parse_args(argv)).run()


if __name__ == "__main__":
    raise SystemExit(main())
