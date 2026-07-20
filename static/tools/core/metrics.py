#!/usr/bin/env python3
"""
Speciedex.org
static/tools/core/metrics.py

Runtime metrics, counters, timers, gauges, histograms, provider statistics,
ingestion summaries, and machine-readable metrics export.

This module owns:

- counters,
- gauges,
- timers,
- histograms,
- provider-run metrics,
- archive-write metrics,
- reconciliation metrics,
- validation metrics,
- cache metrics,
- scheduler metrics,
- rolling runtime summaries,
- JSON metrics export,
- Prometheus text export,
- thread-safe metric updates,
- timing context managers,
- metric snapshots,
- metric merging,
- process-wide default registry helpers.

Metrics are operational telemetry only. They are not the authoritative source
for archive statistics. Canonical counts remain owned by statistics.py and the
SQLite index.

Copyright (c) 2026 ZZX-Laboratories

Licensed under the MIT License.
"""

from __future__ import annotations

import json
import math
import os
import resource
import tempfile
import threading
import time
from collections import defaultdict
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, MutableMapping, Sequence


METRICS_SCHEMA_VERSION = 1

METRIC_COUNTER = "counter"
METRIC_GAUGE = "gauge"
METRIC_HISTOGRAM = "histogram"
METRIC_TIMER = "timer"

VALID_METRIC_TYPES = {
    METRIC_COUNTER,
    METRIC_GAUGE,
    METRIC_HISTOGRAM,
    METRIC_TIMER,
}

DEFAULT_HISTOGRAM_BUCKETS = (
    0.001,
    0.005,
    0.01,
    0.025,
    0.05,
    0.1,
    0.25,
    0.5,
    1.0,
    2.5,
    5.0,
    10.0,
    30.0,
    60.0,
    120.0,
    300.0,
)

DEFAULT_LATENCY_BUCKETS = (
    0.01,
    0.05,
    0.1,
    0.25,
    0.5,
    1.0,
    2.5,
    5.0,
    10.0,
    30.0,
    60.0,
)

DEFAULT_BATCH_BUCKETS = (
    1.0,
    10.0,
    25.0,
    50.0,
    100.0,
    200.0,
    500.0,
    1_000.0,
    5_000.0,
    10_000.0,
)

PROMETHEUS_PREFIX = "speciedex"


class MetricsError(RuntimeError):
    """Raised when metrics operations cannot complete safely."""


class MetricsConfigurationError(MetricsError):
    """Raised when a metric definition is invalid."""


@dataclass(slots=True, frozen=True)
class MetricIdentity:
    """Normalized metric identity."""

    name: str
    labels: tuple[tuple[str, str], ...] = ()

    def label_dict(self) -> dict[str, str]:
        """Return labels as a dictionary."""

        return dict(self.labels)

    def key(self) -> str:
        """Return a deterministic in-memory key."""

        if not self.labels:
            return self.name

        label_text = ",".join(
            f"{key}={value}"
            for key, value in self.labels
        )

        return f"{self.name}{{{label_text}}}"


@dataclass(slots=True)
class CounterValue:
    """Monotonic counter value."""

    value: float = 0.0
    updated_at: float = field(
        default_factory=time.time
    )

    def increment(
        self,
        amount: float = 1.0,
    ) -> float:
        """Increase the counter."""

        parsed = float(amount)

        if parsed < 0:
            raise MetricsError(
                "Counter increments cannot be negative."
            )

        self.value += parsed
        self.updated_at = time.time()

        return self.value


@dataclass(slots=True)
class GaugeValue:
    """Mutable gauge value."""

    value: float = 0.0
    updated_at: float = field(
        default_factory=time.time
    )

    def set(
        self,
        value: float,
    ) -> float:
        """Set the gauge value."""

        self.value = float(value)
        self.updated_at = time.time()

        return self.value

    def increment(
        self,
        amount: float = 1.0,
    ) -> float:
        """Increase the gauge."""

        self.value += float(amount)
        self.updated_at = time.time()

        return self.value

    def decrement(
        self,
        amount: float = 1.0,
    ) -> float:
        """Decrease the gauge."""

        self.value -= float(amount)
        self.updated_at = time.time()

        return self.value


