#!/usr/bin/env python3
"""
Build deterministic Speciedex SQLite database shards.

Expected location:
    static/tools/database/build-sqlite-shards.py

This tool converts canonical Speciedex taxonomy records into SQLite shards
suitable for terminal search, statistics, offline browsing, analysis, and
downstream website data generation.

It preserves compatibility with static/tools/database/common.py while adding:

    * strict input and environment validation
    * deterministic cleanup and shard naming
    * resumable builds with persistent state
    * dry-run and verification modes
    * SQLite integrity checks and optional ANALYZE/VACUUM
    * shard-level checksums and build summaries
    * progress reporting and explicit exit codes
    * disk-space and maximum-file-size safeguards

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import shutil
import sqlite3
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


EXIT_SUCCESS = 0
EXIT_VALIDATION = 1
EXIT_BUILD = 2
EXIT_VERIFICATION = 3
EXIT_INTERRUPTED = 130

STATE_FILENAME = "build-state.json"
SUMMARY_FILENAME = "build-summary.json"
MANIFEST_FILENAME = "manifest.json"
SHARD_PATTERN = "speciedex-*.sqlite3"


def utc_now() -> str:
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


def load_common() -> dict[str, Any]:
    """
    Import shared database helpers lazily.

    Lazy loading keeps `--help` functional even when this script is inspected
    outside the repository, while normal execution still requires common.py.
    """
    try:
        from common import (
            DEFAULT_MAX_FILE_BYTES,
            DEFAULT_ROWS_PER_SHARD,
            DEFAULT_TARGET_FILE_BYTES,
            build_sqlite_shard,
            check_max_file_size,
            chunk_records,
            iter_canonical_records,
            remove_generated_files,
            write_manifest,
        )
    except ModuleNotFoundError as error:
        raise RuntimeError(
            "Unable to import static/tools/database/common.py. "
            "Keep this file beside common.py and run it from the Speciedex "
            "repository."
        ) from error

    return {
        "DEFAULT_MAX_FILE_BYTES": DEFAULT_MAX_FILE_BYTES,
        "DEFAULT_ROWS_PER_SHARD": DEFAULT_ROWS_PER_SHARD,
        "DEFAULT_TARGET_FILE_BYTES": DEFAULT_TARGET_FILE_BYTES,
        "build_sqlite_shard": build_sqlite_shard,
        "check_max_file_size": check_max_file_size,
        "chunk_records": chunk_records,
        "iter_canonical_records": iter_canonical_records,
        "remove_generated_files": remove_generated_files,
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
            64 * 1024 * 1024,
            100 * 1024 * 1024,
        )


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


class SQLiteShardBuildError(RuntimeError):
    def __init__(self, message: str, exit_code: int = EXIT_BUILD) -> None:
        super().__init__(message)
        self.exit_code = exit_code


class SQLiteShardBuilder:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.taxonomy_root = args.taxonomy_root.resolve()
        self.output = args.output.resolve()
        self.state_path = (args.state_file or self.output / STATE_FILENAME).resolve()
        self.summary_path = (
            args.summary_file or self.output / SUMMARY_FILENAME
        ).resolve()
        self.started = time.monotonic()
        self.logger = logging.getLogger("speciedex.database.sqlite_shards")
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
        try:
            load_common()
        except RuntimeError as error:
            raise SQLiteShardBuildError(str(error), EXIT_VALIDATION) from error

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

        self.output.mkdir(parents=True, exist_ok=True)

        probe = self.output / ".speciedex-write-test"
        try:
            probe.write_text("ok\n", encoding="utf-8")
            probe.unlink()
        except OSError as error:
            raise SQLiteShardBuildError(
                f"Output directory is not writable: {self.output}: {error}",
                EXIT_VALIDATION,
            ) from error

        usage = shutil.disk_usage(self.output)
        if usage.free < self.args.minimum_free_bytes:
            raise SQLiteShardBuildError(
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
            self.logger.warning("Unable to read previous build state: %s", error)
            return None

        if not isinstance(payload, dict):
            return None

        try:
            return BuildState(**payload)
        except TypeError:
            self.logger.warning("Ignoring incompatible previous build state.")
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
            self.logger.info("Dry run: would remove existing generated outputs.")
            return

        common = load_common()
        common["remove_generated_files"](
            self.output,
            (
                SHARD_PATTERN,
                MANIFEST_FILENAME,
                SUMMARY_FILENAME,
            ),
        )

    def completed_shard_ids(self) -> set[str]:
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

    def sqlite_integrity_check(self, path: Path) -> str:
        try:
            connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
            try:
                row = connection.execute("PRAGMA integrity_check").fetchone()
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

    def build_shards(self) -> None:
        common = load_common()
        completed_ids = self.completed_shard_ids()

        chunks = common["chunk_records"](
            common["iter_canonical_records"](self.taxonomy_root),
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
                    "shard_id": shard_id,
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
                # common.build_sqlite_shard() already performs an atomic write.
                # Pass the final destination so returned manifest metadata never
                # records an obsolete outer ".tmp" filename.
                metadata = common["build_sqlite_shard"](
                    records,
                    destination,
                    shard_id=shard_id,
                )

                analyzed, vacuumed = self.optimize_sqlite(destination)
                integrity = (
                    self.sqlite_integrity_check(destination)
                    if self.args.verify_each
                    else "not-checked"
                )

                record_count = int(
                    metadata.get("records", metadata.get("rows", len(records)))
                )

            elapsed = time.monotonic() - started
            size = 0 if self.args.dry_run else destination.stat().st_size
            digest = "" if self.args.dry_run else sha256_file(destination)

            if size > self.args.max_bytes:
                destination.unlink(missing_ok=True)
                raise SQLiteShardBuildError(
                    (
                        f"Shard {filename} exceeds maximum size: "
                        f"{size} > {self.args.max_bytes} bytes."
                    ),
                    EXIT_BUILD,
                )

            normalized = dict(metadata)

            # The wrapper owns final shard naming. Overwrite rather than using
            # setdefault() so stale helper metadata can never preserve a
            # temporary or absolute path after atomic publication.
            normalized["id"] = shard_id
            normalized["shard_id"] = shard_id
            normalized["path"] = filename
            normalized["filename"] = filename
            normalized["records"] = record_count
            normalized["bytes"] = size
            normalized["sha256"] = digest
            self.shards.append(normalized)

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

    def write_manifest(self) -> dict[str, Any]:
        common = load_common()

        if self.args.dry_run:
            manifest = {
                "schema_version": 1,
                "kind": "sqlite",
                "source": self.taxonomy_root.as_posix(),
                "totals": {
                    "shards": len(self.shards),
                    "records": sum(
                        int(item.get("records", 0)) for item in self.shards
                    ),
                },
                "shards": self.shards,
                "options": {
                    "rows_per_shard": self.args.rows_per_shard,
                    "target_bytes": self.args.target_bytes,
                    "max_bytes": self.args.max_bytes,
                    "analyze": self.args.analyze,
                    "vacuum": self.args.vacuum,
                },
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
            source=self.taxonomy_root.as_posix(),
            extra={
                "rows_per_shard": self.args.rows_per_shard,
                "target_bytes": self.args.target_bytes,
                "max_bytes": self.args.max_bytes,
                "analyze": self.args.analyze,
                "vacuum": self.args.vacuum,
            },
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
            json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            raise SQLiteShardBuildError(
                f"Generated manifest contains invalid JSON: {error}",
                EXIT_VERIFICATION,
            ) from error

        shard_paths = sorted(self.output.glob(SHARD_PATTERN))
        expected_shards = int(
            manifest.get("totals", {}).get("shards", len(self.shards))
        )

        if len(shard_paths) != expected_shards:
            raise SQLiteShardBuildError(
                (
                    "Shard count mismatch: "
                    f"manifest={expected_shards}, files={len(shard_paths)}"
                ),
                EXIT_VERIFICATION,
            )

        for path in shard_paths:
            self.sqlite_integrity_check(path)
            if path.stat().st_size > self.args.max_bytes:
                raise SQLiteShardBuildError(
                    f"Shard exceeds maximum size: {path}",
                    EXIT_VERIFICATION,
                )

        built_records = sum(
            int(shard.get("records", 0)) for shard in self.shards
        )
        manifest_records = int(
            manifest.get("totals", {}).get("records", built_records)
        )

        if manifest_records != built_records:
            raise SQLiteShardBuildError(
                (
                    "Record count mismatch: "
                    f"manifest={manifest_records}, built={built_records}"
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
                "verify_each": self.args.verify_each,
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
            self.logger.error("SQLite shard build failed: %s", error)
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


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    default_rows, default_target, default_max = default_values()

    parser = argparse.ArgumentParser(
        description="Build deterministic Speciedex SQLite shards.",
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
        help="Skip completed shards recorded in the build-state file.",
    )
    parser.add_argument(
        "--verify",
        action="store_true",
        help="Verify generated manifest, shard counts, sizes, and integrity.",
    )
    parser.add_argument(
        "--verify-each",
        action="store_true",
        help="Run PRAGMA integrity_check immediately after each shard build.",
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
