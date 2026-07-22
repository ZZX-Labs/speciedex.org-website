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

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "UnresolvedConflicts";
    const VERSION = "2.0.0";
    const SERVICE_NAME = "unresolved-conflicts";

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

        const allowed = new Set([
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

        if (!allowed.has(normalized)) {
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

    function normalizeProviders(record) {
        const raw =
            record.providers ??
            record.sources ??
            record.provider_names ??
            [];

        if (Array.isArray(raw)) {
            return [
                ...new Set(
                    raw
                        .map(item => {
                            if (
                                item &&
                                typeof item === "object"
                            ) {
                                return normalizeText(
                                    item.name ??
                                    item.provider ??
                                    item.id
                                );
                            }

                            return normalizeText(item);
                        })
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
        const raw =
            record.values ??
            record.assertions ??
            record.options ??
            record.candidates ??
            [];

        if (Array.isArray(raw)) {
            return raw.map(item => {
                if (
                    item &&
                    typeof item === "object"
                ) {
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
                            Number.isFinite(
                                Number(item.confidence)
                            )
                                ? Number(
                                    item.confidence
                                )
                                : null
                    };
                }

                return {
                    provider: "",
                    value: item,
                    confidence: null
                };
            });
        }

        if (
            raw &&
            typeof raw === "object"
        ) {
            return Object.entries(raw).map(
                ([provider, value]) => ({
                    provider,
                    value,
                    confidence: null
                })
            );
        }

        return [];
    }

    function normalizeRecord(record, index = 0) {
        if (
            !record ||
            typeof record !== "object"
        ) {
            return {
                index,
                value: record,
                severity: "unknown",
                providers: [],
                values: []
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
                    Number(
                        record.provider_count ??
                        record.providerCount
                    )
                )
                    ? Number(
                        record.provider_count ??
                        record.providerCount
                    )
                    : providers.length,
            value_count:
                Number.isFinite(
                    Number(
                        record.value_count ??
                        record.valueCount
                    )
                )
                    ? Number(
                        record.value_count ??
                        record.valueCount
                    )
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
            severity[
                record.severity in severity
                    ? record.severity
                    : "unknown"
            ] += 1;

            for (
                const provider of
                record.providers || []
            ) {
                providers.add(provider);
            }

            if (record.taxon) {
                taxa.add(record.taxon);
            }

            if (record.field) {
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
        const groups = new Map();

        for (
            const record of
            Array.isArray(records)
                ? records
                : []
        ) {
            const raw =
                key === "provider"
                    ? (
                        record.providers?.length
                            ? record.providers
                            : ["unknown"]
                    )
                    : [
                        normalizeText(
                            record[key] ??
                            "unknown"
                        ) || "unknown"
                    ];

            for (const value of raw) {
                const current =
                    groups.get(value) || {
                        key: value,
                        count: 0,
                        high: 0,
                        critical: 0
                    };

                current.count += 1;

                if (
                    record.severity ===
                    "high"
                ) {
                    current.high += 1;
                }

                if (
                    record.severity ===
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
                left.count
        );
    }

    function compareConflictValues(record) {
        const normalized =
            normalizeRecord(record);

        const groups = new Map();

        for (
            const item of
            normalized.values
        ) {
            let key;

            try {
                key =
                    JSON.stringify(
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
                    providers: [],
                    confidences: []
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
        ].map(group => ({
            value:
                group.value,
            providers: [
                ...new Set(
                    group.providers
                )
            ],
            averageConfidence:
                group.confidences.length
                    ? group.confidences.reduce(
                        (sum, value) =>
                            sum + value,
                        0
                    ) /
                      group.confidences.length
                    : null
        }));
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
                                Array.isArray(payload.conflicts)
                                    ? payload.conflicts
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

    class UnresolvedConflictsService extends EventTarget {
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
                    "Unresolved-conflicts service has been destroyed."
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
                    `unresolved-conflicts:${name}`,
                    detail
                );
            } catch (_error) {
                /*
                ----------------------------------------------------------------
                Observer failures must not break conflict requests.
                ----------------------------------------------------------------
                */
            }

            dispatch(
                this.context.root,
                `speciedex:terminal-unresolved-conflicts-${name}`,
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
                    operation:
                        "list",
                    parameters:
                        normalized
                }
            );

            try {
                const payload =
                    await this.context.api.get(
                        "archive/conflicts",
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
                        operation:
                            "list",
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

        async get(id, options = {}) {
            this.ensureAvailable();

            const normalizedId =
                normalizeText(id);

            if (!normalizedId) {
                throw new TypeError(
                    "A conflict ID is required."
                );
            }

            const payload =
                await this.context.api.get(
                    `archive/conflicts/${encodeURIComponent(normalizedId)}`,
                    {},
                    options
                );

            return normalizeRecord(
                payload,
                0
            );
        }

        async highPriority(parameters = {}, options = {}) {
            const result =
                await this.list(
                    {
                        ...parameters,
                        min_severity:
                            parameters.min_severity ??
                            "high",
                        sort:
                            parameters.sort ??
                            "severity",
                        direction:
                            parameters.direction ??
                            "desc"
                    },
                    options
                );

            return {
                ...result,
                records:
                    result.records.filter(
                        record =>
                            SEVERITY_ORDER[
                                record.severity
                            ] >=
                            SEVERITY_ORDER.high
                    )
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
                    )
            };
        }

        status() {
            return {
                version: VERSION,
                endpoint:
                    "archive/conflicts",
                service:
                    SERVICE_NAME,
                severities:
                    Object.keys(
                        SEVERITY_ORDER
                    ),
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
            UnresolvedConflictsService &&
            !existing.destroyed
        ) {
            context.unresolvedConflicts =
                existing;

            return existing;
        }

        if (
            context.unresolvedConflicts instanceof
            UnresolvedConflictsService &&
            !context.unresolvedConflicts.destroyed
        ) {
            return context.unresolvedConflicts;
        }

        const service =
            new UnresolvedConflictsService(
                context
            );

        context.unresolvedConflicts =
            service;

        context.registerService?.(
            SERVICE_NAME,
            service
        );

        context.registerService?.(
            "unresolvedConflicts",
            service
        );

        dispatch(
            document,
            "speciedex:terminal-unresolved-conflicts-ready",
            {
                context,
                service
            }
        );

        return service;
    }

    function requireService(context) {
        const service =
            context?.unresolvedConflicts ||
            context?.services?.get?.(
                SERVICE_NAME
            );

        if (
            !(
                service instanceof
                UnresolvedConflictsService
            )
        ) {
            throw new Error(
                "Unresolved-conflicts service is unavailable."
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
                    "--taxon="
                )
            ) {
                parameters.taxon =
                    argument.slice(8);
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
                    "--field="
                )
            ) {
                parameters.field =
                    argument.slice(8);
                continue;
            }

            if (
                argument.startsWith(
                    "--severity="
                )
            ) {
                parameters.severity =
                    argument.slice(11);
                continue;
            }

            if (
                argument.startsWith(
                    "--min-severity="
                )
            ) {
                parameters.min_severity =
                    argument.slice(15);
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
                    "--volume="
                )
            ) {
                parameters.volume =
                    argument.slice(9);
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
            name: "unresolved-conflicts",
            aliases: [
                "conflicts",
                "conflict-list"
            ],
            category: "archive",
            description:
                "Inspect unresolved provider conflicts.",
            usage:
                "unresolved-conflicts [query] [limit] [--provider=NAME] [--taxon=NAME] [--rank=RANK] [--field=FIELD] [--severity=LEVEL] [--min-severity=LEVEL] [--status=STATUS] [--authority=NAME] [--dataset=NAME] [--release=ID] [--volume=ID] [--type=TYPE] [--from=DATE] [--to=DATE] [--sort=FIELD] [--direction=asc|desc] [--offset=N]",
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
            name: "conflict",
            aliases: [
                "conflict-get"
            ],
            category: "archive",
            description:
                "Retrieve one unresolved conflict by ID.",
            usage:
                "conflict <id>",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                if (!args[0]) {
                    throw new Error(
                        "A conflict ID is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).get(
                        args[0]
                    )
                );
            }
        },
        {
            name: "conflicts-high-priority",
            aliases: [
                "critical-conflicts"
            ],
            category: "archive",
            description:
                "Display high and critical unresolved conflicts.",
            usage:
                "conflicts-high-priority [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).highPriority(
                        parseCommandArguments(
                            args
                        )
                    )
                )
        },
        {
            name: "conflicts-summary",
            category: "archive",
            description:
                "Summarize unresolved conflicts by severity, provider, field, and rank.",
            usage:
                "conflicts-summary [filters]",
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
            name: "unresolved-conflicts-status",
            aliases: [
                "conflicts-status"
            ],
            category: "archive",
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
        }
    ];

    const api = Object.freeze({
        name: MODULE_NAME,
        version: VERSION,
        serviceName:
            SERVICE_NAME,
        SEVERITY_ORDER,
        UnresolvedConflictsService,
        normalizeSeverity,
        normalizeParameters,
        normalizeProviders,
        normalizeValues,
        normalizeRecord,
        normalizeResponse,
        summarize,
        groupBy,
        compareConflictValues,
        parseCommandArguments,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalUnresolvedConflicts =
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
