/*
========================================================================
Speciedex.org
Terminal Providers Module
========================================================================

Provider registry, query service, worker bridge, cache, and terminal command
integration for SpeciedexTerminal.

Designed for browser integration through:

    _partials/splash.html
        -> _partials/terminal.html
        -> terminal loader
        -> static/js/terminal/providers/terminal-providers.js

Features:

    • Validated provider-list API requests
    • Provider, status, capability, protocol, region, and pagination filters
    • Normalized provider records and response envelopes
    • Provider health, capability, protocol, and availability summaries
    • Single-provider retrieval with cache fallback
    • TTL cache, inflight-request deduplication, and explicit refresh
    • AbortSignal support and request lifecycle tracking
    • Optional provider-worker health, overlap, coverage, and duplicate analysis
    • Idempotent service registration and safe teardown
    • Terminal command integration

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Providers";
    const VERSION = "3.0.0";
    const SERVICE_NAME = "providers";
    const WORKER_NAME = "provider";

    const DEFAULT_LIMIT = 50;
    const MIN_LIMIT = 1;
    const MAX_LIMIT = 1000;
    const DEFAULT_CACHE_TTL = 60000;
    const MAX_CACHE_ENTRIES = 128;

    const SORT_FIELDS = Object.freeze([
        "name",
        "id",
        "status",
        "enabled",
        "available",
        "latency",
        "errors",
        "requests",
        "successes",
        "success_rate",
        "records",
        "updated_at",
        "priority",
        "region",
        "country",
        "type",
        "category",
        "license"
    ]);

    const FILTER_FIELDS = Object.freeze([
        "provider",
        "status",
        "capability",
        "protocol",
        "region",
        "country",
        "type",
        "category",
        "license"
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

    function abortError(message = "Provider request aborted.") {
        return createError(
            message,
            "PROVIDERS_ABORTED",
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
            value || "name"
        ).replace(/-/g, "_");

        if (!SORT_FIELDS.includes(normalized)) {
            throw new TypeError(
                `Unsupported provider sort field: ${value}`
            );
        }

        return normalized;
    }

    function normalizeDirection(value) {
        const normalized = normalizeKey(
            value || "asc"
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

    function normalizeStringArray(value) {
        if (Array.isArray(value)) {
            return [
                ...new Set(
                    value
                        .flatMap(item =>
                            typeof item === "string"
                                ? item.split(/[,\s]+/)
                                : [item]
                        )
                        .map(normalizeText)
                        .filter(Boolean)
                )
            ];
        }

        const text = normalizeText(value);

        if (!text) {
            return [];
        }

        return [
            ...new Set(
                text
                    .split(/[,\s]+/)
                    .map(normalizeText)
                    .filter(Boolean)
            )
        ];
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

        for (const field of ["enabled", "available"]) {
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
                "Provider start date must not be later than the end date."
            );
        }

        return normalized;
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
                name: value,
                enabled: false,
                available: false,
                status: "unknown",
                latency: 0,
                errors: 0,
                requests: 0,
                successes: 0,
                successRate: null,
                records: 0,
                priority: 0,
                region: "",
                country: "",
                type: "",
                category: "",
                license: "",
                capabilities: [],
                protocols: [],
                endpoints: [],
                updated_at: ""
            };
        }

        const explicitlyEnabled =
            record.enabled ??
            record.is_enabled ??
            record.isEnabled;

        const explicitlyDisabled =
            record.disabled ??
            record.is_disabled ??
            record.isDisabled;

        const enabled =
            explicitlyEnabled !== undefined
                ? normalizeBoolean(explicitlyEnabled, true)
                : !normalizeBoolean(explicitlyDisabled, false);

        const status = normalizeKey(
            record.status ??
            record.state ??
            (
                enabled
                    ? "unknown"
                    : "disabled"
            )
        );

        const unavailableStatuses = new Set([
            "offline",
            "down",
            "failed",
            "error",
            "disabled",
            "unavailable",
            "blocked"
        ]);

        const available =
            record.available !== undefined
                ? normalizeBoolean(record.available, false)
                : (
                    record.is_available !== undefined
                        ? normalizeBoolean(
                            record.is_available,
                            false
                        )
                        : enabled &&
                          !unavailableStatuses.has(status)
                );

        const latency = Math.max(
            0,
            numericValue(
                record.latency ??
                record.latency_ms ??
                record.latencyMs ??
                record.response_time_ms ??
                record.responseTimeMs,
                0
            )
        );

        const errors = Math.max(
            0,
            numericValue(
                record.errors ??
                record.error_count ??
                record.errorCount ??
                record.failed_requests ??
                record.failedRequests,
                0
            )
        );

        const requests = Math.max(
            0,
            numericValue(
                record.requests ??
                record.request_count ??
                record.requestCount ??
                record.total_requests ??
                record.totalRequests,
                0
            )
        );

        const successes = Math.max(
            0,
            numericValue(
                record.successes ??
                record.success_count ??
                record.successCount ??
                record.successful_requests ??
                record.successfulRequests,
                Math.max(0, requests - errors)
            )
        );

        const successRate =
            record.success_rate !== undefined ||
            record.successRate !== undefined
                ? Math.max(
                    0,
                    Math.min(
                        1,
                        numericValue(
                            record.success_rate ??
                            record.successRate,
                            0
                        )
                    )
                )
                : (
                    requests > 0
                        ? successes / requests
                        : (
                            errors > 0
                                ? 0
                                : null
                        )
                );

        return {
            ...record,
            index:
                record.index ??
                index,
            id: normalizeText(
                record.id ??
                record.key ??
                record.slug ??
                record.provider_id ??
                record.providerId ??
                record.name ??
                `provider-${index + 1}`
            ),
            name: normalizeText(
                record.name ??
                record.label ??
                record.title ??
                record.id ??
                `Provider ${index + 1}`
            ),
            enabled,
            available,
            status,
            latency,
            errors,
            requests,
            successes,
            successRate,
            records: Math.max(
                0,
                numericValue(
                    record.records ??
                    record.record_count ??
                    record.recordCount ??
                    record.total_records ??
                    record.totalRecords,
                    0
                )
            ),
            priority: numericValue(
                record.priority,
                0
            ),
            region: normalizeText(
                record.region ??
                ""
            ),
            country: normalizeText(
                record.country ??
                ""
            ),
            type: normalizeText(
                record.type ??
                record.provider_type ??
                record.providerType ??
                ""
            ),
            category: normalizeText(
                record.category ??
                ""
            ),
            license: normalizeText(
                record.license ??
                record.licence ??
                ""
            ),
            capabilities: normalizeStringArray(
                record.capabilities ??
                record.features ??
                record.supports
            ),
            protocols: normalizeStringArray(
                record.protocols ??
                record.protocol ??
                record.transports
            ),
            endpoints: normalizeEndpoints(
                record.endpoints ??
                record.endpoint
            ),
            updated_at:
                record.updated_at ??
                record.updatedAt ??
                record.last_updated ??
                record.lastUpdated ??
                ""
        };
    }

    function normalizeEndpoints(value) {
        if (Array.isArray(value)) {
            return value.filter(item =>
                item !== undefined &&
                item !== null &&
                item !== ""
            );
        }

        if (
            value === undefined ||
            value === null ||
            value === ""
        ) {
            return [];
        }

        return [value];
    }

    function percentile(values, fraction) {
        if (!values.length) {
            return 0;
        }

        const sorted = [...values].sort(
            (left, right) => left - right
        );

        const position =
            (sorted.length - 1) * fraction;

        const lower = Math.floor(position);
        const upper = Math.ceil(position);

        if (lower === upper) {
            return sorted[lower];
        }

        const weight = position - lower;

        return (
            sorted[lower] * (1 - weight) +
            sorted[upper] * weight
        );
    }

    function summarize(records) {
        const values = Array.isArray(records)
            ? records
            : [];

        const enabled = values.filter(
            provider => provider.enabled
        );

        const available = enabled.filter(
            provider => provider.available
        );

        const latencies = enabled
            .map(provider =>
                numericValue(provider.latency, 0)
            )
            .filter(value => value > 0);

        const capabilities = new Map();
        const protocols = new Map();
        const statuses = new Map();
        const regions = new Map();
        const countries = new Map();
        const categories = new Map();
        const licenses = new Map();

        for (const provider of values) {
            incrementMap(
                statuses,
                provider.status || "unknown"
            );

            incrementMap(
                regions,
                provider.region || "unknown"
            );

            incrementMap(
                countries,
                provider.country || "unknown"
            );

            incrementMap(
                categories,
                provider.category || "unknown"
            );

            incrementMap(
                licenses,
                provider.license || "unknown"
            );

            for (const capability of provider.capabilities || []) {
                incrementMap(capabilities, capability);
            }

            for (const protocol of provider.protocols || []) {
                incrementMap(protocols, protocol);
            }
        }

        const totalErrors = values.reduce(
            (sum, provider) =>
                sum + numericValue(provider.errors, 0),
            0
        );

        const totalRequests = values.reduce(
            (sum, provider) =>
                sum + numericValue(provider.requests, 0),
            0
        );

        const totalSuccesses = values.reduce(
            (sum, provider) =>
                sum + numericValue(provider.successes, 0),
            0
        );

        return {
            total: values.length,
            enabled: enabled.length,
            disabled: values.length - enabled.length,
            available: available.length,
            unavailable: enabled.length - available.length,
            errors: totalErrors,
            requests: totalRequests,
            successes: totalSuccesses,
            aggregateSuccessRate:
                totalRequests > 0
                    ? totalSuccesses / totalRequests
                    : null,
            records: values.reduce(
                (sum, provider) =>
                    sum + numericValue(provider.records, 0),
                0
            ),
            averageLatency:
                latencies.length
                    ? latencies.reduce(
                        (sum, value) => sum + value,
                        0
                    ) / latencies.length
                    : 0,
            medianLatency: percentile(latencies, 0.5),
            p95Latency: percentile(latencies, 0.95),
            minimumLatency:
                latencies.length
                    ? Math.min(...latencies)
                    : 0,
            maximumLatency:
                latencies.length
                    ? Math.max(...latencies)
                    : 0,
            statuses: sortedObject(statuses),
            capabilities: sortedObject(capabilities),
            protocols: sortedObject(protocols),
            regions: sortedObject(regions),
            countries: sortedObject(countries),
            categories: sortedObject(categories),
            licenses: sortedObject(licenses)
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
        const page =
            limit > 0
                ? Math.floor(offset / limit) + 1
                : 1;

        const pages =
            limit > 0
                ? Math.ceil(total / limit)
                : (total > 0 ? 1 : 0);

        return {
            ...result,
            returned,
            page,
            pages,
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
        if (
            typeof structuredClone === "function"
        ) {
            try {
                return structuredClone(value);
            } catch (_error) {
                /* Fall through. */
            }
        }

        return JSON.parse(JSON.stringify(value));
    }

    class ProvidersService extends EventTarget {
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
                    "Providers service has been destroyed.",
                    "PROVIDERS_DESTROYED"
                );
            }

            if (
                !this.context.api ||
                typeof this.context.api.get !== "function"
            ) {
                throw createError(
                    "Speciedex API client is unavailable.",
                    "PROVIDERS_API_UNAVAILABLE"
                );
            }
        }

        emit(name, detail) {
            dispatch(this, name, detail);

            try {
                this.context.events?.emit?.(
                    `providers:${name}`,
                    detail
                );
            } catch (_error) {
                /* Observer failures are isolated. */
            }

            dispatch(
                this.context.root,
                `speciedex:terminal-providers-${name}`,
                detail,
                {
                    bubbles: true
                }
            );
        }

        createRequest(operation, detail = {}) {
            const id =
                `providers:${Date.now()}:${++this.sequence}`;

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
                    "providers",
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
                    "A provider ID or name is required."
                );
            }

            throwIfAborted(options.signal);

            const request = this.createRequest(
                "get",
                {
                    provider: normalizedId
                }
            );

            this.emit("request", {
                requestId: request.id,
                operation: "get",
                provider: normalizedId
            });

            try {
                const payload = await this.context.api.get(
                    `providers/${encodeURIComponent(normalizedId)}`,
                    {},
                    options
                );

                const provider = normalizeRecord(payload, 0);

                this.finishRequest(request, provider);

                this.emit("complete", {
                    requestId: request.id,
                    operation: "get",
                    provider
                });

                return provider;
            } catch (error) {
                const match = this.findCachedProvider(
                    normalizedId
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
                    provider: normalizedId,
                    error
                });

                throw error;
            }
        }

        findCachedProvider(id) {
            const normalizedId = normalizeKey(id);

            for (const entry of this.cache.values()) {
                const match = entry.value?.records?.find(
                    provider =>
                        normalizeKey(provider.id) === normalizedId ||
                        normalizeKey(provider.name) === normalizedId
                );

                if (match) {
                    return clone(match);
                }
            }

            return null;
        }

        async available(parameters = {}, options = {}) {
            const result = await this.list(
                {
                    ...parameters,
                    enabled: true,
                    available: true
                },
                options
            );

            const records = result.records.filter(
                provider =>
                    provider.enabled &&
                    provider.available
            );

            return {
                ...result,
                records,
                returned: records.length,
                summary: summarize(records)
            };
        }

        async byCapability(
            capability,
            parameters = {},
            options = {}
        ) {
            const normalizedCapability = normalizeText(
                capability
            );

            if (!normalizedCapability) {
                throw new TypeError(
                    "A provider capability is required."
                );
            }

            return this.list(
                {
                    ...parameters,
                    capability: normalizedCapability
                },
                options
            );
        }

        async byProtocol(
            protocol,
            parameters = {},
            options = {}
        ) {
            const normalizedProtocol = normalizeText(
                protocol
            );

            if (!normalizedProtocol) {
                throw new TypeError(
                    "A provider protocol is required."
                );
            }

            return this.list(
                {
                    ...parameters,
                    protocol: normalizedProtocol
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
                providers: result.records,
                duration: result.duration,
                cache: result.cache
            };
        }

        async analyze(operation, payload = {}, options = {}) {
            if (this.destroyed) {
                throw createError(
                    "Providers service has been destroyed.",
                    "PROVIDERS_DESTROYED"
                );
            }

            const normalizedOperation = normalizeKey(operation);

            if (!normalizedOperation) {
                throw new TypeError(
                    "A provider analysis operation is required."
                );
            }

            const request = this.createRequest(
                `worker:${normalizedOperation}`
            );

            this.emit("analysis-request", {
                requestId: request.id,
                operation: normalizedOperation
            });

            try {
                const result = await this.callWorker(
                    normalizedOperation,
                    payload,
                    options
                );

                this.finishRequest(request, result);

                this.emit("analysis-complete", {
                    requestId: request.id,
                    operation: normalizedOperation,
                    result
                });

                return result;
            } catch (error) {
                this.finishRequest(request, null, error);

                this.emit("analysis-error", {
                    requestId: request.id,
                    operation: normalizedOperation,
                    error
                });

                throw error;
            }
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
                "PROVIDERS_WORKER_UNAVAILABLE"
            );
        }

        health(providers, options = {}) {
            return this.analyze(
                "health",
                {
                    providers,
                    ...options
                },
                options
            );
        }

        overlap(left, right, options = {}) {
            return this.analyze(
                "overlap",
                {
                    left,
                    right,
                    ...options
                },
                options
            );
        }

        coverage(providers, options = {}) {
            return this.analyze(
                "coverage",
                {
                    providers,
                    ...options
                },
                options
            );
        }

        duplicates(records, options = {}) {
            return this.analyze(
                "duplicates",
                {
                    records,
                    ...options
                },
                options
            );
        }

        status() {
            return {
                version: VERSION,
                endpoint: "providers",
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
                    "provider"
                );
            } catch (_error) {
                /* Teardown must remain safe. */
            }

            return true;
        }
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
            existing instanceof ProvidersService &&
            !existing.destroyed
        ) {
            context.providers = existing;
            return existing;
        }

        if (
            context.providers instanceof ProvidersService &&
            !context.providers.destroyed
        ) {
            return context.providers;
        }

        const service = new ProvidersService(
            context,
            options
        );

        context.providers = service;

        context.registerService?.(
            SERVICE_NAME,
            service
        );

        context.registerService?.(
            "provider",
            service
        );

        dispatch(
            document,
            "speciedex:terminal-providers-ready",
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
            context?.providers ??
            context?.services?.get?.(SERVICE_NAME);

        if (!(service instanceof ProvidersService)) {
            return false;
        }

        const destroyed = service.destroy();

        if (context?.providers === service) {
            context.providers = null;
        }

        return destroyed;
    }

    function requireService(context) {
        const service =
            context?.providers ??
            context?.services?.get?.(SERVICE_NAME);

        if (!(service instanceof ProvidersService)) {
            throw createError(
                "Providers service is unavailable.",
                "PROVIDERS_SERVICE_UNAVAILABLE"
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

            if (argument === "--available") {
                parameters.available = true;
                continue;
            }

            if (argument === "--enabled") {
                parameters.enabled = true;
                continue;
            }

            if (argument === "--disabled") {
                parameters.enabled = false;
                continue;
            }

            if (argument === "--unavailable") {
                parameters.available = false;
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

    const commands = [
        {
            name: "providers",
            aliases: [
                "provider-list"
            ],
            category: "providers",
            description:
                "List and search all configured providers.",
            usage:
                "providers [query] [limit] [--status=STATUS] [--capability=NAME] [--protocol=NAME] [--region=REGION] [--country=COUNTRY] [--type=TYPE] [--category=CATEGORY] [--license=LICENSE] [--enabled=true|false] [--available=true|false] [--from=DATE] [--to=DATE] [--sort=FIELD] [--direction=asc|desc] [--offset=N]",
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
            name: "provider",
            aliases: [
                "provider-get"
            ],
            category: "providers",
            description:
                "Retrieve one provider by ID or name.",
            usage:
                "provider <id|name>",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error(
                        "A provider ID or name is required."
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
            name: "providers-available",
            aliases: [
                "available-providers"
            ],
            category: "providers",
            description:
                "List enabled and currently available providers.",
            usage:
                "providers-available [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).available(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "providers-summary",
            aliases: [
                "provider-summary"
            ],
            category: "providers",
            description:
                "Summarize provider availability, health, capabilities, and protocols.",
            usage:
                "providers-summary [filters]",
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
            name: "providers-health",
            aliases: [
                "provider-health"
            ],
            category: "providers",
            description:
                "Analyze provider health using the provider worker.",
            usage:
                "providers-health [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) => {
                const service = requireService(context);
                const result = await service.list(
                    parseCommandArguments(args),
                    { signal }
                );

                return writeJSONValue(
                    writeJSON,
                    await service.health(
                        result.records,
                        { signal }
                    )
                );
            }
        },
        {
            name: "providers-cache-clear",
            aliases: [
                "provider-cache-clear"
            ],
            category: "providers",
            description:
                "Clear the provider-service response cache.",
            usage:
                "providers-cache-clear",
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
            name: "providers-status",
            category: "providers",
            description:
                "Show provider-service status.",
            usage:
                "providers-status",
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
        ProvidersService,
        normalizeParameters,
        normalizeRecord,
        normalizeResponse,
        normalizeStringArray,
        summarize,
        parseCommandArguments,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        unmount,
        destroy: unmount,
        commands
    });

    window.SpeciedexTerminalProviders = api;

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
