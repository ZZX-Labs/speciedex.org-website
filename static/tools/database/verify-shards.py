#!/usr/bin/env python3
"""
Verify Speciedex SQLite and MariaDB shard integrity.

Expected location:
    static/tools/database/verify-shards.py

The verifier checks:

    * required component manifests and manifest kinds
    * shard existence and path safety
    * duplicate shard identifiers and paths
    * declared and actual file sizes
    * SHA-256 checksums
    * SQLite integrity, schema, row counts, metadata, and shard identity
    * MariaDB gzip integrity, SQL framing, INSERT columns, row counts, and
      optional shard identity headers
    * manifest totals and SQLite/MariaDB record parity
    * orphan shard files not referenced by manifests

A structured JSON report is written whenever possible unless --dry-run is used.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
"""

from __future__ import annotations

import argparse
import contextlib
import gzip
import json
import logging
import re
import sqlite3
import tempfile
import time
from collections import Counter
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Mapping, Sequence

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
EXPECTED_MANIFEST_KINDS = {
    "sqlite": "sqlite",
    "mariadb": "mariadb-logical",
}
ORPHAN_PATTERNS = {
    "sqlite": ("*.sqlite", "*.sqlite3", "*.db"),
    "mariadb": ("*.sql.gz",),
}

SQL_INSERT_RE = re.compile(
    r"^\s*INSERT\s+INTO\s+`?taxa`?\s*\((.*?)\)\s*VALUES\s*$",
    re.IGNORECASE,
)
SHARD_HEADER_RE = re.compile(
    r"^\s*--\s*Speciedex\b",
    re.IGNORECASE,
)
SHARD_ID_RE = re.compile(
    r"^\s*--\s*shard_id\s*:\s*(\S+)\s*$",
    re.IGNORECASE,
)
QUOTED_COLUMN_RE = re.compile(r"`([^`]+)`")


class ShardVerificationError(RuntimeError):
    def __init__(
        self,
        message: str,
        exit_code: int = EXIT_CONFIGURATION,
    ) -> None:
        super().__init__(message)
        self.exit_code = exit_code


@dataclass
class MariaDBInspection:
    header_ok: bool = False
    shard_id: str = ""
    transaction_started: bool = False
    transaction_committed: bool = False
    insert_statements: int = 0
    rows: int = 0
    columns: list[str] = field(default_factory=list)
    scanned_lines: int = 0
    complete_scan: bool = True


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
    metadata_shard_id: str = ""
    gzip_ok: bool | None = None
    sql_header_ok: bool | None = None
    transaction_ok: bool | None = None
    insert_statements: int | None = None
    sql_columns: list[str] = field(default_factory=list)
    sql_scan_complete: bool | None = None
    valid: bool = False
    issues: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    duration_seconds: float = 0.0


def human_duration(seconds: float) -> str:
    seconds = max(0, int(round(seconds)))
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def shard_identifier(shard: Mapping[str, Any]) -> str:
    return clean_text(shard.get("id") or shard.get("shard_id"))


def shard_filename(shard: Mapping[str, Any]) -> str:
    return clean_text(
        shard.get("path")
        or shard.get("filename")
        or shard.get("file")
    )


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
    candidate = Path(filename)

    if candidate.is_absolute():
        raise ShardVerificationError(
            f"Manifest shard path must be relative: {filename}"
        )

    path = (root / candidate).resolve()
    try:
        path.relative_to(root.resolve())
    except ValueError as error:
        raise ShardVerificationError(
            f"Manifest shard path escapes component directory: {filename}"
        ) from error

    return path


def sqlite_connection(path: Path) -> sqlite3.Connection:
    uri = f"file:{path.resolve().as_posix()}?mode=ro&immutable=1"
    connection = sqlite3.connect(uri, uri=True)
    connection.execute("PRAGMA query_only = ON")
    return connection


def sqlite_columns(
    connection: sqlite3.Connection,
    table: str,
) -> set[str]:
    escaped = table.replace('"', '""')
    return {
        clean_text(row[1])
        for row in connection.execute(
            f'PRAGMA table_info("{escaped}")'
        )
    }


