#!/usr/bin/env python3
"""
Speciedex.org
static/tools/core/scheduler.py

Persistent provider scheduler for the Speciedex ingestion system.

This module is responsible for:

- rotating eligible providers fairly,
- preserving scheduler state between runs,
- honoring explicit provider selections,
- honoring --all-providers,
- enforcing provider budgets,
- optionally respecting per-provider intervals,
- tracking provider success and failure state,
- applying failure backoff,
- preventing unhealthy providers from monopolizing scan time,
- producing deterministic scheduler metadata.

The scheduler does not load or execute providers. It only decides which
provider definitions should run during the current invocation.

Copyright (c) 2026 ZZX-Laboratories

Licensed under the MIT License.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from .archive import (
    normalize_key,
    normalize_space,
    now,
    read_json,
    write_json,
)


SCHEDULER_SCHEMA_VERSION = 1

DEFAULT_PROVIDER_BUDGET = 4
DEFAULT_INTERVAL_MINUTES = 15
DEFAULT_FAILURE_BACKOFF_MINUTES = 30
DEFAULT_MAX_FAILURE_BACKOFF_MINUTES = 24 * 60
DEFAULT_MAX_CONSECUTIVE_FAILURES = 10


def utc_now() -> datetime:
    """Return the current timezone-aware UTC datetime."""

    return datetime.now(
        UTC
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


@dataclass(slots=True)
class ProviderScheduleState:
    """Persistent scheduling state for one provider."""

    provider: str
    last_selected: str = ""
    last_success: str = ""
    last_failure: str = ""
    next_due: str = ""
    consecutive_failures: int = 0
    total_runs: int = 0
    total_successes: int = 0
    total_failures: int = 0
    last_error: str = ""
    last_duration_seconds: float | None = None
    average_duration_seconds: float | None = None
    last_records: int = 0
    total_records: int = 0
    total_requests: int = 0

    @classmethod
    def from_dict(
        cls,
        provider: str,
        value: Any,
    ) -> ProviderScheduleState:
        """Build state from a JSON object."""

        if not isinstance(
            value,
            Mapping,
        ):
            value = {}

        return cls(
            provider=provider,
            last_selected=normalize_space(
                value.get(
                    "last_selected"
                )
            ),
            last_success=normalize_space(
                value.get(
                    "last_success"
                )
            ),
            last_failure=normalize_space(
                value.get(
                    "last_failure"
                )
            ),
            next_due=normalize_space(
                value.get(
                    "next_due"
                )
            ),
            consecutive_failures=max(
                0,
                _safe_int(
                    value.get(
                        "consecutive_failures"
                    )
                ),
            ),
            total_runs=max(
                0,
                _safe_int(
                    value.get(
                        "total_runs"
                    )
                ),
            ),
            total_successes=max(
                0,
                _safe_int(
                    value.get(
                        "total_successes"
                    )
                ),
            ),
            total_failures=max(
                0,
                _safe_int(
                    value.get(
                        "total_failures"
                    )
                ),
            ),
            last_error=normalize_space(
                value.get(
                    "last_error"
                )
            ),
            last_duration_seconds=(
                _safe_float_or_none(
                    value.get(
                        "last_duration_seconds"
                    )
                )
            ),
            average_duration_seconds=(
                _safe_float_or_none(
                    value.get(
                        "average_duration_seconds"
                    )
                )
            ),
            last_records=max(
                0,
                _safe_int(
                    value.get(
                        "last_records"
                    )
                ),
            ),
            total_records=max(
                0,
                _safe_int(
                    value.get(
                        "total_records"
                    )
                ),
            ),
            total_requests=max(
                0,
                _safe_int(
                    value.get(
                        "total_requests"
                    )
                ),
            ),
        )

    def to_dict(
        self,
    ) -> dict[str, Any]:
        """Return JSON-compatible provider state."""

        return {
            "provider": self.provider,
            "last_selected": self.last_selected,
            "last_success": self.last_success,
            "last_failure": self.last_failure,
            "next_due": self.next_due,
            "consecutive_failures": (
                self.consecutive_failures
            ),
            "total_runs": self.total_runs,
            "total_successes": (
                self.total_successes
            ),
            "total_failures": (
                self.total_failures
            ),
            "last_error": self.last_error,
            "last_duration_seconds": (
                self.last_duration_seconds
            ),
            "average_duration_seconds": (
                self.average_duration_seconds
            ),
            "last_records": self.last_records,
            "total_records": self.total_records,
            "total_requests": self.total_requests,
        }


@dataclass(slots=True)
class SchedulerState:
    """Persistent global scheduler state."""

    cursor: int = 0
    updated_at: str = ""
    registered: int = 0
    eligible: int = 0
    last_selection: list[str] = field(
        default_factory=list
    )
    providers: dict[
        str,
        ProviderScheduleState,
    ] = field(
        default_factory=dict
    )

    @classmethod
    def from_dict(
        cls,
        value: Any,
    ) -> SchedulerState:
        """Build scheduler state from JSON."""

        if not isinstance(
            value,
            Mapping,
        ):
            value = {}

        raw_providers = value.get(
            "providers"
        )

        providers: dict[
            str,
            ProviderScheduleState,
        ] = {}

        if isinstance(
            raw_providers,
            Mapping,
        ):
            for name, provider_state in (
                raw_providers.items()
            ):
                normalized_name = normalize_key(
                    name
                )

                if not normalized_name:
                    continue

                providers[
                    normalized_name
                ] = (
                    ProviderScheduleState.from_dict(
                        normalized_name,
                        provider_state,
                    )
                )

        raw_selection = value.get(
            "last_selection"
        )

        if not isinstance(
            raw_selection,
            list,
        ):
            raw_selection = []

        return cls(
            cursor=max(
                0,
                _safe_int(
                    value.get(
                        "cursor"
                    )
                ),
            ),
            updated_at=normalize_space(
                value.get(
                    "updated_at"
                )
            ),
            registered=max(
                0,
                _safe_int(
                    value.get(
                        "registered"
                    )
                ),
            ),
            eligible=max(
                0,
                _safe_int(
                    value.get(
                        "eligible"
                    )
                ),
            ),
            last_selection=[
                normalize_key(
                    item
                )
                for item in raw_selection
                if normalize_key(item)
            ],
            providers=providers,
        )

    def to_dict(
        self,
    ) -> dict[str, Any]:
        """Return JSON-compatible scheduler state."""

        return {
            "schema_version": (
                SCHEDULER_SCHEMA_VERSION
            ),
            "cursor": self.cursor,
            "updated_at": self.updated_at,
            "registered": self.registered,
            "eligible": self.eligible,
            "last_selection": list(
                self.last_selection
            ),
            "providers": {
                name: state.to_dict()
                for name, state in sorted(
                    self.providers.items()
                )
            },
        }


@dataclass(slots=True)
class SchedulerSelection:
    """Result returned by the scheduler."""

    selected: list[
        dict[str, Any]
    ]
    deferred: list[
        dict[str, Any]
    ]
    skipped: list[
        dict[str, Any]
    ]
    cursor_before: int
    cursor_after: int
    budget: int

    @property
    def selected_names(
        self,
    ) -> list[str]:
        """Return selected provider names."""

        return [
            str(
                definition.get(
                    "name",
                    ""
                )
            )
            for definition in self.selected
        ]

    def to_dict(
        self,
    ) -> dict[str, Any]:
        """Return JSON-compatible selection data."""

        return {
            "selected": self.selected_names,
            "deferred": list(
                self.deferred
            ),
            "skipped": list(
                self.skipped
            ),
            "cursor_before": (
                self.cursor_before
            ),
            "cursor_after": (
                self.cursor_after
            ),
            "budget": self.budget,
        }


class Scheduler:
    """
    Persistent rotating provider scheduler.

    Provider definitions may optionally include:

        "interval_minutes": 15
        "priority": 100
        "failure_backoff_minutes": 30
        "max_failure_backoff_minutes": 1440
        "max_consecutive_failures": 10
        "schedule_enabled": true

    Providers without these fields remain compatible with the original simple
    round-robin scheduler.
    """

    def __init__(
        self,
        state_path: Path,
        *,
        default_budget: int = (
            DEFAULT_PROVIDER_BUDGET
        ),
        default_interval_minutes: int = (
            DEFAULT_INTERVAL_MINUTES
        ),
        default_failure_backoff_minutes: int = (
            DEFAULT_FAILURE_BACKOFF_MINUTES
        ),
        default_max_failure_backoff_minutes: int = (
            DEFAULT_MAX_FAILURE_BACKOFF_MINUTES
        ),
        default_max_consecutive_failures: int = (
            DEFAULT_MAX_CONSECUTIVE_FAILURES
        ),
    ) -> None:
        if default_budget < 1:
            raise ValueError(
                "default_budget must be positive."
            )

        if default_interval_minutes < 0:
            raise ValueError(
                "default_interval_minutes cannot "
                "be negative."
            )

        self.state_path = Path(
            state_path
        )

        self.default_budget = int(
            default_budget
        )

        self.default_interval_minutes = int(
            default_interval_minutes
        )

        self.default_failure_backoff_minutes = max(
            1,
            int(
                default_failure_backoff_minutes
            ),
        )

        self.default_max_failure_backoff_minutes = max(
            self.default_failure_backoff_minutes,
            int(
                default_max_failure_backoff_minutes
            ),
        )

        self.default_max_consecutive_failures = max(
            1,
            int(
                default_max_consecutive_failures
            ),
        )

        self.state = SchedulerState.from_dict(
            read_json(
                self.state_path,
                {},
            )
        )

    def select(
        self,
        definitions: Sequence[
            Mapping[str, Any]
        ],
        eligible: Sequence[
            Mapping[str, Any]
        ],
        *,
        requested: Iterable[str] | None = None,
        all_providers: bool = False,
        budget: int | None = None,
        current_time: datetime | None = None,
    ) -> SchedulerSelection:
        """
        Select providers for the current scan.

        Explicitly requested providers and --all-providers bypass interval and
        backoff scheduling. Normal scheduled runs select due providers first,
        then use deterministic round-robin ordering within the configured
        budget.
        """

        current = (
            current_time.astimezone(UTC)
            if current_time is not None
            else utc_now()
        )

        requested_names = {
            normalize_key(name)
            for name in (
                requested or []
            )
            if normalize_key(name)
        }

        effective_budget = (
            self.default_budget
            if budget is None
            else int(budget)
        )

        if effective_budget < 1:
            raise ValueError(
                "scheduler budget must be positive."
            )

        normalized_eligible = (
            self._normalize_definitions(
                eligible
            )
        )

        registered_count = len(
            definitions
        )

        eligible_count = len(
            normalized_eligible
        )

        cursor_before = (
            self.state.cursor
            % eligible_count
            if eligible_count
            else 0
        )

        deferred: list[
            dict[str, Any]
        ] = []

        skipped: list[
            dict[str, Any]
        ] = []

        if not normalized_eligible:
            self.state.cursor = 0
            self.state.updated_at = now()
            self.state.registered = (
                registered_count
            )
            self.state.eligible = 0
            self.state.last_selection = []
            self.save()

            return SchedulerSelection(
                selected=[],
                deferred=[],
                skipped=[],
                cursor_before=cursor_before,
                cursor_after=0,
                budget=effective_budget,
            )

        if requested_names:
            selected = [
                definition
                for definition
                in normalized_eligible
                if normalize_key(
                    definition.get(
                        "name"
                    )
                )
                in requested_names
            ]

            available_names = {
                normalize_key(
                    definition.get(
                        "name"
                    )
                )
                for definition
                in normalized_eligible
            }

            for requested_name in sorted(
                requested_names
                - available_names
            ):
                skipped.append(
                    {
                        "provider": requested_name,
                        "reason": (
                            "requested provider is not "
                            "eligible"
                        ),
                    }
                )

            cursor_after = (
                self._cursor_after_selection(
                    normalized_eligible,
                    selected,
                    cursor_before,
                )
            )

        elif all_providers:
            selected = list(
                normalized_eligible
            )

            cursor_after = (
                cursor_before
            )

        else:
            due: list[
                dict[str, Any]
            ] = []

            ordered = self._round_robin_order(
                normalized_eligible,
                cursor_before,
            )

            for definition in ordered:
                name = normalize_key(
                    definition.get(
                        "name"
                    )
                )

                reason = self._defer_reason(
                    definition,
                    current,
                )

                if reason:
                    deferred.append(
                        {
                            "provider": name,
                            "reason": reason,
                            "next_due": (
                                self._provider_state(
                                    name
                                ).next_due
                            ),
                        }
                    )
                    continue

                due.append(
                    definition
                )

            due.sort(
                key=lambda definition: (
                    -self._priority(
                        definition
                    ),
                    self._round_robin_index(
                        normalized_eligible,
                        cursor_before,
                        normalize_key(
                            definition.get(
                                "name"
                            )
                        ),
                    ),
                )
            )

            selected = due[
                : min(
                    effective_budget,
                    len(due),
                )
            ]

            cursor_after = (
                self._cursor_after_selection(
                    normalized_eligible,
                    selected,
                    cursor_before,
                )
            )

        selected_names = [
            normalize_key(
                definition.get(
                    "name"
                )
            )
            for definition in selected
        ]

        selected_at = (
            current.replace(
                microsecond=0
            )
            .isoformat()
            .replace(
                "+00:00",
                "Z",
            )
        )

        for definition in selected:
            name = normalize_key(
                definition.get(
                    "name"
                )
            )

            state = self._provider_state(
                name
            )

            state.last_selected = (
                selected_at
            )

            state.next_due = (
                self._next_due_timestamp(
                    definition,
                    current,
                    state,
                    successful=None,
                )
            )

        self.state.cursor = (
            cursor_after
        )

        self.state.updated_at = (
            selected_at
        )

        self.state.registered = (
            registered_count
        )

        self.state.eligible = (
            eligible_count
        )

        self.state.last_selection = (
            selected_names
        )

        self.save()

        return SchedulerSelection(
            selected=[
                dict(definition)
                for definition in selected
            ],
            deferred=deferred,
            skipped=skipped,
            cursor_before=cursor_before,
            cursor_after=cursor_after,
            budget=effective_budget,
        )

    def record_success(
        self,
        definition: Mapping[str, Any],
        *,
        fetched: int = 0,
        requests: int = 0,
        duration_seconds: float | None = None,
        completed_at: datetime | None = None,
    ) -> None:
        """Record a successful provider execution."""

        name = normalize_key(
            definition.get(
                "name"
            )
        )

        if not name:
            raise ValueError(
                "Provider definition has no name."
            )

        current = (
            completed_at.astimezone(UTC)
            if completed_at is not None
            else utc_now()
        )

        timestamp = (
            current.replace(
                microsecond=0
            )
            .isoformat()
            .replace(
                "+00:00",
                "Z",
            )
        )

        state = self._provider_state(
            name
        )

        state.last_success = timestamp
        state.last_error = ""
        state.consecutive_failures = 0
        state.total_runs += 1
        state.total_successes += 1
        state.last_records = max(
            0,
            _safe_int(
                fetched
            ),
        )
        state.total_records += (
            state.last_records
        )
        state.total_requests += max(
            0,
            _safe_int(
                requests
            ),
        )

        if duration_seconds is not None:
            duration = max(
                0.0,
                float(
                    duration_seconds
                ),
            )

            state.last_duration_seconds = (
                duration
            )

            previous_count = (
                state.total_successes
                - 1
            )

            if (
                state.average_duration_seconds
                is None
                or previous_count <= 0
            ):
                state.average_duration_seconds = (
                    duration
                )
            else:
                previous_average = (
                    state.average_duration_seconds
                )

                state.average_duration_seconds = (
                    (
                        previous_average
                        * previous_count
                    )
                    + duration
                ) / state.total_successes

        state.next_due = (
            self._next_due_timestamp(
                definition,
                current,
                state,
                successful=True,
            )
        )

        self.state.updated_at = (
            timestamp
        )

        self.save()

    def record_failure(
        self,
        definition: Mapping[str, Any],
        error: Exception | str,
        *,
        requests: int = 0,
        duration_seconds: float | None = None,
        completed_at: datetime | None = None,
    ) -> None:
        """Record a failed provider execution and apply backoff."""

        name = normalize_key(
            definition.get(
                "name"
            )
        )

        if not name:
            raise ValueError(
                "Provider definition has no name."
            )

        current = (
            completed_at.astimezone(UTC)
            if completed_at is not None
            else utc_now()
        )

        timestamp = (
            current.replace(
                microsecond=0
            )
            .isoformat()
            .replace(
                "+00:00",
                "Z",
            )
        )

        state = self._provider_state(
            name
        )

        state.last_failure = timestamp
        state.last_error = normalize_space(
            error
        )
        state.consecutive_failures += 1
        state.total_runs += 1
        state.total_failures += 1
        state.total_requests += max(
            0,
            _safe_int(
                requests
            ),
        )

        if duration_seconds is not None:
            state.last_duration_seconds = max(
                0.0,
                float(
                    duration_seconds
                ),
            )

        state.next_due = (
            self._next_due_timestamp(
                definition,
                current,
                state,
                successful=False,
            )
        )

        self.state.updated_at = (
            timestamp
        )

        self.save()

    def reset_provider(
        self,
        provider: str,
    ) -> None:
        """Remove persistent scheduler state for one provider."""

        name = normalize_key(
            provider
        )

        if not name:
            return

        self.state.providers.pop(
            name,
            None,
        )

        self.state.updated_at = now()

        self.save()

    def provider_state(
        self,
        provider: str,
    ) -> dict[str, Any]:
        """Return a provider scheduler state object."""

        name = normalize_key(
            provider
        )

        if not name:
            return {}

        return self._provider_state(
            name
        ).to_dict()

    def save(
        self,
    ) -> None:
        """Persist scheduler state atomically."""

        write_json(
            self.state_path,
            self.state.to_dict(),
        )

    def _defer_reason(
        self,
        definition: Mapping[str, Any],
        current: datetime,
    ) -> str:
        """Return a scheduling defer reason or an empty string."""

        if not self._schedule_enabled(
            definition
        ):
            return (
                "provider scheduling is disabled"
            )

        name = normalize_key(
            definition.get(
                "name"
            )
        )

        state = self._provider_state(
            name
        )

        maximum_failures = max(
            1,
            _safe_int(
                definition.get(
                    "max_consecutive_failures"
                ),
                self.default_max_consecutive_failures,
            ),
        )

        if (
            state.consecutive_failures
            >= maximum_failures
        ):
            next_due = parse_timestamp(
                state.next_due
            )

            if (
                next_due is not None
                and current < next_due
            ):
                return (
                    "provider is in extended failure "
                    "backoff"
                )

        next_due = parse_timestamp(
            state.next_due
        )

        if (
            next_due is not None
            and current < next_due
        ):
            return (
                "provider is not due yet"
            )

        return ""

    def _next_due_timestamp(
        self,
        definition: Mapping[str, Any],
        current: datetime,
        state: ProviderScheduleState,
        *,
        successful: bool | None,
    ) -> str:
        """Calculate the next due time."""

        if successful is False:
            base_backoff = max(
                1,
                _safe_int(
                    definition.get(
                        "failure_backoff_minutes"
                    ),
                    self.default_failure_backoff_minutes,
                ),
            )

            maximum_backoff = max(
                base_backoff,
                _safe_int(
                    definition.get(
                        "max_failure_backoff_minutes"
                    ),
                    self.default_max_failure_backoff_minutes,
                ),
            )

            exponent = max(
                0,
                state.consecutive_failures
                - 1,
            )

            backoff_minutes = min(
                maximum_backoff,
                base_backoff
                * int(
                    math.pow(
                        2,
                        exponent,
                    )
                ),
            )

            due = current + timedelta(
                minutes=backoff_minutes
            )

        else:
            interval_minutes = max(
                0,
                _safe_int(
                    definition.get(
                        "interval_minutes"
                    ),
                    self.default_interval_minutes,
                ),
            )

            due = current + timedelta(
                minutes=interval_minutes
            )

        return (
            due.replace(
                microsecond=0
            )
            .isoformat()
            .replace(
                "+00:00",
                "Z",
            )
        )

    def _provider_state(
        self,
        provider: str,
    ) -> ProviderScheduleState:
        """Return or create provider state."""

        normalized = normalize_key(
            provider
        )

        if not normalized:
            raise ValueError(
                "Provider name is empty."
            )

        state = self.state.providers.get(
            normalized
        )

        if state is None:
            state = ProviderScheduleState(
                provider=normalized
            )

            self.state.providers[
                normalized
            ] = state

        return state

    @staticmethod
    def _normalize_definitions(
        definitions: Sequence[
            Mapping[str, Any]
        ],
    ) -> list[dict[str, Any]]:
        """Normalize and deduplicate provider definitions."""

        result: list[
            dict[str, Any]
        ] = []

        seen: set[str] = set()

        for definition in definitions:
            if not isinstance(
                definition,
                Mapping,
            ):
                continue

            name = normalize_key(
                definition.get(
                    "name"
                )
            )

            if (
                not name
                or name in seen
            ):
                continue

            normalized = dict(
                definition
            )

            normalized["name"] = name

            seen.add(
                name
            )

            result.append(
                normalized
            )

        return result

    @staticmethod
    def _round_robin_order(
        definitions: Sequence[
            dict[str, Any]
        ],
        cursor: int,
    ) -> list[dict[str, Any]]:
        """Return definitions rotated from the cursor."""

        if not definitions:
            return []

        offset = cursor % len(
            definitions
        )

        return [
            *definitions[offset:],
            *definitions[:offset],
        ]

    @staticmethod
    def _round_robin_index(
        definitions: Sequence[
            Mapping[str, Any]
        ],
        cursor: int,
        provider: str,
    ) -> int:
        """Return provider position in current round-robin order."""

        ordered = Scheduler._round_robin_order(
            [
                dict(definition)
                for definition in definitions
            ],
            cursor,
        )

        for index, definition in enumerate(
            ordered
        ):
            if normalize_key(
                definition.get(
                    "name"
                )
            ) == provider:
                return index

        return len(
            ordered
        )

    @staticmethod
    def _cursor_after_selection(
        eligible: Sequence[
            Mapping[str, Any]
        ],
        selected: Sequence[
            Mapping[str, Any]
        ],
        cursor_before: int,
    ) -> int:
        """Advance the cursor past the final selected provider."""

        if not eligible:
            return 0

        if not selected:
            return (
                cursor_before + 1
            ) % len(
                eligible
            )

        eligible_names = [
            normalize_key(
                definition.get(
                    "name"
                )
            )
            for definition in eligible
        ]

        last_selected = normalize_key(
            selected[-1].get(
                "name"
            )
        )

        try:
            absolute_index = (
                eligible_names.index(
                    last_selected
                )
            )
        except ValueError:
            return (
                cursor_before
            )

        return (
            absolute_index + 1
        ) % len(
            eligible
        )

    @staticmethod
    def _priority(
        definition: Mapping[str, Any],
    ) -> int:
        """Return provider scheduling priority."""

        return _safe_int(
            definition.get(
                "priority"
            ),
            0,
        )

    @staticmethod
    def _schedule_enabled(
        definition: Mapping[str, Any],
    ) -> bool:
        """Return whether automatic scheduling is enabled."""

        value = definition.get(
            "schedule_enabled",
            True,
        )

        if isinstance(
            value,
            bool,
        ):
            return value

        return normalize_key(
            value
        ) not in {
            "0",
            "false",
            "no",
            "off",
            "disabled",
        }


def _safe_int(
    value: Any,
    default: int = 0,
) -> int:
    """Convert a value to an integer."""

    try:
        return int(
            value
        )
    except (
        TypeError,
        ValueError,
    ):
        return int(
            default
        )


def _safe_float_or_none(
    value: Any,
) -> float | None:
    """Convert an optional numeric value to float."""

    if value in (
        None,
        "",
    ):
        return None

    try:
        return float(
            value
        )
    except (
        TypeError,
        ValueError,
    ):
        return None


def select_providers(
    *,
    scheduler_path: Path,
    definitions: Sequence[
        Mapping[str, Any]
    ],
    eligible: Sequence[
        Mapping[str, Any]
    ],
    requested: Iterable[str] | None = None,
    all_providers: bool = False,
    provider_budget: int = (
        DEFAULT_PROVIDER_BUDGET
    ),
) -> SchedulerSelection:
    """
    Compatibility helper for stat-grabber.py.

    It creates the scheduler, performs one selection, and persists state.
    """

    scheduler = Scheduler(
        scheduler_path,
        default_budget=provider_budget,
    )

    return scheduler.select(
        definitions=definitions,
        eligible=eligible,
        requested=requested,
        all_providers=all_providers,
        budget=provider_budget,
    )
