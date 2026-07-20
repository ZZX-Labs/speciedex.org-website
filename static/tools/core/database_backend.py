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

from contextlib import AbstractContextManager
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Protocol, Sequence, runtime_checkable

from providers.common import Taxon


class DatabaseBackendError(RuntimeError):
    """Base exception for backend-contract and backend-selection failures."""


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


def assert_backend_contract(
    backend: Any,
) -> DatabaseBackend:
    """
    Validate that an object satisfies the runtime backend protocol.

    ``runtime_checkable`` verifies the required attribute names. This helper
    also verifies callability for the complete method surface and returns the
    original object with a narrowed static type.
    """

    if not isinstance(backend, DatabaseBackend):
        raise DatabaseBackendError(
            f"{type(backend).__name__} does not satisfy DatabaseBackend."
        )

    required_methods = (
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

    missing = [
        name
        for name in required_methods
        if not callable(getattr(backend, name, None))
    ]

    if missing:
        raise DatabaseBackendError(
            "Database backend is missing required methods: "
            + ", ".join(missing)
        )

    return backend


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

    return Path(value)
