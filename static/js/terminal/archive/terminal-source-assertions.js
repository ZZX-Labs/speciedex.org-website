/*
========================================================================
Speciedex.org
Terminal SourceAssertions Module
========================================================================

Source-assertion service for SpeciedexTerminal.

Provides:

    • Validated source-assertion API requests
    • Provider, taxon, rank, status, confidence, date, and pagination filters
    • Normalized assertion records and confidence values
    • Conflict, consensus, and provider summaries
    • Lifecycle events and service registration
    • Terminal command integration
    • Abort-signal propagation
    • Loader-safe, idempotent initialization
    • Canonical lowercase module registration

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "source-assertions";
    const LEGACY_MODULE_NAME = "SourceAssertions";
    const VERSION = "2.1.0";

    const ENDPOINT = "archive/assertions";
    const SERVICE_NAME = "source-assertions";
    const SERVICE_ALIAS = "sourceAssertions";

    const DEFAULT_LIMIT = 50;
    const MIN_LIMIT = 1;
    const MAX_LIMIT = 1000;

    const SORT_FIELDS = Object.freeze([
        "asserted_at",
        "created_at",
        "updated_at",
        "provider",
        "taxon",
        "rank",
        "status",
        "confidence",
        "authority"
    ]);

    const SORT_FIELD_SET = new Set(SORT_FIELDS);

    function now() {
        if (
            window.performance &&
            typeof window.performance.now === "function"
        ) {
            return window.performance.now();
        }

        return Date.now();
    }

    function createEvent(name, detail, options = {}) {
        const settings = {
            bubbles:
                options.bubbles === true,
            cancelable:
                options.cancelable === true,
            composed:
                options.composed === true,
            detail
        };

        if (typeof window.CustomEvent === "function") {
            return new window.CustomEvent(
                name,
                settings
            );
        }

        const event =
            document.createEvent(
                "CustomEvent"
            );

        event.initCustomEvent(
            name,
            settings.bubbles,
            settings.cancelable,
            detail
        );

        return event;
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
                createEvent(
                    name,
                    detail,
                    options
                )
            );
        } catch (_error) {
            return false;
        }
    }

    function isObject(value) {
        return Boolean(
            value &&
            typeof value === "object" &&
            !Array.isArray(value)
        );
    }

    function normalizeText(value) {
        return String(value ?? "")
            .trim();
    }

    function clampInteger(
        value,
        fallback,
        minimum,
        maximum
    ) {
        if (
            value === undefined ||
            value === null ||
            value === ""
        ) {
            return fallback;
        }

        const parsed =
            Number.parseInt(value, 10);

        if (!Number.isFinite(parsed)) {
            throw new TypeError(
                `Expected an integer value; received: ${value}`
            );
        }

        return Math.min(
            maximum,
            Math.max(minimum, parsed)
        );
    }

    function clampNumber(
        value,
        fallback,
        minimum,
        maximum
    ) {
        if (
            value === undefined ||
            value === null ||
            value === ""
        ) {
            return fallback;
        }

        const parsed =
            Number(value);

        if (!Number.isFinite(parsed)) {
            throw new TypeError(
                `Expected a numeric value; received: ${value}`
            );
        }

        return Math.min(
            maximum,
            Math.max(minimum, parsed)
        );
    }

    function normalizeDate(value) {
        const text =
            normalizeText(value);

        if (!text) {
            return "";
        }

        const timestamp =
            Date.parse(text);

        if (!Number.isFinite(timestamp)) {
            throw new TypeError(
                `Invalid date value: ${value}`
            );
        }

        return new Date(timestamp)
            .toISOString();
    }

    function normalizeSort(value) {
        const normalized =
            normalizeText(
                value || "asserted_at"
            ).toLowerCase();

        if (!SORT_FIELD_SET.has(normalized)) {
            throw new TypeError(
                `Unsupported source-assertion sort field: ${value}`
            );
        }

        return normalized;
    }

    function normalizeDirection(value) {
        const normalized =
            normalizeText(
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

    function normalizeConfidence(value, fallback = null) {
        if (
            value === undefined ||
            value === null ||
            value === ""
        ) {
            return fallback;
        }

        let number =
            Number(value);

        if (!Number.isFinite(number)) {
            throw new TypeError(
                `Invalid confidence value: ${value}`
            );
        }

        if (number > 1 && number <= 100) {
            number /= 100;
        }

        return clampNumber(
            number,
            fallback,
            0,
            1
        );
    }

    function normalizeParameters(parameters = {}) {
        const source =
            isObject(parameters)
                ? parameters
                : {};

        const normalized = {
            q:
                normalizeText(
                    source.q ??
                    source.query ??
                    ""
                ),
            limit:
                clampInteger(
                    source.limit,
                    DEFAULT_LIMIT,
                    MIN_LIMIT,
                    MAX_LIMIT
                ),
            offset:
                clampInteger(
                    source.offset,
                    0,
                    0,
                    Number.MAX_SAFE_INTEGER
                ),
            sort:
                normalizeSort(
                    source.sort
                ),
            direction:
                normalizeDirection(
                    source.direction ??
                    source.order
                )
        };

        for (
            const key of [
                "provider",
                "taxon",
                "rank",
                "status",
                "authority",
                "source",
                "type",
                "dataset",
                "release"
            ]
        ) {
            if (
                source[key] !== undefined &&
                source[key] !== null &&
                source[key] !== ""
            ) {
                normalized[key] =
                    normalizeText(
                        source[key]
                    );
            }
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
            normalized.min_confidence =
                normalizeConfidence(
                    minimumConfidence,
                    0
                );
        }

        if (
            maximumConfidence !== undefined &&
            maximumConfidence !== null &&
            maximumConfidence !== ""
        ) {
            normalized.max_confidence =
                normalizeConfidence(
                    maximumConfidence,
                    1
                );
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
                "Source-assertion start date must not be later than the end date."
            );
        }

        return normalized;
    }

    function normalizeBoolean(value, fallback = false) {
        if (typeof value === "boolean") {
            return value;
        }

        if (
            value === undefined ||
            value === null ||
            value === ""
        ) {
            return fallback;
        }

        const normalized =
            normalizeText(value)
                .toLowerCase();

        if (
            [
                "1",
                "true",
                "yes",
                "accepted",
                "conflict",
                "conflicted"
            ].includes(normalized)
        ) {
            return true;
        }

        if (
            [
                "0",
                "false",
                "no",
                "rejected",
                "none"
            ].includes(normalized)
        ) {
            return false;
        }

        return fallback;
    }

    function normalizeRecord(record, index = 0) {
        if (!isObject(record)) {
            return {
                index,
                value:
                    record,
                confidence:
                    null,
                accepted:
                    false,
                conflict:
                    false
            };
        }

        const assertedAt =
            record.asserted_at ??
            record.assertedAt ??
            record.created_at ??
            record.createdAt ??
            "";

        const status =
            normalizeText(
                record.status ??
                record.assertion_status ??
                ""
            );

        const normalizedStatus =
            status.toLowerCase();

        return {
            ...record,
            index:
                record.index ??
                index,
            id:
                normalizeText(
                    record.id ??
                    record.assertion_id ??
                    record.assertionId ??
                    ""
                ),
            provider:
                normalizeText(
                    record.provider ??
                    record.source ??
                    ""
                ),
            taxon:
                normalizeText(
                    record.taxon ??
                    record.taxon_name ??
                    record.scientific_name ??
                    record.name ??
                    ""
                ),
            rank:
                normalizeText(
                    record.rank ??
                    ""
                ),
            status,
            authority:
                normalizeText(
                    record.authority ??
                    record.author ??
                    ""
                ),
            confidence:
                normalizeConfidence(
                    record.confidence ??
                    record.score ??
                    record.probability,
                    null
                ),
            asserted_at:
                assertedAt
                    ? normalizeDate(
                        assertedAt
                    )
                    : "",
            accepted:
                record.accepted !== undefined
                    ? normalizeBoolean(
                        record.accepted,
                        false
                    )
                    : normalizedStatus ===
                        "accepted",
            conflict:
                record.conflict !== undefined
                    ? normalizeBoolean(
                        record.conflict,
                        false
                    )
                    : record.conflicted !== undefined
                        ? normalizeBoolean(
                            record.conflicted,
                            false
                        )
                        : normalizedStatus ===
                            "conflict" ||
                            normalizedStatus ===
                            "conflicted"
        };
    }

    function summarize(records) {
        const values =
            Array.isArray(records)
                ? records
                : [];

        const confidences =
            values
                .map(
                    (record) =>
                        normalizeConfidence(
                            record?.confidence,
                            null
                        )
                )
                .filter(
                    (value) =>
                        Number.isFinite(value)
                );

        const accepted =
            values.filter(
                (record) =>
                    record?.accepted === true
            ).length;

        const rejected =
            values.filter(
                (record) =>
                    record?.accepted === false
            ).length;

        const conflicts =
            values.filter(
                (record) =>
                    record?.conflict === true
            ).length;

        const providers =
            new Set(
                values
                    .map(
                        (record) =>
                            record?.provider
                    )
                    .filter(Boolean)
            );

        const taxa =
            new Set(
                values
                    .map(
                        (record) =>
                            record?.taxon
                    )
                    .filter(Boolean)
            );

        const confidenceTotal =
            confidences.reduce(
                (sum, value) =>
                    sum + value,
                0
            );

        return {
            total:
                values.length,
            accepted,
            rejected,
            unknownAcceptance:
                values.length -
                accepted -
                rejected,
            conflicts,
            providers:
                providers.size,
            taxa:
                taxa.size,
            averageConfidence:
                confidences.length
                    ? confidenceTotal /
                        confidences.length
                    : null,
            minimumConfidence:
                confidences.length
                    ? Math.min(
                        ...confidences
                    )
                    : null,
            maximumConfidence:
                confidences.length
                    ? Math.max(
                        ...confidences
                    )
                    : null
        };
    }

    function groupBy(records, key) {
        const normalizedKey =
            normalizeText(key);

        if (!normalizedKey) {
            throw new TypeError(
                "A grouping key is required."
            );
        }

        const values =
            Array.isArray(records)
                ? records
                : [];

        const groups = new Map();

        for (const record of values) {
            const group =
                normalizeText(
                    record?.[
                        normalizedKey
                    ] ??
                    "unknown"
                ) ||
                "unknown";

            const current =
                groups.get(group) || {
                    key:
                        group,
                    count:
                        0,
                    accepted:
                        0,
                    conflicts:
                        0,
                    confidenceTotal:
                        0,
                    confidenceCount:
                        0
                };

            current.count += 1;

            if (record?.accepted === true) {
                current.accepted += 1;
            }

            if (record?.conflict === true) {
                current.conflicts += 1;
            }

            const confidence =
                normalizeConfidence(
                    record?.confidence,
                    null
                );

            if (Number.isFinite(confidence)) {
                current.confidenceTotal +=
                    confidence;

                current.confidenceCount += 1;
            }

            groups.set(
                group,
                current
            );
        }

        return [
            ...groups.values()
        ]
            .map(
                (group) => ({
                    key:
                        group.key,
                    count:
                        group.count,
                    accepted:
                        group.accepted,
                    conflicts:
                        group.conflicts,
                    averageConfidence:
                        group.confidenceCount
                            ? group.confidenceTotal /
                                group.confidenceCount
                            : null
                })
            )
            .sort(
                (left, right) => {
                    const difference =
                        right.count -
                        left.count;

                    if (difference !== 0) {
                        return difference;
                    }

                    return left.key
                        .localeCompare(
                            right.key
                        );
                }
            );
    }

    function normalizeResponse(payload, parameters = {}) {
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
                    parameters.limit ??
                    records.length,
                offset:
                    parameters.offset ??
                    0,
                summary:
                    summarize(records),
                next: null,
                previous: null,
                parameters,
                raw: payload
            };
        }

        if (isObject(payload)) {
            const values =
                Array.isArray(payload.records)
                    ? payload.records
                    : Array.isArray(payload.items)
                        ? payload.items
                        : Array.isArray(payload.assertions)
                            ? payload.assertions
                            : Array.isArray(payload.data)
                                ? payload.data
                                : [];

            const records =
                values.map(
                    normalizeRecord
                );

            const calculatedSummary =
                summarize(records);

            const summary =
                isObject(payload.summary)
                    ? {
                        ...calculatedSummary,
                        ...payload.summary
                    }
                    : calculatedSummary;

            const numericTotal =
                Number(payload.total);

            const numericLimit =
                Number(payload.limit);

            const numericOffset =
                Number(payload.offset);

            return {
                records,
                total:
                    Number.isFinite(numericTotal)
                        ? numericTotal
                        : records.length,
                limit:
                    Number.isFinite(numericLimit)
                        ? numericLimit
                        : parameters.limit ??
                            records.length,
                offset:
                    Number.isFinite(numericOffset)
                        ? numericOffset
                        : parameters.offset ??
                            0,
                summary,
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
                parameters,
                raw: payload
            };
        }

        return {
            records: [],
            total: 0,
            limit:
                parameters.limit ??
                0,
            offset:
                parameters.offset ??
                0,
            summary:
                summarize([]),
            next: null,
            previous: null,
            parameters,
            raw: payload
        };
    }

    function resolveAPI(context) {
        const candidates = [
            context?.api,
            context?.services?.get?.("api"),
            context?.services?.get?.("terminal-api"),
            window.SpeciedexTerminalAPIInstance
        ];

        for (const candidate of candidates) {
            if (
                candidate &&
                typeof candidate.get === "function"
            ) {
                return candidate;
            }
        }

        return null;
    }

    function registerService(context, name, service) {
        let registered = false;

        if (
            typeof context?.registerService ===
            "function"
        ) {
            try {
                context.registerService(
                    name,
                    service
                );

                registered = true;
            } catch (_error) {
                /*
                Continue with direct registry insertion.
                */
            }
        }

        if (
            context?.services &&
            typeof context.services.set ===
                "function"
        ) {
            try {
                context.services.set(
                    name,
                    service
                );

                registered = true;
            } catch (_error) {
                /*
                Ignore custom registry failures.
                */
            }
        }

        if (
            context?.services &&
            typeof context.services === "object" &&
            typeof context.services.set !==
                "function"
        ) {
            try {
                context.services[name] =
                    service;

                registered = true;
            } catch (_error) {
                /*
                Ignore immutable registries.
                */
            }
        }

        return registered;
    }

    function unregisterService(context, name, service) {
        if (
            typeof context?.unregisterService ===
            "function"
        ) {
            try {
                context.unregisterService(
                    name,
                    service
                );
            } catch (_error) {
                /*
                Continue with registry cleanup.
                */
            }
        }

        if (
            context?.services &&
            typeof context.services.get ===
                "function" &&
            typeof context.services.delete ===
                "function"
        ) {
            try {
                if (
                    context.services.get(name) ===
                    service
                ) {
                    context.services.delete(name);
                }
            } catch (_error) {
                /*
                Ignore registry cleanup failures.
                */
            }
        }

        if (
            context?.services &&
            typeof context.services === "object" &&
            typeof context.services.get !==
                "function"
        ) {
            try {
                if (
                    context.services[name] ===
                    service
                ) {
                    delete context.services[name];
                }
            } catch (_error) {
                /*
                Ignore immutable registries.
                */
            }
        }
    }

    class SourceAssertionsService extends EventTarget {
        constructor(context) {
            super();

            if (!isObject(context)) {
                throw new TypeError(
                    "A terminal context is required."
                );
            }

            this.context = context;
            this.api = resolveAPI(context);
            this.destroyed = false;
            this.activeRequests = 0;
        }

        ensureAvailable() {
            if (this.destroyed) {
                throw new Error(
                    "Source-assertions service has been destroyed."
                );
            }

            if (
                !this.api ||
                typeof this.api.get !== "function"
            ) {
                this.api =
                    resolveAPI(this.context);
            }

            if (
                !this.api ||
                typeof this.api.get !== "function"
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
                    `source-assertions:${name}`,
                    detail
                );
            } catch (_error) {
                /*
                Observer failures must not break assertion requests.
                */
            }

            dispatch(
                this.context.root ||
                    document,
                `speciedex:terminal-source-assertions-${name}`,
                detail,
                {
                    bubbles: true,
                    composed: true
                }
            );
        }

        async list(parameters = {}, options = {}) {
            this.ensureAvailable();

            const normalized =
                normalizeParameters(
                    parameters
                );

            const requestOptions =
                isObject(options)
                    ? options
                    : {};

            const startedAt =
                now();

            this.activeRequests += 1;

            this.emit(
                "request",
                {
                    endpoint:
                        ENDPOINT,
                    parameters:
                        normalized,
                    activeRequests:
                        this.activeRequests
                }
            );

            try {
                const payload =
                    await this.api.get(
                        ENDPOINT,
                        normalized,
                        requestOptions
                    );

                const result =
                    normalizeResponse(
                        payload,
                        normalized
                    );

                result.endpoint =
                    ENDPOINT;

                result.duration =
                    now() -
                    startedAt;

                this.emit(
                    "complete",
                    result
                );

                return result;
            } catch (error) {
                this.emit(
                    "error",
                    {
                        error,
                        endpoint:
                            ENDPOINT,
                        parameters:
                            normalized,
                        duration:
                            now() -
                            startedAt,
                        aborted:
                            error?.name ===
                            "AbortError"
                    }
                );

                throw error;
            } finally {
                this.activeRequests =
                    Math.max(
                        0,
                        this.activeRequests - 1
                    );
            }
        }

        async forTaxon(
            taxon,
            parameters = {},
            options = {}
        ) {
            const normalizedTaxon =
                normalizeText(taxon);

            if (!normalizedTaxon) {
                throw new TypeError(
                    "A taxon name or identifier is required."
                );
            }

            return this.list(
                {
                    ...parameters,
                    taxon:
                        normalizedTaxon
                },
                options
            );
        }

        async forProvider(
            provider,
            parameters = {},
            options = {}
        ) {
            const normalizedProvider =
                normalizeText(provider);

            if (!normalizedProvider) {
                throw new TypeError(
                    "A provider name is required."
                );
            }

            return this.list(
                {
                    ...parameters,
                    provider:
                        normalizedProvider
                },
                options
            );
        }

        async conflicts(parameters = {}, options = {}) {
            const source =
                isObject(parameters)
                    ? parameters
                    : {};

            const result =
                await this.list(
                    {
                        ...source,
                        status:
                            source.status ??
                            "conflict"
                    },
                    options
                );

            const conflictRecords =
                result.records.filter(
                    (record) =>
                        record.conflict === true ||
                        String(
                            record.status
                        ).toLowerCase() ===
                            "conflict" ||
                        String(
                            record.status
                        ).toLowerCase() ===
                            "conflicted"
                );

            return {
                ...result,
                records:
                    conflictRecords,
                total:
                    conflictRecords.length,
                summary:
                    summarize(
                        conflictRecords
                    )
            };
        }

        async summary(parameters = {}, options = {}) {
            const source =
                isObject(parameters)
                    ? parameters
                    : {};

            const result =
                await this.list(
                    {
                        ...source,
                        limit:
                            source.limit ??
                            MAX_LIMIT
                    },
                    options
                );

            return {
                endpoint:
                    ENDPOINT,
                parameters:
                    result.parameters,
                summary:
                    summarize(
                        result.records
                    ),
                byProvider:
                    groupBy(
                        result.records,
                        "provider"
                    ),
                byStatus:
                    groupBy(
                        result.records,
                        "status"
                    ),
                byRank:
                    groupBy(
                        result.records,
                        "rank"
                    ),
                duration:
                    result.duration
            };
        }

        status() {
            const api =
                resolveAPI(
                    this.context
                );

            return {
                module:
                    MODULE_NAME,
                version:
                    VERSION,
                endpoint:
                    ENDPOINT,
                service:
                    SERVICE_NAME,
                sortFields:
                    [...SORT_FIELDS],
                available:
                    Boolean(
                        api &&
                        typeof api.get ===
                            "function"
                    ),
                activeRequests:
                    this.activeRequests,
                destroyed:
                    this.destroyed
            };
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            this.destroyed = true;

            unregisterService(
                this.context,
                SERVICE_NAME,
                this
            );

            unregisterService(
                this.context,
                SERVICE_ALIAS,
                this
            );

            if (
                this.context.sourceAssertions ===
                this
            ) {
                delete this.context.sourceAssertions;
            }

            const detail = {
                timestamp:
                    new Date().toISOString()
            };

            dispatch(
                this,
                "destroy",
                detail
            );

            dispatch(
                this.context.root ||
                    document,
                "speciedex:terminal-source-assertions-destroy",
                detail,
                {
                    bubbles: true,
                    composed: true
                }
            );

            return true;
        }
    }

    function findExistingService(context) {
        const candidates = [
            context?.sourceAssertions,
            context?.services?.get?.(
                SERVICE_NAME
            ),
            context?.services?.get?.(
                SERVICE_ALIAS
            ),
            context?.services?.[
                SERVICE_NAME
            ],
            context?.services?.[
                SERVICE_ALIAS
            ]
        ];

        for (const candidate of candidates) {
            if (
                candidate instanceof
                    SourceAssertionsService &&
                !candidate.destroyed
            ) {
                return candidate;
            }
        }

        return null;
    }

    function initialize(context) {
        if (!isObject(context)) {
            throw new TypeError(
                "A terminal context is required."
            );
        }

        const existing =
            findExistingService(
                context
            );

        if (existing) {
            context.sourceAssertions =
                existing;

            registerService(
                context,
                SERVICE_NAME,
                existing
            );

            registerService(
                context,
                SERVICE_ALIAS,
                existing
            );

            return existing;
        }

        const service =
            new SourceAssertionsService(
                context
            );

        context.sourceAssertions =
            service;

        registerService(
            context,
            SERVICE_NAME,
            service
        );

        registerService(
            context,
            SERVICE_ALIAS,
            service
        );

        const detail = {
            context,
            service,
            module:
                MODULE_NAME,
            version:
                VERSION
        };

        dispatch(
            document,
            "speciedex:terminal-source-assertions-ready",
            detail
        );

        dispatch(
            context.root ||
                document,
            "speciedex:terminal-service-ready",
            {
                name:
                    SERVICE_NAME,
                service,
                module:
                    MODULE_NAME
            },
            {
                bubbles: true,
                composed: true
            }
        );

        return service;
    }

    function requireService(context) {
        const service =
            findExistingService(
                context
            );

        if (service) {
            return service;
        }

        return initialize(context);
    }

    function tokenizeArguments(args) {
        if (Array.isArray(args)) {
            return args.map(
                (value) =>
                    String(value)
            );
        }

        if (typeof args === "string") {
            return args
                .trim()
                .split(/\s+/u)
                .filter(Boolean);
        }

        return [];
    }

    function parseCommandArguments(args = []) {
        const tokens =
            tokenizeArguments(args);

        const parameters = {};
        const positional = [];

        const optionMap = {
            "--limit": "limit",
            "--offset": "offset",
            "--provider": "provider",
            "--taxon": "taxon",
            "--rank": "rank",
            "--status": "status",
            "--authority": "authority",
            "--source": "source",
            "--type": "type",
            "--dataset": "dataset",
            "--release": "release",
            "--min-confidence": "min_confidence",
            "--max-confidence": "max_confidence",
            "--from": "from",
            "--to": "to",
            "--sort": "sort",
            "--direction": "direction",
            "--order": "direction",
            "--query": "q"
        };

        for (
            let index = 0;
            index < tokens.length;
            index += 1
        ) {
            const argument =
                tokens[index];

            if (
                argument === "--asc" ||
                argument === "-a"
            ) {
                parameters.direction =
                    "asc";
                continue;
            }

            if (
                argument === "--desc" ||
                argument === "-d"
            ) {
                parameters.direction =
                    "desc";
                continue;
            }

            if (argument.startsWith("--")) {
                const equalsIndex =
                    argument.indexOf("=");

                if (equalsIndex > 2) {
                    const key =
                        argument.slice(
                            0,
                            equalsIndex
                        );

                    const mapped =
                        optionMap[key];

                    if (!mapped) {
                        throw new TypeError(
                            `Unsupported source-assertions option: ${key}`
                        );
                    }

                    parameters[mapped] =
                        argument.slice(
                            equalsIndex + 1
                        );

                    continue;
                }

                const mapped =
                    optionMap[argument];

                if (!mapped) {
                    throw new TypeError(
                        `Unsupported source-assertions option: ${argument}`
                    );
                }

                const next =
                    tokens[index + 1];

                if (
                    next === undefined ||
                    next.startsWith("--")
                ) {
                    throw new TypeError(
                        `Missing value for source-assertions option: ${argument}`
                    );
                }

                parameters[mapped] =
                    next;

                index += 1;
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

        if (positional.length > 2) {
            parameters.q =
                positional
                    .slice(
                        0,
                        -1
                    )
                    .join(" ");

            parameters.limit =
                positional[
                    positional.length - 1
                ];
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

    const commands = Object.freeze([
        Object.freeze({
            name:
                "source-assertions",
            aliases: Object.freeze([
                "assertions"
            ]),
            category:
                "archive",
            description:
                "Inspect source assertion records.",
            usage:
                "source-assertions [query] [limit] [--provider NAME] [--taxon NAME] [--rank RANK] [--status STATUS] [--authority NAME] [--source NAME] [--type TYPE] [--dataset NAME] [--release ID] [--min-confidence N] [--max-confidence N] [--from DATE] [--to DATE] [--sort FIELD] [--direction asc|desc] [--offset N]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) => {
                const parameters =
                    parseCommandArguments(
                        args
                    );

                const result =
                    await requireService(
                        context
                    ).list(
                        parameters,
                        signal
                            ? { signal }
                            : {}
                    );

                return writeJSONValue(
                    writeJSON,
                    result
                );
            }
        }),
        Object.freeze({
            name:
                "source-assertions-summary",
            aliases: Object.freeze([
                "assertions-summary"
            ]),
            category:
                "archive",
            description:
                "Summarize source assertions by provider, status, and rank.",
            usage:
                "source-assertions-summary [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) => {
                const parameters =
                    parseCommandArguments(
                        args
                    );

                const result =
                    await requireService(
                        context
                    ).summary(
                        parameters,
                        signal
                            ? { signal }
                            : {}
                    );

                return writeJSONValue(
                    writeJSON,
                    result
                );
            }
        }),
        Object.freeze({
            name:
                "source-assertion-conflicts",
            aliases: Object.freeze([
                "assertion-conflicts"
            ]),
            category:
                "archive",
            description:
                "Display conflicting source assertions.",
            usage:
                "source-assertion-conflicts [query] [limit]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) => {
                const parameters =
                    parseCommandArguments(
                        args
                    );

                const result =
                    await requireService(
                        context
                    ).conflicts(
                        parameters,
                        signal
                            ? { signal }
                            : {}
                    );

                return writeJSONValue(
                    writeJSON,
                    result
                );
            }
        }),
        Object.freeze({
            name:
                "source-assertions-status",
            category:
                "archive",
            description:
                "Show source-assertions service status.",
            usage:
                "source-assertions-status",
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
        })
    ]);

    const api = Object.freeze({
        name:
            MODULE_NAME,
        legacyName:
            LEGACY_MODULE_NAME,
        version:
            VERSION,
        endpoint:
            ENDPOINT,
        serviceName:
            SERVICE_NAME,
        serviceAlias:
            SERVICE_ALIAS,
        sortFields:
            SORT_FIELDS,
        SourceAssertionsService,
        normalizeParameters,
        normalizeRecord,
        normalizeResponse,
        normalizeConfidence,
        normalizeBoolean,
        summarize,
        groupBy,
        parseCommandArguments,
        initialize,
        mount:
            initialize,
        init:
            initialize,
        setup:
            initialize,
        commands
    });

    window.SpeciedexTerminalSourceAssertions =
        api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules || {};

    window.SpeciedexTerminalModules[
        MODULE_NAME
    ] = api;

    /*
    --------------------------------------------------------------------
    Historical loader bridge. Canonical registration remains
    "source-assertions".
    --------------------------------------------------------------------
    */
    window.SpeciedexTerminalModules[
        LEGACY_MODULE_NAME
    ] = api;

    dispatch(
        document,
        "speciedex:terminal-module-available",
        {
            name:
                MODULE_NAME,
            legacyName:
                LEGACY_MODULE_NAME,
            module:
                api
        }
    );
})(window, document);
