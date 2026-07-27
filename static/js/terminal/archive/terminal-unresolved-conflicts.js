/*
========================================================================
Speciedex.org
Terminal UnresolvedConflicts Module
========================================================================

Unresolved provider-conflict service for SpeciedexTerminal.

Provides:

    • Validated unresolved-conflict API requests
    • Provider, taxon, rank, field, severity, status, date, and pagination filters
    • Normalized conflict records
    • Severity, provider, field, and taxon summaries
    • Conflict comparison and ambiguity helpers
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

    const MODULE_NAME = "unresolved-conflicts";
    const LEGACY_MODULE_NAME = "UnresolvedConflicts";
    const VERSION = "2.1.0";

    const ENDPOINT = "archive/conflicts";
    const SERVICE_NAME = "unresolved-conflicts";
    const SERVICE_ALIAS = "unresolvedConflicts";

    const DEFAULT_LIMIT = 50;
    const MIN_LIMIT = 1;
    const MAX_LIMIT = 1000;

    const SEVERITY_ORDER = Object.freeze({
        unknown: 0,
        low: 1,
        medium: 2,
        high: 3,
        critical: 4
    });

    const SORT_FIELDS = Object.freeze([
        "severity",
        "created_at",
        "updated_at",
        "provider",
        "taxon",
        "rank",
        "field",
        "status",
        "age"
    ]);

    const SORT_FIELD_SET =
        new Set(SORT_FIELDS);

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

    function normalizeSeverity(value, allowEmpty = true) {
        const normalized =
            normalizeText(value)
                .toLowerCase();

        if (!normalized && allowEmpty) {
            return "";
        }

        if (
            !Object.prototype.hasOwnProperty.call(
                SEVERITY_ORDER,
                normalized
            )
        ) {
            throw new TypeError(
                `Unsupported conflict severity: ${value}`
            );
        }

        return normalized;
    }

    function normalizeSort(value) {
        const normalized =
            normalizeText(
                value || "severity"
            ).toLowerCase();

        if (!SORT_FIELD_SET.has(normalized)) {
            throw new TypeError(
                `Unsupported conflict sort field: ${value}`
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
                "field",
                "status",
                "authority",
                "dataset",
                "release",
                "volume",
                "type"
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

        const severity =
            source.severity ??
            source.level;

        if (
            severity !== undefined &&
            severity !== null &&
            severity !== ""
        ) {
            normalized.severity =
                normalizeSeverity(
                    severity,
                    false
                );
        }

        const minimumSeverity =
            source.minSeverity ??
            source.min_severity;

        if (
            minimumSeverity !== undefined &&
            minimumSeverity !== null &&
            minimumSeverity !== ""
        ) {
            normalized.min_severity =
                normalizeSeverity(
                    minimumSeverity,
                    false
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
                "Conflict start date must not be later than the end date."
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

        let normalized =
            Number(value);

        if (!Number.isFinite(normalized)) {
            return fallback;
        }

        if (
            normalized > 1 &&
            normalized <= 100
        ) {
            normalized /= 100;
        }

        return Math.min(
            1,
            Math.max(
                0,
                normalized
            )
        );
    }

    function normalizeProviders(record) {
        if (!isObject(record)) {
            return [];
        }

        const raw =
            record.providers ??
            record.sources ??
            record.provider_names ??
            record.providerNames ??
            [];

        if (Array.isArray(raw)) {
            return [
                ...new Set(
                    raw
                        .map(
                            (item) => {
                                if (isObject(item)) {
                                    return normalizeText(
                                        item.name ??
                                        item.provider ??
                                        item.source ??
                                        item.id
                                    );
                                }

                                return normalizeText(item);
                            }
                        )
                        .filter(Boolean)
                )
            ];
        }

        if (isObject(raw)) {
            return [
                ...new Set(
                    Object.keys(raw)
                        .map(normalizeText)
                        .filter(Boolean)
                )
            ];
        }

        const single =
            normalizeText(
                raw ||
                record.provider ||
                record.source
            );

        return single
            ? [single]
            : [];
    }

    function normalizeValues(record) {
        if (!isObject(record)) {
            return [];
        }

        const raw =
            record.values ??
            record.assertions ??
            record.options ??
            record.candidates ??
            [];

        if (Array.isArray(raw)) {
            return raw.map(
                (item) => {
                    if (isObject(item)) {
                        return {
                            provider:
                                normalizeText(
                                    item.provider ??
                                    item.source ??
                                    ""
                                ),
                            value:
                                item.value ??
                                item.assertion ??
                                item.name ??
                                null,
                            confidence:
                                normalizeConfidence(
                                    item.confidence ??
                                    item.score ??
                                    item.probability,
                                    null
                                )
                        };
                    }

                    return {
                        provider:
                            "",
                        value:
                            item,
                        confidence:
                            null
                    };
                }
            );
        }

        if (isObject(raw)) {
            return Object.entries(raw)
                .map(
                    ([provider, value]) => {
                        if (isObject(value)) {
                            return {
                                provider:
                                    normalizeText(
                                        value.provider ??
                                        provider
                                    ),
                                value:
                                    value.value ??
                                    value.assertion ??
                                    value.name ??
                                    null,
                                confidence:
                                    normalizeConfidence(
                                        value.confidence ??
                                        value.score ??
                                        value.probability,
                                        null
                                    )
                            };
                        }

                        return {
                            provider:
                                normalizeText(provider),
                            value,
                            confidence:
                                null
                        };
                    }
                );
        }

        return [];
    }

    function normalizeRecord(record, index = 0) {
        if (!isObject(record)) {
            return {
                index,
                value:
                    record,
                severity:
                    "unknown",
                providers:
                    [],
                values:
                    [],
                provider_count:
                    0,
                value_count:
                    0
            };
        }

        const createdAt =
            record.created_at ??
            record.createdAt ??
            record.detected_at ??
            record.detectedAt ??
            "";

        const updatedAt =
            record.updated_at ??
            record.updatedAt ??
            createdAt;

        const providers =
            normalizeProviders(record);

        const values =
            normalizeValues(record);

        const numericProviderCount =
            Number(
                record.provider_count ??
                record.providerCount
            );

        const numericValueCount =
            Number(
                record.value_count ??
                record.valueCount
            );

        return {
            ...record,
            index:
                record.index ??
                index,
            id:
                normalizeText(
                    record.id ??
                    record.conflict_id ??
                    record.conflictId ??
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
            field:
                normalizeText(
                    record.field ??
                    record.attribute ??
                    record.property ??
                    ""
                ),
            status:
                normalizeText(
                    record.status ??
                    "unresolved"
                ),
            severity:
                normalizeSeverity(
                    record.severity ??
                    record.level ??
                    "unknown",
                    false
                ),
            providers,
            values,
            created_at:
                createdAt
                    ? normalizeDate(createdAt)
                    : "",
            updated_at:
                updatedAt
                    ? normalizeDate(updatedAt)
                    : "",
            provider_count:
                Number.isFinite(
                    numericProviderCount
                )
                    ? numericProviderCount
                    : providers.length,
            value_count:
                Number.isFinite(
                    numericValueCount
                )
                    ? numericValueCount
                    : values.length
        };
    }

    function summarize(records) {
        const values =
            Array.isArray(records)
                ? records
                : [];

        const severity = {
            unknown: 0,
            low: 0,
            medium: 0,
            high: 0,
            critical: 0
        };

        const providers =
            new Set();

        const taxa =
            new Set();

        const fields =
            new Set();

        for (const record of values) {
            const level =
                Object.prototype.hasOwnProperty.call(
                    severity,
                    record?.severity
                )
                    ? record.severity
                    : "unknown";

            severity[level] += 1;

            for (
                const provider of
                record?.providers || []
            ) {
                if (provider) {
                    providers.add(provider);
                }
            }

            if (record?.taxon) {
                taxa.add(record.taxon);
            }

            if (record?.field) {
                fields.add(record.field);
            }
        }

        return {
            total:
                values.length,
            severity,
            providers:
                providers.size,
            taxa:
                taxa.size,
            fields:
                fields.size,
            highPriority:
                severity.high +
                severity.critical
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

        const groups = new Map();

        for (
            const record of
            Array.isArray(records)
                ? records
                : []
        ) {
            const rawValues =
                normalizedKey === "provider"
                    ? (
                        record?.providers?.length
                            ? record.providers
                            : ["unknown"]
                    )
                    : [
                        normalizeText(
                            record?.[
                                normalizedKey
                            ] ??
                            "unknown"
                        ) ||
                        "unknown"
                    ];

            for (const rawValue of rawValues) {
                const value =
                    normalizeText(
                        rawValue
                    ) ||
                    "unknown";

                const current =
                    groups.get(value) || {
                        key:
                            value,
                        count:
                            0,
                        high:
                            0,
                        critical:
                            0
                    };

                current.count += 1;

                if (
                    record?.severity ===
                    "high"
                ) {
                    current.high += 1;
                }

                if (
                    record?.severity ===
                    "critical"
                ) {
                    current.critical += 1;
                }

                groups.set(
                    value,
                    current
                );
            }
        }

        return [
            ...groups.values()
        ].sort(
            (left, right) =>
                right.critical -
                    left.critical ||
                right.high -
                    left.high ||
                right.count -
                    left.count ||
                left.key.localeCompare(
                    right.key
                )
        );
    }

    function stableSerialize(value) {
        if (
            value === null ||
            typeof value !== "object"
        ) {
            return JSON.stringify(value);
        }

        if (Array.isArray(value)) {
            return `[${value
                .map(stableSerialize)
                .join(",")}]`;
        }

        const keys =
            Object.keys(value)
                .sort();

        return `{${keys
            .map(
                (key) =>
                    `${JSON.stringify(key)}:${stableSerialize(value[key])}`
            )
            .join(",")}}`;
    }

    function compareConflictValues(record) {
        const normalized =
            normalizeRecord(record);

        const groups = new Map();

        for (const item of normalized.values) {
            let key;

            try {
                key =
                    stableSerialize(
                        item.value
                    );
            } catch (_error) {
                key =
                    String(
                        item.value
                    );
            }

            const current =
                groups.get(key) || {
                    value:
                        item.value,
                    providers:
                        [],
                    confidences:
                        []
                };

            if (item.provider) {
                current.providers.push(
                    item.provider
                );
            }

            if (
                Number.isFinite(
                    item.confidence
                )
            ) {
                current.confidences.push(
                    item.confidence
                );
            }

            groups.set(
                key,
                current
            );
        }

        return [
            ...groups.values()
        ]
            .map(
                (group) => ({
                    value:
                        group.value,
                    providers: [
                        ...new Set(
                            group.providers
                        )
                    ],
                    providerCount:
                        new Set(
                            group.providers
                        ).size,
                    averageConfidence:
                        group.confidences.length
                            ? group.confidences.reduce(
                                (sum, value) =>
                                    sum + value,
                                0
                            ) /
                                group.confidences.length
                            : null
                })
            )
            .sort(
                (left, right) =>
                    right.providerCount -
                    left.providerCount
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
                        : Array.isArray(payload.conflicts)
                            ? payload.conflicts
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

    class UnresolvedConflictsService extends EventTarget {
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
                    "Unresolved-conflicts service has been destroyed."
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
                    `unresolved-conflicts:${name}`,
                    detail
                );
            } catch (_error) {
                /*
                Observer failures must not break conflict requests.
                */
            }

            dispatch(
                this.context.root ||
                    document,
                `speciedex:terminal-unresolved-conflicts-${name}`,
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
                    operation:
                        "list",
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
                        operation:
                            "list",
                        endpoint:
                            ENDPOINT,
                        error,
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

        async get(id, options = {}) {
            this.ensureAvailable();

            const normalizedId =
                normalizeText(id);

            if (!normalizedId) {
                throw new TypeError(
                    "A conflict ID is required."
                );
            }

            const endpoint =
                `${ENDPOINT}/${encodeURIComponent(normalizedId)}`;

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
                    operation:
                        "get",
                    endpoint,
                    id:
                        normalizedId,
                    activeRequests:
                        this.activeRequests
                }
            );

            try {
                const payload =
                    await this.api.get(
                        endpoint,
                        {},
                        requestOptions
                    );

                const source =
                    isObject(payload?.conflict)
                        ? payload.conflict
                        : isObject(payload?.data)
                            ? payload.data
                            : payload;

                const conflict =
                    normalizeRecord(
                        source,
                        0
                    );

                this.emit(
                    "complete",
                    {
                        operation:
                            "get",
                        endpoint,
                        conflict,
                        duration:
                            now() -
                            startedAt
                    }
                );

                return conflict;
            } catch (error) {
                this.emit(
                    "error",
                    {
                        operation:
                            "get",
                        endpoint,
                        id:
                            normalizedId,
                        error,
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

        async highPriority(parameters = {}, options = {}) {
            const source =
                isObject(parameters)
                    ? parameters
                    : {};

            const result =
                await this.list(
                    {
                        ...source,
                        min_severity:
                            source.min_severity ??
                            source.minSeverity ??
                            "high",
                        sort:
                            source.sort ??
                            "severity",
                        direction:
                            source.direction ??
                            source.order ??
                            "desc"
                    },
                    options
                );

            const records =
                result.records.filter(
                    (record) =>
                        SEVERITY_ORDER[
                            record.severity
                        ] >=
                        SEVERITY_ORDER.high
                );

            return {
                ...result,
                records,
                total:
                    records.length,
                summary:
                    summarize(records)
            };
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
                bySeverity:
                    groupBy(
                        result.records,
                        "severity"
                    ),
                byProvider:
                    groupBy(
                        result.records,
                        "provider"
                    ),
                byField:
                    groupBy(
                        result.records,
                        "field"
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
                severities:
                    Object.keys(
                        SEVERITY_ORDER
                    ),
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
                this.context.unresolvedConflicts ===
                this
            ) {
                delete this.context.unresolvedConflicts;
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
                "speciedex:terminal-unresolved-conflicts-destroy",
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
            context?.unresolvedConflicts,
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
                    UnresolvedConflictsService &&
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
            context.unresolvedConflicts =
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
            new UnresolvedConflictsService(
                context
            );

        context.unresolvedConflicts =
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
            "speciedex:terminal-unresolved-conflicts-ready",
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
            "--field": "field",
            "--severity": "severity",
            "--min-severity": "min_severity",
            "--status": "status",
            "--authority": "authority",
            "--dataset": "dataset",
            "--release": "release",
            "--volume": "volume",
            "--type": "type",
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
                            `Unsupported unresolved-conflicts option: ${key}`
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
                        `Unsupported unresolved-conflicts option: ${argument}`
                    );
                }

                const next =
                    tokens[index + 1];

                if (
                    next === undefined ||
                    next.startsWith("--")
                ) {
                    throw new TypeError(
                        `Missing value for unresolved-conflicts option: ${argument}`
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
                "unresolved-conflicts",
            aliases: Object.freeze([
                "conflicts",
                "conflict-list"
            ]),
            category:
                "archive",
            description:
                "Inspect unresolved provider conflicts.",
            usage:
                "unresolved-conflicts [query] [limit] [--provider NAME] [--taxon NAME] [--rank RANK] [--field FIELD] [--severity LEVEL] [--min-severity LEVEL] [--status STATUS] [--authority NAME] [--dataset NAME] [--release ID] [--volume ID] [--type TYPE] [--from DATE] [--to DATE] [--sort FIELD] [--direction asc|desc] [--offset N]",
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
                "conflict",
            aliases: Object.freeze([
                "conflict-get"
            ]),
            category:
                "archive",
            description:
                "Retrieve one unresolved conflict by ID.",
            usage:
                "conflict <id>",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) => {
                const tokens =
                    tokenizeArguments(args);

                if (!tokens[0]) {
                    throw new Error(
                        "A conflict ID is required."
                    );
                }

                const result =
                    await requireService(
                        context
                    ).get(
                        tokens[0],
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
                "conflicts-high-priority",
            aliases: Object.freeze([
                "critical-conflicts"
            ]),
            category:
                "archive",
            description:
                "Display high and critical unresolved conflicts.",
            usage:
                "conflicts-high-priority [filters]",
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
                    ).highPriority(
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
                "conflicts-summary",
            category:
                "archive",
            description:
                "Summarize unresolved conflicts by severity, provider, field, and rank.",
            usage:
                "conflicts-summary [filters]",
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
                "unresolved-conflicts-status",
            aliases: Object.freeze([
                "conflicts-status"
            ]),
            category:
                "archive",
            description:
                "Show unresolved-conflicts service status.",
            usage:
                "unresolved-conflicts-status",
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
        SEVERITY_ORDER,
        UnresolvedConflictsService,
        normalizeSeverity,
        normalizeParameters,
        normalizeProviders,
        normalizeValues,
        normalizeRecord,
        normalizeResponse,
        normalizeConfidence,
        summarize,
        groupBy,
        stableSerialize,
        compareConflictValues,
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

    window.SpeciedexTerminalUnresolvedConflicts =
        api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules || {};

    window.SpeciedexTerminalModules[
        MODULE_NAME
    ] = api;

    /*
    --------------------------------------------------------------------
    Historical loader bridge. Canonical registration remains
    "unresolved-conflicts".
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
