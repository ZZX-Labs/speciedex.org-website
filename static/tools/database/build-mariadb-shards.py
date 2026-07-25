#!/usr/bin/env python3
"""
Build deterministic Speciedex MariaDB logical shards.

Expected location:
    static/tools/database/build-mariadb-shards.py

This tool converts canonical Speciedex taxonomy records into compressed,
logical MariaDB import shards. It preserves compatibility with the existing
database/common.py helpers while adding validation, dry-run support, resume
metadata, verification, deterministic cleanup, progress reporting, and
structured build summaries.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import logging
import os
import shutil
import sys
import time
from dataclasses import asdict, dataclass, field
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
SCHEMA_FILENAME = "schema.sql"
SHARD_PATTERN = "speciedex-*.sql.gz"


def _common():
    try:
        from common import (
            DEFAULT_MAX_FILE_BYTES,
            DEFAULT_ROWS_PER_SHARD,
            DEFAULT_TARGET_FILE_BYTES,
            MARIADB_SCHEMA,
            atomic_write_text,
            build_mariadb_shard,
            check_max_file_size,
            chunk_records,
            iter_canonical_records,
            remove_generated_files,
            write_manifest,
        )
    except ModuleNotFoundError as error:
        raise RuntimeError(
            "Unable to import static/tools/database/common.py. "
            "Run this script from the Speciedex repository with the database "
            "tooling directory intact."
        ) from error

    return {
        "DEFAULT_MAX_FILE_BYTES": DEFAULT_MAX_FILE_BYTES,
        "DEFAULT_ROWS_PER_SHARD": DEFAULT_ROWS_PER_SHARD,
        "DEFAULT_TARGET_FILE_BYTES": DEFAULT_TARGET_FILE_BYTES,
        "MARIADB_SCHEMA": MARIADB_SCHEMA,
        "atomic_write_text": atomic_write_text,
        "build_mariadb_shard": build_mariadb_shard,
        "check_max_file_size": check_max_file_size,
        "chunk_records": chunk_records,
        "iter_canonical_records": iter_canonical_records,
        "remove_generated_files": remove_generated_files,
        "write_manifest": write_manifest,
    }


def utc_now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


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
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


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


@dataclass
class BuildState:
    schema_version: int = 1
    status: str = "pending"
    started_at: str = ""
    finished_at: str = ""
    taxonomy_root: str = ""
    output: str = ""
    current_shard: str = ""
    completed_shards: list[dict[str, Any]] = field(default_factory=list)
    total_records: int = 0
    last_error: str = ""
    interrupted: bool = False


class MariaDBShardBuildError(RuntimeError):
    def __init__(self, message: str, exit_code: int = EXIT_BUILD) -> None:
        super().__init__(message)
        self.exit_code = exit_code


class MariaDBShardBuilder:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.taxonomy_root = args.taxonomy_root.resolve()
        self.output = args.output.resolve()
        self.state_path = (args.state_file or self.output / STATE_FILENAME).resolve()
        self.summary_path = (
            args.summary_file or self.output / SUMMARY_FILENAME
        ).resolve()
        self.started = time.monotonic()
        self.logger = logging.getLogger("speciedex.database.mariadb_shards")
        self.shards: list[dict[str, Any]] = []
        self.shard_summaries: list[ShardSummary] = []
        self.state = BuildState(
            status="pending",
            started_at=utc_now(),
            taxonomy_root=str(self.taxonomy_root),
            output=str(self.output),
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

    def validate(self) -> None:
        if not self.taxonomy_root.exists():
            raise MariaDBShardBuildError(
                f"Taxonomy root does not exist: {self.taxonomy_root}",
                EXIT_VALIDATION,
            )

        if not self.taxonomy_root.is_dir():
            raise MariaDBShardBuildError(
                f"Taxonomy root is not a directory: {self.taxonomy_root}",
                EXIT_VALIDATION,
            )

        if self.args.rows_per_shard < 1:
            raise MariaDBShardBuildError(
                "--rows-per-shard must be at least 1.",
                EXIT_VALIDATION,
            )

        if self.args.target_bytes < 1:
            raise MariaDBShardBuildError(
                "--target-bytes must be at least 1.",
                EXIT_VALIDATION,
            )

        if self.args.max_bytes < 1:
            raise MariaDBShardBuildError(
                "--max-bytes must be at least 1.",
                EXIT_VALIDATION,
            )

        if self.args.target_bytes > self.args.max_bytes:
            raise MariaDBShardBuildError(
                "--target-bytes cannot exceed --max-bytes.",
                EXIT_VALIDATION,
            )

        self.output.mkdir(parents=True, exist_ok=True)

        probe = self.output / ".speciedex-write-test"
        try:
            probe.write_text("ok\n", encoding="utf-8")
            probe.unlink()
        except OSError as error:
            raise MariaDBShardBuildError(
                f"Output directory is not writable: {self.output}: {error}",
                EXIT_VALIDATION,
            ) from error

        usage = shutil.disk_usage(self.output)
        if usage.free < self.args.minimum_free_bytes:
            raise MariaDBShardBuildError(
                (
                    f"Insufficient free disk space under {self.output}: "
                    f"{usage.free} bytes available, "
                    f"{self.args.minimum_free_bytes} required."
                ),
                EXIT_VALIDATION,
            )

    def load_previous_state(self) -> BuildState | None:
        if not self.state_path.is_file():
            return None

        try:
            payload = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            self.logger.warning("Unable to read previous state: %s", error)
            return None

        if not isinstance(payload, dict):
            return None

        try:
            return BuildState(**payload)
        except TypeError:
            self.logger.warning("Ignoring incompatible previous state file.")
            return None

    def save_state(self) -> None:
        self.state.completed_shards = [
            asdict(summary) for summary in self.shard_summaries
        ]
        atomic_write_json(self.state_path, asdict(self.state))

    def clean_outputs(self) -> None:
        common = _common()

        if self.args.resume:
            return

        if not self.args.clean:
            return

        if self.args.dry_run:
            self.logger.info("Dry run: would remove existing generated outputs.")
            return

        common["remove_generated_files"](
            self.output,
            (
                SHARD_PATTERN,
                MANIFEST_FILENAME,
                SCHEMA_FILENAME,
                SUMMARY_FILENAME,
            ),
        )

    def write_schema(self) -> None:
        common = _common()
        schema_path = self.output / SCHEMA_FILENAME

        if self.args.dry_run:
            self.logger.info("Dry run: would write %s", schema_path)
            return

        common["atomic_write_text"](
            schema_path,
            common["MARIADB_SCHEMA"].rstrip() + "\n",
        )

    def existing_completed_ids(self) -> set[str]:
        if not self.args.resume:
            return set()

        previous = self.load_previous_state()
        if previous is None:
            return set()

        completed: set[str] = set()

        for entry in previous.completed_shards:
            shard_id = clean_text(entry.get("shard_id"))
            filename = clean_text(entry.get("filename"))
            if not shard_id or not filename:
                continue

            path = self.output / filename
            if path.is_file():
                completed.add(shard_id)

        self.logger.info(
            "Resume mode found %d completed shard(s).",
            len(completed),
        )
        return completed

    def build_shards(self) -> None:
        common = _common()
        completed_ids = self.existing_completed_ids()

        records_iter = common["iter_canonical_records"](self.taxonomy_root)
        chunks = common["chunk_records"](
            records_iter,
            rows_per_shard=self.args.rows_per_shard,
            target_bytes=self.args.target_bytes,
        )

        for index, records in enumerate(chunks, 1):
            shard_id = f"{index:06d}"
            filename = f"speciedex-{shard_id}.sql.gz"
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
                metadata = {
                    "shard_id": shard_id,
                    "filename": filename,
                    "records": record_count,
                    "bytes": 0,
                    "sha256": "",
                }
                self.logger.info(
                    "Dry run: would build shard %s with %d record(s).",
                    shard_id,
                    record_count,
                )
            else:
                metadata = common["build_mariadb_shard"](
                    records,
                    destination,
                    shard_id=shard_id,
                )

            elapsed = time.monotonic() - started
            finished_at = utc_now()
            record_count = int(
                metadata.get("records", metadata.get("rows", len(records)))
            )
            size = 0 if self.args.dry_run else destination.stat().st_size
            digest = "" if self.args.dry_run else sha256_file(destination)

            if size > self.args.max_bytes:
                raise MariaDBShardBuildError(
                    (
                        f"Shard {filename} exceeds maximum size: "
                        f"{size} > {self.args.max_bytes} bytes."
                    ),
                    EXIT_BUILD,
                )

            normalized_metadata = dict(metadata)
            normalized_metadata.setdefault("shard_id", shard_id)
            normalized_metadata.setdefault("filename", filename)
            normalized_metadata.setdefault("records", record_count)
            normalized_metadata.setdefault("bytes", size)
            normalized_metadata.setdefault("sha256", digest)
            self.shards.append(normalized_metadata)

            summary = ShardSummary(
                shard_id=shard_id,
                filename=filename,
                records=record_count,
                bytes=size,
                sha256=digest,
                started_at=started_at,
                finished_at=finished_at,
                duration_seconds=round(elapsed, 6),
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

    def write_manifest(self) -> dict[str, Any]:
        common = _common()

        if self.args.dry_run:
            manifest = {
                "schema_version": 1,
                "kind": "mariadb-logical",
                "source": self.taxonomy_root.as_posix(),
                "schema": SCHEMA_FILENAME,
                "compression": "gzip",
                "totals": {
                    "shards": len(self.shards),
                    "records": sum(
                        int(item.get("records", 0)) for item in self.shards
                    ),
                },
                "shards": self.shards,
            }
            self.logger.info(
                "Dry run: would write %s",
                self.output / MANIFEST_FILENAME,
            )
            return manifest

        return common["write_manifest"](
            self.output / MANIFEST_FILENAME,
            kind="mariadb-logical",
            shards=self.shards,
            source=self.taxonomy_root.as_posix(),
            extra={
                "schema": SCHEMA_FILENAME,
                "compression": "gzip",
                "rows_per_shard": self.args.rows_per_shard,
                "target_bytes": self.args.target_bytes,
                "max_bytes": self.args.max_bytes,
            },
        )

    def verify_outputs(self, manifest: Mapping[str, Any]) -> None:
        if self.args.dry_run or not self.args.verify:
            return

        schema_path = self.output / SCHEMA_FILENAME
        manifest_path = self.output / MANIFEST_FILENAME

        if not schema_path.is_file():
            raise MariaDBShardBuildError(
                f"Missing generated schema: {schema_path}",
                EXIT_VERIFICATION,
            )

        if not manifest_path.is_file():
            raise MariaDBShardBuildError(
                f"Missing generated manifest: {manifest_path}",
                EXIT_VERIFICATION,
            )

        try:
            json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            raise MariaDBShardBuildError(
                f"Generated manifest is invalid JSON: {error}",
                EXIT_VERIFICATION,
            ) from error

        expected_shards = int(
            manifest.get("totals", {}).get("shards", len(self.shards))
        )
        actual_paths = sorted(self.output.glob(SHARD_PATTERN))

        if len(actual_paths) != expected_shards:
            raise MariaDBShardBuildError(
                (
                    "Shard count mismatch: "
                    f"manifest={expected_shards}, files={len(actual_paths)}"
                ),
                EXIT_VERIFICATION,
            )

        total_records = 0

        for path in actual_paths:
            try:
                with gzip.open(path, "rt", encoding="utf-8") as handle:
                    handle.read(1)
            except (OSError, UnicodeError) as error:
                raise MariaDBShardBuildError(
                    f"Invalid gzip SQL shard {path}: {error}",
                    EXIT_VERIFICATION,
                ) from error

            if path.stat().st_size > self.args.max_bytes:
                raise MariaDBShardBuildError(
                    f"Shard exceeds maximum size: {path}",
                    EXIT_VERIFICATION,
                )

        for shard in self.shards:
            total_records += int(shard.get("records", 0))

        manifest_records = int(
            manifest.get("totals", {}).get("records", total_records)
        )
        if manifest_records != total_records:
            raise MariaDBShardBuildError(
                (
                    "Record count mismatch: "
                    f"manifest={manifest_records}, built={total_records}"
                ),
                EXIT_VERIFICATION,
            )

    def write_summary(
        self,
        manifest: Mapping[str, Any] | None,
        exit_code: int,
    ) -> None:
        elapsed = time.monotonic() - self.started
        payload = {
            "schema_version": 1,
            "status": self.state.status,
            "exit_code": exit_code,
            "started_at": self.state.started_at,
            "finished_at": self.state.finished_at or utc_now(),
            "duration_seconds": round(elapsed, 6),
            "duration": human_duration(elapsed),
            "taxonomy_root": str(self.taxonomy_root),
            "output": str(self.output),
            "options": {
                "rows_per_shard": self.args.rows_per_shard,
                "target_bytes": self.args.target_bytes,
                "max_bytes": self.args.max_bytes,
                "clean": self.args.clean,
                "resume": self.args.resume,
                "verify": self.args.verify,
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
            "shards": [asdict(summary) for summary in self.shard_summaries],
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
            self.write_schema()
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
            self.logger.error("MariaDB shard build interrupted.")
            return EXIT_INTERRUPTED

        except MariaDBShardBuildError as error:
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
            self.logger.error("MariaDB shard build failed: %s", error)
            if self.args.verbose:
                self.logger.exception("Detailed failure")
            return EXIT_BUILD

        totals = manifest.get("totals", {}) if manifest else {}
        self.logger.info(
            "Built %s MariaDB shard(s) with %s record(s) in %s.",
            totals.get("shards", len(self.shards)),
            totals.get("records", self.state.total_records),
            human_duration(time.monotonic() - self.started),
        )
        return EXIT_SUCCESS


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    defaults = None
    try:
        defaults = _common()
    except RuntimeError:
        defaults = {
            "DEFAULT_ROWS_PER_SHARD": 100_000,
            "DEFAULT_TARGET_FILE_BYTES": 64 * 1024 * 1024,
            "DEFAULT_MAX_FILE_BYTES": 100 * 1024 * 1024,
        }

    parser = argparse.ArgumentParser(
        description="Build deterministic Speciedex MariaDB logical shards.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )

    parser.add_argument(
        "--taxonomy-root",
        type=Path,
        default=Path("static/data/taxonomy"),
        help="Root directory containing canonical taxonomy records.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("static/data/db/mariadb"),
        help="Destination directory for generated MariaDB shards.",
    )
    parser.add_argument(
        "--rows-per-shard",
        type=int,
        default=defaults["DEFAULT_ROWS_PER_SHARD"],
        help="Maximum logical records per shard.",
    )
    parser.add_argument(
        "--target-bytes",
        type=int,
        default=defaults["DEFAULT_TARGET_FILE_BYTES"],
        help="Approximate target uncompressed shard size.",
    )
    parser.add_argument(
        "--max-bytes",
        type=int,
        default=defaults["DEFAULT_MAX_FILE_BYTES"],
        help="Maximum allowed compressed shard file size.",
    )
    parser.add_argument(
        "--minimum-free-bytes",
        type=int,
        default=256 * 1024 * 1024,
        help="Minimum required free disk space beneath the output directory.",
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
        help="Path to the build summary JSON.",
    )
    parser.add_argument(
        "--clean",
        action="store_true",
        help="Remove existing generated shard outputs before building.",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Skip completed shard identifiers recorded in build state.",
    )
    parser.add_argument(
        "--verify",
        action="store_true",
        help="Verify generated manifest, gzip streams, counts, and file sizes.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Read and chunk records without writing shard files.",
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

    if args.progress_every < 0:
        parser.error("--progress-every cannot be negative.")

    if args.verbose and args.quiet:
        parser.error("--verbose and --quiet cannot be used together.")

    if args.clean and args.resume:
        parser.error("--clean and --resume cannot be used together.")

    return args


def main(argv: Sequence[str] | None = None) -> int:
    return MariaDBShardBuilder(parse_args(argv)).run()


if __name__ == "__main__":
    raise SystemExit(main())
