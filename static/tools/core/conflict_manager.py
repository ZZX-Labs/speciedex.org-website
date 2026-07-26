#!/usr/bin/env python3
"""
Speciedex.org
static/tools/core/conflict_manager.py

Unresolved reconciliation conflict manager.

This module owns:

- deterministic conflict identifiers,
- conflict normalization,
- append-only JSONL conflict journals,
- SQLite conflict indexing,
- duplicate suppression,
- conflict status transitions,
- conflict resolution records,
- conflict statistics,
- conflict iteration,
- manifest metadata,
- verification and rebuild support.

The ConflictManager does not decide whether two taxa conflict. The reconciler
returns a conflict decision, and the archive passes that decision here for
durable storage.

Copyright (c) 2026 ZZX-Laboratories

Licensed under the MIT License.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import tempfile
import threading
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping

from providers.common import Taxon

from .archive import normalize_key, normalize_space, now
from .sqlite_index import SQLiteIndex


CONFLICT_SCHEMA_VERSION = 1

DEFAULT_UNRESOLVED_FILE = "unresolved.jsonl"
DEFAULT_RESOLVED_FILE = "resolved.jsonl"
DEFAULT_REJECTED_FILE = "rejected.jsonl"


class ConflictManagerError(RuntimeError):
    """Raised when a conflict operation cannot complete safely."""


@dataclass(slots=True)
class ConflictRecord:
    """Normalized unresolved taxonomic conflict."""

    conflict_id: str
    provider: str
    provider_id: str
    scientific_name: str
    canonical_name: str
    rank: str
    kingdom: str
    candidates: list[str]
    reason: str
    created_at: str
    status: str = "unresolved"
    score: float | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible conflict record."""

        return {
            "schema_version": (
                CONFLICT_SCHEMA_VERSION
            ),
            "conflict_id": self.conflict_id,
            "provider": self.provider,
            "provider_id": self.provider_id,
            "scientific_name": (
                self.scientific_name
            ),
            "canonical_name": (
                self.canonical_name
            ),
            "rank": self.rank,
            "kingdom": self.kingdom,
            "candidates": list(
                self.candidates
            ),
            "reason": self.reason,
            "created_at": self.created_at,
            "status": self.status,
            "score": self.score,
            "metadata": dict(
                self.metadata
            ),
        }


@dataclass(slots=True)
class ConflictResolution:
    """Resolution event for a previously unresolved conflict."""

    conflict_id: str
    action: str
    resolved_at: str
    resolved_by: str
    selected_speciedex_id: str | None = None
    notes: str = ""
    replacement_conflict_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible resolution event."""

        return {
            "schema_version": (
                CONFLICT_SCHEMA_VERSION
            ),
            "event": "conflict_resolved",
            "conflict_id": self.conflict_id,
            "action": self.action,
            "resolved_at": self.resolved_at,
            "resolved_by": self.resolved_by,
            "selected_speciedex_id": (
                self.selected_speciedex_id
            ),
            "notes": self.notes,
            "replacement_conflict_id": (
                self.replacement_conflict_id
            ),
        }


@dataclass(slots=True)
class ConflictStatistics:
    """Aggregate conflict statistics."""

    unresolved: int
    resolved: int
    rejected: int
    by_provider: dict[str, int]
    by_reason: dict[str, int]
    by_rank: dict[str, int]

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible statistics object."""

        return {
            "unresolved": self.unresolved,
            "resolved": self.resolved,
            "rejected": self.rejected,
            "by_provider": dict(
                self.by_provider
            ),
            "by_reason": dict(
                self.by_reason
            ),
            "by_rank": dict(
                self.by_rank
            ),
        }


