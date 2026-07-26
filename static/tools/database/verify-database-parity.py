#!/usr/bin/env python3
"""
Verify parity between Speciedex SQLite and MariaDB shard products.

Expected location:
    static/tools/database/verify-database-parity.py

This verifier compares component manifests, shard identities, row counts,
manifest declarations, checksums, file sizes, and optionally record-level
Speciedex identifiers and record hashes.

The verifier is read-only. SQLite files are opened in immutable read-only mode,
and MariaDB logical shards are parsed without executing SQL.

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
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterator, Mapping, Sequence

from common import (
    atomic_write_json,
    clean_text,
    load_manifest,
    sha256_file,
    utc_now,
)


EXIT_SUCCESS = 0
EXIT_MISMATCH = 1
EXIT_CONFIGURATION = 2
EXIT_INTERRUPTED = 130

DEFAULT_DB_ROOT = Path("static/data/db")
DEFAULT_REPORT = Path("static/data/db/reports/parity.json")

EXPECTED_SQLITE_KIND = "sqlite"
EXPECTED_MARIADB_KIND = "mariadb-logical"

INSERT_RE = re.compile(
    r"^\s*INSERT\s+INTO\s+`?taxa`?\s*\((.*?)\)\s*VALUES\s*$",
    re.IGNORECASE,
)
SHARD_ID_RE = re.compile(
    r"^\s*--\s*shard_id\s*:\s*(\S+)\s*$",
    re.IGNORECASE,
)
SQLITE_COLUMNS_RE = re.compile(r"`([^`]+)`")


class ParityError(RuntimeError):
    def __init__(
        self,
        message: str,
        exit_code: int = EXIT_CONFIGURATION,
    ) -> None:
        super().__init__(message)
        self.exit_code = exit_code


@dataclass
class MariaDBParseResult:
    shard_id: str = ""
    columns: list[str] = field(default_factory=list)
    rows: int = 0
    identities: list[tuple[str, str]] = field(default_factory=list)


@dataclass
class ShardParity:
    shard_id: str
    sqlite_path: str
    mariadb_path: str
    sqlite_exists: bool = False
    mariadb_exists: bool = False
    sqlite_rows: int | None = None
    mariadb_rows: int | None = None
    manifest_sqlite_rows: int | None = None
    manifest_mariadb_rows: int | None = None
    sqlite_manifest_bytes: int | None = None
    mariadb_manifest_bytes: int | None = None
    sqlite_actual_bytes: int | None = None
    mariadb_actual_bytes: int | None = None
    sqlite_manifest_sha256: str = ""
    mariadb_manifest_sha256: str = ""
    sqlite_actual_sha256: str = ""
    mariadb_actual_sha256: str = ""
    sqlite_checksum_ok: bool | None = None
    mariadb_checksum_ok: bool | None = None
    sqlite_size_ok: bool | None = None
    mariadb_size_ok: bool | None = None
    mariadb_header_shard_id: str = ""
    ids_equal: bool | None = None
    hashes_equal: bool | None = None
    equal: bool = False
    issues: list[str] = field(default_factory=list)
    duration_seconds: float = 0.0


def human_duration(seconds: float) -> str:
    seconds = max(0, int(round(seconds)))
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def shard_id(value: Mapping[str, Any]) -> str:
    return clean_text(value.get("id") or value.get("shard_id"))


def shard_path(value: Mapping[str, Any]) -> str:
    return clean_text(
        value.get("path")
        or value.get("filename")
        or value.get("file")
    )


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


def safe_path(root: Path, relative: str) -> Path:
    candidate = Path(relative)
    if candidate.is_absolute():
        raise ParityError(
            f"Manifest path must be relative to its component root: {relative}"
        )

    path = (root / candidate).resolve()
    try:
        path.relative_to(root.resolve())
    except ValueError as error:
        raise ParityError(
            f"Manifest path escapes component root: {relative}"
        ) from error
    return path


def sqlite_connect_read_only(path: Path) -> sqlite3.Connection:
    uri = f"file:{path.resolve().as_posix()}?mode=ro&immutable=1"
    connection = sqlite3.connect(uri, uri=True)
    connection.execute("PRAGMA query_only = ON")
    return connection


def sqlite_validate_schema(path: Path) -> None:
    connection = sqlite_connect_read_only(path)
    try:
        row = connection.execute(
            "SELECT 1 FROM sqlite_master "
            "WHERE type='table' AND name='taxa'"
        ).fetchone()
        if row is None:
            raise ParityError(f"SQLite shard has no taxa table: {path}")

        columns = {
            clean_text(item[1])
            for item in connection.execute("PRAGMA table_info(taxa)")
        }
        required = {"speciedex_id", "record_hash"}
        missing = sorted(required - columns)
        if missing:
            raise ParityError(
                f"SQLite shard {path} is missing required column(s): "
                + ", ".join(missing)
            )
    finally:
        connection.close()


def sqlite_count(path: Path) -> int:
    connection = sqlite_connect_read_only(path)
    try:
        row = connection.execute("SELECT COUNT(*) FROM taxa").fetchone()
        return int(row[0] if row else 0)
    finally:
        connection.close()


def sqlite_identity_rows(path: Path) -> Iterator[tuple[str, str]]:
    connection = sqlite_connect_read_only(path)
    try:
        cursor = connection.execute(
            "SELECT speciedex_id, record_hash "
            "FROM taxa ORDER BY speciedex_id, record_hash"
        )
        for identifier, record_hash in cursor:
            yield clean_text(identifier), clean_text(record_hash)
    finally:
        connection.close()


def parse_sql_string(token: str) -> str:
    if len(token) < 2 or token[0] != "'" or token[-1] != "'":
        raise ValueError(f"Expected quoted SQL string, got {token!r}")

    value = token[1:-1]
    output: list[str] = []
    index = 0

    while index < len(value):
        character = value[index]

        if character == "'" and index + 1 < len(value):
            if value[index + 1] == "'":
                output.append("'")
                index += 2
                continue

        if character == "\\" and index + 1 < len(value):
            escaped = value[index + 1]
            mapping = {
                "0": "\0",
                "b": "\b",
                "n": "\n",
                "r": "\r",
                "t": "\t",
                "Z": "\x1a",
                "\\": "\\",
                "'": "'",
                '"': '"',
            }
            output.append(mapping.get(escaped, escaped))
            index += 2
            continue

        output.append(character)
        index += 1

    return "".join(output)


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

    if stripped.endswith(","):
        stripped = stripped[:-1].rstrip()
    elif stripped.endswith(";"):
        stripped = stripped[:-1].rstrip()

    if not stripped.endswith(")"):
        return None

    return split_sql_values(stripped[1:-1])


def parse_mariadb_shard(
    path: Path,
    *,
    collect_identities: bool,
) -> MariaDBParseResult:
    result = MariaDBParseResult()
    in_values = False
    id_index: int | None = None
    hash_index: int | None = None

    with gzip.open(path, "rt", encoding="utf-8", newline="") as handle:
        for line_number, line in enumerate(handle, 1):
            header = SHARD_ID_RE.match(line)
            if header:
                result.shard_id = clean_text(header.group(1))
                continue

            if not in_values:
                insert = INSERT_RE.match(line)
                if insert:
                    columns = [
                        clean_text(value)
                        for value in SQLITE_COLUMNS_RE.findall(insert.group(1))
                    ]

                    if not columns:
                        columns = [
                            clean_text(value).strip("`")
                            for value in insert.group(1).split(",")
                        ]

                    if len(columns) != len(set(columns)):
                        raise ParityError(
                            f"{path}:{line_number}: duplicate INSERT columns."
                        )

                    try:
                        id_index = columns.index("speciedex_id")
                        hash_index = columns.index("record_hash")
                    except ValueError as error:
                        raise ParityError(
                            f"{path}:{line_number}: INSERT is missing "
                            "speciedex_id or record_hash."
                        ) from error

                    result.columns = columns
                    in_values = True
                continue

            stripped = line.strip()
            if not stripped:
                continue

            if stripped.upper().startswith(("COMMIT", "UNLOCK", "SET ")):
                in_values = False
                continue

            values = parse_value_row(line)
            if values is None:
                continue

            if len(values) != len(result.columns):
                raise ParityError(
                    f"{path}:{line_number}: SQL row has {len(values)} values "
                    f"for {len(result.columns)} columns."
                )

            result.rows += 1

            if collect_identities:
                assert id_index is not None
                assert hash_index is not None
                identifier = parse_sql_string(values[id_index])
                record_hash = parse_sql_string(values[hash_index])
                result.identities.append((identifier, record_hash))

    if not result.columns:
        raise ParityError(
            f"MariaDB shard contains no recognized taxa INSERT statement: {path}"
        )

    return result


class DatabaseParityVerifier:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.db_root = args.db_root.resolve()
        self.sqlite_root = self.db_root / "sqlite"
        self.mariadb_root = self.db_root / "mariadb"
        self.report_path = args.report.resolve()
        self.logger = logging.getLogger("speciedex.database.parity")
        self.started = time.monotonic()
        self.issues: list[str] = []
        self.results: list[ShardParity] = []
        self.sqlite_manifest: Mapping[str, Any] | None = None
        self.mariadb_manifest: Mapping[str, Any] | None = None

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
        result: ShardParity | None = None,
    ) -> None:
        self.issues.append(message)
        if result is not None:
            result.issues.append(message)

    def validate(self) -> None:
        if not self.db_root.exists():
            raise ParityError(
                f"Database root does not exist: {self.db_root}"
            )
        if not self.db_root.is_dir():
            raise ParityError(
                f"Database root is not a directory: {self.db_root}"
            )

        if not self.sqlite_root.is_dir():
            raise ParityError(
                f"SQLite component directory is missing: {self.sqlite_root}"
            )
        if not self.mariadb_root.is_dir():
            raise ParityError(
                f"MariaDB component directory is missing: {self.mariadb_root}"
            )

        self.report_path.parent.mkdir(parents=True, exist_ok=True)
        probe: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                "w",
                encoding="utf-8",
                delete=False,
                dir=self.report_path.parent,
                prefix=".speciedex-parity-write-test.",
            ) as handle:
                handle.write("ok\n")
                probe = Path(handle.name)
        except OSError as error:
            raise ParityError(
                f"Report directory is not writable: "
                f"{self.report_path.parent}: {error}"
            ) from error
        finally:
            if probe is not None:
                probe.unlink(missing_ok=True)

    def load_manifests(
        self,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        sqlite_manifest_path = self.sqlite_root / "manifest.json"
        mariadb_manifest_path = self.mariadb_root / "manifest.json"

        if not sqlite_manifest_path.is_file():
            raise ParityError(
                f"Missing SQLite manifest: {sqlite_manifest_path}"
            )
        if not mariadb_manifest_path.is_file():
            raise ParityError(
                f"Missing MariaDB manifest: {mariadb_manifest_path}"
            )

        sqlite_manifest = load_manifest(sqlite_manifest_path)
        mariadb_manifest = load_manifest(mariadb_manifest_path)

        if clean_text(sqlite_manifest.get("kind")) != EXPECTED_SQLITE_KIND:
            raise ParityError(
                f"Unexpected SQLite manifest kind: "
                f"{sqlite_manifest.get('kind')!r}"
            )

        if (
            clean_text(mariadb_manifest.get("kind"))
            != EXPECTED_MARIADB_KIND
        ):
            raise ParityError(
                f"Unexpected MariaDB manifest kind: "
                f"{mariadb_manifest.get('kind')!r}"
            )

        return sqlite_manifest, mariadb_manifest

    def manifest_map(
        self,
        manifest: Mapping[str, Any],
        kind: str,
    ) -> dict[str, Mapping[str, Any]]:
        shards = manifest.get("shards", [])
        if not isinstance(shards, list):
            raise ParityError(
                f"{kind} manifest shards must be an array."
            )

        result: dict[str, Mapping[str, Any]] = {}

        for position, item in enumerate(shards, 1):
            if not isinstance(item, Mapping):
                self.add_issue(
                    f"{kind} manifest shard {position} is not an object."
                )
                continue

            identifier = shard_id(item)
            if not identifier:
                self.add_issue(
                    f"{kind} manifest shard {position} has no shard id."
                )
                continue

            if identifier in result:
                self.add_issue(
                    f"Duplicate {kind} shard id: {identifier}"
                )
                continue

            result[identifier] = item

        return result

    def verify_manifest_totals(
        self,
        sqlite_manifest: Mapping[str, Any],
        mariadb_manifest: Mapping[str, Any],
    ) -> None:
        sqlite_totals = sqlite_manifest.get("totals", {})
        mariadb_totals = mariadb_manifest.get("totals", {})

        if not isinstance(sqlite_totals, Mapping):
            self.add_issue("SQLite manifest totals are not an object.")
            sqlite_totals = {}

        if not isinstance(mariadb_totals, Mapping):
            self.add_issue("MariaDB manifest totals are not an object.")
            mariadb_totals = {}

        sqlite_shards = integer_or_none(sqlite_totals.get("shards"))
        mariadb_shards = integer_or_none(mariadb_totals.get("shards"))
        sqlite_records = integer_or_none(sqlite_totals.get("records"))
        mariadb_records = integer_or_none(mariadb_totals.get("records"))

        if sqlite_shards is None:
            self.add_issue("SQLite manifest has no valid shard total.")
        if mariadb_shards is None:
            self.add_issue("MariaDB manifest has no valid shard total.")
        if sqlite_records is None:
            self.add_issue("SQLite manifest has no valid record total.")
        if mariadb_records is None:
            self.add_issue("MariaDB manifest has no valid record total.")

        if (
            sqlite_shards is not None
            and mariadb_shards is not None
            and sqlite_shards != mariadb_shards
        ):
            self.add_issue(
                f"Manifest shard totals differ: "
                f"sqlite={sqlite_shards}, mariadb={mariadb_shards}"
            )

        if (
            sqlite_records is not None
            and mariadb_records is not None
            and sqlite_records != mariadb_records
        ):
            self.add_issue(
                f"Manifest record totals differ: "
                f"sqlite={sqlite_records}, mariadb={mariadb_records}"
            )

        if (
            self.args.expect_records is not None
            and sqlite_records is not None
            and sqlite_records != self.args.expect_records
        ):
            self.add_issue(
                f"SQLite manifest record total does not match "
                f"--expect-records: expected={self.args.expect_records}, "
                f"actual={sqlite_records}"
            )

        if (
            self.args.expect_records is not None
            and mariadb_records is not None
            and mariadb_records != self.args.expect_records
        ):
            self.add_issue(
                f"MariaDB manifest record total does not match "
                f"--expect-records: expected={self.args.expect_records}, "
                f"actual={mariadb_records}"
            )

    def verify_pair(
        self,
        identifier: str,
        sqlite_info: Mapping[str, Any],
        mariadb_info: Mapping[str, Any],
    ) -> ShardParity:
        started = time.monotonic()

        sqlite_relative = shard_path(sqlite_info)
        mariadb_relative = shard_path(mariadb_info)

        result = ShardParity(
            shard_id=identifier,
            sqlite_path=sqlite_relative,
            mariadb_path=mariadb_relative,
            manifest_sqlite_rows=integer_or_none(
                sqlite_info.get("records", sqlite_info.get("rows"))
            ),
            manifest_mariadb_rows=integer_or_none(
                mariadb_info.get("records", mariadb_info.get("rows"))
            ),
            sqlite_manifest_bytes=integer_or_none(
                sqlite_info.get("bytes")
            ),
            mariadb_manifest_bytes=integer_or_none(
                mariadb_info.get("bytes")
            ),
            sqlite_manifest_sha256=clean_text(
                sqlite_info.get("sha256")
            ),
            mariadb_manifest_sha256=clean_text(
                mariadb_info.get("sha256")
            ),
        )

        if not sqlite_relative:
            self.add_issue(
                f"SQLite shard {identifier} has no path.",
                result,
            )
        if not mariadb_relative:
            self.add_issue(
                f"MariaDB shard {identifier} has no path.",
                result,
            )
        if result.issues:
            result.duration_seconds = round(
                time.monotonic() - started,
                6,
            )
            return result

        try:
            sqlite_path = safe_path(
                self.sqlite_root,
                sqlite_relative,
            )
            mariadb_path = safe_path(
                self.mariadb_root,
                mariadb_relative,
            )
        except ParityError as error:
            self.add_issue(str(error), result)
            result.duration_seconds = round(
                time.monotonic() - started,
                6,
            )
            return result

        result.sqlite_path = sqlite_path.as_posix()
        result.mariadb_path = mariadb_path.as_posix()
        result.sqlite_exists = sqlite_path.is_file()
        result.mariadb_exists = mariadb_path.is_file()

        if not result.sqlite_exists:
            self.add_issue(
                f"Missing SQLite shard: {sqlite_path}",
                result,
            )
        if not result.mariadb_exists:
            self.add_issue(
                f"Missing MariaDB shard: {mariadb_path}",
                result,
            )
        if result.issues:
            result.duration_seconds = round(
                time.monotonic() - started,
                6,
            )
            return result

        result.sqlite_actual_bytes = sqlite_path.stat().st_size
        result.mariadb_actual_bytes = mariadb_path.stat().st_size
        result.sqlite_actual_sha256 = sha256_file(sqlite_path)
        result.mariadb_actual_sha256 = sha256_file(mariadb_path)

        if result.sqlite_manifest_bytes is not None:
            result.sqlite_size_ok = (
                result.sqlite_actual_bytes
                == result.sqlite_manifest_bytes
            )
            if not result.sqlite_size_ok:
                self.add_issue(
                    f"SQLite size mismatch for shard {identifier}.",
                    result,
                )

        if result.mariadb_manifest_bytes is not None:
            result.mariadb_size_ok = (
                result.mariadb_actual_bytes
                == result.mariadb_manifest_bytes
            )
            if not result.mariadb_size_ok:
                self.add_issue(
                    f"MariaDB size mismatch for shard {identifier}.",
                    result,
                )

        if result.sqlite_manifest_sha256:
            result.sqlite_checksum_ok = (
                result.sqlite_actual_sha256.casefold()
                == result.sqlite_manifest_sha256.casefold()
            )
            if not result.sqlite_checksum_ok:
                self.add_issue(
                    f"SQLite checksum mismatch for shard {identifier}.",
                    result,
                )
        elif self.args.require_checksums:
            self.add_issue(
                f"SQLite manifest has no checksum for shard {identifier}.",
                result,
            )

        if result.mariadb_manifest_sha256:
            result.mariadb_checksum_ok = (
                result.mariadb_actual_sha256.casefold()
                == result.mariadb_manifest_sha256.casefold()
            )
            if not result.mariadb_checksum_ok:
                self.add_issue(
                    f"MariaDB checksum mismatch for shard {identifier}.",
                    result,
                )
        elif self.args.require_checksums:
            self.add_issue(
                f"MariaDB manifest has no checksum for shard {identifier}.",
                result,
            )

        try:
            sqlite_validate_schema(sqlite_path)
            result.sqlite_rows = sqlite_count(sqlite_path)
        except (sqlite3.Error, ParityError) as error:
            self.add_issue(
                f"Unable to inspect SQLite shard {identifier}: {error}",
                result,
            )

        mariadb_parse: MariaDBParseResult | None = None
        try:
            mariadb_parse = parse_mariadb_shard(
                mariadb_path,
                collect_identities=self.args.deep,
            )
            result.mariadb_rows = mariadb_parse.rows
            result.mariadb_header_shard_id = mariadb_parse.shard_id

            if (
                mariadb_parse.shard_id
                and mariadb_parse.shard_id != identifier
            ):
                self.add_issue(
                    f"MariaDB header shard id mismatch for {identifier}: "
                    f"header={mariadb_parse.shard_id}",
                    result,
                )
        except (OSError, EOFError, UnicodeError, ValueError, ParityError) as error:
            self.add_issue(
                f"Unable to inspect MariaDB shard {identifier}: {error}",
                result,
            )

        counts = (
            result.sqlite_rows,
            result.mariadb_rows,
            result.manifest_sqlite_rows,
            result.manifest_mariadb_rows,
        )
        known_counts = [
            value for value in counts if value is not None
        ]

        if known_counts and len(set(known_counts)) != 1:
            self.add_issue(
                f"Row-count mismatch for shard {identifier}: "
                f"sqlite={result.sqlite_rows}, "
                f"mariadb={result.mariadb_rows}, "
                f"manifest_sqlite={result.manifest_sqlite_rows}, "
                f"manifest_mariadb={result.manifest_mariadb_rows}",
                result,
            )

        if self.args.deep and mariadb_parse is not None:
            try:
                sqlite_rows = list(
                    sqlite_identity_rows(sqlite_path)
                )
            except sqlite3.Error as error:
                self.add_issue(
                    f"Unable to read SQLite identities for shard "
                    f"{identifier}: {error}",
                    result,
                )
                sqlite_rows = []

            mariadb_rows = sorted(mariadb_parse.identities)
            sqlite_rows = sorted(sqlite_rows)

            sqlite_ids = [item[0] for item in sqlite_rows]
            mariadb_ids = [item[0] for item in mariadb_rows]
            result.ids_equal = sqlite_ids == mariadb_ids

            if not result.ids_equal:
                self.add_issue(
                    f"Record identifier mismatch for shard {identifier}.",
                    result,
                )
            else:
                result.hashes_equal = sqlite_rows == mariadb_rows
                if not result.hashes_equal:
                    self.add_issue(
                        f"Record hash mismatch for shard {identifier}.",
                        result,
                    )

        result.equal = not result.issues
        result.duration_seconds = round(
            time.monotonic() - started,
            6,
        )
        return result

    def verify_result_totals(self) -> None:
        sqlite_total = sum(
            result.sqlite_rows or 0
            for result in self.results
        )
        mariadb_total = sum(
            result.mariadb_rows or 0
            for result in self.results
        )

        if sqlite_total != mariadb_total:
            self.add_issue(
                f"Observed record totals differ: "
                f"sqlite={sqlite_total}, mariadb={mariadb_total}"
            )

        if self.sqlite_manifest is not None:
            totals = self.sqlite_manifest.get("totals")
            if isinstance(totals, Mapping):
                expected = integer_or_none(totals.get("records"))
                if expected is not None and sqlite_total != expected:
                    self.add_issue(
                        f"Observed SQLite rows do not match its manifest: "
                        f"manifest={expected}, observed={sqlite_total}"
                    )

        if self.mariadb_manifest is not None:
            totals = self.mariadb_manifest.get("totals")
            if isinstance(totals, Mapping):
                expected = integer_or_none(totals.get("records"))
                if expected is not None and mariadb_total != expected:
                    self.add_issue(
                        f"Observed MariaDB rows do not match its manifest: "
                        f"manifest={expected}, observed={mariadb_total}"
                    )

    def report_payload(self) -> dict[str, Any]:
        elapsed = time.monotonic() - self.started

        return {
            "schema_version": 3,
            "kind": "database-parity-report",
            "generated_at": utc_now(),
            "status": "mismatch" if self.issues else "success",
            "database_root": self.db_root.as_posix(),
            "equal": not self.issues,
            "deep": self.args.deep,
            "duration_seconds": round(elapsed, 6),
            "duration": human_duration(elapsed),
            "totals": {
                "shards_checked": len(self.results),
                "shards_equal": sum(
                    1 for result in self.results if result.equal
                ),
                "shards_unequal": sum(
                    1 for result in self.results if not result.equal
                ),
                "sqlite_rows": sum(
                    result.sqlite_rows or 0
                    for result in self.results
                ),
                "mariadb_rows": sum(
                    result.mariadb_rows or 0
                    for result in self.results
                ),
                "issues": len(self.issues),
            },
            "manifest_totals": {
                "sqlite": (
                    self.sqlite_manifest.get("totals", {})
                    if isinstance(self.sqlite_manifest, Mapping)
                    else {}
                ),
                "mariadb": (
                    self.mariadb_manifest.get("totals", {})
                    if isinstance(self.mariadb_manifest, Mapping)
                    else {}
                ),
            },
            "issues": list(self.issues),
            "shards": [asdict(result) for result in self.results],
        }

    def write_report(self) -> None:
        if not self.args.dry_run:
            atomic_write_json(
                self.report_path,
                self.report_payload(),
            )

    def run(self) -> int:
        self.configure_logging()

        try:
            self.validate()
            (
                self.sqlite_manifest,
                self.mariadb_manifest,
            ) = self.load_manifests()

            self.verify_manifest_totals(
                self.sqlite_manifest,
                self.mariadb_manifest,
            )

            sqlite_map = self.manifest_map(
                self.sqlite_manifest,
                "SQLite",
            )
            mariadb_map = self.manifest_map(
                self.mariadb_manifest,
                "MariaDB",
            )

            sqlite_ids = set(sqlite_map)
            mariadb_ids = set(mariadb_map)

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

            for identifier in sorted(sqlite_ids & mariadb_ids):
                self.results.append(
                    self.verify_pair(
                        identifier,
                        sqlite_map[identifier],
                        mariadb_map[identifier],
                    )
                )

            self.verify_result_totals()
            self.write_report()

        except KeyboardInterrupt:
            self.logger.error(
                "Database parity verification interrupted."
            )
            return EXIT_INTERRUPTED

        except ParityError as error:
            self.logger.error("%s", error)
            with contextlib.suppress(Exception):
                self.add_issue(str(error))
                self.write_report()
            return error.exit_code

        except Exception as error:
            self.logger.error(
                "Database parity verification failed: %s",
                error,
            )
            if self.args.verbose:
                self.logger.exception("Detailed failure")
            with contextlib.suppress(Exception):
                self.add_issue(
                    f"{type(error).__name__}: {error}"
                )
                self.write_report()
            return EXIT_CONFIGURATION

        if self.issues:
            for issue in self.issues:
                self.logger.error("%s", issue)
            return EXIT_MISMATCH

        self.logger.info(
            "SQLite and MariaDB database products are in parity "
            "across %d shard(s) in %s.",
            len(self.results),
            human_duration(time.monotonic() - self.started),
        )
        return EXIT_SUCCESS


def parse_args(
    argv: Sequence[str] | None = None,
) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Verify SQLite and MariaDB shard parity without executing SQL."
        ),
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )

    parser.add_argument(
        "--db-root",
        type=Path,
        default=DEFAULT_DB_ROOT,
        help="Root containing sqlite/ and mariadb/ component directories.",
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=DEFAULT_REPORT,
        help="Destination JSON parity report.",
    )
    parser.add_argument(
        "--deep",
        action="store_true",
        help="Compare per-record identifiers and record hashes.",
    )
    parser.add_argument(
        "--expect-records",
        type=int,
        default=None,
        help="Expected total record count in both products.",
    )
    parser.add_argument(
        "--require-checksums",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Require shard checksums in both component manifests.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Run checks without writing the report.",
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

    if args.expect_records is not None and args.expect_records < 0:
        parser.error("--expect-records cannot be negative.")

    if args.verbose and args.quiet:
        parser.error(
            "--verbose and --quiet cannot be used together."
        )

    return args


def main(argv: Sequence[str] | None = None) -> int:
    return DatabaseParityVerifier(parse_args(argv)).run()


if __name__ == "__main__":
    raise SystemExit(main())
