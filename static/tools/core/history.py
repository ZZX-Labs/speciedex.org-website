#!/usr/bin/env python3
"""
Speciedex.org
static/tools/core/history.py

Persistent statistics-history and ingestion-run history manager.

This module owns:

- statistics-history snapshots,
- provider-run history,
- deduplication of unchanged snapshots,
- configurable retention limits,
- atomic JSON persistence,
- append-only optional JSONL run journals,
- historical delta calculation,
- historical verification,
- history repair and normalization,
- dashboard-ready trend data.

The HistoryManager does not calculate archive statistics itself. Callers pass
completed statistics and provider summaries into this module after each scan.

Copyright (c) 2026 ZZX-Laboratories

Licensed under the MIT License.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Sequence


HISTORY_SCHEMA_VERSION = 1

DEFAULT_HISTORY_LIMIT = 672
DEFAULT_PROVIDER_HISTORY_LIMIT = 2_688

DEFAULT_STATISTICS_FILENAME = (
    "statistics-history.json"
)

DEFAULT_PROVIDER_HISTORY_FILENAME = (
    "provider-history.json"
)

DEFAULT_RUN_JOURNAL_FILENAME = (
    "run-history.jsonl"
)

DEFAULT_TRACKED_FIELDS = (
    "species",
    "genera",
    "families",
    "orders",
    "classes",
    "phyla",
    "kingdoms",
    "records_archived",
    "source_assertions",
    "source_identifiers",
    "synonyms",
    "unresolved_conflicts",
    "resolved_conflicts",
    "rejected_conflicts",
    "revisions",
    "volumes",
    "sealed_volumes",
)

DEFAULT_PROVIDER_FIELDS = (
    "fetched",
    "raw",
    "created",
    "matched",
    "revised",
    "conflicted",
    "rejected",
    "requests",
    "duration_seconds",
)


class HistoryError(RuntimeError):
    """Raised when history data cannot be read or written safely."""


@dataclass(slots=True)
class HistoryPaths:
    """Filesystem paths owned by HistoryManager."""

    data_root: Path
    statistics: Path = field(init=False)
    providers: Path = field(init=False)
    run_journal: Path = field(init=False)

    def __post_init__(self) -> None:
        self.data_root = Path(
            self.data_root
        )

        self.statistics = (
            self.data_root
            / DEFAULT_STATISTICS_FILENAME
        )

        self.providers = (
            self.data_root
            / DEFAULT_PROVIDER_HISTORY_FILENAME
        )

        self.run_journal = (
            self.data_root
            / DEFAULT_RUN_JOURNAL_FILENAME
        )


@dataclass(slots=True)
class HistoryUpdate:
    """Result of updating history files."""

    statistics_appended: bool
    statistics_replaced: bool
    provider_snapshots_added: int
    run_journal_appended: bool
    statistics_entries: int
    provider_entries: int

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible update result."""

        return {
            "statistics_appended": (
                self.statistics_appended
            ),
            "statistics_replaced": (
                self.statistics_replaced
            ),
            "provider_snapshots_added": (
                self.provider_snapshots_added
            ),
            "run_journal_appended": (
                self.run_journal_appended
            ),
            "statistics_entries": (
                self.statistics_entries
            ),
            "provider_entries": (
                self.provider_entries
            ),
        }