def utc_now() -> str:
    """Return the current UTC timestamp."""

    return (
        datetime.now(UTC)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def stable_json_hash(
    value: Any,
) -> str:
    """Return a deterministic SHA-256 hash of JSON-compatible data."""

    return hashlib.sha256(
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()


def append_jsonl(
    path: Path,
    values: Iterable[
        Mapping[str, Any]
    ],
    *,
    fsync_write: bool = True,
) -> int:
    """Append mapping objects to a UTF-8 JSONL file."""

    path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    count = 0

    with path.open(
        "a",
        encoding="utf-8",
        newline="\n",
    ) as handle:
        for value in values:
            handle.write(
                json.dumps(
                    dict(value),
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
            )
            handle.write("\n")
            count += 1

        handle.flush()

        if fsync_write:
            os.fsync(
                handle.fileno()
            )

    return count


def atomic_write_json(
    path: Path,
    value: Any,
) -> None:
    """Atomically write formatted JSON."""

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


class ConflictManager:
    """
    Durable unresolved-conflict manager.

    Conflict identities are deterministic and exclude timestamps. Repeated
    attempts to store the same logical conflict therefore do not create
    duplicate SQLite rows or duplicate unresolved JSONL events.
    """

    VALID_RESOLUTION_ACTIONS = {
        "match",
        "create",
        "reject",
        "merge",
        "supersede",
        "dismiss",
    }

    def __init__(
        self,
        *,
        root: Path,
        index: SQLiteIndex,
        manifest: dict[str, Any] | None = None,
        manifest_path: Path | None = None,
        fsync_writes: bool = True,
        persist_manifest: bool = True,
        read_only: bool | None = None,
    ) -> None:
        self.root = Path(root)
        self.conflicts_root = (
            self.root
            / "conflicts"
        )

        self.index = index

        self.manifest = (
            manifest
            if manifest is not None
            else {}
        )

        self.manifest_path = (
            Path(manifest_path)
            if manifest_path is not None
            else self.root
            / "manifest.json"
        )

        self.fsync_writes = bool(
            fsync_writes
        )

        self.persist_manifest = bool(
            persist_manifest
        )

        self.read_only = (
            bool(read_only)
            if read_only is not None
            else bool(
                getattr(
                    self.index,
                    "read_only",
                    False,
                )
            )
        )

        self._closed = False
        self._lock = threading.RLock()

        self.unresolved_path = (
            self.conflicts_root
            / DEFAULT_UNRESOLVED_FILE
        )

        self.resolved_path = (
            self.conflicts_root
            / DEFAULT_RESOLVED_FILE
        )

        self.rejected_path = (
            self.conflicts_root
            / DEFAULT_REJECTED_FILE
        )

        if not self.read_only:
            self.conflicts_root.mkdir(
                parents=True,
                exist_ok=True,
            )

        self._repair_manifest_defaults()

    def __enter__(
        self,
    ) -> "ConflictManager":
        """Return this manager for context-manager use."""

        self._ensure_open()
        return self

    def __exit__(
        self,
        exc_type: Any,
        exc_value: Any,
        traceback: Any,
    ) -> None:
        self.close()

    def close(self) -> None:
        """Mark this manager closed without closing its shared index."""

        with self._lock:
            self._closed = True

    def _ensure_open(self) -> None:
        """Reject operations after this manager has been closed."""

        if self._closed:
            raise ConflictManagerError(
                "ConflictManager is closed."
            )

    def _ensure_writable(self) -> None:
        """Reject journal or index mutations in read-only mode."""

        self._ensure_open()

        if self.read_only:
            raise ConflictManagerError(
                "ConflictManager is read-only."
            )

    @property
    def state(self) -> dict[str, Any]:
        """Return conflict metadata stored in the archive manifest."""

        value = self.manifest.get(
            "conflict_journal"
        )

        if not isinstance(
            value,
            dict,
        ):
            value = {}
            self.manifest[
                "conflict_journal"
            ] = value

        return value

    def _repair_manifest_defaults(
        self,
    ) -> None:
        """Add conflict-journal defaults."""

        state = self.state

        defaults = {
            "schema_version": (
                CONFLICT_SCHEMA_VERSION
            ),
            "generated_at": utc_now(),
            "unresolved_file": (
                "conflicts/"
                + DEFAULT_UNRESOLVED_FILE
            ),
            "resolved_file": (
                "conflicts/"
                + DEFAULT_RESOLVED_FILE
            ),
            "rejected_file": (
                "conflicts/"
                + DEFAULT_REJECTED_FILE
            ),
            "total_unresolved_events": 0,
            "total_resolved_events": 0,
            "total_rejected_events": 0,
        }

        for key, value in defaults.items():
            if key not in state:
                state[key] = value

        state[
            "schema_version"
        ] = CONFLICT_SCHEMA_VERSION

        self.manifest.setdefault(
            "total_conflicts",
            self.index.table_count(
                "conflicts"
            ),
        )

    def save_manifest(self) -> None:
        """Persist conflict metadata."""

        self._ensure_writable()
        timestamp = utc_now()

        self.state[
            "generated_at"
        ] = timestamp

        self.manifest[
            "generated_at"
        ] = timestamp

        self.manifest[
            "total_conflicts"
        ] = self.index.table_count(
            "conflicts"
        )

        if self.persist_manifest:
            atomic_write_json(
                self.manifest_path,
                self.manifest,
            )

    def add(
        self,
        record: Taxon,
        candidates: Iterable[str],
        reason: str,
        *,
        score: float | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> tuple[str, bool]:
        """
        Store one unresolved conflict.

        Returns:

            conflict_id, inserted
        """

        self._ensure_writable()

        candidate_ids = sorted(
            {
                normalize_space(
                    candidate
                )
                for candidate in candidates
                if normalize_space(
                    candidate
                )
            }
        )

        normalized_reason = (
            normalize_space(reason)
            or "unspecified reconciliation conflict"
        )

        stable_payload = {
            "provider": normalize_key(
                record.provider
            ),
            "provider_id": normalize_space(
                record.provider_id
            ),
            "canonical_name": normalize_key(
                record.canonical_name
            ),
            "rank": normalize_key(
                record.rank
            ),
            "kingdom": normalize_key(
                record.kingdom
            ),
            "candidates": candidate_ids,
            "reason": normalized_reason,
        }

        conflict_id = (
            "spx-conflict:sha256:"
            + stable_json_hash(
                stable_payload
            )
        )

        normalized_score: float | None = None

        if score is not None:
            normalized_score = float(score)

            if not math.isfinite(normalized_score):
                raise ValueError(
                    "Conflict score must be finite."
                )

        normalized_metadata = dict(
            metadata or {}
        )

        try:
            json.dumps(
                normalized_metadata,
                ensure_ascii=False,
                allow_nan=False,
            )
        except (TypeError, ValueError) as error:
            raise ValueError(
                "Conflict metadata must be JSON-compatible."
            ) from error

        conflict = ConflictRecord(
            conflict_id=conflict_id,
            provider=normalize_key(
                record.provider
            ),
            provider_id=normalize_space(
                record.provider_id
            ),
            scientific_name=normalize_space(
                record.scientific_name
            ),
            canonical_name=normalize_space(
                record.canonical_name
            ),
            rank=normalize_key(
                record.rank
            )
            or "unknown",
            kingdom=normalize_space(
                record.kingdom
            ),
            candidates=candidate_ids,
            reason=normalized_reason,
            created_at=utc_now(),
            score=normalized_score,
            metadata=normalized_metadata,
        )

        conflict_json = json.dumps(
            conflict.to_dict(),
            ensure_ascii=False,
            separators=(",", ":"),
        )

        with self._lock:
            inserted = self.index.add_conflict(
                conflict_id=conflict_id,
                conflict_json=conflict_json,
                created_at=conflict.created_at,
                commit=False,
            )

            if inserted:
                try:
                    append_jsonl(
                        self.unresolved_path,
                        (
                            conflict.to_dict(),
                        ),
                        fsync_write=(
                            self.fsync_writes
                        ),
                    )

                    self.index.commit()

                except Exception:
                    self.index.connection.rollback()
                    raise

                self.state[
                    "total_unresolved_events"
                ] = (
                    int(
                        self.state.get(
                            "total_unresolved_events",
                            0,
                        )
                        or 0
                    )
                    + 1
                )

                self.save_manifest()
            else:
                self.index.connection.rollback()

        return (
            conflict_id,
            inserted,
        )

    def resolve(
        self,
        conflict_id: str,
        *,
        action: str,
        resolved_by: str,
        selected_speciedex_id: str | None = None,
        notes: str = "",
        replacement_conflict_id: str | None = None,
    ) -> ConflictResolution:
        """Resolve one existing conflict."""

        self._ensure_writable()

        normalized_id = normalize_space(
            conflict_id
        )

        if not normalized_id:
            raise ValueError(
                "conflict_id is required."
            )

        normalized_action = normalize_key(
            action
        )

        if (
            normalized_action
            not in self.VALID_RESOLUTION_ACTIONS
        ):
            raise ValueError(
                "Unsupported conflict resolution "
                f"action: {action!r}."
            )

        existing = self.index.conflict(
            normalized_id
        )

        if existing is None:
            raise KeyError(
                f"Unknown conflict: "
                f"{normalized_id}"
            )

        resolution = ConflictResolution(
            conflict_id=normalized_id,
            action=normalized_action,
            resolved_at=utc_now(),
            resolved_by=(
                normalize_space(
                    resolved_by
                )
                or "unknown"
            ),
            selected_speciedex_id=(
                normalize_space(
                    selected_speciedex_id
                )
                or None
            ),
            notes=normalize_space(
                notes
            ),
            replacement_conflict_id=(
                normalize_space(
                    replacement_conflict_id
                )
                or None
            ),
        )

        append_jsonl(
            self.resolved_path,
            (
                resolution.to_dict(),
            ),
            fsync_write=(
                self.fsync_writes
            ),
        )

        self._delete_indexed_conflict(
            normalized_id
        )

        self.state[
            "total_resolved_events"
        ] = (
            int(
                self.state.get(
                    "total_resolved_events",
                    0,
                )
                or 0
            )
            + 1
        )

        self.save_manifest()

        return resolution

    def reject(
        self,
        conflict_id: str,
        *,
        rejected_by: str,
        reason: str,
    ) -> ConflictResolution:
        """Reject or dismiss one conflict."""

        self._ensure_writable()

        resolution = self.resolve(
            conflict_id,
            action="reject",
            resolved_by=rejected_by,
            notes=reason,
        )

        append_jsonl(
            self.rejected_path,
            (
                {
                    **resolution.to_dict(),
                    "event": (
                        "conflict_rejected"
                    ),
                },
            ),
            fsync_write=(
                self.fsync_writes
            ),
        )

        self.state[
            "total_rejected_events"
        ] = (
            int(
                self.state.get(
                    "total_rejected_events",
                    0,
                )
                or 0
            )
            + 1
        )

        self.save_manifest()

        return resolution

    def get(
        self,
        conflict_id: str,
    ) -> dict[str, Any] | None:
        """Return one unresolved conflict."""

        self._ensure_open()

        row = self.index.conflict(
            normalize_space(
                conflict_id
            )
        )

        if row is None:
            return None

        return self._decode_object(
            row["conflict_json"]
        )

    def iter_unresolved(
        self,
    ) -> Iterator[
        dict[str, Any]
    ]:
        """Iterate unresolved conflicts from SQLite."""

        self._ensure_open()

        for row in self.index.iter_conflicts():
            value = self._decode_object(
                row["conflict_json"]
            )

            if value:
                yield value

    def iter_unresolved_events(
        self,
    ) -> Iterator[
        dict[str, Any]
    ]:
        """Iterate all append-only unresolved conflict events."""

        self._ensure_open()

        yield from self._iter_jsonl(
            self.unresolved_path
        )

    def iter_resolutions(
        self,
    ) -> Iterator[
        dict[str, Any]
    ]:
        """Iterate all conflict resolution events."""

        self._ensure_open()

        yield from self._iter_jsonl(
            self.resolved_path
        )

    def statistics(
        self,
    ) -> ConflictStatistics:
        """Return unresolved and historical conflict statistics."""

        self._ensure_open()

        by_provider: dict[str, int] = {}
        by_reason: dict[str, int] = {}
        by_rank: dict[str, int] = {}

        unresolved = 0

        for conflict in self.iter_unresolved():
            unresolved += 1

            provider = (
                normalize_space(
                    conflict.get(
                        "provider"
                    )
                )
                or "unknown"
            )

            reason = (
                normalize_space(
                    conflict.get(
                        "reason"
                    )
                )
                or "unknown"
            )

            rank = (
                normalize_space(
                    conflict.get(
                        "rank"
                    )
                )
                or "unknown"
            )

            by_provider[provider] = (
                by_provider.get(
                    provider,
                    0,
                )
                + 1
            )

            by_reason[reason] = (
                by_reason.get(
                    reason,
                    0,
                )
                + 1
            )

            by_rank[rank] = (
                by_rank.get(
                    rank,
                    0,
                )
                + 1
            )

        resolved = self._count_jsonl(
            self.resolved_path
        )

        rejected = self._count_jsonl(
            self.rejected_path
        )

        return ConflictStatistics(
            unresolved=unresolved,
            resolved=resolved,
            rejected=rejected,
            by_provider=dict(
                sorted(
                    by_provider.items(),
                    key=lambda item: (
                        -item[1],
                        item[0],
                    ),
                )
            ),
            by_reason=dict(
                sorted(
                    by_reason.items(),
                    key=lambda item: (
                        -item[1],
                        item[0],
                    ),
                )
            ),
            by_rank=dict(
                sorted(
                    by_rank.items(),
                    key=lambda item: (
                        -item[1],
                        item[0],
                    ),
                )
            ),
        )

    def verify(self) -> list[str]:
        """Verify conflict journals and SQLite consistency."""

        self._ensure_open()

        errors: list[str] = []

        errors.extend(
            self._validate_jsonl(
                self.unresolved_path,
                required_fields=(
                    "conflict_id",
                    "provider",
                    "provider_id",
                    "canonical_name",
                    "reason",
                    "created_at",
                ),
            )
        )

        errors.extend(
            self._validate_jsonl(
                self.resolved_path,
                required_fields=(
                    "event",
                    "conflict_id",
                    "action",
                    "resolved_at",
                    "resolved_by",
                ),
            )
        )

        errors.extend(
            self._validate_jsonl(
                self.rejected_path,
                required_fields=(
                    "event",
                    "conflict_id",
                    "action",
                    "resolved_at",
                    "resolved_by",
                ),
            )
        )

        indexed_ids = {
            normalize_space(
                row["conflict_id"]
            )
            for row in self.index.iter_conflicts()
        }

        if "" in indexed_ids:
            errors.append(
                "SQLite contains a conflict with "
                "an empty conflict_id."
            )

        unresolved_event_ids: set[str] = set()

        for event in self.iter_unresolved_events():
            conflict_id = normalize_space(
                event.get(
                    "conflict_id"
                )
            )

            if not conflict_id:
                continue

            if conflict_id in unresolved_event_ids:
                errors.append(
                    "Duplicate unresolved conflict "
                    f"event: {conflict_id}."
                )

            unresolved_event_ids.add(
                conflict_id
            )

        resolved_ids = {
            normalize_space(
                event.get(
                    "conflict_id"
                )
            )
            for event in self.iter_resolutions()
            if normalize_space(
                event.get(
                    "conflict_id"
                )
            )
        }

        for conflict_id in indexed_ids:
            if conflict_id in resolved_ids:
                errors.append(
                    "Conflict remains indexed after "
                    f"resolution: {conflict_id}."
                )

        journal_expectations = {
            "total_unresolved_events": (
                self._count_jsonl(
                    self.unresolved_path
                )
            ),
            "total_resolved_events": (
                self._count_jsonl(
                    self.resolved_path
                )
            ),
            "total_rejected_events": (
                self._count_jsonl(
                    self.rejected_path
                )
            ),
        }

        for field_name, actual_count in (
            journal_expectations.items()
        ):
            manifest_count = int(
                self.state.get(
                    field_name,
                    0,
                )
                or 0
            )

            if manifest_count != actual_count:
                errors.append(
                    "Manifest conflict journal count "
                    f"does not match {field_name}: "
                    f"manifest={manifest_count}, "
                    f"journal={actual_count}."
                )

        manifest_total = int(
            self.manifest.get(
                "total_conflicts",
                0,
            )
            or 0
        )

        sqlite_total = self.index.table_count(
            "conflicts"
        )

        if manifest_total != sqlite_total:
            errors.append(
                "Manifest conflict total does not "
                "match SQLite: "
                f"manifest={manifest_total}, "
                f"sqlite={sqlite_total}."
            )

        return errors

    def rebuild_index(
        self,
    ) -> int:
        """
        Rebuild unresolved conflict rows from append-only journals.

        Resolution events are applied after unresolved events so only currently
        unresolved conflicts remain indexed.
        """

        self._ensure_writable()

        unresolved: dict[
            str,
            dict[str, Any],
        ] = {}

        for event in self.iter_unresolved_events():
            conflict_id = normalize_space(
                event.get(
                    "conflict_id"
                )
            )

            if conflict_id:
                unresolved[
                    conflict_id
                ] = event

        for resolution in self.iter_resolutions():
            conflict_id = normalize_space(
                resolution.get(
                    "conflict_id"
                )
            )

            if conflict_id:
                unresolved.pop(
                    conflict_id,
                    None,
                )

        self._clear_indexed_conflicts()

        inserted = 0

        for conflict_id, conflict in sorted(
            unresolved.items()
        ):
            conflict_json = json.dumps(
                conflict,
                ensure_ascii=False,
                separators=(",", ":"),
            )

            created_at = (
                normalize_space(
                    conflict.get(
                        "created_at"
                    )
                )
                or utc_now()
            )

            if self.index.add_conflict(
                conflict_id=conflict_id,
                conflict_json=conflict_json,
                created_at=created_at,
                commit=False,
            ):
                inserted += 1

        self.index.commit()

        self.manifest[
            "total_conflicts"
        ] = inserted

        self.save_manifest()

        return inserted

    def iter_rejections(
        self,
    ) -> Iterator[dict[str, Any]]:
        """Iterate all explicit rejection events."""

        self._ensure_open()
        yield from self._iter_jsonl(
            self.rejected_path
        )

    def resolution(
        self,
        conflict_id: str,
    ) -> dict[str, Any] | None:
        """Return the latest resolution event for one conflict."""

        self._ensure_open()
        normalized_id = normalize_space(
            conflict_id
        )

        if not normalized_id:
            return None

        latest: dict[str, Any] | None = None

        for event in self.iter_resolutions():
            if normalize_space(
                event.get("conflict_id")
            ) == normalized_id:
                latest = event

        return latest

    def is_resolved(
        self,
        conflict_id: str,
    ) -> bool:
        """Return whether a resolution event exists for a conflict."""

        return self.resolution(
            conflict_id
        ) is not None

    def rebuild_manifest_counts(self) -> dict[str, int]:
        """Recalculate conflict journal counters and persist the manifest."""

        self._ensure_writable()

        counts = {
            "total_unresolved_events": (
                self._count_jsonl(
                    self.unresolved_path
                )
            ),
            "total_resolved_events": (
                self._count_jsonl(
                    self.resolved_path
                )
            ),
            "total_rejected_events": (
                self._count_jsonl(
                    self.rejected_path
                )
            ),
        }

        self.state.update(counts)
        self.manifest["total_conflicts"] = (
            self.index.table_count(
                "conflicts"
            )
        )
        self.save_manifest()
        return counts

    def export(
        self,
        path: Path,
        *,
        include_history: bool = True,
    ) -> None:
        """Export unresolved conflicts and optional history as JSON."""

        self._ensure_open()

        payload: dict[str, Any] = {
            "schema_version": (
                CONFLICT_SCHEMA_VERSION
            ),
            "generated_at": utc_now(),
            "unresolved": list(
                self.iter_unresolved()
            ),
            "statistics": (
                self.statistics().to_dict()
            ),
        }

        if include_history:
            payload["unresolved_events"] = list(
                self.iter_unresolved_events()
            )
            payload["resolutions"] = list(
                self.iter_resolutions()
            )
            payload["rejections"] = list(
                self.iter_rejections()
            )

        atomic_write_json(
            Path(path),
            payload,
        )

    def describe(self) -> dict[str, Any]:
        """Return non-secret conflict-manager metadata."""

        self._ensure_open()

        return {
            "root": self.root.as_posix(),
            "conflicts_root": (
                self.conflicts_root.as_posix()
            ),
            "unresolved_path": (
                self.unresolved_path.as_posix()
            ),
            "resolved_path": (
                self.resolved_path.as_posix()
            ),
            "rejected_path": (
                self.rejected_path.as_posix()
            ),
            "read_only": self.read_only,
            "persist_manifest": (
                self.persist_manifest
            ),
            "fsync_writes": (
                self.fsync_writes
            ),
            "indexed_conflicts": (
                self.index.table_count(
                    "conflicts"
                )
            ),
            "closed": self._closed,
        }

    def _delete_indexed_conflict(
        self,
        conflict_id: str,
    ) -> None:
        """Delete one conflict from the rebuildable SQLite index."""

        self.index.connection.execute(
            """
            DELETE FROM conflicts
            WHERE conflict_id = ?
            """,
            (
                conflict_id,
            ),
        )

        self.index.connection.commit()

    def _clear_indexed_conflicts(
        self,
    ) -> None:
        """Clear all rebuildable conflict rows."""

        self.index.connection.execute(
            "DELETE FROM conflicts"
        )

        self.index.connection.commit()

    @staticmethod
    def _decode_object(
        value: Any,
    ) -> dict[str, Any]:
        """Decode a JSON object."""

        if isinstance(
            value,
            dict,
        ):
            return value

        if not isinstance(
            value,
            str,
        ):
            return {}

        try:
            decoded = json.loads(
                value
            )
        except json.JSONDecodeError:
            return {}

        return (
            decoded
            if isinstance(
                decoded,
                dict,
            )
            else {}
        )

    @staticmethod
    def _iter_jsonl(
        path: Path,
    ) -> Iterator[
        dict[str, Any]
    ]:
        """Iterate JSON objects from a JSONL file."""

        if not path.is_file():
            return

        with path.open(
            "r",
            encoding="utf-8",
        ) as handle:
            for line_number, line in enumerate(
                handle,
                start=1,
            ):
                stripped = line.strip()

                if not stripped:
                    continue

                try:
                    value = json.loads(
                        stripped
                    )
                except json.JSONDecodeError as error:
                    raise ConflictManagerError(
                        "Invalid conflict JSONL in "
                        f"{path.name}:"
                        f"{line_number}: {error}"
                    ) from error

                if not isinstance(
                    value,
                    dict,
                ):
                    raise ConflictManagerError(
                        "Conflict JSONL value is not "
                        "an object in "
                        f"{path.name}:"
                        f"{line_number}."
                    )

                yield value

    @classmethod
    def _validate_jsonl(
        cls,
        path: Path,
        *,
        required_fields: Iterable[str],
    ) -> list[str]:
        """Validate a conflict JSONL file."""

        if not path.exists():
            return []

        errors: list[str] = []

        try:
            for line_number, value in enumerate(
                cls._iter_jsonl(path),
                start=1,
            ):
                for field_name in required_fields:
                    if not normalize_space(
                        value.get(
                            field_name
                        )
                    ):
                        errors.append(
                            "Conflict record missing "
                            f"{field_name!r} in "
                            f"{path.name}:"
                            f"{line_number}."
                        )

        except ConflictManagerError as error:
            errors.append(
                str(error)
            )

        return errors

    @staticmethod
    def _count_jsonl(
        path: Path,
    ) -> int:
        """Count nonempty JSONL records."""

        if not path.is_file():
            return 0

        count = 0

        with path.open(
            "r",
            encoding="utf-8",
        ) as handle:
            for line in handle:
                if line.strip():
                    count += 1

        return count


__all__ = [
    "CONFLICT_SCHEMA_VERSION",
    "DEFAULT_REJECTED_FILE",
    "DEFAULT_RESOLVED_FILE",
    "DEFAULT_UNRESOLVED_FILE",
    "ConflictManager",
    "ConflictManagerError",
    "ConflictRecord",
    "ConflictResolution",
    "ConflictStatistics",
    "append_jsonl",
    "atomic_write_json",
    "stable_json_hash",
    "utc_now",
]
