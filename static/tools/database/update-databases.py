#!/usr/bin/env python3
"""
Atomically update all Speciedex database products.

Expected location:
    static/tools/database/update-databases.py

This orchestrator rebuilds, verifies, stages, and publishes the complete
Speciedex database product set derived from static/data/taxonomy/. It manages:

    * SQLite shards
    * MariaDB logical shards
    * browser/search indexes
    * shard verification
    * SQLite/MariaDB parity verification
    * component and release manifests
    * compressed additions/change streams
    * deletion streams
    * persistent state, summaries, logs, and recovery

The default publication strategy is staged and transactional: products are
built under a temporary sibling directory and only replace the live database
root after every required build and verification step succeeds.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from common import (
    atomic_write_json,
    clean_text,
    iter_canonical_records,
    sha256_file,
    stable_json,
    utc_now,
    write_jsonl,
)


EXIT_SUCCESS = 0
EXIT_VALIDATION = 1
EXIT_BUILD = 2
EXIT_VERIFICATION = 3
EXIT_PUBLICATION = 4
EXIT_INTERRUPTED = 130

DEFAULT_TAXONOMY_ROOT = Path("static/data/taxonomy")
DEFAULT_DB_ROOT = Path("static/data/db")
STATE_FILENAME = "update-state.json"
SUMMARY_FILENAME = "update-summary.json"
LOG_FILENAME = "update.log"

PIPELINE = (
    ("sqlite", "build-sqlite-shards.py"),
    ("mariadb", "build-mariadb-shards.py"),
    ("indexes", "build-db-indexes.py"),
    ("verify-shards", "verify-shards.py"),
    ("verify-parity", "verify-database-parity.py"),
    ("manifests", "build-db-manifests.py"),
)


class UpdateError(RuntimeError):
    def __init__(self, message: str, exit_code: int = EXIT_BUILD) -> None:
        super().__init__(message)
        self.exit_code = exit_code


@dataclass
class StepResult:
    name: str
    script: str
    command: list[str]
    started_at: str
    finished_at: str
    duration_seconds: float
    return_code: int
    stdout_log: str
    stderr_log: str
    status: str


@dataclass
class UpdateState:
    schema_version: int = 2
    status: str = "pending"
    started_at: str = ""
    finished_at: str = ""
    taxonomy_root: str = ""
    db_root: str = ""
    staging_root: str = ""
    backup_root: str = ""
    current_step: str = ""
    completed_steps: list[str] = field(default_factory=list)
    published: bool = False
    rolled_back: bool = False
    last_error: str = ""


def human_duration(seconds: float) -> str:
    seconds = max(0, int(round(seconds)))
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def safe_stamp() -> str:
    return utc_now().replace(":", "").replace("-", "").replace("Z", "Z")


def compact_record(record: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "id": clean_text(record.get("speciedex_id")),
        "scientific_name": clean_text(record.get("scientific_name")),
        "common_name": clean_text(record.get("common_name")),
        "rank": clean_text(record.get("rank")),
        "provider": clean_text(record.get("provider")),
        "indexed_at": clean_text(record.get("indexed_at")),
        "record_hash": clean_text(record.get("record_hash")),
    }


def load_previous_index(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}

    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}

    hashes: dict[str, str] = {}

    if isinstance(value, Mapping):
        for identifier, record in value.items():
            if isinstance(record, Mapping):
                hashes[clean_text(identifier)] = stable_json(record)
        return hashes

    if isinstance(value, list):
        for record in value:
            if not isinstance(record, Mapping):
                continue
            identifier = clean_text(
                record.get("id") or record.get("speciedex_id")
            )
            if identifier:
                hashes[identifier] = stable_json(record)

    return hashes


class DatabaseUpdater:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.here = Path(__file__).resolve().parent
        self.taxonomy_root = args.taxonomy_root.resolve()
        self.db_root = args.db_root.resolve()
        self.parent = self.db_root.parent
        self.staging_root = (
            args.staging_root.resolve()
            if args.staging_root
            else self.parent / f".{self.db_root.name}.staging"
        )
        self.backup_root = (
            args.backup_root.resolve()
            if args.backup_root
            else self.parent / f".{self.db_root.name}.backup"
        )
        self.state_path = (
            args.state_file.resolve()
            if args.state_file
            else self.parent / f".{self.db_root.name}-{STATE_FILENAME}"
        )
        self.summary_path = (
            args.summary_file.resolve()
            if args.summary_file
            else self.parent / f".{self.db_root.name}-{SUMMARY_FILENAME}"
        )
        self.logs_root = (
            args.logs_root.resolve()
            if args.logs_root
            else self.parent / f".{self.db_root.name}-logs"
        )
        self.logger = logging.getLogger("speciedex.database.update")
        self.started = time.monotonic()
        self.steps: list[StepResult] = []
        self.previous_hashes: dict[str, str] = {}
        self.state = UpdateState(
            status="pending",
            started_at=utc_now(),
            taxonomy_root=str(self.taxonomy_root),
            db_root=str(self.db_root),
            staging_root=str(self.staging_root),
            backup_root=str(self.backup_root),
        )
        self.update_manifest: dict[str, Any] = {}

    def configure_logging(self) -> None:
        level = logging.DEBUG if self.args.verbose else logging.INFO
        if self.args.quiet:
            level = logging.WARNING

        self.logs_root.mkdir(parents=True, exist_ok=True)
        handlers: list[logging.Handler] = [logging.StreamHandler()]
        if not self.args.dry_run:
            handlers.append(
                logging.FileHandler(
                    self.logs_root / LOG_FILENAME,
                    encoding="utf-8",
                )
            )

        logging.basicConfig(
            level=level,
            format="%(asctime)s %(levelname)s %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
            handlers=handlers,
            force=True,
        )

    def save_state(self) -> None:
        if self.args.dry_run:
            return
        atomic_write_json(self.state_path, asdict(self.state))

    def validate(self) -> None:
        if not self.taxonomy_root.exists():
            raise UpdateError(
                f"Taxonomy root does not exist: {self.taxonomy_root}",
                EXIT_VALIDATION,
            )
        if not self.taxonomy_root.is_dir():
            raise UpdateError(
                f"Taxonomy root is not a directory: {self.taxonomy_root}",
                EXIT_VALIDATION,
            )

        required = [self.here / script for _, script in PIPELINE]
        missing = [path for path in required if not path.is_file()]
        if missing:
            raise UpdateError(
                "Required database script(s) missing: "
                + ", ".join(str(path) for path in missing),
                EXIT_VALIDATION,
            )

        self.parent.mkdir(parents=True, exist_ok=True)
        usage = shutil.disk_usage(self.parent)
        if usage.free < self.args.minimum_free_bytes:
            raise UpdateError(
                f"Insufficient free space under {self.parent}: "
                f"{usage.free} available, "
                f"{self.args.minimum_free_bytes} required.",
                EXIT_VALIDATION,
            )

        if self.staging_root == self.db_root:
            raise UpdateError(
                "Staging root cannot equal the live database root.",
                EXIT_VALIDATION,
            )
        if self.backup_root == self.db_root:
            raise UpdateError(
                "Backup root cannot equal the live database root.",
                EXIT_VALIDATION,
            )

    def prepare_staging(self) -> None:
        self.previous_hashes = load_previous_index(
            self.db_root / "indexes" / "species.json"
        )

        if self.args.in_place:
            self.staging_root = self.db_root
            self.state.staging_root = str(self.staging_root)
            return

        if self.args.dry_run:
            self.logger.info(
                "Dry run: would prepare staging root %s",
                self.staging_root,
            )
            return

        if self.staging_root.exists():
            if self.args.resume:
                self.logger.info(
                    "Reusing staging root in resume mode: %s",
                    self.staging_root,
                )
            else:
                shutil.rmtree(self.staging_root)

        self.staging_root.mkdir(parents=True, exist_ok=True)

        if self.args.copy_existing and self.db_root.exists():
            shutil.copytree(
                self.db_root,
                self.staging_root,
                dirs_exist_ok=True,
            )

    def step_command(self, name: str, script: Path) -> list[str]:
        command = [sys.executable, str(script)]

        if name == "sqlite":
            command += [
                "--taxonomy-root", str(self.taxonomy_root),
                "--output", str(self.staging_root / "sqlite"),
                "--clean",
                "--verify",
            ]
        elif name == "mariadb":
            command += [
                "--taxonomy-root", str(self.taxonomy_root),
                "--output", str(self.staging_root / "mariadb"),
            ]
            if self.args.clean:
                command.append("--clean")
            if self.args.verify:
                command.append("--verify")
        elif name == "indexes":
            command += [
                "--taxonomy-root", str(self.taxonomy_root),
                "--output", str(self.staging_root / "indexes"),
            ]
            if self.args.clean:
                command.append("--clean")
            if self.args.verify:
                command.append("--verify")
        elif name == "verify-shards":
            command += [
                "--db-root", str(self.staging_root),
                "--report", str(
                    self.staging_root / "reports" / "shards.json"
                ),
                "--max-bytes", str(self.args.max_bytes),
            ]
        elif name == "verify-parity":
            command += [
                "--db-root", str(self.staging_root),
                "--report", str(
                    self.staging_root / "reports" / "parity.json"
                ),
            ]
            if self.args.deep_parity:
                command.append("--deep")
        elif name == "manifests":
            command += [
                "--db-root", str(self.staging_root),
            ]
            if self.args.verify:
                command.append("--verify")

        if self.args.verbose and name not in {
            "verify-shards",
            "verify-parity",
        }:
            command.append("--verbose")

        return command

    def completed_steps(self) -> set[str]:
        if not self.args.resume or not self.state_path.is_file():
            return set()

        try:
            value = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return set()

        completed = value.get("completed_steps", [])
        if not isinstance(completed, list):
            return set()
        return {clean_text(item) for item in completed}

    def run_step(self, name: str, script_name: str) -> None:
        completed = self.completed_steps()
        if name in completed:
            self.logger.info("Skipping completed step: %s", name)
            if name not in self.state.completed_steps:
                self.state.completed_steps.append(name)
            return

        script = self.here / script_name
        command = self.step_command(name, script)
        self.state.current_step = name
        self.state.status = "running"
        self.save_state()

        self.logger.info("Running step: %s", name)
        self.logger.debug("Command: %s", " ".join(command))

        started_at = utc_now()
        started = time.monotonic()
        stdout_path = self.logs_root / f"{name}.stdout.log"
        stderr_path = self.logs_root / f"{name}.stderr.log"

        if self.args.dry_run:
            result = StepResult(
                name=name,
                script=script_name,
                command=command,
                started_at=started_at,
                finished_at=utc_now(),
                duration_seconds=0.0,
                return_code=0,
                stdout_log=str(stdout_path),
                stderr_log=str(stderr_path),
                status="dry-run",
            )
            self.steps.append(result)
            self.state.completed_steps.append(name)
            return

        process = subprocess.run(
            command,
            cwd=self.here,
            text=True,
            capture_output=True,
            check=False,
        )

        stdout_path.write_text(process.stdout or "", encoding="utf-8")
        stderr_path.write_text(process.stderr or "", encoding="utf-8")

        result = StepResult(
            name=name,
            script=script_name,
            command=command,
            started_at=started_at,
            finished_at=utc_now(),
            duration_seconds=round(time.monotonic() - started, 6),
            return_code=process.returncode,
            stdout_log=str(stdout_path),
            stderr_log=str(stderr_path),
            status="success" if process.returncode == 0 else "failed",
        )
        self.steps.append(result)

        if process.returncode != 0:
            tail = (process.stderr or process.stdout or "").strip()[-4000:]
            raise UpdateError(
                f"Database update step '{name}' failed with exit code "
                f"{process.returncode}.\n{tail}",
                (
                    EXIT_VERIFICATION
                    if name.startswith("verify")
                    else EXIT_BUILD
                ),
            )

        self.state.completed_steps.append(name)
        self.save_state()

    def generate_updates(self) -> None:
        updates_root = self.staging_root / "updates"
        current_ids: set[str] = set()
        additions: list[dict[str, Any]] = []

        for record in iter_canonical_records(
            self.taxonomy_root,
            strict=self.args.strict_records,
            deduplicate=True,
        ):
            identifier = clean_text(record.get("speciedex_id"))
            if not identifier:
                continue

            current_ids.add(identifier)
            compact = compact_record(record)
            previous = self.previous_hashes.get(identifier)

            if previous != stable_json(compact):
                additions.append(record)

        additions.sort(
            key=lambda record: clean_text(record.get("speciedex_id"))
        )
        deletions = sorted(set(self.previous_hashes) - current_ids)
        stamp = safe_stamp()

        additions_name = f"additions-{stamp}.jsonl.gz"
        deletions_name = f"deletions-{stamp}.json"
        latest_additions = "latest-additions.jsonl.gz"
        latest_deletions = "latest-deletions.json"

        manifest = {
            "schema_version": 2,
            "generated_at": utc_now(),
            "source": self.taxonomy_root.as_posix(),
            "latest": {
                "additions": additions_name,
                "deletions": deletions_name,
                "latest_additions": latest_additions,
                "latest_deletions": latest_deletions,
            },
            "counts": {
                "current_records": len(current_ids),
                "additions_or_changes": len(additions),
                "deletions": len(deletions),
            },
            "files": {},
        }

        if self.args.dry_run:
            self.logger.info(
                "Dry run: would generate %d additions/changes and "
                "%d deletions.",
                len(additions),
                len(deletions),
            )
            self.update_manifest = manifest
            return

        updates_root.mkdir(parents=True, exist_ok=True)
        additions_path = updates_root / additions_name
        deletions_path = updates_root / deletions_name

        write_jsonl(additions_path, additions, gzip_output=True)
        atomic_write_json(deletions_path, deletions)

        shutil.copy2(additions_path, updates_root / latest_additions)
        shutil.copy2(deletions_path, updates_root / latest_deletions)

        manifest["files"] = {
            additions_name: {
                "bytes": additions_path.stat().st_size,
                "sha256": sha256_file(additions_path),
            },
            deletions_name: {
                "bytes": deletions_path.stat().st_size,
                "sha256": sha256_file(deletions_path),
            },
        }

        atomic_write_json(updates_root / "manifest.json", manifest)
        self.update_manifest = manifest

    def publish(self) -> None:
        if self.args.in_place:
            self.state.published = True
            return

        if self.args.dry_run:
            self.logger.info(
                "Dry run: would atomically publish %s to %s",
                self.staging_root,
                self.db_root,
            )
            return

        if not self.staging_root.is_dir():
            raise UpdateError(
                f"Staging root is missing: {self.staging_root}",
                EXIT_PUBLICATION,
            )

        if self.backup_root.exists():
            shutil.rmtree(self.backup_root)

        try:
            if self.db_root.exists():
                os.replace(self.db_root, self.backup_root)

            os.replace(self.staging_root, self.db_root)
            self.state.published = True

            if self.backup_root.exists() and not self.args.keep_backup:
                shutil.rmtree(self.backup_root)

        except Exception as error:
            self.logger.error("Publication failed; attempting rollback.")

            with contextlib.suppress(Exception):
                if self.db_root.exists() and not self.state.published:
                    shutil.rmtree(self.db_root)

            if self.backup_root.exists():
                os.replace(self.backup_root, self.db_root)
                self.state.rolled_back = True

            raise UpdateError(
                f"Unable to publish staged database products: {error}",
                EXIT_PUBLICATION,
            ) from error

    def write_summary(self, exit_code: int) -> None:
        if self.args.dry_run:
            return

        elapsed = time.monotonic() - self.started
        payload = {
            "schema_version": 2,
            "generated_at": utc_now(),
            "status": self.state.status,
            "exit_code": exit_code,
            "duration_seconds": round(elapsed, 6),
            "duration": human_duration(elapsed),
            "taxonomy_root": str(self.taxonomy_root),
            "db_root": str(self.db_root),
            "staging_root": str(self.staging_root),
            "backup_root": str(self.backup_root),
            "published": self.state.published,
            "rolled_back": self.state.rolled_back,
            "completed_steps": self.state.completed_steps,
            "steps": [asdict(step) for step in self.steps],
            "updates": self.update_manifest,
            "last_error": self.state.last_error,
        }
        atomic_write_json(self.summary_path, payload)

    def run(self) -> int:
        self.configure_logging()

        try:
            self.validate()
            self.prepare_staging()

            for name, script in PIPELINE:
                if name in self.args.skip_step:
                    self.logger.info("Skipping requested step: %s", name)
                    continue
                self.run_step(name, script)

            self.state.current_step = "updates"
            self.generate_updates()

            if self.args.publish:
                self.state.current_step = "publish"
                self.publish()

            self.state.status = "success"
            self.state.current_step = ""
            self.state.finished_at = utc_now()
            self.save_state()
            self.write_summary(EXIT_SUCCESS)

        except KeyboardInterrupt:
            self.state.status = "interrupted"
            self.state.finished_at = utc_now()
            self.state.last_error = "Update interrupted by user."
            self.save_state()
            self.write_summary(EXIT_INTERRUPTED)
            self.logger.error("Database update interrupted.")
            return EXIT_INTERRUPTED

        except UpdateError as error:
            self.state.status = "failed"
            self.state.finished_at = utc_now()
            self.state.last_error = str(error)
            self.save_state()
            self.write_summary(error.exit_code)
            self.logger.error("%s", error)
            return error.exit_code

        except Exception as error:
            self.state.status = "failed"
            self.state.finished_at = utc_now()
            self.state.last_error = f"{type(error).__name__}: {error}"
            self.save_state()
            self.write_summary(EXIT_BUILD)
            self.logger.error("Database update failed: %s", error)
            if self.args.verbose:
                self.logger.error(traceback.format_exc())
            return EXIT_BUILD

        self.logger.info(
            "Updated all Speciedex database products successfully in %s.",
            human_duration(time.monotonic() - self.started),
        )
        return EXIT_SUCCESS


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Build, verify, stage, and atomically publish all Speciedex "
            "database products."
        ),
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )

    parser.add_argument(
        "--taxonomy-root",
        type=Path,
        default=DEFAULT_TAXONOMY_ROOT,
        help="Canonical taxonomy source root.",
    )
    parser.add_argument(
        "--db-root",
        type=Path,
        default=DEFAULT_DB_ROOT,
        help="Live database product root.",
    )
    parser.add_argument(
        "--staging-root",
        type=Path,
        default=None,
        help="Explicit staging directory.",
    )
    parser.add_argument(
        "--backup-root",
        type=Path,
        default=None,
        help="Explicit backup directory used during publication.",
    )
    parser.add_argument(
        "--state-file",
        type=Path,
        default=None,
        help="Persistent update-state JSON path.",
    )
    parser.add_argument(
        "--summary-file",
        type=Path,
        default=None,
        help="Update-summary JSON path.",
    )
    parser.add_argument(
        "--logs-root",
        type=Path,
        default=None,
        help="Directory for orchestration and child-process logs.",
    )
    parser.add_argument(
        "--minimum-free-bytes",
        type=int,
        default=512 * 1024 * 1024,
        help="Minimum free disk space required before updating.",
    )
    parser.add_argument(
        "--max-bytes",
        type=int,
        default=90 * 1024 * 1024,
        help="Maximum permitted shard size during verification.",
    )
    parser.add_argument(
        "--clean",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Request clean output from component builders.",
    )
    parser.add_argument(
        "--verify",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Request component verification where supported.",
    )
    parser.add_argument(
        "--publish",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Publish staged products to the live database root.",
    )
    parser.add_argument(
        "--in-place",
        action="store_true",
        help="Build directly into the live database root without staging.",
    )
    parser.add_argument(
        "--copy-existing",
        action="store_true",
        help="Copy the current database root into staging before rebuilding.",
    )
    parser.add_argument(
        "--keep-backup",
        action="store_true",
        help="Retain the previous database root after successful publication.",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Resume using existing staging data and persistent state.",
    )
    parser.add_argument(
        "--deep-parity",
        action="store_true",
        help="Request record-level SQLite/MariaDB parity verification.",
    )
    parser.add_argument(
        "--strict-records",
        action="store_true",
        help="Fail update-stream generation on invalid canonical records.",
    )
    parser.add_argument(
        "--skip-step",
        action="append",
        choices=[name for name, _ in PIPELINE],
        default=[],
        help="Skip a named pipeline step. May be repeated.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show the pipeline without writing or publishing products.",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable verbose orchestration logging.",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress informational logging.",
    )

    args = parser.parse_args(argv)

    if args.minimum_free_bytes < 0:
        parser.error("--minimum-free-bytes cannot be negative.")

    if args.max_bytes < 1:
        parser.error("--max-bytes must be at least 1.")

    if args.verbose and args.quiet:
        parser.error("--verbose and --quiet cannot be used together.")

    if args.in_place and args.staging_root is not None:
        parser.error("--in-place cannot be combined with --staging-root.")

    if args.in_place and args.keep_backup:
        parser.error("--keep-backup is not meaningful with --in-place.")

    return args


def main(argv: Sequence[str] | None = None) -> int:
    return DatabaseUpdater(parse_args(argv)).run()


if __name__ == "__main__":
    raise SystemExit(main())