def split_sql_values(row: str) -> list[str]:
    values: list[str] = []
    buffer: list[str] = []
    in_string = False
    index = 0

    while index < len(row):
        character = row[index]

        if in_string:
            buffer.append(character)

            if character == "\\" and index + 1 < len(row):
                index += 1
                buffer.append(row[index])
            elif character == "'":
                if index + 1 < len(row) and row[index + 1] == "'":
                    index += 1
                    buffer.append(row[index])
                else:
                    in_string = False

            index += 1
            continue

        if character == "'":
            in_string = True
            buffer.append(character)
        elif character == ",":
            values.append("".join(buffer).strip())
            buffer = []
        else:
            buffer.append(character)

        index += 1

    if in_string:
        raise ValueError("Unterminated SQL string literal.")

    values.append("".join(buffer).strip())
    return values


def parse_value_row(line: str) -> list[str] | None:
    stripped = line.strip()
    if not stripped.startswith("("):
        return None

    if stripped.endswith(",") or stripped.endswith(";"):
        stripped = stripped[:-1].rstrip()

    if not stripped.endswith(")"):
        return None

    return split_sql_values(stripped[1:-1])


def inspect_mariadb_shard(
    path: Path,
    *,
    max_sql_lines: int,
) -> MariaDBInspection:
    inspection = MariaDBInspection()
    first_nonempty = ""
    in_values = False
    expected_columns = 0

    with gzip.open(
        path,
        "rt",
        encoding="utf-8",
        newline="",
    ) as handle:
        for line_number, line in enumerate(handle, 1):
            inspection.scanned_lines = line_number

            if max_sql_lines and line_number > max_sql_lines:
                inspection.complete_scan = False
                break

            stripped = line.strip()
            if not stripped:
                continue

            if not first_nonempty:
                first_nonempty = stripped
                inspection.header_ok = bool(
                    SHARD_HEADER_RE.match(first_nonempty)
                )

            shard_match = SHARD_ID_RE.match(line)
            if shard_match:
                inspection.shard_id = clean_text(shard_match.group(1))
                continue

            upper = stripped.upper()
            if upper.startswith("START TRANSACTION"):
                inspection.transaction_started = True
                continue
            if upper.startswith("COMMIT"):
                inspection.transaction_committed = True
                in_values = False
                continue

            insert_match = SQL_INSERT_RE.match(line)
            if insert_match:
                columns = [
                    clean_text(value)
                    for value in QUOTED_COLUMN_RE.findall(
                        insert_match.group(1)
                    )
                ]
                if not columns:
                    columns = [
                        clean_text(value).strip("`")
                        for value in insert_match.group(1).split(",")
                    ]

                if not columns or any(not value for value in columns):
                    raise ShardVerificationError(
                        f"{path}:{line_number}: invalid INSERT column list."
                    )

                if len(columns) != len(set(columns)):
                    raise ShardVerificationError(
                        f"{path}:{line_number}: duplicate INSERT columns."
                    )

                if "speciedex_id" not in columns:
                    raise ShardVerificationError(
                        f"{path}:{line_number}: INSERT is missing "
                        "speciedex_id."
                    )

                if inspection.columns and inspection.columns != columns:
                    raise ShardVerificationError(
                        f"{path}:{line_number}: inconsistent INSERT columns."
                    )

                inspection.columns = columns
                expected_columns = len(columns)
                inspection.insert_statements += 1
                in_values = True
                continue

            if not in_values:
                continue

            values = parse_value_row(line)
            if values is None:
                continue

            if len(values) != expected_columns:
                raise ShardVerificationError(
                    f"{path}:{line_number}: SQL row has {len(values)} "
                    f"values for {expected_columns} columns."
                )

            inspection.rows += 1

    return inspection