@dataclass(slots=True)
class HistogramValue:
    """Histogram state."""

    buckets: tuple[float, ...]
    bucket_counts: list[int]
    count: int = 0
    total: float = 0.0
    minimum: float | None = None
    maximum: float | None = None
    updated_at: float = field(
        default_factory=time.time
    )

    @classmethod
    def create(
        cls,
        buckets: Sequence[float],
    ) -> HistogramValue:
        """Create an empty histogram."""

        normalized = tuple(
            sorted(
                {
                    float(bucket)
                    for bucket in buckets
                    if math.isfinite(
                        float(bucket)
                    )
                }
            )
        )

        if not normalized:
            raise MetricsConfigurationError(
                "Histogram requires at least one finite bucket."
            )

        return cls(
            buckets=normalized,
            bucket_counts=[
                0
                for _bucket
                in normalized
            ],
        )

    def observe(
        self,
        value: float,
    ) -> None:
        """Observe one histogram value."""

        parsed = float(value)

        if not math.isfinite(parsed):
            raise MetricsError(
                "Histogram observations must be finite."
            )

        self.count += 1
        self.total += parsed
        self.updated_at = time.time()

        if (
            self.minimum is None
            or parsed < self.minimum
        ):
            self.minimum = parsed

        if (
            self.maximum is None
            or parsed > self.maximum
        ):
            self.maximum = parsed

        for index, bucket in enumerate(
            self.buckets
        ):
            if parsed <= bucket:
                self.bucket_counts[index] += 1

    @property
    def mean(self) -> float:
        """Return arithmetic mean."""

        if self.count <= 0:
            return 0.0

        return self.total / self.count

    def percentile(
        self,
        percentile: float,
    ) -> float:
        """
        Estimate a percentile using configured bucket boundaries.
        """

        if self.count <= 0:
            return 0.0

        parsed = min(
            100.0,
            max(
                0.0,
                float(percentile),
            ),
        )

        target = max(
            1,
            math.ceil(
                self.count
                * parsed
                / 100.0
            ),
        )

        for bucket, count in zip(
            self.buckets,
            self.bucket_counts,
        ):
            if count >= target:
                return bucket

        return (
            self.maximum
            if self.maximum is not None
            else 0.0
        )

    def to_dict(self) -> dict[str, Any]:
        """Return JSON-compatible histogram data."""

        return {
            "count": self.count,
            "sum": self.total,
            "mean": self.mean,
            "minimum": self.minimum,
            "maximum": self.maximum,
            "p50": self.percentile(50.0),
            "p90": self.percentile(90.0),
            "p95": self.percentile(95.0),
            "p99": self.percentile(99.0),
            "buckets": [
                {
                    "le": bucket,
                    "count": count,
                }
                for bucket, count
                in zip(
                    self.buckets,
                    self.bucket_counts,
                )
            ],
            "updated_at": self.updated_at,
        }


@dataclass(slots=True)
class MetricDefinition:
    """Metric schema entry."""

    name: str
    metric_type: str
    description: str = ""
    unit: str = ""
    buckets: tuple[float, ...] = ()

    def __post_init__(self) -> None:
        normalized_type = normalize_key(
            self.metric_type
        )

        if normalized_type not in VALID_METRIC_TYPES:
            raise MetricsConfigurationError(
                "Unsupported metric type: "
                f"{self.metric_type!r}."
            )

        self.metric_type = normalized_type
        self.name = normalize_metric_name(
            self.name
        )
        self.description = normalize_space(
            self.description
        )
        self.unit = normalize_key(
            self.unit
        )

        if (
            self.metric_type
            in {
                METRIC_HISTOGRAM,
                METRIC_TIMER,
            }
            and not self.buckets
        ):
            self.buckets = (
                DEFAULT_HISTOGRAM_BUCKETS
            )


@dataclass(slots=True)
class MetricsSnapshot:
    """Immutable registry snapshot."""

    generated_at: str
    counters: dict[str, dict[str, Any]]
    gauges: dict[str, dict[str, Any]]
    histograms: dict[str, dict[str, Any]]
    definitions: dict[str, dict[str, Any]]
    process: dict[str, Any]
    metadata: dict[str, Any] = field(
        default_factory=dict
    )

    def to_dict(self) -> dict[str, Any]:
        """Return JSON-compatible snapshot data."""

        return {
            "schema_version": (
                METRICS_SCHEMA_VERSION
            ),
            "generated_at": self.generated_at,
            "counters": dict(
                self.counters
            ),
            "gauges": dict(
                self.gauges
            ),
            "histograms": dict(
                self.histograms
            ),
            "definitions": dict(
                self.definitions
            ),
            "process": dict(
                self.process
            ),
            "metadata": dict(
                self.metadata
            ),
        }


@dataclass(slots=True)
class TimerResult:
    """Completed timer result."""

    name: str
    labels: dict[str, str]
    seconds: float
    started_at: float
    finished_at: float

    def to_dict(self) -> dict[str, Any]:
        """Return JSON-compatible timer data."""

        return {
            "name": self.name,
            "labels": dict(
                self.labels
            ),
            "seconds": self.seconds,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
        }


@dataclass(slots=True)
class ProviderRunMetrics:
    """Summary of one provider run."""

    provider: str
    fetched: int = 0
    created: int = 0
    matched: int = 0
    revised: int = 0
    conflicts: int = 0
    rejected: int = 0
    requests: int = 0
    raw: int = 0
    duration_seconds: float = 0.0
    success: bool = True
    error: str = ""
    exhausted: bool = False
    next_cursor: str | None = None
    started_at: str = ""
    finished_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        """Return JSON-compatible provider metrics."""

        return {
            "provider": self.provider,
            "fetched": self.fetched,
            "created": self.created,
            "matched": self.matched,
            "revised": self.revised,
            "conflicts": self.conflicts,
            "rejected": self.rejected,
            "requests": self.requests,
            "raw": self.raw,
            "duration_seconds": round(
                self.duration_seconds,
                6,
            ),
            "success": self.success,
            "error": self.error,
            "exhausted": self.exhausted,
            "next_cursor": self.next_cursor,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
        }


