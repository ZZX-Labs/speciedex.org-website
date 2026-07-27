/*
========================================================================
Speciedex.org
Terminal Synonyms Module
========================================================================

Archived taxonomic-synonym service for SpeciedexTerminal.

Provides:

    • Validated synonym API requests
    • Provider, rank, status, accepted-name, synonym, date, and pagination filters
    • Normalized synonym records
    • Accepted-name, provider, and ambiguity summaries
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

    const MODULE_NAME = "synonyms";
    const VERSION = "2.1.0";

    const ENDPOINT = "archive/synonyms";
    const SERVICE_NAME = "synonyms";
    const SERVICE_ALIAS = "synonym";

    const DEFAULT_LIMIT = 50;
    const MIN_LIMIT = 1;
    const MAX_LIMIT = 1000;

    const SORT_FIELDS = Object.freeze([
        "synonym",
        "accepted_name",
        "provider",
        "rank",
        "status",
        "created_at",
        "updated_at",
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
                value || "synonym"
            ).toLowerCase();

        if (!SORT_FIELD_SET.has(normalized)) {
            throw new TypeError(
                `Unsupported synonym sort field: ${value}`
            );
        }

        return normalized;
    }

    function normalizeDirection(value) {
        const normalized =
            normalizeText(
                value || "asc"
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

        const aliases = {
            accepted_name:
                source.accepted_name ??
                source.acceptedName ??
                source.accepted,
            synonym:
                source.synonym ??
                source.name,
            provider:
                source.provider ??
                source.source,
            rank:
                source.rank,
            status:
                source.status,
            authority:
                source.authority,
            dataset:
                source.dataset,
            release:
                source.release,
            taxon_id:
                source.taxon_id ??
                source.taxonId
        };

        for (
            const [key, value] of
            Object.entries(aliases)
        ) {
            if (
                value !== undefined &&
                value !== null &&
                value !== ""
            ) {
                normalized[key] =
                    normalizeText(value);
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
                "Synonym start date must not be later than the end date."
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
                "ambiguous",
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
                "unambiguous",
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
                synonym:
                    normalizeText(record),
                accepted_name:
                    "",
                ambiguous:
                    false,
                value:
                    record
            };
        }

        const status =
            normalizeText(
                record.status ??
                record.taxonomic_status ??
                record.taxonomicStatus ??
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
                    record.synonym_id ??
                    record.synonymId ??
                    ""
                ),
            synonym:
                normalizeText(
                    record.synonym ??
                    record.name ??
                    record.scientific_name ??
                    record.scientificName ??
                    ""
                ),
            accepted_name:
                normalizeText(
                    record.accepted_name ??
                    record.acceptedName ??
                    record.accepted ??
                    record.canonical_name ??
                    record.canonicalName ??
                    ""
                ),
            provider:
                normalizeText(
                    record.provider ??
                    record.source ??
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
            taxon_id:
                normalizeText(
                    record.taxon_id ??
                    record.taxonId ??
                    ""
                ),
            accepted_id:
                normalizeText(
                    record.accepted_id ??
                    record.acceptedId ??
                    record.accepted_taxon_id ??
                    record.acceptedTaxonId ??
                    ""
                ),
            ambiguous:
                record.ambiguous !== undefined
                    ? normalizeBoolean(
                        record.ambiguous,
                        false
                    )
                    : record.conflict !== undefined
                        ? normalizeBoolean(
                            record.conflict,
                            false
                        )
                        : normalizedStatus ===
                            "ambiguous" ||
                            normalizedStatus ===
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

        const acceptedNames =
            new Set(
                values
                    .map(
                        (record) =>
                            record?.accepted_name
                    )
                    .filter(Boolean)
            );

        const providers =
            new Set(
                values
                    .map(
                        (record) =>
                            record?.provider
                    )
                    .filter(Boolean)
            );

        const ranks =
            new Set(
                values
                    .map(
                        (record) =>
                            record?.rank
                    )
                    .filter(Boolean)
            );

        const ambiguous =
            values.filter(
                (record) =>
                    record?.ambiguous === true
            ).length;

        return {
            total:
                values.length,
            acceptedNames:
                acceptedNames.size,
            providers:
                providers.size,
            ranks:
                ranks.size,
            ambiguous,
            unambiguous:
                values.length -
                ambiguous
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
            const value =
                normalizeText(
                    record?.[
                        normalizedKey
                    ] ??
                    "unknown"
                ) ||
                "unknown";

            const current =
                groups.get(value) || {
                    key:
                        value,
                    count:
                        0,
                    ambiguous:
                        0
                };

            current.count += 1;

            if (
                record?.ambiguous === true
            ) {
                current.ambiguous += 1;
            }

            groups.set(
                value,
                current
            );
        }

        return [
            ...groups.values()
        ].sort(
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

    function findAmbiguities(records) {
        const bySynonym = new Map();

        for (
            const record of
            Array.isArray(records)
                ? records
                : []
        ) {
            const synonym =
                normalizeText(
                    record?.synonym
                ).toLowerCase();

            if (!synonym) {
                continue;
            }

            const collection =
                bySynonym.get(
                    synonym
                ) || [];

            collection.push(record);

            bySynonym.set(
                synonym,
                collection
            );
        }

        return [
            ...bySynonym.entries()
        ]
            .map(
                ([synonym, entries]) => {
                    const acceptedNames = [
                        ...new Set(
                            entries
                                .map(
                                    (entry) =>
                                        entry.accepted_name
                                )
                                .filter(Boolean)
                        )
                    ];

                    const providers = [
                        ...new Set(
                            entries
                                .map(
                                    (entry) =>
                                        entry.provider
                                )
                                .filter(Boolean)
                        )
                    ];

                    return {
                        synonym,
                        acceptedNames,
                        providers,
                        entries,
                        explicitlyAmbiguous:
                            entries.some(
                                (entry) =>
                                    entry.ambiguous ===
                                    true
                            )
                    };
                }
            )
            .filter(
                (group) =>
                    group.acceptedNames.length >
                        1 ||
                    group.explicitlyAmbiguous
            )
            .sort(
                (left, right) => {
                    const difference =
                        right.entries.length -
                        left.entries.length;

                    if (difference !== 0) {
                        return difference;
                    }

                    return left.synonym
                        .localeCompare(
                            right.synonym
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
                        : Array.isArray(payload.synonyms)
                            ? payload.synonyms
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

    class SynonymsService extends EventTarget {
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
                    "Synonyms service has been destroyed."
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
                    `synonyms:${name}`,
                    detail
                );
            } catch (_error) {
                /*
                Observer failures must not break synonym requests.
                */
            }

            dispatch(
                this.context.root ||
                    document,
                `speciedex:terminal-synonyms-${name}`,
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

        async resolve(name, parameters = {}, options = {}) {
            const normalizedName =
                normalizeText(name);

            if (!normalizedName) {
                throw new TypeError(
                    "A synonym or taxon name is required."
                );
            }

            const source =
                isObject(parameters)
                    ? parameters
                    : {};

            const result =
                await this.list(
                    {
                        ...source,
                        synonym:
                            normalizedName,
                        q:
                            source.q ??
                            normalizedName
                    },
                    options
                );

            const acceptedNames = [
                ...new Set(
                    result.records
                        .map(
                            (record) =>
                                record.accepted_name
                        )
                        .filter(Boolean)
                )
            ];

            return {
                query:
                    normalizedName,
                matches:
                    result.records,
                acceptedNames,
                ambiguous:
                    acceptedNames.length >
                        1 ||
                    result.records.some(
                        (record) =>
                            record.ambiguous ===
                            true
                    ),
                ambiguities:
                    findAmbiguities(
                        result.records
                    ),
                parameters:
                    result.parameters,
                duration:
                    result.duration
            };
        }

        async forAcceptedName(
            acceptedName,
            parameters = {},
            options = {}
        ) {
            const normalizedName =
                normalizeText(
                    acceptedName
                );

            if (!normalizedName) {
                throw new TypeError(
                    "An accepted taxon name is required."
                );
            }

            return this.list(
                {
                    ...parameters,
                    accepted_name:
                        normalizedName
                },
                options
            );
        }

        async ambiguities(parameters = {}, options = {}) {
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

            const ambiguities =
                findAmbiguities(
                    result.records
                );

            return {
                endpoint:
                    ENDPOINT,
                parameters:
                    result.parameters,
                ambiguities,
                total:
                    ambiguities.length,
                summary:
                    result.summary,
                duration:
                    result.duration
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
                byAcceptedName:
                    groupBy(
                        result.records,
                        "accepted_name"
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
                this.context.synonyms ===
                this
            ) {
                delete this.context.synonyms;
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
                "speciedex:terminal-synonyms-destroy",
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
            context?.synonyms,
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
                    SynonymsService &&
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
            context.synonyms =
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
            new SynonymsService(
                context
            );

        context.synonyms =
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
            "speciedex:terminal-synonyms-ready",
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
            "--accepted": "accepted_name",
            "--accepted-name": "accepted_name",
            "--synonym": "synonym",
            "--provider": "provider",
            "--rank": "rank",
            "--status": "status",
            "--authority": "authority",
            "--dataset": "dataset",
            "--release": "release",
            "--taxon-id": "taxon_id",
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
                            `Unsupported synonyms option: ${key}`
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
                        `Unsupported synonyms option: ${argument}`
                    );
                }

                const next =
                    tokens[index + 1];

                if (
                    next === undefined ||
                    next.startsWith("--")
                ) {
                    throw new TypeError(
                        `Missing value for synonyms option: ${argument}`
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
                "synonyms",
            aliases: Object.freeze([
                "synonym-list"
            ]),
            category:
                "archive",
            description:
                "Search archived taxonomic synonyms.",
            usage:
                "synonyms [query] [limit] [--accepted NAME] [--synonym NAME] [--provider NAME] [--rank RANK] [--status STATUS] [--authority NAME] [--dataset NAME] [--release ID] [--taxon-id ID] [--from DATE] [--to DATE] [--sort FIELD] [--direction asc|desc] [--offset N]",
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
                "synonym-resolve",
            aliases: Object.freeze([
                "resolve-synonym"
            ]),
            category:
                "archive",
            description:
                "Resolve a synonym to one or more accepted names.",
            usage:
                "synonym-resolve <name>",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) => {
                const name =
                    tokenizeArguments(args)
                        .join(" ")
                        .trim();

                if (!name) {
                    throw new Error(
                        "A synonym or taxon name is required."
                    );
                }

                const result =
                    await requireService(
                        context
                    ).resolve(
                        name,
                        {},
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
                "synonym-ambiguities",
            aliases: Object.freeze([
                "ambiguous-synonyms"
            ]),
            category:
                "archive",
            description:
                "Display synonyms mapping to multiple accepted names.",
            usage:
                "synonym-ambiguities [filters]",
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
                    ).ambiguities(
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
                "synonyms-summary",
            category:
                "archive",
            description:
                "Summarize synonyms by provider, accepted name, and rank.",
            usage:
                "synonyms-summary [filters]",
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
                "synonyms-status",
            category:
                "archive",
            description:
                "Show synonym-service status.",
            usage:
                "synonyms-status",
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
        SynonymsService,
        normalizeParameters,
        normalizeRecord,
        normalizeResponse,
        normalizeBoolean,
        summarize,
        groupBy,
        findAmbiguities,
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

    window.SpeciedexTerminalSynonyms =
        api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules || {};

    window.SpeciedexTerminalModules[
        MODULE_NAME
    ] = api;

    dispatch(
        document,
        "speciedex:terminal-module-available",
        {
            name:
                MODULE_NAME,
            module:
                api
        }
    );
})(window, document);