class ShardVerifier:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.db_root = args.db_root.resolve()
        self.report = args.report.resolve()
        self.logger = logging.getLogger(
            "speciedex.database.verify_shards"
        )
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

        self.report.parent.mkdir(parents=True, exist_ok=True)

        probe: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                "w",
                encoding="utf-8",
                delete=False,
                dir=self.report.parent,
                prefix=".speciedex-shards-write-test.",
            ) as handle:
                handle.write("ok\n")
                probe = Path(handle.name)
        except OSError as error:
            raise ShardVerificationError(
                f"Report directory is not writable: "
                f"{self.report.parent}: {error}"
            ) from error
        finally:
            if probe is not None:
                probe.unlink(missing_ok=True)

    def add_issue(
        self,
        message: str,
        check: CheckResult | None = None,
    ) -> None:
        self.issues.append(message)
        if check is not None:
            check.issues.append(message)

    def add_warning(
        self,
        message: str,
        check: CheckResult | None = None,
    ) -> None:
        self.warnings.append(message)
        if check is not None:
            check.warnings.append(message)

    def load_component_manifest(
        self,
        kind: str,
    ) -> dict[str, Any] | None:
        path = self.db_root / kind / "manifest.json"

        if not path.is_file():
            message = f"Missing {kind} manifest: {path}"
            if self.args.allow_missing_kind:
                self.add_warning(message)
                self.logger.warning(message)
                return None

            self.add_issue(message)
            return None

        try:
            manifest = load_manifest(path)
        except Exception as error:
            self.add_issue(
                f"Unable to load {kind} manifest {path}: {error}"
            )
            return None

        if not isinstance(manifest, dict):
            self.add_issue(
                f"{kind} manifest is not a JSON object: {path}"
            )
            return None

        expected_kind = EXPECTED_MANIFEST_KINDS[kind]
        actual_kind = clean_text(manifest.get("kind"))
        if actual_kind != expected_kind:
            self.add_issue(
                f"Unexpected {kind} manifest kind: "
                f"expected={expected_kind!r}, actual={actual_kind!r}"
            )

        shards = manifest.get("shards")
        totals = manifest.get("totals")

        if not isinstance(shards, list):
            self.add_issue(
                f"{kind} manifest shards must be an array: {path}"
            )
            return None

        if not isinstance(totals, Mapping):
            self.add_issue(
                f"{kind} manifest totals must be an object: {path}"
            )

        self.manifests[kind] = manifest
        return manifest

    def verify_manifest_structure(
        self,
        kind: str,
        manifest: Mapping[str, Any],
    ) -> None:
        seen_ids: set[str] = set()
        seen_paths: set[str] = set()

        for position, shard in enumerate(
            manifest.get("shards", []),
            1,
        ):
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
                    f"Duplicate {kind} shard id in manifest: "
                    f"{identifier}"
                )
            else:
                seen_ids.add(identifier)

            if not filename:
                self.add_issue(
                    f"{kind} manifest shard "
                    f"{identifier or position} has no path."
                )
            elif filename in seen_paths:
                self.add_issue(
                    f"Duplicate {kind} shard path in manifest: "
                    f"{filename}"
                )
            else:
                seen_paths.add(filename)

            records = integer_or_none(
                shard.get("records", shard.get("rows"))
            )
            if records is None or records < 0:
                self.add_issue(
                    f"{kind} shard {identifier or position} has an "
                    "invalid record count."
                )

            size = integer_or_none(shard.get("bytes"))
            if size is None or size < 0:
                self.add_issue(
                    f"{kind} shard {identifier or position} has an "
                    "invalid byte count."
                )

            digest = clean_text(shard.get("sha256"))
            if self.args.require_checksums:
                if not re.fullmatch(r"[0-9a-fA-F]{64}", digest):
                    self.add_issue(
                        f"{kind} shard {identifier or position} has no "
                        "valid SHA-256 checksum."
                    )

    def verify_sqlite_shard(
        self,
        path: Path,
        result: CheckResult,
    ) -> None:
        try:
            connection = sqlite_connection(path)
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

                required_tables = {"taxa", "metadata"}
                missing_tables = sorted(
                    required_tables - present_tables
                )
                result.schema_ok = not missing_tables

                if missing_tables:
                    self.add_issue(
                        f"SQLite schema missing table(s) in {path}: "
                        f"{missing_tables}",
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
                missing_columns = sorted(
                    required_columns - taxa_columns
                )

                if missing_columns:
                    result.schema_ok = False
                    self.add_issue(
                        f"SQLite taxa schema missing column(s) in "
                        f"{path}: {missing_columns}",
                        result,
                    )

                result.rows = int(
                    connection.execute(
                        "SELECT COUNT(*) FROM taxa"
                    ).fetchone()[0]
                )

                if result.manifest_records is not None:
                    result.row_count_ok = (
                        result.rows
                        == result.manifest_records
                    )
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
                result.metadata_shard_id = metadata.get(
                    "shard_id",
                    "",
                )
                result.metadata_ok = (
                    bool(result.metadata_shard_id)
                    and result.metadata_shard_id == result.shard_id
                )

                if not result.metadata_ok:
                    self.add_issue(
                        f"SQLite metadata shard_id mismatch for {path}: "
                        f"manifest={result.shard_id}, "
                        f"metadata={result.metadata_shard_id!r}",
                        result,
                    )

                metadata_records = integer_or_none(
                    metadata.get("records")
                    or metadata.get("record_count")
                )
                if (
                    metadata_records is not None
                    and result.rows is not None
                    and metadata_records != result.rows
                ):
                    self.add_issue(
                        f"SQLite metadata record count mismatch for "
                        f"{path}: metadata={metadata_records}, "
                        f"actual={result.rows}",
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
        result: CheckResult,
    ) -> None:
        try:
            inspection = inspect_mariadb_shard(
                path,
                max_sql_lines=self.args.max_sql_lines,
            )
            result.gzip_ok = True
            result.sql_header_ok = inspection.header_ok
            result.transaction_ok = (
                inspection.transaction_started
                and inspection.transaction_committed
            )
            result.insert_statements = (
                inspection.insert_statements
            )
            result.rows = inspection.rows
            result.sql_columns = inspection.columns
            result.sql_scan_complete = inspection.complete_scan
            result.metadata_shard_id = inspection.shard_id

            if not result.sql_header_ok:
                self.add_issue(
                    f"MariaDB shard header is invalid: {path}",
                    result,
                )

            if not result.transaction_ok:
                message = (
                    f"MariaDB shard transaction framing is incomplete: "
                    f"{path}"
                )
                if inspection.complete_scan:
                    self.add_issue(message, result)
                else:
                    self.add_warning(
                        message + " (partial SQL scan)",
                        result,
                    )

            if (
                inspection.shard_id
                and inspection.shard_id != result.shard_id
            ):
                self.add_issue(
                    f"MariaDB shard_id mismatch for {path}: "
                    f"manifest={result.shard_id}, "
                    f"header={inspection.shard_id}",
                    result,
                )

            if not inspection.columns:
                self.add_issue(
                    f"MariaDB shard contains no recognized taxa "
                    f"INSERT statement: {path}",
                    result,
                )

            if (
                result.manifest_records not in (None, 0)
                and inspection.insert_statements == 0
            ):
                self.add_issue(
                    f"MariaDB shard contains no taxa INSERT "
                    f"statements: {path}",
                    result,
                )

            if inspection.complete_scan:
                if result.manifest_records is not None:
                    result.row_count_ok = (
                        inspection.rows
                        == result.manifest_records
                    )
                    if not result.row_count_ok:
                        self.add_issue(
                            f"MariaDB row-count mismatch for {path}: "
                            f"manifest={result.manifest_records}, "
                            f"actual={inspection.rows}",
                            result,
                        )
            else:
                result.row_count_ok = None
                self.add_warning(
                    f"MariaDB SQL scan was truncated after "
                    f"{self.args.max_sql_lines} lines; row-count and "
                    f"transaction verification are incomplete: {path}",
                    result,
                )

        except (
            OSError,
            EOFError,
            UnicodeError,
            ValueError,
            ShardVerificationError,
        ) as error:
            result.gzip_ok = False
            self.add_issue(
                f"MariaDB shard inspection failure: {path}: {error}",
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
            manifest_bytes=integer_or_none(
                shard.get("bytes")
            ),
            manifest_sha256=clean_text(
                shard.get("sha256")
            ),
        )

        if not identifier:
            self.add_issue(
                f"{kind} shard has no identifier.",
                result,
            )

        if not filename:
            self.add_issue(
                f"{kind} shard {identifier or '<unknown>'} "
                "has no path.",
                result,
            )
            result.duration_seconds = round(
                time.monotonic() - started,
                6,
            )
            return result

        try:
            path = safe_shard_path(component_root, filename)
        except ShardVerificationError as error:
            self.add_issue(str(error), result)
            result.duration_seconds = round(
                time.monotonic() - started,
                6,
            )
            return result

        result.path = path.as_posix()
        self.referenced_files[kind].add(path)
        result.exists = path.is_file()

        if not result.exists:
            self.add_issue(
                f"Missing {kind} shard: {path}",
                result,
            )
            result.duration_seconds = round(
                time.monotonic() - started,
                6,
            )
            return result

        result.bytes = path.stat().st_size
        result.sha256 = sha256_file(path)

        if result.manifest_sha256:
            result.checksum_ok = (
                result.sha256.casefold()
                == result.manifest_sha256.casefold()
            )
            if not result.checksum_ok:
                self.add_issue(
                    f"Checksum mismatch: {path}",
                    result,
                )
        elif self.args.require_checksums:
            result.checksum_ok = False
            self.add_issue(
                f"Missing manifest checksum: {path}",
                result,
            )

        if result.manifest_bytes is not None:
            result.declared_size_ok = (
                result.bytes == result.manifest_bytes
            )
            if not result.declared_size_ok:
                self.add_issue(
                    f"Declared size mismatch for {path}: "
                    f"manifest={result.manifest_bytes}, "
                    f"actual={result.bytes}",
                    result,
                )

        result.maximum_size_ok = (
            result.bytes <= self.args.max_bytes
        )
        if not result.maximum_size_ok:
            self.add_issue(
                f"Shard exceeds maximum size: {path} "
                f"({result.bytes} > {self.args.max_bytes})",
                result,
            )

        if kind == "sqlite":
            self.verify_sqlite_shard(path, result)
        else:
            self.verify_mariadb_shard(path, result)

        result.valid = not result.issues
        result.duration_seconds = round(
            time.monotonic() - started,
            6,
        )
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

            result = self.verify_shard(
                kind,
                component_root,
                shard,
            )
            self.checks.append(result)

    def verify_manifest_totals(self) -> None:
        for kind, manifest in sorted(self.manifests.items()):
            totals = manifest.get("totals", {})
            if not isinstance(totals, Mapping):
                continue

            component_checks = [
                check
                for check in self.checks
                if check.kind == kind
            ]
            declared_shards = integer_or_none(
                totals.get("shards")
            )
            declared_records = integer_or_none(
                totals.get("records")
            )
            declared_bytes = integer_or_none(
                totals.get("bytes")
            )

            if declared_shards is None:
                self.add_issue(
                    f"{kind} manifest has no valid shard total."
                )
            elif declared_shards != len(component_checks):
                self.add_issue(
                    f"{kind} manifest shard total mismatch: "
                    f"manifest={declared_shards}, "
                    f"checks={len(component_checks)}"
                )

            known_rows = [
                check.rows
                for check in component_checks
                if check.rows is not None
                and (
                    kind == "sqlite"
                    or check.sql_scan_complete is not False
                )
            ]
            if declared_records is None:
                self.add_issue(
                    f"{kind} manifest has no valid record total."
                )
            elif len(known_rows) == len(component_checks):
                actual_records = sum(known_rows)
                if declared_records != actual_records:
                    self.add_issue(
                        f"{kind} manifest record total mismatch: "
                        f"manifest={declared_records}, "
                        f"actual={actual_records}"
                    )

            known_bytes = [
                check.bytes
                for check in component_checks
                if check.bytes is not None
            ]
            if (
                declared_bytes is not None
                and len(known_bytes) == len(component_checks)
            ):
                actual_bytes = sum(known_bytes)
                if declared_bytes != actual_bytes:
                    self.add_issue(
                        f"{kind} manifest byte total mismatch: "
                        f"manifest={declared_bytes}, "
                        f"actual={actual_bytes}"
                    )

            if (
                self.args.expect_records is not None
                and declared_records is not None
                and declared_records != self.args.expect_records
            ):
                self.add_issue(
                    f"{kind} manifest total does not match "
                    f"--expect-records: "
                    f"expected={self.args.expect_records}, "
                    f"actual={declared_records}"
                )

    def verify_cross_format_parity(self) -> None:
        if not self.args.parity:
            return

        sqlite_manifest = self.manifests.get("sqlite")
        mariadb_manifest = self.manifests.get("mariadb")

        if not sqlite_manifest or not mariadb_manifest:
            return

        sqlite_totals = sqlite_manifest.get("totals")
        mariadb_totals = mariadb_manifest.get("totals")

        sqlite_records = (
            integer_or_none(sqlite_totals.get("records"))
            if isinstance(sqlite_totals, Mapping)
            else None
        )
        mariadb_records = (
            integer_or_none(mariadb_totals.get("records"))
            if isinstance(mariadb_totals, Mapping)
            else None
        )

        if sqlite_records is None or mariadb_records is None:
            self.add_issue(
                "Unable to compare SQLite/MariaDB parity because "
                "record totals are missing."
            )
            return

        if sqlite_records != mariadb_records:
            self.add_issue(
                "SQLite/MariaDB record parity failure: "
                f"sqlite={sqlite_records}, "
                f"mariadb={mariadb_records}"
            )

        sqlite_ids = {
            check.shard_id
            for check in self.checks
            if check.kind == "sqlite"
        }
        mariadb_ids = {
            check.shard_id
            for check in self.checks
            if check.kind == "mariadb"
        }

        for identifier in sorted(sqlite_ids - mariadb_ids):
            self.add_issue(
                f"SQLite shard has no MariaDB counterpart: "
                f"{identifier}"
            )

        for identifier in sorted(mariadb_ids - sqlite_ids):
            self.add_issue(
                f"MariaDB shard has no SQLite counterpart: "
                f"{identifier}"
            )

    def detect_orphans(self) -> None:
        if not self.args.check_orphans:
            return

        for kind in self.args.kind:
            component_root = self.db_root / kind
            if not component_root.exists():
                continue

            referenced = self.referenced_files[kind]
            candidates: set[Path] = set()

            for pattern in ORPHAN_PATTERNS[kind]:
                iterator = (
                    component_root.rglob(pattern)
                    if self.args.recursive_orphans
                    else component_root.glob(pattern)
                )
                for path in iterator:
                    if path.is_file():
                        candidates.add(path.resolve())

            for path in sorted(
                candidates,
                key=lambda item: item.as_posix(),
            ):
                if path in referenced:
                    continue

                message = (
                    f"Orphan {kind} shard not in manifest: {path}"
                )
                if self.args.orphans_are_errors:
                    self.add_issue(message)
                else:
                    self.add_warning(message)

    def report_payload(
        self,
        *,
        status: str | None = None,
    ) -> dict[str, Any]:
        elapsed = time.monotonic() - self.started
        by_kind = Counter(
            check.kind for check in self.checks
        )
        valid_by_kind = Counter(
            check.kind
            for check in self.checks
            if check.valid
        )

        if status is None:
            status = "invalid" if self.issues else "success"

        return {
            "schema_version": 3,
            "kind": "shard-verification-report",
            "generated_at": utc_now(),
            "status": status,
            "database_root": self.db_root.as_posix(),
            "valid": not self.issues,
            "duration_seconds": round(elapsed, 6),
            "duration": human_duration(elapsed),
            "options": {
                "kinds": list(self.args.kind),
                "max_bytes": self.args.max_bytes,
                "expect_records": self.args.expect_records,
                "require_checksums": self.args.require_checksums,
                "parity": self.args.parity,
                "check_orphans": self.args.check_orphans,
                "orphans_are_errors": (
                    self.args.orphans_are_errors
                ),
                "recursive_orphans": (
                    self.args.recursive_orphans
                ),
                "max_sql_lines": self.args.max_sql_lines,
            },
            "manifest_totals": {
                kind: manifest.get("totals", {})
                for kind, manifest in sorted(
                    self.manifests.items()
                )
            },
            "totals": {
                "checks": len(self.checks),
                "passed": sum(
                    1 for check in self.checks if check.valid
                ),
                "failed": sum(
                    1 for check in self.checks if not check.valid
                ),
                "issues": len(self.issues),
                "warnings": len(self.warnings),
                "rows_by_kind": {
                    kind: sum(
                        check.rows or 0
                        for check in self.checks
                        if check.kind == kind
                    )
                    for kind in self.args.kind
                },
                "by_kind": dict(sorted(by_kind.items())),
                "valid_by_kind": dict(
                    sorted(valid_by_kind.items())
                ),
            },
            "issues": list(self.issues),
            "warnings": list(self.warnings),
            "checks": [
                asdict(check)
                for check in self.checks
            ],
        }

    def write_report(
        self,
        *,
        status: str | None = None,
    ) -> None:
        if self.args.dry_run:
            self.logger.info(
                "Dry run: report not written."
            )
            return

        atomic_write_json(
            self.report,
            self.report_payload(status=status),
        )

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
            self.logger.error(
                "Shard verification interrupted."
            )
            with contextlib.suppress(Exception):
                self.write_report(status="interrupted")
            return EXIT_INTERRUPTED

        except ShardVerificationError as error:
            self.logger.error("%s", error)
            with contextlib.suppress(Exception):
                self.add_issue(str(error))
                self.write_report(status="configuration-error")
            return error.exit_code

        except Exception as error:
            self.logger.error(
                "Shard verification failed: %s",
                error,
            )
            if self.args.verbose:
                self.logger.exception("Detailed failure")

            with contextlib.suppress(Exception):
                self.add_issue(
                    f"{type(error).__name__}: {error}"
                )
                self.write_report(status="configuration-error")
            return EXIT_CONFIGURATION

        if self.issues:
            for issue in self.issues:
                self.logger.error("%s", issue)

            self.logger.error(
                "%d shard verification issue(s) detected. "
                "Report: %s",
                len(self.issues),
                self.report,
            )
            return EXIT_INVALID

        self.logger.info(
            "All %d database shard(s) passed integrity, "
            "checksum, size, schema, row-count, and parity "
            "checks in %s.",
            len(self.checks),
            human_duration(time.monotonic() - self.started),
        )
        return EXIT_SUCCESS


def parse_args(
    argv: Sequence[str] | None = None,
) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Verify Speciedex SQLite and MariaDB shard integrity."
        ),
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )

    parser.add_argument(
        "--db-root",
        type=Path,
        default=Path("static/data/db"),
        help=(
            "Root directory containing SQLite and MariaDB components."
        ),
    )
    parser.add_argument(
        "--kind",
        action="append",
        choices=SUPPORTED_KINDS,
        default=None,
        help=(
            "Component kind to verify. May be supplied multiple times."
        ),
    )
    parser.add_argument(
        "--max-bytes",
        type=int,
        default=DEFAULT_MAX_FILE_BYTES,
        help="Maximum permitted shard file size.",
    )
    parser.add_argument(
        "--expect-records",
        type=int,
        default=None,
        help="Expected record total for each requested component.",
    )
    parser.add_argument(
        "--require-checksums",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Require valid SHA-256 values in component manifests.",
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
        help=(
            "Compare SQLite and MariaDB manifest totals and shard ids."
        ),
    )
    parser.add_argument(
        "--check-orphans",
        action=argparse.BooleanOptionalAction,
        default=True,
        help=(
            "Detect shard files not referenced by component manifests."
        ),
    )
    parser.add_argument(
        "--recursive-orphans",
        action=argparse.BooleanOptionalAction,
        default=True,
        help=(
            "Search component subdirectories recursively for orphan shards."
        ),
    )
    parser.add_argument(
        "--orphans-are-errors",
        action="store_true",
        help=(
            "Treat orphan shard files as verification failures."
        ),
    )
    parser.add_argument(
        "--allow-missing-kind",
        action="store_true",
        help=(
            "Warn instead of failing when a requested component is absent."
        ),
    )
    parser.add_argument(
        "--max-sql-lines",
        type=int,
        default=0,
        help=(
            "Maximum MariaDB SQL lines to inspect per shard; "
            "use 0 to scan the complete gzip stream."
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

    if (
        args.expect_records is not None
        and args.expect_records < 0
    ):
        parser.error("--expect-records cannot be negative.")

    if args.max_sql_lines < 0:
        parser.error("--max-sql-lines cannot be negative.")

    if args.verbose and args.quiet:
        parser.error(
            "--verbose and --quiet cannot be used together."
        )

    if args.parity and len(args.kind) < 2:
        args.parity = False

    return args


def main(argv: Sequence[str] | None = None) -> int:
    return ShardVerifier(parse_args(argv)).run()


if __name__ == "__main__":
    raise SystemExit(main())
