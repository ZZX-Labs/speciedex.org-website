#!/usr/bin/env python3
"""
Speciedex database build orchestrator.

Expected location:
    static/tools/database/build-databases.py

This command coordinates the complete database build while preserving
compatibility with the existing update-databases.py implementation.

It provides:

    * environment and path validation
    * clean, incremental, resume, dry-run, and verification modes
    * structured logs and build-state persistence
    * bounded subprocess execution with clear exit codes
    * optional post-build verification and optimization hooks
    * provider filtering and pass-through worker controls
    * human-readable and JSON build summaries

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import signal
import subprocess
import sys
import time
import traceback
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence


EXIT_SUCCESS = 0
EXIT_VALIDATION = 1
EXIT_BUILD = 2
EXIT_VERIFICATION = 3
EXIT_OPTIMIZATION = 4
EXIT_INTERRUPTED = 130

STATE_FILENAME = "build-state.json"
SUMMARY_FILENAME = "build-summary.json"
LOG_FILENAME = "build.log"

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
    return datetime.now(timezone.utc).isoformat()


def clean_text(value: Any) -> str:
    return str(value or "").strip()


def human_duration(seconds: float) -> str:
    seconds = max(0, int(round(seconds)))
    hours, remainder = divmod(seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


@dataclass
class StageResult:
    name: str
    command: list[str] = field(default_factory=list)
    started_at: str = ""
    finished_at: str = ""
    duration_seconds: float = 0.0
    return_code: int = 0
    skipped: bool = False
    success: bool = False
    message: str = ""


@dataclass
class BuildState:
    version: int = 1
    status: str = "pending"
    started_at: str = ""
    finished_at: str = ""
    taxonomy_root: str = ""
    db_root: str = ""
    provider: list[str] = field(default_factory=list)
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
        self.log_root = (args.log_root or self.db_root / "logs").resolve()
        self.report_root = (args.report_root or self.db_root / "reports").resolve()
        self.state_path = (args.state_file or self.db_root / STATE_FILENAME).resolve()
        self.summary_path = self.report_root / SUMMARY_FILENAME
        self.update_script = self.script_dir / "update-databases.py"
        self.started_monotonic = time.monotonic()
        self.stage_results: list[StageResult] = []
        self.interrupted = False
        self.logger = logging.getLogger("speciedex.database.build")
        self.state = BuildState(
            status="pending",
            started_at=utc_now(),
            taxonomy_root=str(self.taxonomy_root),
            db_root=str(self.db_root),
            provider=list(args.provider or []),
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

        if not self.update_script.is_file():
            raise BuildError(
                f"Required script not found: {self.update_script}",
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

        self.db_root.mkdir(parents=True, exist_ok=True)
        self.report_root.mkdir(parents=True, exist_ok=True)
        self.log_root.mkdir(parents=True, exist_ok=True)

        for path in (self.db_root, self.report_root, self.log_root):
            probe = path / ".speciedex-write-test"
            try:
                probe.write_text("ok\n", encoding="utf-8")
                probe.unlink()
            except OSError as error:
                raise BuildError(
                    f"Directory is not writable: {path}: {error}",
                    EXIT_VALIDATION,
                ) from error

        usage = shutil.disk_usage(self.db_root)
        minimum_free = int(self.args.minimum_free_bytes)
        if usage.free < minimum_free:
            raise BuildError(
                (
                    f"Insufficient free disk space under {self.db_root}: "
                    f"{usage.free} bytes available, {minimum_free} required."
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
        self.state.stages = [asdict(result) for result in self.stage_results]
        atomic_write_json(self.state_path, asdict(self.state))

    def clean_outputs(self) -> None:
        if not self.args.clean:
            return

        preserve = {
            self.log_root.resolve(),
            self.report_root.resolve(),
        }

        for child in self.db_root.iterdir():
            resolved = child.resolve()

            if resolved in preserve:
                continue

            if child == self.state_path:
                continue

            self.logger.info("Removing existing build output: %s", child)

            if self.args.dry_run:
                continue

            if child.is_dir() and not child.is_symlink():
                shutil.rmtree(child)
            else:
                child.unlink(missing_ok=True)

    def build_update_command(self) -> list[str]:
        command = [
            sys.executable,
            str(self.update_script),
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
            command.extend(["--workers", str(self.args.workers)])

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
        optional: bool = False,
    ) -> StageResult:
        result = StageResult(
            name=name,
            command=[str(part) for part in command],
            started_at=utc_now(),
        )
        self.stage_results.append(result)
        self.state.current_stage = name
        self.state.status = "running"
        self.save_state()

        self.logger.info("[%d] %s", len(self.stage_results), name)
        self.logger.debug("Command: %s", " ".join(result.command))

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
                cwd=str(Path.cwd()),
                check=False,
                text=True,
                env=os.environ.copy(),
            )
        except FileNotFoundError as error:
            if optional:
                result.skipped = True
                result.success = True
                result.message = str(error)
                result.finished_at = utc_now()
                result.duration_seconds = time.monotonic() - started
                self.save_state()
                return result

            raise BuildError(
                f"Unable to execute {name}: {error}",
                exit_code,
            ) from error

        result.duration_seconds = time.monotonic() - started
        result.finished_at = utc_now()
        result.return_code = int(completed.returncode)
        result.success = completed.returncode == 0

        if not result.success:
            result.message = (
                f"{name} failed with exit status {completed.returncode}."
            )
            self.save_state()
            raise BuildError(result.message, exit_code)

        result.message = f"Completed in {human_duration(result.duration_seconds)}."
        self.save_state()
        return result

    def run_verification(self) -> None:
        if not self.args.verify:
            return

        discovered = [
            self.script_dir / filename
            for filename in OPTIONAL_VERIFY_SCRIPTS
            if (self.script_dir / filename).is_file()
        ]

        if not discovered:
            self.logger.warning(
                "Verification requested, but no verification scripts were found."
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
                optional=True,
            )

    def run_optimization(self) -> None:
        if not self.args.optimize:
            return

        discovered = [
            self.script_dir / filename
            for filename in OPTIONAL_OPTIMIZE_SCRIPTS
            if (self.script_dir / filename).is_file()
        ]

        if not discovered:
            self.logger.warning(
                "Optimization requested, but no optimization script was found."
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
                optional=True,
            )

    def write_summary(self, exit_code: int) -> None:
        duration = time.monotonic() - self.started_monotonic
        summary = {
            "version": 1,
            "status": self.state.status,
            "exit_code": exit_code,
            "started_at": self.state.started_at,
            "finished_at": self.state.finished_at or utc_now(),
            "duration_seconds": duration,
            "duration": human_duration(duration),
            "taxonomy_root": str(self.taxonomy_root),
            "db_root": str(self.db_root),
            "providers": list(self.args.provider),
            "options": {
                "clean": self.args.clean,
                "incremental": self.args.incremental,
                "resume": self.args.resume,
                "verify": self.args.verify,
                "optimize": self.args.optimize,
                "vacuum": self.args.vacuum,
                "analyze": self.args.analyze,
                "dry_run": self.args.dry_run,
                "workers": self.args.workers,
            },
            "stages": [asdict(result) for result in self.stage_results],
            "last_error": self.state.last_error,
            "interrupted": self.state.interrupted,
        }
        atomic_write_json(self.summary_path, summary)

    def run(self) -> int:
        self.configure_logging()
        self.logger.info("Starting Speciedex database build.")

        try:
            self.validate()

            previous = self.load_previous_state()
            if self.args.resume and previous:
                self.logger.info(
                    "Resuming from previous state: %s",
                    previous.status,
                )

            self.clean_outputs()

            self.run_command(
                "update-databases",
                self.build_update_command(),
                exit_code=EXIT_BUILD,
            )

            self.run_verification()
            self.run_optimization()

            self.state.status = "success"
            self.state.finished_at = utc_now()
            self.state.current_stage = ""
            self.save_state()
            self.write_summary(EXIT_SUCCESS)

            duration = time.monotonic() - self.started_monotonic
            self.logger.info(
                "Speciedex database build completed successfully in %s.",
                human_duration(duration),
            )
            return EXIT_SUCCESS

        except KeyboardInterrupt:
            self.interrupted = True
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
            self.state.last_error = f"{type(error).__name__}: {error}"
            self.save_state()
            self.write_summary(EXIT_BUILD)
            self.logger.error(
                "Unexpected build failure:\n%s",
                traceback.format_exc(),
            )
            return EXIT_BUILD


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build the complete Speciedex database layer.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )

    parser.add_argument(
        "--taxonomy-root",
        type=Path,
        default=Path("static/data/taxonomy"),
        help="Root directory containing normalized taxonomy data.",
    )
    parser.add_argument(
        "--db-root",
        type=Path,
        default=Path("static/data/db"),
        help="Destination root for generated databases and indexes.",
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
        help="Path to the persistent build-state JSON file.",
    )

    parser.add_argument(
        "--provider",
        action="append",
        default=[],
        metavar="NAME",
        help="Limit the build to a provider. May be supplied multiple times.",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=None,
        help="Worker count forwarded to update-databases.py.",
    )

    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--clean",
        action="store_true",
        help="Remove existing database outputs before rebuilding.",
    )
    mode.add_argument(
        "--incremental",
        action="store_true",
        help="Request an incremental database update.",
    )

    parser.add_argument(
        "--resume",
        action="store_true",
        help="Resume using prior build state where supported.",
    )
    parser.add_argument(
        "--verify",
        action="store_true",
        help="Run verification scripts found beside this command.",
    )
    parser.add_argument(
        "--optimize",
        action="store_true",
        help="Run an optional database optimization script.",
    )
    parser.add_argument(
        "--vacuum",
        action="store_true",
        help="Request VACUUM during optimization.",
    )
    parser.add_argument(
        "--analyze",
        action="store_true",
        help="Request ANALYZE during optimization.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show and record actions without executing subprocesses.",
    )
    parser.add_argument(
        "--minimum-free-bytes",
        type=int,
        default=256 * 1024 * 1024,
        help="Minimum required free disk space beneath the database root.",
    )
    parser.add_argument(
        "--update-arg",
        action="append",
        default=[],
        metavar="ARG",
        help=(
            "Additional argument forwarded verbatim to update-databases.py. "
            "May be supplied multiple times."
        ),
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

    if args.workers is not None and args.workers < 1:
        parser.error("--workers must be at least 1.")

    if args.minimum_free_bytes < 0:
        parser.error("--minimum-free-bytes cannot be negative.")

    if args.quiet and args.verbose:
        parser.error("--quiet and --verbose cannot be used together.")

    if (args.vacuum or args.analyze) and not args.optimize:
        parser.error("--vacuum and --analyze require --optimize.")

    args.provider = [
        provider
        for provider in (clean_text(value) for value in args.provider)
        if provider
    ]

    return args


def main(argv: Sequence[str] | None = None) -> int:
    return DatabaseBuilder(parse_args(argv)).run()


if __name__ == "__main__":
    raise SystemExit(main())
