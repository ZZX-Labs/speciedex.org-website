#!/usr/bin/env python3
"""
Speciedex.org
static/tools/core/database_backend.py

Shared database-backend protocol for the Speciedex archive.

This module defines the structural interface implemented by:

- core.sqlite_index.SQLiteIndex
- core.mariadb_index.MariaDBIndex

The append-only JSONL archive remains the canonical durable record store.
Database backends are rebuildable indexes used for reconciliation, lookup,
statistics, health checks, and administrative maintenance.

The protocol is intentionally runtime-checkable and dependency-free. It allows
DatabaseManager, Archive, tests, and type checkers to verify backend parity
without introducing an inheritance requirement.

Copyright (c) 2026 ZZX-Laboratories
Licensed under the MIT License.
"""

from __future__ import annotations

import inspect
from contextlib import AbstractContextManager
from dataclasses import dataclass, field
from pathlib import Path
from typing import (
    Any,
    Iterable,
    Iterator,
    Mapping,
    Protocol,
    Sequence,
    runtime_checkable,
)

from providers.common import Taxon


DATABASE_BACKEND_SCHEMA_VERSION = 1

BACKEND_KIND_SQLITE = "sqlite"
BACKEND_KIND_MARIADB = "mariadb"
BACKEND_KIND_UNKNOWN = "unknown"

REQUIRED_BACKEND_ATTRIBUTES = (
    "read_only",
    "connection",
    "database",
)

REQUIRED_BACKEND_METHODS = (
    "transaction",
    "commit",
    "rollback",
    "checkpoint",
    "close",
    "set_metadata",
    "metadata",
    "insert_taxon",
    "update_taxon_timestamp",
    "taxon",
    "source_match",
    "identity_candidates",
    "name_candidates",
    "synonym_candidates",
    "attach_assertion",
    "assertion",
    "assertions_for_taxon",
    "replace_synonyms",
    "add_conflict",
    "conflict",
    "iter_conflicts",
    "table_count",
    "rank_counts",
    "status_counts",
    "kingdom_counts",
    "provider_statistics",
    "latest_provider_assertions",
    "orphan_counts",
    "integrity_check",
    "verify",
    "vacuum",
    "analyze",
    "optimize",
    "clear",
    "rebuild_from_records",
    "describe",
)

MUTATING_BACKEND_METHODS = (
    "commit",
    "rollback",
    "checkpoint",
    "set_metadata",
    "insert_taxon",
    "update_taxon_timestamp",
    "attach_assertion",
    "replace_synonyms",
    "add_conflict",
    "vacuum",
    "analyze",
    "optimize",
    "clear",
    "rebuild_from_records",
)


class DatabaseBackendError(RuntimeError):
    """Base exception for backend-contract and backend-selection failures."""


class DatabaseBackendContractError(DatabaseBackendError):
    """Raised when a backend does not satisfy the shared contract."""


class DatabaseBackendReadOnlyError(DatabaseBackendError):
    """Raised when a mutating operation is requested on a read-only backend."""


