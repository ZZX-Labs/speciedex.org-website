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

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "LastUpdated";
    const VERSION = "2.0.0";
    const SERVICE_NAME = "last-updated";

    const DEFAULT_LIMIT = 50;
    const MIN_LIMIT = 1;
    const MAX_LIMIT = 1000;
    const DEFAULT_STALE_AFTER_HOURS = 24;

    function dispatch(target, name, detail, options = {}) {
        if (
            !target ||
            typeof target.dispatchEvent !== "function"
        ) {
            return false;
        }

        try {
            return target.dispatchEvent(
                new CustomEvent(
                    name,
                    {
                        bubbles:
                            options.bubbles === true,
                        cancelable:
                            options.cancelable === true,
                        detail
                    }
                )
            );
        } catch (_error) {
            return false;
        }
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

    function normalizeText(value) {
        return String(value ?? "")
            .trim();
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

        return new Date(timestamp).toISOString();
    }

    function normalizeSort(value) {
        const normalized =
            normalizeText(
                value || "updated_at"
            ).toLowerCase();

        const allowed = new Set([
            "updated_at",
            "provider",
            "archive",
            "status",
            "age",
            "records"
        ]);

        if (!allowed.has(normalized)) {
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
            parameters &&
            typeof parameters === "object"
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
            const key of
            [
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
                    24 * 365 * 10
                );
        }

        return normalized;
    }

    function extractTimestamp(record) {
        if (
            !record ||
            typeof record !== "object"
        ) {
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
            "";

        return value
            ? normalizeDate(
                value,
                false
            )
            : "";
    }

    function calculateAge(timestamp, now = Date.now()) {
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

        const milliseconds =
            Math.max(
                0,
                Number(now) - parsed
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
        if (
            !record ||
            typeof record !== "object"
        ) {
            return {
                index,
                value: record,
                updated_at: "",
                age: calculateAge("")
            };
        }

        const updatedAt =
            extractTimestamp(record);

        const age =
            calculateAge(
                updatedAt,
                options.now
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
        if (Array.isArray(payload)) {
            const records =
                payload.map(
                    (record, index) =>
                        normalizeRecord(
                            record,
                            index,
                            options
                        )
                );

            return {
                records,
                total:
                    records.length,
                limit:
                    records.length,
                offset: 0,
                raw: payload
            };
        }

        if (
            payload &&
            typeof payload === "object"
        ) {
            const values =
                Array.isArray(payload.records)
                    ? payload.records
                    : (
                        Array.isArray(payload.items)
                            ? payload.items
                            : (
                                Array.isArray(
                                    payload.last_updated
                                )
                                    ? payload.last_updated
                                    : (
                                        Array.isArray(
                                            payload.timestamps
                                        )
                                            ? payload.timestamps
                                            : []
                                    )
                            )
                    );

            const records =
                values.map(
                    (record, index) =>
                        normalizeRecord(
                            record,
                            index,
                            options
                        )
                );

            return {
                records,
                total:
                    Number.isFinite(
                        Number(payload.total)
                    )
                        ? Number(payload.total)
                        : records.length,
                limit:
                    Number.isFinite(
                        Number(payload.limit)
                    )
                        ? Number(payload.limit)
                        : records.length,
                offset:
                    Number.isFinite(
                        Number(payload.offset)
                    )
                        ? Number(payload.offset)
                        : 0,
                next:
                    payload.next ??
                    payload.nextPage ??
                    null,
                previous:
                    payload.previous ??
                    payload.previousPage ??
                    null,
                raw: payload
            };
        }

        return {
            records: [],
            total: 0,
            limit: 0,
            offset: 0,
            raw: payload
        };
    }

    function summarize(records) {
        const values =
            Array.isArray(records)
                ? records
                : [];

        const withTimestamps =
            values.filter(record =>
                Number.isFinite(
                    Date.parse(
                        record.updated_at
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
                    record =>
                        record.stale === true
                ).length,
            fresh:
                values.filter(
                    record =>
                        record.stale === false
                ).length,
            unknown:
                values.filter(
                    record =>
                        record.stale === null
                ).length,
            oldest:
                sorted[0] || null,
            newest:
                sorted[
                    sorted.length - 1
                ] || null
        };
    }

    class LastUpdatedService extends EventTarget {
        constructor(context) {
            super();

            if (!context || typeof context !== "object") {
                throw new TypeError(
                    "A terminal context is required."
                );
            }

            this.context = context;
            this.destroyed = false;
        }

        ensureAvailable() {
            if (this.destroyed) {
                throw new Error(
                    "Last-updated service has been destroyed."
                );
            }

            if (
                !this.context.api ||
                typeof this.context.api.get !==
                "function"
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
                ----------------------------------------------------------------
                Observer failures must not break freshness requests.
                ----------------------------------------------------------------
                */
            }

            dispatch(
                this.context.root,
                `speciedex:terminal-last-updated-${name}`,
                detail,
                {
                    bubbles: true
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

            const startedAt =
                performance.now();

            this.emit(
                "request",
                {
                    parameters:
                        normalized
                }
            );

            try {
                const payload =
                    await this.context.api.get(
                        "archive/last-updated",
                        normalized,
                        options
                    );

                const result =
                    normalizeResponse(
                        payload,
                        {
                            staleAfterHours
                        }
                    );

                result.parameters =
                    normalized;

                result.summary =
                    summarize(
                        result.records
                    );

                result.duration =
                    performance.now() -
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
                        parameters:
                            normalized,
                        duration:
                            performance.now() -
                            startedAt
                    }
                );

                throw error;
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
            const result =
                await this.list(
                    {
                        ...parameters,
                        stale_after_hours:
                            staleAfterHours
                    },
                    options
                );

            return {
                ...result,
                records:
                    result.records.filter(
                        record =>
                            record.stale === true
                    ),
                summary:
                    summarize(
                        result.records.filter(
                            record =>
                                record.stale === true
                        )
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
            return {
                version: VERSION,
                endpoint:
                    "archive/last-updated",
                service:
                    SERVICE_NAME,
                defaultStaleAfterHours:
                    DEFAULT_STALE_AFTER_HOURS,
                available:
                    Boolean(
                        this.context.api &&
                        typeof this.context.api.get ===
                        "function"
                    ),
                destroyed:
                    this.destroyed
            };
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            this.destroyed = true;

            dispatch(
                this,
                "destroy",
                {
                    timestamp:
                        new Date().toISOString()
                }
            );

            return true;
        }
    }

    function initialize(context) {
        const existing =
            context.services?.get?.(
                SERVICE_NAME
            );

        if (
            existing instanceof
            LastUpdatedService &&
            !existing.destroyed
        ) {
            context.lastUpdated =
                existing;

            return existing;
        }

        if (
            context.lastUpdated instanceof
            LastUpdatedService &&
            !context.lastUpdated.destroyed
        ) {
            return context.lastUpdated;
        }

        const service =
            new LastUpdatedService(
                context
            );

        context.lastUpdated =
            service;

        context.registerService?.(
            SERVICE_NAME,
            service
        );

        context.registerService?.(
            "lastUpdated",
            service
        );

        dispatch(
            document,
            "speciedex:terminal-last-updated-ready",
            {
                context,
                service
            }
        );

        return service;
    }

    function requireService(context) {
        const service =
            context?.lastUpdated ||
            context?.services?.get?.(
                SERVICE_NAME
            );

        if (
            !(
                service instanceof
                LastUpdatedService
            )
        ) {
            throw new Error(
                "Last-updated service is unavailable."
            );
        }

        return service;
    }

    function parseCommandArguments(args = []) {
        const parameters = {};
        const positional = [];

        for (const argument of args) {
            if (
                argument.startsWith(
                    "--limit="
                )
            ) {
                parameters.limit =
                    argument.slice(8);
                continue;
            }

            if (
                argument.startsWith(
                    "--offset="
                )
            ) {
                parameters.offset =
                    argument.slice(9);
                continue;
            }

            if (
                argument.startsWith(
                    "--provider="
                )
            ) {
                parameters.provider =
                    argument.slice(11);
                continue;
            }

            if (
                argument.startsWith(
                    "--archive="
                )
            ) {
                parameters.archive =
                    argument.slice(10);
                continue;
            }

            if (
                argument.startsWith(
                    "--status="
                )
            ) {
                parameters.status =
                    argument.slice(9);
                continue;
            }

            if (
                argument.startsWith(
                    "--scope="
                )
            ) {
                parameters.scope =
                    argument.slice(8);
                continue;
            }

            if (
                argument.startsWith(
                    "--type="
                )
            ) {
                parameters.type =
                    argument.slice(7);
                continue;
            }

            if (
                argument.startsWith(
                    "--from="
                )
            ) {
                parameters.from =
                    argument.slice(7);
                continue;
            }

            if (
                argument.startsWith(
                    "--to="
                )
            ) {
                parameters.to =
                    argument.slice(5);
                continue;
            }

            if (
                argument.startsWith(
                    "--stale="
                )
            ) {
                parameters.stale_after_hours =
                    argument.slice(8);
                continue;
            }

            if (
                argument.startsWith(
                    "--sort="
                )
            ) {
                parameters.sort =
                    argument.slice(7);
                continue;
            }

            if (
                argument.startsWith(
                    "--direction="
                )
            ) {
                parameters.direction =
                    argument.slice(12);
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

    const commands = [
        {
            name: "last-updated",
            aliases: [
                "updated",
                "freshness"
            ],
            category: "archive",
            description:
                "Display archive and provider update timestamps.",
            usage:
                "last-updated [query] [limit] [--provider=NAME] [--archive=NAME] [--status=STATUS] [--scope=SCOPE] [--type=TYPE] [--from=DATE] [--to=DATE] [--stale=HOURS] [--sort=FIELD] [--direction=asc|desc] [--offset=N]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                const parameters =
                    parseCommandArguments(
                        args
                    );

                const result =
                    await requireService(
                        context
                    ).list(
                        parameters
                    );

                return writeJSONValue(
                    writeJSON,
                    result
                );
            }
        },
        {
            name: "last-updated-latest",
            aliases: [
                "freshest"
            ],
            category: "archive",
            description:
                "Display the most recently updated archive and provider records.",
            usage:
                "last-updated-latest [limit]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).latest(
                        args[0] || 10
                    )
                )
        },
        {
            name: "last-updated-stale",
            aliases: [
                "stale"
            ],
            category: "archive",
            description:
                "Display records older than a freshness threshold.",
            usage:
                "last-updated-stale [hours] [limit]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).stale(
                        args[0] ||
                        DEFAULT_STALE_AFTER_HOURS,
                        {
                            limit:
                                args[1] ||
                                DEFAULT_LIMIT
                        }
                    )
                )
        },
        {
            name: "last-updated-status",
            category: "archive",
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
        }
    ];

    const api = Object.freeze({
        name: MODULE_NAME,
        version: VERSION,
        serviceName:
            SERVICE_NAME,
        LastUpdatedService,
        normalizeParameters,
        normalizeRecord,
        normalizeResponse,
        extractTimestamp,
        calculateAge,
        summarize,
        parseCommandArguments,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalLastUpdated =
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
            name: MODULE_NAME,
            module: api
        }
    );
})(window, document);
