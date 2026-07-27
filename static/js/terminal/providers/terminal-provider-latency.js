/*
========================================================================
Speciedex.org
Terminal ProviderLatency Module
========================================================================

Provider response, transport, queue, processing, and ingestion latency service
for SpeciedexTerminal.

Designed for browser integration through:

    _partials/splash.html
        -> _partials/terminal.html
        -> terminal loader
        -> static/js/terminal/providers/terminal-provider-latency.js

Features:

    • Validated provider-latency API requests
    • Provider, stage, endpoint, protocol, status, threshold, and date filters
    • Normalized latency and timing records
    • Minimum, maximum, average, median, p90, p95, and p99 summaries
    • TTL cache, inflight-request deduplication, and explicit refresh
    • AbortSignal support and request lifecycle tracking
    • Single-measurement retrieval with cache fallback
    • Slow, degraded, timeout, failed, successful, cached, and stage views
    • Optional provider-worker health and duplicate analysis
    • Idempotent service registration and safe teardown
    • Terminal command integration

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "ProviderLatency";
    const VERSION = "3.0.0";
    const SERVICE_NAME = "provider-latency";
    const WORKER_NAME = "provider";

    const DEFAULT_LIMIT = 50;
    const MIN_LIMIT = 1;
    const MAX_LIMIT = 1000;
    const DEFAULT_SLOW_THRESHOLD = 1000;
    const DEFAULT_CACHE_TTL = 30000;
    const MAX_CACHE_ENTRIES = 128;

    const SORT_FIELDS = Object.freeze([
        "measured_at",
        "created_at",
        "updated_at",
        "provider",
        "provider_id",
        "latency",
        "response_time",
        "ingestion_time",
        "queue_time",
        "network_time",
        "processing_time",
        "dns_time",
        "connect_time",
        "tls_time",
        "time_to_first_byte",
        "stage",
        "status",
        "endpoint",
        "protocol",
        "region",
        "country",
        "id"
    ]);

    const FILTER_FIELDS = Object.freeze([
        "provider",
        "provider_id",
        "stage",
        "status",
        "endpoint",
        "protocol",
        "region",
        "country",
        "measurement",
        "measurement_id",
        "job",
        "job_id",
        "run",
        "run_id",
        "category",
        "type"
    ]);

    const BOOLEAN_FIELDS = Object.freeze([
        "timeout",
        "degraded",
        "successful",
        "cached"
    ]);

    const NUMERIC_FILTERS = Object.freeze([
        ["min_latency", "minLatency"],
        ["max_latency", "maxLatency"],
        ["min_response_time", "minResponseTime"],
        ["max_response_time", "maxResponseTime"],
        ["min_ingestion_time", "minIngestionTime"],
        ["max_ingestion_time", "maxIngestionTime"],
        ["min_queue_time", "minQueueTime"],
        ["max_queue_time", "maxQueueTime"],
        ["min_network_time", "minNetworkTime"],
        ["max_network_time", "maxNetworkTime"],
        ["min_processing_time", "minProcessingTime"],
        ["max_processing_time", "maxProcessingTime"],
        ["threshold", "threshold"]
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
        if (
            !target ||
            typeof target.dispatchEvent !== "function"
        ) {
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

    function abortError(message = "Provider-latency request aborted.") {
        return createError(
            message,
            "PROVIDER_LATENCY_ABORTED",
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

    function numericValue(value, fallback = 0) {
        const number = Number(value);

        return Number.isFinite(number)
            ? number
            : fallback;
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

    function normalizeSort(value) {
        const normalized = normalizeKey(
            value || "measured_at"
        ).replace(/-/g, "_");

        if (!SORT_FIELDS.includes(normalized)) {
            throw new TypeError(
                `Unsupported provider-latency sort field: ${value}`
            );
        }

        return normalized;
    }

    function normalizeDirection(value) {
        const normalized = normalizeKey(
            value || "desc"
        );

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

        for (const [snakeCase, camelCase] of NUMERIC_FILTERS) {
            const value =
                source[snakeCase] ??
                source[camelCase];

            if (
                value === undefined ||
                value === null ||
                value === ""
            ) {
                continue;
            }

            normalized[snakeCase] = clampNumber(
                value,
                0,
                0,
                Number.MAX_SAFE_INTEGER
            );
        }

        validateRange(
            normalized,
            "min_latency",
            "max_latency",
            "latency"
        );

        validateRange(
            normalized,
            "min_response_time",
            "max_response_time",
            "response time"
        );

        validateRange(
            normalized,
            "min_ingestion_time",
            "max_ingestion_time",
            "ingestion time"
        );

        validateRange(
            normalized,
            "min_queue_time",
            "max_queue_time",
            "queue time"
        );

        validateRange(
            normalized,
            "min_network_time",
            "max_network_time",
            "network time"
        );

        validateRange(
            normalized,
            "min_processing_time",
            "max_processing_time",
            "processing time"
        );

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
                "Provider-latency start date must not be later than the end date."
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

    function normalizeRecord(record, index = 0) {
        if (
            !record ||
            typeof record !== "object"
        ) {
            const value = normalizeText(record);

            return {
                index,
                id: value,
                provider: "",
                provider_id: "",
                latency: 0,
                response_time: 0,
                ingestion_time: 0,
                queue_time: 0,
                network_time: 0,
                processing_time: 0,
                dns_time: 0,
                connect_time: 0,
                tls_time: 0,
                time_to_first_byte: 0,
                stage: "unknown",
                status: "unknown",
                timeout: false,
                degraded: false,
                successful: false,
                cached: false,
                endpoint: "",
                protocol: "",
                region: "",
                country: "",
                category: "",
                type: "",
                job_id: "",
                run_id: "",
                measured_at: "",
                created_at: "",
                updated_at: ""
            };
        }

        const latency = Math.max(
            0,
            numericValue(
                record.latency ??
                record.latency_ms ??
                record.latencyMs ??
                record.total_time ??
                record.totalTime,
                0
            )
        );

        const responseTime = Math.max(
            0,
            numericValue(
                record.response_time ??
                record.responseTime ??
                record.response_ms ??
                record.responseMs,
                latency
            )
        );

        const ingestionTime = Math.max(
            0,
            numericValue(
                record.ingestion_time ??
                record.ingestionTime ??
                record.ingestion_ms ??
                record.ingestionMs,
                0
            )
        );

        const status = normalizeKey(
            record.status ??
            record.state ??
            (
                record.timeout === true
                    ? "timeout"
                    : (
                        record.successful === false
                            ? "failed"
                            : "ok"
                    )
            )
        );

        const timeout =
            normalizeBoolean(record.timeout, false) ||
            status === "timeout";

        const successful =
            record.successful !== undefined
                ? normalizeBoolean(record.successful, false)
                : ![
                    "failed",
                    "error",
                    "timeout",
                    "unavailable",
                    "cancelled",
                    "canceled"
                ].includes(status);

        const degraded =
            normalizeBoolean(record.degraded, false) ||
            [
                "degraded",
                "slow",
                "warning"
            ].includes(status);

        return {
            ...record,
            index:
                record.index ??
                index,
            id: normalizeText(
                record.id ??
                record.measurement_id ??
                record.measurementId ??
                record.uuid ??
                `latency-${index + 1}`
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
            latency,
            response_time: responseTime,
            ingestion_time: ingestionTime,
            queue_time: positiveMetric(
                record.queue_time ??
                record.queueTime ??
                record.queue_ms ??
                record.queueMs
            ),
            network_time: positiveMetric(
                record.network_time ??
                record.networkTime ??
                record.network_ms ??
                record.networkMs
            ),
            processing_time: positiveMetric(
                record.processing_time ??
                record.processingTime ??
                record.processing_ms ??
                record.processingMs
            ),
            dns_time: positiveMetric(
                record.dns_time ??
                record.dnsTime ??
                record.dns_ms ??
                record.dnsMs
            ),
            connect_time: positiveMetric(
                record.connect_time ??
                record.connectTime ??
                record.connect_ms ??
                record.connectMs
            ),
            tls_time: positiveMetric(
                record.tls_time ??
                record.tlsTime ??
                record.tls_ms ??
                record.tlsMs
            ),
            time_to_first_byte: positiveMetric(
                record.time_to_first_byte ??
                record.timeToFirstByte ??
                record.ttfb
            ),
            stage: normalizeKey(
                record.stage ??
                record.phase ??
                record.operation ??
                "unknown"
            ),
            status,
            timeout,
            degraded,
            successful,
            cached: normalizeBoolean(
                record.cached ??
                record.cache_hit ??
                record.cacheHit,
                false
            ),
            endpoint: normalizeText(
                record.endpoint ??
                record.url ??
                record.path ??
                ""
            ),
            protocol: normalizeKey(
                record.protocol ??
                record.transport ??
                ""
            ),
            region: normalizeText(
                record.region ??
                ""
            ),
            country: normalizeText(
                record.country ??
                ""
            ),
            category: normalizeText(
                record.category ??
                ""
            ),
            type: normalizeText(
                record.type ??
                record.measurement_type ??
                record.measurementType ??
                ""
            ),
            job_id: normalizeText(
                record.job_id ??
                record.jobId ??
                ""
            ),
            run_id: normalizeText(
                record.run_id ??
                record.runId ??
                record.execution_id ??
                record.executionId ??
                ""
            ),
            measured_at:
                record.measured_at ??
                record.measuredAt ??
                record.timestamp ??
                record.created_at ??
                record.createdAt ??
                "",
            created_at:
                record.created_at ??
                record.createdAt ??
                "",
            updated_at:
                record.updated_at ??
                record.updatedAt ??
                record.last_updated ??
                record.lastUpdated ??
                ""
        };
    }

    function positiveMetric(value) {
        return Math.max(
            0,
            numericValue(value, 0)
        );
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
            .filter(value =>
                Number.isFinite(value) &&
                value >= 0
            );

        if (!numbers.length) {
            return {
                count: 0,
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

        const average =
            numbers.reduce(
                (sum, value) => sum + value,
                0
            ) / numbers.length;

        const variance =
            numbers.reduce(
                (sum, value) =>
                    sum + Math.pow(value - average, 2),
                0
            ) / numbers.length;

        return {
            count: numbers.length,
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

        const providers = new Map();
        const stages = new Map();
        const statuses = new Map();
        const endpoints = new Map();
        const protocols = new Map();
        const regions = new Map();
        const countries = new Map();
        const categories = new Map();
        const types = new Map();

        for (const measurement of values) {
            incrementMap(providers, measurement.provider);
            incrementMap(stages, measurement.stage);
            incrementMap(statuses, measurement.status);
            incrementMap(endpoints, measurement.endpoint);
            incrementMap(protocols, measurement.protocol);
            incrementMap(regions, measurement.region);
            incrementMap(countries, measurement.country);
            incrementMap(categories, measurement.category);
            incrementMap(types, measurement.type);
        }

        const successful = values.filter(
            item => item.successful
        ).length;

        const timeout = values.filter(
            item => item.timeout
        ).length;

        const degraded = values.filter(
            item => item.degraded
        ).length;

        const cached = values.filter(
            item => item.cached
        ).length;

        return {
            total: values.length,
            successful,
            failed: values.length - successful,
            timeout,
            degraded,
            cached,
            successRate:
                values.length
                    ? successful / values.length
                    : 0,
            timeoutRate:
                values.length
                    ? timeout / values.length
                    : 0,
            degradedRate:
                values.length
                    ? degraded / values.length
                    : 0,
            cacheHitRate:
                values.length
                    ? cached / values.length
                    : 0,
            latency: metricSummary(
                values.map(item => item.latency)
            ),
            responseTime: metricSummary(
                values.map(item => item.response_time)
            ),
            ingestionTime: metricSummary(
                values.map(item => item.ingestion_time)
            ),
            queueTime: metricSummary(
                values.map(item => item.queue_time)
            ),
            networkTime: metricSummary(
                values.map(item => item.network_time)
            ),
            processingTime: metricSummary(
                values.map(item => item.processing_time)
            ),
            dnsTime: metricSummary(
                values.map(item => item.dns_time)
            ),
            connectTime: metricSummary(
                values.map(item => item.connect_time)
            ),
            tlsTime: metricSummary(
                values.map(item => item.tls_time)
            ),
            timeToFirstByte: metricSummary(
                values.map(item => item.time_to_first_byte)
            ),
            providers: sortedObject(providers),
            stages: sortedObject(stages),
            statuses: sortedObject(statuses),
            endpoints: sortedObject(endpoints),
            protocols: sortedObject(protocols),
            regions: sortedObject(regions),
            countries: sortedObject(countries),
            categories: sortedObject(categories),
            types: sortedObject(types)
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

        if (
            payload &&
            typeof payload === "object"
        ) {
            const values =
                payload.records ??
                payload.items ??
                payload.latency ??
                payload.measurements ??
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

    function stableStringify(value) {
        if (
            value === null ||
            typeof value !== "object"
        ) {
            return JSON.stringify(value);
        }

        if (Array.isArray(value)) {
            return `[${value
                .map(stableStringify)
                .join(",")}]`;
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

    class ProviderLatencyService extends EventTarget {
        constructor(context, options = {}) {
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
            this.workerName = normalizeText(
                options.workerName ??
                options.worker_name ??
                WORKER_NAME
            );
        }

        ensureAvailable() {
            if (this.destroyed) {
                throw createError(
                    "Provider-latency service has been destroyed.",
                    "PROVIDER_LATENCY_DESTROYED"
                );
            }

            if (
                !this.context.api ||
                typeof this.context.api.get !== "function"
            ) {
                throw createError(
                    "Speciedex API client is unavailable.",
                    "PROVIDER_LATENCY_API_UNAVAILABLE"
                );
            }
        }

        emit(name, detail) {
            dispatch(this, name, detail);

            try {
                this.context.events?.emit?.(
                    `provider-latency:${name}`,
                    detail
                );
            } catch (_error) {
                /* Observer failures are isolated. */
            }

            dispatch(
                this.context.root,
                `speciedex:terminal-provider-latency-${name}`,
                detail,
                {
                    bubbles: true
                }
            );
        }

        createRequest(operation, detail = {}) {
            const id =
                `provider-latency:${Date.now()}:${++this.sequence}`;

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

            if (
                !force &&
                this.inflight.has(key)
            ) {
                return this.awaitWithSignal(
                    this.inflight.get(key),
                    signal
                );
            }

            const request = this.createRequest(
                "list",
                {
                    parameters: normalized
                }
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
                    "providers/latency",
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

        async get(id, options = {}) {
            this.ensureAvailable();

            const normalizedId = normalizeText(id);

            if (!normalizedId) {
                throw new TypeError(
                    "A latency measurement ID is required."
                );
            }

            throwIfAborted(options.signal);

            const request = this.createRequest(
                "get",
                {
                    measurement: normalizedId
                }
            );

            this.emit("request", {
                requestId: request.id,
                operation: "get",
                measurement: normalizedId
            });

            try {
                const payload = await this.context.api.get(
                    `providers/latency/${encodeURIComponent(normalizedId)}`,
                    {},
                    options
                );

                const item = normalizeRecord(payload, 0);

                this.finishRequest(request, item);

                this.emit("complete", {
                    requestId: request.id,
                    operation: "get",
                    measurement: item
                });

                return item;
            } catch (error) {
                const match = this.findCachedMeasurement(
                    normalizedId
                );

                if (match) {
                    this.finishRequest(request, match);

                    this.emit("fallback", {
                        requestId: request.id,
                        operation: "get",
                        measurement: match,
                        error
                    });

                    return match;
                }

                this.finishRequest(request, null, error);

                this.emit("error", {
                    requestId: request.id,
                    operation: "get",
                    measurement: normalizedId,
                    error
                });

                throw error;
            }
        }

        findCachedMeasurement(id) {
            const normalizedId = normalizeKey(id);

            for (const entry of this.cache.values()) {
                const match = entry.value?.records?.find(
                    item =>
                        normalizeKey(item.id) === normalizedId
                );

                if (match) {
                    return clone(match);
                }
            }

            return null;
        }

        async slow(
            threshold = DEFAULT_SLOW_THRESHOLD,
            parameters = {},
            options = {}
        ) {
            const normalizedThreshold = clampNumber(
                threshold,
                DEFAULT_SLOW_THRESHOLD,
                0,
                Number.MAX_SAFE_INTEGER
            );

            const result = await this.list(
                {
                    ...parameters,
                    min_latency: normalizedThreshold,
                    threshold: normalizedThreshold
                },
                options
            );

            const records = result.records.filter(
                item =>
                    item.latency >= normalizedThreshold
            );

            return {
                ...result,
                threshold: normalizedThreshold,
                records,
                returned: records.length,
                summary: summarize(records)
            };
        }

        async degraded(parameters = {}, options = {}) {
            return this.filteredView(
                {
                    ...parameters,
                    degraded: true
                },
                item => item.degraded,
                options
            );
        }

        async timeouts(parameters = {}, options = {}) {
            return this.filteredView(
                {
                    ...parameters,
                    timeout: true
                },
                item => item.timeout,
                options
            );
        }

        async failed(parameters = {}, options = {}) {
            return this.filteredView(
                {
                    ...parameters,
                    successful: false
                },
                item => !item.successful,
                options
            );
        }

        async successful(parameters = {}, options = {}) {
            return this.filteredView(
                {
                    ...parameters,
                    successful: true
                },
                item => item.successful,
                options
            );
        }

        async cached(parameters = {}, options = {}) {
            return this.filteredView(
                {
                    ...parameters,
                    cached: true
                },
                item => item.cached,
                options
            );
        }

        async recent(
            duration = 3600000,
            parameters = {},
            options = {}
        ) {
            const milliseconds = Math.max(
                0,
                numericValue(duration, 3600000)
            );

            const cutoff = Date.now() - milliseconds;

            return this.filteredView(
                {
                    ...parameters,
                    from: new Date(cutoff).toISOString()
                },
                item => {
                    const timestamp = Date.parse(
                        item.measured_at
                    );

                    return (
                        Number.isFinite(timestamp) &&
                        timestamp >= cutoff
                    );
                },
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

        async byProvider(
            provider,
            parameters = {},
            options = {}
        ) {
            const normalizedProvider = normalizeText(provider);

            if (!normalizedProvider) {
                throw new TypeError(
                    "A provider ID or name is required."
                );
            }

            return this.list(
                {
                    ...parameters,
                    provider: normalizedProvider
                },
                options
            );
        }

        async byStage(
            stage,
            parameters = {},
            options = {}
        ) {
            const normalizedStage = normalizeText(stage);

            if (!normalizedStage) {
                throw new TypeError(
                    "A latency stage is required."
                );
            }

            return this.list(
                {
                    ...parameters,
                    stage: normalizedStage
                },
                options
            );
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
                measurements: result.records,
                duration: result.duration,
                cache: result.cache
            };
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
                "duplicates",
                {
                    records: result.records,
                    fields: [
                        "provider_id",
                        "run_id",
                        "job_id",
                        "stage",
                        "endpoint",
                        "measured_at"
                    ]
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
                "health",
                {
                    providers: summarizeByProvider(
                        result.records
                    )
                },
                options
            );
        }

        async callWorker(type, payload, options = {}) {
            const workers =
                this.context.workers ??
                this.context.workerPool ??
                this.context.worker_pool;

            const candidates = [
                () => workers?.request?.(
                    this.workerName,
                    type,
                    payload,
                    options
                ),
                () => workers?.run?.(
                    this.workerName,
                    type,
                    payload,
                    options
                ),
                () => workers?.execute?.(
                    this.workerName,
                    type,
                    payload,
                    options
                ),
                () => workers?.call?.(
                    this.workerName,
                    type,
                    payload,
                    options
                ),
                () => this.context.services
                    ?.get?.("workers")
                    ?.request?.(
                        this.workerName,
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
                    if (
                        error?.code ===
                        "WORKER_UNAVAILABLE"
                    ) {
                        continue;
                    }

                    throw error;
                }
            }

            throw createError(
                "Provider worker service is unavailable.",
                "PROVIDER_LATENCY_WORKER_UNAVAILABLE"
            );
        }

        status() {
            return {
                version: VERSION,
                endpoint: "providers/latency",
                service: SERVICE_NAME,
                worker: this.workerName,
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
                    "providerLatency"
                );
            } catch (_error) {
                /* Teardown must remain safe. */
            }

            return true;
        }
    }

    function summarizeByProvider(records) {
        const providers = new Map();

        for (const item of records) {
            const key =
                item.provider_id ||
                item.provider ||
                "unknown";

            if (!providers.has(key)) {
                providers.set(key, {
                    id: key,
                    name: item.provider || key,
                    records: 0,
                    latency: 0,
                    errors: 0,
                    timeouts: 0,
                    degraded: 0,
                    status: "unknown"
                });
            }

            const provider = providers.get(key);

            provider.records += 1;
            provider.latency += item.latency;

            if (!item.successful) {
                provider.errors += 1;
            }

            if (item.timeout) {
                provider.timeouts += 1;
            }

            if (item.degraded) {
                provider.degraded += 1;
            }

            if (item.timeout || !item.successful) {
                provider.status = "failed";
            } else if (
                provider.status !== "failed" &&
                item.degraded
            ) {
                provider.status = "degraded";
            } else if (provider.status === "unknown") {
                provider.status = "available";
            }
        }

        return [...providers.values()].map(provider => ({
            ...provider,
            latency:
                provider.records > 0
                    ? provider.latency / provider.records
                    : 0
        }));
    }

    function initialize(context, options = {}) {
        if (
            !context ||
            typeof context !== "object"
        ) {
            throw new TypeError(
                "A terminal context is required."
            );
        }

        const existing =
            context.services?.get?.(SERVICE_NAME);

        if (
            existing instanceof ProviderLatencyService &&
            !existing.destroyed
        ) {
            context.providerLatency = existing;
            return existing;
        }

        if (
            context.providerLatency instanceof ProviderLatencyService &&
            !context.providerLatency.destroyed
        ) {
            return context.providerLatency;
        }

        const service = new ProviderLatencyService(
            context,
            options
        );

        context.providerLatency = service;

        context.registerService?.(
            SERVICE_NAME,
            service
        );

        context.registerService?.(
            "providerLatency",
            service
        );

        dispatch(
            document,
            "speciedex:terminal-provider-latency-ready",
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
            context?.providerLatency ??
            context?.services?.get?.(SERVICE_NAME);

        if (!(service instanceof ProviderLatencyService)) {
            return false;
        }

        const destroyed = service.destroy();

        if (context?.providerLatency === service) {
            context.providerLatency = null;
        }

        return destroyed;
    }

    function requireService(context) {
        const service =
            context?.providerLatency ??
            context?.services?.get?.(SERVICE_NAME);

        if (!(service instanceof ProviderLatencyService)) {
            throw createError(
                "Provider-latency service is unavailable.",
                "PROVIDER_LATENCY_SERVICE_UNAVAILABLE"
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
                "--timeout": ["timeout", true],
                "--no-timeout": ["timeout", false],
                "--degraded": ["degraded", true],
                "--not-degraded": ["degraded", false],
                "--successful": ["successful", true],
                "--failed": ["successful", false],
                "--cached": ["cached", true],
                "--uncached": ["cached", false]
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

                const normalizedName = name
                    .replace(/-/g, "_");

                const aliases = {
                    query: "q",
                    order: "direction",
                    since: "from",
                    start: "from",
                    until: "to",
                    end: "to",
                    minlatency: "min_latency",
                    maxlatency: "max_latency",
                    minresponsetime: "min_response_time",
                    maxresponsetime: "max_response_time",
                    miningestiontime: "min_ingestion_time",
                    maxingestiontime: "max_ingestion_time",
                    minqueuetime: "min_queue_time",
                    maxqueuetime: "max_queue_time",
                    minnetworktime: "min_network_time",
                    maxnetworktime: "max_network_time",
                    minprocessingtime: "min_processing_time",
                    maxprocessingtime: "max_processing_time"
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

    const commands = [
        {
            name: "provider-latency",
            aliases: [
                "providers-latency"
            ],
            category: "providers",
            description:
                "Inspect provider response and ingestion latency.",
            usage:
                "provider-latency [query] [limit] [--provider=ID] [--stage=STAGE] [--status=STATUS] [--endpoint=ENDPOINT] [--protocol=PROTOCOL] [--region=REGION] [--country=COUNTRY] [--measurement=ID] [--job=ID] [--run=ID] [--category=CATEGORY] [--type=TYPE] [--timeout|--no-timeout] [--degraded|--not-degraded] [--successful|--failed] [--cached|--uncached] [--min-latency=MS] [--max-latency=MS] [--min-response-time=MS] [--max-response-time=MS] [--min-ingestion-time=MS] [--max-ingestion-time=MS] [--min-queue-time=MS] [--max-queue-time=MS] [--min-network-time=MS] [--max-network-time=MS] [--min-processing-time=MS] [--max-processing-time=MS] [--from=DATE] [--to=DATE] [--sort=FIELD] [--direction=asc|desc] [--offset=N]",
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
            name: "provider-latency-measurement",
            aliases: [
                "provider-latency-get"
            ],
            category: "providers",
            description:
                "Retrieve one provider latency measurement by ID.",
            usage:
                "provider-latency-measurement <id>",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error(
                        "A latency measurement ID is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).get(
                        id,
                        { signal }
                    )
                );
            }
        },
        {
            name: "provider-latency-slow",
            aliases: [
                "slow-providers"
            ],
            category: "providers",
            description:
                "List latency measurements at or above a threshold.",
            usage:
                "provider-latency-slow [threshold-ms] [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) => {
                let threshold = DEFAULT_SLOW_THRESHOLD;
                let filters = args;

                if (
                    args.length &&
                    !String(args[0]).startsWith("--") &&
                    Number.isFinite(Number(args[0]))
                ) {
                    threshold = Number(args[0]);
                    filters = args.slice(1);
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).slow(
                        threshold,
                        parseCommandArguments(filters),
                        { signal }
                    )
                );
            }
        },
        {
            name: "provider-latency-degraded",
            aliases: [
                "degraded-provider-latency"
            ],
            category: "providers",
            description:
                "List degraded provider latency measurements.",
            usage:
                "provider-latency-degraded [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).degraded(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "provider-latency-timeouts",
            aliases: [
                "provider-timeouts"
            ],
            category: "providers",
            description:
                "List provider latency timeout measurements.",
            usage:
                "provider-latency-timeouts [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).timeouts(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "provider-latency-failed",
            aliases: [
                "failed-provider-latency"
            ],
            category: "providers",
            description:
                "List unsuccessful provider latency measurements.",
            usage:
                "provider-latency-failed [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).failed(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "provider-latency-recent",
            aliases: [
                "recent-provider-latency"
            ],
            category: "providers",
            description:
                "List provider latency measurements from a recent time window.",
            usage:
                "provider-latency-recent [milliseconds] [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) => {
                let duration = 3600000;
                let filters = args;

                if (
                    args.length &&
                    !String(args[0]).startsWith("--") &&
                    Number.isFinite(Number(args[0]))
                ) {
                    duration = Number(args[0]);
                    filters = args.slice(1);
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).recent(
                        duration,
                        parseCommandArguments(filters),
                        { signal }
                    )
                );
            }
        },
        {
            name: "provider-latency-summary",
            aliases: [
                "provider-performance-summary"
            ],
            category: "providers",
            description:
                "Summarize latency metrics, percentiles, stages, providers, endpoints, protocols, and statuses.",
            usage:
                "provider-latency-summary [filters]",
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
            name: "provider-latency-duplicates",
            aliases: [
                "provider-performance-duplicates"
            ],
            category: "providers",
            description:
                "Analyze duplicate latency measurements using the provider worker.",
            usage:
                "provider-latency-duplicates [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).duplicates(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "provider-latency-health",
            aliases: [
                "provider-performance-health"
            ],
            category: "providers",
            description:
                "Analyze provider health from latency measurements.",
            usage:
                "provider-latency-health [filters]",
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
            name: "provider-latency-cache-clear",
            aliases: [
                "provider-performance-cache-clear"
            ],
            category: "providers",
            description:
                "Clear the provider-latency response cache.",
            usage:
                "provider-latency-cache-clear",
            handler: ({
                context,
                writeJSON
            }) =>
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
            name: "provider-latency-status",
            category: "providers",
            description:
                "Show provider-latency service status.",
            usage:
                "provider-latency-status",
            handler: ({
                context,
                writeJSON
            }) =>
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
        workerName: WORKER_NAME,
        ProviderLatencyService,
        normalizeParameters,
        normalizeRecord,
        normalizeResponse,
        percentile,
        metricSummary,
        summarize,
        summarizeByProvider,
        parseCommandArguments,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        unmount,
        destroy: unmount,
        commands
    });

    window.SpeciedexTerminalProviderLatency = api;

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
