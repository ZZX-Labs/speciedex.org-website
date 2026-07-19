#!/usr/bin/env python3
"""
Speciedex.org
static/tools/core/manifest.py

Archive manifest manager for the Speciedex taxonomic ingestion system.

This module owns:

- loading and validating manifest.json,
- schema defaults and migrations,
- atomic manifest persistence,
- shared in-memory manifest state,
- archive-wide counters,
- primary-volume metadata,
- revision-journal metadata,
- conflict-journal metadata,
- generated timestamps,
- safe nested updates,
- consistency checks,
- manifest repair,
- manifest snapshots,
- manifest locking for concurrent processes.

The ManifestManager is intentionally storage-format agnostic. VolumeWriter,
RevisionWriter, ConflictManager, Archive, and StatisticsManager may all share
the same mutable manifest dictionary while using this class as the only
persistence layer.

Copyright (c) 2026 ZZX-Laboratories

Licensed under the MIT License.
"""

from __future__ import annotations

import copy
import json
import os
import tempfile
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator, Mapping, MutableMapping, Sequence


MANIFEST_SCHEMA_VERSION = 1
DEFAULT_RECORD_FORMAT = "jsonl"

DEFAULT_TARGET_VOLUME_BYTES = 48 * 1024 * 1024
DEFAULT_MAXIMUM_VOLUME_BYTES = 90 * 1024 * 1024

DEFAULT_LOCK_TIMEOUT_SECONDS = 30.0
DEFAULT_LOCK_POLL_SECONDS = 0.1
DEFAULT_STALE_LOCK_SECONDS = 15 * 60


class ManifestError(RuntimeError):
    """Raised when manifest state cannot be read or written safely."""


class ManifestLockError(ManifestError):
    """Raised when the manifest lock cannot be acquired."""


@dataclass(slots=True)
class ManifestVerification:
    """Verification result for one manifest."""

    valid: bool
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible verification result."""

        return {
            "valid": self.valid,
            "errors": list(self.errors),
            "warnings": list(self.warnings),
        }


@dataclass(slots=True)
class ManifestSnapshot:
    """Immutable point-in-time manifest snapshot."""

    generated_at: str
    data: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible snapshot."""

        return {
            "generated_at": self.generated_at,
            "data": copy.deepcopy(self.data),
        }


