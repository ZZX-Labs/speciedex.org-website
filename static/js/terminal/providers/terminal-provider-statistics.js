/*
========================================================================
Speciedex.org
Terminal ProviderStatistics Module
========================================================================

Provider-level statistics service for SpeciedexTerminal.

Provides:

    • Validated provider-statistics API requests
    • Provider, metric, rank, status, region, source, and date filters
    • Normalized provider statistics records
    • Record, species, taxa, assertion, error, latency, throughput, and coverage metrics
    • Aggregate totals, averages, medians, percentiles, minima, maxima, and rankings
    • Single-provider statistics retrieval
    • Top, bottom, healthy, degraded, and trend views
    • Lifecycle events, caching, and resilient service registration
    • Terminal command integration

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "ProviderStatistics";
    const VERSION = "2.0.0";
    const SERVICE_NAME = "provider-statistics";

    const DEFAULT_LIMIT = 50;
    const MIN_LIMIT = 1;
    const MAX_LIMIT = 1000;
    const DEFAULT_RANK_LIMIT = 10;

    function dispatch(target, name, detail, options = {}) {
        if (
            !target ||
            typeof target.dispatchEvent !== "function"
        ) {
            return false;
        }

        try {
            return target.dispatchEvent(
                new CustomEvent(
                    name,
                    {
                        bubbles:
                            options.bubbles === true,
                        cancelable:
                            options.cancelable === true,
                        detail
                    }
                )
            );
        } catch (_error) {
            return false;
        }
    }

    function normalizeText(value) {
        return String(value ?? "").trim();
    }

    function clampInteger(value, fallback, minimum, maximum) {
        const parsed = Number.parseInt(value, 10);

        if (!Number.isFinite(parsed)) {
            return fallback;
        }

        return Math.min(
            maximum,
            Math.max(minimum, parsed)
        );
    }

    function clampNumber(value, fallback, minimum, maximum) {
        const parsed = Number(value);

        if (!Number.isFinite(parsed)) {
            return fallback;
        }

        return Math.min(
            maximum,
            Math.max(minimum, parsed)
        );
    }

    function normalizeBoolean(value, fallback = null) {
        if (typeof value === "boolean") {
            return value;
        }

        if (
            value === 1 ||
            value === "1" ||
            String(value).toLowerCase() === "true"
        ) {
            return true;
        }

        if (
            value === 0 ||
            value === "0" ||
            String(value).toLowerCase() === "false"
        ) {
            return false;
        }

        return fallback;
    }

    function normalizeDate(value) {
        const text = normalizeText(value);

        if (!text) {
            return "";
        }

        const timestamp = Date.parse(text);

        if (!Number.isFinite(timestamp)) {
            throw new TypeError(
                `Invalid date value: ${value}`
            );
        }

        return new Date(timestamp).toISOString();
    }

    function normalizeRatio(value, fallback = 0) {
        const number = Number(value);

        if (!Number.isFinite(number)) {
            return fallback;
        }

        return Math.min(
            1,
            Math.max(
                0,
                number > 1 &&
                number <= 100
                    ? number / 100
                    : number
            )
        );
    }

    function normalizeSort(value) {
        const normalized = normalizeText(
            value || "records"
        ).toLowerCase();

        const allowed = new Set([
            "provider",
            "records",
            "species",
            "taxa",
            "assertions",
            "errors",
            "warnings",
            "latency",
            "throughput",
            "coverage",
            "completeness",
            "quality",
            "success_rate",
            "availability",
            "updated_at",
            "created_at",
            "id"
        ]);

        if (!allowed.has(normalized)) {
            throw new TypeError(
                `Unsupported provider-statistics sort field: ${value}`
            );
        }

        return normalized;
    }

    function normalizeDirection(value) {
        const normalized = normalizeText(
            value || "desc"
        ).toLowerCase();

        if (
            normalized !== "asc" &&
            normalized !== "desc"
        ) {
            throw new TypeError(
                `Unsupported sort direction: ${value}`
            );
        }

        return normalized;
    }

    function normalizeParameters(parameters = {}) {
        const source =
            parameters &&
            typeof parameters === "object"
                ? parameters
                : {};

        const normalized = {
            q: normalizeText(
                source.q ??
                source.query ??
                ""
            ),
            limit: clampInteger(
                source.limit,
                DEFAULT_LIMIT,
                MIN_LIMIT,
                MAX_LIMIT
            ),
            offset: clampInteger(
                source.offset,
                0,
                0,
                Number.MAX_SAFE_INTEGER
            ),
            sort: normalizeSort(
                source.sort
            ),
            direction: normalizeDirection(
                source.direction ??
                source.order
            )
        };

        for (
            const key of
            [
                "provider",
                "provider_id",
                "metric",
                "rank",
                "status",
                "region",
                "country",
                "source",
                "category",
                "type",
                "build",
                "environment"
            ]
        ) {
            if (
                source[key] !== undefined &&
                source[key] !== null &&
                source[key] !== ""
            ) {
                normalized[key] =
                    normalizeText(source[key]);
            }
        }

        for (
            const key of
            [
                "healthy",
                "degraded",
                "available",
                "enabled",
                "authenticated",
                "active"
            ]
        ) {
            if (
                source[key] !== undefined &&
                source[key] !== null &&
                source[key] !== ""
            ) {
                const value = normalizeBoolean(
                    source[key],
                    null
                );

                if (value === null) {
                    throw new TypeError(
                        `Invalid ${key} value: ${source[key]}`
                    );
                }

                normalized[key] = value;
            }
        }

        const countFields = [
            ["min_records", source.min_records ?? source.minRecords],
            ["max_records", source.max_records ?? source.maxRecords],
            ["min_species", source.min_species ?? source.minSpecies],
            ["max_species", source.max_species ?? source.maxSpecies],
            ["min_errors", source.min_errors ?? source.minErrors],
            ["max_errors", source.max_errors ?? source.maxErrors],
            ["min_assertions", source.min_assertions ?? source.minAssertions],
            ["max_assertions", source.max_assertions ?? source.maxAssertions]
        ];

        for (const [key, value] of countFields) {
            if (
                value !== undefined &&
                value !== null &&
                value !== ""
            ) {
                normalized[key] =
                    clampInteger(
                        value,
                        0,
                        0,
                        Number.MAX_SAFE_INTEGER
                    );
            }
        }

        const numericFields = [
            ["min_latency", source.min_latency ?? source.minLatency],
            ["max_latency", source.max_latency ?? source.maxLatency],
            ["min_throughput", source.min_throughput ?? source.minThroughput],
            ["max_throughput", source.max_throughput ?? source.maxThroughput]
        ];

        for (const [key, value] of numericFields) {
            if (
                value !== undefined &&
                value !== null &&
                value !== ""
            ) {
                normalized[key] =
                    clampNumber(
                        value,
                        0,
                        0,
                        Number.MAX_SAFE_INTEGER
                    );
            }
        }

        const ratioFields = [
            ["min_coverage", source.min_coverage ?? source.minCoverage],
            ["max_coverage", source.max_coverage ?? source.maxCoverage],
            ["min_completeness", source.min_completeness ?? source.minCompleteness],
            ["max_completeness", source.max_completeness ?? source.maxCompleteness],
            ["min_quality", source.min_quality ?? source.minQuality],
            ["max_quality", source.max_quality ?? source.maxQuality],
            ["min_success_rate", source.min_success_rate ?? source.minSuccessRate],
            ["max_success_rate", source.max_success_rate ?? source.maxSuccessRate],
            ["min_availability", source.min_availability ?? source.minAvailability],
            ["max_availability", source.max_availability ?? source.maxAvailability]
        ];

        for (const [key, value] of ratioFields) {
            if (
                value !== undefined &&
                value !== null &&
                value !== ""
            ) {
                normalized[key] =
                    normalizeRatio(
                        value,
                        0
                    );
            }
        }

        for (
            const [minimum, maximum, label] of
            [
                ["min_records", "max_records", "record count"],
                ["min_species", "max_species", "species count"],
                ["min_errors", "max_errors", "error count"],
                ["min_assertions", "max_assertions", "assertion count"],
                ["min_latency", "max_latency", "latency"],
                ["min_throughput", "max_throughput", "throughput"],
                ["min_coverage", "max_coverage", "coverage"],
                ["min_completeness", "max_completeness", "completeness"],
                ["min_quality", "max_quality", "quality"],
                ["min_success_rate", "max_success_rate", "success rate"],
                ["min_availability", "max_availability", "availability"]
            ]
        ) {
            if (
                normalized[minimum] !== undefined &&
                normalized[maximum] !== undefined &&
                normalized[minimum] >
                normalized[maximum]
            ) {
                throw new RangeError(
                    `Minimum ${label} must not exceed maximum ${label}.`
                );
            }
        }

        const from =
            source.from ??
            source.since ??
            source.start;

        const to =
            source.to ??
            source.until ??
            source.end;

        if (
            from !== undefined &&
            from !== null &&
            from !== ""
        ) {
            normalized.from =
                normalizeDate(from);
        }

        if (
            to !== undefined &&
            to !== null &&
            to !== ""
        ) {
            normalized.to =
                normalizeDate(to);
        }

        if (
            normalized.from &&
            normalized.to &&
            Date.parse(normalized.from) >
            Date.parse(normalized.to)
        ) {
            throw new RangeError(
                "Provider-statistics start date must not be later than the end date."
            );
        }

        return normalized;
    }

    function numericValue(value, fallback = 0) {
        const number = Number(value);

        return Number.isFinite(number)
            ? number
            : fallback;
    }

    function normalizeRecord(record, index = 0) {
        if (
            !record ||
            typeof record !== "object"
        ) {
            return {
                index,
                id:
                    normalizeText(record),
                provider: "",
                records: 0,
                species: 0,
                taxa: 0,
                assertions: 0,
                errors: 0,
                warnings: 0,
                latency: 0,
                throughput: 0,
                coverage: 0,
                completeness: 0,
                quality: 0,
                success_rate: 0,
                availability: 0,
                healthy: false,
                degraded: false,
                available: false,
                enabled: false,
                authenticated: false,
                active: false,
                status: "unknown"
            };
        }

        const status = normalizeText(
            record.status ??
            record.health_status ??
            record.healthStatus ??
            "unknown"
        ).toLowerCase();

        const successRate = normalizeRatio(
            record.success_rate ??
            record.successRate ??
            record.success_ratio ??
            record.successRatio,
            0
        );

        const availability = normalizeRatio(
            record.availability ??
            record.availability_ratio ??
            record.availabilityRatio ??
            record.uptime,
            0
        );

        const quality = normalizeRatio(
            record.quality ??
            record.quality_score ??
            record.qualityScore,
            0
        );

        const completeness = normalizeRatio(
            record.completeness ??
            record.completeness_score ??
            record.completenessScore,
            0
        );

        const coverage = normalizeRatio(
            record.coverage ??
            record.coverage_score ??
            record.coverageScore,
            0
        );

        const healthy =
            record.healthy === true ||
            [
                "healthy",
                "ok",
                "operational",
                "ready"
            ].includes(status);

        const degraded =
            record.degraded === true ||
            [
                "degraded",
                "warning",
                "partial"
            ].includes(status);

        return {
            ...record,
            index:
                record.index ??
                index,
            id: normalizeText(
                record.id ??
                record.provider_id ??
                record.providerId ??
                record.provider ??
                `provider-statistics-${index + 1}`
            ),
            provider: normalizeText(
                record.provider ??
                record.provider_name ??
                record.providerName ??
                record.provider_id ??
                record.providerId ??
                ""
            ),
            provider_id: normalizeText(
                record.provider_id ??
                record.providerId ??
                record.provider ??
                ""
            ),
            records: numericValue(
                record.records ??
                record.record_count ??
                record.recordCount ??
                record.total_records ??
                record.totalRecords,
                0
            ),
            species: numericValue(
                record.species ??
                record.species_count ??
                record.speciesCount ??
                record.total_species ??
                record.totalSpecies,
                0
            ),
            taxa: numericValue(
                record.taxa ??
                record.taxa_count ??
                record.taxaCount ??
                record.taxons ??
                record.taxons_count ??
                record.taxonsCount,
                0
            ),
            assertions: numericValue(
                record.assertions ??
                record.assertion_count ??
                record.assertionCount,
                0
            ),
            synonyms: numericValue(
                record.synonyms ??
                record.synonym_count ??
                record.synonymCount,
                0
            ),
            occurrences: numericValue(
                record.occurrences ??
                record.occurrence_count ??
                record.occurrenceCount,
                0
            ),
            errors: numericValue(
                record.errors ??
                record.error_count ??
                record.errorCount,
                0
            ),
            warnings: numericValue(
                record.warnings ??
                record.warning_count ??
                record.warningCount,
                0
            ),
            conflicts: numericValue(
                record.conflicts ??
                record.conflict_count ??
                record.conflictCount,
                0
            ),
            unresolved: numericValue(
                record.unresolved ??
                record.unresolved_count ??
                record.unresolvedCount,
                0
            ),
            latency: numericValue(
                record.latency ??
                record.latency_ms ??
                record.latencyMs ??
                record.average_latency ??
                record.averageLatency,
                0
            ),
            throughput: numericValue(
                record.throughput ??
                record.records_per_second ??
                record.recordsPerSecond ??
                record.rps,
                0
            ),
            coverage,
            completeness,
            quality,
            success_rate:
                successRate,
            availability,
            healthy,
            degraded,
            available:
                record.available !== false &&
                ![
                    "unavailable",
                    "offline"
                ].includes(status),
            enabled:
                record.enabled !== false,
            authenticated:
                record.authenticated === true ||
                record.authentication_required === false ||
                record.authenticationRequired === false,
            active:
                record.active !== false &&
                ![
                    "inactive",
                    "disabled",
                    "retired"
                ].includes(status),
            status,
            rank: normalizeText(
                record.rank ??
                record.primary_rank ??
                record.primaryRank ??
                ""
            ).toLowerCase(),
            region: normalizeText(
                record.region ??
                ""
            ),
            country: normalizeText(
                record.country ??
                ""
            ),
            source: normalizeText(
                record.source ??
                ""
            ),
            category: normalizeText(
                record.category ??
                ""
            ),
            type: normalizeText(
                record.type ??
                record.provider_type ??
                record.providerType ??
                ""
            ),
            build: normalizeText(
                record.build ??
                record.build_id ??
                record.buildId ??
                ""
            ),
            environment: normalizeText(
                record.environment ??
                ""
            ),
            trend: numericValue(
                record.trend ??
                record.change ??
                record.delta,
                0
            ),
            trend_period: normalizeText(
                record.trend_period ??
                record.trendPeriod ??
                ""
            ),
            created_at:
                record.created_at ??
                record.createdAt ??
                "",
            updated_at:
                record.updated_at ??
                record.updatedAt ??
                record.measured_at ??
                record.measuredAt ??
                record.timestamp ??
                ""
        };
    }

    function percentile(values, percentage) {
        const numbers =
            values
                .map(Number)
                .filter(Number.isFinite)
                .sort(
                    (left, right) =>
                        left - right
                );

        if (!numbers.length) {
            return null;
        }

        if (numbers.length === 1) {
            return numbers[0];
        }

        const position =
            (numbers.length - 1) *
            percentage;

        const lower =
            Math.floor(position);

        const upper =
            Math.ceil(position);

        if (lower === upper) {
            return numbers[lower];
        }

        const weight =
            position - lower;

        return (
            numbers[lower] *
            (1 - weight) +
            numbers[upper] *
            weight
        );
    }

    function metricSummary(values) {
        const numbers =
            values
                .map(Number)
                .filter(Number.isFinite);

        if (!numbers.length) {
            return {
                count: 0,
                total: 0,
                minimum: null,
                maximum: null,
                average: null,
                median: null,
                p90: null,
                p95: null,
                p99: null
            };
        }

        const total =
            numbers.reduce(
                (sum, value) =>
                    sum + value,
                0
            );

        return {
            count:
                numbers.length,
            total,
            minimum:
                Math.min(...numbers),
            maximum:
                Math.max(...numbers),
            average:
                total /
                numbers.length,
            median:
                percentile(
                    numbers,
                    0.5
                ),
            p90:
                percentile(
                    numbers,
                    0.9
                ),
            p95:
                percentile(
                    numbers,
                    0.95
                ),
            p99:
                percentile(
                    numbers,
                    0.99
                )
        };
    }

    function incrementMap(map, key) {
        const normalized =
            normalizeText(key) ||
            "unknown";

        map.set(
            normalized,
            (
                map.get(normalized) ||
                0
            ) + 1
        );
    }

    function mapToSortedObject(map) {
        return Object.fromEntries(
            [...map.entries()]
                .sort(
                    (left, right) =>
                        right[1] -
                        left[1] ||
                        left[0].localeCompare(
                            right[0]
                        )
                )
        );
    }

    function summarize(records) {
        const values =
            Array.isArray(records)
                ? records
                : [];

        const statuses = new Map();
        const ranks = new Map();
        const regions = new Map();
        const countries = new Map();
        const categories = new Map();
        const types = new Map();

        for (const item of values) {
            incrementMap(
                statuses,
                item.status
            );

            incrementMap(
                ranks,
                item.rank
            );

            incrementMap(
                regions,
                item.region
            );

            incrementMap(
                countries,
                item.country
            );

            incrementMap(
                categories,
                item.category
            );

            incrementMap(
                types,
                item.type
            );
        }

        return {
            total:
                values.length,
            healthy:
                values.filter(
                    item =>
                        item.healthy
                ).length,
            degraded:
                values.filter(
                    item =>
                        item.degraded
                ).length,
            available:
                values.filter(
                    item =>
                        item.available
                ).length,
            enabled:
                values.filter(
                    item =>
                        item.enabled
                ).length,
            authenticated:
                values.filter(
                    item =>
                        item.authenticated
                ).length,
            active:
                values.filter(
                    item =>
                        item.active
                ).length,
            records:
                metricSummary(
                    values.map(
                        item =>
                            item.records
                    )
                ),
            species:
                metricSummary(
                    values.map(
                        item =>
                            item.species
                    )
                ),
            taxa:
                metricSummary(
                    values.map(
                        item =>
                            item.taxa
                    )
                ),
            assertions:
                metricSummary(
                    values.map(
                        item =>
                            item.assertions
                    )
                ),
            synonyms:
                metricSummary(
                    values.map(
                        item =>
                            item.synonyms
                    )
                ),
            occurrences:
                metricSummary(
                    values.map(
                        item =>
                            item.occurrences
                    )
                ),
            errors:
                metricSummary(
                    values.map(
                        item =>
                            item.errors
                    )
                ),
            warnings:
                metricSummary(
                    values.map(
                        item =>
                            item.warnings
                    )
                ),
            conflicts:
                metricSummary(
                    values.map(
                        item =>
                            item.conflicts
                    )
                ),
            unresolved:
                metricSummary(
                    values.map(
                        item =>
                            item.unresolved
                    )
                ),
            latency:
                metricSummary(
                    values.map(
                        item =>
                            item.latency
                    )
                ),
            throughput:
                metricSummary(
                    values.map(
                        item =>
                            item.throughput
                    )
                ),
            coverage:
                metricSummary(
                    values.map(
                        item =>
                            item.coverage
                    )
                ),
            completeness:
                metricSummary(
                    values.map(
                        item =>
                            item.completeness
                    )
                ),
            quality:
                metricSummary(
                    values.map(
                        item =>
                            item.quality
                    )
                ),
            successRate:
                metricSummary(
                    values.map(
                        item =>
                            item.success_rate
                    )
                ),
            availability:
                metricSummary(
                    values.map(
                        item =>
                            item.availability
                    )
                ),
            trend:
                metricSummary(
                    values.map(
                        item =>
                            item.trend
                    )
                ),
            statuses:
                mapToSortedObject(
                    statuses
                ),
            ranks:
                mapToSortedObject(
                    ranks
                ),
            regions:
                mapToSortedObject(
                    regions
                ),
            countries:
                mapToSortedObject(
                    countries
                ),
            categories:
                mapToSortedObject(
                    categories
                ),
            types:
                mapToSortedObject(
                    types
                )
        };
    }

    function normalizeResponse(payload) {
        if (Array.isArray(payload)) {
            const records =
                payload.map(
                    normalizeRecord
                );

            return {
                records,
                total:
                    records.length,
                limit:
                    records.length,
                offset: 0,
                summary:
                    summarize(records),
                raw: payload
            };
        }

        if (
            payload &&
            typeof payload === "object"
        ) {
            const values =
                Array.isArray(payload.records)
                    ? payload.records
                    : (
                        Array.isArray(payload.items)
                            ? payload.items
                            : (
                                Array.isArray(payload.statistics)
                                    ? payload.statistics
                                    : (
                                        Array.isArray(payload.providers)
                                            ? payload.providers
                                            : []
                                    )
                            )
                    );

            const records =
                values.map(
                    normalizeRecord
                );

            return {
                records,
                total:
                    Number.isFinite(
                        Number(payload.total)
                    )
                        ? Number(payload.total)
                        : records.length,
                limit:
                    Number.isFinite(
                        Number(payload.limit)
                    )
                        ? Number(payload.limit)
                        : records.length,
                offset:
                    Number.isFinite(
                        Number(payload.offset)
                    )
                        ? Number(payload.offset)
                        : 0,
                summary:
                    payload.summary &&
                    typeof payload.summary === "object"
                        ? {
                            ...summarize(records),
                            ...payload.summary
                        }
                        : summarize(records),
                next:
                    payload.next ??
                    payload.nextPage ??
                    null,
                previous:
                    payload.previous ??
                    payload.previousPage ??
                    null,
                raw: payload
            };
        }

        return {
            records: [],
            total: 0,
            limit: 0,
            offset: 0,
            summary:
                summarize([]),
            raw: payload
        };
    }

    function resolveMetric(record, metric) {
        const normalized =
            normalizeSort(metric);

        if (
            normalized === "provider" ||
            normalized === "status" ||
            normalized === "updated_at" ||
            normalized === "created_at" ||
            normalized === "id"
        ) {
            throw new TypeError(
                `Metric ${metric} is not numeric.`
            );
        }

        return numericValue(
            record[normalized],
            0
        );
    }

    function rankRecords(records, metric, direction = "desc", limit = DEFAULT_RANK_LIMIT) {
        const normalizedDirection =
            normalizeDirection(direction);

        const normalizedLimit =
            clampInteger(
                limit,
                DEFAULT_RANK_LIMIT,
                1,
                MAX_LIMIT
            );

        return [...records]
            .sort(
                (left, right) => {
                    const leftValue =
                        resolveMetric(
                            left,
                            metric
                        );

                    const rightValue =
                        resolveMetric(
                            right,
                            metric
                        );

                    return normalizedDirection === "asc"
                        ? leftValue - rightValue
                        : rightValue - leftValue;
                }
            )
            .slice(
                0,
                normalizedLimit
            );
    }

    class ProviderStatisticsService extends EventTarget {
        constructor(context) {
            super();

            if (
                !context ||
                typeof context !== "object"
            ) {
                throw new TypeError(
                    "A terminal context is required."
                );
            }

            this.context = context;
            this.destroyed = false;
            this.cache = null;
            this.cacheTimestamp = 0;
        }

        ensureAvailable() {
            if (this.destroyed) {
                throw new Error(
                    "Provider-statistics service has been destroyed."
                );
            }

            if (
                !this.context.api ||
                typeof this.context.api.get !==
                "function"
            ) {
                throw new Error(
                    "Speciedex API client is unavailable."
                );
            }
        }

        emit(name, detail) {
            dispatch(
                this,
                name,
                detail
            );

            try {
                this.context.events?.emit?.(
                    `provider-statistics:${name}`,
                    detail
                );
            } catch (_error) {
                /*
                Observer failures must not break statistics operations.
                */
            }

            dispatch(
                this.context.root,
                `speciedex:terminal-provider-statistics-${name}`,
                detail,
                {
                    bubbles: true
                }
            );
        }

        async list(parameters = {}, options = {}) {
            this.ensureAvailable();

            const normalized =
                normalizeParameters(
                    parameters
                );

            const startedAt =
                performance.now();

            this.emit(
                "request",
                {
                    operation:
                        "list",
                    parameters:
                        normalized
                }
            );

            try {
                const payload =
                    await this.context.api.get(
                        "providers/statistics",
                        normalized,
                        options
                    );

                const result =
                    normalizeResponse(
                        payload
                    );

                result.parameters =
                    normalized;

                result.duration =
                    performance.now() -
                    startedAt;

                this.cache =
                    result;

                this.cacheTimestamp =
                    Date.now();

                this.emit(
                    "complete",
                    result
                );

                return result;
            } catch (error) {
                this.emit(
                    "error",
                    {
                        operation:
                            "list",
                        error,
                        parameters:
                            normalized,
                        duration:
                            performance.now() -
                            startedAt
                    }
                );

                throw error;
            }
        }

        async get(provider, options = {}) {
            this.ensureAvailable();

            const normalizedProvider =
                normalizeText(provider);

            if (!normalizedProvider) {
                throw new TypeError(
                    "A provider ID or name is required."
                );
            }

            try {
                const payload =
                    await this.context.api.get(
                        `providers/statistics/${encodeURIComponent(normalizedProvider)}`,
                        {},
                        options
                    );

                return normalizeRecord(
                    payload,
                    0
                );
            } catch (error) {
                const lower =
                    normalizedProvider.toLowerCase();

                const match =
                    this.cache?.records?.find(
                        item =>
                            item.id ===
                                normalizedProvider ||
                            item.provider
                                .toLowerCase() ===
                                lower
                    );

                if (match) {
                    return match;
                }

                throw error;
            }
        }

        async top(metric = "records", limit = DEFAULT_RANK_LIMIT, parameters = {}, options = {}) {
            const result =
                await this.list(
                    {
                        ...parameters,
                        sort:
                            metric,
                        direction:
                            "desc",
                        limit:
                            Math.max(
                                parameters.limit ??
                                limit,
                                limit
                            )
                    },
                    options
                );

            const records =
                rankRecords(
                    result.records,
                    metric,
                    "desc",
                    limit
                );

            return {
                ...result,
                metric:
                    normalizeSort(metric),
                direction:
                    "desc",
                records,
                summary:
                    summarize(records)
            };
        }

        async bottom(metric = "records", limit = DEFAULT_RANK_LIMIT, parameters = {}, options = {}) {
            const result =
                await this.list(
                    {
                        ...parameters,
                        sort:
                            metric,
                        direction:
                            "asc",
                        limit:
                            Math.max(
                                parameters.limit ??
                                limit,
                                limit
                            )
                    },
                    options
                );

            const records =
                rankRecords(
                    result.records,
                    metric,
                    "asc",
                    limit
                );

            return {
                ...result,
                metric:
                    normalizeSort(metric),
                direction:
                    "asc",
                records,
                summary:
                    summarize(records)
            };
        }

        async healthy(parameters = {}, options = {}) {
            const result =
                await this.list(
                    {
                        ...parameters,
                        healthy: true
                    },
                    options
                );

            const records =
                result.records.filter(
                    item =>
                        item.healthy
                );

            return {
                ...result,
                records,
                summary:
                    summarize(records)
            };
        }

        async degraded(parameters = {}, options = {}) {
            const result =
                await this.list(
                    {
                        ...parameters,
                        degraded: true
                    },
                    options
                );

            const records =
                result.records.filter(
                    item =>
                        item.degraded
                );

            return {
                ...result,
                records,
                summary:
                    summarize(records)
            };
        }

        async trends(parameters = {}, options = {}) {
            const result =
                await this.list(
                    {
                        ...parameters,
                        sort:
                            parameters.sort ??
                            "updated_at",
                        direction:
                            parameters.direction ??
                            "desc"
                    },
                    options
                );

            const records =
                [...result.records].sort(
                    (left, right) =>
                        Math.abs(right.trend) -
                        Math.abs(left.trend)
                );

            return {
                ...result,
                records,
                summary:
                    summarize(records)
            };
        }

        async summary(parameters = {}, options = {}) {
            const result =
                await this.list(
                    {
                        ...parameters,
                        limit:
                            parameters.limit ??
                            MAX_LIMIT
                    },
                    options
                );

            return {
                parameters:
                    result.parameters,
                summary:
                    summarize(
                        result.records
                    ),
                providers:
                    result.records
            };
        }

        status() {
            return {
                version: VERSION,
                endpoint:
                    "providers/statistics",
                service:
                    SERVICE_NAME,
                available:
                    Boolean(
                        this.context.api &&
                        typeof this.context.api.get ===
                        "function"
                    ),
                cached:
                    Boolean(this.cache),
                cacheAge:
                    this.cacheTimestamp
                        ? Date.now() -
                          this.cacheTimestamp
                        : null,
                destroyed:
                    this.destroyed
            };
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            this.cache = null;
            this.cacheTimestamp = 0;
            this.destroyed = true;

            dispatch(
                this,
                "destroy",
                {
                    timestamp:
                        new Date().toISOString()
                }
            );

            return true;
        }
    }

    function initialize(context) {
        const existing =
            context.services?.get?.(
                SERVICE_NAME
            );

        if (
            existing instanceof
            ProviderStatisticsService &&
            !existing.destroyed
        ) {
            context.providerStatistics =
                existing;

            return existing;
        }

        if (
            context.providerStatistics instanceof
            ProviderStatisticsService &&
            !context.providerStatistics.destroyed
        ) {
            return context.providerStatistics;
        }

        const service =
            new ProviderStatisticsService(
                context
            );

        context.providerStatistics =
            service;

        context.registerService?.(
            SERVICE_NAME,
            service
        );

        context.registerService?.(
            "providerStatistics",
            service
        );

        dispatch(
            document,
            "speciedex:terminal-provider-statistics-ready",
            {
                context,
                service
            }
        );

        return service;
    }

    function requireService(context) {
        const service =
            context?.providerStatistics ||
            context?.services?.get?.(
                SERVICE_NAME
            );

        if (
            !(
                service instanceof
                ProviderStatisticsService
            )
        ) {
            throw new Error(
                "Provider-statistics service is unavailable."
            );
        }

        return service;
    }

    function parseCommandArguments(args = []) {
        const parameters = {};
        const positional = [];

        for (const argument of args) {
            if (
                argument.startsWith(
                    "--limit="
                )
            ) {
                parameters.limit =
                    argument.slice(8);
                continue;
            }

            if (
                argument.startsWith(
                    "--offset="
                )
            ) {
                parameters.offset =
                    argument.slice(9);
                continue;
            }

            if (
                argument.startsWith(
                    "--provider="
                )
            ) {
                parameters.provider =
                    argument.slice(11);
                continue;
            }

            if (
                argument.startsWith(
                    "--metric="
                )
            ) {
                parameters.metric =
                    argument.slice(9);
                continue;
            }

            if (
                argument.startsWith(
                    "--rank="
                )
            ) {
                parameters.rank =
                    argument.slice(7);
                continue;
            }

            if (
                argument.startsWith(
                    "--status="
                )
            ) {
                parameters.status =
                    argument.slice(9);
                continue;
            }

            if (
                argument.startsWith(
                    "--region="
                )
            ) {
                parameters.region =
                    argument.slice(9);
                continue;
            }

            if (
                argument.startsWith(
                    "--country="
                )
            ) {
                parameters.country =
                    argument.slice(10);
                continue;
            }

            if (
                argument.startsWith(
                    "--source="
                )
            ) {
                parameters.source =
                    argument.slice(9);
                continue;
            }

            if (
                argument.startsWith(
                    "--category="
                )
            ) {
                parameters.category =
                    argument.slice(11);
                continue;
            }

            if (
                argument.startsWith(
                    "--type="
                )
            ) {
                parameters.type =
                    argument.slice(7);
                continue;
            }

            if (
                argument.startsWith(
                    "--build="
                )
            ) {
                parameters.build =
                    argument.slice(8);
                continue;
            }

            if (
                argument.startsWith(
                    "--environment="
                )
            ) {
                parameters.environment =
                    argument.slice(14);
                continue;
            }

            if (
                argument.startsWith(
                    "--healthy="
                )
            ) {
                parameters.healthy =
                    argument.slice(10);
                continue;
            }

            if (
                argument.startsWith(
                    "--degraded="
                )
            ) {
                parameters.degraded =
                    argument.slice(11);
                continue;
            }

            if (
                argument.startsWith(
                    "--available="
                )
            ) {
                parameters.available =
                    argument.slice(12);
                continue;
            }

            if (
                argument.startsWith(
                    "--enabled="
                )
            ) {
                parameters.enabled =
                    argument.slice(10);
                continue;
            }

            if (
                argument.startsWith(
                    "--authenticated="
                )
            ) {
                parameters.authenticated =
                    argument.slice(16);
                continue;
            }

            if (
                argument.startsWith(
                    "--active="
                )
            ) {
                parameters.active =
                    argument.slice(9);
                continue;
            }

            if (
                argument.startsWith(
                    "--min-records="
                )
            ) {
                parameters.min_records =
                    argument.slice(14);
                continue;
            }

            if (
                argument.startsWith(
                    "--max-records="
                )
            ) {
                parameters.max_records =
                    argument.slice(14);
                continue;
            }

            if (
                argument.startsWith(
                    "--min-species="
                )
            ) {
                parameters.min_species =
                    argument.slice(14);
                continue;
            }

            if (
                argument.startsWith(
                    "--max-species="
                )
            ) {
                parameters.max_species =
                    argument.slice(14);
                continue;
            }

            if (
                argument.startsWith(
                    "--min-errors="
                )
            ) {
                parameters.min_errors =
                    argument.slice(13);
                continue;
            }

            if (
                argument.startsWith(
                    "--max-errors="
                )
            ) {
                parameters.max_errors =
                    argument.slice(13);
                continue;
            }

            if (
                argument.startsWith(
                    "--min-assertions="
                )
            ) {
                parameters.min_assertions =
                    argument.slice(17);
                continue;
            }

            if (
                argument.startsWith(
                    "--max-assertions="
                )
            ) {
                parameters.max_assertions =
                    argument.slice(17);
                continue;
            }

            if (
                argument.startsWith(
                    "--min-latency="
                )
            ) {
                parameters.min_latency =
                    argument.slice(14);
                continue;
            }

            if (
                argument.startsWith(
                    "--max-latency="
                )
            ) {
                parameters.max_latency =
                    argument.slice(14);
                continue;
            }

            if (
                argument.startsWith(
                    "--min-throughput="
                )
            ) {
                parameters.min_throughput =
                    argument.slice(17);
                continue;
            }

            if (
                argument.startsWith(
                    "--max-throughput="
                )
            ) {
                parameters.max_throughput =
                    argument.slice(17);
                continue;
            }

            if (
                argument.startsWith(
                    "--min-coverage="
                )
            ) {
                parameters.min_coverage =
                    argument.slice(15);
                continue;
            }

            if (
                argument.startsWith(
                    "--max-coverage="
                )
            ) {
                parameters.max_coverage =
                    argument.slice(15);
                continue;
            }

            if (
                argument.startsWith(
                    "--min-completeness="
                )
            ) {
                parameters.min_completeness =
                    argument.slice(19);
                continue;
            }

            if (
                argument.startsWith(
                    "--max-completeness="
                )
            ) {
                parameters.max_completeness =
                    argument.slice(19);
                continue;
            }

            if (
                argument.startsWith(
                    "--min-quality="
                )
            ) {
                parameters.min_quality =
                    argument.slice(14);
                continue;
            }

            if (
                argument.startsWith(
                    "--max-quality="
                )
            ) {
                parameters.max_quality =
                    argument.slice(14);
                continue;
            }

            if (
                argument.startsWith(
                    "--min-success-rate="
                )
            ) {
                parameters.min_success_rate =
                    argument.slice(19);
                continue;
            }

            if (
                argument.startsWith(
                    "--max-success-rate="
                )
            ) {
                parameters.max_success_rate =
                    argument.slice(19);
                continue;
            }

            if (
                argument.startsWith(
                    "--min-availability="
                )
            ) {
                parameters.min_availability =
                    argument.slice(19);
                continue;
            }

            if (
                argument.startsWith(
                    "--max-availability="
                )
            ) {
                parameters.max_availability =
                    argument.slice(19);
                continue;
            }

            if (
                argument.startsWith(
                    "--from="
                )
            ) {
                parameters.from =
                    argument.slice(7);
                continue;
            }

            if (
                argument.startsWith(
                    "--to="
                )
            ) {
                parameters.to =
                    argument.slice(5);
                continue;
            }

            if (
                argument.startsWith(
                    "--sort="
                )
            ) {
                parameters.sort =
                    argument.slice(7);
                continue;
            }

            if (
                argument.startsWith(
                    "--direction="
                )
            ) {
                parameters.direction =
                    argument.slice(12);
                continue;
            }

            positional.push(argument);
        }

        if (positional.length) {
            parameters.q =
                positional[0];
        }

        if (
            positional[1] !==
            undefined
        ) {
            parameters.limit =
                positional[1];
        }

        return normalizeParameters(
            parameters
        );
    }

    function writeJSONValue(writeJSON, value) {
        if (
            typeof writeJSON ===
            "function"
        ) {
            return writeJSON(value);
        }

        return value;
    }

    const commands = [
        {
            name: "provider-statistics",
            aliases: [
                "providers-statistics",
                "provider-stats"
            ],
            category: "providers",
            description:
                "Display provider-level statistics.",
            usage:
                "provider-statistics [query] [limit] [--provider=ID] [--metric=METRIC] [--rank=RANK] [--status=STATUS] [--region=REGION] [--country=COUNTRY] [--source=SOURCE] [--category=CATEGORY] [--type=TYPE] [--build=BUILD] [--environment=ENV] [--healthy=true|false] [--degraded=true|false] [--available=true|false] [--enabled=true|false] [--authenticated=true|false] [--active=true|false] [--min-records=N] [--max-records=N] [--min-species=N] [--max-species=N] [--min-errors=N] [--max-errors=N] [--min-assertions=N] [--max-assertions=N] [--min-latency=N] [--max-latency=N] [--min-throughput=N] [--max-throughput=N] [--min-coverage=N] [--max-coverage=N] [--min-completeness=N] [--max-completeness=N] [--min-quality=N] [--max-quality=N] [--min-success-rate=N] [--max-success-rate=N] [--min-availability=N] [--max-availability=N] [--from=DATE] [--to=DATE] [--sort=FIELD] [--direction=asc|desc] [--offset=N]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                const result =
                    await requireService(
                        context
                    ).list(
                        parseCommandArguments(
                            args
                        )
                    );

                return writeJSONValue(
                    writeJSON,
                    result
                );
            }
        },
        {
            name: "provider-statistics-get",
            aliases: [
                "provider-stats-get"
            ],
            category: "providers",
            description:
                "Retrieve one provider statistics record by provider ID or name.",
            usage:
                "provider-statistics-get <provider>",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                const provider =
                    args.join(" ")
                        .trim();

                if (!provider) {
                    throw new Error(
                        "A provider ID or name is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).get(provider)
                );
            }
        },
        {
            name: "provider-statistics-top",
            aliases: [
                "provider-stats-top"
            ],
            category: "providers",
            description:
                "Rank providers from highest to lowest by a numeric metric.",
            usage:
                "provider-statistics-top [metric] [limit] [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                const metric =
                    args[0] &&
                    !String(args[0]).startsWith("--")
                        ? args[0]
                        : "records";

                const limit =
                    args[1] &&
                    !String(args[1]).startsWith("--")
                        ? args[1]
                        : DEFAULT_RANK_LIMIT;

                const filterStart =
                    metric === "records" &&
                    String(args[0] || "").startsWith("--")
                        ? 0
                        : (
                            String(args[1] || "").startsWith("--")
                                ? 1
                                : 2
                        );

                return writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).top(
                        metric,
                        limit,
                        parseCommandArguments(
                            args.slice(filterStart)
                        )
                    )
                );
            }
        },
        {
            name: "provider-statistics-bottom",
            aliases: [
                "provider-stats-bottom"
            ],
            category: "providers",
            description:
                "Rank providers from lowest to highest by a numeric metric.",
            usage:
                "provider-statistics-bottom [metric] [limit] [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                const metric =
                    args[0] &&
                    !String(args[0]).startsWith("--")
                        ? args[0]
                        : "records";

                const limit =
                    args[1] &&
                    !String(args[1]).startsWith("--")
                        ? args[1]
                        : DEFAULT_RANK_LIMIT;

                const filterStart =
                    metric === "records" &&
                    String(args[0] || "").startsWith("--")
                        ? 0
                        : (
                            String(args[1] || "").startsWith("--")
                                ? 1
                                : 2
                        );

                return writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).bottom(
                        metric,
                        limit,
                        parseCommandArguments(
                            args.slice(filterStart)
                        )
                    )
                );
            }
        },
        {
            name: "provider-statistics-healthy",
            aliases: [
                "healthy-provider-statistics"
            ],
            category: "providers",
            description:
                "List healthy provider statistics records.",
            usage:
                "provider-statistics-healthy [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).healthy(
                        parseCommandArguments(
                            args
                        )
                    )
                )
        },
        {
            name: "provider-statistics-degraded",
            aliases: [
                "degraded-provider-statistics"
            ],
            category: "providers",
            description:
                "List degraded provider statistics records.",
            usage:
                "provider-statistics-degraded [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).degraded(
                        parseCommandArguments(
                            args
                        )
                    )
                )
        },
        {
            name: "provider-statistics-trends",
            aliases: [
                "provider-stats-trends"
            ],
            category: "providers",
            description:
                "List provider statistics ordered by absolute trend change.",
            usage:
                "provider-statistics-trends [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).trends(
                        parseCommandArguments(
                            args
                        )
                    )
                )
        },
        {
            name: "provider-statistics-summary",
            aliases: [
                "provider-stats-summary"
            ],
            category: "providers",
            description:
                "Summarize provider totals, averages, medians, percentiles, health, coverage, completeness, quality, success, latency, throughput, and availability.",
            usage:
                "provider-statistics-summary [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).summary(
                        parseCommandArguments(
                            args
                        )
                    )
                )
        },
        {
            name: "provider-statistics-status",
            category: "providers",
            description:
                "Show provider-statistics service status.",
            usage:
                "provider-statistics-status",
            handler: ({
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    requireService(
                        context
                    ).status()
                )
        }
    ];

    const api = Object.freeze({
        name: MODULE_NAME,
        version: VERSION,
        serviceName:
            SERVICE_NAME,
        ProviderStatisticsService,
        normalizeParameters,
        normalizeRecord,
        normalizeResponse,
        normalizeRatio,
        percentile,
        metricSummary,
        summarize,
        resolveMetric,
        rankRecords,
        parseCommandArguments,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalProviderStatistics =
        api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules ||
        {};

    window.SpeciedexTerminalModules[
        MODULE_NAME
    ] = api;

    dispatch(
        document,
        "speciedex:terminal-module-available",
        {
            name: MODULE_NAME,
            module: api
        }
    );
})(window, document);