@dataclass(slots=True)
class HistoryVerification:
    """Verification result for all history files."""

    valid: bool
    errors: list[str]
    warnings: list[str]
    statistics_entries: int
    provider_entries: int
    run_entries: int

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-compatible verification result."""

        return {
            "valid": self.valid,
            "errors": list(
                self.errors
            ),
            "warnings": list(
                self.warnings
            ),
            "statistics_entries": (
                self.statistics_entries
            ),
            "provider_entries": (
                self.provider_entries
            ),
            "run_entries": self.run_entries,
        }


def utc_now() -> str:
    """Return the current UTC timestamp in stable ISO-8601 form."""

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
    """Convert a value to a nonnegative integer."""

    try:
        parsed = int(
            value
        )
    except (
        TypeError,
        ValueError,
    ):
        return max(
            0,
            int(default),
        )

    return max(
        0,
        parsed,
    )


def safe_float(
    value: Any,
    default: float = 0.0,
) -> float:
    """Convert a value to a nonnegative float."""

    try:
        parsed = float(
            value
        )
    except (
        TypeError,
        ValueError,
    ):
        return max(
            0.0,
            float(default),
        )

    return max(
        0.0,
        parsed,
    )


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
            os.fsync(
                handle.fileno()
            )
            temporary = Path(
                handle.name
            )

        temporary.replace(
            path
        )

    finally:
        if (
            temporary is not None
            and temporary.exists()
        ):
            temporary.unlink(
                missing_ok=True
            )


def append_jsonl(
    path: Path,
    values: Iterable[
        Mapping[str, Any]
    ],
    *,
    fsync_write: bool = True,
) -> int:
    """Append JSON objects to a UTF-8 JSONL file."""

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


class HistoryManager:
    """
    Manage aggregate statistics and provider execution history.

    The primary statistics history preserves the existing
    ``statistics-history.json`` format: a JSON array of snapshots.

    Provider history is stored as a JSON object containing one retained list
    per provider.

    The optional JSONL run journal stores one complete immutable scan event per
    invocation and is not truncated by retention policies.
    """

    def __init__(
        self,
        data_root: Path,
        *,
        statistics_limit: int = (
            DEFAULT_HISTORY_LIMIT
        ),
        provider_limit: int = (
            DEFAULT_PROVIDER_HISTORY_LIMIT
        ),
        tracked_fields: Sequence[str] = (
            DEFAULT_TRACKED_FIELDS
        ),
        provider_fields: Sequence[str] = (
            DEFAULT_PROVIDER_FIELDS
        ),
        write_run_journal: bool = True,
        fsync_writes: bool = True,
    ) -> None:
        self.paths = HistoryPaths(
            Path(data_root)
        )

        self.statistics_limit = max(
            0,
            int(statistics_limit),
        )

        self.provider_limit = max(
            0,
            int(provider_limit),
        )

        self.tracked_fields = tuple(
            normalize_space(field_name)
            for field_name in tracked_fields
            if normalize_space(field_name)
        )

        self.provider_fields = tuple(
            normalize_space(field_name)
            for field_name in provider_fields
            if normalize_space(field_name)
        )

        self.write_run_journal = bool(
            write_run_journal
        )

        self.fsync_writes = bool(
            fsync_writes
        )

        self.paths.data_root.mkdir(
            parents=True,
            exist_ok=True,
        )

    def update(
        self,
        *,
        statistics: Mapping[str, Any],
        provider_summaries: Sequence[
            Mapping[str, Any]
        ] | None = None,
        skipped_providers: Sequence[
            Mapping[str, Any]
        ] | None = None,
        generated_at: str | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> HistoryUpdate:
        """
        Update all configured history stores for one ingestion run.
        """

        timestamp = (
            normalize_space(
                generated_at
            )
            or normalize_space(
                statistics.get(
                    "last_updated"
                )
            )
            or utc_now()
        )

        snapshot = self.build_statistics_snapshot(
            statistics,
            generated_at=timestamp,
        )

        (
            statistics_history,
            appended,
            replaced,
        ) = self._update_statistics_history(
            snapshot
        )

        normalized_summaries = [
            self._normalize_provider_summary(
                summary,
                generated_at=timestamp,
            )
            for summary in (
                provider_summaries or []
            )
            if isinstance(
                summary,
                Mapping,
            )
        ]

        normalized_summaries = [
            summary
            for summary in normalized_summaries
            if summary.get("provider")
        ]

        provider_history = (
            self._update_provider_history(
                normalized_summaries
            )
        )

        run_appended = False

        if self.write_run_journal:
            run_record = {
                "schema_version": (
                    HISTORY_SCHEMA_VERSION
                ),
                "event": "ingestion_run",
                "generated_at": timestamp,
                "statistics": snapshot,
                "providers": (
                    normalized_summaries
                ),
                "skipped": (
                    self._normalize_skipped(
                        skipped_providers or []
                    )
                ),
                "metadata": dict(
                    metadata or {}
                ),
            }

            append_jsonl(
                self.paths.run_journal,
                (
                    run_record,
                ),
                fsync_write=(
                    self.fsync_writes
                ),
            )

            run_appended = True

        return HistoryUpdate(
            statistics_appended=appended,
            statistics_replaced=replaced,
            provider_snapshots_added=len(
                normalized_summaries
            ),
            run_journal_appended=run_appended,
            statistics_entries=len(
                statistics_history
            ),
            provider_entries=sum(
                len(entries)
                for entries
                in provider_history.values()
            ),
        )

    def build_statistics_snapshot(
        self,
        statistics: Mapping[str, Any],
        *,
        generated_at: str | None = None,
    ) -> dict[str, Any]:
        """Build one normalized aggregate statistics snapshot."""

        timestamp = (
            normalize_space(
                generated_at
            )
            or normalize_space(
                statistics.get(
                    "last_updated"
                )
            )
            or utc_now()
        )

        snapshot: dict[str, Any] = {
            "schema_version": (
                HISTORY_SCHEMA_VERSION
            ),
            "last_updated": timestamp,
        }

        for field_name in self.tracked_fields:
            snapshot[field_name] = (
                safe_int(
                    statistics.get(
                        field_name
                    )
                )
            )

        generator = statistics.get(
            "generator"
        )

        if isinstance(
            generator,
            Mapping,
        ):
            snapshot["generator"] = {
                "name": normalize_space(
                    generator.get("name")
                ),
                "version": normalize_space(
                    generator.get("version")
                ),
            }

        count_method = normalize_space(
            statistics.get(
                "count_method"
            )
        )

        if count_method:
            snapshot[
                "count_method"
            ] = count_method

        return snapshot

    def statistics_history(
        self,
    ) -> list[dict[str, Any]]:
        """Read normalized aggregate statistics history."""

        value = read_json(
            self.paths.statistics,
            [],
        )

        if not isinstance(value, list):
            return []

        result: list[
            dict[str, Any]
        ] = []

        for item in value:
            if not isinstance(
                item,
                Mapping,
            ):
                continue

            normalized = (
                self._normalize_statistics_snapshot(
                    item
                )
            )

            if normalized:
                result.append(
                    normalized
                )

        return result

    def provider_history(
        self,
        provider: str | None = None,
    ) -> dict[
        str,
        list[dict[str, Any]],
    ] | list[dict[str, Any]]:
        """
        Read provider history.

        When provider is supplied, only that provider's retained history is
        returned.
        """

        value = read_json(
            self.paths.providers,
            {},
        )

        normalized = (
            self._normalize_provider_history(
                value
            )
        )

        if provider is None:
            return normalized

        return normalized.get(
            normalize_key(provider),
            [],
        )

    def run_history(
        self,
    ) -> Iterator[dict[str, Any]]:
        """Iterate immutable run journal entries."""

        if not self.paths.run_journal.is_file():
            return

        with self.paths.run_journal.open(
            "r",
            encoding="utf-8",
        ) as handle:
            for (
                line_number,
                line,
            ) in enumerate(
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
                    raise HistoryError(
                        "Invalid run-history JSONL in "
                        f"{self.paths.run_journal.name}:"
                        f"{line_number}: {error}"
                    ) from error

                if not isinstance(
                    value,
                    dict,
                ):
                    raise HistoryError(
                        "Run-history JSONL value is not "
                        "an object at line "
                        f"{line_number}."
                    )

                yield value

    def latest_statistics(
        self,
    ) -> dict[str, Any] | None:
        """Return the latest aggregate statistics snapshot."""

        history = self.statistics_history()

        if not history:
            return None

        return history[-1]

    def latest_provider(
        self,
        provider: str,
    ) -> dict[str, Any] | None:
        """Return the latest retained snapshot for one provider."""

        entries = self.provider_history(
            provider
        )

        assert isinstance(
            entries,
            list,
        )

        if not entries:
            return None

        return entries[-1]

    def statistics_deltas(
        self,
        *,
        field_names: Sequence[str] | None = None,
    ) -> list[dict[str, Any]]:
        """
        Return per-snapshot changes relative to the previous snapshot.
        """

        history = self.statistics_history()

        fields = tuple(
            normalize_space(field_name)
            for field_name in (
                field_names
                if field_names is not None
                else self.tracked_fields
            )
            if normalize_space(field_name)
        )

        result: list[
            dict[str, Any]
        ] = []

        previous: dict[str, Any] | None = None

        for snapshot in history:
            delta = {
                "last_updated": (
                    snapshot.get(
                        "last_updated"
                    )
                ),
                "values": {
                    field_name: safe_int(
                        snapshot.get(
                            field_name
                        )
                    )
                    for field_name in fields
                },
                "changes": {},
            }

            for field_name in fields:
                current_value = safe_int(
                    snapshot.get(
                        field_name
                    )
                )

                if previous is None:
                    change = 0
                else:
                    change = (
                        current_value
                        - safe_int(
                            previous.get(
                                field_name
                            )
                        )
                    )

                delta[
                    "changes"
                ][field_name] = change

            result.append(delta)
            previous = snapshot

        return result

    def provider_deltas(
        self,
        provider: str,
    ) -> list[dict[str, Any]]:
        """Return retained per-run changes for one provider."""

        entries = self.provider_history(
            provider
        )

        assert isinstance(
            entries,
            list,
        )

        result: list[
            dict[str, Any]
        ] = []

        previous: dict[str, Any] | None = None

        cumulative_fields = (
            "fetched",
            "created",
            "matched",
            "revised",
            "conflicted",
            "rejected",
            "requests",
        )

        for entry in entries:
            delta = {
                "generated_at": (
                    entry.get(
                        "generated_at"
                    )
                ),
                "values": {
                    field_name: entry.get(
                        field_name,
                        0,
                    )
                    for field_name
                    in self.provider_fields
                },
                "changes": {},
            }

            for field_name in cumulative_fields:
                current_value = safe_int(
                    entry.get(
                        field_name
                    )
                )

                if previous is None:
                    change = current_value
                else:
                    change = (
                        current_value
                        - safe_int(
                            previous.get(
                                field_name
                            )
                        )
                    )

                delta[
                    "changes"
                ][field_name] = change

            result.append(delta)
            previous = entry

        return result

    def trend_data(
        self,
        *,
        field_names: Sequence[str] | None = None,
    ) -> dict[str, Any]:
        """Return dashboard-ready aggregate time-series data."""

        fields = tuple(
            normalize_space(field_name)
            for field_name in (
                field_names
                if field_names is not None
                else self.tracked_fields
            )
            if normalize_space(field_name)
        )

        history = self.statistics_history()

        series: dict[
            str,
            list[dict[str, Any]],
        ] = {
            field_name: []
            for field_name in fields
        }

        for snapshot in history:
            timestamp = snapshot.get(
                "last_updated"
            )

            for field_name in fields:
                series[
                    field_name
                ].append(
                    {
                        "timestamp": timestamp,
                        "value": safe_int(
                            snapshot.get(
                                field_name
                            )
                        ),
                    }
                )

        return {
            "schema_version": (
                HISTORY_SCHEMA_VERSION
            ),
            "generated_at": utc_now(),
            "entries": len(history),
            "series": series,
        }

    def verify(self) -> HistoryVerification:
        """Verify all configured history files."""

        errors: list[str] = []
        warnings: list[str] = []

        statistics = self.statistics_history()
        providers = self.provider_history()

        assert isinstance(
            providers,
            dict,
        )

        previous_timestamp: datetime | None = None

        for index, snapshot in enumerate(
            statistics,
            start=1,
        ):
            timestamp_text = normalize_space(
                snapshot.get(
                    "last_updated"
                )
            )

            timestamp = parse_timestamp(
                timestamp_text
            )

            if timestamp is None:
                errors.append(
                    "Statistics history entry "
                    f"{index} has an invalid timestamp."
                )

            elif (
                previous_timestamp is not None
                and timestamp
                < previous_timestamp
            ):
                errors.append(
                    "Statistics history timestamps "
                    "are not monotonic at entry "
                    f"{index}."
                )

            if timestamp is not None:
                previous_timestamp = timestamp

            for field_name in self.tracked_fields:
                value = snapshot.get(
                    field_name
                )

                try:
                    parsed = int(value)
                except (
                    TypeError,
                    ValueError,
                ):
                    errors.append(
                        "Statistics history entry "
                        f"{index} has invalid "
                        f"{field_name!r}."
                    )
                    continue

                if parsed < 0:
                    errors.append(
                        "Statistics history entry "
                        f"{index} has negative "
                        f"{field_name!r}."
                    )

        for provider, entries in providers.items():
            previous_provider_time: datetime | None = None

            for index, entry in enumerate(
                entries,
                start=1,
            ):
                timestamp = parse_timestamp(
                    entry.get(
                        "generated_at"
                    )
                )

                if timestamp is None:
                    errors.append(
                        "Provider history entry "
                        f"{provider}[{index}] has an "
                        "invalid timestamp."
                    )

                elif (
                    previous_provider_time
                    is not None
                    and timestamp
                    < previous_provider_time
                ):
                    errors.append(
                        "Provider history timestamps "
                        "are not monotonic for "
                        f"{provider} at entry {index}."
                    )

                if timestamp is not None:
                    previous_provider_time = timestamp

                for field_name in self.provider_fields:
                    value = entry.get(
                        field_name
                    )

                    if (
                        field_name
                        == "duration_seconds"
                    ):
                        parsed_float = safe_float(
                            value
                        )

                        if parsed_float < 0:
                            errors.append(
                                "Provider history entry "
                                f"{provider}[{index}] has "
                                "negative duration."
                            )
                    else:
                        try:
                            parsed = int(
                                value
                            )
                        except (
                            TypeError,
                            ValueError,
                        ):
                            errors.append(
                                "Provider history entry "
                                f"{provider}[{index}] has "
                                f"invalid {field_name!r}."
                            )
                            continue

                        if parsed < 0:
                            errors.append(
                                "Provider history entry "
                                f"{provider}[{index}] has "
                                f"negative {field_name!r}."
                            )

        run_entries = 0

        if self.paths.run_journal.is_file():
            try:
                for run_entries, event in enumerate(
                    self.run_history(),
                    start=1,
                ):
                    if normalize_space(
                        event.get("event")
                    ) != "ingestion_run":
                        warnings.append(
                            "Run-history entry "
                            f"{run_entries} has an "
                            "unexpected event type."
                        )

                    if parse_timestamp(
                        event.get(
                            "generated_at"
                        )
                    ) is None:
                        errors.append(
                            "Run-history entry "
                            f"{run_entries} has an "
                            "invalid timestamp."
                        )

            except HistoryError as error:
                errors.append(
                    str(error)
                )

        if (
            self.statistics_limit > 0
            and len(statistics)
            > self.statistics_limit
        ):
            warnings.append(
                "Statistics history exceeds its "
                "configured retention limit."
            )

        provider_entries = sum(
            len(entries)
            for entries in providers.values()
        )

        for provider, entries in providers.items():
            if (
                self.provider_limit > 0
                and len(entries)
                > self.provider_limit
            ):
                warnings.append(
                    "Provider history exceeds its "
                    "configured retention limit for "
                    f"{provider}."
                )

        return HistoryVerification(
            valid=not errors,
            errors=errors,
            warnings=warnings,
            statistics_entries=len(
                statistics
            ),
            provider_entries=provider_entries,
            run_entries=run_entries,
        )

    def repair(self) -> dict[str, int]:
        """
        Normalize, sort, deduplicate, and truncate retained histories.
        """

        statistics = self.statistics_history()

        statistics.sort(
            key=lambda item: (
                parse_timestamp(
                    item.get(
                        "last_updated"
                    )
                )
                or datetime.min.replace(
                    tzinfo=UTC
                )
            )
        )

        repaired_statistics: list[
            dict[str, Any]
        ] = []

        for snapshot in statistics:
            if (
                repaired_statistics
                and self._same_statistics(
                    repaired_statistics[-1],
                    snapshot,
                )
            ):
                repaired_statistics[-1] = (
                    snapshot
                )
            else:
                repaired_statistics.append(
                    snapshot
                )

        if self.statistics_limit > 0:
            repaired_statistics = (
                repaired_statistics[
                    -self.statistics_limit:
                ]
            )

        atomic_write_json(
            self.paths.statistics,
            repaired_statistics,
        )

        providers = self.provider_history()

        assert isinstance(
            providers,
            dict,
        )

        repaired_providers: dict[
            str,
            list[dict[str, Any]],
        ] = {}

        for provider, entries in providers.items():
            entries.sort(
                key=lambda item: (
                    parse_timestamp(
                        item.get(
                            "generated_at"
                        )
                    )
                    or datetime.min.replace(
                        tzinfo=UTC
                    )
                )
            )

            deduplicated: list[
                dict[str, Any]
            ] = []

            for entry in entries:
                if (
                    deduplicated
                    and self._same_provider_entry(
                        deduplicated[-1],
                        entry,
                    )
                ):
                    deduplicated[-1] = entry
                else:
                    deduplicated.append(
                        entry
                    )

            if self.provider_limit > 0:
                deduplicated = deduplicated[
                    -self.provider_limit:
                ]

            repaired_providers[
                provider
            ] = deduplicated

        atomic_write_json(
            self.paths.providers,
            {
                "schema_version": (
                    HISTORY_SCHEMA_VERSION
                ),
                "generated_at": utc_now(),
                "providers": (
                    repaired_providers
                ),
            },
        )

        return {
            "statistics_entries": len(
                repaired_statistics
            ),
            "providers": len(
                repaired_providers
            ),
            "provider_entries": sum(
                len(entries)
                for entries
                in repaired_providers.values()
            ),
        }

    def _update_statistics_history(
        self,
        snapshot: Mapping[str, Any],
    ) -> tuple[
        list[dict[str, Any]],
        bool,
        bool,
    ]:
        """Append or replace the latest aggregate snapshot."""

        history = self.statistics_history()

        appended = False
        replaced = False

        normalized_snapshot = (
            self._normalize_statistics_snapshot(
                snapshot
            )
        )

        if not normalized_snapshot:
            raise HistoryError(
                "Statistics snapshot is invalid."
            )

        if (
            history
            and self._same_statistics(
                history[-1],
                normalized_snapshot,
            )
        ):
            history[-1] = (
                normalized_snapshot
            )
            replaced = True
        else:
            history.append(
                normalized_snapshot
            )
            appended = True

        if self.statistics_limit > 0:
            history = history[
                -self.statistics_limit:
            ]

        atomic_write_json(
            self.paths.statistics,
            history,
        )

        return (
            history,
            appended,
            replaced,
        )

    def _update_provider_history(
        self,
        summaries: Sequence[
            Mapping[str, Any]
        ],
    ) -> dict[
        str,
        list[dict[str, Any]],
    ]:
        """Append retained provider execution snapshots."""

        current = self.provider_history()

        assert isinstance(
            current,
            dict,
        )

        for summary in summaries:
            provider = normalize_key(
                summary.get(
                    "provider"
                )
            )

            if not provider:
                continue

            entries = current.setdefault(
                provider,
                [],
            )

            normalized = dict(
                summary
            )

            if (
                entries
                and self._same_provider_entry(
                    entries[-1],
                    normalized,
                )
            ):
                entries[-1] = normalized
            else:
                entries.append(
                    normalized
                )

            if self.provider_limit > 0:
                current[provider] = entries[
                    -self.provider_limit:
                ]

        atomic_write_json(
            self.paths.providers,
            {
                "schema_version": (
                    HISTORY_SCHEMA_VERSION
                ),
                "generated_at": utc_now(),
                "providers": dict(
                    sorted(
                        current.items()
                    )
                ),
            },
        )

        return current

    def _normalize_statistics_snapshot(
        self,
        value: Mapping[str, Any],
    ) -> dict[str, Any]:
        """Normalize one retained aggregate snapshot."""

        timestamp = (
            normalize_space(
                value.get(
                    "last_updated"
                )
            )
            or normalize_space(
                value.get(
                    "generated_at"
                )
            )
        )

        if not timestamp:
            return {}

        result: dict[str, Any] = {
            "schema_version": (
                HISTORY_SCHEMA_VERSION
            ),
            "last_updated": timestamp,
        }

        for field_name in self.tracked_fields:
            result[field_name] = safe_int(
                value.get(
                    field_name
                )
            )

        generator = value.get(
            "generator"
        )

        if isinstance(
            generator,
            Mapping,
        ):
            result["generator"] = {
                "name": normalize_space(
                    generator.get("name")
                ),
                "version": normalize_space(
                    generator.get("version")
                ),
            }

        count_method = normalize_space(
            value.get(
                "count_method"
            )
        )

        if count_method:
            result[
                "count_method"
            ] = count_method

        return result

    def _normalize_provider_summary(
        self,
        value: Mapping[str, Any],
        *,
        generated_at: str,
    ) -> dict[str, Any]:
        """Normalize one provider-run summary."""

        provider = normalize_key(
            value.get(
                "provider"
            )
        )

        if not provider:
            return {}

        result: dict[str, Any] = {
            "schema_version": (
                HISTORY_SCHEMA_VERSION
            ),
            "provider": provider,
            "generated_at": (
                normalize_space(
                    value.get(
                        "completed_at"
                    )
                )
                or normalize_space(
                    value.get(
                        "generated_at"
                    )
                )
                or generated_at
            ),
            "started_at": normalize_space(
                value.get(
                    "started_at"
                )
            ),
            "completed_at": normalize_space(
                value.get(
                    "completed_at"
                )
            ),
            "fetched": safe_int(
                value.get("fetched")
            ),
            "raw": safe_int(
                value.get("raw")
            ),
            "created": safe_int(
                value.get("created")
            ),
            "matched": safe_int(
                value.get("matched")
            ),
            "revised": safe_int(
                value.get("revised")
            ),
            "conflicted": safe_int(
                value.get(
                    "conflicted",
                    value.get(
                        "conflicts"
                    ),
                )
            ),
            "rejected": safe_int(
                value.get("rejected")
            ),
            "requests": safe_int(
                value.get("requests")
            ),
            "duration_seconds": safe_float(
                value.get(
                    "duration_seconds"
                )
            ),
            "exhausted": bool(
                value.get(
                    "exhausted",
                    False,
                )
            ),
            "next_cursor": (
                None
                if value.get(
                    "next_cursor"
                )
                is None
                else str(
                    value.get(
                        "next_cursor"
                    )
                )
            ),
            "error": (
                normalize_space(
                    value.get("error")
                )
                or None
            ),
        }

        return result

    def _normalize_provider_history(
        self,
        value: Any,
    ) -> dict[
        str,
        list[dict[str, Any]],
    ]:
        """Normalize provider-history file data."""

        if isinstance(value, Mapping):
            providers = value.get(
                "providers",
                value,
            )
        else:
            providers = {}

        if not isinstance(
            providers,
            Mapping,
        ):
            return {}

        result: dict[
            str,
            list[dict[str, Any]],
        ] = {}

        for provider, entries in providers.items():
            normalized_provider = normalize_key(
                provider
            )

            if (
                not normalized_provider
                or not isinstance(
                    entries,
                    list,
                )
            ):
                continue

            normalized_entries: list[
                dict[str, Any]
            ] = []

            for entry in entries:
                if not isinstance(
                    entry,
                    Mapping,
                ):
                    continue

                normalized = (
                    self._normalize_provider_summary(
                        entry,
                        generated_at=(
                            normalize_space(
                                entry.get(
                                    "generated_at"
                                )
                            )
                            or utc_now()
                        ),
                    )
                )

                if normalized:
                    normalized_entries.append(
                        normalized
                    )

            result[
                normalized_provider
            ] = normalized_entries

        return result

    @staticmethod
    def _normalize_skipped(
        skipped: Sequence[
            Mapping[str, Any]
        ],
    ) -> list[dict[str, str]]:
        """Normalize skipped-provider records."""

        result: list[
            dict[str, str]
        ] = []

        for item in skipped:
            if not isinstance(
                item,
                Mapping,
            ):
                continue

            provider = normalize_key(
                item.get(
                    "provider"
                )
            )

            if not provider:
                continue

            result.append(
                {
                    "provider": provider,
                    "reason": (
                        normalize_space(
                            item.get(
                                "reason"
                            )
                        )
                        or "unspecified"
                    ),
                }
            )

        return result

    def _same_statistics(
        self,
        left: Mapping[str, Any],
        right: Mapping[str, Any],
    ) -> bool:
        """Compare aggregate snapshots while ignoring timestamps."""

        return all(
            safe_int(
                left.get(field_name)
            )
            == safe_int(
                right.get(field_name)
            )
            for field_name in self.tracked_fields
        )

    def _same_provider_entry(
        self,
        left: Mapping[str, Any],
        right: Mapping[str, Any],
    ) -> bool:
        """Compare provider snapshots while ignoring timestamps."""

        for field_name in self.provider_fields:
            if field_name == "duration_seconds":
                if round(
                    safe_float(
                        left.get(field_name)
                    ),
                    6,
                ) != round(
                    safe_float(
                        right.get(field_name)
                    ),
                    6,
                ):
                    return False

            elif safe_int(
                left.get(field_name)
            ) != safe_int(
                right.get(field_name)
            ):
                return False

        return (
            normalize_space(
                left.get("error")
            )
            == normalize_space(
                right.get("error")
            )
            and bool(
                left.get(
                    "exhausted",
                    False,
                )
            )
            == bool(
                right.get(
                    "exhausted",
                    False,
                )
            )
            and str(
                left.get(
                    "next_cursor",
                    "",
                )
            )
            == str(
                right.get(
                    "next_cursor",
                    "",
                )
            )
        )


def update_history(
    *,
    data_root: Path,
    statistics: Mapping[str, Any],
    provider_summaries: Sequence[
        Mapping[str, Any]
    ] | None = None,
    skipped_providers: Sequence[
        Mapping[str, Any]
    ] | None = None,
    history_limit: int = (
        DEFAULT_HISTORY_LIMIT
    ),
    provider_history_limit: int = (
        DEFAULT_PROVIDER_HISTORY_LIMIT
    ),
    metadata: Mapping[str, Any] | None = None,
) -> HistoryUpdate:
    """Convenience wrapper used by stat-grabber.py."""

    manager = HistoryManager(
        data_root,
        statistics_limit=history_limit,
        provider_limit=(
            provider_history_limit
        ),
    )

    return manager.update(
        statistics=statistics,
        provider_summaries=(
            provider_summaries
        ),
        skipped_providers=(
            skipped_providers
        ),
        metadata=metadata,
    )
