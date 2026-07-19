#!/usr/bin/env python3
"""
Speciedex.org
static/tools/core/health.py

Ingestion-engine health monitoring, diagnostics, and status reporting.

This module owns:

- archive health checks,
- SQLite health checks,
- manifest health checks,
- primary-volume health checks,
- revision-journal health checks,
- conflict-journal health checks,
- provider-state health checks,
- scheduler health checks,
- disk-space checks,
- file-size limit checks,
- stale-state detection,
- provider failure summaries,
- structured health reports,
- machine-readable status JSON,
- exit-code calculation for CI and GitHub Actions.

The HealthManager does not mutate archive data by default. Repair operations
remain the responsibility of the individual components.

Copyright (c) 2026 ZZX-Laboratories

Licensed under the MIT License.
"""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import tempfile
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from .manifest import ManifestManager
from .revision_writer import RevisionWriter
from .scheduler import Scheduler
from .sqlite_index import SQLiteIndex
from .volume_writer import VolumeWriter


HEALTH_SCHEMA_VERSION = 1

STATUS_OK = "ok"
STATUS_WARNING = "warning"
STATUS_CRITICAL = "critical"
STATUS_UNKNOWN = "unknown"

VALID_STATUSES = {
    STATUS_OK,
    STATUS_WARNING,
    STATUS_CRITICAL,
    STATUS_UNKNOWN,
}

DEFAULT_MINIMUM_FREE_BYTES = 2 * 1024 * 1024 * 1024
DEFAULT_WARNING_FREE_BYTES = 5 * 1024 * 1024 * 1024
DEFAULT_STALE_HOURS = 48
DEFAULT_PROVIDER_STALE_HOURS = 72
DEFAULT_MAX_PROVIDER_FAILURES = 5
DEFAULT_GITHUB_WARNING_BYTES = 85 * 1024 * 1024
DEFAULT_GITHUB_FAILURE_BYTES = 95 * 1024 * 1024


class HealthError(RuntimeError):
    """Raised when health diagnostics cannot complete safely."""


@dataclass(slots=True)
class HealthCheck:
    """One health check result."""

    name: str
    status: str
    message: str
    component: str = "system"
    details: dict[str, Any] = field(
        default_factory=dict
    )
    duration_seconds: float = 0.0

    @property
    def ok(self) -> bool:
        """Return whether the check passed."""

        return self.status == STATUS_OK

    @property
    def warning(self) -> bool:
        """Return whether the check produced a warning."""

        return self.status == STATUS_WARNING

    @property
    def critical(self) -> bool:
        """Return whether the check failed critically."""

        return self.status == STATUS_CRITICAL

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible check object."""

        return {
            "name": self.name,
            "status": self.status,
            "message": self.message,
            "component": self.component,
            "details": dict(
                self.details
            ),
            "duration_seconds": round(
                self.duration_seconds,
                6,
            ),
        }


@dataclass(slots=True)
class ComponentHealth:
    """Aggregate health for one subsystem."""

    component: str
    status: str
    checks: list[HealthCheck]

    @property
    def critical_count(self) -> int:
        return sum(
            1
            for check in self.checks
            if check.critical
        )

    @property
    def warning_count(self) -> int:
        return sum(
            1
            for check in self.checks
            if check.warning
        )

    @property
    def ok_count(self) -> int:
        return sum(
            1
            for check in self.checks
            if check.ok
        )

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible component result."""

        return {
            "component": self.component,
            "status": self.status,
            "ok_count": self.ok_count,
            "warning_count": (
                self.warning_count
            ),
            "critical_count": (
                self.critical_count
            ),
            "checks": [
                check.to_dict()
                for check in self.checks
            ],
        }


@dataclass(slots=True)
class HealthSummary:
    """Top-level health summary."""

    status: str
    generated_at: str
    checks: int
    ok: int
    warnings: int
    critical: int
    unknown: int

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible summary."""

        return {
            "status": self.status,
            "generated_at": self.generated_at,
            "checks": self.checks,
            "ok": self.ok,
            "warnings": self.warnings,
            "critical": self.critical,
            "unknown": self.unknown,
        }


@dataclass(slots=True)
class HealthReport:
    """Complete ingestion-engine health report."""

    summary: HealthSummary
    components: list[ComponentHealth]
    checks: list[HealthCheck]
    metadata: dict[str, Any] = field(
        default_factory=dict
    )

    @property
    def status(self) -> str:
        return self.summary.status

    @property
    def healthy(self) -> bool:
        return self.status == STATUS_OK

    @property
    def degraded(self) -> bool:
        return self.status == STATUS_WARNING

    @property
    def failed(self) -> bool:
        return self.status == STATUS_CRITICAL

    @property
    def exit_code(self) -> int:
        """
        Return a CI-friendly process exit code.

        0: healthy
        1: warnings
        2: critical
        3: unknown
        """

        if self.status == STATUS_OK:
            return 0

        if self.status == STATUS_WARNING:
            return 1

        if self.status == STATUS_CRITICAL:
            return 2

        return 3

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible health report."""

        return {
            "schema_version": (
                HEALTH_SCHEMA_VERSION
            ),
            "summary": self.summary.to_dict(),
            "components": [
                component.to_dict()
                for component in self.components
            ],
            "checks": [
                check.to_dict()
                for check in self.checks
            ],
            "metadata": dict(
                self.metadata
            ),
            "exit_code": self.exit_code,
        }