def utc_now() -> str:
    """Return the current UTC time in stable ISO-8601 form."""

    return (
        datetime.now(UTC)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def normalize_space(value: Any) -> str:
    """Collapse leading, trailing, and repeated whitespace."""

    return " ".join(
        str(
            value
            if value is not None
            else ""
        ).strip().split()
    )


def safe_int(
    value: Any,
    default: int = 0,
) -> int:
    """Convert a value to a nonnegative integer."""

    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = int(default)

    return max(0, parsed)


def read_json(
    path: Path,
    default: Any,
) -> Any:
    """Read UTF-8 JSON or return the supplied default."""

    try:
        return json.loads(
            path.read_text(
                encoding="utf-8",
            )
        )
    except (
        OSError,
        json.JSONDecodeError,
    ):
        return default


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
            os.fsync(handle.fileno())
            temporary = Path(handle.name)

        temporary.replace(path)

    finally:
        if (
            temporary is not None
            and temporary.exists()
        ):
            temporary.unlink(
                missing_ok=True
            )


class ManifestManager:
    """
    Manage the shared Speciedex archive manifest.

    ``state`` is a mutable dictionary intentionally shared with the archive
    writers. Any component may update the dictionary in memory, but this class
    should remain the sole object responsible for loading and persisting it.
    """

    def __init__(
        self,
        path: Path,
        *,
        target_volume_bytes: int = (
            DEFAULT_TARGET_VOLUME_BYTES
        ),
        maximum_volume_bytes: int = (
            DEFAULT_MAXIMUM_VOLUME_BYTES
        ),
        auto_save: bool = False,
        lock_timeout_seconds: float = (
            DEFAULT_LOCK_TIMEOUT_SECONDS
        ),
        lock_poll_seconds: float = (
            DEFAULT_LOCK_POLL_SECONDS
        ),
        stale_lock_seconds: float = (
            DEFAULT_STALE_LOCK_SECONDS
        ),
    ) -> None:
        self.path = Path(path)
        self.lock_path = self.path.with_suffix(
            self.path.suffix + ".lock"
        )

        self.target_volume_bytes = int(
            target_volume_bytes
        )

        self.maximum_volume_bytes = int(
            maximum_volume_bytes
        )

        self.auto_save = bool(auto_save)

        self.lock_timeout_seconds = max(
            0.0,
            float(lock_timeout_seconds),
        )

        self.lock_poll_seconds = max(
            0.01,
            float(lock_poll_seconds),
        )

        self.stale_lock_seconds = max(
            1.0,
            float(stale_lock_seconds),
        )

        self._dirty = False
        self._lock_depth = 0
        self._lock_fd: int | None = None

        self._validate_configuration()

        self.path.parent.mkdir(
            parents=True,
            exist_ok=True,
        )

        self.state = self._load()
        self.repair_defaults()

    def __enter__(
        self,
    ) -> ManifestManager:
        return self

    def __exit__(
        self,
        exc_type: Any,
        exc_value: Any,
        traceback: Any,
    ) -> None:
        if exc_type is None and self._dirty:
            self.save()

        self.release_lock()

    @property
    def dirty(self) -> bool:
        """Return whether in-memory state differs from disk."""

        return self._dirty

    @property
    def volumes(self) -> list[dict[str, Any]]:
        """Return primary volume metadata."""

        value = self.state.get(
            "volumes"
        )

        if not isinstance(value, list):
            value = []
            self.state["volumes"] = value
            self.mark_dirty()

        return value

    @property
    def revision_journal(self) -> dict[str, Any]:
        """Return revision-journal metadata."""

        value = self.state.get(
            "revision_journal"
        )

        if not isinstance(value, dict):
            value = {}
            self.state[
                "revision_journal"
            ] = value
            self.mark_dirty()

        return value

    @property
    def conflict_journal(self) -> dict[str, Any]:
        """Return conflict-journal metadata."""

        value = self.state.get(
            "conflict_journal"
        )

        if not isinstance(value, dict):
            value = {}
            self.state[
                "conflict_journal"
            ] = value
            self.mark_dirty()

        return value

    def _validate_configuration(self) -> None:
        """Validate manager configuration."""

        if self.target_volume_bytes < 1:
            raise ValueError(
                "target_volume_bytes must be positive."
            )

        if self.maximum_volume_bytes < 1:
            raise ValueError(
                "maximum_volume_bytes must be positive."
            )

        if (
            self.target_volume_bytes
            >= self.maximum_volume_bytes
        ):
            raise ValueError(
                "target_volume_bytes must be below "
                "maximum_volume_bytes."
            )

    def _load(self) -> dict[str, Any]:
        """Load the manifest from disk."""

        if not self.path.exists():
            return self.new_manifest()

        try:
            value = json.loads(
                self.path.read_text(
                    encoding="utf-8",
                )
            )
        except OSError as error:
            raise ManifestError(
                f"Unable to read manifest "
                f"{self.path}: {error}"
            ) from error
        except json.JSONDecodeError as error:
            raise ManifestError(
                f"Invalid manifest JSON in "
                f"{self.path}: {error}"
            ) from error

        if not isinstance(value, dict):
            raise ManifestError(
                "Manifest root must be a JSON object."
            )

        return value

    def reload(self) -> dict[str, Any]:
        """Reload manifest state from disk."""

        self.state = self._load()
        self.repair_defaults()
        self._dirty = False

        return self.state

    def new_manifest(self) -> dict[str, Any]:
        """Create a new manifest dictionary."""

        timestamp = utc_now()

        return {
            "schema_version": (
                MANIFEST_SCHEMA_VERSION
            ),
            "generated_at": timestamp,
            "record_format": (
                DEFAULT_RECORD_FORMAT
            ),
            "target_volume_bytes": (
                self.target_volume_bytes
            ),
            "maximum_volume_bytes": (
                self.maximum_volume_bytes
            ),
            "total_primary_records": 0,
            "total_revisions": 0,
            "total_conflicts": 0,
            "volumes": [],
            "active_volume": None,
            "revision_journal": {
                "schema_version": 1,
                "record_format": "jsonl",
                "total_records": 0,
                "volumes": [],
                "active_volume": None,
                "generated_at": timestamp,
            },
            "conflict_journal": {
                "schema_version": 1,
                "total_unresolved_events": 0,
                "total_resolved_events": 0,
                "total_rejected_events": 0,
                "generated_at": timestamp,
            },
        }

    def repair_defaults(self) -> None:
        """
        Add required fields and normalize malformed manifest structures.

        Existing valid data is preserved.
        """

        defaults = self.new_manifest()

        changed = False

        for key, value in defaults.items():
            if key not in self.state:
                self.state[key] = copy.deepcopy(
                    value
                )
                changed = True

        if not isinstance(
            self.state.get("volumes"),
            list,
        ):
            self.state["volumes"] = []
            changed = True

        if not isinstance(
            self.state.get(
                "revision_journal"
            ),
            dict,
        ):
            self.state[
                "revision_journal"
            ] = copy.deepcopy(
                defaults["revision_journal"]
            )
            changed = True

        if not isinstance(
            self.state.get(
                "conflict_journal"
            ),
            dict,
        ):
            self.state[
                "conflict_journal"
            ] = copy.deepcopy(
                defaults["conflict_journal"]
            )
            changed = True

        self.state[
            "schema_version"
        ] = MANIFEST_SCHEMA_VERSION

        self.state[
            "record_format"
        ] = DEFAULT_RECORD_FORMAT

        self.state[
            "target_volume_bytes"
        ] = self.target_volume_bytes

        self.state[
            "maximum_volume_bytes"
        ] = self.maximum_volume_bytes

        self.state[
            "total_primary_records"
        ] = safe_int(
            self.state.get(
                "total_primary_records"
            )
        )

        self.state[
            "total_revisions"
        ] = safe_int(
            self.state.get(
                "total_revisions"
            )
        )

        self.state[
            "total_conflicts"
        ] = safe_int(
            self.state.get(
                "total_conflicts"
            )
        )

        self._repair_revision_journal()
        self._repair_conflict_journal()
        self._repair_volume_entries()

        if changed:
            self.mark_dirty()

    def _repair_revision_journal(self) -> None:
        """Normalize revision-journal fields."""

        journal = self.revision_journal

        defaults = {
            "schema_version": 1,
            "record_format": "jsonl",
            "total_records": safe_int(
                self.state.get(
                    "total_revisions"
                )
            ),
            "volumes": [],
            "active_volume": None,
            "generated_at": utc_now(),
        }

        for key, value in defaults.items():
            if key not in journal:
                journal[key] = copy.deepcopy(
                    value
                )
                self.mark_dirty()

        if not isinstance(
            journal.get("volumes"),
            list,
        ):
            journal["volumes"] = []
            self.mark_dirty()

        journal["schema_version"] = 1
        journal["record_format"] = "jsonl"
        journal["total_records"] = safe_int(
            journal.get(
                "total_records"
            )
        )

    def _repair_conflict_journal(self) -> None:
        """Normalize conflict-journal fields."""

        journal = self.conflict_journal

        defaults = {
            "schema_version": 1,
            "total_unresolved_events": 0,
            "total_resolved_events": 0,
            "total_rejected_events": 0,
            "generated_at": utc_now(),
        }

        for key, value in defaults.items():
            if key not in journal:
                journal[key] = copy.deepcopy(
                    value
                )
                self.mark_dirty()

        journal["schema_version"] = 1

        for key in (
            "total_unresolved_events",
            "total_resolved_events",
            "total_rejected_events",
        ):
            journal[key] = safe_int(
                journal.get(key)
            )

    def _repair_volume_entries(self) -> None:
        """Normalize primary volume entries."""

        repaired: list[
            dict[str, Any]
        ] = []

        seen_files: set[str] = set()

        for value in self.volumes:
            if not isinstance(value, Mapping):
                self.mark_dirty()
                continue

            entry = dict(value)

            relative_file = normalize_space(
                entry.get("file")
            )

            if not relative_file:
                self.mark_dirty()
                continue

            if relative_file in seen_files:
                self.mark_dirty()
                continue

            seen_files.add(relative_file)

            entry["file"] = relative_file
            entry["record_count"] = safe_int(
                entry.get(
                    "record_count"
                )
            )
            entry["size_bytes"] = safe_int(
                entry.get(
                    "size_bytes"
                )
            )
            entry["sealed"] = bool(
                entry.get(
                    "sealed",
                    False,
                )
            )
            entry["sha256"] = (
                normalize_space(
                    entry.get("sha256")
                )
                or None
            )
            entry["created_at"] = (
                normalize_space(
                    entry.get(
                        "created_at"
                    )
                )
                or utc_now()
            )
            entry["sealed_at"] = (
                normalize_space(
                    entry.get(
                        "sealed_at"
                    )
                )
                or None
            )

            repaired.append(entry)

        if repaired != self.volumes:
            self.state["volumes"] = repaired
            self.mark_dirty()

    def mark_dirty(self) -> None:
        """Mark state as modified."""

        self._dirty = True

        if self.auto_save:
            self.save()

    def save(
        self,
        *,
        acquire_lock: bool = True,
    ) -> None:
        """Persist the current manifest atomically."""

        self.state[
            "generated_at"
        ] = utc_now()

        self.revision_journal[
            "generated_at"
        ] = self.state[
            "generated_at"
        ]

        self.conflict_journal[
            "generated_at"
        ] = self.state[
            "generated_at"
        ]

        self.repair_defaults()

        if acquire_lock:
            with self.locked():
                atomic_write_json(
                    self.path,
                    self.state,
                )
        else:
            atomic_write_json(
                self.path,
                self.state,
            )

        self._dirty = False

    def snapshot(self) -> ManifestSnapshot:
        """Return an immutable deep copy of current state."""

        return ManifestSnapshot(
            generated_at=utc_now(),
            data=copy.deepcopy(
                self.state
            ),
        )

    def replace(
        self,
        value: Mapping[str, Any],
        *,
        save: bool = False,
    ) -> None:
        """Replace all manifest state."""

        self.state = dict(
            copy.deepcopy(value)
        )

        self.repair_defaults()
        self.mark_dirty()

        if save:
            self.save()

    def get(
        self,
        path: str | Sequence[str],
        default: Any = None,
    ) -> Any:
        """Read a nested manifest value."""

        keys = self._path_keys(path)

        current: Any = self.state

        for key in keys:
            if not isinstance(
                current,
                Mapping,
            ):
                return default

            if key not in current:
                return default

            current = current[key]

        return current

    def set(
        self,
        path: str | Sequence[str],
        value: Any,
        *,
        save: bool = False,
    ) -> None:
        """Set a nested manifest value."""

        keys = self._path_keys(path)

        if not keys:
            raise ValueError(
                "Manifest path cannot be empty."
            )

        current: MutableMapping[
            str,
            Any,
        ] = self.state

        for key in keys[:-1]:
            child = current.get(key)

            if not isinstance(
                child,
                MutableMapping,
            ):
                child = {}
                current[key] = child

            current = child

        current[keys[-1]] = copy.deepcopy(
            value
        )

        self.mark_dirty()

        if save:
            self.save()

    def delete(
        self,
        path: str | Sequence[str],
        *,
        save: bool = False,
    ) -> bool:
        """Delete a nested manifest value."""

        keys = self._path_keys(path)

        if not keys:
            return False

        current: MutableMapping[
            str,
            Any,
        ] = self.state

        for key in keys[:-1]:
            child = current.get(key)

            if not isinstance(
                child,
                MutableMapping,
            ):
                return False

            current = child

        if keys[-1] not in current:
            return False

        del current[keys[-1]]
        self.mark_dirty()

        if save:
            self.save()

        return True

    def increment(
        self,
        path: str | Sequence[str],
        amount: int = 1,
        *,
        save: bool = False,
    ) -> int:
        """Increment a nested nonnegative integer counter."""

        current = safe_int(
            self.get(path, 0)
        )

        updated = max(
            0,
            current + int(amount),
        )

        self.set(
            path,
            updated,
            save=save,
        )

        return updated

    def register_volume(
        self,
        entry: Mapping[str, Any],
        *,
        journal: str = "primary",
        save: bool = False,
    ) -> dict[str, Any]:
        """Register or replace one volume metadata object."""

        normalized = self._normalize_volume_entry(
            entry
        )

        relative_file = normalized["file"]

        volumes = self._journal_volumes(
            journal
        )

        for index, existing in enumerate(
            volumes
        ):
            if (
                normalize_space(
                    existing.get("file")
                )
                == relative_file
            ):
                volumes[index] = normalized
                self.mark_dirty()

                if save:
                    self.save()

                return normalized

        volumes.append(normalized)
        self.mark_dirty()

        if save:
            self.save()

        return normalized

    def update_volume(
        self,
        relative_file: str,
        updates: Mapping[str, Any],
        *,
        journal: str = "primary",
        save: bool = False,
    ) -> dict[str, Any]:
        """Update one registered volume."""

        target = self.find_volume(
            relative_file,
            journal=journal,
        )

        if target is None:
            raise KeyError(
                f"Unknown {journal} volume: "
                f"{relative_file}"
            )

        for key, value in updates.items():
            target[str(key)] = copy.deepcopy(
                value
            )

        normalized = self._normalize_volume_entry(
            target
        )

        target.clear()
        target.update(normalized)

        self.mark_dirty()

        if save:
            self.save()

        return target

    def remove_volume(
        self,
        relative_file: str,
        *,
        journal: str = "primary",
        save: bool = False,
    ) -> bool:
        """Remove one volume metadata entry."""

        normalized = normalize_space(
            relative_file
        )

        volumes = self._journal_volumes(
            journal
        )

        for index, entry in enumerate(
            volumes
        ):
            if (
                normalize_space(
                    entry.get("file")
                )
                == normalized
            ):
                del volumes[index]
                self.mark_dirty()

                if save:
                    self.save()

                return True

        return False

    def find_volume(
        self,
        relative_file: str,
        *,
        journal: str = "primary",
    ) -> dict[str, Any] | None:
        """Find one volume metadata entry."""

        normalized = normalize_space(
            relative_file
        )

        for entry in self._journal_volumes(
            journal
        ):
            if (
                normalize_space(
                    entry.get("file")
                )
                == normalized
            ):
                return entry

        return None

    def set_active_volume(
        self,
        relative_file: str | None,
        *,
        journal: str = "primary",
        save: bool = False,
    ) -> None:
        """Set the active volume for one journal."""

        normalized = (
            normalize_space(relative_file)
            if relative_file is not None
            else ""
        )

        if normalized:
            entry = self.find_volume(
                normalized,
                journal=journal,
            )

            if entry is None:
                raise KeyError(
                    f"Cannot activate unknown "
                    f"{journal} volume: {normalized}"
                )

            if bool(entry.get("sealed")):
                raise ManifestError(
                    f"Cannot activate sealed "
                    f"{journal} volume: {normalized}"
                )

        if journal == "primary":
            self.state[
                "active_volume"
            ] = normalized or None

        elif journal == "revision":
            self.revision_journal[
                "active_volume"
            ] = normalized or None

        else:
            raise ValueError(
                f"Unsupported journal: {journal}"
            )

        self.mark_dirty()

        if save:
            self.save()

    def active_volume(
        self,
        *,
        journal: str = "primary",
    ) -> dict[str, Any] | None:
        """Return active volume metadata."""

        if journal == "primary":
            relative_file = normalize_space(
                self.state.get(
                    "active_volume"
                )
            )

        elif journal == "revision":
            relative_file = normalize_space(
                self.revision_journal.get(
                    "active_volume"
                )
            )

        else:
            raise ValueError(
                f"Unsupported journal: {journal}"
            )

        if not relative_file:
            return None

        return self.find_volume(
            relative_file,
            journal=journal,
        )

    def recalculate_primary_total(self) -> int:
        """Recalculate total primary records from volume metadata."""

        total = sum(
            safe_int(
                entry.get(
                    "record_count"
                )
            )
            for entry in self.volumes
        )

        self.state[
            "total_primary_records"
        ] = total

        self.mark_dirty()

        return total

    def recalculate_revision_total(self) -> int:
        """Recalculate total revision records."""

        total = sum(
            safe_int(
                entry.get(
                    "record_count"
                )
            )
            for entry in self._journal_volumes(
                "revision"
            )
        )

        self.revision_journal[
            "total_records"
        ] = total

        self.state[
            "total_revisions"
        ] = total

        self.mark_dirty()

        return total

    def synchronize_counters(self) -> None:
        """Synchronize mirrored top-level and nested counters."""

        revision_total = safe_int(
            self.revision_journal.get(
                "total_records"
            )
        )

        self.state[
            "total_revisions"
        ] = revision_total

        self.state[
            "total_conflicts"
        ] = safe_int(
            self.state.get(
                "total_conflicts"
            )
        )

        self.mark_dirty()

    def verify(self) -> ManifestVerification:
        """Verify manifest structure and internal consistency."""

        errors: list[str] = []
        warnings: list[str] = []

        if (
            safe_int(
                self.state.get(
                    "schema_version"
                )
            )
            != MANIFEST_SCHEMA_VERSION
        ):
            errors.append(
                "Manifest schema version mismatch."
            )

        if (
            normalize_space(
                self.state.get(
                    "record_format"
                )
            )
            != DEFAULT_RECORD_FORMAT
        ):
            errors.append(
                "Manifest record_format must be "
                f"{DEFAULT_RECORD_FORMAT!r}."
            )

        if (
            safe_int(
                self.state.get(
                    "target_volume_bytes"
                )
            )
            >= safe_int(
                self.state.get(
                    "maximum_volume_bytes"
                )
            )
        ):
            errors.append(
                "Manifest target volume size must be "
                "below maximum volume size."
            )

        errors.extend(
            self._verify_volume_list(
                self.volumes,
                active_file=normalize_space(
                    self.state.get(
                        "active_volume"
                    )
                ),
                label="primary",
            )
        )

        errors.extend(
            self._verify_volume_list(
                self._journal_volumes(
                    "revision"
                ),
                active_file=normalize_space(
                    self.revision_journal.get(
                        "active_volume"
                    )
                ),
                label="revision",
            )
        )

        primary_total = sum(
            safe_int(
                entry.get(
                    "record_count"
                )
            )
            for entry in self.volumes
        )

        manifest_primary_total = safe_int(
            self.state.get(
                "total_primary_records"
            )
        )

        if (
            primary_total
            != manifest_primary_total
        ):
            errors.append(
                "Primary record total mismatch: "
                f"manifest={manifest_primary_total}, "
                f"volumes={primary_total}."
            )

        revision_total = sum(
            safe_int(
                entry.get(
                    "record_count"
                )
            )
            for entry in self._journal_volumes(
                "revision"
            )
        )

        nested_revision_total = safe_int(
            self.revision_journal.get(
                "total_records"
            )
        )

        top_revision_total = safe_int(
            self.state.get(
                "total_revisions"
            )
        )

        if (
            revision_total
            != nested_revision_total
        ):
            errors.append(
                "Revision journal total mismatch: "
                f"journal={nested_revision_total}, "
                f"volumes={revision_total}."
            )

        if (
            nested_revision_total
            != top_revision_total
        ):
            errors.append(
                "Top-level total_revisions does not "
                "match revision_journal.total_records."
            )

        generated_at = normalize_space(
            self.state.get(
                "generated_at"
            )
        )

        if not generated_at:
            warnings.append(
                "Manifest has no generated_at timestamp."
            )

        return ManifestVerification(
            valid=not errors,
            errors=errors,
            warnings=warnings,
        )

    def repair(
        self,
        *,
        save: bool = False,
    ) -> ManifestVerification:
        """Repair manifest defaults and mirrored counters."""

        self.repair_defaults()

        self.state["volumes"] = self._sorted_unique_volumes(
            self.volumes
        )

        self.revision_journal[
            "volumes"
        ] = self._sorted_unique_volumes(
            self._journal_volumes(
                "revision"
            )
        )

        self._repair_active_volume(
            journal="primary"
        )

        self._repair_active_volume(
            journal="revision"
        )

        self.recalculate_primary_total()
        self.recalculate_revision_total()
        self.synchronize_counters()

        if save:
            self.save()

        return self.verify()

    @contextmanager
    def locked(
        self,
        *,
        timeout_seconds: float | None = None,
    ) -> Iterator[None]:
        """Acquire the manifest file lock."""

        self.acquire_lock(
            timeout_seconds=timeout_seconds
        )

        try:
            yield
        finally:
            self.release_lock()

    def acquire_lock(
        self,
        *,
        timeout_seconds: float | None = None,
    ) -> None:
        """Acquire an exclusive filesystem lock."""

        if self._lock_depth > 0:
            self._lock_depth += 1
            return

        timeout = (
            self.lock_timeout_seconds
            if timeout_seconds is None
            else max(
                0.0,
                float(timeout_seconds),
            )
        )

        deadline = time.monotonic() + timeout

        while True:
            self._remove_stale_lock()

            try:
                file_descriptor = os.open(
                    self.lock_path,
                    (
                        os.O_CREAT
                        | os.O_EXCL
                        | os.O_WRONLY
                    ),
                    0o600,
                )

            except FileExistsError:
                if time.monotonic() >= deadline:
                    raise ManifestLockError(
                        "Timed out waiting for manifest "
                        f"lock: {self.lock_path}"
                    )

                time.sleep(
                    self.lock_poll_seconds
                )
                continue

            except OSError as error:
                raise ManifestLockError(
                    "Unable to acquire manifest lock: "
                    f"{error}"
                ) from error

            lock_payload = {
                "pid": os.getpid(),
                "created_at": utc_now(),
                "manifest": str(
                    self.path
                ),
            }

            os.write(
                file_descriptor,
                json.dumps(
                    lock_payload,
                    ensure_ascii=False,
                    separators=(",", ":"),
                ).encode("utf-8"),
            )

            os.fsync(file_descriptor)

            self._lock_fd = (
                file_descriptor
            )

            self._lock_depth = 1
            return

    def release_lock(self) -> None:
        """Release the manifest filesystem lock."""

        if self._lock_depth == 0:
            return

        self._lock_depth -= 1

        if self._lock_depth > 0:
            return

        try:
            if self._lock_fd is not None:
                os.close(
                    self._lock_fd
                )

        finally:
            self._lock_fd = None

            try:
                self.lock_path.unlink(
                    missing_ok=True
                )
            except OSError:
                pass

    def _remove_stale_lock(self) -> None:
        """Remove a stale manifest lock file."""

        if not self.lock_path.exists():
            return

        try:
            age = (
                time.time()
                - self.lock_path.stat().st_mtime
            )
        except OSError:
            return

        if age < self.stale_lock_seconds:
            return

        try:
            self.lock_path.unlink(
                missing_ok=True
            )
        except OSError:
            return

    def _journal_volumes(
        self,
        journal: str,
    ) -> list[dict[str, Any]]:
        """Return a volume list for one journal."""

        if journal == "primary":
            return self.volumes

        if journal == "revision":
            value = self.revision_journal.get(
                "volumes"
            )

            if not isinstance(value, list):
                value = []
                self.revision_journal[
                    "volumes"
                ] = value
                self.mark_dirty()

            return value

        raise ValueError(
            f"Unsupported journal: {journal}"
        )

    @staticmethod
    def _normalize_volume_entry(
        value: Mapping[str, Any],
    ) -> dict[str, Any]:
        """Normalize one volume metadata object."""

        relative_file = normalize_space(
            value.get("file")
        )

        if not relative_file:
            raise ValueError(
                "Volume entry requires a file."
            )

        sealed = bool(
            value.get(
                "sealed",
                False,
            )
        )

        return {
            "file": relative_file,
            "record_count": safe_int(
                value.get(
                    "record_count"
                )
            ),
            "size_bytes": safe_int(
                value.get(
                    "size_bytes"
                )
            ),
            "sha256": (
                normalize_space(
                    value.get("sha256")
                )
                or None
            ),
            "sealed": sealed,
            "created_at": (
                normalize_space(
                    value.get(
                        "created_at"
                    )
                )
                or utc_now()
            ),
            "sealed_at": (
                normalize_space(
                    value.get(
                        "sealed_at"
                    )
                )
                or None
            ),
        }

    @classmethod
    def _sorted_unique_volumes(
        cls,
        values: Sequence[
            Mapping[str, Any]
        ],
    ) -> list[dict[str, Any]]:
        """Normalize, deduplicate, and sort volume entries."""

        by_file: dict[
            str,
            dict[str, Any],
        ] = {}

        for value in values:
            if not isinstance(
                value,
                Mapping,
            ):
                continue

            try:
                normalized = (
                    cls._normalize_volume_entry(
                        value
                    )
                )
            except ValueError:
                continue

            by_file[
                normalized["file"]
            ] = normalized

        return sorted(
            by_file.values(),
            key=lambda entry: (
                normalize_space(
                    entry.get("file")
                )
            ),
        )

    def _repair_active_volume(
        self,
        *,
        journal: str,
    ) -> None:
        """Repair active-volume metadata."""

        volumes = self._journal_volumes(
            journal
        )

        if journal == "primary":
            active_file = normalize_space(
                self.state.get(
                    "active_volume"
                )
            )
        else:
            active_file = normalize_space(
                self.revision_journal.get(
                    "active_volume"
                )
            )

        active = (
            self.find_volume(
                active_file,
                journal=journal,
            )
            if active_file
            else None
        )

        if (
            active is not None
            and not bool(
                active.get("sealed")
            )
        ):
            return

        unsealed = [
            entry
            for entry in volumes
            if not bool(
                entry.get("sealed")
            )
        ]

        replacement = (
            unsealed[-1]["file"]
            if unsealed
            else None
        )

        if journal == "primary":
            self.state[
                "active_volume"
            ] = replacement
        else:
            self.revision_journal[
                "active_volume"
            ] = replacement

        self.mark_dirty()

    @staticmethod
    def _verify_volume_list(
        volumes: Sequence[
            Mapping[str, Any]
        ],
        *,
        active_file: str,
        label: str,
    ) -> list[str]:
        """Verify one manifest volume list."""

        errors: list[str] = []
        seen: set[str] = set()
        unsealed: list[str] = []

        for index, entry in enumerate(
            volumes,
            start=1,
        ):
            if not isinstance(
                entry,
                Mapping,
            ):
                errors.append(
                    f"{label} volume entry {index} "
                    "is not an object."
                )
                continue

            relative_file = normalize_space(
                entry.get("file")
            )

            if not relative_file:
                errors.append(
                    f"{label} volume entry {index} "
                    "has no file."
                )
                continue

            if relative_file in seen:
                errors.append(
                    f"Duplicate {label} volume: "
                    f"{relative_file}."
                )

            seen.add(relative_file)

            if safe_int(
                entry.get(
                    "record_count"
                )
            ) < 0:
                errors.append(
                    f"{label} volume has a negative "
                    f"record count: {relative_file}."
                )

            if safe_int(
                entry.get(
                    "size_bytes"
                )
            ) < 0:
                errors.append(
                    f"{label} volume has a negative "
                    f"size: {relative_file}."
                )

            sealed = bool(
                entry.get("sealed")
            )

            sha256 = normalize_space(
                entry.get("sha256")
            )

            if sealed and not sha256:
                errors.append(
                    f"Sealed {label} volume has no "
                    f"checksum: {relative_file}."
                )

            if not sealed:
                unsealed.append(
                    relative_file
                )

        if len(unsealed) > 1:
            errors.append(
                f"Multiple unsealed {label} volumes: "
                + ", ".join(unsealed)
            )

        if active_file:
            if active_file not in seen:
                errors.append(
                    f"Active {label} volume is not "
                    f"registered: {active_file}."
                )

            if (
                unsealed
                and active_file not in unsealed
            ):
                errors.append(
                    f"Active {label} volume is sealed "
                    f"or differs from the unsealed "
                    f"volume: {active_file}."
                )

        elif unsealed:
            errors.append(
                f"Unsealed {label} volume exists but "
                "no active volume is configured."
            )

        return errors

    @staticmethod
    def _path_keys(
        path: str | Sequence[str],
    ) -> list[str]:
        """Normalize a nested path."""

        if isinstance(path, str):
            return [
                key
                for key in path.split(".")
                if key
            ]

        return [
            str(key)
            for key in path
            if str(key)
        ]
