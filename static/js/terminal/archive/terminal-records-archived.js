/*
========================================================================
Speciedex.org
Terminal RecordsArchived Module
========================================================================

Canonical archive-record totals service for SpeciedexTerminal.

Provides:

    • Validated archived-record API requests
    • Provider, archive, rank, status, date, and pagination filters
    • Normalized totals and aggregate summaries
    • Grouping by provider, archive, rank, status, or date
    • Lifecycle events and service registration
    • Terminal command integration

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "RecordsArchived";
    const VERSION = "2.0.0";
    const SERVICE_NAME = "records-archived";

    const DEFAULT_LIMIT = 50;
    const MIN_LIMIT = 1;
    const MAX_LIMIT = 1000;

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

        return new Date(timestamp).toISOString();
    }

    function normalizeSort(value) {
        const normalized =
            normalizeText(
                value || "records"
            ).toLowerCase();

        const allowed = new Set([
            "records",
            "created_at",
            "updated_at",
            "provider",
            "archive",
            "rank",
            "status",
            "date"
        ]);

        if (!allowed.has(normalized)) {
            throw new TypeError(
                `Unsupported archived-record sort field: ${value}`
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

    function normalizeGroup(value) {
        const normalized =
            normalizeText(
                value || ""
            ).toLowerCase();

        if (!normalized) {
            return "";
        }

        const allowed = new Set([
            "provider",
            "archive",
            "rank",
            "status",
            "date",
            "release",
            "volume"
        ]);

        if (!allowed.has(normalized)) {
            throw new TypeError(
                `Unsupported archived-record group: ${value}`
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
                "rank",
                "status",
                "release",
                "volume",
                "dataset",
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

        const group =
            source.group ??
            source.groupBy ??
            source.group_by;

        if (
            group !== undefined &&
            group !== null &&
            group !== ""
        ) {
            normalized.group =
                normalizeGroup(group);
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
                "Archived-record start date must not be later than the end date."
            );
        }

        return normalized;
    }

    function numericValue(value, fallback = 0) {
        const number =
            Number(value);

        return Number.isFinite(number)
            ? number
            : fallback;
    }

    function extractRecordCount(record) {
        if (
            !record ||
            typeof record !== "object"
        ) {
            return numericValue(record);
        }

        return numericValue(
            record.records ??
            record.record_count ??
            record.recordCount ??
            record.count ??
            record.total ??
            0
        );
    }

    function normalizeRecord(record, index = 0) {
        if (
            !record ||
            typeof record !== "object"
        ) {
            return {
                index,
                records:
                    extractRecordCount(
                        record
                    ),
                value: record
            };
        }

        return {
            ...record,
            index:
                record.index ??
                index,
            provider:
                normalizeText(
                    record.provider ??
                    record.source ??
                    ""
                ),
            archive:
                normalizeText(
                    record.archive ??
                    record.collection ??
                    ""
                ),
            rank:
                normalizeText(
                    record.rank ??
                    ""
                ),
            status:
                normalizeText(
                    record.status ??
                    ""
                ),
            release:
                normalizeText(
                    record.release ??
                    record.release_id ??
                    ""
                ),
            volume:
                normalizeText(
                    record.volume ??
                    record.volume_id ??
                    ""
                ),
            records:
                extractRecordCount(
                    record
                )
        };
    }

    function summarize(records) {
        const values =
            Array.isArray(records)
                ? records
                : [];

        const totals =
            values.map(
                record =>
                    numericValue(
                        record.records
                    )
            );

        const total =
            totals.reduce(
                (sum, value) =>
                    sum + value,
                0
            );

        return {
            groups:
                values.length,
            records:
                total,
            minimum:
                totals.length
                    ? Math.min(
                        ...totals
                    )
                    : 0,
            maximum:
                totals.length
                    ? Math.max(
                        ...totals
                    )
                    : 0,
            average:
                totals.length
                    ? total /
                      totals.length
                    : 0
        };
    }

    function groupRecords(records, key) {
        const normalizedKey =
            normalizeGroup(key);

        if (!normalizedKey) {
            return [];
        }

        const groups = new Map();

        for (const record of records) {
            const value =
                normalizeText(
                    record[
                        normalizedKey
                    ] ?? "unknown"
                ) || "unknown";

            const current =
                groups.get(value) || {
                    key: value,
                    group:
                        normalizedKey,
                    records: 0,
                    rows: 0
                };

            current.records +=
                numericValue(
                    record.records
                );

            current.rows += 1;

            groups.set(
                value,
                current
            );
        }

        return [
            ...groups.values()
        ].sort(
            (left, right) =>
                right.records -
                left.records
        );
    }

    function normalizeResponse(payload) {
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
                    records.length,
                offset: 0,
                summary:
                    summarize(records),
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
                                    payload.archived
                                )
                                    ? payload.archived
                                    : []
                            )
                    );

            const records =
                values.map(
                    normalizeRecord
                );

            const summary =
                payload.summary &&
                typeof payload.summary === "object"
                    ? {
                        ...summarize(records),
                        ...payload.summary
                    }
                    : summarize(records);

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
                summary,
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
            summary:
                summarize([]),
            raw: payload
        };
    }

    class RecordsArchivedService extends EventTarget {
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
                    "Records-archived service has been destroyed."
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
                    `records-archived:${name}`,
                    detail
                );
            } catch (_error) {
                /*
                ----------------------------------------------------------------
                Observer failures must not break archived-record requests.
                ----------------------------------------------------------------
                */
            }

            dispatch(
                this.context.root,
                `speciedex:terminal-records-archived-${name}`,
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
                        "archive/records",
                        normalized,
                        options
                    );

                const result =
                    normalizeResponse(
                        payload
                    );

                result.parameters =
                    normalized;

                result.duration =
                    performance.now() -
                    startedAt;

                if (
                    normalized.group &&
                    !result.records.every(
                        record =>
                            record.group ===
                            normalized.group
                    )
                ) {
                    result.grouped =
                        groupRecords(
                            result.records,
                            normalized.group
                        );
                }

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

        async totals(parameters = {}, options = {}) {
            const result =
                await this.list(
                    {
                        ...parameters,
                        limit:
                            parameters.limit ??
                            MAX_LIMIT
                    },
                    options
                );

            return {
                parameters:
                    result.parameters,
                summary:
                    result.summary,
                grouped:
                    parameters.group
                        ? (
                            result.grouped ||
                            groupRecords(
                                result.records,
                                parameters.group
                            )
                        )
                        : null
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

        async byRank(
            rank,
            parameters = {},
            options = {}
        ) {
            const normalizedRank =
                normalizeText(rank);

            if (!normalizedRank) {
                throw new TypeError(
                    "A taxonomic rank is required."
                );
            }

            return this.list(
                {
                    ...parameters,
                    rank:
                        normalizedRank
                },
                options
            );
        }

        status() {
            return {
                version: VERSION,
                endpoint:
                    "archive/records",
                service:
                    SERVICE_NAME,
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
            RecordsArchivedService &&
            !existing.destroyed
        ) {
            context.recordsArchived =
                existing;

            return existing;
        }

        if (
            context.recordsArchived instanceof
            RecordsArchivedService &&
            !context.recordsArchived.destroyed
        ) {
            return context.recordsArchived;
        }

        const service =
            new RecordsArchivedService(
                context
            );

        context.recordsArchived =
            service;

        context.registerService?.(
            SERVICE_NAME,
            service
        );

        context.registerService?.(
            "recordsArchived",
            service
        );

        dispatch(
            document,
            "speciedex:terminal-records-archived-ready",
            {
                context,
                service
            }
        );

        return service;
    }

    function requireService(context) {
        const service =
            context?.recordsArchived ||
            context?.services?.get?.(
                SERVICE_NAME
            );

        if (
            !(
                service instanceof
                RecordsArchivedService
            )
        ) {
            throw new Error(
                "Records-archived service is unavailable."
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
                    "--rank="
                )
            ) {
                parameters.rank =
                    argument.slice(7);
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
                    "--release="
                )
            ) {
                parameters.release =
                    argument.slice(10);
                continue;
            }

            if (
                argument.startsWith(
                    "--volume="
                )
            ) {
                parameters.volume =
                    argument.slice(9);
                continue;
            }

            if (
                argument.startsWith(
                    "--dataset="
                )
            ) {
                parameters.dataset =
                    argument.slice(10);
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
                    "--group="
                )
            ) {
                parameters.group =
                    argument.slice(8);
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
            name: "records-archived",
            aliases: [
                "archive-records"
            ],
            category: "archive",
            description:
                "Display canonical archived record totals.",
            usage:
                "records-archived [query] [limit] [--provider=NAME] [--archive=NAME] [--rank=RANK] [--status=STATUS] [--release=ID] [--volume=ID] [--dataset=NAME] [--type=TYPE] [--group=provider|archive|rank|status|date|release|volume] [--from=DATE] [--to=DATE] [--sort=FIELD] [--direction=asc|desc] [--offset=N]",
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
            name: "records-archived-totals",
            aliases: [
                "archive-record-totals"
            ],
            category: "archive",
            description:
                "Display aggregate archived-record totals.",
            usage:
                "records-archived-totals [--group=provider|archive|rank|status|date|release|volume] [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                const parameters =
                    parseCommandArguments(
                        args
                    );

                return writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).totals(
                        parameters
                    )
                );
            }
        },
        {
            name: "records-archived-status",
            category: "archive",
            description:
                "Show archived-record service status.",
            usage:
                "records-archived-status",
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
        RecordsArchivedService,
        normalizeParameters,
        normalizeRecord,
        normalizeResponse,
        extractRecordCount,
        summarize,
        groupRecords,
        parseCommandArguments,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalRecordsArchived =
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
