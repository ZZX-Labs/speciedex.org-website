#!/usr/bin/env python3
"""
Verify parity between Speciedex SQLite and MariaDB shard products.

Expected location:
    static/tools/database/verify-database-parity.py

This verifier compares component manifests, shard identities, row counts,
manifest declarations, and optionally record-level identifiers and hashes.

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

INSERT_LINE_RE = re.compile(r"^\s*\(")
VALUE_ROW_RE = re.compile(r"^\s*\((.*)\)\s*,?\s*$")
SQL_STRING_RE = re.compile(r"'((?:''|\\.|[^'])*)'")
SHARD_ID_RE = re.compile(r"--\s*shard_id:\s*(\S+)", re.IGNORECASE)


class ParityError(RuntimeError):
    def __init__(self, message: str, exit_code: int = EXIT_CONFIGURATION) -> None:
        super().__init__(message)
        self.exit_code = exit_code


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
    sqlite_manifest_sha256: str = ""
    mariadb_manifest_sha256: str = ""
    sqlite_actual_sha256: str = ""
    mariadb_actual_sha256: str = ""
    sqlite_checksum_ok: bool | None = None
    mariadb_checksum_ok: bool | None = None
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
    return clean_text(value.get("path") or value.get("filename"))


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
    path = (root / relative).resolve()
    try:
        path.relative_to(root.resolve())
    except ValueError as error:
        raise ParityError(
            f"Manifest path escapes component root: {relative}"
        ) from error
    return path


def sqlite_count(path: Path) -> int:
    uri = f"file:{path.resolve()}?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    try:
        row = connection.execute("SELECT COUNT(*) FROM taxa").fetchone()
        return int(row[0] if row else 0)
    finally:
        connection.close()


def sqlite_identity_rows(path: Path) -> Iterator[tuple[str, str]]:
    uri = f"file:{path.resolve()}?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    try:
        for identifier, record_hash in connection.execute(
            "SELECT speciedex_id, record_hash "
            "FROM taxa ORDER BY speciedex_id"
        ):
            yield clean_text(identifier), clean_text(record_hash)
    finally:
        connection.close()


def mariadb_count(path: Path) -> int:
    count = 0
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        for line in handle:
            if INSERT_LINE_RE.match(line):
                count += 1
    return count


def unescape_sql_string(value: str) -> str:
    return value.replace("''", "'").replace("\\\\", "\\")


def mariadb_identity_rows(path: Path) -> Iterator[tuple[str, str]]:
    """
    Extract speciedex_id and record_hash from logical SQL rows.

    The generated MariaDB shard uses SQLITE_COLUMNS order, where
    speciedex_id is the first column and record_hash is the penultimate column.
    """
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        for line in handle:
            if not INSERT_LINE_RE.match(line):
                continue

            match = VALUE_ROW_RE.match(line)
            if not match:
                continue

            strings = SQL_STRING_RE.findall(match.group(1))
            if len(strings) < 2:
                continue

            identifier = unescape_sql_string(strings[0])
            record_hash = unescape_sql_string(strings[-2])
            yield identifier, record_hash


class DatabaseParityVerifier:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.db_root = args.db_root.resolve()
        self.report_path = args.report.resolve()
        self.logger = logging.getLogger("speciedex.database.parity")
        self.started = time.monotonic()
        self.issues: list[str] = []
        self.results: list[ShardParity] = []

    def configure_logging(self) -> None:
        level = logging.DEBUG if self.args.verbose else logging.INFO
        if self.args.quiet:
            level = logging.WARNING

        logging.basicConfig(
            level=level,
            format="%(asctime)s %(levelname)s %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )

    def add_issue(self, message: str, result: ShardParity | None = None) -> None:
        self.issues.append(message)
        if result is not None:
            result.issues.append(message)

    def validate(self) -> None:
        if not self.db_root.exists():
            raise ParityError(f"Database root does not exist: {self.db_root}")
        if not self.db_root.is_dir():
            raise ParityError(f"Database root is not a directory: {self.db_root}")

    def load_manifests(self) -> tuple[dict[str, Any], dict[str, Any]]:
        sqlite_manifest_path = self.db_root / "sqlite" / "manifest.json"
        mariadb_manifest_path = self.db_root / "mariadb" / "manifest.json"

        if not sqlite_manifest_path.is_file():
            raise ParityError(f"Missing SQLite manifest: {sqlite_manifest_path}")
        if not mariadb_manifest_path.is_file():
            raise ParityError(f"Missing MariaDB manifest: {mariadb_manifest_path}")

        return (
            load_manifest(sqlite_manifest_path),
            load_manifest(mariadb_manifest_path),
        )

    def manifest_map(
        self,
        manifest: Mapping[str, Any],
        kind: str,
    ) -> dict[str, Mapping[str, Any]]:
        shards = manifest.get("shards", [])
        if not isinstance(shards, list):
            raise ParityError(f"{kind} manifest shards must be an array.")

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

        sqlite_shards = integer_or_none(
            sqlite_totals.get("shards") if isinstance(sqlite_totals, Mapping) else None
        )
        mariadb_shards = integer_or_none(
            mariadb_totals.get("shards") if isinstance(mariadb_totals, Mapping) else None
        )
        sqlite_records = integer_or_none(
            sqlite_totals.get("records") if isinstance(sqlite_totals, Mapping) else None
        )
        mariadb_records = integer_or_none(
            mariadb_totals.get("records") if isinstance(mariadb_totals, Mapping) else None
        )

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

    def verify_pair(
        self,
        identifier: str,
        sqlite_info: Mapping[str, Any],
        mariadb_info: Mapping[str, Any],
    ) -> ShardParity:
        started = time.monotonic()

        sqlite_relative = shard_path(sqlite_info)
        mariadb_relative = shard_path(mariadb_info)
        sqlite_root = self.db_root / "sqlite"
        mariadb_root = self.db_root / "mariadb"

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
            sqlite_manifest_sha256=clean_text(sqlite_info.get("sha256")),
            mariadb_manifest_sha256=clean_text(mariadb_info.get("sha256")),
        )

        if not sqlite_relative:
            self.add_issue(f"SQLite shard {identifier} has no path.", result)
            return result
        if not mariadb_relative:
            self.add_issue(f"MariaDB shard {identifier} has no path.", result)
            return result

        sqlite_path = safe_path(sqlite_root, sqlite_relative)
        mariadb_path = safe_path(mariadb_root, mariadb_relative)

        result.sqlite_path = sqlite_path.as_posix()
        result.mariadb_path = mariadb_path.as_posix()
        result.sqlite_exists = sqlite_path.is_file()
        result.mariadb_exists = mariadb_path.is_file()

        if not result.sqlite_exists:
            self.add_issue(f"Missing SQLite shard: {sqlite_path}", result)
        if not result.mariadb_exists:
            self.add_issue(f"Missing MariaDB shard: {mariadb_path}", result)
        if result.issues:
            result.duration_seconds = round(time.monotonic() - started, 6)
            return result

        result.sqlite_actual_sha256 = sha256_file(sqlite_path)
        result.mariadb_actual_sha256 = sha256_file(mariadb_path)

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

        try:
            result.sqlite_rows = sqlite_count(sqlite_path)
        except sqlite3.Error as error:
            self.add_issue(
                f"Unable to count SQLite shard {identifier}: {error}",
                result,
            )

        try:
            result.mariadb_rows = mariadb_count(mariadb_path)
        except (OSError, EOFError, UnicodeError) as error:
            self.add_issue(
                f"Unable to count MariaDB shard {identifier}: {error}",
                result,
            )

        counts = (
            result.sqlite_rows,
            result.mariadb_rows,
            result.manifest_sqlite_rows,
            result.manifest_mariadb_rows,
        )
        known_counts = [value for value in counts if value is not None]

        if known_counts and len(set(known_counts)) != 1:
            self.add_issue(
                f"Row-count mismatch for shard {identifier}: "
                f"sqlite={result.sqlite_rows}, "
                f"mariadb={result.mariadb_rows}, "
                f"manifest_sqlite={result.manifest_sqlite_rows}, "
                f"manifest_mariadb={result.manifest_mariadb_rows}",
                result,
            )

        if self.args.deep and not result.issues:
            sqlite_rows = list(sqlite_identity_rows(sqlite_path))
            mariadb_rows = sorted(mariadb_identity_rows(mariadb_path))

            sqlite_ids = [item[0] for item in sqlite_rows]
            mariadb_ids = [item[0] for item in mariadb_rows]
            result.ids_equal = sqlite_ids == mariadb_ids

            if not result.ids_equal:
                self.add_issue(
                    f"Record identifier mismatch for shard {identifier}.",
                    result,
                )

            if result.ids_equal:
                sqlite_hashes = dict(sqlite_rows)
                mariadb_hashes = dict(mariadb_rows)
                result.hashes_equal = sqlite_hashes == mariadb_hashes
                if not result.hashes_equal:
                    self.add_issue(
                        f"Record hash mismatch for shard {identifier}.",
                        result,
                    )

        result.equal = not result.issues
        result.duration_seconds = round(time.monotonic() - started, 6)
        return result

    def write_report(
        self,
        sqlite_manifest: Mapping[str, Any] | None,
        mariadb_manifest: Mapping[str, Any] | None,
    ) -> None:
        if self.args.dry_run:
            return

        elapsed = time.monotonic() - self.started
        report = {
            "schema_version": 2,
            "generated_at": utc_now(),
            "database_root": self.db_root.as_posix(),
            "equal": not self.issues,
            "deep": self.args.deep,
            "duration_seconds": round(elapsed, 6),
            "duration": human_duration(elapsed),
            "totals": {
                "shards_checked": len(self.results),
                "shards_equal": sum(1 for result in self.results if result.equal),
                "shards_unequal": sum(1 for result in self.results if not result.equal),
                "issues": len(self.issues),
            },
            "manifest_totals": {
                "sqlite": (
                    sqlite_manifest.get("totals", {})
                    if isinstance(sqlite_manifest, Mapping)
                    else {}
                ),
                "mariadb": (
                    mariadb_manifest.get("totals", {})
                    if isinstance(mariadb_manifest, Mapping)
                    else {}
                ),
            },
            "issues": self.issues,
            "shards": [asdict(result) for result in self.results],
        }
        atomic_write_json(self.report_path, report)

    def run(self) -> int:
        self.configure_logging()
        sqlite_manifest: Mapping[str, Any] | None = None
        mariadb_manifest: Mapping[str, Any] | None = None

        try:
            self.validate()
            sqlite_manifest, mariadb_manifest = self.load_manifests()
            self.verify_manifest_totals(sqlite_manifest, mariadb_manifest)

            sqlite_map = self.manifest_map(sqlite_manifest, "SQLite")
            mariadb_map = self.manifest_map(mariadb_manifest, "MariaDB")

            sqlite_ids = set(sqlite_map)
            mariadb_ids = set(mariadb_map)

            for identifier in sorted(sqlite_ids - mariadb_ids):
                self.add_issue(
                    f"SQLite shard has no MariaDB counterpart: {identifier}"
                )

            for identifier in sorted(mariadb_ids - sqlite_ids):
                self.add_issue(
                    f"MariaDB shard has no SQLite counterpart: {identifier}"
                )

            for identifier in sorted(sqlite_ids & mariadb_ids):
                self.results.append(
                    self.verify_pair(
                        identifier,
                        sqlite_map[identifier],
                        mariadb_map[identifier],
                    )
                )

            self.write_report(sqlite_manifest, mariadb_manifest)

        except KeyboardInterrupt:
            self.logger.error("Database parity verification interrupted.")
            return EXIT_INTERRUPTED
        except ParityError as error:
            self.logger.error("%s", error)
            return error.exit_code
        except Exception as error:
            self.logger.error("Database parity verification failed: %s", error)
            if self.args.verbose:
                self.logger.exception("Detailed failure")
            return EXIT_CONFIGURATION

        if self.issues:
            for issue in self.issues:
                self.logger.error("%s", issue)
            return EXIT_MISMATCH

        self.logger.info(
            "SQLite and MariaDB database products are in parity across "
            "%d shard(s) in %s.",
            len(self.results),
            human_duration(time.monotonic() - self.started),
        )
        return EXIT_SUCCESS


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Verify SQLite/MariaDB shard parity.",
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

    if args.verbose and args.quiet:
        parser.error("--verbose and --quiet cannot be used together.")

    return args


def main(argv: Sequence[str] | None = None) -> int:
    return DatabaseParityVerifier(parse_args(argv)).run()


if __name__ == "__main__":
    raise SystemExit(main())
