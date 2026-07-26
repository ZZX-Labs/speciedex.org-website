#!/usr/bin/env python3
"""
Atomically update all Speciedex database products.

Expected location:
    static/tools/database/update-databases.py

This orchestrator rebuilds, verifies, stages, and publishes the complete
Speciedex database product set derived from static/data/taxonomy/.

Managed products:

    * SQLite shards
    * MariaDB logical shards
    * browser/search indexes
    * update streams
    * shard verification
    * SQLite/MariaDB/browser parity verification
    * component and release manifests
    * persistent state, summaries, logs, and rollback recovery

The default publication strategy is staged and transactional. Products are
built beneath a sibling staging directory and replace the live database root
only after every required build and verification stage succeeds.

The canonical taxonomy archive remains authoritative. SQLite, MariaDB, browser
indexes, manifests, checksums, and update streams are derived products.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
"""

from __future__ import annotations

import argparse
import contextlib
import gzip
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
from typing import Any, Mapping, Sequence

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

BUILD_PIPELINE = (
    ("sqlite", "build-sqlite-shards.py"),
    ("mariadb", "build-mariadb-shards.py"),
    ("indexes", "build-db-indexes.py"),
)

VERIFY_PIPELINE = (
    ("verify-shards", "verify-shards.py"),
    ("verify-parity", "verify-database-parity.py"),
)

FINALIZE_PIPELINE = (
    ("manifests", "build-db-manifests.py"),
)

ALL_STEPS = tuple(
    name
    for name, _ in (
        *BUILD_PIPELINE,
        ("updates", "<internal>"),
        *VERIFY_PIPELINE,
        *FINALIZE_PIPELINE,
        ("publish", "<internal>"),
    )
)


class UpdateError(RuntimeError):
    def __init__(
        self,
        message: str,
        exit_code: int = EXIT_BUILD,
    ) -> None:
        super().__init__(message)
        self.exit_code = exit_code


@dataclass
class StepResult:
    name: str
    script: str
    command: list[str] = field(default_factory=list)
    started_at: str = ""
    finished_at: str = ""
    duration_seconds: float = 0.0
    return_code: int = 0
    stdout_log: str = ""
    stderr_log: str = ""
    stdout_tail: list[str] = field(default_factory=list)
    stderr_tail: list[str] = field(default_factory=list)
    status: str = "pending"
    resumed: bool = False
    skipped: bool = False
    message: str = ""


@dataclass
class UpdateState:
    schema_version: int = 3
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
    return (
        utc_now()
        .replace(":", "")
        .replace("-", "")
        .replace(".", "")
        .replace("+00:00", "Z")
    )


