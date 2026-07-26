#!/usr/bin/env python3
"""
Speciedex database build orchestrator.

Expected location:
    static/tools/database/build-databases.py

This command coordinates deterministic SQLite and MariaDB shard builds from the
canonical Speciedex taxonomy archive.

The canonical source of truth remains static/data/taxonomy/. Database products
are derived artifacts and are never treated as authoritative.

The orchestrator can run the dedicated shard builders directly, preserve
compatibility with update-databases.py when explicitly requested, persist
stage state, resume validated stages, capture bounded subprocess output,
verify manifests and shard totals, and write structured build summaries.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
"""

from __future__ import annotations

import argparse
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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence


EXIT_SUCCESS = 0
EXIT_VALIDATION = 1
EXIT_BUILD = 2
EXIT_VERIFICATION = 3
EXIT_OPTIMIZATION = 4
EXIT_INTERRUPTED = 130

STATE_FILENAME = "build-state.json"
SUMMARY_FILENAME = "build-summary.json"
LOG_FILENAME = "build.log"

SQLITE_BUILDER = "build-sqlite-shards.py"
MARIADB_BUILDER = "build-mariadb-shards.py"
LEGACY_UPDATE_SCRIPT = "update-databases.py"

SQLITE_MANIFEST = Path("sqlite/manifest.json")
MARIADB_MANIFEST = Path("mariadb/manifest.json")

OPTIONAL_VERIFY_SCRIPTS = (
    "verify-database.py",
    "verify-databases.py",
    "verify-indexes.py",
    "verify-providers.py",
    "verify-statistics.py",
)

OPTIONAL_OPTIMIZE_SCRIPTS = (
    "optimize-databases.py",
    "optimize-database.py",
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00",
        "Z",
    )


def clean_text(value: Any) -> str:
    return str(value or "").strip()