def utc_now() -> str:
    """Return the current UTC timestamp."""

    return (
        datetime.now(UTC)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def normalize_space(
    value: Any,
) -> str:
    """Collapse surrounding and repeated whitespace."""

    return " ".join(
        str(
            value
            if value is not None
            else ""
        ).strip().split()
    )


def normalize_key(
    value: Any,
) -> str:
    """Normalize text for comparisons."""

    return normalize_space(
        value
    ).casefold()


def normalize_metric_name(
    value: Any,
) -> str:
    """Normalize a metric name for JSON and Prometheus export."""

    text = normalize_key(
        value
    )

    normalized = "".join(
        character
        if (
            character.isalnum()
            or character
            in {
                "_",
                ":",
            }
        )
        else "_"
        for character in text
    )

    while "__" in normalized:
        normalized = normalized.replace(
            "__",
            "_",
        )

    normalized = normalized.strip(
        "_"
    )

    if not normalized:
        raise MetricsConfigurationError(
            "Metric name cannot be empty."
        )

    if normalized[0].isdigit():
        normalized = (
            "_"
            + normalized
        )

    return normalized


def normalize_labels(
    labels: Mapping[
        str,
        Any,
    ] | None,
) -> tuple[tuple[str, str], ...]:
    """Normalize and sort metric labels."""

    if not labels:
        return ()

    normalized: list[
        tuple[str, str]
    ] = []

    for key, value in labels.items():
        label_name = (
            normalize_metric_name(
                key
            )
        )

        label_value = normalize_space(
            value
        )

        normalized.append(
            (
                label_name,
                label_value,
            )
        )

    return tuple(
        sorted(
            normalized
        )
    )


def safe_int(
    value: Any,
    default: int = 0,
) -> int:
    """Convert a value to integer."""

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
    """Convert a value to finite float."""

    try:
        parsed = float(value)
    except (
        TypeError,
        ValueError,
    ):
        return float(default)

    if not math.isfinite(parsed):
        return float(default)

    return parsed


def atomic_write_text(
    path: Path,
    text: str,
) -> None:
    """Atomically write UTF-8 text."""

    destination = Path(path)

    destination.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    temporary: Path | None = None

    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            dir=destination.parent,
            prefix=f".{destination.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            handle.write(text)
            handle.flush()
            os.fsync(
                handle.fileno()
            )

            temporary = Path(
                handle.name
            )

        temporary.replace(
            destination
        )

    finally:
        if (
            temporary is not None
            and temporary.exists()
        ):
            temporary.unlink(
                missing_ok=True
            )


def process_metrics() -> dict[str, Any]:
    """Return process-level runtime information."""

    usage = resource.getrusage(
        resource.RUSAGE_SELF
    )

    return {
        "pid": os.getpid(),
        "user_cpu_seconds": (
            usage.ru_utime
        ),
        "system_cpu_seconds": (
            usage.ru_stime
        ),
        "maximum_rss": (
            usage.ru_maxrss
        ),
        "minor_page_faults": (
            usage.ru_minflt
        ),
        "major_page_faults": (
            usage.ru_majflt
        ),
        "voluntary_context_switches": (
            usage.ru_nvcsw
        ),
        "involuntary_context_switches": (
            usage.ru_nivcsw
        ),
        "threads": threading.active_count(),
    }


class MetricsRegistry:
    """
    Thread-safe metrics registry.
    """

    def __init__(
        self,
        *,
        prefix: str = PROMETHEUS_PREFIX,
        metadata: Mapping[
            str,
            Any,
        ] | None = None,
    ) -> None:
        self.prefix = normalize_metric_name(
            prefix
        )

        self.metadata = dict(
            metadata or {}
        )

        self._definitions: dict[
            str,
            MetricDefinition,
        ] = {}

        self._counters: dict[
            MetricIdentity,
            CounterValue,
        ] = {}

        self._gauges: dict[
            MetricIdentity,
            GaugeValue,
        ] = {}

        self._histograms: dict[
            MetricIdentity,
            HistogramValue,
        ] = {}

        self._lock = threading.RLock()

        self._register_defaults()

    def define(
        self,
        name: str,
        metric_type: str,
        *,
        description: str = "",
        unit: str = "",
        buckets: Sequence[
            float
        ] | None = None,
    ) -> MetricDefinition:
        """Register a metric definition."""

        definition = MetricDefinition(
            name=name,
            metric_type=metric_type,
            description=description,
            unit=unit,
            buckets=tuple(
                buckets or ()
            ),
        )

        with self._lock:
            existing = (
                self._definitions.get(
                    definition.name
                )
            )

            if (
                existing is not None
                and existing.metric_type
                != definition.metric_type
            ):
                raise MetricsConfigurationError(
                    "Metric already exists with "
                    "a different type: "
                    f"{definition.name}."
                )

            self._definitions[
                definition.name
            ] = definition

        return definition

    def increment(
        self,
        name: str,
        amount: float = 1.0,
        *,
        labels: Mapping[
            str,
            Any,
        ] | None = None,
    ) -> float:
        """Increment a counter."""

        identity = self._identity(
            name,
            labels,
        )

        self._require_type(
            identity.name,
            METRIC_COUNTER,
        )

        with self._lock:
            value = self._counters.setdefault(
                identity,
                CounterValue(),
            )

            return value.increment(
                amount
            )

    def counter(
        self,
        name: str,
        *,
        labels: Mapping[
            str,
            Any,
        ] | None = None,
    ) -> float:
        """Return a counter value."""

        identity = self._identity(
            name,
            labels,
        )

        with self._lock:
            value = self._counters.get(
                identity
            )

            return (
                value.value
                if value is not None
                else 0.0
            )

    def set_gauge(
        self,
        name: str,
        value: float,
        *,
        labels: Mapping[
            str,
            Any,
        ] | None = None,
    ) -> float:
        """Set a gauge."""

        identity = self._identity(
            name,
            labels,
        )

        self._require_type(
            identity.name,
            METRIC_GAUGE,
        )

        with self._lock:
            gauge = self._gauges.setdefault(
                identity,
                GaugeValue(),
            )

            return gauge.set(
                value
            )

    def increment_gauge(
        self,
        name: str,
        amount: float = 1.0,
        *,
        labels: Mapping[
            str,
            Any,
        ] | None = None,
    ) -> float:
        """Increase a gauge."""

        identity = self._identity(
            name,
            labels,
        )

        self._require_type(
            identity.name,
            METRIC_GAUGE,
        )

        with self._lock:
            gauge = self._gauges.setdefault(
                identity,
                GaugeValue(),
            )

            return gauge.increment(
                amount
            )

    def decrement_gauge(
        self,
        name: str,
        amount: float = 1.0,
        *,
        labels: Mapping[
            str,
            Any,
        ] | None = None,
    ) -> float:
        """Decrease a gauge."""

        identity = self._identity(
            name,
            labels,
        )

        self._require_type(
            identity.name,
            METRIC_GAUGE,
        )

        with self._lock:
            gauge = self._gauges.setdefault(
                identity,
                GaugeValue(),
            )

            return gauge.decrement(
                amount
            )

    def gauge(
        self,
        name: str,
        *,
        labels: Mapping[
            str,
            Any,
        ] | None = None,
    ) -> float:
        """Return a gauge value."""

        identity = self._identity(
            name,
            labels,
        )

        with self._lock:
            value = self._gauges.get(
                identity
            )

            return (
                value.value
                if value is not None
                else 0.0
            )

    def observe(
        self,
        name: str,
        value: float,
        *,
        labels: Mapping[
            str,
            Any,
        ] | None = None,
    ) -> None:
        """Observe a histogram or timer value."""

        identity = self._identity(
            name,
            labels,
        )

        definition = (
            self._definitions.get(
                identity.name
            )
        )

        if definition is None:
            definition = self.define(
                identity.name,
                METRIC_HISTOGRAM,
                buckets=(
                    DEFAULT_HISTOGRAM_BUCKETS
                ),
            )

        if definition.metric_type not in {
            METRIC_HISTOGRAM,
            METRIC_TIMER,
        }:
            raise MetricsError(
                "Metric is not observable: "
                f"{identity.name}."
            )

        with self._lock:
            histogram = (
                self._histograms.get(
                    identity
                )
            )

            if histogram is None:
                histogram = (
                    HistogramValue.create(
                        definition.buckets
                    )
                )

                self._histograms[
                    identity
                ] = histogram

            histogram.observe(
                value
            )

    def histogram(
        self,
        name: str,
        *,
        labels: Mapping[
            str,
            Any,
        ] | None = None,
    ) -> dict[str, Any]:
        """Return histogram data."""

        identity = self._identity(
            name,
            labels,
        )

        with self._lock:
            value = (
                self._histograms.get(
                    identity
                )
            )

            return (
                value.to_dict()
                if value is not None
                else {}
            )

    @contextmanager
    def timer(
        self,
        name: str,
        *,
        labels: Mapping[
            str,
            Any,
        ] | None = None,
    ) -> Iterator[
        MutableMapping[
            str,
            Any,
        ]
    ]:
        """Measure elapsed wall-clock time."""

        normalized_name = (
            normalize_metric_name(
                name
            )
        )

        if (
            normalized_name
            not in self._definitions
        ):
            self.define(
                normalized_name,
                METRIC_TIMER,
                unit="seconds",
                buckets=(
                    DEFAULT_LATENCY_BUCKETS
                ),
            )

        started_at = time.time()
        started_monotonic = (
            time.perf_counter()
        )

        state: dict[str, Any] = {
            "started_at": started_at,
            "seconds": None,
        }

        try:
            yield state

        finally:
            finished_at = time.time()

            seconds = max(
                0.0,
                time.perf_counter()
                - started_monotonic,
            )

            state[
                "finished_at"
            ] = finished_at

            state["seconds"] = seconds

            self.observe(
                normalized_name,
                seconds,
                labels=labels,
            )

    def time_call(
        self,
        name: str,
        function: Any,
        *args: Any,
        labels: Mapping[
            str,
            Any,
        ] | None = None,
        **kwargs: Any,
    ) -> tuple[Any, TimerResult]:
        """Call a function and return its result plus timing data."""

        started_at = time.time()
        started_monotonic = (
            time.perf_counter()
        )

        try:
            result = function(
                *args,
                **kwargs,
            )

        finally:
            finished_at = time.time()

            seconds = max(
                0.0,
                time.perf_counter()
                - started_monotonic,
            )

            self.observe(
                name,
                seconds,
                labels=labels,
            )

        timer_result = TimerResult(
            name=normalize_metric_name(
                name
            ),
            labels=dict(
                labels or {}
            ),
            seconds=seconds,
            started_at=started_at,
            finished_at=finished_at,
        )

        return (
            result,
            timer_result,
        )

    def record_provider_run(
        self,
        metrics: ProviderRunMetrics,
    ) -> None:
        """Record a completed provider run."""

        provider = normalize_key(
            metrics.provider
        )

        labels = {
            "provider": provider,
        }

        self.increment(
            "provider_runs_total",
            labels=labels,
        )

        if metrics.success:
            self.increment(
                "provider_runs_success_total",
                labels=labels,
            )
        else:
            self.increment(
                "provider_runs_failed_total",
                labels=labels,
            )

        counters = (
            (
                "provider_records_fetched_total",
                metrics.fetched,
            ),
            (
                "provider_records_created_total",
                metrics.created,
            ),
            (
                "provider_records_matched_total",
                metrics.matched,
            ),
            (
                "provider_records_revised_total",
                metrics.revised,
            ),
            (
                "provider_conflicts_total",
                metrics.conflicts,
            ),
            (
                "provider_records_rejected_total",
                metrics.rejected,
            ),
            (
                "provider_requests_total",
                metrics.requests,
            ),
            (
                "provider_raw_records_total",
                metrics.raw,
            ),
        )

        for metric_name, amount in counters:
            self.increment(
                metric_name,
                max(
                    0,
                    int(amount),
                ),
                labels=labels,
            )

        self.observe(
            "provider_run_duration_seconds",
            max(
                0.0,
                metrics.duration_seconds,
            ),
            labels=labels,
        )

        self.observe(
            "provider_batch_size",
            max(
                0,
                metrics.fetched,
            ),
            labels=labels,
        )

        self.set_gauge(
            "provider_last_run_success",
            (
                1.0
                if metrics.success
                else 0.0
            ),
            labels=labels,
        )

        self.set_gauge(
            "provider_exhausted",
            (
                1.0
                if metrics.exhausted
                else 0.0
            ),
            labels=labels,
        )

        self.set_gauge(
            "provider_last_run_timestamp",
            time.time(),
            labels=labels,
        )

    def record_cache_statistics(
        self,
        statistics: Mapping[
            str,
            Any,
        ],
    ) -> None:
        """Copy cache statistics into gauges and counters."""

        counter_fields = (
            "memory_hits",
            "memory_misses",
            "disk_hits",
            "disk_misses",
            "stale_hits",
            "writes",
            "deletes",
            "evictions",
            "expirations",
            "integrity_failures",
            "serialization_failures",
            "lock_failures",
            "prunes",
            "bytes_read",
            "bytes_written",
        )

        for field_name in counter_fields:
            metric_name = (
                "cache_"
                + field_name
                + "_total"
            )

            self.set_gauge(
                metric_name,
                safe_float(
                    statistics.get(
                        field_name,
                        0,
                    )
                ),
            )

        self.set_gauge(
            "cache_hit_rate",
            safe_float(
                statistics.get(
                    "hit_rate",
                    0.0,
                )
            ),
        )

    def record_validation_result(
        self,
        *,
        provider: str,
        valid: bool,
        warnings: int = 0,
        errors: int = 0,
        critical: int = 0,
    ) -> None:
        """Record validation output."""

        labels = {
            "provider": normalize_key(
                provider
            ),
        }

        self.increment(
            "validation_records_total",
            labels=labels,
        )

        self.increment(
            (
                "validation_records_valid_total"
                if valid
                else "validation_records_invalid_total"
            ),
            labels=labels,
        )

        self.increment(
            "validation_warnings_total",
            max(
                0,
                int(warnings),
            ),
            labels=labels,
        )

        self.increment(
            "validation_errors_total",
            max(
                0,
                int(errors),
            ),
            labels=labels,
        )

        self.increment(
            "validation_critical_total",
            max(
                0,
                int(critical),
            ),
            labels=labels,
        )

    def record_reconciliation(
        self,
        *,
        action: str,
        provider: str,
        score: float | None = None,
    ) -> None:
        """Record a reconciliation outcome."""

        labels = {
            "provider": normalize_key(
                provider
            ),
            "action": normalize_key(
                action
            ),
        }

        self.increment(
            "reconciliation_results_total",
            labels=labels,
        )

        if score is not None:
            self.observe(
                "reconciliation_score",
                safe_float(score),
                labels=labels,
            )

    def snapshot(self) -> MetricsSnapshot:
        """Return a thread-safe metrics snapshot."""

        with self._lock:
            counters = {
                identity.key(): {
                    "name": identity.name,
                    "labels": (
                        identity.label_dict()
                    ),
                    "value": value.value,
                    "updated_at": (
                        value.updated_at
                    ),
                }
                for identity, value
                in self._counters.items()
            }

            gauges = {
                identity.key(): {
                    "name": identity.name,
                    "labels": (
                        identity.label_dict()
                    ),
                    "value": value.value,
                    "updated_at": (
                        value.updated_at
                    ),
                }
                for identity, value
                in self._gauges.items()
            }

            histograms = {
                identity.key(): {
                    "name": identity.name,
                    "labels": (
                        identity.label_dict()
                    ),
                    **value.to_dict(),
                }
                for identity, value
                in self._histograms.items()
            }

            definitions = {
                name: {
                    "name": definition.name,
                    "type": (
                        definition.metric_type
                    ),
                    "description": (
                        definition.description
                    ),
                    "unit": definition.unit,
                    "buckets": list(
                        definition.buckets
                    ),
                }
                for name, definition
                in self._definitions.items()
            }

        return MetricsSnapshot(
            generated_at=utc_now(),
            counters=counters,
            gauges=gauges,
            histograms=histograms,
            definitions=definitions,
            process=process_metrics(),
            metadata=dict(
                self.metadata
            ),
        )

    def reset(
        self,
        *,
        keep_definitions: bool = True,
    ) -> None:
        """Reset all metric values."""

        with self._lock:
            self._counters.clear()
            self._gauges.clear()
            self._histograms.clear()

            if not keep_definitions:
                self._definitions.clear()

    def merge(
        self,
        snapshot: MetricsSnapshot
        | Mapping[str, Any],
    ) -> None:
        """Merge another metrics snapshot into this registry."""

        value = (
            snapshot.to_dict()
            if isinstance(
                snapshot,
                MetricsSnapshot,
            )
            else dict(snapshot)
        )

        counters = value.get(
            "counters",
            {},
        )

        if isinstance(
            counters,
            Mapping,
        ):
            for item in counters.values():
                if not isinstance(
                    item,
                    Mapping,
                ):
                    continue

                self.increment(
                    str(
                        item.get(
                            "name",
                            "",
                        )
                    ),
                    safe_float(
                        item.get(
                            "value",
                            0.0,
                        )
                    ),
                    labels=(
                        item.get(
                            "labels",
                            {},
                        )
                        if isinstance(
                            item.get(
                                "labels",
                                {},
                            ),
                            Mapping,
                        )
                        else {}
                    ),
                )

        gauges = value.get(
            "gauges",
            {},
        )

        if isinstance(
            gauges,
            Mapping,
        ):
            for item in gauges.values():
                if not isinstance(
                    item,
                    Mapping,
                ):
                    continue

                self.set_gauge(
                    str(
                        item.get(
                            "name",
                            "",
                        )
                    ),
                    safe_float(
                        item.get(
                            "value",
                            0.0,
                        )
                    ),
                    labels=(
                        item.get(
                            "labels",
                            {},
                        )
                        if isinstance(
                            item.get(
                                "labels",
                                {},
                            ),
                            Mapping,
                        )
                        else {}
                    ),
                )

        histograms = value.get(
            "histograms",
            {},
        )

        if isinstance(
            histograms,
            Mapping,
        ):
            for item in histograms.values():
                if not isinstance(
                    item,
                    Mapping,
                ):
                    continue

                name = normalize_metric_name(
                    item.get(
                        "name",
                        "histogram",
                    )
                )

                labels = (
                    item.get(
                        "labels",
                        {},
                    )
                    if isinstance(
                        item.get(
                            "labels",
                            {},
                        ),
                        Mapping,
                    )
                    else {}
                )

                count = max(
                    0,
                    safe_int(
                        item.get(
                            "count",
                            0,
                        )
                    ),
                )

                mean = safe_float(
                    item.get(
                        "mean",
                        0.0,
                    )
                )

                for _index in range(
                    count
                ):
                    self.observe(
                        name,
                        mean,
                        labels=labels,
                    )

    def to_prometheus(
        self,
        *,
        include_process: bool = True,
    ) -> str:
        """Export metrics in Prometheus text format."""

        snapshot = self.snapshot()
        lines: list[str] = []

        definitions = snapshot.definitions

        emitted_help: set[str] = set()
        emitted_type: set[str] = set()

        def emit_definition(
            metric_name: str,
            metric_type: str,
        ) -> str:
            exported_name = (
                self._prometheus_name(
                    metric_name
                )
            )

            definition = definitions.get(
                metric_name,
                {},
            )

            if (
                exported_name
                not in emitted_help
            ):
                description = normalize_space(
                    definition.get(
                        "description",
                        "",
                    )
                )

                if description:
                    lines.append(
                        f"# HELP {exported_name} "
                        f"{self._escape_help(description)}"
                    )

                emitted_help.add(
                    exported_name
                )

            if (
                exported_name
                not in emitted_type
            ):
                prometheus_type = (
                    "histogram"
                    if metric_type
                    in {
                        METRIC_HISTOGRAM,
                        METRIC_TIMER,
                    }
                    else metric_type
                )

                lines.append(
                    f"# TYPE {exported_name} "
                    f"{prometheus_type}"
                )

                emitted_type.add(
                    exported_name
                )

            return exported_name

        for item in snapshot.counters.values():
            name = str(
                item["name"]
            )

            exported_name = (
                emit_definition(
                    name,
                    METRIC_COUNTER,
                )
            )

            lines.append(
                f"{exported_name}"
                f"{self._format_labels(item['labels'])} "
                f"{self._format_number(item['value'])}"
            )

        for item in snapshot.gauges.values():
            name = str(
                item["name"]
            )

            exported_name = (
                emit_definition(
                    name,
                    METRIC_GAUGE,
                )
            )

            lines.append(
                f"{exported_name}"
                f"{self._format_labels(item['labels'])} "
                f"{self._format_number(item['value'])}"
            )

        for item in snapshot.histograms.values():
            name = str(
                item["name"]
            )

            exported_name = (
                emit_definition(
                    name,
                    METRIC_HISTOGRAM,
                )
            )

            labels = dict(
                item.get(
                    "labels",
                    {},
                )
            )

            for bucket in item.get(
                "buckets",
                [],
            ):
                bucket_labels = {
                    **labels,
                    "le": str(
                        bucket.get(
                            "le"
                        )
                    ),
                }

                lines.append(
                    f"{exported_name}_bucket"
                    f"{self._format_labels(bucket_labels)} "
                    f"{safe_int(bucket.get('count'))}"
                )

            infinite_labels = {
                **labels,
                "le": "+Inf",
            }

            lines.append(
                f"{exported_name}_bucket"
                f"{self._format_labels(infinite_labels)} "
                f"{safe_int(item.get('count'))}"
            )

            lines.append(
                f"{exported_name}_sum"
                f"{self._format_labels(labels)} "
                f"{self._format_number(item.get('sum', 0.0))}"
            )

            lines.append(
                f"{exported_name}_count"
                f"{self._format_labels(labels)} "
                f"{safe_int(item.get('count'))}"
            )

        if include_process:
            for key, value in (
                snapshot.process.items()
            ):
                metric_name = (
                    self._prometheus_name(
                        "process_"
                        + normalize_metric_name(
                            key
                        )
                    )
                )

                lines.append(
                    f"# TYPE {metric_name} gauge"
                )

                lines.append(
                    f"{metric_name} "
                    f"{self._format_number(value)}"
                )

        return "\n".join(
            lines
        ) + "\n"

    def write_json(
        self,
        path: Path,
    ) -> MetricsSnapshot:
        """Write a metrics snapshot as formatted JSON."""

        snapshot = self.snapshot()

        atomic_write_text(
            Path(path),
            json.dumps(
                snapshot.to_dict(),
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
            + "\n",
        )

        return snapshot

    def write_prometheus(
        self,
        path: Path,
        *,
        include_process: bool = True,
    ) -> None:
        """Write Prometheus metrics text."""

        atomic_write_text(
            Path(path),
            self.to_prometheus(
                include_process=(
                    include_process
                )
            ),
        )

    def _identity(
        self,
        name: str,
        labels: Mapping[
            str,
            Any,
        ] | None,
    ) -> MetricIdentity:
        """Build a normalized metric identity."""

        return MetricIdentity(
            name=normalize_metric_name(
                name
            ),
            labels=normalize_labels(
                labels
            ),
        )

    def _require_type(
        self,
        name: str,
        expected: str,
    ) -> None:
        """Ensure a metric has the expected type."""

        normalized_name = (
            normalize_metric_name(
                name
            )
        )

        definition = (
            self._definitions.get(
                normalized_name
            )
        )

        if definition is None:
            self.define(
                normalized_name,
                expected,
            )

            return

        if definition.metric_type != expected:
            raise MetricsError(
                f"Metric {normalized_name!r} "
                f"is {definition.metric_type}, "
                f"not {expected}."
            )

    def _prometheus_name(
        self,
        name: str,
    ) -> str:
        """Return a prefixed Prometheus metric name."""

        normalized = (
            normalize_metric_name(
                name
            )
            .replace(":", "_")
        )

        prefix = self.prefix

        if normalized.startswith(
            prefix + "_"
        ):
            return normalized

        return (
            prefix
            + "_"
            + normalized
        )

    @staticmethod
    def _format_labels(
        labels: Mapping[
            str,
            Any,
        ],
    ) -> str:
        """Format Prometheus labels."""

        if not labels:
            return ""

        parts = []

        for key, value in sorted(
            labels.items()
        ):
            escaped = (
                str(value)
                .replace("\\", "\\\\")
                .replace("\n", "\\n")
                .replace('"', '\\"')
            )

            parts.append(
                f'{normalize_metric_name(key)}="{escaped}"'
            )

        return (
            "{"
            + ",".join(parts)
            + "}"
        )

    @staticmethod
    def _format_number(
        value: Any,
    ) -> str:
        """Format a Prometheus numeric value."""

        parsed = safe_float(
            value
        )

        if parsed.is_integer():
            return str(
                int(parsed)
            )

        return repr(parsed)

    @staticmethod
    def _escape_help(
        value: str,
    ) -> str:
        """Escape Prometheus HELP text."""

        return (
            value
            .replace("\\", "\\\\")
            .replace("\n", "\\n")
        )

    def _register_defaults(self) -> None:
        """Register standard Speciedex metrics."""

        counter_definitions = {
            "provider_runs_total": (
                "Total provider runs."
            ),
            "provider_runs_success_total": (
                "Successful provider runs."
            ),
            "provider_runs_failed_total": (
                "Failed provider runs."
            ),
            "provider_records_fetched_total": (
                "Provider records fetched."
            ),
            "provider_records_created_total": (
                "Canonical taxa created."
            ),
            "provider_records_matched_total": (
                "Records matched to existing taxa."
            ),
            "provider_records_revised_total": (
                "Existing taxa revised."
            ),
            "provider_conflicts_total": (
                "Reconciliation conflicts created."
            ),
            "provider_records_rejected_total": (
                "Provider records rejected."
            ),
            "provider_requests_total": (
                "Provider HTTP requests."
            ),
            "provider_raw_records_total": (
                "Raw provider records received."
            ),
            "reconciliation_results_total": (
                "Reconciliation outcomes."
            ),
            "validation_records_total": (
                "Taxon records validated."
            ),
            "validation_records_valid_total": (
                "Valid taxon records."
            ),
            "validation_records_invalid_total": (
                "Invalid taxon records."
            ),
            "validation_warnings_total": (
                "Validation warnings."
            ),
            "validation_errors_total": (
                "Validation errors."
            ),
            "validation_critical_total": (
                "Critical validation errors."
            ),
            "archive_writes_total": (
                "Archive write operations."
            ),
            "archive_write_failures_total": (
                "Failed archive write operations."
            ),
            "revision_events_total": (
                "Revision events written."
            ),
            "conflict_events_total": (
                "Conflict events written."
            ),
        }

        for name, description in (
            counter_definitions.items()
        ):
            self.define(
                name,
                METRIC_COUNTER,
                description=description,
            )

        gauge_definitions = {
            "provider_last_run_success": (
                "Whether the last provider run succeeded."
            ),
            "provider_last_run_timestamp": (
                "Unix timestamp of the last provider run."
            ),
            "provider_exhausted": (
                "Whether a provider cursor is exhausted."
            ),
            "scheduler_registered_providers": (
                "Number of registered providers."
            ),
            "scheduler_eligible_providers": (
                "Number of currently eligible providers."
            ),
            "archive_taxa": (
                "Canonical taxa currently indexed."
            ),
            "archive_assertions": (
                "Source assertions currently indexed."
            ),
            "archive_synonyms": (
                "Synonym mappings currently indexed."
            ),
            "archive_conflicts": (
                "Conflicts currently indexed."
            ),
            "cache_hit_rate": (
                "Combined cache hit rate."
            ),
        }

        for name, description in (
            gauge_definitions.items()
        ):
            self.define(
                name,
                METRIC_GAUGE,
                description=description,
            )

        for field_name in (
            "memory_hits",
            "memory_misses",
            "disk_hits",
            "disk_misses",
            "stale_hits",
            "writes",
            "deletes",
            "evictions",
            "expirations",
            "integrity_failures",
            "serialization_failures",
            "lock_failures",
            "prunes",
            "bytes_read",
            "bytes_written",
        ):
            self.define(
                "cache_"
                + field_name
                + "_total",
                METRIC_GAUGE,
                description=(
                    "Current cache statistic "
                    + field_name.replace(
                        "_",
                        " ",
                    )
                    + "."
                ),
            )

        self.define(
            "provider_run_duration_seconds",
            METRIC_TIMER,
            description=(
                "Provider run duration."
            ),
            unit="seconds",
            buckets=(
                DEFAULT_LATENCY_BUCKETS
            ),
        )

        self.define(
            "provider_batch_size",
            METRIC_HISTOGRAM,
            description=(
                "Provider batch record count."
            ),
            unit="records",
            buckets=(
                DEFAULT_BATCH_BUCKETS
            ),
        )

        self.define(
            "reconciliation_score",
            METRIC_HISTOGRAM,
            description=(
                "Reconciliation score distribution."
            ),
            unit="score",
            buckets=(
                10.0,
                20.0,
                30.0,
                40.0,
                50.0,
                60.0,
                70.0,
                80.0,
                90.0,
                95.0,
                100.0,
            ),
        )


class ProviderRunTimer:
    """
    Context manager for one provider run.
    """

    def __init__(
        self,
        registry: MetricsRegistry,
        provider: str,
    ) -> None:
        self.registry = registry
        self.metrics = ProviderRunMetrics(
            provider=normalize_key(
                provider
            ),
            started_at=utc_now(),
        )

        self._started = 0.0

    def __enter__(
        self,
    ) -> ProviderRunMetrics:
        self._started = (
            time.perf_counter()
        )

        return self.metrics

    def __exit__(
        self,
        exc_type: Any,
        exc_value: Any,
        traceback: Any,
    ) -> None:
        self.metrics.duration_seconds = max(
            0.0,
            time.perf_counter()
            - self._started,
        )

        self.metrics.finished_at = (
            utc_now()
        )

        if exc_value is not None:
            self.metrics.success = False
            self.metrics.error = normalize_space(
                exc_value
            )

        self.registry.record_provider_run(
            self.metrics
        )


_default_registry: (
    MetricsRegistry
    | None
) = None

_default_registry_lock = (
    threading.RLock()
)


def get_default_registry(
) -> MetricsRegistry:
    """Return the process-wide metrics registry."""

    global _default_registry

    with _default_registry_lock:
        if _default_registry is None:
            _default_registry = (
                MetricsRegistry()
            )

        return _default_registry


def set_default_registry(
    registry: MetricsRegistry | None,
) -> None:
    """Replace or clear the process-wide registry."""

    global _default_registry

    with _default_registry_lock:
        _default_registry = registry


def increment(
    name: str,
    amount: float = 1.0,
    *,
    labels: Mapping[
        str,
        Any,
    ] | None = None,
) -> float:
    """Increment a default-registry counter."""

    return (
        get_default_registry()
        .increment(
            name,
            amount,
            labels=labels,
        )
    )


def set_gauge(
    name: str,
    value: float,
    *,
    labels: Mapping[
        str,
        Any,
    ] | None = None,
) -> float:
    """Set a default-registry gauge."""

    return (
        get_default_registry()
        .set_gauge(
            name,
            value,
            labels=labels,
        )
    )


def observe(
    name: str,
    value: float,
    *,
    labels: Mapping[
        str,
        Any,
    ] | None = None,
) -> None:
    """Observe a default-registry histogram."""

    get_default_registry().observe(
        name,
        value,
        labels=labels,
    )


@contextmanager
def timer(
    name: str,
    *,
    labels: Mapping[
        str,
        Any,
    ] | None = None,
) -> Iterator[
    MutableMapping[
        str,
        Any,
    ]
]:
    """Measure time using the default registry."""

    with get_default_registry().timer(
        name,
        labels=labels,
    ) as state:
        yield state


def provider_run(
    provider: str,
    *,
    registry: MetricsRegistry
    | None = None,
) -> ProviderRunTimer:
    """Return a provider-run timing context."""

    return ProviderRunTimer(
        (
            registry
            if registry is not None
            else get_default_registry()
        ),
        provider,
    )


__all__ = [
    "DEFAULT_BATCH_BUCKETS",
    "DEFAULT_HISTOGRAM_BUCKETS",
    "DEFAULT_LATENCY_BUCKETS",
    "GaugeValue",
    "HistogramValue",
    "METRICS_SCHEMA_VERSION",
    "METRIC_COUNTER",
    "METRIC_GAUGE",
    "METRIC_HISTOGRAM",
    "METRIC_TIMER",
    "MetricDefinition",
    "MetricIdentity",
    "MetricsConfigurationError",
    "MetricsError",
    "MetricsRegistry",
    "MetricsSnapshot",
    "PROMETHEUS_PREFIX",
    "ProviderRunMetrics",
    "ProviderRunTimer",
    "TimerResult",
    "atomic_write_text",
    "get_default_registry",
    "increment",
    "normalize_key",
    "normalize_labels",
    "normalize_metric_name",
    "normalize_space",
    "observe",
    "process_metrics",
    "provider_run",
    "safe_float",
    "safe_int",
    "set_default_registry",
    "set_gauge",
    "timer",
    "utc_now",
]