def utc_now() -> str:
    """Return the current UTC timestamp."""

    return (
        datetime.now(UTC)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def normalize_space(value: Any) -> str:
    """Collapse surrounding and repeated whitespace."""

    return " ".join(
        str(
            value
            if value is not None
            else ""
        ).strip().split()
    )


def normalize_key(value: Any) -> str:
    """Normalize text for stable comparisons."""

    return normalize_space(
        value
    ).casefold()


def safe_int(
    value: Any,
    default: int = 0,
) -> int:
    """Convert a value to an integer."""

    try:
        return int(value)
    except (
        TypeError,
        ValueError,
    ):
        return int(default)


def safe_float(
    value: Any,
    default: float = 0.0,
) -> float:
    """Convert a value to float."""

    try:
        return float(value)
    except (
        TypeError,
        ValueError,
    ):
        return float(default)


def parse_timestamp(
    value: Any,
) -> datetime | None:
    """Parse an ISO-8601 timestamp into UTC."""

    normalized = normalize_space(
        value
    )

    if not normalized:
        return None

    try:
        parsed = datetime.fromisoformat(
            normalized.replace(
                "Z",
                "+00:00",
            )
        )
    except ValueError:
        return None

    if parsed.tzinfo is None:
        parsed = parsed.replace(
            tzinfo=UTC
        )

    return parsed.astimezone(
        UTC
    )


def atomic_write_json(
    path: Path,
    value: Any,
) -> None:
    """Atomically write formatted UTF-8 JSON."""

    path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    payload = (
        json.dumps(
            value,
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )

    temporary: Path | None = None

    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(
                handle.fileno()
            )
            temporary = Path(
                handle.name
            )

        temporary.replace(path)

    finally:
        if (
            temporary is not None
            and temporary.exists()
        ):
            temporary.unlink(
                missing_ok=True
            )


class HealthManager:
    """
    Run non-destructive health checks across the ingestion stack.
    """

    def __init__(
        self,
        *,
        repo_root: Path,
        data_root: Path,
        archive_root: Path,
        manifest_manager: ManifestManager | None = None,
        index: SQLiteIndex | None = None,
        volume_writer: VolumeWriter | None = None,
        revision_writer: RevisionWriter | None = None,
        scheduler: Scheduler | None = None,
        provider_states_root: Path | None = None,
        minimum_free_bytes: int = (
            DEFAULT_MINIMUM_FREE_BYTES
        ),
        warning_free_bytes: int = (
            DEFAULT_WARNING_FREE_BYTES
        ),
        stale_hours: int = (
            DEFAULT_STALE_HOURS
        ),
        provider_stale_hours: int = (
            DEFAULT_PROVIDER_STALE_HOURS
        ),
        maximum_provider_failures: int = (
            DEFAULT_MAX_PROVIDER_FAILURES
        ),
        github_warning_bytes: int = (
            DEFAULT_GITHUB_WARNING_BYTES
        ),
        github_failure_bytes: int = (
            DEFAULT_GITHUB_FAILURE_BYTES
        ),
    ) -> None:
        self.repo_root = Path(
            repo_root
        )

        self.data_root = Path(
            data_root
        )

        self.archive_root = Path(
            archive_root
        )

        self.manifest_manager = (
            manifest_manager
        )

        self.index = index
        self.volume_writer = (
            volume_writer
        )

        self.revision_writer = (
            revision_writer
        )

        self.scheduler = scheduler

        self.provider_states_root = (
            Path(provider_states_root)
            if provider_states_root is not None
            else (
                self.archive_root
                / "provider-state"
            )
        )

        self.minimum_free_bytes = max(
            0,
            int(minimum_free_bytes),
        )

        self.warning_free_bytes = max(
            self.minimum_free_bytes,
            int(warning_free_bytes),
        )

        self.stale_hours = max(
            1,
            int(stale_hours),
        )

        self.provider_stale_hours = max(
            1,
            int(provider_stale_hours),
        )

        self.maximum_provider_failures = max(
            1,
            int(maximum_provider_failures),
        )

        self.github_warning_bytes = max(
            1,
            int(github_warning_bytes),
        )

        self.github_failure_bytes = max(
            self.github_warning_bytes,
            int(github_failure_bytes),
        )

    def run(
        self,
        *,
        include_sqlite_integrity: bool = True,
        include_json_validation: bool = True,
        include_provider_checks: bool = True,
        include_scheduler_checks: bool = True,
    ) -> HealthReport:
        """Run all configured health checks."""

        checks: list[
            HealthCheck
        ] = []

        checks.extend(
            self.check_paths()
        )

        checks.extend(
            self.check_disk_space()
        )

        if self.manifest_manager is not None:
            checks.extend(
                self.check_manifest()
            )

        if self.index is not None:
            checks.extend(
                self.check_sqlite(
                    include_integrity=(
                        include_sqlite_integrity
                    )
                )
            )

        if self.volume_writer is not None:
            checks.extend(
                self.check_primary_volumes(
                    validate_json=(
                        include_json_validation
                    )
                )
            )

        if self.revision_writer is not None:
            checks.extend(
                self.check_revision_volumes(
                    validate_json=(
                        include_json_validation
                    )
                )
            )

        if include_provider_checks:
            checks.extend(
                self.check_provider_states()
            )

        if (
            include_scheduler_checks
            and self.scheduler is not None
        ):
            checks.extend(
                self.check_scheduler()
            )

        checks.extend(
            self.check_large_files()
        )

        checks.extend(
            self.check_generated_data_freshness()
        )

        return self._build_report(
            checks
        )

    def check_paths(
        self,
    ) -> list[HealthCheck]:
        """Verify required directories and writability."""

        checks: list[
            HealthCheck
        ] = []

        required_paths = (
            (
                "repository root",
                self.repo_root,
                False,
            ),
            (
                "data root",
                self.data_root,
                True,
            ),
            (
                "archive root",
                self.archive_root,
                True,
            ),
            (
                "provider state root",
                self.provider_states_root,
                True,
            ),
        )

        for label, path, writable in (
            required_paths
        ):
            if not path.exists():
                checks.append(
                    HealthCheck(
                        name=(
                            f"path:{label}"
                        ),
                        status=(
                            STATUS_CRITICAL
                            if writable
                            else STATUS_WARNING
                        ),
                        message=(
                            f"{label} does not exist"
                        ),
                        component="filesystem",
                        details={
                            "path": (
                                path.as_posix()
                            ),
                            "required_writable": (
                                writable
                            ),
                        },
                    )
                )
                continue

            if not path.is_dir():
                checks.append(
                    HealthCheck(
                        name=(
                            f"path:{label}"
                        ),
                        status=STATUS_CRITICAL,
                        message=(
                            f"{label} is not a directory"
                        ),
                        component="filesystem",
                        details={
                            "path": (
                                path.as_posix()
                            ),
                        },
                    )
                )
                continue

            if (
                writable
                and not os.access(
                    path,
                    os.W_OK,
                )
            ):
                checks.append(
                    HealthCheck(
                        name=(
                            f"path:{label}"
                        ),
                        status=STATUS_CRITICAL,
                        message=(
                            f"{label} is not writable"
                        ),
                        component="filesystem",
                        details={
                            "path": (
                                path.as_posix()
                            ),
                        },
                    )
                )
                continue

            checks.append(
                HealthCheck(
                    name=f"path:{label}",
                    status=STATUS_OK,
                    message=(
                        f"{label} is available"
                    ),
                    component="filesystem",
                    details={
                        "path": path.as_posix(),
                        "writable": (
                            os.access(
                                path,
                                os.W_OK,
                            )
                        ),
                    },
                )
            )

        return checks

    def check_disk_space(
        self,
    ) -> list[HealthCheck]:
        """Check available disk capacity."""

        try:
            usage = shutil.disk_usage(
                self.archive_root
            )
        except OSError as error:
            return [
                HealthCheck(
                    name="disk-space",
                    status=STATUS_UNKNOWN,
                    message=(
                        "unable to read disk usage"
                    ),
                    component="filesystem",
                    details={
                        "error": str(error),
                    },
                )
            ]

        free = int(
            usage.free
        )

        total = int(
            usage.total
        )

        used = int(
            usage.used
        )

        if free < self.minimum_free_bytes:
            status = STATUS_CRITICAL
            message = (
                "free disk space is below "
                "the critical threshold"
            )

        elif free < self.warning_free_bytes:
            status = STATUS_WARNING
            message = (
                "free disk space is below "
                "the warning threshold"
            )

        else:
            status = STATUS_OK
            message = (
                "disk space is sufficient"
            )

        return [
            HealthCheck(
                name="disk-space",
                status=status,
                message=message,
                component="filesystem",
                details={
                    "total_bytes": total,
                    "used_bytes": used,
                    "free_bytes": free,
                    "minimum_free_bytes": (
                        self.minimum_free_bytes
                    ),
                    "warning_free_bytes": (
                        self.warning_free_bytes
                    ),
                    "used_percent": round(
                        (
                            used / total * 100.0
                            if total > 0
                            else 0.0
                        ),
                        3,
                    ),
                },
            )
        ]

    def check_manifest(
        self,
    ) -> list[HealthCheck]:
        """Check manifest structure and consistency."""

        assert (
            self.manifest_manager
            is not None
        )

        result = (
            self.manifest_manager.verify()
        )

        checks: list[
            HealthCheck
        ] = []

        if result.errors:
            checks.append(
                HealthCheck(
                    name="manifest:integrity",
                    status=STATUS_CRITICAL,
                    message=(
                        "manifest verification failed"
                    ),
                    component="manifest",
                    details={
                        "errors": list(
                            result.errors
                        ),
                        "warnings": list(
                            result.warnings
                        ),
                    },
                )
            )

        elif result.warnings:
            checks.append(
                HealthCheck(
                    name="manifest:integrity",
                    status=STATUS_WARNING,
                    message=(
                        "manifest verification "
                        "completed with warnings"
                    ),
                    component="manifest",
                    details={
                        "warnings": list(
                            result.warnings
                        ),
                    },
                )
            )

        else:
            checks.append(
                HealthCheck(
                    name="manifest:integrity",
                    status=STATUS_OK,
                    message=(
                        "manifest is internally "
                        "consistent"
                    ),
                    component="manifest",
                    details={},
                )
            )

        generated_at = parse_timestamp(
            self.manifest_manager.state.get(
                "generated_at"
            )
        )

        checks.append(
            self._freshness_check(
                name="manifest:freshness",
                component="manifest",
                timestamp=generated_at,
                maximum_age_hours=(
                    self.stale_hours
                ),
                missing_message=(
                    "manifest has no valid "
                    "generated_at timestamp"
                ),
            )
        )

        return checks

    def check_sqlite(
        self,
        *,
        include_integrity: bool = True,
    ) -> list[HealthCheck]:
        """Check SQLite availability and integrity."""

        assert self.index is not None

        checks: list[
            HealthCheck
        ] = []

        try:
            row = (
                self.index.connection.execute(
                    "SELECT 1 AS ok"
                ).fetchone()
            )

            reachable = bool(
                row
                and int(row["ok"]) == 1
            )

        except sqlite3.Error as error:
            checks.append(
                HealthCheck(
                    name="sqlite:connection",
                    status=STATUS_CRITICAL,
                    message=(
                        "SQLite query failed"
                    ),
                    component="sqlite",
                    details={
                        "error": str(error),
                    },
                )
            )

            return checks

        checks.append(
            HealthCheck(
                name="sqlite:connection",
                status=(
                    STATUS_OK
                    if reachable
                    else STATUS_CRITICAL
                ),
                message=(
                    "SQLite connection is responsive"
                    if reachable
                    else "SQLite connection is not responsive"
                ),
                component="sqlite",
                details={
                    "path": (
                        self.index.path.as_posix()
                    ),
                    "read_only": (
                        self.index.read_only
                    ),
                },
            )
        )

        if include_integrity:
            errors = (
                self.index.integrity_check()
            )

            checks.append(
                HealthCheck(
                    name="sqlite:integrity",
                    status=(
                        STATUS_CRITICAL
                        if errors
                        else STATUS_OK
                    ),
                    message=(
                        "SQLite integrity check failed"
                        if errors
                        else "SQLite integrity check passed"
                    ),
                    component="sqlite",
                    details={
                        "errors": errors,
                    },
                )
            )

        try:
            counts = {
                table: (
                    self.index.table_count(
                        table
                    )
                )
                for table in (
                    "taxa",
                    "source_ids",
                    "assertions",
                    "synonyms",
                    "conflicts",
                )
            }

            checks.append(
                HealthCheck(
                    name="sqlite:tables",
                    status=STATUS_OK,
                    message=(
                        "SQLite tables are readable"
                    ),
                    component="sqlite",
                    details=counts,
                )
            )

        except Exception as error:
            checks.append(
                HealthCheck(
                    name="sqlite:tables",
                    status=STATUS_CRITICAL,
                    message=(
                        "one or more SQLite tables "
                        "could not be read"
                    ),
                    component="sqlite",
                    details={
                        "error": str(error),
                    },
                )
            )

        try:
            orphans = (
                self.index.orphan_counts()
            )

            orphan_total = sum(
                int(value)
                for value in orphans.values()
            )

            checks.append(
                HealthCheck(
                    name="sqlite:orphans",
                    status=(
                        STATUS_CRITICAL
                        if orphan_total
                        else STATUS_OK
                    ),
                    message=(
                        "orphaned SQLite rows detected"
                        if orphan_total
                        else "no orphaned SQLite rows detected"
                    ),
                    component="sqlite",
                    details=orphans,
                )
            )

        except Exception as error:
            checks.append(
                HealthCheck(
                    name="sqlite:orphans",
                    status=STATUS_UNKNOWN,
                    message=(
                        "unable to calculate SQLite "
                        "orphan counts"
                    ),
                    component="sqlite",
                    details={
                        "error": str(error),
                    },
                )
            )

        return checks

    def check_primary_volumes(
        self,
        *,
        validate_json: bool = True,
    ) -> list[HealthCheck]:
        """Verify primary archive volumes."""

        assert (
            self.volume_writer
            is not None
        )

        errors = (
            self.volume_writer.verify(
                validate_json=validate_json
            )
        )

        statistics = (
            self.volume_writer
            .volume_statistics()
        )

        checks = [
            HealthCheck(
                name="volumes:integrity",
                status=(
                    STATUS_CRITICAL
                    if errors
                    else STATUS_OK
                ),
                message=(
                    "primary volume verification failed"
                    if errors
                    else "primary volumes are valid"
                ),
                component="volumes",
                details={
                    "errors": errors,
                    **statistics,
                },
            )
        ]

        active = statistics.get(
            "active_volume"
        )

        if active:
            checks.append(
                HealthCheck(
                    name="volumes:active",
                    status=STATUS_OK,
                    message=(
                        "an active primary volume exists"
                    ),
                    component="volumes",
                    details={
                        "active_volume": active,
                    },
                )
            )
        else:
            checks.append(
                HealthCheck(
                    name="volumes:active",
                    status=STATUS_WARNING,
                    message=(
                        "no active primary volume is "
                        "currently configured"
                    ),
                    component="volumes",
                    details={},
                )
            )

        return checks

    def check_revision_volumes(
        self,
        *,
        validate_json: bool = True,
    ) -> list[HealthCheck]:
        """Verify revision-journal volumes."""

        assert (
            self.revision_writer
            is not None
        )

        errors = (
            self.revision_writer.verify(
                validate_json=validate_json
            )
        )

        statistics = (
            self.revision_writer.statistics()
        )

        return [
            HealthCheck(
                name="revisions:integrity",
                status=(
                    STATUS_CRITICAL
                    if errors
                    else STATUS_OK
                ),
                message=(
                    "revision journal verification failed"
                    if errors
                    else "revision journal is valid"
                ),
                component="revisions",
                details={
                    "errors": errors,
                    **statistics,
                },
            )
        ]

    def check_provider_states(
        self,
    ) -> list[HealthCheck]:
        """Check persisted provider-state files."""

        checks: list[
            HealthCheck
        ] = []

        root = (
            self.provider_states_root
        )

        if not root.exists():
            return [
                HealthCheck(
                    name="providers:state-root",
                    status=STATUS_WARNING,
                    message=(
                        "provider state directory "
                        "does not exist"
                    ),
                    component="providers",
                    details={
                        "path": root.as_posix(),
                    },
                )
            ]

        state_files = sorted(
            root.glob("*.json")
        )

        if not state_files:
            return [
                HealthCheck(
                    name="providers:states",
                    status=STATUS_WARNING,
                    message=(
                        "no provider state files exist"
                    ),
                    component="providers",
                    details={
                        "path": root.as_posix(),
                    },
                )
            ]

        failed_providers: list[
            dict[str, Any]
        ] = []

        stale_providers: list[
            dict[str, Any]
        ] = []

        invalid_files: list[
            dict[str, str]
        ] = []

        healthy_count = 0

        for path in state_files:
            try:
                value = json.loads(
                    path.read_text(
                        encoding="utf-8",
                    )
                )
            except (
                OSError,
                json.JSONDecodeError,
            ) as error:
                invalid_files.append(
                    {
                        "file": path.name,
                        "error": str(error),
                    }
                )
                continue

            if not isinstance(
                value,
                Mapping,
            ):
                invalid_files.append(
                    {
                        "file": path.name,
                        "error": (
                            "state root is not "
                            "a JSON object"
                        ),
                    }
                )
                continue

            provider = (
                normalize_key(
                    value.get(
                        "provider",
                        path.stem,
                    )
                )
                or path.stem
            )

            failure_count = safe_int(
                value.get(
                    "failure_count",
                    value.get(
                        "consecutive_failures",
                        0,
                    ),
                )
            )

            last_success = parse_timestamp(
                value.get(
                    "last_success"
                )
            )

            last_failure = parse_timestamp(
                value.get(
                    "last_failure"
                )
            )

            if (
                failure_count
                >= self.maximum_provider_failures
            ):
                failed_providers.append(
                    {
                        "provider": provider,
                        "failure_count": (
                            failure_count
                        ),
                        "last_failure": (
                            value.get(
                                "last_failure"
                            )
                        ),
                        "last_error": (
                            value.get(
                                "last_error"
                            )
                        ),
                    }
                )

            latest_timestamp = max(
                (
                    timestamp
                    for timestamp in (
                        last_success,
                        last_failure,
                    )
                    if timestamp is not None
                ),
                default=None,
            )

            if latest_timestamp is not None:
                age = (
                    datetime.now(UTC)
                    - latest_timestamp
                )

                if age > timedelta(
                    hours=self.provider_stale_hours
                ):
                    stale_providers.append(
                        {
                            "provider": provider,
                            "last_activity": (
                                latest_timestamp
                                .replace(
                                    microsecond=0
                                )
                                .isoformat()
                                .replace(
                                    "+00:00",
                                    "Z",
                                )
                            ),
                            "age_hours": round(
                                (
                                    age.total_seconds()
                                    / 3600.0
                                ),
                                3,
                            ),
                        }
                    )

            if (
                failure_count
                < self.maximum_provider_failures
                and latest_timestamp
                is not None
            ):
                healthy_count += 1

        if invalid_files:
            checks.append(
                HealthCheck(
                    name="providers:state-files",
                    status=STATUS_CRITICAL,
                    message=(
                        "invalid provider state files "
                        "were detected"
                    ),
                    component="providers",
                    details={
                        "invalid_files": (
                            invalid_files
                        ),
                    },
                )
            )
        else:
            checks.append(
                HealthCheck(
                    name="providers:state-files",
                    status=STATUS_OK,
                    message=(
                        "provider state files are valid"
                    ),
                    component="providers",
                    details={
                        "files": len(
                            state_files
                        ),
                    },
                )
            )

        checks.append(
            HealthCheck(
                name="providers:failures",
                status=(
                    STATUS_CRITICAL
                    if failed_providers
                    else STATUS_OK
                ),
                message=(
                    "providers exceeded the failure "
                    "threshold"
                    if failed_providers
                    else "provider failure counts are acceptable"
                ),
                component="providers",
                details={
                    "failed_providers": (
                        failed_providers
                    ),
                    "threshold": (
                        self.maximum_provider_failures
                    ),
                },
            )
        )

        checks.append(
            HealthCheck(
                name="providers:freshness",
                status=(
                    STATUS_WARNING
                    if stale_providers
                    else STATUS_OK
                ),
                message=(
                    "stale provider states detected"
                    if stale_providers
                    else "provider states are recent"
                ),
                component="providers",
                details={
                    "stale_providers": (
                        stale_providers
                    ),
                    "maximum_age_hours": (
                        self.provider_stale_hours
                    ),
                    "healthy_count": (
                        healthy_count
                    ),
                },
            )
        )

        return checks

    def check_scheduler(
        self,
    ) -> list[HealthCheck]:
        """Check scheduler state and provider backoff."""

        assert self.scheduler is not None

        checks: list[
            HealthCheck
        ] = []

        state = self.scheduler.state

        checks.append(
            self._freshness_check(
                name="scheduler:freshness",
                component="scheduler",
                timestamp=parse_timestamp(
                    state.updated_at
                ),
                maximum_age_hours=(
                    self.stale_hours
                ),
                missing_message=(
                    "scheduler has no valid "
                    "updated_at timestamp"
                ),
            )
        )

        extended_backoff: list[
            dict[str, Any]
        ] = []

        failures: list[
            dict[str, Any]
        ] = []

        for provider, provider_state in (
            state.providers.items()
        ):
            if (
                provider_state
                .consecutive_failures
                >= self.maximum_provider_failures
            ):
                failures.append(
                    {
                        "provider": provider,
                        "consecutive_failures": (
                            provider_state
                            .consecutive_failures
                        ),
                        "last_error": (
                            provider_state
                            .last_error
                        ),
                        "next_due": (
                            provider_state
                            .next_due
                        ),
                    }
                )

            next_due = parse_timestamp(
                provider_state.next_due
            )

            if (
                next_due is not None
                and next_due
                > datetime.now(UTC)
                + timedelta(hours=24)
            ):
                extended_backoff.append(
                    {
                        "provider": provider,
                        "next_due": (
                            provider_state
                            .next_due
                        ),
                        "consecutive_failures": (
                            provider_state
                            .consecutive_failures
                        ),
                    }
                )

        checks.append(
            HealthCheck(
                name="scheduler:failures",
                status=(
                    STATUS_CRITICAL
                    if failures
                    else STATUS_OK
                ),
                message=(
                    "scheduler contains unhealthy "
                    "providers"
                    if failures
                    else "scheduler provider health is acceptable"
                ),
                component="scheduler",
                details={
                    "providers": failures,
                },
            )
        )

        checks.append(
            HealthCheck(
                name="scheduler:backoff",
                status=(
                    STATUS_WARNING
                    if extended_backoff
                    else STATUS_OK
                ),
                message=(
                    "providers are in extended backoff"
                    if extended_backoff
                    else "no providers are in extended backoff"
                ),
                component="scheduler",
                details={
                    "providers": (
                        extended_backoff
                    ),
                },
            )
        )

        cursor_valid = (
            state.cursor >= 0
            and (
                state.eligible == 0
                or state.cursor
                < max(
                    state.eligible,
                    1,
                )
            )
        )

        checks.append(
            HealthCheck(
                name="scheduler:cursor",
                status=(
                    STATUS_OK
                    if cursor_valid
                    else STATUS_WARNING
                ),
                message=(
                    "scheduler cursor is valid"
                    if cursor_valid
                    else "scheduler cursor is outside "
                    "the current eligible range"
                ),
                component="scheduler",
                details={
                    "cursor": state.cursor,
                    "eligible": state.eligible,
                    "registered": (
                        state.registered
                    ),
                },
            )
        )

        return checks

    def check_large_files(
        self,
    ) -> list[HealthCheck]:
        """Find files approaching GitHub's repository file-size limit."""

        warning_files: list[
            dict[str, Any]
        ] = []

        critical_files: list[
            dict[str, Any]
        ] = []

        search_roots = {
            self.archive_root,
            self.data_root,
        }

        seen_paths: set[Path] = set()

        for root in search_roots:
            if not root.exists():
                continue

            for path in root.rglob("*"):
                if (
                    not path.is_file()
                    or path in seen_paths
                ):
                    continue

                seen_paths.add(path)

                try:
                    size = (
                        path.stat().st_size
                    )
                except OSError:
                    continue

                entry = {
                    "path": (
                        path.relative_to(
                            self.repo_root
                        ).as_posix()
                        if self._is_relative_to(
                            path,
                            self.repo_root,
                        )
                        else path.as_posix()
                    ),
                    "size_bytes": size,
                }

                if (
                    size
                    >= self.github_failure_bytes
                ):
                    critical_files.append(
                        entry
                    )

                elif (
                    size
                    >= self.github_warning_bytes
                ):
                    warning_files.append(
                        entry
                    )

        if critical_files:
            status = STATUS_CRITICAL
            message = (
                "files exceed the GitHub-safe "
                "failure threshold"
            )

        elif warning_files:
            status = STATUS_WARNING
            message = (
                "files are approaching the "
                "GitHub-safe failure threshold"
            )

        else:
            status = STATUS_OK
            message = (
                "no oversized repository files "
                "were detected"
            )

        return [
            HealthCheck(
                name="filesystem:large-files",
                status=status,
                message=message,
                component="filesystem",
                details={
                    "warning_threshold_bytes": (
                        self.github_warning_bytes
                    ),
                    "failure_threshold_bytes": (
                        self.github_failure_bytes
                    ),
                    "warning_files": (
                        warning_files
                    ),
                    "critical_files": (
                        critical_files
                    ),
                },
            )
        ]

    def check_generated_data_freshness(
        self,
    ) -> list[HealthCheck]:
        """Check public generated statistics files."""

        files = (
            "statistics.json",
            "statistics-sources.json",
            "statistics-history.json",
        )

        checks: list[
            HealthCheck
        ] = []

        for filename in files:
            path = (
                self.data_root
                / filename
            )

            if not path.exists():
                checks.append(
                    HealthCheck(
                        name=(
                            "generated:"
                            + filename
                        ),
                        status=STATUS_WARNING,
                        message=(
                            "generated data file "
                            "does not exist"
                        ),
                        component="generated-data",
                        details={
                            "path": (
                                path.as_posix()
                            ),
                        },
                    )
                )
                continue

            try:
                modified = datetime.fromtimestamp(
                    path.stat().st_mtime,
                    tz=UTC,
                )
            except OSError as error:
                checks.append(
                    HealthCheck(
                        name=(
                            "generated:"
                            + filename
                        ),
                        status=STATUS_UNKNOWN,
                        message=(
                            "unable to read generated "
                            "file metadata"
                        ),
                        component="generated-data",
                        details={
                            "path": (
                                path.as_posix()
                            ),
                            "error": str(error),
                        },
                    )
                )
                continue

            checks.append(
                self._freshness_check(
                    name=(
                        "generated:"
                        + filename
                    ),
                    component="generated-data",
                    timestamp=modified,
                    maximum_age_hours=(
                        self.stale_hours
                    ),
                    missing_message=(
                        "generated file has no "
                        "valid modification time"
                    ),
                    details={
                        "path": (
                            path.as_posix()
                        ),
                    },
                )
            )

        return checks

    def write_report(
        self,
        path: Path,
        *,
        include_sqlite_integrity: bool = True,
        include_json_validation: bool = True,
        include_provider_checks: bool = True,
        include_scheduler_checks: bool = True,
    ) -> HealthReport:
        """Run health checks and write the resulting JSON report."""

        report = self.run(
            include_sqlite_integrity=(
                include_sqlite_integrity
            ),
            include_json_validation=(
                include_json_validation
            ),
            include_provider_checks=(
                include_provider_checks
            ),
            include_scheduler_checks=(
                include_scheduler_checks
            ),
        )

        atomic_write_json(
            Path(path),
            report.to_dict(),
        )

        return report

    def _build_report(
        self,
        checks: Sequence[HealthCheck],
    ) -> HealthReport:
        """Build component and summary aggregates."""

        normalized_checks = [
            self._normalize_check(check)
            for check in checks
        ]

        grouped: dict[
            str,
            list[HealthCheck],
        ] = {}

        for check in normalized_checks:
            grouped.setdefault(
                check.component,
                [],
            ).append(check)

        components = [
            ComponentHealth(
                component=component,
                status=self._aggregate_status(
                    component_checks
                ),
                checks=component_checks,
            )
            for component, component_checks
            in sorted(grouped.items())
        ]

        status_counts = {
            STATUS_OK: 0,
            STATUS_WARNING: 0,
            STATUS_CRITICAL: 0,
            STATUS_UNKNOWN: 0,
        }

        for check in normalized_checks:
            status_counts[
                check.status
            ] += 1

        overall_status = (
            self._aggregate_status(
                normalized_checks
            )
        )

        summary = HealthSummary(
            status=overall_status,
            generated_at=utc_now(),
            checks=len(
                normalized_checks
            ),
            ok=status_counts[
                STATUS_OK
            ],
            warnings=status_counts[
                STATUS_WARNING
            ],
            critical=status_counts[
                STATUS_CRITICAL
            ],
            unknown=status_counts[
                STATUS_UNKNOWN
            ],
        )

        metadata = {
            "repo_root": (
                self.repo_root.as_posix()
            ),
            "data_root": (
                self.data_root.as_posix()
            ),
            "archive_root": (
                self.archive_root.as_posix()
            ),
            "thresholds": {
                "minimum_free_bytes": (
                    self.minimum_free_bytes
                ),
                "warning_free_bytes": (
                    self.warning_free_bytes
                ),
                "stale_hours": (
                    self.stale_hours
                ),
                "provider_stale_hours": (
                    self.provider_stale_hours
                ),
                "maximum_provider_failures": (
                    self.maximum_provider_failures
                ),
                "github_warning_bytes": (
                    self.github_warning_bytes
                ),
                "github_failure_bytes": (
                    self.github_failure_bytes
                ),
            },
        }

        return HealthReport(
            summary=summary,
            components=components,
            checks=normalized_checks,
            metadata=metadata,
        )

    @staticmethod
    def _normalize_check(
        check: HealthCheck,
    ) -> HealthCheck:
        """Normalize one health result."""

        status = normalize_key(
            check.status
        )

        if status not in VALID_STATUSES:
            status = STATUS_UNKNOWN

        return HealthCheck(
            name=normalize_space(
                check.name
            )
            or "unnamed-check",
            status=status,
            message=normalize_space(
                check.message
            ),
            component=(
                normalize_key(
                    check.component
                )
                or "system"
            ),
            details=dict(
                check.details
            ),
            duration_seconds=max(
                0.0,
                safe_float(
                    check.duration_seconds
                ),
            ),
        )

    @staticmethod
    def _aggregate_status(
        checks: Sequence[HealthCheck],
    ) -> str:
        """Return the worst status in a collection."""

        statuses = {
            check.status
            for check in checks
        }

        if STATUS_CRITICAL in statuses:
            return STATUS_CRITICAL

        if STATUS_WARNING in statuses:
            return STATUS_WARNING

        if STATUS_UNKNOWN in statuses:
            return STATUS_UNKNOWN

        if STATUS_OK in statuses:
            return STATUS_OK

        return STATUS_UNKNOWN

    @staticmethod
    def _freshness_check(
        *,
        name: str,
        component: str,
        timestamp: datetime | None,
        maximum_age_hours: int,
        missing_message: str,
        details: Mapping[str, Any] | None = None,
    ) -> HealthCheck:
        """Build a standard timestamp-freshness check."""

        result_details = dict(
            details or {}
        )

        result_details[
            "maximum_age_hours"
        ] = maximum_age_hours

        if timestamp is None:
            return HealthCheck(
                name=name,
                status=STATUS_WARNING,
                message=missing_message,
                component=component,
                details=result_details,
            )

        current = datetime.now(UTC)

        age = current - timestamp

        age_hours = (
            age.total_seconds()
            / 3600.0
        )

        result_details[
            "timestamp"
        ] = (
            timestamp
            .replace(microsecond=0)
            .isoformat()
            .replace("+00:00", "Z")
        )

        result_details[
            "age_hours"
        ] = round(
            age_hours,
            3,
        )

        if age_hours > maximum_age_hours:
            return HealthCheck(
                name=name,
                status=STATUS_WARNING,
                message=(
                    "timestamp is older than the "
                    "configured freshness threshold"
                ),
                component=component,
                details=result_details,
            )

        return HealthCheck(
            name=name,
            status=STATUS_OK,
            message=(
                "timestamp is within the configured "
                "freshness threshold"
            ),
            component=component,
            details=result_details,
        )

    @staticmethod
    def _is_relative_to(
        path: Path,
        parent: Path,
    ) -> bool:
        """Return whether path is located below parent."""

        try:
            path.relative_to(
                parent
            )
        except ValueError:
            return False

        return True


def run_health_checks(
    *,
    repo_root: Path,
    data_root: Path,
    archive_root: Path,
    manifest_manager: ManifestManager | None = None,
    index: SQLiteIndex | None = None,
    volume_writer: VolumeWriter | None = None,
    revision_writer: RevisionWriter | None = None,
    scheduler: Scheduler | None = None,
    provider_states_root: Path | None = None,
    output_path: Path | None = None,
    include_sqlite_integrity: bool = True,
    include_json_validation: bool = True,
) -> HealthReport:
    """Convenience wrapper for CLI and workflow use."""

    manager = HealthManager(
        repo_root=repo_root,
        data_root=data_root,
        archive_root=archive_root,
        manifest_manager=(
            manifest_manager
        ),
        index=index,
        volume_writer=volume_writer,
        revision_writer=(
            revision_writer
        ),
        scheduler=scheduler,
        provider_states_root=(
            provider_states_root
        ),
    )

    report = manager.run(
        include_sqlite_integrity=(
            include_sqlite_integrity
        ),
        include_json_validation=(
            include_json_validation
        ),
    )

    if output_path is not None:
        atomic_write_json(
            Path(output_path),
            report.to_dict(),
        )

    return report
