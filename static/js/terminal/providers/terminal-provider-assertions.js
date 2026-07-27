/*
========================================================================
Speciedex.org
Terminal ProviderAssertions Module
========================================================================

Provider assertion inspection service for SpeciedexTerminal.

Designed for browser integration through:

    _partials/splash.html
        -> _partials/terminal.html
        -> terminal loader
        -> static/js/terminal/providers/terminal-provider-assertions.js

Features:

    • Validated assertion API requests
    • Provider, field, value, status, confidence, source, rank, and date filters
    • Normalized assertion records and response envelopes
    • Provider, field, source, status, rank, license, and confidence summaries
    • TTL cache, inflight-request deduplication, and explicit refresh
    • AbortSignal support and request lifecycle tracking
    • Single-assertion retrieval with cache fallback
    • Conflict, low-confidence, unresolved, inactive, and unverified views
    • Optional provider-worker duplicate and overlap analysis
    • Idempotent service registration and safe teardown
    • Terminal command integration

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "ProviderAssertions";
    const VERSION = "3.0.0";
    const SERVICE_NAME = "provider-assertions";
    const WORKER_NAME = "provider";

    const DEFAULT_LIMIT = 50;
    const MIN_LIMIT = 1;
    const MAX_LIMIT = 1000;
    const DEFAULT_CACHE_TTL = 60000;
    const MAX_CACHE_ENTRIES = 128;

    const SORT_FIELDS = Object.freeze([
        "updated_at",
        "created_at",
        "provider",
        "provider_id",
        "field",
        "status",
        "confidence",
        "rank",
        "record",
        "record_id",
        "taxon",
        "taxon_id",
        "source",
        "license",
        "id"
    ]);

    const FILTER_FIELDS = Object.freeze([
        "provider",
        "provider_id",
        "field",
        "value",
        "status",
        "source",
        "rank",
        "record",
        "record_id",
        "taxon",
        "taxon_id",
        "assertion",
        "assertion_id",
        "license"
    ]);

    const BOOLEAN_FIELDS = Object.freeze([
        "accepted",
        "conflicting",
        "verified",
        "active"
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

    function abortError(message = "Provider-assertion request aborted.") {
        return createError(
            message,
            "PROVIDER_ASSERTIONS_ABORTED",
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

    function numericValue(value, fallback = 0) {
        const number = Number(value);

        return Number.isFinite(number)
            ? number
            : fallback;
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
            value || "updated_at"
        ).replace(/-/g, "_");

        if (!SORT_FIELDS.includes(normalized)) {
            throw new TypeError(
                `Unsupported assertion sort field: ${value}`
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

    function normalizeConfidence(value) {
        const number = Number(value);

        if (!Number.isFinite(number)) {
            return null;
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

        const minimumConfidence =
            source.minConfidence ??
            source.min_confidence;

        const maximumConfidence =
            source.maxConfidence ??
            source.max_confidence;

        if (
            minimumConfidence !== undefined &&
            minimumConfidence !== null &&
            minimumConfidence !== ""
        ) {
            const parsed = normalizeConfidence(minimumConfidence);

            if (parsed === null) {
                throw new TypeError(
                    `Invalid minimum confidence value: ${minimumConfidence}`
                );
            }

            normalized.min_confidence = parsed;
        }

        if (
            maximumConfidence !== undefined &&
            maximumConfidence !== null &&
            maximumConfidence !== ""
        ) {
            const parsed = normalizeConfidence(maximumConfidence);

            if (parsed === null) {
                throw new TypeError(
                    `Invalid maximum confidence value: ${maximumConfidence}`
                );
            }

            normalized.max_confidence = parsed;
        }

        if (
            normalized.min_confidence !== undefined &&
            normalized.max_confidence !== undefined &&
            normalized.min_confidence >
            normalized.max_confidence
        ) {
            throw new RangeError(
                "Minimum confidence must not exceed maximum confidence."
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
                "Assertion start date must not be later than the end date."
            );
        }

        return normalized;
    }

    function normalizeEvidence(value) {
        if (Array.isArray(value)) {
            return value.filter(item =>
                item !== undefined &&
                item !== null
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

    function normalizeRecord(record, index = 0) {
        if (
            !record ||
            typeof record !== "object"
        ) {
            return {
                index,
                id: normalizeText(record),
                provider: "",
                provider_id: "",
                record_id: "",
                taxon_id: "",
                field: "",
                value: record,
                normalized_value: record,
                status: "unknown",
                confidence: null,
                confidencePercent: null,
                accepted: false,
                conflicting: false,
                verified: false,
                active: true,
                rank: "",
                source: "",
                sources: [],
                evidence: [],
                license: "",
                created_at: "",
                updated_at: ""
            };
        }

        const confidence = normalizeConfidence(
            record.confidence ??
            record.score ??
            record.confidence_score ??
            record.confidenceScore
        );

        const status = normalizeKey(
            record.status ??
            record.state ??
            (
                record.accepted === true
                    ? "accepted"
                    : "unknown"
            )
        );

        const accepted = normalizeBoolean(
            record.accepted,
            [
                "accepted",
                "resolved",
                "confirmed",
                "canonical"
            ].includes(status)
        );

        const conflicting = normalizeBoolean(
            record.conflicting ??
            record.conflict,
            [
                "conflict",
                "conflicting",
                "disputed"
            ].includes(status)
        );

        const verified = normalizeBoolean(
            record.verified,
            [
                "verified",
                "confirmed",
                "accepted",
                "canonical"
            ].includes(status)
        );

        const active =
            normalizeBoolean(record.active, true) &&
            !normalizeBoolean(record.deleted, false) &&
            !["inactive", "deleted", "retired"].includes(status);

        return {
            ...record,
            index:
                record.index ??
                index,
            id: normalizeText(
                record.id ??
                record.assertion_id ??
                record.assertionId ??
                record.uuid ??
                `assertion-${index + 1}`
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
            record_id: normalizeText(
                record.record_id ??
                record.recordId ??
                record.entity_id ??
                record.entityId ??
                record.taxon_id ??
                record.taxonId ??
                ""
            ),
            taxon_id: normalizeText(
                record.taxon_id ??
                record.taxonId ??
                record.record_id ??
                record.recordId ??
                ""
            ),
            field: normalizeText(
                record.field ??
                record.property ??
                record.attribute ??
                record.key ??
                ""
            ),
            value:
                record.value ??
                record.asserted_value ??
                record.assertedValue ??
                record.data ??
                null,
            normalized_value:
                record.normalized_value ??
                record.normalizedValue ??
                record.value ??
                null,
            status,
            confidence,
            confidencePercent:
                confidence === null
                    ? null
                    : confidence * 100,
            accepted,
            conflicting,
            verified,
            active,
            rank: normalizeText(
                record.rank ??
                record.taxon_rank ??
                record.taxonRank ??
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
                record.evidence_sources ??
                record.evidenceSources ??
                record.source
            ),
            evidence: normalizeEvidence(
                record.evidence ??
                record.evidences
            ),
            license: normalizeText(
                record.license ??
                record.licence ??
                ""
            ),
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
            return null;
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
        const fields = new Map();
        const statuses = new Map();
        const sources = new Map();
        const ranks = new Map();
        const licenses = new Map();
        const confidences = [];

        for (const assertion of values) {
            incrementMap(providers, assertion.provider);
            incrementMap(fields, assertion.field);
            incrementMap(statuses, assertion.status);
            incrementMap(ranks, assertion.rank);
            incrementMap(licenses, assertion.license);

            for (const source of assertion.sources || []) {
                incrementMap(sources, source);
            }

            if (Number.isFinite(assertion.confidence)) {
                confidences.push(assertion.confidence);
            }
        }

        const accepted = values.filter(
            assertion => assertion.accepted
        ).length;

        const conflicting = values.filter(
            assertion => assertion.conflicting
        ).length;

        const verified = values.filter(
            assertion => assertion.verified
        ).length;

        const active = values.filter(
            assertion => assertion.active
        ).length;

        return {
            total: values.length,
            accepted,
            rejected: values.filter(assertion =>
                [
                    "rejected",
                    "invalid",
                    "discarded"
                ].includes(assertion.status)
            ).length,
            conflicting,
            unresolved: values.filter(assertion =>
                !assertion.accepted &&
                !assertion.conflicting &&
                assertion.active
            ).length,
            verified,
            unverified: values.length - verified,
            active,
            inactive: values.length - active,
            acceptanceRate:
                values.length
                    ? accepted / values.length
                    : 0,
            conflictRate:
                values.length
                    ? conflicting / values.length
                    : 0,
            verificationRate:
                values.length
                    ? verified / values.length
                    : 0,
            averageConfidence:
                confidences.length
                    ? confidences.reduce(
                        (sum, value) => sum + value,
                        0
                    ) / confidences.length
                    : null,
            medianConfidence: percentile(
                confidences,
                0.5
            ),
            p95Confidence: percentile(
                confidences,
                0.95
            ),
            minimumConfidence:
                confidences.length
                    ? Math.min(...confidences)
                    : null,
            maximumConfidence:
                confidences.length
                    ? Math.max(...confidences)
                    : null,
            providers: sortedObject(providers),
            fields: sortedObject(fields),
            statuses: sortedObject(statuses),
            sources: sortedObject(sources),
            ranks: sortedObject(ranks),
            licenses: sortedObject(licenses)
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
                payload.assertions ??
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

    class ProviderAssertionsService extends EventTarget {
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
                    "Provider-assertions service has been destroyed.",
                    "PROVIDER_ASSERTIONS_DESTROYED"
                );
            }

            if (
                !this.context.api ||
                typeof this.context.api.get !== "function"
            ) {
                throw createError(
                    "Speciedex API client is unavailable.",
                    "PROVIDER_ASSERTIONS_API_UNAVAILABLE"
                );
            }
        }

        emit(name, detail) {
            dispatch(this, name, detail);

            try {
                this.context.events?.emit?.(
                    `provider-assertions:${name}`,
                    detail
                );
            } catch (_error) {
                /* Observer failures are isolated. */
            }

            dispatch(
                this.context.root,
                `speciedex:terminal-provider-assertions-${name}`,
                detail,
                {
                    bubbles: true
                }
            );
        }

        createRequest(operation, detail = {}) {
            const id =
                `provider-assertions:${Date.now()}:${++this.sequence}`;

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
                    "providers/assertions",
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
                    "An assertion ID is required."
                );
            }

            throwIfAborted(options.signal);

            const request = this.createRequest(
                "get",
                {
                    assertion: normalizedId
                }
            );

            this.emit("request", {
                requestId: request.id,
                operation: "get",
                assertion: normalizedId
            });

            try {
                const payload = await this.context.api.get(
                    `providers/assertions/${encodeURIComponent(normalizedId)}`,
                    {},
                    options
                );

                const assertion = normalizeRecord(payload, 0);

                this.finishRequest(request, assertion);

                this.emit("complete", {
                    requestId: request.id,
                    operation: "get",
                    assertion
                });

                return assertion;
            } catch (error) {
                const match = this.findCachedAssertion(
                    normalizedId
                );

                if (match) {
                    this.finishRequest(request, match);

                    this.emit("fallback", {
                        requestId: request.id,
                        operation: "get",
                        assertion: match,
                        error
                    });

                    return match;
                }

                this.finishRequest(request, null, error);

                this.emit("error", {
                    requestId: request.id,
                    operation: "get",
                    assertion: normalizedId,
                    error
                });

                throw error;
            }
        }

        findCachedAssertion(id) {
            const normalizedId = normalizeKey(id);

            for (const entry of this.cache.values()) {
                const match = entry.value?.records?.find(
                    assertion =>
                        normalizeKey(assertion.id) === normalizedId
                );

                if (match) {
                    return clone(match);
                }
            }

            return null;
        }

        async conflicts(parameters = {}, options = {}) {
            return this.filteredView(
                {
                    ...parameters,
                    conflicting: true
                },
                assertion => assertion.conflicting,
                options
            );
        }

        async unresolved(parameters = {}, options = {}) {
            return this.filteredView(
                parameters,
                assertion =>
                    !assertion.accepted &&
                    !assertion.conflicting &&
                    assertion.active,
                options
            );
        }

        async unverified(parameters = {}, options = {}) {
            return this.filteredView(
                {
                    ...parameters,
                    verified: false
                },
                assertion => !assertion.verified,
                options
            );
        }

        async inactive(parameters = {}, options = {}) {
            return this.filteredView(
                {
                    ...parameters,
                    active: false
                },
                assertion => !assertion.active,
                options
            );
        }

        async lowConfidence(
            threshold = 0.5,
            parameters = {},
            options = {}
        ) {
            const normalizedThreshold =
                normalizeConfidence(threshold) ??
                0.5;

            const result = await this.list(
                {
                    ...parameters,
                    max_confidence: normalizedThreshold
                },
                options
            );

            const records = result.records.filter(
                assertion =>
                    assertion.confidence === null ||
                    assertion.confidence <=
                    normalizedThreshold
            );

            return {
                ...result,
                threshold: normalizedThreshold,
                records,
                returned: records.length,
                summary: summarize(records)
            };
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

        async byField(
            field,
            parameters = {},
            options = {}
        ) {
            const normalizedField = normalizeText(field);

            if (!normalizedField) {
                throw new TypeError(
                    "An assertion field is required."
                );
            }

            return this.list(
                {
                    ...parameters,
                    field: normalizedField
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
                assertions: result.records,
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
                        "record_id",
                        "field",
                        "normalized_value"
                    ]
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
                "PROVIDER_ASSERTIONS_WORKER_UNAVAILABLE"
            );
        }

        status() {
            return {
                version: VERSION,
                endpoint: "providers/assertions",
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
                    "providerAssertions"
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
            existing instanceof ProviderAssertionsService &&
            !existing.destroyed
        ) {
            context.providerAssertions = existing;
            return existing;
        }

        if (
            context.providerAssertions instanceof ProviderAssertionsService &&
            !context.providerAssertions.destroyed
        ) {
            return context.providerAssertions;
        }

        const service = new ProviderAssertionsService(
            context,
            options
        );

        context.providerAssertions = service;

        context.registerService?.(
            SERVICE_NAME,
            service
        );

        context.registerService?.(
            "providerAssertions",
            service
        );

        dispatch(
            document,
            "speciedex:terminal-provider-assertions-ready",
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
            context?.providerAssertions ??
            context?.services?.get?.(SERVICE_NAME);

        if (!(service instanceof ProviderAssertionsService)) {
            return false;
        }

        const destroyed = service.destroy();

        if (context?.providerAssertions === service) {
            context.providerAssertions = null;
        }

        return destroyed;
    }

    function requireService(context) {
        const service =
            context?.providerAssertions ??
            context?.services?.get?.(SERVICE_NAME);

        if (!(service instanceof ProviderAssertionsService)) {
            throw createError(
                "Provider-assertions service is unavailable.",
                "PROVIDER_ASSERTIONS_SERVICE_UNAVAILABLE"
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
                "--accepted": ["accepted", true],
                "--unaccepted": ["accepted", false],
                "--conflicting": ["conflicting", true],
                "--non-conflicting": ["conflicting", false],
                "--verified": ["verified", true],
                "--unverified": ["verified", false],
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

                const normalizedName = name
                    .replace(/-/g, "_");

                const aliases = {
                    query: "q",
                    order: "direction",
                    since: "from",
                    start: "from",
                    until: "to",
                    end: "to",
                    minconfidence: "min_confidence",
                    maxconfidence: "max_confidence"
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
            name: "provider-assertions",
            aliases: [
                "assertions-by-provider"
            ],
            category: "providers",
            description:
                "Inspect provider assertions.",
            usage:
                "provider-assertions [query] [limit] [--provider=ID] [--field=NAME] [--value=VALUE] [--status=STATUS] [--source=SOURCE] [--rank=RANK] [--record=ID] [--taxon=ID] [--assertion=ID] [--license=LICENSE] [--accepted|--unaccepted] [--conflicting|--non-conflicting] [--verified|--unverified] [--active|--inactive] [--min-confidence=N] [--max-confidence=N] [--from=DATE] [--to=DATE] [--sort=FIELD] [--direction=asc|desc] [--offset=N]",
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
            name: "provider-assertion",
            aliases: [
                "assertion-get"
            ],
            category: "providers",
            description:
                "Retrieve one provider assertion by ID.",
            usage:
                "provider-assertion <id>",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error(
                        "An assertion ID is required."
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
            name: "provider-assertion-conflicts",
            aliases: [
                "assertion-conflicts"
            ],
            category: "providers",
            description:
                "List conflicting provider assertions.",
            usage:
                "provider-assertion-conflicts [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).conflicts(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "provider-assertion-low-confidence",
            aliases: [
                "low-confidence-assertions"
            ],
            category: "providers",
            description:
                "List assertions at or below a confidence threshold.",
            usage:
                "provider-assertion-low-confidence [threshold] [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) => {
                let threshold = 0.5;
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
                    await requireService(context).lowConfidence(
                        threshold,
                        parseCommandArguments(filters),
                        { signal }
                    )
                );
            }
        },
        {
            name: "provider-assertion-unresolved",
            aliases: [
                "unresolved-assertions"
            ],
            category: "providers",
            description:
                "List active assertions that are neither accepted nor conflicting.",
            usage:
                "provider-assertion-unresolved [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).unresolved(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "provider-assertion-unverified",
            aliases: [
                "unverified-assertions"
            ],
            category: "providers",
            description:
                "List unverified provider assertions.",
            usage:
                "provider-assertion-unverified [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).unverified(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "provider-assertions-summary",
            aliases: [
                "assertion-summary"
            ],
            category: "providers",
            description:
                "Summarize provider assertions, fields, sources, statuses, ranks, licenses, and confidence.",
            usage:
                "provider-assertions-summary [filters]",
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
            name: "provider-assertions-duplicates",
            aliases: [
                "assertion-duplicates"
            ],
            category: "providers",
            description:
                "Analyze duplicate assertion records with the provider worker.",
            usage:
                "provider-assertions-duplicates [filters]",
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
            name: "provider-assertions-cache-clear",
            aliases: [
                "assertion-cache-clear"
            ],
            category: "providers",
            description:
                "Clear the provider-assertion response cache.",
            usage:
                "provider-assertions-cache-clear",
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
            name: "provider-assertions-status",
            category: "providers",
            description:
                "Show provider-assertions service status.",
            usage:
                "provider-assertions-status",
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
        ProviderAssertionsService,
        normalizeParameters,
        normalizeRecord,
        normalizeResponse,
        normalizeConfidence,
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

    window.SpeciedexTerminalProviderAssertions = api;

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
