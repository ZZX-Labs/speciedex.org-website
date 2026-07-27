/*
========================================================================
Speciedex.org
Terminal ProviderStatistics Module
========================================================================

Provider-level statistics, performance, quality, coverage, and health service
for SpeciedexTerminal.

Provides:

    • Validated provider-statistics API requests
    • Provider, metric, rank, status, region, source, build, and date filters
    • Normalized provider statistics records
    • Record, species, taxa, assertion, error, latency, throughput, and coverage metrics
    • Aggregate totals, averages, medians, percentiles, minima, maxima, and rankings
    • TTL response caching and inflight-request deduplication
    • AbortSignal-aware request lifecycle tracking
    • Single-provider retrieval with cache fallback
    • Top, bottom, healthy, degraded, unavailable, inactive, and trend views
    • Optional statistics-worker and provider-worker analysis
    • Idempotent service registration and safe teardown
    • Terminal command integration

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "ProviderStatistics";
    const VERSION = "3.0.0";
    const SERVICE_NAME = "provider-statistics";
    const STATISTICS_WORKER_NAME = "statistics";
    const PROVIDER_WORKER_NAME = "provider";

    const DEFAULT_LIMIT = 50;
    const MIN_LIMIT = 1;
    const MAX_LIMIT = 1000;
    const DEFAULT_RANK_LIMIT = 10;
    const DEFAULT_CACHE_TTL = 30000;
    const MAX_CACHE_ENTRIES = 128;

    const NUMERIC_METRICS = Object.freeze([
        "records",
        "species",
        "taxa",
        "assertions",
        "synonyms",
        "occurrences",
        "errors",
        "warnings",
        "conflicts",
        "unresolved",
        "latency",
        "throughput",
        "coverage",
        "completeness",
        "quality",
        "success_rate",
        "availability",
        "trend"
    ]);

    const SORT_FIELDS = Object.freeze([
        "provider",
        "provider_id",
        ...NUMERIC_METRICS,
        "status",
        "rank",
        "region",
        "country",
        "updated_at",
        "created_at",
        "id"
    ]);

    const FILTER_FIELDS = Object.freeze([
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
    ]);

    const BOOLEAN_FIELDS = Object.freeze([
        "healthy",
        "degraded",
        "available",
        "enabled",
        "authenticated",
        "active"
    ]);

    const COUNT_FILTERS = Object.freeze([
        ["records", "Records"],
        ["species", "Species"],
        ["taxa", "Taxa"],
        ["assertions", "Assertions"],
        ["synonyms", "Synonyms"],
        ["occurrences", "Occurrences"],
        ["errors", "Errors"],
        ["warnings", "Warnings"],
        ["conflicts", "Conflicts"],
        ["unresolved", "Unresolved"]
    ]);

    const NUMBER_FILTERS = Object.freeze([
        ["latency", "Latency"],
        ["throughput", "Throughput"],
        ["trend", "Trend"]
    ]);

    const RATIO_FILTERS = Object.freeze([
        ["coverage", "Coverage"],
        ["completeness", "Completeness"],
        ["quality", "Quality"],
        ["success_rate", "SuccessRate"],
        ["availability", "Availability"]
    ]);

    function now() {
        return (
            window.performance &&
            typeof window.performance.now === "function"
        )
            ? window.performance.now()
            : Date.now();
    }

    function dispatch(target, name, detail, options = {}) {
        if (!target || typeof target.dispatchEvent !== "function") {
            return false;
        }

        try {
            return target.dispatchEvent(
                new CustomEvent(name, {
                    bubbles: options.bubbles === true,
                    cancelable: options.cancelable === true,
                    detail
                })
            );
        } catch (_error) {
            return false;
        }
    }

    function createError(message, code, name = "Error") {
        const error = new Error(message);
        error.name = name;
        error.code = code;
        return error;
    }

    function abortError(message = "Provider-statistics request aborted.") {
        return createError(
            message,
            "PROVIDER_STATISTICS_ABORTED",
            "AbortError"
        );
    }

    function throwIfAborted(signal) {
        if (signal?.aborted) {
            throw signal.reason instanceof Error
                ? signal.reason
                : abortError();
        }
    }

    function normalizeText(value) {
        return String(value ?? "").trim();
    }

    function normalizeKey(value) {
        return normalizeText(value).toLowerCase();
    }

    function numericValue(value, fallback = 0) {
        const number = Number(value);
        return Number.isFinite(number) ? number : fallback;
    }

    function clampInteger(value, fallback, minimum, maximum) {
        const parsed = Number.parseInt(value, 10);

        if (!Number.isFinite(parsed)) {
            return fallback;
        }

        return Math.min(maximum, Math.max(minimum, parsed));
    }

    function clampNumber(value, fallback, minimum, maximum) {
        const parsed = Number(value);

        if (!Number.isFinite(parsed)) {
            return fallback;
        }

        return Math.min(maximum, Math.max(minimum, parsed));
    }

    function normalizeBoolean(value, fallback = null) {
        if (typeof value === "boolean") {
            return value;
        }

        if (typeof value === "number") {
            return value !== 0;
        }

        const normalized = normalizeKey(value);

        if (["true", "1", "yes", "on"].includes(normalized)) {
            return true;
        }

        if (["false", "0", "no", "off", ""].includes(normalized)) {
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
            throw new TypeError(`Invalid date value: ${value}`);
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
                number > 1 && number <= 100
                    ? number / 100
                    : number
            )
        );
    }

    function normalizeSort(value) {
        const normalized = normalizeKey(
            value || "records"
        ).replace(/-/g, "_");

        if (!SORT_FIELDS.includes(normalized)) {
            throw new TypeError(
                `Unsupported provider-statistics sort field: ${value}`
            );
        }

        return normalized;
    }

    function normalizeMetric(value) {
        const normalized = normalizeKey(
            value || "records"
        ).replace(/-/g, "_");

        if (!NUMERIC_METRICS.includes(normalized)) {
            throw new TypeError(
                `Unsupported provider-statistics metric: ${value}`
            );
        }

        return normalized;
    }

    function normalizeDirection(value) {
        const normalized = normalizeKey(value || "desc");

        if (normalized !== "asc" && normalized !== "desc") {
            throw new TypeError(
                `Unsupported sort direction: ${value}`
            );
        }

        return normalized;
    }

    function validateRange(source, minimumKey, maximumKey, label) {
        if (
            source[minimumKey] !== undefined &&
            source[maximumKey] !== undefined &&
            source[minimumKey] > source[maximumKey]
        ) {
            throw new RangeError(
                `Minimum ${label} must not exceed maximum ${label}.`
            );
        }
    }

    function normalizeParameters(parameters = {}) {
        const source =
            parameters && typeof parameters === "object"
                ? parameters
                : {};

        const normalized = {
            q: normalizeText(
                source.q ??
                source.query ??
                source.search ??
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
            sort: normalizeSort(source.sort),
            direction: normalizeDirection(
                source.direction ??
                source.order
            )
        };

        for (const field of FILTER_FIELDS) {
            const value = source[field];

            if (
                value !== undefined &&
                value !== null &&
                value !== ""
            ) {
                normalized[field] = normalizeText(value);
            }
        }

        for (const field of BOOLEAN_FIELDS) {
            const value = source[field];

            if (
                value === undefined ||
                value === null ||
                value === ""
            ) {
                continue;
            }

            const parsed = normalizeBoolean(value, null);

            if (parsed === null) {
                throw new TypeError(
                    `Invalid ${field} value: ${value}`
                );
            }

            normalized[field] = parsed;
        }

        for (const [metric, camelSuffix] of COUNT_FILTERS) {
            const minimum =
                source[`min_${metric}`] ??
                source[`min${camelSuffix}`];

            const maximum =
                source[`max_${metric}`] ??
                source[`max${camelSuffix}`];

            if (
                minimum !== undefined &&
                minimum !== null &&
                minimum !== ""
            ) {
                normalized[`min_${metric}`] = clampInteger(
                    minimum,
                    0,
                    0,
                    Number.MAX_SAFE_INTEGER
                );
            }

            if (
                maximum !== undefined &&
                maximum !== null &&
                maximum !== ""
            ) {
                normalized[`max_${metric}`] = clampInteger(
                    maximum,
                    Number.MAX_SAFE_INTEGER,
                    0,
                    Number.MAX_SAFE_INTEGER
                );
            }

            validateRange(
                normalized,
                `min_${metric}`,
                `max_${metric}`,
                `${metric} count`
            );
        }

        for (const [metric, camelSuffix] of NUMBER_FILTERS) {
            const minimum =
                source[`min_${metric}`] ??
                source[`min${camelSuffix}`];

            const maximum =
                source[`max_${metric}`] ??
                source[`max${camelSuffix}`];

            if (
                minimum !== undefined &&
                minimum !== null &&
                minimum !== ""
            ) {
                normalized[`min_${metric}`] = clampNumber(
                    minimum,
                    0,
                    metric === "trend"
                        ? -Number.MAX_SAFE_INTEGER
                        : 0,
                    Number.MAX_SAFE_INTEGER
                );
            }

            if (
                maximum !== undefined &&
                maximum !== null &&
                maximum !== ""
            ) {
                normalized[`max_${metric}`] = clampNumber(
                    maximum,
                    Number.MAX_SAFE_INTEGER,
                    metric === "trend"
                        ? -Number.MAX_SAFE_INTEGER
                        : 0,
                    Number.MAX_SAFE_INTEGER
                );
            }

            validateRange(
                normalized,
                `min_${metric}`,
                `max_${metric}`,
                metric
            );
        }

        for (const [metric, camelSuffix] of RATIO_FILTERS) {
            const minimum =
                source[`min_${metric}`] ??
                source[`min${camelSuffix}`];

            const maximum =
                source[`max_${metric}`] ??
                source[`max${camelSuffix}`];

            if (
                minimum !== undefined &&
                minimum !== null &&
                minimum !== ""
            ) {
                normalized[`min_${metric}`] =
                    normalizeRatio(minimum, 0);
            }

            if (
                maximum !== undefined &&
                maximum !== null &&
                maximum !== ""
            ) {
                normalized[`max_${metric}`] =
                    normalizeRatio(maximum, 0);
            }

            validateRange(
                normalized,
                `min_${metric}`,
                `max_${metric}`,
                metric.replace(/_/g, " ")
            );
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
            normalized.from = normalizeDate(from);
        }

        if (
            to !== undefined &&
            to !== null &&
            to !== ""
        ) {
            normalized.to = normalizeDate(to);
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

    function positiveMetric(value) {
        return Math.max(0, numericValue(value, 0));
    }

    function normalizeRecord(record, index = 0) {
        if (!record || typeof record !== "object") {
            return {
                index,
                id: normalizeText(record),
                provider: "",
                provider_id: "",
                records: 0,
                species: 0,
                taxa: 0,
                assertions: 0,
                synonyms: 0,
                occurrences: 0,
                errors: 0,
                warnings: 0,
                conflicts: 0,
                unresolved: 0,
                latency: 0,
                throughput: 0,
                coverage: 0,
                completeness: 0,
                quality: 0,
                success_rate: 0,
                availability: 0,
                error_rate: 0,
                warning_rate: 0,
                assertion_density: 0,
                species_density: 0,
                healthy: false,
                degraded: false,
                available: false,
                enabled: false,
                authenticated: false,
                active: false,
                status: "unknown",
                rank: "",
                region: "",
                country: "",
                source: "",
                category: "",
                type: "",
                build: "",
                environment: "",
                trend: 0,
                trend_period: "",
                created_at: "",
                updated_at: ""
            };
        }

        const status = normalizeKey(
            record.status ??
            record.health_status ??
            record.healthStatus ??
            "unknown"
        );

        const records = positiveMetric(
            record.records ??
            record.record_count ??
            record.recordCount ??
            record.total_records ??
            record.totalRecords
        );

        const species = positiveMetric(
            record.species ??
            record.species_count ??
            record.speciesCount ??
            record.total_species ??
            record.totalSpecies
        );

        const taxa = positiveMetric(
            record.taxa ??
            record.taxa_count ??
            record.taxaCount ??
            record.taxons ??
            record.taxons_count ??
            record.taxonsCount
        );

        const assertions = positiveMetric(
            record.assertions ??
            record.assertion_count ??
            record.assertionCount
        );

        const errors = positiveMetric(
            record.errors ??
            record.error_count ??
            record.errorCount
        );

        const warnings = positiveMetric(
            record.warnings ??
            record.warning_count ??
            record.warningCount
        );

        const successRate = normalizeRatio(
            record.success_rate ??
            record.successRate ??
            record.success_ratio ??
            record.successRatio,
            records > 0
                ? Math.max(0, 1 - errors / records)
                : 0
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
            normalizeBoolean(record.healthy, false) ||
            ["healthy", "ok", "operational", "ready"].includes(status);

        const degraded =
            normalizeBoolean(record.degraded, false) ||
            ["degraded", "warning", "partial"].includes(status);

        return {
            ...record,
            index: record.index ?? index,
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
            records,
            species,
            taxa,
            assertions,
            synonyms: positiveMetric(
                record.synonyms ??
                record.synonym_count ??
                record.synonymCount
            ),
            occurrences: positiveMetric(
                record.occurrences ??
                record.occurrence_count ??
                record.occurrenceCount
            ),
            errors,
            warnings,
            conflicts: positiveMetric(
                record.conflicts ??
                record.conflict_count ??
                record.conflictCount
            ),
            unresolved: positiveMetric(
                record.unresolved ??
                record.unresolved_count ??
                record.unresolvedCount
            ),
            latency: positiveMetric(
                record.latency ??
                record.latency_ms ??
                record.latencyMs ??
                record.average_latency ??
                record.averageLatency
            ),
            throughput: positiveMetric(
                record.throughput ??
                record.records_per_second ??
                record.recordsPerSecond ??
                record.rps
            ),
            coverage,
            completeness,
            quality,
            success_rate: successRate,
            availability,
            error_rate:
                records > 0
                    ? errors / records
                    : 0,
            warning_rate:
                records > 0
                    ? warnings / records
                    : 0,
            assertion_density:
                records > 0
                    ? assertions / records
                    : 0,
            species_density:
                records > 0
                    ? species / records
                    : 0,
            healthy,
            degraded,
            available:
                normalizeBoolean(record.available, true) &&
                !["unavailable", "offline", "failed"].includes(status),
            enabled: normalizeBoolean(record.enabled, true),
            authenticated:
                normalizeBoolean(record.authenticated, false) ||
                normalizeBoolean(
                    record.authentication_required ??
                    record.authenticationRequired,
                    true
                ) === false,
            active:
                normalizeBoolean(record.active, true) &&
                !["inactive", "disabled", "retired"].includes(status),
            status,
            rank: normalizeKey(
                record.rank ??
                record.primary_rank ??
                record.primaryRank ??
                ""
            ),
            region: normalizeText(record.region ?? ""),
            country: normalizeText(record.country ?? ""),
            source: normalizeText(record.source ?? ""),
            category: normalizeText(record.category ?? ""),
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
            environment: normalizeText(record.environment ?? ""),
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
        const numbers = values
            .map(Number)
            .filter(Number.isFinite)
            .sort((left, right) => left - right);

        if (!numbers.length) {
            return null;
        }

        if (numbers.length === 1) {
            return numbers[0];
        }

        const position =
            (numbers.length - 1) * percentage;

        const lower = Math.floor(position);
        const upper = Math.ceil(position);

        if (lower === upper) {
            return numbers[lower];
        }

        const weight = position - lower;

        return (
            numbers[lower] * (1 - weight) +
            numbers[upper] * weight
        );
    }

    function metricSummary(values) {
        const numbers = values
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
                p75: null,
                p90: null,
                p95: null,
                p99: null,
                standardDeviation: null
            };
        }

        const total = numbers.reduce(
            (sum, value) => sum + value,
            0
        );

        const average = total / numbers.length;

        const variance = numbers.reduce(
            (sum, value) =>
                sum + Math.pow(value - average, 2),
            0
        ) / numbers.length;

        return {
            count: numbers.length,
            total,
            minimum: Math.min(...numbers),
            maximum: Math.max(...numbers),
            average,
            median: percentile(numbers, 0.5),
            p75: percentile(numbers, 0.75),
            p90: percentile(numbers, 0.9),
            p95: percentile(numbers, 0.95),
            p99: percentile(numbers, 0.99),
            standardDeviation: Math.sqrt(variance)
        };
    }

    function incrementMap(map, value) {
        const key = normalizeText(value) || "unknown";
        map.set(key, (map.get(key) || 0) + 1);
    }

    function sortedObject(map) {
        return Object.fromEntries(
            [...map.entries()].sort((left, right) =>
                right[1] - left[1] ||
                left[0].localeCompare(
                    right[0],
                    undefined,
                    {
                        numeric: true,
                        sensitivity: "base"
                    }
                )
            )
        );
    }

    function summarize(records) {
        const values = Array.isArray(records)
            ? records
            : [];

        const statuses = new Map();
        const ranks = new Map();
        const regions = new Map();
        const countries = new Map();
        const sources = new Map();
        const categories = new Map();
        const types = new Map();
        const builds = new Map();
        const environments = new Map();

        for (const item of values) {
            incrementMap(statuses, item.status);
            incrementMap(ranks, item.rank);
            incrementMap(regions, item.region);
            incrementMap(countries, item.country);
            incrementMap(sources, item.source);
            incrementMap(categories, item.category);
            incrementMap(types, item.type);
            incrementMap(builds, item.build);
            incrementMap(environments, item.environment);
        }

        const healthy = values.filter(
            item => item.healthy
        ).length;

        const degraded = values.filter(
            item => item.degraded
        ).length;

        const available = values.filter(
            item => item.available
        ).length;

        const enabled = values.filter(
            item => item.enabled
        ).length;

        const active = values.filter(
            item => item.active
        ).length;

        const metrics = {};

        for (const metric of NUMERIC_METRICS) {
            metrics[metric] = metricSummary(
                values.map(item => item[metric])
            );
        }

        metrics.error_rate = metricSummary(
            values.map(item => item.error_rate)
        );

        metrics.warning_rate = metricSummary(
            values.map(item => item.warning_rate)
        );

        metrics.assertion_density = metricSummary(
            values.map(item => item.assertion_density)
        );

        metrics.species_density = metricSummary(
            values.map(item => item.species_density)
        );

        return {
            total: values.length,
            healthy,
            unhealthy: values.length - healthy,
            degraded,
            available,
            unavailable: values.length - available,
            enabled,
            disabled: values.length - enabled,
            authenticated: values.filter(
                item => item.authenticated
            ).length,
            active,
            inactive: values.length - active,
            healthyRate:
                values.length
                    ? healthy / values.length
                    : 0,
            degradedRate:
                values.length
                    ? degraded / values.length
                    : 0,
            availabilityRate:
                values.length
                    ? available / values.length
                    : 0,
            ...metrics,
            successRate: metrics.success_rate,
            statuses: sortedObject(statuses),
            ranks: sortedObject(ranks),
            regions: sortedObject(regions),
            countries: sortedObject(countries),
            sources: sortedObject(sources),
            categories: sortedObject(categories),
            types: sortedObject(types),
            builds: sortedObject(builds),
            environments: sortedObject(environments)
        };
    }

    function enrichPagination(result) {
        const limit = Math.max(
            0,
            numericValue(result.limit, 0)
        );

        const offset = Math.max(
            0,
            numericValue(result.offset, 0)
        );

        const total = Math.max(
            0,
            numericValue(result.total, 0)
        );

        const returned = result.records.length;

        return {
            ...result,
            returned,
            page:
                limit > 0
                    ? Math.floor(offset / limit) + 1
                    : 1,
            pages:
                limit > 0
                    ? Math.ceil(total / limit)
                    : (total > 0 ? 1 : 0),
            hasPrevious: offset > 0,
            hasNext: offset + returned < total
        };
    }

    function normalizeResponse(payload) {
        if (Array.isArray(payload)) {
            const records = payload.map(normalizeRecord);

            return enrichPagination({
                records,
                total: records.length,
                limit: records.length,
                offset: 0,
                summary: summarize(records),
                raw: payload
            });
        }

        if (payload && typeof payload === "object") {
            const values =
                payload.records ??
                payload.items ??
                payload.statistics ??
                payload.providers ??
                payload.results ??
                payload.rows ??
                payload.data ??
                [];

            const records = Array.isArray(values)
                ? values.map(normalizeRecord)
                : [];

            return enrichPagination({
                records,
                total:
                    Number.isFinite(Number(payload.total))
                        ? Number(payload.total)
                        : records.length,
                limit:
                    Number.isFinite(Number(payload.limit))
                        ? Number(payload.limit)
                        : records.length,
                offset:
                    Number.isFinite(Number(payload.offset))
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
                    payload.next_page ??
                    null,
                previous:
                    payload.previous ??
                    payload.previousPage ??
                    payload.previous_page ??
                    null,
                raw: payload
            });
        }

        return enrichPagination({
            records: [],
            total: 0,
            limit: 0,
            offset: 0,
            summary: summarize([]),
            raw: payload
        });
    }

    function resolveMetric(record, metric) {
        const normalized = normalizeMetric(metric);
        return numericValue(record[normalized], 0);
    }

    function rankRecords(
        records,
        metric,
        direction = "desc",
        limit = DEFAULT_RANK_LIMIT
    ) {
        const normalizedMetric = normalizeMetric(metric);
        const normalizedDirection =
            normalizeDirection(direction);

        const normalizedLimit = clampInteger(
            limit,
            DEFAULT_RANK_LIMIT,
            1,
            MAX_LIMIT
        );

        return [...records]
            .sort((left, right) => {
                const leftValue =
                    resolveMetric(left, normalizedMetric);

                const rightValue =
                    resolveMetric(right, normalizedMetric);

                const difference =
                    normalizedDirection === "asc"
                        ? leftValue - rightValue
                        : rightValue - leftValue;

                return (
                    difference ||
                    left.provider.localeCompare(
                        right.provider,
                        undefined,
                        {
                            numeric: true,
                            sensitivity: "base"
                        }
                    )
                );
            })
            .slice(0, normalizedLimit);
    }

    function stableStringify(value) {
        if (value === null || typeof value !== "object") {
            return JSON.stringify(value);
        }

        if (Array.isArray(value)) {
            return `[${value.map(stableStringify).join(",")}]`;
        }

        return `{${Object.keys(value)
            .sort()
            .map(key =>
                `${JSON.stringify(key)}:${stableStringify(value[key])}`
            )
            .join(",")}}`;
    }

    function cacheKey(parameters) {
        return stableStringify(parameters);
    }

    function clone(value) {
        if (typeof structuredClone === "function") {
            try {
                return structuredClone(value);
            } catch (_error) {
                /* Fall through. */
            }
        }

        return JSON.parse(JSON.stringify(value));
    }

    class ProviderStatisticsService extends EventTarget {
        constructor(context, options = {}) {
            super();

            if (!context || typeof context !== "object") {
                throw new TypeError(
                    "A terminal context is required."
                );
            }

            this.context = context;
            this.destroyed = false;
            this.cache = new Map();
            this.inflight = new Map();
            this.requests = new Map();
            this.sequence = 0;
            this.cacheTTL = clampInteger(
                options.cacheTTL ??
                options.cache_ttl,
                DEFAULT_CACHE_TTL,
                0,
                Number.MAX_SAFE_INTEGER
            );
            this.statisticsWorkerName = normalizeText(
                options.statisticsWorkerName ??
                options.statistics_worker_name ??
                STATISTICS_WORKER_NAME
            );
            this.providerWorkerName = normalizeText(
                options.providerWorkerName ??
                options.provider_worker_name ??
                PROVIDER_WORKER_NAME
            );
        }

        ensureAvailable() {
            if (this.destroyed) {
                throw createError(
                    "Provider-statistics service has been destroyed.",
                    "PROVIDER_STATISTICS_DESTROYED"
                );
            }

            if (
                !this.context.api ||
                typeof this.context.api.get !== "function"
            ) {
                throw createError(
                    "Speciedex API client is unavailable.",
                    "PROVIDER_STATISTICS_API_UNAVAILABLE"
                );
            }
        }

        emit(name, detail) {
            dispatch(this, name, detail);

            try {
                this.context.events?.emit?.(
                    `provider-statistics:${name}`,
                    detail
                );
            } catch (_error) {
                /* Observer failures are isolated. */
            }

            dispatch(
                this.context.root,
                `speciedex:terminal-provider-statistics-${name}`,
                detail,
                { bubbles: true }
            );
        }

        createRequest(operation, detail = {}) {
            const id =
                `provider-statistics:${Date.now()}:${++this.sequence}`;

            const request = {
                id,
                operation,
                startedAt: now(),
                timestamp: new Date().toISOString(),
                ...detail
            };

            this.requests.set(id, request);
            return request;
        }

        finishRequest(request, result, error = null) {
            request.duration = now() - request.startedAt;
            request.completedAt = new Date().toISOString();
            request.error = error || null;
            request.result = result;
            this.requests.delete(request.id);
            return request;
        }

        getCached(parameters, options = {}) {
            const key = cacheKey(parameters);
            const entry = this.cache.get(key);

            if (!entry) {
                return null;
            }

            const ttl = clampInteger(
                options.cacheTTL ??
                options.cache_ttl,
                this.cacheTTL,
                0,
                Number.MAX_SAFE_INTEGER
            );

            if (
                ttl > 0 &&
                Date.now() - entry.timestamp > ttl
            ) {
                this.cache.delete(key);
                return null;
            }

            entry.hits += 1;
            entry.lastAccessed = Date.now();

            return clone(entry.value);
        }

        setCached(parameters, value) {
            const key = cacheKey(parameters);

            this.cache.set(key, {
                timestamp: Date.now(),
                lastAccessed: Date.now(),
                hits: 0,
                value: clone(value)
            });

            if (this.cache.size > MAX_CACHE_ENTRIES) {
                const oldest = [...this.cache.entries()]
                    .sort((left, right) =>
                        left[1].lastAccessed -
                        right[1].lastAccessed
                    )[0];

                if (oldest) {
                    this.cache.delete(oldest[0]);
                }
            }
        }

        clearCache() {
            const entries = this.cache.size;
            this.cache.clear();

            this.emit("cache-clear", {
                entries,
                timestamp: new Date().toISOString()
            });

            return entries;
        }

        async list(parameters = {}, options = {}) {
            this.ensureAvailable();

            const normalized = normalizeParameters(parameters);
            const signal = options.signal;
            const force = normalizeBoolean(
                options.force ??
                options.refresh,
                false
            );

            throwIfAborted(signal);

            if (!force) {
                const cached = this.getCached(
                    normalized,
                    options
                );

                if (cached) {
                    cached.cache = {
                        hit: true,
                        timestamp: new Date().toISOString()
                    };

                    this.emit("cache-hit", {
                        operation: "list",
                        parameters: normalized
                    });

                    return cached;
                }
            }

            const key = cacheKey(normalized);

            if (!force && this.inflight.has(key)) {
                return this.awaitWithSignal(
                    this.inflight.get(key),
                    signal
                );
            }

            const request = this.createRequest(
                "list",
                { parameters: normalized }
            );

            this.emit("request", {
                requestId: request.id,
                operation: "list",
                parameters: normalized
            });

            const operation = this.performList(
                normalized,
                options,
                request
            );

            this.inflight.set(key, operation);

            try {
                return await this.awaitWithSignal(
                    operation,
                    signal
                );
            } finally {
                if (this.inflight.get(key) === operation) {
                    this.inflight.delete(key);
                }
            }
        }

        async performList(normalized, options, request) {
            try {
                const payload = await this.context.api.get(
                    "providers/statistics",
                    normalized,
                    options
                );

                const result = normalizeResponse(payload);

                result.parameters = normalized;
                result.duration = now() - request.startedAt;
                result.cache = {
                    hit: false,
                    timestamp: new Date().toISOString()
                };

                this.setCached(normalized, result);
                this.finishRequest(request, result);

                this.emit("complete", {
                    requestId: request.id,
                    ...result
                });

                return result;
            } catch (error) {
                this.finishRequest(request, null, error);

                this.emit("error", {
                    requestId: request.id,
                    operation: "list",
                    error,
                    parameters: normalized,
                    duration: request.duration
                });

                throw error;
            }
        }

        awaitWithSignal(promise, signal) {
            if (!signal) {
                return promise;
            }

            throwIfAborted(signal);

            return new Promise((resolve, reject) => {
                const onAbort = () => {
                    reject(
                        signal.reason instanceof Error
                            ? signal.reason
                            : abortError()
                    );
                };

                signal.addEventListener(
                    "abort",
                    onAbort,
                    { once: true }
                );

                promise.then(
                    value => {
                        signal.removeEventListener(
                            "abort",
                            onAbort
                        );
                        resolve(value);
                    },
                    error => {
                        signal.removeEventListener(
                            "abort",
                            onAbort
                        );
                        reject(error);
                    }
                );
            });
        }

        async get(provider, options = {}) {
            this.ensureAvailable();

            const normalizedProvider = normalizeText(provider);

            if (!normalizedProvider) {
                throw new TypeError(
                    "A provider ID or name is required."
                );
            }

            throwIfAborted(options.signal);

            const request = this.createRequest(
                "get",
                { provider: normalizedProvider }
            );

            this.emit("request", {
                requestId: request.id,
                operation: "get",
                provider: normalizedProvider
            });

            try {
                const payload = await this.context.api.get(
                    `providers/statistics/${encodeURIComponent(normalizedProvider)}`,
                    {},
                    options
                );

                const item = normalizeRecord(payload, 0);

                this.finishRequest(request, item);

                this.emit("complete", {
                    requestId: request.id,
                    operation: "get",
                    provider: item
                });

                return item;
            } catch (error) {
                const match = this.findCachedProvider(
                    normalizedProvider
                );

                if (match) {
                    this.finishRequest(request, match);

                    this.emit("fallback", {
                        requestId: request.id,
                        operation: "get",
                        provider: match,
                        error
                    });

                    return match;
                }

                this.finishRequest(request, null, error);

                this.emit("error", {
                    requestId: request.id,
                    operation: "get",
                    provider: normalizedProvider,
                    error
                });

                throw error;
            }
        }

        findCachedProvider(provider) {
            const normalizedProvider = normalizeKey(provider);

            for (const entry of this.cache.values()) {
                const match = entry.value?.records?.find(
                    item =>
                        normalizeKey(item.id) === normalizedProvider ||
                        normalizeKey(item.provider_id) === normalizedProvider ||
                        normalizeKey(item.provider) === normalizedProvider
                );

                if (match) {
                    return clone(match);
                }
            }

            return null;
        }

        async top(
            metric = "records",
            limit = DEFAULT_RANK_LIMIT,
            parameters = {},
            options = {}
        ) {
            return this.ranked(
                metric,
                "desc",
                limit,
                parameters,
                options
            );
        }

        async bottom(
            metric = "records",
            limit = DEFAULT_RANK_LIMIT,
            parameters = {},
            options = {}
        ) {
            return this.ranked(
                metric,
                "asc",
                limit,
                parameters,
                options
            );
        }

        async ranked(metric, direction, limit, parameters, options) {
            const normalizedMetric = normalizeMetric(metric);

            const normalizedLimit = clampInteger(
                limit,
                DEFAULT_RANK_LIMIT,
                1,
                MAX_LIMIT
            );

            const result = await this.list(
                {
                    ...parameters,
                    sort: normalizedMetric,
                    direction,
                    limit: Math.max(
                        parameters.limit ??
                        normalizedLimit,
                        normalizedLimit
                    )
                },
                options
            );

            const records = rankRecords(
                result.records,
                normalizedMetric,
                direction,
                normalizedLimit
            );

            return {
                ...result,
                metric: normalizedMetric,
                direction,
                records,
                returned: records.length,
                summary: summarize(records)
            };
        }

        async healthy(parameters = {}, options = {}) {
            return this.filteredView(
                { ...parameters, healthy: true },
                item => item.healthy,
                options
            );
        }

        async degraded(parameters = {}, options = {}) {
            return this.filteredView(
                { ...parameters, degraded: true },
                item => item.degraded,
                options
            );
        }

        async unavailable(parameters = {}, options = {}) {
            return this.filteredView(
                { ...parameters, available: false },
                item => !item.available,
                options
            );
        }

        async inactive(parameters = {}, options = {}) {
            return this.filteredView(
                { ...parameters, active: false },
                item => !item.active,
                options
            );
        }

        async filteredView(parameters, predicate, options) {
            const result = await this.list(
                parameters,
                options
            );

            const records = result.records.filter(predicate);

            return {
                ...result,
                records,
                returned: records.length,
                summary: summarize(records)
            };
        }

        async trends(parameters = {}, options = {}) {
            const result = await this.list(
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

            const records = [...result.records].sort(
                (left, right) =>
                    Math.abs(right.trend) -
                    Math.abs(left.trend) ||
                    right.trend - left.trend
            );

            return {
                ...result,
                records,
                returned: records.length,
                summary: summarize(records)
            };
        }

        async summary(parameters = {}, options = {}) {
            const result = await this.list(
                {
                    ...parameters,
                    limit:
                        parameters.limit ??
                        MAX_LIMIT
                },
                options
            );

            return {
                parameters: result.parameters,
                summary: summarize(result.records),
                providers: result.records,
                duration: result.duration,
                cache: result.cache
            };
        }

        async analyze(parameters = {}, options = {}) {
            const result = await this.list(
                {
                    ...parameters,
                    limit:
                        parameters.limit ??
                        MAX_LIMIT
                },
                options
            );

            return this.callWorker(
                this.statisticsWorkerName,
                "summarize",
                {
                    records: result.records,
                    metrics: NUMERIC_METRICS
                },
                options
            );
        }

        async health(parameters = {}, options = {}) {
            const result = await this.list(
                {
                    ...parameters,
                    limit:
                        parameters.limit ??
                        MAX_LIMIT
                },
                options
            );

            return this.callWorker(
                this.providerWorkerName,
                "health",
                {
                    providers: result.records
                },
                options
            );
        }

        async coverage(parameters = {}, options = {}) {
            const result = await this.list(
                {
                    ...parameters,
                    limit:
                        parameters.limit ??
                        MAX_LIMIT
                },
                options
            );

            return this.callWorker(
                this.providerWorkerName,
                "coverage",
                {
                    providers: result.records
                },
                options
            );
        }

        async duplicates(parameters = {}, options = {}) {
            const result = await this.list(
                {
                    ...parameters,
                    limit:
                        parameters.limit ??
                        MAX_LIMIT
                },
                options
            );

            return this.callWorker(
                this.providerWorkerName,
                "duplicates",
                {
                    records: result.records,
                    fields: [
                        "provider_id",
                        "build",
                        "environment"
                    ]
                },
                options
            );
        }

        async callWorker(workerName, type, payload, options = {}) {
            const workers =
                this.context.workers ??
                this.context.workerPool ??
                this.context.worker_pool;

            const candidates = [
                () => workers?.request?.(
                    workerName,
                    type,
                    payload,
                    options
                ),
                () => workers?.run?.(
                    workerName,
                    type,
                    payload,
                    options
                ),
                () => workers?.execute?.(
                    workerName,
                    type,
                    payload,
                    options
                ),
                () => workers?.call?.(
                    workerName,
                    type,
                    payload,
                    options
                ),
                () => this.context.services
                    ?.get?.("workers")
                    ?.request?.(
                        workerName,
                        type,
                        payload,
                        options
                    )
            ];

            for (const candidate of candidates) {
                try {
                    const result = candidate();

                    if (
                        result &&
                        typeof result.then === "function"
                    ) {
                        return await result;
                    }

                    if (result !== undefined) {
                        return result;
                    }
                } catch (error) {
                    if (error?.code === "WORKER_UNAVAILABLE") {
                        continue;
                    }

                    throw error;
                }
            }

            throw createError(
                `${workerName} worker service is unavailable.`,
                "PROVIDER_STATISTICS_WORKER_UNAVAILABLE"
            );
        }

        status() {
            return {
                version: VERSION,
                endpoint: "providers/statistics",
                service: SERVICE_NAME,
                statisticsWorker: this.statisticsWorkerName,
                providerWorker: this.providerWorkerName,
                available: Boolean(
                    this.context.api &&
                    typeof this.context.api.get === "function"
                ),
                workerAvailable: Boolean(
                    this.context.workers ||
                    this.context.workerPool ||
                    this.context.worker_pool ||
                    this.context.services?.get?.("workers")
                ),
                cacheEntries: this.cache.size,
                cacheTTL: this.cacheTTL,
                inflight: this.inflight.size,
                activeRequests: this.requests.size,
                destroyed: this.destroyed
            };
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            const detail = {
                timestamp: new Date().toISOString(),
                cacheEntries: this.cache.size,
                inflight: this.inflight.size,
                activeRequests: this.requests.size
            };

            this.cache.clear();
            this.inflight.clear();
            this.requests.clear();
            this.destroyed = true;

            dispatch(this, "destroy", detail);

            try {
                this.context.unregisterService?.(
                    SERVICE_NAME
                );

                this.context.unregisterService?.(
                    "providerStatistics"
                );
            } catch (_error) {
                /* Teardown must remain safe. */
            }

            return true;
        }
    }

    function initialize(context, options = {}) {
        if (!context || typeof context !== "object") {
            throw new TypeError(
                "A terminal context is required."
            );
        }

        const existing =
            context.services?.get?.(SERVICE_NAME);

        if (
            existing instanceof ProviderStatisticsService &&
            !existing.destroyed
        ) {
            context.providerStatistics = existing;
            return existing;
        }

        if (
            context.providerStatistics instanceof ProviderStatisticsService &&
            !context.providerStatistics.destroyed
        ) {
            return context.providerStatistics;
        }

        const service = new ProviderStatisticsService(
            context,
            options
        );

        context.providerStatistics = service;

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
                service,
                version: VERSION
            }
        );

        return service;
    }

    function unmount(context) {
        const service =
            context?.providerStatistics ??
            context?.services?.get?.(SERVICE_NAME);

        if (!(service instanceof ProviderStatisticsService)) {
            return false;
        }

        const destroyed = service.destroy();

        if (context?.providerStatistics === service) {
            context.providerStatistics = null;
        }

        return destroyed;
    }

    function requireService(context) {
        const service =
            context?.providerStatistics ??
            context?.services?.get?.(SERVICE_NAME);

        if (!(service instanceof ProviderStatisticsService)) {
            throw createError(
                "Provider-statistics service is unavailable.",
                "PROVIDER_STATISTICS_SERVICE_UNAVAILABLE"
            );
        }

        return service;
    }

    function parseCommandArguments(args = []) {
        const parameters = {};
        const positional = [];

        for (let index = 0; index < args.length; index += 1) {
            const argument = normalizeText(args[index]);

            if (!argument) {
                continue;
            }

            const booleanFlags = {
                "--healthy": ["healthy", true],
                "--unhealthy": ["healthy", false],
                "--degraded": ["degraded", true],
                "--not-degraded": ["degraded", false],
                "--available": ["available", true],
                "--unavailable": ["available", false],
                "--enabled": ["enabled", true],
                "--disabled": ["enabled", false],
                "--authenticated": ["authenticated", true],
                "--unauthenticated": ["authenticated", false],
                "--active": ["active", true],
                "--inactive": ["active", false]
            };

            if (booleanFlags[argument]) {
                const [field, value] = booleanFlags[argument];
                parameters[field] = value;
                continue;
            }

            if (argument.startsWith("--")) {
                const equals = argument.indexOf("=");
                let name;
                let value;

                if (equals >= 0) {
                    name = argument.slice(2, equals);
                    value = argument.slice(equals + 1);
                } else {
                    name = argument.slice(2);
                    value = args[index + 1];

                    if (
                        value !== undefined &&
                        !String(value).startsWith("--")
                    ) {
                        index += 1;
                    } else {
                        value = "";
                    }
                }

                const normalizedName = name.replace(/-/g, "_");

                const aliases = {
                    query: "q",
                    order: "direction",
                    since: "from",
                    start: "from",
                    until: "to",
                    end: "to"
                };

                parameters[
                    aliases[normalizedName] ??
                    normalizedName
                ] = value;

                continue;
            }

            positional.push(argument);
        }

        if (positional.length) {
            parameters.q = positional[0];
        }

        if (positional[1] !== undefined) {
            parameters.limit = positional[1];
        }

        return normalizeParameters(parameters);
    }

    function writeJSONValue(writeJSON, value) {
        if (typeof writeJSON === "function") {
            return writeJSON(value);
        }

        return value;
    }

    function parseRankingArguments(args = []) {
        let metric = "records";
        let limit = DEFAULT_RANK_LIMIT;
        let cursor = 0;

        if (
            args[cursor] &&
            !String(args[cursor]).startsWith("--")
        ) {
            metric = args[cursor];
            cursor += 1;
        }

        if (
            args[cursor] &&
            !String(args[cursor]).startsWith("--") &&
            Number.isFinite(Number(args[cursor]))
        ) {
            limit = Number(args[cursor]);
            cursor += 1;
        }

        return {
            metric,
            limit,
            parameters:
                parseCommandArguments(args.slice(cursor))
        };
    }

    function filteredCommand(
        name,
        aliases,
        description,
        method
    ) {
        return {
            name,
            aliases,
            category: "providers",
            description,
            usage: `${name} [filters]`,
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context)[method](
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        };
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
                "provider-statistics [query] [limit] [--provider=ID] [--metric=METRIC] [--rank=RANK] [--status=STATUS] [--region=REGION] [--country=COUNTRY] [--source=SOURCE] [--category=CATEGORY] [--type=TYPE] [--build=BUILD] [--environment=ENV] [--healthy|--unhealthy] [--degraded|--not-degraded] [--available|--unavailable] [--enabled|--disabled] [--authenticated|--unauthenticated] [--active|--inactive] [--min-<metric>=N] [--max-<metric>=N] [--from=DATE] [--to=DATE] [--sort=FIELD] [--direction=asc|desc] [--offset=N]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).list(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "provider-statistics-get",
            aliases: ["provider-stats-get"],
            category: "providers",
            description:
                "Retrieve one provider statistics record by provider ID or name.",
            usage:
                "provider-statistics-get <provider>",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) => {
                const provider = args.join(" ").trim();

                if (!provider) {
                    throw new Error(
                        "A provider ID or name is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).get(
                        provider,
                        { signal }
                    )
                );
            }
        },
        {
            name: "provider-statistics-top",
            aliases: ["provider-stats-top"],
            category: "providers",
            description:
                "Rank providers from highest to lowest by a numeric metric.",
            usage:
                "provider-statistics-top [metric] [limit] [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) => {
                const parsed = parseRankingArguments(args);

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).top(
                        parsed.metric,
                        parsed.limit,
                        parsed.parameters,
                        { signal }
                    )
                );
            }
        },
        {
            name: "provider-statistics-bottom",
            aliases: ["provider-stats-bottom"],
            category: "providers",
            description:
                "Rank providers from lowest to highest by a numeric metric.",
            usage:
                "provider-statistics-bottom [metric] [limit] [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) => {
                const parsed = parseRankingArguments(args);

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).bottom(
                        parsed.metric,
                        parsed.limit,
                        parsed.parameters,
                        { signal }
                    )
                );
            }
        },
        filteredCommand(
            "provider-statistics-healthy",
            ["healthy-provider-statistics"],
            "List healthy provider statistics records.",
            "healthy"
        ),
        filteredCommand(
            "provider-statistics-degraded",
            ["degraded-provider-statistics"],
            "List degraded provider statistics records.",
            "degraded"
        ),
        filteredCommand(
            "provider-statistics-unavailable",
            ["unavailable-provider-statistics"],
            "List unavailable provider statistics records.",
            "unavailable"
        ),
        filteredCommand(
            "provider-statistics-inactive",
            ["inactive-provider-statistics"],
            "List inactive provider statistics records.",
            "inactive"
        ),
        {
            name: "provider-statistics-trends",
            aliases: ["provider-stats-trends"],
            category: "providers",
            description:
                "List provider statistics ordered by absolute trend change.",
            usage:
                "provider-statistics-trends [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).trends(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "provider-statistics-summary",
            aliases: ["provider-stats-summary"],
            category: "providers",
            description:
                "Summarize provider totals, averages, medians, percentiles, health, coverage, completeness, quality, success, latency, throughput, and availability.",
            usage:
                "provider-statistics-summary [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).summary(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "provider-statistics-analyze",
            aliases: ["provider-stats-analyze"],
            category: "providers",
            description:
                "Analyze provider metrics using the statistics worker.",
            usage:
                "provider-statistics-analyze [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).analyze(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "provider-statistics-health",
            aliases: ["provider-stats-health"],
            category: "providers",
            description:
                "Analyze provider health using the provider worker.",
            usage:
                "provider-statistics-health [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).health(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "provider-statistics-coverage",
            aliases: ["provider-stats-coverage"],
            category: "providers",
            description:
                "Analyze provider coverage using the provider worker.",
            usage:
                "provider-statistics-coverage [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).coverage(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "provider-statistics-cache-clear",
            aliases: ["provider-stats-cache-clear"],
            category: "providers",
            description:
                "Clear the provider-statistics response cache.",
            usage:
                "provider-statistics-cache-clear",
            handler: ({ context, writeJSON }) =>
                writeJSONValue(
                    writeJSON,
                    {
                        cleared:
                            requireService(context)
                                .clearCache()
                    }
                )
        },
        {
            name: "provider-statistics-status",
            category: "providers",
            description:
                "Show provider-statistics service status.",
            usage:
                "provider-statistics-status",
            handler: ({ context, writeJSON }) =>
                writeJSONValue(
                    writeJSON,
                    requireService(context).status()
                )
        }
    ];

    const api = Object.freeze({
        name: MODULE_NAME,
        version: VERSION,
        serviceName: SERVICE_NAME,
        statisticsWorkerName: STATISTICS_WORKER_NAME,
        providerWorkerName: PROVIDER_WORKER_NAME,
        numericMetrics: NUMERIC_METRICS,
        ProviderStatisticsService,
        normalizeParameters,
        normalizeRecord,
        normalizeResponse,
        normalizeRatio,
        normalizeMetric,
        percentile,
        metricSummary,
        summarize,
        resolveMetric,
        rankRecords,
        parseCommandArguments,
        parseRankingArguments,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        unmount,
        destroy: unmount,
        commands
    });

    window.SpeciedexTerminalProviderStatistics = api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules || {};

    window.SpeciedexTerminalModules[
        MODULE_NAME
    ] = api;

    dispatch(
        document,
        "speciedex:terminal-module-available",
        {
            name: MODULE_NAME,
            module: api,
            version: VERSION
        }
    );
})(window, document);