@dataclass(slots=True, frozen=True)
class BackendCapabilityReport:
    """Structured backend capability and contract report."""

    backend_type: str
    backend_kind: str
    valid: bool
    read_only: bool
    missing_attributes: tuple[str, ...] = ()
    missing_methods: tuple[str, ...] = ()
    noncallable_methods: tuple[str, ...] = ()
    signature_warnings: tuple[str, ...] = ()
    diagnostics: Mapping[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible capability report."""

        return {
            "schema_version": DATABASE_BACKEND_SCHEMA_VERSION,
            "backend_type": self.backend_type,
            "backend_kind": self.backend_kind,
            "valid": self.valid,
            "read_only": self.read_only,
            "missing_attributes": list(self.missing_attributes),
            "missing_methods": list(self.missing_methods),
            "noncallable_methods": list(self.noncallable_methods),
            "signature_warnings": list(self.signature_warnings),
            "diagnostics": dict(self.diagnostics),
        }


@runtime_checkable
class DatabaseBackend(Protocol):
    """
    Structural interface shared by all Speciedex database indexes.

    Implementations may use different database drivers and row types, but must
    preserve these method names, argument names, return shapes, and behavioral
    expectations.
    """

    read_only: bool
    connection: Any

    @property
    def database(self) -> Any:
        """Return the underlying DB-API-compatible connection."""

    def __enter__(self) -> "DatabaseBackend":
        """Return the open backend."""

    def __exit__(
        self,
        exc_type: Any,
        exc_value: Any,
        traceback: Any,
    ) -> None:
        """Close the backend."""

    def transaction(self) -> AbstractContextManager[Any]:
        """Return a transaction context manager."""

    def commit(self) -> None:
        """Commit pending changes."""

    def rollback(self) -> None:
        """Rollback pending changes."""

    def checkpoint(
        self,
        *,
        truncate: bool = False,
    ) -> None:
        """Checkpoint or flush backend-specific write-ahead state."""

    def close(self) -> None:
        """Close the backend."""

    def set_metadata(
        self,
        key: str,
        value: Any,
        *,
        commit: bool = True,
    ) -> None:
        """Create or update one archive metadata value."""

    def metadata(
        self,
        key: str,
        default: Any = None,
    ) -> Any:
        """Read one archive metadata value."""

    def insert_taxon(
        self,
        *,
        identifier: str,
        identity_key: str,
        record: Taxon,
        primary_json: str,
        record_hash: str,
        volume_file: str,
        line_number: int,
        created_at: str,
        updated_at: str | None = None,
        commit: bool = True,
    ) -> None:
        """Insert one canonical taxon."""

    def update_taxon_timestamp(
        self,
        identifier: str,
        timestamp: str | None = None,
        *,
        commit: bool = True,
    ) -> None:
        """Update one canonical taxon's modification timestamp."""

    def taxon(
        self,
        identifier: str,
    ) -> Mapping[str, Any] | None:
        """Return one canonical taxon row."""

    def source_match(
        self,
        provider: str,
        provider_id: str,
    ) -> str | None:
        """Resolve one provider/source identifier to a canonical taxon."""

    def identity_candidates(
        self,
        identity_key: str,
    ) -> list[Mapping[str, Any]]:
        """Return exact identity-key candidates."""

    def name_candidates(
        self,
        record: Taxon,
    ) -> list[Mapping[str, Any]]:
        """Return normalized name/rank/kingdom candidates."""

    def synonym_candidates(
        self,
        synonym: str,
    ) -> list[str]:
        """Return canonical taxon identifiers for one synonym."""

    def attach_assertion(
        self,
        *,
        identifier: str,
        record: Taxon,
        assertion_json: str,
        assertion_hash: str,
        timestamp: str | None = None,
        commit: bool = True,
    ) -> bool:
        """
        Create or update one provider assertion.

        Return True when an existing assertion changed.
        """

    def assertion(
        self,
        provider: str,
        provider_id: str,
    ) -> Mapping[str, Any] | None:
        """Return one provider assertion."""

    def assertions_for_taxon(
        self,
        identifier: str,
    ) -> list[Mapping[str, Any]]:
        """Return every provider assertion attached to one taxon."""

    def replace_synonyms(
        self,
        *,
        identifier: str,
        provider: str,
        synonyms: Iterable[str],
        commit: bool = True,
    ) -> None:
        """Replace one provider's synonyms for one taxon."""

    def add_conflict(
        self,
        *,
        conflict_id: str,
        conflict_json: str,
        created_at: str,
        commit: bool = True,
    ) -> bool:
        """Insert one unresolved conflict and return whether it was new."""

    def conflict(
        self,
        conflict_id: str,
    ) -> Mapping[str, Any] | None:
        """Return one indexed conflict."""

    def iter_conflicts(
        self,
    ) -> Iterator[Mapping[str, Any]]:
        """Iterate conflicts in deterministic order."""

    def table_count(
        self,
        table: str,
    ) -> int:
        """Return a row count from one trusted internal table."""

    def rank_counts(
        self,
        *,
        statuses: Sequence[str] | None = None,
    ) -> dict[str, int]:
        """Return canonical taxon counts grouped by rank."""

    def status_counts(self) -> dict[str, int]:
        """Return canonical taxon counts grouped by status."""

    def kingdom_counts(
        self,
        *,
        statuses: Sequence[str] | None = None,
    ) -> dict[str, int]:
        """Return canonical taxon counts grouped by kingdom."""

    def provider_statistics(
        self,
    ) -> dict[str, dict[str, int]]:
        """Return provider-specific assertion and index totals."""

    def latest_provider_assertions(
        self,
    ) -> dict[str, str]:
        """Return the latest assertion timestamp for each provider."""

    def orphan_counts(self) -> dict[str, int]:
        """Return counts of rows referencing missing canonical taxa."""

    def integrity_check(self) -> list[str]:
        """Return physical or server-level integrity errors."""

    def verify(self) -> list[str]:
        """Return complete backend verification errors."""

    def vacuum(self) -> None:
        """Run the backend's heavyweight compaction operation."""

    def analyze(self) -> None:
        """Refresh query-planner statistics."""

    def optimize(self) -> None:
        """Run lightweight backend optimization."""

    def clear(self) -> None:
        """Delete all rebuildable index data while retaining metadata."""

    def rebuild_from_records(
        self,
        records: Iterable[Mapping[str, Any]],
    ) -> int:
        """Rebuild canonical taxon rows from archive records."""

    def describe(self) -> dict[str, Any]:
        """Return non-secret backend diagnostic metadata."""


def backend_kind(
    backend: Any,
) -> str:
    """Return a normalized backend kind without importing concrete classes."""

    explicit = str(
        getattr(
            backend,
            "backend_kind",
            "",
        )
        or ""
    ).strip().casefold()

    if explicit in {
        BACKEND_KIND_SQLITE,
        BACKEND_KIND_MARIADB,
    }:
        return explicit

    type_name = type(backend).__name__.casefold()
    module_name = type(backend).__module__.casefold()

    if "sqlite" in type_name or "sqlite" in module_name:
        return BACKEND_KIND_SQLITE

    if (
        "mariadb" in type_name
        or "mariadb" in module_name
        or "mysql" in type_name
        or "mysql" in module_name
    ):
        return BACKEND_KIND_MARIADB

    return BACKEND_KIND_UNKNOWN


def backend_path(
    backend: DatabaseBackend,
) -> Path | None:
    """
    Return a backend-local filesystem path when one exists.

    SQLite exposes ``path``. Server backends such as MariaDB return None.
    """

    value = getattr(backend, "path", None)

    if value is None:
        return None

    try:
        return Path(value)
    except TypeError:
        return None


def backend_is_open(
    backend: Any,
) -> bool:
    """Return whether a backend appears open and usable."""

    connection = getattr(
        backend,
        "connection",
        None,
    )

    if connection is None:
        return False

    closed = getattr(
        backend,
        "closed",
        None,
    )

    if isinstance(closed, bool):
        return not closed

    connection_closed = getattr(
        connection,
        "closed",
        None,
    )

    if isinstance(connection_closed, bool):
        return not connection_closed

    return True


def backend_is_read_only(
    backend: Any,
) -> bool:
    """Return the normalized backend read-only state."""

    return bool(
        getattr(
            backend,
            "read_only",
            False,
        )
    )


def require_writable_backend(
    backend: Any,
    *,
    operation: str = "database mutation",
) -> DatabaseBackend:
    """Validate the backend contract and reject read-only operation targets."""

    validated = assert_backend_contract(
        backend
    )

    if backend_is_read_only(validated):
        raise DatabaseBackendReadOnlyError(
            f"Cannot perform {operation}: "
            "database backend is read-only."
        )

    return validated


def backend_capability_report(
    backend: Any,
    *,
    inspect_signatures: bool = True,
) -> BackendCapabilityReport:
    """Inspect backend attributes, callability, signatures, and diagnostics."""

    missing_attributes: list[str] = []
    missing_methods: list[str] = []
    noncallable_methods: list[str] = []
    signature_warnings: list[str] = []

    for name in REQUIRED_BACKEND_ATTRIBUTES:
        try:
            inspect.getattr_static(
                backend,
                name,
            )
        except AttributeError:
            missing_attributes.append(
                name
            )

    for name in REQUIRED_BACKEND_METHODS:
        try:
            value = getattr(
                backend,
                name,
            )
        except Exception:
            missing_methods.append(
                name
            )
            continue

        if not callable(value):
            noncallable_methods.append(
                name
            )
            continue

        if inspect_signatures:
            try:
                inspect.signature(value)
            except (
                TypeError,
                ValueError,
            ):
                signature_warnings.append(
                    f"Unable to inspect signature: {name}."
                )

    diagnostics: dict[str, Any] = {}

    describe = getattr(
        backend,
        "describe",
        None,
    )

    if callable(describe):
        try:
            value = describe()

            if isinstance(value, Mapping):
                diagnostics = dict(value)

        except Exception as error:
            signature_warnings.append(
                "Backend describe() failed: "
                f"{error}"
            )

    valid = not (
        missing_attributes
        or missing_methods
        or noncallable_methods
    )

    return BackendCapabilityReport(
        backend_type=(
            f"{type(backend).__module__}."
            f"{type(backend).__qualname__}"
        ),
        backend_kind=backend_kind(
            backend
        ),
        valid=valid,
        read_only=backend_is_read_only(
            backend
        ),
        missing_attributes=tuple(
            sorted(
                missing_attributes
            )
        ),
        missing_methods=tuple(
            sorted(
                missing_methods
            )
        ),
        noncallable_methods=tuple(
            sorted(
                noncallable_methods
            )
        ),
        signature_warnings=tuple(
            sorted(
                signature_warnings
            )
        ),
        diagnostics=diagnostics,
    )


def assert_backend_contract(
    backend: Any,
) -> DatabaseBackend:
    """
    Validate that an object satisfies the runtime backend protocol.

    Runtime-checkable protocols only verify attribute presence. This helper
    performs an explicit structural audit so failures identify every missing
    or non-callable member instead of stopping at a generic isinstance result.
    """

    report = backend_capability_report(
        backend,
        inspect_signatures=False,
    )

    if not report.valid:
        details: list[str] = []

        if report.missing_attributes:
            details.append(
                "missing attributes: "
                + ", ".join(
                    report.missing_attributes
                )
            )

        if report.missing_methods:
            details.append(
                "missing methods: "
                + ", ".join(
                    report.missing_methods
                )
            )

        if report.noncallable_methods:
            details.append(
                "non-callable methods: "
                + ", ".join(
                    report.noncallable_methods
                )
            )

        raise DatabaseBackendContractError(
            f"{type(backend).__name__} does not satisfy "
            "DatabaseBackend ("
            + "; ".join(details)
            + ")."
        )

    return backend


def assert_backend_parity(
    backends: Iterable[Any],
) -> tuple[DatabaseBackend, ...]:
    """
    Validate multiple backends and return them as a typed immutable sequence.

    This is useful in tests and DatabaseManager initialization when SQLite and
    MariaDB must expose the same contract surface.
    """

    validated: list[DatabaseBackend] = []

    for backend in backends:
        validated.append(
            assert_backend_contract(
                backend
            )
        )

    if not validated:
        raise DatabaseBackendError(
            "At least one database backend is required."
        )

    return tuple(validated)


def backend_supports(
    backend: Any,
    capability: str,
) -> bool:
    """Return whether a backend exposes one callable capability."""

    name = str(
        capability
        if capability is not None
        else ""
    ).strip()

    if not name:
        return False

    return callable(
        getattr(
            backend,
            name,
            None,
        )
    )


def backend_diagnostics(
    backend: Any,
) -> dict[str, Any]:
    """Return normalized non-secret backend diagnostic metadata."""

    report = backend_capability_report(
        backend
    )

    path = backend_path(
        backend
    )

    return {
        **report.to_dict(),
        "path": (
            path.as_posix()
            if path is not None
            else None
        ),
        "open": backend_is_open(
            backend
        ),
        "supports_transactions": (
            backend_supports(
                backend,
                "transaction",
            )
        ),
        "supports_checkpoint": (
            backend_supports(
                backend,
                "checkpoint",
            )
        ),
        "supports_vacuum": (
            backend_supports(
                backend,
                "vacuum",
            )
        ),
        "supports_optimize": (
            backend_supports(
                backend,
                "optimize",
            )
        ),
    }


__all__ = [
    "BACKEND_KIND_MARIADB",
    "BACKEND_KIND_SQLITE",
    "BACKEND_KIND_UNKNOWN",
    "DATABASE_BACKEND_SCHEMA_VERSION",
    "MUTATING_BACKEND_METHODS",
    "REQUIRED_BACKEND_ATTRIBUTES",
    "REQUIRED_BACKEND_METHODS",
    "BackendCapabilityReport",
    "DatabaseBackend",
    "DatabaseBackendContractError",
    "DatabaseBackendError",
    "DatabaseBackendReadOnlyError",
    "assert_backend_contract",
    "assert_backend_parity",
    "backend_capability_report",
    "backend_diagnostics",
    "backend_is_open",
    "backend_is_read_only",
    "backend_kind",
    "backend_path",
    "backend_supports",
    "require_writable_backend",
]
