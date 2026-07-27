/*
========================================================================
Speciedex.org
Terminal LastUpdated Module
========================================================================

Archive and provider freshness service for SpeciedexTerminal.

Provides:

    • Validated last-updated API requests
    • Provider, archive, status, date, and staleness filters
    • Normalized timestamps and freshness calculations
    • Summary helpers for newest, oldest, and stale records
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

    const MODULE_NAME = "last-updated";
    const LEGACY_MODULE_NAME = "LastUpdated";
    const VERSION = "2.1.0";

    const ENDPOINT = "archive/last-updated";
    const SERVICE_NAME = "last-updated";
    const SERVICE_ALIAS = "lastUpdated";

    const DEFAULT_LIMIT = 50;
    const MIN_LIMIT = 1;
    const MAX_LIMIT = 1000;
    const DEFAULT_STALE_AFTER_HOURS = 24;
    const MAX_STALE_AFTER_HOURS = 24 * 365 * 10;

    const SORT_FIELDS = Object.freeze([
        "updated_at",
        "provider",
        "archive",
        "status",
        "age",
        "records"
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

    function normalizeDate(value, allowEmpty = true) {
        const text =
            normalizeText(value);

        if (!text && allowEmpty) {
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
                value || "updated_at"
            ).toLowerCase();

        if (!SORT_FIELD_SET.has(normalized)) {
            throw new TypeError(
                `Unsupported last-updated sort field: ${value}`
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
                "archive",
                "status",
                "scope",
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
                normalizeDate(
                    from,
                    false
                );
        }

        if (
            to !== undefined &&
            to !== null &&
            to !== ""
        ) {
            normalized.to =
                normalizeDate(
                    to,
                    false
                );
        }

        if (
            normalized.from &&
            normalized.to &&
            Date.parse(normalized.from) >
                Date.parse(normalized.to)
        ) {
            throw new RangeError(
                "Last-updated start date must not be later than the end date."
            );
        }

        const staleAfter =
            source.staleAfterHours ??
            source.stale_after_hours ??
            source.stale;

        if (
            staleAfter !== undefined &&
            staleAfter !== null &&
            staleAfter !== ""
        ) {
            normalized.stale_after_hours =
                clampInteger(
                    staleAfter,
                    DEFAULT_STALE_AFTER_HOURS,
                    1,
                    MAX_STALE_AFTER_HOURS
                );
        }

        return normalized;
    }

    function extractTimestamp(record) {
        if (!isObject(record)) {
            return "";
        }

        const value =
            record.updated_at ??
            record.updatedAt ??
            record.last_updated ??
            record.lastUpdated ??
            record.timestamp ??
            record.modified_at ??
            record.modifiedAt ??
            record.published_at ??
            record.publishedAt ??
            "";

        return value
            ? normalizeDate(
                value,
                false
            )
            : "";
    }

    function calculateAge(timestamp, referenceNow = Date.now()) {
        const parsed =
            Date.parse(timestamp);

        if (!Number.isFinite(parsed)) {
            return {
                milliseconds: null,
                seconds: null,
                minutes: null,
                hours: null,
                days: null
            };
        }

        const numericNow =
            Number(referenceNow);

        const effectiveNow =
            Number.isFinite(numericNow)
                ? numericNow
                : Date.now();

        const milliseconds =
            Math.max(
                0,
                effectiveNow - parsed
            );

        return {
            milliseconds,
            seconds:
                milliseconds / 1000,
            minutes:
                milliseconds / 60000,
            hours:
                milliseconds / 3600000,
            days:
                milliseconds / 86400000
        };
    }

    function normalizeRecord(
        record,
        index = 0,
        options = {}
    ) {
        if (!isObject(record)) {
            return {
                index,
                value: record,
                updated_at: "",
                age:
                    calculateAge(""),
                stale: null
            };
        }

        const updatedAt =
            extractTimestamp(record);

        const referenceNow =
            Number.isFinite(
                Number(options.now)
            )
                ? Number(options.now)
                : Date.now();

        const age =
            calculateAge(
                updatedAt,
                referenceNow
            );

        const staleAfterHours =
            Number.isFinite(
                Number(
                    options.staleAfterHours
                )
            )
                ? Number(
                    options.staleAfterHours
                )
                : DEFAULT_STALE_AFTER_HOURS;

        return {
            ...record,
            index:
                record.index ??
                index,
            updated_at:
                updatedAt,
            age,
            stale:
                Number.isFinite(
                    age.hours
                )
                    ? age.hours >
                        staleAfterHours
                    : null
        };
    }

    function normalizeResponse(payload, options = {}) {
        const parameters =
            isObject(options.parameters)
                ? options.parameters
                : {};

        const normalizeValues =
            (values) =>
                values.map(
                    (record, index) =>
                        normalizeRecord(
                            record,
                            index,
                            options
                        )
                );

        if (Array.isArray(payload)) {
            const records =
                normalizeValues(payload);

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
                        : Array.isArray(
                            payload.last_updated
                        )
                            ? payload.last_updated
                            : Array.isArray(
                                payload.timestamps
                            )
                                ? payload.timestamps
                                : Array.isArray(
                                    payload.data
                                )
                                    ? payload.data
                                    : [];

            const records =
                normalizeValues(values);

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
            next: null,
            previous: null,
            parameters,
            raw: payload
        };
    }

    function summarize(records) {
        const values =
            Array.isArray(records)
                ? records
                : [];

        const withTimestamps =
            values.filter(
                (record) =>
                    Number.isFinite(
                        Date.parse(
                            record?.updated_at
                        )
                    )
            );

        const sorted =
            [...withTimestamps].sort(
                (left, right) =>
                    Date.parse(
                        left.updated_at
                    ) -
                    Date.parse(
                        right.updated_at
                    )
            );

        return {
            total:
                values.length,
            timestamped:
                withTimestamps.length,
            stale:
                values.filter(
                    (record) =>
                        record?.stale === true
                ).length,
            fresh:
                values.filter(
                    (record) =>
                        record?.stale === false
                ).length,
            unknown:
                values.filter(
                    (record) =>
                        record?.stale === null ||
                        record?.stale === undefined
                ).length,
            oldest:
                sorted[0] ||
                null,
            newest:
                sorted[
                    sorted.length - 1
                ] ||
                null
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

    class LastUpdatedService extends EventTarget {
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
                    "Last-updated service has been destroyed."
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
                    `last-updated:${name}`,
                    detail
                );
            } catch (_error) {
                /*
                Observer failures must not break freshness requests.
                */
            }

            dispatch(
                this.context.root ||
                    document,
                `speciedex:terminal-last-updated-${name}`,
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

            const staleAfterHours =
                normalized.stale_after_hours ??
                DEFAULT_STALE_AFTER_HOURS;

            const requestOptions =
                isObject(options)
                    ? options
                    : {};

            const startedAt =
                now();

            const referenceNow =
                Date.now();

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
                        {
                            staleAfterHours,
                            now:
                                referenceNow,
                            parameters:
                                normalized
                        }
                    );

                result.endpoint =
                    ENDPOINT;

                result.summary =
                    summarize(
                        result.records
                    );

                result.duration =
                    now() -
                    startedAt;

                this.emit(
                    "complete",
                    result
                );

                return result;
            } catch (error) {
                const detail = {
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
                };

                this.emit(
                    "error",
                    detail
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

        async latest(limit = 10, options = {}) {
            return this.list(
                {
                    limit,
                    sort:
                        "updated_at",
                    direction:
                        "desc"
                },
                options
            );
        }

        async stale(
            staleAfterHours =
                DEFAULT_STALE_AFTER_HOURS,
            parameters = {},
            options = {}
        ) {
            const normalizedThreshold =
                clampInteger(
                    staleAfterHours,
                    DEFAULT_STALE_AFTER_HOURS,
                    1,
                    MAX_STALE_AFTER_HOURS
                );

            const result =
                await this.list(
                    {
                        ...parameters,
                        stale_after_hours:
                            normalizedThreshold
                    },
                    options
                );

            const staleRecords =
                result.records.filter(
                    (record) =>
                        record.stale === true
                );

            return {
                ...result,
                records:
                    staleRecords,
                total:
                    staleRecords.length,
                summary:
                    summarize(
                        staleRecords
                    )
            };
        }

        async byProvider(
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
                defaultStaleAfterHours:
                    DEFAULT_STALE_AFTER_HOURS,
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
                this.context.lastUpdated ===
                this
            ) {
                delete this.context.lastUpdated;
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
                "speciedex:terminal-last-updated-destroy",
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
            context?.lastUpdated,
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
                    LastUpdatedService &&
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
            context.lastUpdated =
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
            new LastUpdatedService(
                context
            );

        context.lastUpdated =
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
            "speciedex:terminal-last-updated-ready",
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
            "--archive": "archive",
            "--status": "status",
            "--scope": "scope",
            "--type": "type",
            "--from": "from",
            "--to": "to",
            "--stale": "stale_after_hours",
            "--stale-after-hours":
                "stale_after_hours",
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
                            `Unsupported last-updated option: ${key}`
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
                        `Unsupported last-updated option: ${argument}`
                    );
                }

                const next =
                    tokens[index + 1];

                if (
                    next === undefined ||
                    next.startsWith("--")
                ) {
                    throw new TypeError(
                        `Missing value for last-updated option: ${argument}`
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
                "last-updated",
            aliases: Object.freeze([
                "updated",
                "freshness"
            ]),
            category:
                "archive",
            description:
                "Display archive and provider update timestamps.",
            usage:
                "last-updated [query] [limit] [--provider NAME] [--archive NAME] [--status STATUS] [--scope SCOPE] [--type TYPE] [--from DATE] [--to DATE] [--stale HOURS] [--sort FIELD] [--direction asc|desc] [--offset N]",
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
                "last-updated-latest",
            aliases: Object.freeze([
                "freshest"
            ]),
            category:
                "archive",
            description:
                "Display the most recently updated archive and provider records.",
            usage:
                "last-updated-latest [limit]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) => {
                const tokens =
                    tokenizeArguments(args);

                const result =
                    await requireService(
                        context
                    ).latest(
                        tokens[0] ||
                        10,
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
                "last-updated-stale",
            aliases: Object.freeze([
                "stale"
            ]),
            category:
                "archive",
            description:
                "Display records older than a freshness threshold.",
            usage:
                "last-updated-stale [hours] [limit]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) => {
                const tokens =
                    tokenizeArguments(args);

                const result =
                    await requireService(
                        context
                    ).stale(
                        tokens[0] ||
                        DEFAULT_STALE_AFTER_HOURS,
                        {
                            limit:
                                tokens[1] ||
                                DEFAULT_LIMIT
                        },
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
                "last-updated-status",
            category:
                "archive",
            description:
                "Show last-updated service status.",
            usage:
                "last-updated-status",
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
        defaultStaleAfterHours:
            DEFAULT_STALE_AFTER_HOURS,
        LastUpdatedService,
        normalizeParameters,
        normalizeRecord,
        normalizeResponse,
        extractTimestamp,
        calculateAge,
        summarize,
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

    window.SpeciedexTerminalLastUpdated =
        api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules || {};

    window.SpeciedexTerminalModules[
        MODULE_NAME
    ] = api;

    /*
    --------------------------------------------------------------------
    Historical loader bridge. Canonical registration remains
    "last-updated".
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
