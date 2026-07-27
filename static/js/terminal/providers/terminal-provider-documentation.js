/*
========================================================================
Speciedex.org
Terminal ProviderDocumentation Module
========================================================================

Provider documentation metadata service for SpeciedexTerminal.

Designed for browser integration through:

    _partials/splash.html
        -> _partials/terminal.html
        -> terminal loader
        -> static/js/terminal/providers/terminal-provider-documentation.js

Features:

    • Validated documentation API requests
    • Provider, type, format, language, version, license, and date filters
    • Normalized documentation metadata records and response envelopes
    • Provider, type, format, language, version, license, status, and topic summaries
    • TTL cache, inflight-request deduplication, and explicit refresh
    • AbortSignal support and request lifecycle tracking
    • Single-document retrieval with cache fallback
    • Current, deprecated, archived, unofficial, unsearchable, and missing views
    • Optional documentation integrity and duplicate analysis
    • Idempotent service registration and safe teardown
    • Terminal command integration

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "ProviderDocumentation";
    const VERSION = "3.0.0";
    const SERVICE_NAME = "provider-documentation";
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
        "title",
        "type",
        "format",
        "language",
        "version",
        "license",
        "status",
        "category",
        "size",
        "id"
    ]);

    const FILTER_FIELDS = Object.freeze([
        "provider",
        "provider_id",
        "document",
        "document_id",
        "title",
        "type",
        "format",
        "language",
        "version",
        "license",
        "status",
        "category",
        "section",
        "topic"
    ]);

    const BOOLEAN_FIELDS = Object.freeze([
        "current",
        "deprecated",
        "available",
        "official",
        "archived",
        "searchable"
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

    function abortError(message = "Provider-documentation request aborted.") {
        return createError(
            message,
            "PROVIDER_DOCUMENTATION_ABORTED",
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
            value || "updated_at"
        ).replace(/-/g, "_");

        if (!SORT_FIELDS.includes(normalized)) {
            throw new TypeError(
                `Unsupported documentation sort field: ${value}`
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

        const minimumSize =
            source.minSize ??
            source.min_size;

        const maximumSize =
            source.maxSize ??
            source.max_size;

        if (
            minimumSize !== undefined &&
            minimumSize !== null &&
            minimumSize !== ""
        ) {
            const parsed = Number(minimumSize);

            if (!Number.isFinite(parsed) || parsed < 0) {
                throw new TypeError(
                    `Invalid minimum size value: ${minimumSize}`
                );
            }

            normalized.min_size = parsed;
        }

        if (
            maximumSize !== undefined &&
            maximumSize !== null &&
            maximumSize !== ""
        ) {
            const parsed = Number(maximumSize);

            if (!Number.isFinite(parsed) || parsed < 0) {
                throw new TypeError(
                    `Invalid maximum size value: ${maximumSize}`
                );
            }

            normalized.max_size = parsed;
        }

        if (
            normalized.min_size !== undefined &&
            normalized.max_size !== undefined &&
            normalized.min_size > normalized.max_size
        ) {
            throw new RangeError(
                "Minimum documentation size must not exceed maximum size."
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
                "Documentation start date must not be later than the end date."
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
                title: value,
                description: "",
                type: "documentation",
                format: "",
                language: "",
                version: "",
                license: "",
                status: "unknown",
                current: false,
                deprecated: false,
                available: false,
                official: false,
                archived: false,
                searchable: false,
                url: "",
                path: "",
                category: "",
                topics: [],
                sections: [],
                checksum: "",
                checksumAlgorithm: "",
                size: null,
                created_at: "",
                updated_at: ""
            };
        }

        const status = normalizeKey(
            record.status ??
            record.state ??
            (
                record.deprecated === true
                    ? "deprecated"
                    : "current"
            )
        );

        const deprecated =
            normalizeBoolean(record.deprecated, false) ||
            [
                "deprecated",
                "obsolete",
                "retired"
            ].includes(status);

        const archived =
            normalizeBoolean(record.archived, false) ||
            status === "archived";

        const available =
            normalizeBoolean(record.available, true) &&
            !normalizeBoolean(record.missing, false) &&
            ![
                "missing",
                "unavailable",
                "deleted"
            ].includes(status);

        const current =
            record.current !== undefined
                ? normalizeBoolean(record.current, false)
                : (
                    available &&
                    !deprecated &&
                    !archived
                );

        const official = normalizeBoolean(
            record.official ??
            record.is_official ??
            record.isOfficial,
            false
        );

        const searchable =
            normalizeBoolean(record.searchable, true) &&
            normalizeBoolean(record.indexed, true) &&
            available;

        const checksum = normalizeText(
            record.checksum ??
            record.sha256 ??
            record.digest ??
            ""
        );

        return {
            ...record,
            index:
                record.index ??
                index,
            id: normalizeText(
                record.id ??
                record.document_id ??
                record.documentId ??
                record.slug ??
                record.path ??
                `documentation-${index + 1}`
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
            title: normalizeText(
                record.title ??
                record.name ??
                record.label ??
                record.id ??
                `Documentation ${index + 1}`
            ),
            description: normalizeText(
                record.description ??
                record.summary ??
                record.abstract ??
                ""
            ),
            type: normalizeKey(
                record.type ??
                record.document_type ??
                record.documentType ??
                "documentation"
            ),
            format: normalizeKey(
                record.format ??
                record.mime_type ??
                record.mimeType ??
                record.extension ??
                ""
            ),
            language: normalizeKey(
                record.language ??
                record.locale ??
                record.lang ??
                ""
            ),
            version: normalizeText(
                record.version ??
                record.api_version ??
                record.apiVersion ??
                ""
            ),
            license: normalizeText(
                record.license ??
                record.licence ??
                ""
            ),
            status,
            current,
            deprecated,
            available,
            official,
            archived,
            searchable,
            url: normalizeText(
                record.url ??
                record.href ??
                record.location ??
                ""
            ),
            path: normalizeText(
                record.path ??
                record.file ??
                record.filename ??
                ""
            ),
            category: normalizeText(
                record.category ??
                ""
            ),
            topics: normalizeStringArray(
                record.topics ??
                record.tags ??
                record.keywords
            ),
            sections: normalizeStringArray(
                record.sections ??
                record.headings ??
                record.chapters
            ),
            checksum,
            checksumAlgorithm: normalizeText(
                record.checksum_algorithm ??
                record.checksumAlgorithm ??
                (
                    checksum.length === 64
                        ? "sha256"
                        : ""
                )
            ).toLowerCase(),
            size:
                Number.isFinite(Number(record.size))
                    ? Math.max(0, Number(record.size))
                    : null,
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

    function summarize(records) {
        const values = Array.isArray(records)
            ? records
            : [];

        const providers = new Map();
        const types = new Map();
        const formats = new Map();
        const languages = new Map();
        const versions = new Map();
        const licenses = new Map();
        const statuses = new Map();
        const topics = new Map();
        const categories = new Map();

        const sizes = [];

        for (const item of values) {
            incrementMap(providers, item.provider);
            incrementMap(types, item.type);
            incrementMap(formats, item.format);
            incrementMap(languages, item.language);
            incrementMap(versions, item.version);
            incrementMap(licenses, item.license);
            incrementMap(statuses, item.status);
            incrementMap(categories, item.category);

            for (const topic of item.topics || []) {
                incrementMap(topics, topic);
            }

            if (Number.isFinite(item.size)) {
                sizes.push(item.size);
            }
        }

        const totalSize = sizes.reduce(
            (sum, value) => sum + value,
            0
        );

        return {
            total: values.length,
            current: values.filter(item => item.current).length,
            deprecated: values.filter(item => item.deprecated).length,
            available: values.filter(item => item.available).length,
            unavailable: values.filter(item => !item.available).length,
            official: values.filter(item => item.official).length,
            unofficial: values.filter(item => !item.official).length,
            archived: values.filter(item => item.archived).length,
            searchable: values.filter(item => item.searchable).length,
            unsearchable: values.filter(item => !item.searchable).length,
            checksummed: values.filter(item => Boolean(item.checksum)).length,
            totalSize,
            averageSize:
                sizes.length
                    ? totalSize / sizes.length
                    : 0,
            minimumSize:
                sizes.length
                    ? Math.min(...sizes)
                    : 0,
            maximumSize:
                sizes.length
                    ? Math.max(...sizes)
                    : 0,
            providers: sortedObject(providers),
            types: sortedObject(types),
            formats: sortedObject(formats),
            languages: sortedObject(languages),
            versions: sortedObject(versions),
            licenses: sortedObject(licenses),
            statuses: sortedObject(statuses),
            topics: sortedObject(topics),
            categories: sortedObject(categories)
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
                payload.documentation ??
                payload.documents ??
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

    class ProviderDocumentationService extends EventTarget {
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
                    "Provider-documentation service has been destroyed.",
                    "PROVIDER_DOCUMENTATION_DESTROYED"
                );
            }

            if (
                !this.context.api ||
                typeof this.context.api.get !== "function"
            ) {
                throw createError(
                    "Speciedex API client is unavailable.",
                    "PROVIDER_DOCUMENTATION_API_UNAVAILABLE"
                );
            }
        }

        emit(name, detail) {
            dispatch(this, name, detail);

            try {
                this.context.events?.emit?.(
                    `provider-documentation:${name}`,
                    detail
                );
            } catch (_error) {
                /* Observer failures are isolated. */
            }

            dispatch(
                this.context.root,
                `speciedex:terminal-provider-documentation-${name}`,
                detail,
                {
                    bubbles: true
                }
            );
        }

        createRequest(operation, detail = {}) {
            const id =
                `provider-documentation:${Date.now()}:${++this.sequence}`;

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
                    "providers/documentation",
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
                    "A documentation ID or title is required."
                );
            }

            throwIfAborted(options.signal);

            const request = this.createRequest(
                "get",
                {
                    document: normalizedId
                }
            );

            this.emit("request", {
                requestId: request.id,
                operation: "get",
                document: normalizedId
            });

            try {
                const payload = await this.context.api.get(
                    `providers/documentation/${encodeURIComponent(normalizedId)}`,
                    {},
                    options
                );

                const item = normalizeRecord(payload, 0);

                this.finishRequest(request, item);

                this.emit("complete", {
                    requestId: request.id,
                    operation: "get",
                    document: item
                });

                return item;
            } catch (error) {
                const match = this.findCachedDocument(
                    normalizedId
                );

                if (match) {
                    this.finishRequest(request, match);

                    this.emit("fallback", {
                        requestId: request.id,
                        operation: "get",
                        document: match,
                        error
                    });

                    return match;
                }

                this.finishRequest(request, null, error);

                this.emit("error", {
                    requestId: request.id,
                    operation: "get",
                    document: normalizedId,
                    error
                });

                throw error;
            }
        }

        findCachedDocument(id) {
            const normalizedId = normalizeKey(id);

            for (const entry of this.cache.values()) {
                const match = entry.value?.records?.find(
                    item =>
                        normalizeKey(item.id) === normalizedId ||
                        normalizeKey(item.title) === normalizedId ||
                        normalizeKey(item.path) === normalizedId
                );

                if (match) {
                    return clone(match);
                }
            }

            return null;
        }

        async current(parameters = {}, options = {}) {
            return this.filteredView(
                {
                    ...parameters,
                    current: true,
                    deprecated: false,
                    available: true
                },
                item =>
                    item.current &&
                    !item.deprecated &&
                    item.available,
                options
            );
        }

        async deprecated(parameters = {}, options = {}) {
            return this.filteredView(
                {
                    ...parameters,
                    deprecated: true
                },
                item => item.deprecated,
                options
            );
        }

        async missing(parameters = {}, options = {}) {
            return this.filteredView(
                {
                    ...parameters,
                    available: false
                },
                item => !item.available,
                options
            );
        }

        async archived(parameters = {}, options = {}) {
            return this.filteredView(
                {
                    ...parameters,
                    archived: true
                },
                item => item.archived,
                options
            );
        }

        async unofficial(parameters = {}, options = {}) {
            return this.filteredView(
                {
                    ...parameters,
                    official: false
                },
                item => !item.official,
                options
            );
        }

        async unsearchable(parameters = {}, options = {}) {
            return this.filteredView(
                {
                    ...parameters,
                    searchable: false
                },
                item => !item.searchable,
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

        async byType(
            type,
            parameters = {},
            options = {}
        ) {
            const normalizedType = normalizeText(type);

            if (!normalizedType) {
                throw new TypeError(
                    "A documentation type is required."
                );
            }

            return this.list(
                {
                    ...parameters,
                    type: normalizedType
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
                documentation: result.records,
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
                        "title",
                        "version",
                        "type",
                        "path"
                    ]
                },
                options
            );
        }

        async integrity(parameters = {}, options = {}) {
            const result = await this.list(
                {
                    ...parameters,
                    limit:
                        parameters.limit ??
                        MAX_LIMIT
                },
                options
            );

            const records = result.records;

            return {
                total: records.length,
                missingChecksum: records.filter(
                    item => !item.checksum
                ),
                missingPathAndUrl: records.filter(
                    item => !item.path && !item.url
                ),
                unavailable: records.filter(
                    item => !item.available
                ),
                deprecatedCurrentConflict: records.filter(
                    item => item.deprecated && item.current
                ),
                archivedCurrentConflict: records.filter(
                    item => item.archived && item.current
                ),
                invalidSize: records.filter(
                    item =>
                        item.size !== null &&
                        (
                            !Number.isFinite(item.size) ||
                            item.size < 0
                        )
                )
            };
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
                "PROVIDER_DOCUMENTATION_WORKER_UNAVAILABLE"
            );
        }

        status() {
            return {
                version: VERSION,
                endpoint: "providers/documentation",
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
                    "providerDocumentation"
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
            existing instanceof ProviderDocumentationService &&
            !existing.destroyed
        ) {
            context.providerDocumentation = existing;
            return existing;
        }

        if (
            context.providerDocumentation instanceof ProviderDocumentationService &&
            !context.providerDocumentation.destroyed
        ) {
            return context.providerDocumentation;
        }

        const service = new ProviderDocumentationService(
            context,
            options
        );

        context.providerDocumentation = service;

        context.registerService?.(
            SERVICE_NAME,
            service
        );

        context.registerService?.(
            "providerDocumentation",
            service
        );

        dispatch(
            document,
            "speciedex:terminal-provider-documentation-ready",
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
            context?.providerDocumentation ??
            context?.services?.get?.(SERVICE_NAME);

        if (!(service instanceof ProviderDocumentationService)) {
            return false;
        }

        const destroyed = service.destroy();

        if (context?.providerDocumentation === service) {
            context.providerDocumentation = null;
        }

        return destroyed;
    }

    function requireService(context) {
        const service =
            context?.providerDocumentation ??
            context?.services?.get?.(SERVICE_NAME);

        if (!(service instanceof ProviderDocumentationService)) {
            throw createError(
                "Provider-documentation service is unavailable.",
                "PROVIDER_DOCUMENTATION_SERVICE_UNAVAILABLE"
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
                "--current": ["current", true],
                "--not-current": ["current", false],
                "--deprecated": ["deprecated", true],
                "--not-deprecated": ["deprecated", false],
                "--available": ["available", true],
                "--missing": ["available", false],
                "--official": ["official", true],
                "--unofficial": ["official", false],
                "--archived": ["archived", true],
                "--not-archived": ["archived", false],
                "--searchable": ["searchable", true],
                "--unsearchable": ["searchable", false]
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
                    minsize: "min_size",
                    maxsize: "max_size"
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
            name: "provider-documentation",
            aliases: [
                "provider-docs"
            ],
            category: "providers",
            description:
                "Read provider documentation metadata.",
            usage:
                "provider-documentation [query] [limit] [--provider=ID] [--document=ID] [--title=TEXT] [--type=TYPE] [--format=FORMAT] [--language=LANG] [--version=VERSION] [--license=LICENSE] [--status=STATUS] [--category=CATEGORY] [--section=SECTION] [--topic=TOPIC] [--current|--not-current] [--deprecated|--not-deprecated] [--available|--missing] [--official|--unofficial] [--archived|--not-archived] [--searchable|--unsearchable] [--min-size=N] [--max-size=N] [--from=DATE] [--to=DATE] [--sort=FIELD] [--direction=asc|desc] [--offset=N]",
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
            name: "provider-document",
            aliases: [
                "provider-doc"
            ],
            category: "providers",
            description:
                "Retrieve one provider documentation record by ID, title, or path.",
            usage:
                "provider-document <id|title|path>",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error(
                        "A documentation ID, title, or path is required."
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
            name: "provider-documentation-current",
            aliases: [
                "provider-docs-current"
            ],
            category: "providers",
            description:
                "List current and available provider documentation.",
            usage:
                "provider-documentation-current [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).current(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "provider-documentation-deprecated",
            aliases: [
                "provider-docs-deprecated"
            ],
            category: "providers",
            description:
                "List deprecated provider documentation.",
            usage:
                "provider-documentation-deprecated [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).deprecated(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "provider-documentation-missing",
            aliases: [
                "provider-docs-missing"
            ],
            category: "providers",
            description:
                "List unavailable or missing provider documentation.",
            usage:
                "provider-documentation-missing [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).missing(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "provider-documentation-archived",
            aliases: [
                "provider-docs-archived"
            ],
            category: "providers",
            description:
                "List archived provider documentation.",
            usage:
                "provider-documentation-archived [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).archived(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "provider-documentation-summary",
            aliases: [
                "provider-docs-summary"
            ],
            category: "providers",
            description:
                "Summarize provider documentation by provider, type, format, language, version, license, status, category, and topic.",
            usage:
                "provider-documentation-summary [filters]",
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
            name: "provider-documentation-integrity",
            aliases: [
                "provider-docs-integrity"
            ],
            category: "providers",
            description:
                "Inspect documentation metadata integrity and state conflicts.",
            usage:
                "provider-documentation-integrity [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).integrity(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "provider-documentation-duplicates",
            aliases: [
                "provider-docs-duplicates"
            ],
            category: "providers",
            description:
                "Analyze duplicate documentation metadata using the provider worker.",
            usage:
                "provider-documentation-duplicates [filters]",
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
            name: "provider-documentation-cache-clear",
            aliases: [
                "provider-docs-cache-clear"
            ],
            category: "providers",
            description:
                "Clear the provider-documentation response cache.",
            usage:
                "provider-documentation-cache-clear",
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
            name: "provider-documentation-status",
            category: "providers",
            description:
                "Show provider-documentation service status.",
            usage:
                "provider-documentation-status",
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
        ProviderDocumentationService,
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

    window.SpeciedexTerminalProviderDocumentation = api;

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
