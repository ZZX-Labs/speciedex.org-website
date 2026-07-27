/*
========================================================================
Speciedex.org
Terminal ProviderErrors Module
========================================================================

Provider ingestion, validation, transport, and runtime error service for
SpeciedexTerminal.

Designed for browser integration through:

    _partials/splash.html
        -> _partials/terminal.html
        -> terminal loader
        -> static/js/terminal/providers/terminal-provider-errors.js

Features:

    • Validated provider-error API requests
    • Provider, severity, stage, code, status, source, retry, and date filters
    • Normalized provider error and diagnostic records
    • Severity, stage, provider, code, source, retry, and timing summaries
    • TTL cache, inflight-request deduplication, and explicit refresh
    • AbortSignal support and request lifecycle tracking
    • Single-error retrieval with cache fallback
    • Active, resolved, retryable, exhausted, fatal, validation, and recent views
    • Optional provider-worker duplicate and health analysis
    • Idempotent service registration and safe teardown
    • Terminal command integration

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "ProviderErrors";
    const VERSION = "3.0.0";
    const SERVICE_NAME = "provider-errors";
    const WORKER_NAME = "provider";

    const DEFAULT_LIMIT = 50;
    const MIN_LIMIT = 1;
    const MAX_LIMIT = 1000;
    const DEFAULT_CACHE_TTL = 30000;
    const MAX_CACHE_ENTRIES = 128;

    const SORT_FIELDS = Object.freeze([
        "occurred_at",
        "created_at",
        "updated_at",
        "resolved_at",
        "provider",
        "provider_id",
        "severity",
        "stage",
        "code",
        "status",
        "retry_count",
        "max_retries",
        "source",
        "category",
        "type",
        "id"
    ]);

    const FILTER_FIELDS = Object.freeze([
        "provider",
        "provider_id",
        "severity",
        "stage",
        "code",
        "status",
        "source",
        "field",
        "record",
        "record_id",
        "job",
        "job_id",
        "run",
        "run_id",
        "error",
        "error_id",
        "category",
        "type"
    ]);

    const BOOLEAN_FIELDS = Object.freeze([
        "active",
        "resolved",
        "retryable",
        "fatal",
        "validation"
    ]);

    const SEVERITY_WEIGHTS = Object.freeze({
        trace: 0,
        debug: 1,
        info: 2,
        notice: 3,
        warning: 4,
        error: 5,
        fatal: 6
    });

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

    function abortError(message = "Provider-error request aborted.") {
        return createError(
            message,
            "PROVIDER_ERRORS_ABORTED",
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
            value || "occurred_at"
        ).replace(/-/g, "_");

        if (!SORT_FIELDS.includes(normalized)) {
            throw new TypeError(
                `Unsupported provider-error sort field: ${value}`
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

    function normalizeSeverity(value, fallback = "error") {
        const normalized = normalizeKey(
            value || fallback
        );

        const aliases = {
            warn: "warning",
            critical: "fatal",
            severe: "fatal",
            informational: "info",
            information: "info",
            err: "error"
        };

        return aliases[normalized] || normalized;
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

        const minimumRetries =
            source.minRetries ??
            source.min_retries;

        const maximumRetries =
            source.maxRetries ??
            source.max_retries;

        if (
            minimumRetries !== undefined &&
            minimumRetries !== null &&
            minimumRetries !== ""
        ) {
            normalized.min_retries = clampInteger(
                minimumRetries,
                0,
                0,
                Number.MAX_SAFE_INTEGER
            );
        }

        if (
            maximumRetries !== undefined &&
            maximumRetries !== null &&
            maximumRetries !== ""
        ) {
            normalized.max_retries = clampInteger(
                maximumRetries,
                Number.MAX_SAFE_INTEGER,
                0,
                Number.MAX_SAFE_INTEGER
            );
        }

        if (
            normalized.min_retries !== undefined &&
            normalized.max_retries !== undefined &&
            normalized.min_retries >
            normalized.max_retries
        ) {
            throw new RangeError(
                "Minimum retries must not exceed maximum retries."
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
                "Provider-error start date must not be later than the end date."
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
                provider: "",
                provider_id: "",
                severity: "error",
                severityWeight: SEVERITY_WEIGHTS.error,
                stage: "unknown",
                code: "",
                type: "",
                category: "",
                message: value,
                details: null,
                status: "active",
                active: true,
                resolved: false,
                retryable: false,
                fatal: false,
                validation: false,
                exhausted: false,
                retry_count: 0,
                max_retries: 0,
                remaining_retries: 0,
                record_id: "",
                job_id: "",
                run_id: "",
                field: "",
                source: "",
                sources: [],
                stack: "",
                occurred_at: "",
                created_at: "",
                updated_at: "",
                resolved_at: ""
            };
        }

        const severity = normalizeSeverity(
            record.severity ??
            record.level ??
            record.priority ??
            "error"
        );

        const status = normalizeKey(
            record.status ??
            record.state ??
            (
                record.resolved === true
                    ? "resolved"
                    : "active"
            )
        );

        const resolved =
            normalizeBoolean(record.resolved, false) ||
            [
                "resolved",
                "closed",
                "dismissed",
                "ignored"
            ].includes(status);

        const active =
            normalizeBoolean(record.active, true) &&
            !resolved &&
            ![
                "inactive",
                "deleted",
                "retired"
            ].includes(status);

        const fatal =
            normalizeBoolean(record.fatal, false) ||
            severity === "fatal";

        const retryable = normalizeBoolean(
            record.retryable ??
            record.can_retry ??
            record.canRetry,
            false
        );

        const stage = normalizeKey(
            record.stage ??
            record.phase ??
            record.operation ??
            record.pipeline_stage ??
            record.pipelineStage ??
            "unknown"
        );

        const validation =
            normalizeBoolean(record.validation, false) ||
            stage === "validation" ||
            normalizeKey(record.category) === "validation";

        const retryCount = Math.max(
            0,
            numericValue(
                record.retry_count ??
                record.retryCount ??
                record.retries,
                0
            )
        );

        const maxRetries = Math.max(
            0,
            numericValue(
                record.max_retries ??
                record.maxRetries,
                0
            )
        );

        const exhausted =
            maxRetries > 0 &&
            retryCount >= maxRetries;

        return {
            ...record,
            index:
                record.index ??
                index,
            id: normalizeText(
                record.id ??
                record.error_id ??
                record.errorId ??
                record.uuid ??
                `provider-error-${index + 1}`
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
            severity,
            severityWeight:
                SEVERITY_WEIGHTS[severity] ??
                SEVERITY_WEIGHTS.error,
            stage,
            code: normalizeText(
                record.code ??
                record.error_code ??
                record.errorCode ??
                record.name ??
                ""
            ),
            type: normalizeText(
                record.type ??
                record.error_type ??
                record.errorType ??
                ""
            ),
            category: normalizeText(
                record.category ??
                ""
            ),
            message: normalizeText(
                record.message ??
                record.error ??
                record.detail ??
                record.description ??
                ""
            ),
            details:
                record.details ??
                record.context ??
                record.metadata ??
                null,
            status,
            active,
            resolved,
            retryable,
            fatal,
            validation,
            exhausted,
            retry_count: retryCount,
            max_retries: maxRetries,
            remaining_retries:
                maxRetries > 0
                    ? Math.max(0, maxRetries - retryCount)
                    : null,
            record_id: normalizeText(
                record.record_id ??
                record.recordId ??
                record.entity_id ??
                record.entityId ??
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
            field: normalizeText(
                record.field ??
                record.property ??
                record.attribute ??
                ""
            ),
            source: normalizeText(
                record.source ??
                record.source_name ??
                record.sourceName ??
                ""
            ),
            sources: normalizeStringArray(
                record.sources ??
                record.source
            ),
            stack: normalizeText(
                record.stack ??
                record.stack_trace ??
                record.stackTrace ??
                ""
            ),
            occurred_at:
                record.occurred_at ??
                record.occurredAt ??
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
                "",
            resolved_at:
                record.resolved_at ??
                record.resolvedAt ??
                ""
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

        const providers = new Map();
        const severities = new Map();
        const stages = new Map();
        const codes = new Map();
        const statuses = new Map();
        const sources = new Map();
        const categories = new Map();
        const types = new Map();
        const retryCounts = [];

        for (const item of values) {
            incrementMap(providers, item.provider);
            incrementMap(severities, item.severity);
            incrementMap(stages, item.stage);
            incrementMap(codes, item.code);
            incrementMap(statuses, item.status);
            incrementMap(categories, item.category);
            incrementMap(types, item.type);

            for (const source of item.sources || []) {
                incrementMap(sources, source);
            }

            retryCounts.push(
                numericValue(item.retry_count, 0)
            );
        }

        const active = values.filter(
            item => item.active
        ).length;

        const resolved = values.filter(
            item => item.resolved
        ).length;

        const retryable = values.filter(
            item => item.retryable
        ).length;

        const fatal = values.filter(
            item => item.fatal
        ).length;

        const totalRetries = retryCounts.reduce(
            (sum, value) => sum + value,
            0
        );

        return {
            total: values.length,
            active,
            resolved,
            unresolved: values.length - resolved,
            retryable,
            nonRetryable: values.length - retryable,
            exhausted: values.filter(
                item => item.exhausted
            ).length,
            fatal,
            validation: values.filter(
                item => item.validation
            ).length,
            retries: totalRetries,
            averageRetries:
                retryCounts.length
                    ? totalRetries / retryCounts.length
                    : 0,
            medianRetries: percentile(
                retryCounts,
                0.5
            ),
            p95Retries: percentile(
                retryCounts,
                0.95
            ),
            activeRate:
                values.length
                    ? active / values.length
                    : 0,
            resolutionRate:
                values.length
                    ? resolved / values.length
                    : 0,
            fatalRate:
                values.length
                    ? fatal / values.length
                    : 0,
            providers: sortedObject(providers),
            severities: sortedObject(severities),
            stages: sortedObject(stages),
            codes: sortedObject(codes),
            statuses: sortedObject(statuses),
            sources: sortedObject(sources),
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
                payload.errors ??
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

    class ProviderErrorsService extends EventTarget {
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
                    "Provider-errors service has been destroyed.",
                    "PROVIDER_ERRORS_DESTROYED"
                );
            }

            if (
                !this.context.api ||
                typeof this.context.api.get !== "function"
            ) {
                throw createError(
                    "Speciedex API client is unavailable.",
                    "PROVIDER_ERRORS_API_UNAVAILABLE"
                );
            }
        }

        emit(name, detail) {
            dispatch(this, name, detail);

            try {
                this.context.events?.emit?.(
                    `provider-errors:${name}`,
                    detail
                );
            } catch (_error) {
                /* Observer failures are isolated. */
            }

            dispatch(
                this.context.root,
                `speciedex:terminal-provider-errors-${name}`,
                detail,
                {
                    bubbles: true
                }
            );
        }

        createRequest(operation, detail = {}) {
            const id =
                `provider-errors:${Date.now()}:${++this.sequence}`;

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
                    "providers/errors",
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
                    "A provider-error ID is required."
                );
            }

            throwIfAborted(options.signal);

            const request = this.createRequest(
                "get",
                {
                    error: normalizedId
                }
            );

            this.emit("request", {
                requestId: request.id,
                operation: "get",
                error: normalizedId
            });

            try {
                const payload = await this.context.api.get(
                    `providers/errors/${encodeURIComponent(normalizedId)}`,
                    {},
                    options
                );

                const item = normalizeRecord(payload, 0);

                this.finishRequest(request, item);

                this.emit("complete", {
                    requestId: request.id,
                    operation: "get",
                    error: item
                });

                return item;
            } catch (error) {
                const match = this.findCachedError(
                    normalizedId
                );

                if (match) {
                    this.finishRequest(request, match);

                    this.emit("fallback", {
                        requestId: request.id,
                        operation: "get",
                        error: match,
                        cause: error
                    });

                    return match;
                }

                this.finishRequest(request, null, error);

                this.emit("error", {
                    requestId: request.id,
                    operation: "get",
                    errorId: normalizedId,
                    error
                });

                throw error;
            }
        }

        findCachedError(id) {
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

        async active(parameters = {}, options = {}) {
            return this.filteredView(
                {
                    ...parameters,
                    active: true,
                    resolved: false
                },
                item => item.active && !item.resolved,
                options
            );
        }

        async resolved(parameters = {}, options = {}) {
            return this.filteredView(
                {
                    ...parameters,
                    resolved: true
                },
                item => item.resolved,
                options
            );
        }

        async retryable(parameters = {}, options = {}) {
            return this.filteredView(
                {
                    ...parameters,
                    retryable: true
                },
                item => item.retryable,
                options
            );
        }

        async exhausted(parameters = {}, options = {}) {
            return this.filteredView(
                parameters,
                item => item.exhausted,
                options
            );
        }

        async fatal(parameters = {}, options = {}) {
            return this.filteredView(
                {
                    ...parameters,
                    fatal: true
                },
                item => item.fatal,
                options
            );
        }

        async validation(parameters = {}, options = {}) {
            return this.filteredView(
                {
                    ...parameters,
                    validation: true
                },
                item => item.validation,
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

            const from = new Date(
                Date.now() - milliseconds
            ).toISOString();

            return this.filteredView(
                {
                    ...parameters,
                    from
                },
                item => {
                    const timestamp = Date.parse(
                        item.occurred_at
                    );

                    return (
                        Number.isFinite(timestamp) &&
                        timestamp >= Date.now() - milliseconds
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
                    "A provider-error stage is required."
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
                errors: result.records,
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
                        "record_id",
                        "stage",
                        "code",
                        "message"
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
                "PROVIDER_ERRORS_WORKER_UNAVAILABLE"
            );
        }

        status() {
            return {
                version: VERSION,
                endpoint: "providers/errors",
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
                    "providerErrors"
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
                    errors: 0,
                    fatalErrors: 0,
                    activeErrors: 0,
                    validationErrors: 0,
                    retries: 0,
                    status: "unknown"
                });
            }

            const provider = providers.get(key);

            provider.errors += 1;
            provider.retries += numericValue(
                item.retry_count,
                0
            );

            if (item.fatal) {
                provider.fatalErrors += 1;
            }

            if (item.active) {
                provider.activeErrors += 1;
            }

            if (item.validation) {
                provider.validationErrors += 1;
            }

            if (item.fatal) {
                provider.status = "failed";
            } else if (
                provider.status !== "failed" &&
                item.active
            ) {
                provider.status = "degraded";
            }
        }

        return [...providers.values()];
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
            existing instanceof ProviderErrorsService &&
            !existing.destroyed
        ) {
            context.providerErrors = existing;
            return existing;
        }

        if (
            context.providerErrors instanceof ProviderErrorsService &&
            !context.providerErrors.destroyed
        ) {
            return context.providerErrors;
        }

        const service = new ProviderErrorsService(
            context,
            options
        );

        context.providerErrors = service;

        context.registerService?.(
            SERVICE_NAME,
            service
        );

        context.registerService?.(
            "providerErrors",
            service
        );

        dispatch(
            document,
            "speciedex:terminal-provider-errors-ready",
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
            context?.providerErrors ??
            context?.services?.get?.(SERVICE_NAME);

        if (!(service instanceof ProviderErrorsService)) {
            return false;
        }

        const destroyed = service.destroy();

        if (context?.providerErrors === service) {
            context.providerErrors = null;
        }

        return destroyed;
    }

    function requireService(context) {
        const service =
            context?.providerErrors ??
            context?.services?.get?.(SERVICE_NAME);

        if (!(service instanceof ProviderErrorsService)) {
            throw createError(
                "Provider-errors service is unavailable.",
                "PROVIDER_ERRORS_SERVICE_UNAVAILABLE"
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
                "--active": ["active", true],
                "--inactive": ["active", false],
                "--resolved": ["resolved", true],
                "--unresolved": ["resolved", false],
                "--retryable": ["retryable", true],
                "--not-retryable": ["retryable", false],
                "--fatal": ["fatal", true],
                "--non-fatal": ["fatal", false],
                "--validation": ["validation", true],
                "--not-validation": ["validation", false]
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
                    minretries: "min_retries",
                    maxretries: "max_retries"
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
            name: "provider-errors",
            aliases: [
                "providers-errors"
            ],
            category: "providers",
            description:
                "Inspect provider ingestion and validation errors.",
            usage:
                "provider-errors [query] [limit] [--provider=ID] [--severity=LEVEL] [--stage=STAGE] [--code=CODE] [--status=STATUS] [--source=SOURCE] [--field=FIELD] [--record=ID] [--job=ID] [--run=ID] [--error=ID] [--category=CATEGORY] [--type=TYPE] [--active|--inactive] [--resolved|--unresolved] [--retryable|--not-retryable] [--fatal|--non-fatal] [--validation|--not-validation] [--min-retries=N] [--max-retries=N] [--from=DATE] [--to=DATE] [--sort=FIELD] [--direction=asc|desc] [--offset=N]",
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
            name: "provider-error",
            aliases: [
                "provider-error-get"
            ],
            category: "providers",
            description:
                "Retrieve one provider error by ID.",
            usage:
                "provider-error <id>",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error(
                        "A provider-error ID is required."
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
            name: "provider-errors-active",
            aliases: [
                "active-provider-errors"
            ],
            category: "providers",
            description:
                "List active unresolved provider errors.",
            usage:
                "provider-errors-active [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).active(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "provider-errors-resolved",
            aliases: [
                "resolved-provider-errors"
            ],
            category: "providers",
            description:
                "List resolved provider errors.",
            usage:
                "provider-errors-resolved [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).resolved(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "provider-errors-retryable",
            aliases: [
                "retryable-provider-errors"
            ],
            category: "providers",
            description:
                "List provider errors eligible for retry.",
            usage:
                "provider-errors-retryable [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).retryable(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "provider-errors-exhausted",
            aliases: [
                "exhausted-provider-errors"
            ],
            category: "providers",
            description:
                "List provider errors that exhausted their retry allowance.",
            usage:
                "provider-errors-exhausted [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).exhausted(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "provider-errors-fatal",
            aliases: [
                "fatal-provider-errors"
            ],
            category: "providers",
            description:
                "List fatal provider errors.",
            usage:
                "provider-errors-fatal [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).fatal(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "provider-validation-errors",
            aliases: [
                "provider-errors-validation"
            ],
            category: "providers",
            description:
                "List provider validation errors.",
            usage:
                "provider-validation-errors [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).validation(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "provider-errors-recent",
            aliases: [
                "recent-provider-errors"
            ],
            category: "providers",
            description:
                "List provider errors from the recent time window.",
            usage:
                "provider-errors-recent [milliseconds] [filters]",
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
            name: "provider-errors-summary",
            aliases: [
                "provider-error-summary"
            ],
            category: "providers",
            description:
                "Summarize provider errors by provider, severity, stage, code, source, status, category, and retry state.",
            usage:
                "provider-errors-summary [filters]",
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
            name: "provider-errors-duplicates",
            aliases: [
                "provider-error-duplicates"
            ],
            category: "providers",
            description:
                "Analyze duplicate provider errors using the provider worker.",
            usage:
                "provider-errors-duplicates [filters]",
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
            name: "provider-errors-health",
            aliases: [
                "provider-error-health"
            ],
            category: "providers",
            description:
                "Analyze provider health from error records.",
            usage:
                "provider-errors-health [filters]",
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
            name: "provider-errors-cache-clear",
            aliases: [
                "provider-error-cache-clear"
            ],
            category: "providers",
            description:
                "Clear the provider-error response cache.",
            usage:
                "provider-errors-cache-clear",
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
            name: "provider-errors-status",
            category: "providers",
            description:
                "Show provider-errors service status.",
            usage:
                "provider-errors-status",
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
        ProviderErrorsService,
        normalizeParameters,
        normalizeRecord,
        normalizeResponse,
        normalizeSeverity,
        normalizeStringArray,
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

    window.SpeciedexTerminalProviderErrors = api;

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
