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

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Synonyms";
    const VERSION = "2.0.0";
    const SERVICE_NAME = "synonyms";

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
                value || "synonym"
            ).toLowerCase();

        const allowed = new Set([
            "synonym",
            "accepted_name",
            "provider",
            "rank",
            "status",
            "created_at",
            "updated_at",
            "authority"
        ]);

        if (!allowed.has(normalized)) {
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
            const [
                key,
                value
            ] of Object.entries(
                aliases
            )
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

    function normalizeRecord(record, index = 0) {
        if (
            !record ||
            typeof record !== "object"
        ) {
            return {
                index,
                synonym:
                    normalizeText(record),
                accepted_name: ""
            };
        }

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
            status:
                normalizeText(
                    record.status ??
                    record.taxonomic_status ??
                    record.taxonomicStatus ??
                    ""
                ),
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
                    ""
                ),
            ambiguous:
                record.ambiguous === true ||
                record.conflict === true ||
                String(
                    record.status || ""
                ).toLowerCase() ===
                "ambiguous"
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
                        record =>
                            record.accepted_name
                    )
                    .filter(Boolean)
            );

        const providers =
            new Set(
                values
                    .map(
                        record =>
                            record.provider
                    )
                    .filter(Boolean)
            );

        const ranks =
            new Set(
                values
                    .map(
                        record =>
                            record.rank
                    )
                    .filter(Boolean)
            );

        const ambiguous =
            values.filter(
                record =>
                    record.ambiguous ===
                    true
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
        const groups = new Map();

        for (
            const record of
            Array.isArray(records)
                ? records
                : []
        ) {
            const value =
                normalizeText(
                    record[key] ??
                    "unknown"
                ) || "unknown";

            const current =
                groups.get(value) || {
                    key: value,
                    count: 0,
                    ambiguous: 0
                };

            current.count += 1;

            if (record.ambiguous === true) {
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
            (left, right) =>
                right.count -
                left.count
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
                    record.synonym
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
                ([
                    synonym,
                    entries
                ]) => ({
                    synonym,
                    acceptedNames: [
                        ...new Set(
                            entries
                                .map(
                                    entry =>
                                        entry.accepted_name
                                )
                                .filter(Boolean)
                        )
                    ],
                    providers: [
                        ...new Set(
                            entries
                                .map(
                                    entry =>
                                        entry.provider
                                )
                                .filter(Boolean)
                        )
                    ],
                    entries
                })
            )
            .filter(
                group =>
                    group.acceptedNames.length >
                    1
            )
            .sort(
                (left, right) =>
                    right.entries.length -
                    left.entries.length
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
                                Array.isArray(payload.synonyms)
                                    ? payload.synonyms
                                    : []
                            )
                    );

            const records =
                values.map(
                    normalizeRecord
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

    class SynonymsService extends EventTarget {
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
                    "Synonyms service has been destroyed."
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
                    `synonyms:${name}`,
                    detail
                );
            } catch (_error) {
                /*
                ----------------------------------------------------------------
                Observer failures must not break synonym requests.
                ----------------------------------------------------------------
                */
            }

            dispatch(
                this.context.root,
                `speciedex:terminal-synonyms-${name}`,
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
                        "archive/synonyms",
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

        async resolve(name, parameters = {}, options = {}) {
            const normalizedName =
                normalizeText(name);

            if (!normalizedName) {
                throw new TypeError(
                    "A synonym or taxon name is required."
                );
            }

            const result =
                await this.list(
                    {
                        ...parameters,
                        synonym:
                            normalizedName,
                        q:
                            parameters.q ??
                            normalizedName
                    },
                    options
                );

            return {
                query:
                    normalizedName,
                matches:
                    result.records,
                acceptedNames: [
                    ...new Set(
                        result.records
                            .map(
                                record =>
                                    record.accepted_name
                            )
                            .filter(Boolean)
                    )
                ],
                ambiguous:
                    findAmbiguities(
                        result.records
                    )
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
                ambiguities:
                    findAmbiguities(
                        result.records
                    ),
                summary:
                    result.summary
            };
        }

        async summary(parameters = {}, options = {}) {
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
                    )
            };
        }

        status() {
            return {
                version: VERSION,
                endpoint:
                    "archive/synonyms",
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
            SynonymsService &&
            !existing.destroyed
        ) {
            context.synonyms =
                existing;

            return existing;
        }

        if (
            context.synonyms instanceof
            SynonymsService &&
            !context.synonyms.destroyed
        ) {
            return context.synonyms;
        }

        const service =
            new SynonymsService(
                context
            );

        context.synonyms =
            service;

        context.registerService?.(
            SERVICE_NAME,
            service
        );

        context.registerService?.(
            "synonym",
            service
        );

        dispatch(
            document,
            "speciedex:terminal-synonyms-ready",
            {
                context,
                service
            }
        );

        return service;
    }

    function requireService(context) {
        const service =
            context?.synonyms ||
            context?.services?.get?.(
                SERVICE_NAME
            );

        if (
            !(
                service instanceof
                SynonymsService
            )
        ) {
            throw new Error(
                "Synonyms service is unavailable."
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
                    "--accepted="
                )
            ) {
                parameters.accepted_name =
                    argument.slice(11);
                continue;
            }

            if (
                argument.startsWith(
                    "--synonym="
                )
            ) {
                parameters.synonym =
                    argument.slice(10);
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
                    "--authority="
                )
            ) {
                parameters.authority =
                    argument.slice(12);
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
                    "--release="
                )
            ) {
                parameters.release =
                    argument.slice(10);
                continue;
            }

            if (
                argument.startsWith(
                    "--taxon-id="
                )
            ) {
                parameters.taxon_id =
                    argument.slice(11);
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
            name: "synonyms",
            aliases: [
                "synonym-list"
            ],
            category: "archive",
            description:
                "Search archived taxonomic synonyms.",
            usage:
                "synonyms [query] [limit] [--accepted=NAME] [--synonym=NAME] [--provider=NAME] [--rank=RANK] [--status=STATUS] [--authority=NAME] [--dataset=NAME] [--release=ID] [--taxon-id=ID] [--from=DATE] [--to=DATE] [--sort=FIELD] [--direction=asc|desc] [--offset=N]",
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
            name: "synonym-resolve",
            aliases: [
                "resolve-synonym"
            ],
            category: "archive",
            description:
                "Resolve a synonym to one or more accepted names.",
            usage:
                "synonym-resolve <name>",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                const name =
                    args.join(" ").trim();

                if (!name) {
                    throw new Error(
                        "A synonym or taxon name is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).resolve(name)
                );
            }
        },
        {
            name: "synonym-ambiguities",
            aliases: [
                "ambiguous-synonyms"
            ],
            category: "archive",
            description:
                "Display synonyms mapping to multiple accepted names.",
            usage:
                "synonym-ambiguities [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).ambiguities(
                        parseCommandArguments(
                            args
                        )
                    )
                )
        },
        {
            name: "synonyms-summary",
            category: "archive",
            description:
                "Summarize synonyms by provider, accepted name, and rank.",
            usage:
                "synonyms-summary [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).summary(
                        parseCommandArguments(
                            args
                        )
                    )
                )
        },
        {
            name: "synonyms-status",
            category: "archive",
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
        }
    ];

    const api = Object.freeze({
        name: MODULE_NAME,
        version: VERSION,
        serviceName:
            SERVICE_NAME,
        SynonymsService,
        normalizeParameters,
        normalizeRecord,
        normalizeResponse,
        summarize,
        groupBy,
        findAmbiguities,
        parseCommandArguments,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
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
            name: MODULE_NAME,
            module: api
        }
    );
})(window, document);