def compact_record(record: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "id": clean_text(record.get("speciedex_id")),
        "scientific_name": clean_text(record.get("scientific_name")),
        "canonical_name": clean_text(record.get("canonical_name")),
        "common_name": clean_text(record.get("common_name")),
        "rank": clean_text(record.get("rank")),
        "status": clean_text(record.get("status")),
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


def load_json_object(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise UpdateError(
            f"Required JSON file not found: {path}",
            EXIT_VERIFICATION,
        ) from error
    except json.JSONDecodeError as error:
        raise UpdateError(
            f"Invalid JSON in {path}: {error}",
            EXIT_VERIFICATION,
        ) from error

    if not isinstance(value, dict):
        raise UpdateError(
            f"Expected JSON object in {path}.",
            EXIT_VERIFICATION,
        )

    return value


def manifest_records(path: Path) -> int:
    manifest = load_json_object(path)
    totals = manifest.get("totals")

    candidates: list[Any] = [
        manifest.get("records"),
        manifest.get("record_count"),
    ]
    if isinstance(totals, Mapping):
        candidates.extend(
            [
                totals.get("records"),
                totals.get("taxa"),
                totals.get("species"),
            ]
        )

    for value in candidates:
        if isinstance(value, bool) or value in (None, ""):
            continue
        try:
            number = int(value)
        except (TypeError, ValueError):
            continue
        if number >= 0:
            return number

    raise UpdateError(
        f"Manifest does not declare a valid record total: {path}",
        EXIT_VERIFICATION,
    )


class DatabaseUpdater:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.here = Path(__file__).resolve().parent
        self.repo_root = self.here.parent.parent.parent.resolve()

        self.taxonomy_root = args.taxonomy_root.resolve()
        self.archive_manifest = (
            args.archive_manifest.resolve()
            if args.archive_manifest
            else None
        )
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
        self.previous_state: UpdateState | None = None

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

        handlers: list[logging.Handler] = [
            logging.StreamHandler(sys.stdout)
        ]
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
        if not self.args.dry_run:
            atomic_write_json(self.state_path, asdict(self.state))

    def load_previous_state(self) -> UpdateState | None:
        if not self.args.resume or not self.state_path.is_file():
            return None

        try:
            value = json.loads(
                self.state_path.read_text(encoding="utf-8")
            )
        except (OSError, json.JSONDecodeError) as error:
            raise UpdateError(
                f"Unable to read resume state {self.state_path}: {error}",
                EXIT_VALIDATION,
            ) from error

        if not isinstance(value, Mapping):
            raise UpdateError(
                f"Resume state is not a JSON object: {self.state_path}",
                EXIT_VALIDATION,
            )

        allowed = set(UpdateState.__dataclass_fields__)
        compatible = {
            key: value
            for key, value in value.items()
            if key in allowed
        }

        try:
            state = UpdateState(**compatible)
        except TypeError as error:
            raise UpdateError(
                f"Incompatible resume state: {error}",
                EXIT_VALIDATION,
            ) from error

        if Path(state.taxonomy_root).resolve() != self.taxonomy_root:
            raise UpdateError(
                "Resume state taxonomy root does not match this update.",
                EXIT_VALIDATION,
            )

        if Path(state.db_root).resolve() != self.db_root:
            raise UpdateError(
                "Resume state database root does not match this update.",
                EXIT_VALIDATION,
            )

        if Path(state.staging_root).resolve() != self.staging_root:
            raise UpdateError(
                "Resume state staging root does not match this update.",
                EXIT_VALIDATION,
            )

        return state

    def validate(self) -> None:
        if sys.version_info < (3, 10):
            raise UpdateError(
                "Python 3.10 or newer is required.",
                EXIT_VALIDATION,
            )

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

        required_steps = [
            pair
            for pair in (
                *BUILD_PIPELINE,
                *VERIFY_PIPELINE,
                *FINALIZE_PIPELINE,
            )
            if pair[0] not in self.args.skip_step
        ]
        missing = [
            self.here / script
            for _, script in required_steps
            if not (self.here / script).is_file()
        ]
        if missing:
            raise UpdateError(
                "Required database script(s) missing: "
                + ", ".join(str(path) for path in missing),
                EXIT_VALIDATION,
            )

        self.parent.mkdir(parents=True, exist_ok=True)
        self.logs_root.mkdir(parents=True, exist_ok=True)
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.summary_path.parent.mkdir(parents=True, exist_ok=True)

        for directory in {
            self.parent,
            self.logs_root,
            self.state_path.parent,
            self.summary_path.parent,
        }:
            probe: Path | None = None
            try:
                with tempfile.NamedTemporaryFile(
                    "w",
                    encoding="utf-8",
                    delete=False,
                    dir=directory,
                    prefix=".speciedex-update-write-test.",
                ) as handle:
                    handle.write("ok\n")
                    probe = Path(handle.name)
            except OSError as error:
                raise UpdateError(
                    f"Directory is not writable: {directory}: {error}",
                    EXIT_VALIDATION,
                ) from error
            finally:
                if probe is not None:
                    probe.unlink(missing_ok=True)

        usage = shutil.disk_usage(self.parent)
        if usage.free < self.args.minimum_free_bytes:
            raise UpdateError(
                f"Insufficient free space under {self.parent}: "
                f"{usage.free} available, "
                f"{self.args.minimum_free_bytes} required.",
                EXIT_VALIDATION,
            )

        roots = {
            self.db_root,
            self.staging_root,
            self.backup_root,
        }
        if len(roots) != 3 and not self.args.in_place:
            raise UpdateError(
                "Live, staging, and backup roots must be distinct.",
                EXIT_VALIDATION,
            )

        if self.args.in_place and self.args.publish:
            self.logger.warning(
                "--in-place already writes live data; publication is implicit."
            )

        self.previous_state = self.load_previous_state()

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

    def common_builder_args(self) -> list[str]:
        arguments = [
            "--taxonomy-root",
            str(self.taxonomy_root),
            "--source-mode",
            self.args.source_mode,
            "--rows-per-shard",
            str(self.args.rows_per_shard),
            "--target-bytes",
            str(self.args.target_bytes),
            "--max-bytes",
            str(self.args.max_bytes),
            "--minimum-free-bytes",
            str(self.args.minimum_free_bytes),
        ]

        if self.archive_manifest is not None:
            arguments.extend(
                ["--archive-manifest", str(self.archive_manifest)]
            )

        if self.args.expect_records is not None:
            arguments.extend(
                ["--expect-records", str(self.args.expect_records)]
            )

        if self.args.clean:
            arguments.append("--clean")

        if self.args.resume:
            arguments.append("--resume")

        if self.args.strict_records:
            arguments.append("--strict")

        if self.args.deduplicate:
            arguments.append("--deduplicate")

        if self.args.verify:
            arguments.append("--verify")

        if self.args.verify_each:
            arguments.append("--verify-each")

        if self.args.verbose:
            arguments.append("--verbose")

        if self.args.quiet:
            arguments.append("--quiet")

        return arguments

    def step_command(self, name: str, script: Path) -> list[str]:
        command = [sys.executable, str(script)]

        if name == "sqlite":
            command.extend(
                [
                    "--output",
                    str(self.staging_root / "sqlite"),
                    *self.common_builder_args(),
                ]
            )
            command.extend(self.args.sqlite_arg)

        elif name == "mariadb":
            command.extend(
                [
                    "--output",
                    str(self.staging_root / "mariadb"),
                    "--insert-batch-size",
                    str(self.args.insert_batch_size),
                    *self.common_builder_args(),
                ]
            )
            command.extend(self.args.mariadb_arg)

        elif name == "indexes":
            command.extend(
                [
                    "--taxonomy-root",
                    str(self.taxonomy_root),
                    "--source-mode",
                    self.args.source_mode,
                    "--output",
                    str(self.staging_root / "indexes"),
                    "--shard-size",
                    str(self.args.index_shard_size),
                    "--minimum-free-bytes",
                    str(self.args.minimum_free_bytes),
                ]
            )

            if self.archive_manifest is not None:
                command.extend(
                    ["--archive-manifest", str(self.archive_manifest)]
                )
            if self.args.expect_records is not None:
                command.extend(
                    ["--expect-records", str(self.args.expect_records)]
                )
            if self.args.clean:
                command.append("--clean")
            if self.args.verify:
                command.append("--verify")
            else:
                command.append("--no-verify")
            if self.args.shard_indexes:
                command.append("--shard")
            if self.args.include_canonical_name:
                command.append("--include-canonical-name")
            if self.args.include_taxonomy:
                command.append("--include-taxonomy")
            if self.args.strict_records:
                command.append("--strict")
            if self.args.verbose:
                command.append("--verbose")
            if self.args.quiet:
                command.append("--quiet")
            command.extend(self.args.index_arg)

        elif name == "verify-shards":
            command.extend(
                [
                    "--db-root",
                    str(self.staging_root),
                    "--report",
                    str(self.staging_root / "reports" / "shards.json"),
                    "--max-bytes",
                    str(self.args.max_bytes),
                ]
            )
            command.extend(self.args.verify_shards_arg)

        elif name == "verify-parity":
            command.extend(
                [
                    "--db-root",
                    str(self.staging_root),
                    "--report",
                    str(self.staging_root / "reports" / "parity.json"),
                ]
            )
            if self.args.deep_parity:
                command.append("--deep")
            command.extend(self.args.verify_parity_arg)

        elif name == "manifests":
            command.extend(
                [
                    "--db-root",
                    str(self.staging_root),
                ]
            )
            if self.args.verify:
                command.append("--verify")
            if self.args.strict_parity:
                command.append("--strict-parity")
            if self.args.require_index_parity:
                command.append("--require-index-parity")
            if self.args.verbose:
                command.append("--verbose")
            if self.args.quiet:
                command.append("--quiet")
            command.extend(self.args.manifest_arg)

        return command

    def is_step_complete(self, name: str) -> bool:
        return bool(
            self.args.resume
            and self.previous_state is not None
            and name in self.previous_state.completed_steps
        )

    def record_internal_step(
        self,
        name: str,
        *,
        started_at: str,
        started: float,
        status: str,
        message: str,
    ) -> None:
        self.steps.append(
            StepResult(
                name=name,
                script="<internal>",
                started_at=started_at,
                finished_at=utc_now(),
                duration_seconds=round(
                    time.monotonic() - started,
                    6,
                ),
                return_code=0 if status == "success" else 1,
                status=status,
                message=message,
            )
        )

    def run_step(self, name: str, script_name: str) -> None:
        if self.is_step_complete(name):
            self.logger.info("Skipping completed step: %s", name)
            self.steps.append(
                StepResult(
                    name=name,
                    script=script_name,
                    status="resumed",
                    resumed=True,
                    skipped=True,
                    message="Completed in previous update state.",
                )
            )
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
            self.steps.append(
                StepResult(
                    name=name,
                    script=script_name,
                    command=command,
                    started_at=started_at,
                    finished_at=utc_now(),
                    return_code=0,
                    stdout_log=str(stdout_path),
                    stderr_log=str(stderr_path),
                    status="dry-run",
                    skipped=True,
                    message="Dry run; command not executed.",
                )
            )
            self.state.completed_steps.append(name)
            return

        try:
            process = subprocess.run(
                command,
                cwd=self.repo_root,
                text=True,
                capture_output=True,
                check=False,
                timeout=self.args.step_timeout,
                env=os.environ.copy(),
            )
        except subprocess.TimeoutExpired as error:
            stdout = clean_text(error.stdout)
            stderr = clean_text(error.stderr)
            stdout_path.write_text(stdout, encoding="utf-8")
            stderr_path.write_text(stderr, encoding="utf-8")

            self.steps.append(
                StepResult(
                    name=name,
                    script=script_name,
                    command=command,
                    started_at=started_at,
                    finished_at=utc_now(),
                    duration_seconds=round(
                        time.monotonic() - started,
                        6,
                    ),
                    return_code=-1,
                    stdout_log=str(stdout_path),
                    stderr_log=str(stderr_path),
                    stdout_tail=stdout.splitlines()[
                        -self.args.capture_lines :
                    ],
                    stderr_tail=stderr.splitlines()[
                        -self.args.capture_lines :
                    ],
                    status="failed",
                    message=(
                        f"Step exceeded timeout of "
                        f"{self.args.step_timeout} seconds."
                    ),
                )
            )
            raise UpdateError(
                f"Database update step '{name}' timed out.",
                EXIT_VERIFICATION
                if name.startswith("verify")
                else EXIT_BUILD,
            ) from error

        stdout = process.stdout or ""
        stderr = process.stderr or ""
        stdout_path.write_text(stdout, encoding="utf-8")
        stderr_path.write_text(stderr, encoding="utf-8")

        result = StepResult(
            name=name,
            script=script_name,
            command=command,
            started_at=started_at,
            finished_at=utc_now(),
            duration_seconds=round(
                time.monotonic() - started,
                6,
            ),
            return_code=int(process.returncode),
            stdout_log=str(stdout_path),
            stderr_log=str(stderr_path),
            stdout_tail=stdout.splitlines()[
                -self.args.capture_lines :
            ],
            stderr_tail=stderr.splitlines()[
                -self.args.capture_lines :
            ],
            status=(
                "success"
                if process.returncode == 0
                else "failed"
            ),
        )
        self.steps.append(result)

        if process.returncode != 0:
            tail_lines = result.stderr_tail or result.stdout_tail
            tail = "\n".join(tail_lines)
            raise UpdateError(
                f"Database update step '{name}' failed with exit code "
                f"{process.returncode}."
                + (f"\n{tail}" if tail else ""),
                EXIT_VERIFICATION
                if name.startswith("verify")
                else EXIT_BUILD,
            )

        result.message = (
            f"Completed in {human_duration(result.duration_seconds)}."
        )
        self.state.completed_steps.append(name)
        self.save_state()

    def generate_updates(self) -> None:
        name = "updates"

        if self.is_step_complete(name):
            self.logger.info("Skipping completed step: %s", name)
            if name not in self.state.completed_steps:
                self.state.completed_steps.append(name)
            self.steps.append(
                StepResult(
                    name=name,
                    script="<internal>",
                    status="resumed",
                    resumed=True,
                    skipped=True,
                    message="Completed in previous update state.",
                )
            )
            manifest_path = self.staging_root / "updates" / "manifest.json"
            if manifest_path.is_file():
                self.update_manifest = load_json_object(manifest_path)
            return

        self.state.current_step = name
        self.state.status = "running"
        self.save_state()

        started_at = utc_now()
        started = time.monotonic()

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
            key=lambda record: clean_text(
                record.get("speciedex_id")
            )
        )
        deletions = sorted(set(self.previous_hashes) - current_ids)
        stamp = safe_stamp()

        additions_name = f"additions-{stamp}.jsonl.gz"
        deletions_name = f"deletions-{stamp}.json"
        latest_additions = "latest-additions.jsonl.gz"
        latest_deletions = "latest-deletions.json"

        manifest = {
            "schema_version": 3,
            "kind": "database-updates",
            "generated_at": utc_now(),
            "source": self.taxonomy_root.as_posix(),
            "latest": {
                "additions": additions_name,
                "deletions": deletions_name,
                "latest_additions": latest_additions,
                "latest_deletions": latest_deletions,
            },
            "totals": {
                "records": len(current_ids),
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
            self.record_internal_step(
                name,
                started_at=started_at,
                started=started,
                status="success",
                message="Dry run; update streams not written.",
            )
            self.state.completed_steps.append(name)
            return

        updates_root.mkdir(parents=True, exist_ok=True)
        additions_path = updates_root / additions_name
        deletions_path = updates_root / deletions_name
        latest_additions_path = updates_root / latest_additions
        latest_deletions_path = updates_root / latest_deletions

        write_jsonl(
            additions_path,
            additions,
            gzip_output=True,
        )
        atomic_write_json(deletions_path, deletions)

        shutil.copy2(additions_path, latest_additions_path)
        shutil.copy2(deletions_path, latest_deletions_path)

        manifest["files"] = {
            additions_name: {
                "bytes": additions_path.stat().st_size,
                "sha256": sha256_file(additions_path),
                "records": len(additions),
            },
            deletions_name: {
                "bytes": deletions_path.stat().st_size,
                "sha256": sha256_file(deletions_path),
                "records": len(deletions),
            },
            latest_additions: {
                "bytes": latest_additions_path.stat().st_size,
                "sha256": sha256_file(latest_additions_path),
                "records": len(additions),
            },
            latest_deletions: {
                "bytes": latest_deletions_path.stat().st_size,
                "sha256": sha256_file(latest_deletions_path),
                "records": len(deletions),
            },
        }

        atomic_write_json(updates_root / "manifest.json", manifest)
        self.update_manifest = manifest

        self.record_internal_step(
            name,
            started_at=started_at,
            started=started,
            status="success",
            message=(
                f"Generated {len(additions)} additions/changes and "
                f"{len(deletions)} deletions."
            ),
        )
        self.state.completed_steps.append(name)
        self.save_state()

    def verify_staging(self) -> None:
        if self.args.dry_run or not self.args.verify:
            return

        required = {
            "sqlite": self.staging_root / "sqlite" / "manifest.json",
            "mariadb": self.staging_root / "mariadb" / "manifest.json",
            "indexes": self.staging_root / "indexes" / "manifest.json",
            "updates": self.staging_root / "updates" / "manifest.json",
            "root": self.staging_root / "manifest.json",
            "checksums": self.staging_root / "checksums.json",
            "build-state": self.staging_root / "build-state.json",
        }

        missing = [
            f"{name}: {path}"
            for name, path in required.items()
            if not path.is_file()
        ]
        if missing:
            raise UpdateError(
                "Staging verification found missing outputs: "
                + "; ".join(missing),
                EXIT_VERIFICATION,
            )

        sqlite_records = manifest_records(required["sqlite"])
        mariadb_records = manifest_records(required["mariadb"])
        index_records = manifest_records(required["indexes"])

        if not (
            sqlite_records == mariadb_records == index_records
        ):
            raise UpdateError(
                "Staging record parity failed: "
                f"sqlite={sqlite_records}, "
                f"mariadb={mariadb_records}, "
                f"indexes={index_records}.",
                EXIT_VERIFICATION,
            )

        if (
            self.args.expect_records is not None
            and sqlite_records != self.args.expect_records
        ):
            raise UpdateError(
                "Staging record total does not match --expect-records: "
                f"expected={self.args.expect_records}, "
                f"actual={sqlite_records}.",
                EXIT_VERIFICATION,
            )

        checksums = load_json_object(required["checksums"])
        files = checksums.get("files")
        if not isinstance(files, Mapping):
            raise UpdateError(
                "Top-level checksums.json has an invalid files object.",
                EXIT_VERIFICATION,
            )

        for relative, descriptor in files.items():
            if not isinstance(descriptor, Mapping):
                raise UpdateError(
                    f"Invalid checksum descriptor for {relative}.",
                    EXIT_VERIFICATION,
                )

            path = (self.staging_root / str(relative)).resolve()
            try:
                path.relative_to(self.staging_root.resolve())
            except ValueError as error:
                raise UpdateError(
                    f"Checksum path escapes staging root: {relative}",
                    EXIT_VERIFICATION,
                ) from error

            if not path.is_file():
                raise UpdateError(
                    f"Checksummed staging file is missing: {path}",
                    EXIT_VERIFICATION,
                )

            expected_size = descriptor.get("bytes")
            if expected_size is not None:
                if path.stat().st_size != int(expected_size):
                    raise UpdateError(
                        f"Staging size mismatch for {relative}.",
                        EXIT_VERIFICATION,
                    )

            expected_digest = clean_text(
                descriptor.get("sha256")
            )
            if expected_digest and sha256_file(path) != expected_digest:
                raise UpdateError(
                    f"Staging SHA-256 mismatch for {relative}.",
                    EXIT_VERIFICATION,
                )

    def publish(self) -> None:
        name = "publish"
        self.state.current_step = name
        self.state.status = "running"
        self.save_state()

        started_at = utc_now()
        started = time.monotonic()

        if self.args.in_place:
            self.state.published = True
            self.state.completed_steps.append(name)
            self.record_internal_step(
                name,
                started_at=started_at,
                started=started,
                status="success",
                message="In-place build; publication was implicit.",
            )
            return

        if self.args.dry_run:
            self.logger.info(
                "Dry run: would atomically publish %s to %s",
                self.staging_root,
                self.db_root,
            )
            self.record_internal_step(
                name,
                started_at=started_at,
                started=started,
                status="success",
                message="Dry run; staged products not published.",
            )
            self.state.completed_steps.append(name)
            return

        if not self.staging_root.is_dir():
            raise UpdateError(
                f"Staging root is missing: {self.staging_root}",
                EXIT_PUBLICATION,
            )

        if self.backup_root.exists():
            shutil.rmtree(self.backup_root)

        moved_live = False

        try:
            if self.db_root.exists():
                os.replace(self.db_root, self.backup_root)
                moved_live = True

            os.replace(self.staging_root, self.db_root)
            self.state.published = True

            if (
                self.backup_root.exists()
                and not self.args.keep_backup
            ):
                shutil.rmtree(self.backup_root)

        except Exception as error:
            self.logger.error(
                "Publication failed; attempting rollback."
            )

            with contextlib.suppress(Exception):
                if self.db_root.exists() and not self.state.published:
                    shutil.rmtree(self.db_root)

            if moved_live and self.backup_root.exists():
                os.replace(self.backup_root, self.db_root)
                self.state.rolled_back = True

            raise UpdateError(
                f"Unable to publish staged database products: {error}",
                EXIT_PUBLICATION,
            ) from error

        self.state.completed_steps.append(name)
        self.record_internal_step(
            name,
            started_at=started_at,
            started=started,
            status="success",
            message="Staged products published atomically.",
        )
        self.save_state()

    def write_summary(self, exit_code: int) -> None:
        if self.args.dry_run:
            return

        elapsed = time.monotonic() - self.started
        payload = {
            "schema_version": 3,
            "generated_at": utc_now(),
            "status": self.state.status,
            "exit_code": exit_code,
            "duration_seconds": round(elapsed, 6),
            "duration": human_duration(elapsed),
            "taxonomy_root": str(self.taxonomy_root),
            "archive_manifest": (
                str(self.archive_manifest)
                if self.archive_manifest
                else None
            ),
            "db_root": str(self.db_root),
            "staging_root": str(self.staging_root),
            "backup_root": str(self.backup_root),
            "published": self.state.published,
            "rolled_back": self.state.rolled_back,
            "completed_steps": list(self.state.completed_steps),
            "options": {
                "source_mode": self.args.source_mode,
                "clean": self.args.clean,
                "verify": self.args.verify,
                "verify_each": self.args.verify_each,
                "deep_parity": self.args.deep_parity,
                "strict_parity": self.args.strict_parity,
                "require_index_parity": (
                    self.args.require_index_parity
                ),
                "strict_records": self.args.strict_records,
                "deduplicate": self.args.deduplicate,
                "publish": self.args.publish,
                "in_place": self.args.in_place,
                "copy_existing": self.args.copy_existing,
                "keep_backup": self.args.keep_backup,
                "resume": self.args.resume,
                "expect_records": self.args.expect_records,
            },
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

            for name, script in BUILD_PIPELINE:
                if name in self.args.skip_step:
                    self.logger.info(
                        "Skipping requested step: %s",
                        name,
                    )
                    continue
                self.run_step(name, script)

            if "updates" not in self.args.skip_step:
                self.generate_updates()

            for name, script in VERIFY_PIPELINE:
                if name in self.args.skip_step:
                    self.logger.info(
                        "Skipping requested step: %s",
                        name,
                    )
                    continue
                self.run_step(name, script)

            for name, script in FINALIZE_PIPELINE:
                if name in self.args.skip_step:
                    self.logger.info(
                        "Skipping requested step: %s",
                        name,
                    )
                    continue
                self.run_step(name, script)

            self.verify_staging()

            if self.args.publish:
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
            self.state.last_error = (
                f"{type(error).__name__}: {error}"
            )
            self.save_state()
            self.write_summary(EXIT_BUILD)
            self.logger.error(
                "Database update failed: %s",
                error,
            )
            if self.args.verbose:
                self.logger.error(traceback.format_exc())
            return EXIT_BUILD

        self.logger.info(
            "Updated all Speciedex database products successfully "
            "in %s.",
            human_duration(time.monotonic() - self.started),
        )
        return EXIT_SUCCESS


def parse_args(
    argv: Sequence[str] | None = None,
) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Build, verify, stage, and atomically publish all "
            "Speciedex database products."
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
        "--archive-manifest",
        type=Path,
        default=None,
        help="Canonical taxonomy archive manifest.",
    )
    parser.add_argument(
        "--source-mode",
        choices=("auto", "manifest", "volumes", "recursive"),
        default="auto",
        help="Canonical taxonomy source discovery mode.",
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

    sizing = parser.add_argument_group("builder sizing")
    sizing.add_argument(
        "--rows-per-shard",
        type=int,
        default=100_000,
        help="Maximum logical records per database shard.",
    )
    sizing.add_argument(
        "--target-bytes",
        type=int,
        default=72 * 1024 * 1024,
        help="Approximate target logical shard size.",
    )
    sizing.add_argument(
        "--max-bytes",
        type=int,
        default=90 * 1024 * 1024,
        help="Maximum permitted generated shard size.",
    )
    sizing.add_argument(
        "--insert-batch-size",
        type=int,
        default=500,
        help="Rows per MariaDB INSERT statement.",
    )
    sizing.add_argument(
        "--index-shard-size",
        type=int,
        default=25_000,
        help="Records per browser species shard.",
    )
    sizing.add_argument(
        "--minimum-free-bytes",
        type=int,
        default=512 * 1024 * 1024,
        help="Minimum free disk space required before updating.",
    )
    sizing.add_argument(
        "--expect-records",
        type=int,
        default=None,
        help="Expected canonical record count.",
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
        help="Verify component and staged outputs.",
    )
    parser.add_argument(
        "--verify-each",
        action="store_true",
        help="Request per-shard verification from database builders.",
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
        help="Build directly into the live database root.",
    )
    parser.add_argument(
        "--copy-existing",
        action="store_true",
        help="Copy the current database root into staging first.",
    )
    parser.add_argument(
        "--keep-backup",
        action="store_true",
        help="Retain the previous database root after publication.",
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
        "--strict-parity",
        action="store_true",
        help="Require complete SQLite/MariaDB parity in top-level manifests.",
    )
    parser.add_argument(
        "--require-index-parity",
        action="store_true",
        help="Require browser indexes to match database record totals.",
    )
    parser.add_argument(
        "--strict-records",
        action="store_true",
        help="Fail component builds on invalid canonical records.",
    )
    parser.add_argument(
        "--deduplicate",
        action="store_true",
        help="Deduplicate canonical records by speciedex_id.",
    )
    parser.add_argument(
        "--shard-indexes",
        action="store_true",
        help="Generate sharded browser species indexes.",
    )
    parser.add_argument(
        "--include-canonical-name",
        action="store_true",
        help="Include canonical_name in browser species records.",
    )
    parser.add_argument(
        "--include-taxonomy",
        action="store_true",
        help="Include taxonomy fields in browser species records.",
    )
    parser.add_argument(
        "--step-timeout",
        type=int,
        default=6 * 60 * 60,
        help="Maximum runtime in seconds for each child process.",
    )
    parser.add_argument(
        "--capture-lines",
        type=int,
        default=200,
        help="Maximum stdout and stderr tail lines stored per step.",
    )
    parser.add_argument(
        "--skip-step",
        action="append",
        choices=ALL_STEPS,
        default=[],
        help="Skip a named pipeline step. May be repeated.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show the pipeline without writing or publishing products.",
    )

    passthrough = parser.add_argument_group("pass-through arguments")
    passthrough.add_argument(
        "--sqlite-arg",
        action="append",
        default=[],
        metavar="ARG",
        help="Additional argument for build-sqlite-shards.py.",
    )
    passthrough.add_argument(
        "--mariadb-arg",
        action="append",
        default=[],
        metavar="ARG",
        help="Additional argument for build-mariadb-shards.py.",
    )
    passthrough.add_argument(
        "--index-arg",
        action="append",
        default=[],
        metavar="ARG",
        help="Additional argument for build-db-indexes.py.",
    )
    passthrough.add_argument(
        "--verify-shards-arg",
        action="append",
        default=[],
        metavar="ARG",
        help="Additional argument for verify-shards.py.",
    )
    passthrough.add_argument(
        "--verify-parity-arg",
        action="append",
        default=[],
        metavar="ARG",
        help="Additional argument for verify-database-parity.py.",
    )
    passthrough.add_argument(
        "--manifest-arg",
        action="append",
        default=[],
        metavar="ARG",
        help="Additional argument for build-db-manifests.py.",
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

    if args.rows_per_shard < 1:
        parser.error("--rows-per-shard must be at least 1.")

    if args.target_bytes < 1:
        parser.error("--target-bytes must be at least 1.")

    if args.max_bytes < 1:
        parser.error("--max-bytes must be at least 1.")

    if args.target_bytes > args.max_bytes:
        parser.error("--target-bytes cannot exceed --max-bytes.")

    if args.insert_batch_size < 1:
        parser.error("--insert-batch-size must be at least 1.")

    if args.index_shard_size < 1:
        parser.error("--index-shard-size must be at least 1.")

    if args.minimum_free_bytes < 0:
        parser.error("--minimum-free-bytes cannot be negative.")

    if args.expect_records is not None and args.expect_records < 0:
        parser.error("--expect-records cannot be negative.")

    if args.step_timeout < 1:
        parser.error("--step-timeout must be at least 1.")

    if args.capture_lines < 0:
        parser.error("--capture-lines cannot be negative.")

    if args.verbose and args.quiet:
        parser.error("--verbose and --quiet cannot be used together.")

    if args.in_place and args.staging_root is not None:
        parser.error(
            "--in-place cannot be combined with --staging-root."
        )

    if args.in_place and args.keep_backup:
        parser.error(
            "--keep-backup is not meaningful with --in-place."
        )

    if "publish" in args.skip_step and args.publish:
        parser.error(
            "Use --no-publish instead of --skip-step publish."
        )

    return args


def main(argv: Sequence[str] | None = None) -> int:
    return DatabaseUpdater(parse_args(argv)).run()


if __name__ == "__main__":
    raise SystemExit(main())