def human_duration(seconds: float) -> str:
    seconds = max(0, int(round(seconds)))
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None

    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            newline="\n",
            delete=False,
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
        ) as handle:
            json.dump(
                payload,
                handle,
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
            temporary = Path(handle.name)

        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink(missing_ok=True)


def load_json_object(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise BuildError(
            f"Required JSON file not found: {path}",
            EXIT_VERIFICATION,
        ) from error
    except json.JSONDecodeError as error:
        raise BuildError(
            f"Invalid JSON in {path}: {error}",
            EXIT_VERIFICATION,
        ) from error

    if not isinstance(value, dict):
        raise BuildError(
            f"Expected JSON object in {path}.",
            EXIT_VERIFICATION,
        )

    return value


def manifest_total_records(manifest: Mapping[str, Any]) -> int:
    totals = manifest.get("totals")
    if not isinstance(totals, Mapping):
        raise BuildError(
            "Generated manifest is missing totals.",
            EXIT_VERIFICATION,
        )

    value = totals.get("records")
    if isinstance(value, bool):
        raise BuildError(
            "Generated manifest record total is invalid.",
            EXIT_VERIFICATION,
        )

    try:
        records = int(value)
    except (TypeError, ValueError) as error:
        raise BuildError(
            f"Generated manifest record total is invalid: {value!r}",
            EXIT_VERIFICATION,
        ) from error

    if records < 0:
        raise BuildError(
            "Generated manifest record total cannot be negative.",
            EXIT_VERIFICATION,
        )

    return records


def manifest_total_shards(manifest: Mapping[str, Any]) -> int:
    totals = manifest.get("totals")
    if not isinstance(totals, Mapping):
        raise BuildError(
            "Generated manifest is missing totals.",
            EXIT_VERIFICATION,
        )

    try:
        shards = int(totals.get("shards"))
    except (TypeError, ValueError) as error:
        raise BuildError(
            "Generated manifest shard total is invalid.",
            EXIT_VERIFICATION,
        ) from error

    if shards < 0:
        raise BuildError(
            "Generated manifest shard total cannot be negative.",
            EXIT_VERIFICATION,
        )

    return shards


@dataclass
class StageResult:
    name: str
    command: list[str] = field(default_factory=list)
    started_at: str = ""
    finished_at: str = ""
    duration_seconds: float = 0.0
    return_code: int = 0
    skipped: bool = False
    resumed: bool = False
    success: bool = False
    stdout_tail: list[str] = field(default_factory=list)
    stderr_tail: list[str] = field(default_factory=list)
    message: str = ""


@dataclass
class BuildState:
    version: int = 2
    status: str = "pending"
    started_at: str = ""
    finished_at: str = ""
    taxonomy_root: str = ""
    db_root: str = ""
    mode: str = "direct"
    targets: list[str] = field(default_factory=list)
    stages: list[dict[str, Any]] = field(default_factory=list)
    current_stage: str = ""
    last_error: str = ""
    interrupted: bool = False


class BuildError(RuntimeError):
    def __init__(self, message: str, exit_code: int = EXIT_BUILD) -> None:
        super().__init__(message)
        self.exit_code = exit_code


class DatabaseBuilder:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.script_dir = Path(__file__).resolve().parent
        self.taxonomy_root = args.taxonomy_root.resolve()
        self.db_root = args.db_root.resolve()
        self.sqlite_root = (args.sqlite_root or self.db_root / "sqlite").resolve()
        self.mariadb_root = (
            args.mariadb_root or self.db_root / "mariadb"
        ).resolve()
        self.log_root = (args.log_root or self.db_root / "logs").resolve()
        self.report_root = (
            args.report_root or self.db_root / "reports"
        ).resolve()
        self.state_path = (
            args.state_file or self.db_root / STATE_FILENAME
        ).resolve()
        self.summary_path = (
            args.summary_file or self.report_root / SUMMARY_FILENAME
        ).resolve()

        self.sqlite_builder = self.script_dir / SQLITE_BUILDER
        self.mariadb_builder = self.script_dir / MARIADB_BUILDER
        self.legacy_update_script = self.script_dir / LEGACY_UPDATE_SCRIPT

        self.started_monotonic = time.monotonic()
        self.stage_results: list[StageResult] = []
        self.logger = logging.getLogger("speciedex.database.build")

        targets: list[str] = []
        if args.sqlite:
            targets.append("sqlite")
        if args.mariadb:
            targets.append("mariadb")

        self.state = BuildState(
            status="pending",
            started_at=utc_now(),
            taxonomy_root=str(self.taxonomy_root),
            db_root=str(self.db_root),
            mode=args.mode,
            targets=targets,
        )

    def configure_logging(self) -> None:
        self.log_root.mkdir(parents=True, exist_ok=True)

        level = logging.DEBUG if self.args.verbose else logging.INFO
        if self.args.quiet:
            level = logging.WARNING

        self.logger.setLevel(level)
        self.logger.handlers.clear()
        self.logger.propagate = False

        formatter = logging.Formatter(
            "%(asctime)s %(levelname)s %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )

        file_handler = logging.FileHandler(
            self.log_root / LOG_FILENAME,
            encoding="utf-8",
        )
        file_handler.setLevel(logging.DEBUG)
        file_handler.setFormatter(formatter)
        self.logger.addHandler(file_handler)

        stream_handler = logging.StreamHandler(sys.stdout)
        stream_handler.setLevel(level)
        stream_handler.setFormatter(formatter)
        self.logger.addHandler(stream_handler)

    def validate(self) -> None:
        if sys.version_info < (3, 10):
            raise BuildError(
                "Python 3.10 or newer is required.",
                EXIT_VALIDATION,
            )

        if not self.taxonomy_root.exists():
            raise BuildError(
                f"Taxonomy root does not exist: {self.taxonomy_root}",
                EXIT_VALIDATION,
            )

        if not self.taxonomy_root.is_dir():
            raise BuildError(
                f"Taxonomy root is not a directory: {self.taxonomy_root}",
                EXIT_VALIDATION,
            )

        if self.args.mode == "direct":
            if self.args.sqlite and not self.sqlite_builder.is_file():
                raise BuildError(
                    f"Required SQLite builder not found: {self.sqlite_builder}",
                    EXIT_VALIDATION,
                )

            if self.args.mariadb and not self.mariadb_builder.is_file():
                raise BuildError(
                    f"Required MariaDB builder not found: "
                    f"{self.mariadb_builder}",
                    EXIT_VALIDATION,
                )

        elif not self.legacy_update_script.is_file():
            raise BuildError(
                f"Legacy update script not found: "
                f"{self.legacy_update_script}",
                EXIT_VALIDATION,
            )

        if not self.args.sqlite and not self.args.mariadb:
            raise BuildError(
                "At least one database target must be enabled.",
                EXIT_VALIDATION,
            )

        for path in (
            self.db_root,
            self.sqlite_root,
            self.mariadb_root,
            self.report_root,
            self.log_root,
            self.state_path.parent,
            self.summary_path.parent,
        ):
            path.mkdir(parents=True, exist_ok=True)

        for path in (
            self.db_root,
            self.report_root,
            self.log_root,
            self.state_path.parent,
            self.summary_path.parent,
        ):
            probe: Path | None = None
            try:
                with tempfile.NamedTemporaryFile(
                    "w",
                    encoding="utf-8",
                    delete=False,
                    dir=path,
                    prefix=".speciedex-write-test.",
                ) as handle:
                    handle.write("ok\n")
                    probe = Path(handle.name)
            except OSError as error:
                raise BuildError(
                    f"Directory is not writable: {path}: {error}",
                    EXIT_VALIDATION,
                ) from error
            finally:
                if probe is not None:
                    probe.unlink(missing_ok=True)

        usage = shutil.disk_usage(self.db_root)
        if usage.free < self.args.minimum_free_bytes:
            raise BuildError(
                f"Insufficient free disk space under {self.db_root}: "
                f"{usage.free} bytes available, "
                f"{self.args.minimum_free_bytes} required.",
                EXIT_VALIDATION,
            )

    def load_previous_state(self) -> BuildState | None:
        if not self.state_path.is_file():
            return None

        try:
            payload = json.loads(
                self.state_path.read_text(encoding="utf-8")
            )
        except (OSError, json.JSONDecodeError) as error:
            self.logger.warning(
                "Unable to read previous build state: %s",
                error,
            )
            return None

        if not isinstance(payload, dict):
            return None

        allowed = set(BuildState.__dataclass_fields__)
        compatible = {
            key: value
            for key, value in payload.items()
            if key in allowed
        }

        try:
            return BuildState(**compatible)
        except TypeError:
            self.logger.warning(
                "Ignoring incompatible previous build state."
            )
            return None

    def save_state(self) -> None:
        self.state.stages = [
            asdict(result) for result in self.stage_results
        ]
        atomic_write_json(self.state_path, asdict(self.state))

    def clean_outputs(self) -> None:
        if not self.args.clean:
            return

        targets: list[Path] = []
        if self.args.sqlite:
            targets.append(self.sqlite_root)
        if self.args.mariadb:
            targets.append(self.mariadb_root)

        for target in targets:
            self.logger.info(
                "Removing existing database output: %s",
                target,
            )

            if self.args.dry_run:
                continue

            if target.exists():
                shutil.rmtree(target)

            target.mkdir(parents=True, exist_ok=True)

    def stage_completed_in_previous_state(
        self,
        name: str,
    ) -> StageResult | None:
        if not self.args.resume:
            return None

        previous = self.load_previous_state()
        if previous is None:
            return None

        if Path(previous.taxonomy_root).resolve() != self.taxonomy_root:
            raise BuildError(
                "Resume state taxonomy root does not match this build.",
                EXIT_VALIDATION,
            )

        if Path(previous.db_root).resolve() != self.db_root:
            raise BuildError(
                "Resume state database root does not match this build.",
                EXIT_VALIDATION,
            )

        for raw in previous.stages:
            if not isinstance(raw, Mapping):
                continue
            if clean_text(raw.get("name")) != name:
                continue
            if not bool(raw.get("success")):
                continue

            allowed = set(StageResult.__dataclass_fields__)
            compatible = {
                key: value
                for key, value in raw.items()
                if key in allowed
            }
            result = StageResult(**compatible)
            result.resumed = True
            result.skipped = True
            result.message = "Resumed completed stage."
            return result

        return None

    def build_common_builder_args(self) -> list[str]:
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
            "--progress-every",
            str(self.args.progress_every),
        ]

        if self.args.archive_manifest is not None:
            arguments.extend(
                [
                    "--archive-manifest",
                    str(self.args.archive_manifest.resolve()),
                ]
            )

        if self.args.expect_records is not None:
            arguments.extend(
                [
                    "--expect-records",
                    str(self.args.expect_records),
                ]
            )

        if self.args.clean:
            arguments.append("--clean")

        if self.args.resume:
            arguments.append("--resume")

        if self.args.verify:
            arguments.append("--verify")

        if self.args.verify_each:
            arguments.append("--verify-each")

        if self.args.strict:
            arguments.append("--strict")

        if self.args.deduplicate:
            arguments.append("--deduplicate")

        if self.args.dry_run:
            arguments.append("--dry-run")

        if self.args.verbose:
            arguments.append("--verbose")

        if self.args.quiet:
            arguments.append("--quiet")

        return arguments

    def build_sqlite_command(self) -> list[str]:
        command = [
            sys.executable,
            str(self.sqlite_builder),
            "--output",
            str(self.sqlite_root),
            *self.build_common_builder_args(),
        ]

        if self.args.analyze:
            command.append("--analyze")

        if self.args.vacuum:
            command.append("--vacuum")

        command.extend(self.args.sqlite_arg)
        return command

    def build_mariadb_command(self) -> list[str]:
        command = [
            sys.executable,
            str(self.mariadb_builder),
            "--output",
            str(self.mariadb_root),
            "--insert-batch-size",
            str(self.args.insert_batch_size),
            *self.build_common_builder_args(),
        ]
        command.extend(self.args.mariadb_arg)
        return command

    def build_legacy_command(self) -> list[str]:
        command = [
            sys.executable,
            str(self.legacy_update_script),
            "--taxonomy-root",
            str(self.taxonomy_root),
            "--db-root",
            str(self.db_root),
        ]

        if self.args.incremental:
            command.append("--incremental")

        if self.args.resume:
            command.append("--resume")

        if self.args.workers is not None:
            command.extend(
                ["--workers", str(self.args.workers)]
            )

        for provider in self.args.provider:
            command.extend(["--provider", provider])

        if self.args.verbose:
            command.append("--verbose")

        if self.args.quiet:
            command.append("--quiet")

        command.extend(self.args.update_arg)
        return command

    def run_command(
        self,
        name: str,
        command: Sequence[str],
        *,
        exit_code: int,
        allow_resume: bool = True,
    ) -> StageResult:
        resumed = (
            self.stage_completed_in_previous_state(name)
            if allow_resume
            else None
        )

        if resumed is not None:
            self.stage_results.append(resumed)
            self.logger.info(
                "Skipping completed stage from resume state: %s",
                name,
            )
            self.save_state()
            return resumed

        result = StageResult(
            name=name,
            command=[str(part) for part in command],
            started_at=utc_now(),
        )
        self.stage_results.append(result)
        self.state.current_stage = name
        self.state.status = "running"
        self.save_state()

        self.logger.info(
            "[%d] %s",
            len(self.stage_results),
            name,
        )
        self.logger.debug(
            "Command: %s",
            " ".join(result.command),
        )

        if self.args.dry_run:
            result.skipped = True
            result.success = True
            result.message = "Dry run; command not executed."
            result.finished_at = utc_now()
            self.save_state()
            return result

        started = time.monotonic()

        try:
            completed = subprocess.run(
                result.command,
                cwd=str(self.script_dir.parent.parent.parent),
                check=False,
                text=True,
                capture_output=True,
                timeout=self.args.stage_timeout,
                env=os.environ.copy(),
            )
        except subprocess.TimeoutExpired as error:
            result.duration_seconds = time.monotonic() - started
            result.finished_at = utc_now()
            result.return_code = -1
            result.success = False
            result.message = (
                f"{name} exceeded timeout of "
                f"{self.args.stage_timeout} seconds."
            )
            result.stdout_tail = (
                clean_text(error.stdout).splitlines()
                if error.stdout
                else []
            )[-self.args.capture_lines :]
            result.stderr_tail = (
                clean_text(error.stderr).splitlines()
                if error.stderr
                else []
            )[-self.args.capture_lines :]
            self.save_state()
            raise BuildError(result.message, exit_code) from error

        except OSError as error:
            result.duration_seconds = time.monotonic() - started
            result.finished_at = utc_now()
            result.return_code = -1
            result.success = False
            result.message = f"Unable to execute {name}: {error}"
            self.save_state()
            raise BuildError(result.message, exit_code) from error

        result.duration_seconds = time.monotonic() - started
        result.finished_at = utc_now()
        result.return_code = int(completed.returncode)
        result.stdout_tail = completed.stdout.splitlines()[
            -self.args.capture_lines :
        ]
        result.stderr_tail = completed.stderr.splitlines()[
            -self.args.capture_lines :
        ]
        result.success = completed.returncode == 0

        for line in result.stdout_tail:
            self.logger.debug("%s stdout: %s", name, line)
        for line in result.stderr_tail:
            self.logger.debug("%s stderr: %s", name, line)

        if not result.success:
            result.message = (
                f"{name} failed with exit status "
                f"{completed.returncode}."
            )
            self.save_state()
            raise BuildError(result.message, exit_code)

        result.message = (
            f"Completed in "
            f"{human_duration(result.duration_seconds)}."
        )
        self.save_state()
        return result

    def run_direct_builds(self) -> None:
        if self.args.sqlite:
            self.run_command(
                "build-sqlite-shards",
                self.build_sqlite_command(),
                exit_code=EXIT_BUILD,
            )

        if self.args.mariadb:
            self.run_command(
                "build-mariadb-shards",
                self.build_mariadb_command(),
                exit_code=EXIT_BUILD,
            )

    def run_legacy_build(self) -> None:
        self.run_command(
            "update-databases",
            self.build_legacy_command(),
            exit_code=EXIT_BUILD,
        )

    def verify_manifests(self) -> None:
        if self.args.dry_run or not self.args.verify:
            return

        sqlite_manifest: dict[str, Any] | None = None
        mariadb_manifest: dict[str, Any] | None = None

        if self.args.sqlite:
            sqlite_manifest = load_json_object(
                self.sqlite_root / "manifest.json"
            )

            if clean_text(sqlite_manifest.get("kind")) != "sqlite":
                raise BuildError(
                    "SQLite manifest kind is invalid.",
                    EXIT_VERIFICATION,
                )

            manifest_total_records(sqlite_manifest)
            expected_shards = manifest_total_shards(sqlite_manifest)
            actual_shards = len(
                list(self.sqlite_root.glob("speciedex-*.sqlite3"))
            )

            if actual_shards != expected_shards:
                raise BuildError(
                    "SQLite shard count mismatch: "
                    f"manifest={expected_shards}, files={actual_shards}.",
                    EXIT_VERIFICATION,
                )

        if self.args.mariadb:
            mariadb_manifest = load_json_object(
                self.mariadb_root / "manifest.json"
            )

            if (
                clean_text(mariadb_manifest.get("kind"))
                != "mariadb-logical"
            ):
                raise BuildError(
                    "MariaDB manifest kind is invalid.",
                    EXIT_VERIFICATION,
                )

            manifest_total_records(mariadb_manifest)
            expected_shards = manifest_total_shards(mariadb_manifest)
            actual_shards = len(
                list(self.mariadb_root.glob("speciedex-*.sql.gz"))
            )

            if actual_shards != expected_shards:
                raise BuildError(
                    "MariaDB shard count mismatch: "
                    f"manifest={expected_shards}, files={actual_shards}.",
                    EXIT_VERIFICATION,
                )

        if (
            sqlite_manifest is not None
            and mariadb_manifest is not None
        ):
            sqlite_records = manifest_total_records(sqlite_manifest)
            mariadb_records = manifest_total_records(mariadb_manifest)

            if sqlite_records != mariadb_records:
                raise BuildError(
                    "Cross-format record count mismatch: "
                    f"sqlite={sqlite_records}, "
                    f"mariadb={mariadb_records}.",
                    EXIT_VERIFICATION,
                )

    def run_optional_verification(self) -> None:
        if not self.args.verify_scripts:
            return

        discovered = [
            self.script_dir / filename
            for filename in OPTIONAL_VERIFY_SCRIPTS
            if (self.script_dir / filename).is_file()
        ]

        if not discovered:
            self.logger.warning(
                "Verification scripts requested, but none were found."
            )
            return

        for script in discovered:
            command = [
                sys.executable,
                str(script),
                "--taxonomy-root",
                str(self.taxonomy_root),
                "--db-root",
                str(self.db_root),
            ]
            self.run_command(
                f"verify:{script.name}",
                command,
                exit_code=EXIT_VERIFICATION,
                allow_resume=False,
            )

    def run_optional_optimization(self) -> None:
        if not self.args.optimize_scripts:
            return

        discovered = [
            self.script_dir / filename
            for filename in OPTIONAL_OPTIMIZE_SCRIPTS
            if (self.script_dir / filename).is_file()
        ]

        if not discovered:
            self.logger.warning(
                "Optimization scripts requested, but none were found."
            )
            return

        for script in discovered:
            command = [
                sys.executable,
                str(script),
                "--db-root",
                str(self.db_root),
            ]

            if self.args.vacuum:
                command.append("--vacuum")

            if self.args.analyze:
                command.append("--analyze")

            self.run_command(
                f"optimize:{script.name}",
                command,
                exit_code=EXIT_OPTIMIZATION,
                allow_resume=False,
            )

    def summary_totals(self) -> dict[str, Any]:
        totals: dict[str, Any] = {}

        if not self.args.dry_run and self.args.sqlite:
            path = self.sqlite_root / "manifest.json"
            if path.is_file():
                manifest = load_json_object(path)
                totals["sqlite"] = dict(
                    manifest.get("totals", {})
                    if isinstance(manifest.get("totals"), Mapping)
                    else {}
                )

        if not self.args.dry_run and self.args.mariadb:
            path = self.mariadb_root / "manifest.json"
            if path.is_file():
                manifest = load_json_object(path)
                totals["mariadb"] = dict(
                    manifest.get("totals", {})
                    if isinstance(manifest.get("totals"), Mapping)
                    else {}
                )

        return totals

    def write_summary(self, exit_code: int) -> None:
        duration = time.monotonic() - self.started_monotonic
        summary = {
            "version": 2,
            "status": self.state.status,
            "exit_code": exit_code,
            "started_at": self.state.started_at,
            "finished_at": self.state.finished_at or utc_now(),
            "duration_seconds": round(duration, 6),
            "duration": human_duration(duration),
            "taxonomy_root": str(self.taxonomy_root),
            "db_root": str(self.db_root),
            "sqlite_root": str(self.sqlite_root),
            "mariadb_root": str(self.mariadb_root),
            "mode": self.args.mode,
            "targets": list(self.state.targets),
            "options": {
                "clean": self.args.clean,
                "incremental": self.args.incremental,
                "resume": self.args.resume,
                "verify": self.args.verify,
                "verify_each": self.args.verify_each,
                "verify_scripts": self.args.verify_scripts,
                "optimize_scripts": self.args.optimize_scripts,
                "vacuum": self.args.vacuum,
                "analyze": self.args.analyze,
                "strict": self.args.strict,
                "deduplicate": self.args.deduplicate,
                "dry_run": self.args.dry_run,
                "rows_per_shard": self.args.rows_per_shard,
                "target_bytes": self.args.target_bytes,
                "max_bytes": self.args.max_bytes,
                "insert_batch_size": self.args.insert_batch_size,
                "stage_timeout": self.args.stage_timeout,
            },
            "totals": self.summary_totals(),
            "stages": [
                asdict(result)
                for result in self.stage_results
            ],
            "last_error": self.state.last_error,
            "interrupted": self.state.interrupted,
        }
        atomic_write_json(self.summary_path, summary)

    def run(self) -> int:
        self.configure_logging()
        self.logger.info(
            "Starting Speciedex database build."
        )

        try:
            self.validate()
            self.clean_outputs()

            if self.args.mode == "direct":
                self.run_direct_builds()
            else:
                self.run_legacy_build()

            self.verify_manifests()
            self.run_optional_verification()
            self.run_optional_optimization()

            self.state.status = "success"
            self.state.finished_at = utc_now()
            self.state.current_stage = ""
            self.save_state()
            self.write_summary(EXIT_SUCCESS)

            self.logger.info(
                "Speciedex database build completed successfully "
                "in %s.",
                human_duration(
                    time.monotonic()
                    - self.started_monotonic
                ),
            )
            return EXIT_SUCCESS

        except KeyboardInterrupt:
            self.state.status = "interrupted"
            self.state.interrupted = True
            self.state.finished_at = utc_now()
            self.state.last_error = "Build interrupted by user."
            self.save_state()
            self.write_summary(EXIT_INTERRUPTED)
            self.logger.error("Build interrupted.")
            return EXIT_INTERRUPTED

        except BuildError as error:
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
                "Unexpected build failure:\n%s",
                traceback.format_exc(),
            )
            return EXIT_BUILD


def parse_args(
    argv: Sequence[str] | None = None,
) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Build deterministic Speciedex SQLite and MariaDB "
            "database products."
        ),
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )

    parser.add_argument(
        "--taxonomy-root",
        type=Path,
        default=Path("static/data/taxonomy"),
        help="Root directory containing canonical taxonomy data.",
    )
    parser.add_argument(
        "--archive-manifest",
        type=Path,
        default=None,
        help="Canonical taxonomy manifest passed to shard builders.",
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
        default=Path("static/data/db"),
        help="Destination root for generated databases.",
    )
    parser.add_argument(
        "--sqlite-root",
        type=Path,
        default=None,
        help="SQLite shard output directory.",
    )
    parser.add_argument(
        "--mariadb-root",
        type=Path,
        default=None,
        help="MariaDB logical shard output directory.",
    )
    parser.add_argument(
        "--log-root",
        type=Path,
        default=None,
        help="Directory for build logs.",
    )
    parser.add_argument(
        "--report-root",
        type=Path,
        default=None,
        help="Directory for JSON build reports.",
    )
    parser.add_argument(
        "--state-file",
        type=Path,
        default=None,
        help="Persistent orchestrator state file.",
    )
    parser.add_argument(
        "--summary-file",
        type=Path,
        default=None,
        help="Build summary JSON destination.",
    )
    parser.add_argument(
        "--mode",
        choices=("direct", "legacy"),
        default="direct",
        help=(
            "Use dedicated shard builders directly or call the "
            "legacy update-databases.py wrapper."
        ),
    )

    targets = parser.add_argument_group("database targets")
    targets.add_argument(
        "--sqlite",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Build SQLite shards.",
    )
    targets.add_argument(
        "--mariadb",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Build MariaDB logical shards.",
    )

    builder = parser.add_argument_group("builder options")
    builder.add_argument(
        "--rows-per-shard",
        type=int,
        default=100_000,
        help="Maximum logical records per shard.",
    )
    builder.add_argument(
        "--target-bytes",
        type=int,
        default=72 * 1024 * 1024,
        help="Approximate target logical shard size.",
    )
    builder.add_argument(
        "--max-bytes",
        type=int,
        default=90 * 1024 * 1024,
        help="Maximum allowed generated shard size.",
    )
    builder.add_argument(
        "--insert-batch-size",
        type=int,
        default=500,
        help="Rows per MariaDB INSERT statement.",
    )
    builder.add_argument(
        "--expect-records",
        type=int,
        default=None,
        help="Expected canonical record count.",
    )
    builder.add_argument(
        "--progress-every",
        type=int,
        default=10,
        help="Emit builder progress after this many shards.",
    )
    builder.add_argument(
        "--strict",
        action="store_true",
        help="Fail on malformed canonical records.",
    )
    builder.add_argument(
        "--deduplicate",
        action="store_true",
        help="Deduplicate canonical records by speciedex_id.",
    )

    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--clean",
        action="store_true",
        help="Remove selected database outputs before rebuilding.",
    )
    mode.add_argument(
        "--incremental",
        action="store_true",
        help="Request an incremental legacy update.",
    )

    parser.add_argument(
        "--resume",
        action="store_true",
        help="Resume completed stages and shard builders where supported.",
    )
    parser.add_argument(
        "--verify",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Verify builder outputs and cross-format totals.",
    )
    parser.add_argument(
        "--verify-each",
        action="store_true",
        help="Request per-shard verification from both builders.",
    )
    parser.add_argument(
        "--verify-scripts",
        action="store_true",
        help="Run optional repository verification scripts.",
    )
    parser.add_argument(
        "--optimize-scripts",
        action="store_true",
        help="Run optional repository optimization scripts.",
    )
    parser.add_argument(
        "--vacuum",
        action="store_true",
        help="Request SQLite VACUUM during direct build or optimization.",
    )
    parser.add_argument(
        "--analyze",
        action="store_true",
        help="Request SQLite ANALYZE during direct build or optimization.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Record commands without executing subprocesses.",
    )
    parser.add_argument(
        "--minimum-free-bytes",
        type=int,
        default=256 * 1024 * 1024,
        help="Minimum free disk space required beneath db-root.",
    )
    parser.add_argument(
        "--stage-timeout",
        type=int,
        default=6 * 60 * 60,
        help="Maximum runtime in seconds for each subprocess stage.",
    )
    parser.add_argument(
        "--capture-lines",
        type=int,
        default=200,
        help="Maximum stdout and stderr lines retained per stage.",
    )

    legacy = parser.add_argument_group("legacy compatibility")
    legacy.add_argument(
        "--provider",
        action="append",
        default=[],
        metavar="NAME",
        help="Provider filter passed to update-databases.py.",
    )
    legacy.add_argument(
        "--workers",
        type=int,
        default=None,
        help="Worker count passed to update-databases.py.",
    )
    legacy.add_argument(
        "--update-arg",
        action="append",
        default=[],
        metavar="ARG",
        help="Additional argument passed to update-databases.py.",
    )

    passthrough = parser.add_argument_group("builder pass-through")
    passthrough.add_argument(
        "--sqlite-arg",
        action="append",
        default=[],
        metavar="ARG",
        help="Additional argument passed to build-sqlite-shards.py.",
    )
    passthrough.add_argument(
        "--mariadb-arg",
        action="append",
        default=[],
        metavar="ARG",
        help="Additional argument passed to build-mariadb-shards.py.",
    )

    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Enable verbose logging.",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress informational console logging.",
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

    if args.expect_records is not None and args.expect_records < 0:
        parser.error("--expect-records cannot be negative.")

    if args.progress_every < 0:
        parser.error("--progress-every cannot be negative.")

    if args.minimum_free_bytes < 0:
        parser.error("--minimum-free-bytes cannot be negative.")

    if args.stage_timeout < 1:
        parser.error("--stage-timeout must be at least 1.")

    if args.capture_lines < 0:
        parser.error("--capture-lines cannot be negative.")

    if args.workers is not None and args.workers < 1:
        parser.error("--workers must be at least 1.")

    if args.quiet and args.verbose:
        parser.error(
            "--quiet and --verbose cannot be used together."
        )

    if args.incremental and args.mode != "legacy":
        parser.error("--incremental requires --mode legacy.")

    if args.provider and args.mode != "legacy":
        parser.error("--provider requires --mode legacy.")

    if args.workers is not None and args.mode != "legacy":
        parser.error("--workers requires --mode legacy.")

    if args.update_arg and args.mode != "legacy":
        parser.error("--update-arg requires --mode legacy.")

    if not args.sqlite and not args.mariadb:
        parser.error(
            "At least one of --sqlite or --mariadb must be enabled."
        )

    args.provider = [
        provider
        for provider in (
            clean_text(value)
            for value in args.provider
        )
        if provider
    ]

    return args


def main(argv: Sequence[str] | None = None) -> int:
    return DatabaseBuilder(parse_args(argv)).run()


if __name__ == "__main__":
    raise SystemExit(main())
