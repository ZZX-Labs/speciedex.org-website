/*
========================================================================
Speciedex.org
Terminal Ranks Module
========================================================================

Taxonomic rank service for SpeciedexTerminal.

Provides:

    • Validated taxonomic-rank API requests
    • Rank, level, parent, group, code, status, and support filters
    • Normalized rank metadata and canonical aliases
    • Rank hierarchy, lineage, parent, child, and comparison helpers
    • Supported, unsupported, major, minor, and unranked views
    • Rank, group, status, level, and support summaries
    • Lifecycle events, caching, and resilient service registration
    • Terminal command integration

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Ranks";
    const VERSION = "2.0.0";
    const SERVICE_NAME = "ranks";

    const DEFAULT_LIMIT = 50;
    const MIN_LIMIT = 1;
    const MAX_LIMIT = 1000;

    const CANONICAL_ORDER = Object.freeze([
        "domain",
        "superkingdom",
        "kingdom",
        "subkingdom",
        "infrakingdom",
        "superphylum",
        "phylum",
        "subphylum",
        "infraphylum",
        "superclass",
        "class",
        "subclass",
        "infraclass",
        "superorder",
        "order",
        "suborder",
        "infraorder",
        "parvorder",
        "superfamily",
        "family",
        "subfamily",
        "tribe",
        "subtribe",
        "genus",
        "subgenus",
        "section",
        "subsection",
        "series",
        "species",
        "subspecies",
        "variety",
        "subvariety",
        "form",
        "subform",
        "strain",
        "isolate",
        "cultivar",
        "breed",
        "unranked"
    ]);

    const RANK_ALIASES = Object.freeze({
        regnum: "kingdom",
        divisio: "phylum",
        division: "phylum",
        classis: "class",
        ordo: "order",
        familia: "family",
        tribus: "tribe",
        genus_group: "genus",
        species_group: "species",
        varietas: "variety",
        forma: "form",
        no_rank: "unranked",
        norank: "unranked",
        incertae_sedis: "unranked"
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

    function normalizeText(value) {
        return String(value ?? "").trim();
    }

    function normalizeKey(value) {
        return normalizeText(value)
            .toLowerCase()
            .replace(/[\s-]+/g, "_")
            .replace(/[^a-z0-9_]/g, "");
    }

    function canonicalizeRank(value) {
        const normalized = normalizeKey(value);

        return RANK_ALIASES[normalized] || normalized;
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

    function normalizeBoolean(value, fallback = null) {
        if (typeof value === "boolean") {
            return value;
        }

        if (
            value === 1 ||
            value === "1" ||
            String(value).toLowerCase() === "true"
        ) {
            return true;
        }

        if (
            value === 0 ||
            value === "0" ||
            String(value).toLowerCase() === "false"
        ) {
            return false;
        }

        return fallback;
    }

    function normalizeSort(value) {
        const normalized = normalizeKey(
            value || "level"
        );

        const allowed = new Set([
            "level",
            "name",
            "rank",
            "label",
            "group",
            "status",
            "code",
            "parent",
            "created_at",
            "updated_at",
            "id"
        ]);

        if (!allowed.has(normalized)) {
            throw new TypeError(
                `Unsupported rank sort field: ${value}`
            );
        }

        return normalized;
    }

    function normalizeDirection(value) {
        const normalized = normalizeText(
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
            q: normalizeText(
                source.q ??
                source.query ??
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
            sort: normalizeSort(
                source.sort
            ),
            direction: normalizeDirection(
                source.direction ??
                source.order
            )
        };

        for (
            const key of
            [
                "rank",
                "name",
                "label",
                "code",
                "parent",
                "group",
                "status",
                "category",
                "type"
            ]
        ) {
            if (
                source[key] !== undefined &&
                source[key] !== null &&
                source[key] !== ""
            ) {
                normalized[key] =
                    key === "rank" ||
                    key === "parent"
                        ? canonicalizeRank(
                            source[key]
                        )
                        : normalizeText(
                            source[key]
                        );
            }
        }

        for (
            const key of
            [
                "supported",
                "accepted",
                "deprecated",
                "major",
                "minor",
                "unranked",
                "terminal"
            ]
        ) {
            if (
                source[key] !== undefined &&
                source[key] !== null &&
                source[key] !== ""
            ) {
                const value =
                    normalizeBoolean(
                        source[key],
                        null
                    );

                if (value === null) {
                    throw new TypeError(
                        `Invalid ${key} value: ${source[key]}`
                    );
                }

                normalized[key] = value;
            }
        }

        const minimumLevel =
            source.min_level ??
            source.minLevel;

        const maximumLevel =
            source.max_level ??
            source.maxLevel;

        if (
            minimumLevel !== undefined &&
            minimumLevel !== null &&
            minimumLevel !== ""
        ) {
            normalized.min_level =
                clampInteger(
                    minimumLevel,
                    0,
                    0,
                    Number.MAX_SAFE_INTEGER
                );
        }

        if (
            maximumLevel !== undefined &&
            maximumLevel !== null &&
            maximumLevel !== ""
        ) {
            normalized.max_level =
                clampInteger(
                    maximumLevel,
                    Number.MAX_SAFE_INTEGER,
                    0,
                    Number.MAX_SAFE_INTEGER
                );
        }

        if (
            normalized.min_level !== undefined &&
            normalized.max_level !== undefined &&
            normalized.min_level >
            normalized.max_level
        ) {
            throw new RangeError(
                "Minimum rank level must not exceed maximum rank level."
            );
        }

        return normalized;
    }

    function inferLevel(rank) {
        const canonical =
            canonicalizeRank(rank);

        const index =
            CANONICAL_ORDER.indexOf(
                canonical
            );

        return index >= 0
            ? index
            : CANONICAL_ORDER.length;
    }

    function inferGroup(rank) {
        const canonical =
            canonicalizeRank(rank);

        if (
            [
                "domain",
                "superkingdom",
                "kingdom",
                "subkingdom",
                "infrakingdom"
            ].includes(canonical)
        ) {
            return "kingdom";
        }

        if (
            canonical.includes("phylum")
        ) {
            return "phylum";
        }

        if (
            canonical.includes("class")
        ) {
            return "class";
        }

        if (
            canonical.includes("order") ||
            canonical === "parvorder"
        ) {
            return "order";
        }

        if (
            canonical.includes("family") ||
            canonical === "tribe" ||
            canonical === "subtribe"
        ) {
            return "family";
        }

        if (
            canonical.includes("genus") ||
            [
                "section",
                "subsection",
                "series"
            ].includes(canonical)
        ) {
            return "genus";
        }

        if (
            canonical.includes("species") ||
            [
                "variety",
                "subvariety",
                "form",
                "subform",
                "strain",
                "isolate",
                "cultivar",
                "breed"
            ].includes(canonical)
        ) {
            return "species";
        }

        return "unranked";
    }

    function normalizeAliases(value) {
        if (Array.isArray(value)) {
            return [
                ...new Set(
                    value
                        .map(canonicalizeRank)
                        .filter(Boolean)
                )
            ];
        }

        const text =
            normalizeText(value);

        if (!text) {
            return [];
        }

        return [
            ...new Set(
                text
                    .split(/[;,|]+/)
                    .map(canonicalizeRank)
                    .filter(Boolean)
            )
        ];
    }

    function normalizeRecord(record, index = 0) {
        if (
            !record ||
            typeof record !== "object"
        ) {
            const rank =
                canonicalizeRank(record);

            return {
                index,
                id:
                    rank ||
                    `rank-${index + 1}`,
                rank,
                name:
                    rank,
                label:
                    rank,
                code: "",
                level:
                    inferLevel(rank),
                group:
                    inferGroup(rank),
                parent: "",
                aliases: [],
                supported: true,
                accepted: true,
                deprecated: false,
                major: false,
                minor: true,
                unranked:
                    rank === "unranked",
                terminal:
                    rank === "species" ||
                    rank === "subspecies",
                status: "accepted"
            };
        }

        const rank =
            canonicalizeRank(
                record.rank ??
                record.name ??
                record.slug ??
                record.code ??
                ""
            );

        const level =
            Number.isFinite(
                Number(
                    record.level ??
                    record.depth ??
                    record.order_index ??
                    record.orderIndex
                )
            )
                ? Number(
                    record.level ??
                    record.depth ??
                    record.order_index ??
                    record.orderIndex
                )
                : inferLevel(rank);

        const status =
            normalizeText(
                record.status ??
                (
                    record.deprecated === true
                        ? "deprecated"
                        : "accepted"
                )
            ).toLowerCase();

        const deprecated =
            record.deprecated === true ||
            status === "deprecated";

        const accepted =
            record.accepted !== false &&
            !deprecated &&
            ![
                "rejected",
                "unsupported"
            ].includes(status);

        const supported =
            record.supported !== false &&
            ![
                "unsupported",
                "disabled"
            ].includes(status);

        const majorRanks =
            new Set([
                "domain",
                "kingdom",
                "phylum",
                "class",
                "order",
                "family",
                "genus",
                "species"
            ]);

        const major =
            record.major === true ||
            majorRanks.has(rank);

        const unranked =
            record.unranked === true ||
            rank === "unranked";

        return {
            ...record,
            index:
                record.index ??
                index,
            id: normalizeText(
                record.id ??
                record.rank_id ??
                record.rankId ??
                rank ??
                `rank-${index + 1}`
            ),
            rank,
            name: normalizeText(
                record.name ??
                rank
            ),
            label: normalizeText(
                record.label ??
                record.display_name ??
                record.displayName ??
                record.name ??
                rank
            ),
            code: normalizeText(
                record.code ??
                record.abbreviation ??
                record.short_name ??
                record.shortName ??
                ""
            ),
            level,
            group: normalizeKey(
                record.group ??
                record.rank_group ??
                record.rankGroup ??
                inferGroup(rank)
            ),
            parent: canonicalizeRank(
                record.parent ??
                record.parent_rank ??
                record.parentRank ??
                ""
            ),
            aliases: normalizeAliases(
                record.aliases ??
                record.synonyms ??
                record.alternative_names ??
                record.alternativeNames
            ),
            supported,
            accepted,
            deprecated,
            major,
            minor:
                record.minor !== undefined
                    ? Boolean(record.minor)
                    : !major,
            unranked,
            terminal:
                record.terminal === true ||
                record.leaf === true ||
                [
                    "species",
                    "subspecies",
                    "variety",
                    "form",
                    "strain",
                    "isolate",
                    "cultivar",
                    "breed"
                ].includes(rank),
            status,
            category: normalizeText(
                record.category ??
                ""
            ),
            type: normalizeText(
                record.type ??
                ""
            ),
            description: normalizeText(
                record.description ??
                ""
            ),
            created_at:
                record.created_at ??
                record.createdAt ??
                "",
            updated_at:
                record.updated_at ??
                record.updatedAt ??
                ""
        };
    }

    function incrementMap(map, key) {
        const normalized =
            normalizeText(key) ||
            "unknown";

        map.set(
            normalized,
            (
                map.get(normalized) ||
                0
            ) + 1
        );
    }

    function mapToSortedObject(map) {
        return Object.fromEntries(
            [...map.entries()]
                .sort(
                    (left, right) =>
                        right[1] -
                        left[1] ||
                        left[0].localeCompare(
                            right[0]
                        )
                )
        );
    }

    function summarize(records) {
        const values =
            Array.isArray(records)
                ? records
                : [];

        const groups = new Map();
        const statuses = new Map();
        const levels = new Map();
        const categories = new Map();
        const types = new Map();

        for (const rank of values) {
            incrementMap(
                groups,
                rank.group
            );

            incrementMap(
                statuses,
                rank.status
            );

            incrementMap(
                levels,
                String(rank.level)
            );

            incrementMap(
                categories,
                rank.category
            );

            incrementMap(
                types,
                rank.type
            );
        }

        return {
            total:
                values.length,
            supported:
                values.filter(
                    item =>
                        item.supported
                ).length,
            accepted:
                values.filter(
                    item =>
                        item.accepted
                ).length,
            deprecated:
                values.filter(
                    item =>
                        item.deprecated
                ).length,
            major:
                values.filter(
                    item =>
                        item.major
                ).length,
            minor:
                values.filter(
                    item =>
                        item.minor
                ).length,
            unranked:
                values.filter(
                    item =>
                        item.unranked
                ).length,
            terminal:
                values.filter(
                    item =>
                        item.terminal
                ).length,
            minimumLevel:
                values.length
                    ? Math.min(
                        ...values.map(
                            item =>
                                item.level
                        )
                    )
                    : null,
            maximumLevel:
                values.length
                    ? Math.max(
                        ...values.map(
                            item =>
                                item.level
                        )
                    )
                    : null,
            groups:
                mapToSortedObject(
                    groups
                ),
            statuses:
                mapToSortedObject(
                    statuses
                ),
            levels:
                mapToSortedObject(
                    levels
                ),
            categories:
                mapToSortedObject(
                    categories
                ),
            types:
                mapToSortedObject(
                    types
                )
        };
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
                                Array.isArray(payload.ranks)
                                    ? payload.ranks
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

    function sortHierarchy(records) {
        return [...records]
            .sort(
                (left, right) =>
                    left.level -
                    right.level ||
                    left.rank.localeCompare(
                        right.rank
                    )
            );
    }

    function findRank(records, value) {
        const target =
            canonicalizeRank(value);

        return records.find(
            item =>
                item.rank === target ||
                item.id === value ||
                item.aliases.includes(target)
        ) || null;
    }

    function buildHierarchy(records) {
        const ordered =
            sortHierarchy(records);

        const byRank =
            new Map(
                ordered.map(
                    item => [
                        item.rank,
                        {
                            ...item,
                            children: []
                        }
                    ]
                )
            );

        const roots = [];

        for (const item of byRank.values()) {
            if (
                item.parent &&
                byRank.has(item.parent)
            ) {
                byRank.get(
                    item.parent
                ).children.push(item);
            } else {
                roots.push(item);
            }
        }

        return {
            roots,
            byRank:
                Object.fromEntries(
                    [...byRank.entries()]
                )
        };
    }

    function buildLineage(records, value) {
        const hierarchy =
            buildHierarchy(records);

        const rank =
            findRank(records, value);

        if (!rank) {
            return [];
        }

        const lineage = [];
        const visited = new Set();
        let current = rank;

        while (
            current &&
            !visited.has(current.rank)
        ) {
            lineage.unshift(current);
            visited.add(current.rank);

            current =
                current.parent
                    ? hierarchy.byRank[
                        current.parent
                    ] || null
                    : null;
        }

        return lineage;
    }

    class RanksService extends EventTarget {
        constructor(context) {
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
            this.cache = null;
            this.cacheTimestamp = 0;
        }

        ensureAvailable() {
            if (this.destroyed) {
                throw new Error(
                    "Ranks service has been destroyed."
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
                    `ranks:${name}`,
                    detail
                );
            } catch (_error) {
                /*
                Observer failures must not break rank operations.
                */
            }

            dispatch(
                this.context.root,
                `speciedex:terminal-ranks-${name}`,
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
                        "taxa/ranks",
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

                this.cache =
                    result;

                this.cacheTimestamp =
                    Date.now();

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

        async get(rank, options = {}) {
            this.ensureAvailable();

            const normalizedRank =
                canonicalizeRank(rank);

            if (!normalizedRank) {
                throw new TypeError(
                    "A taxonomic rank is required."
                );
            }

            try {
                const payload =
                    await this.context.api.get(
                        `taxa/ranks/${encodeURIComponent(normalizedRank)}`,
                        {},
                        options
                    );

                return normalizeRecord(
                    payload,
                    0
                );
            } catch (error) {
                const match =
                    findRank(
                        this.cache?.records || [],
                        normalizedRank
                    );

                if (match) {
                    return match;
                }

                throw error;
            }
        }

        async supported(parameters = {}, options = {}) {
            const result =
                await this.list(
                    {
                        ...parameters,
                        supported: true
                    },
                    options
                );

            const records =
                result.records.filter(
                    item =>
                        item.supported
                );

            return {
                ...result,
                records,
                summary:
                    summarize(records)
            };
        }

        async major(parameters = {}, options = {}) {
            const result =
                await this.list(
                    {
                        ...parameters,
                        major: true
                    },
                    options
                );

            const records =
                result.records.filter(
                    item =>
                        item.major
                );

            return {
                ...result,
                records,
                summary:
                    summarize(records)
            };
        }

        async hierarchy(parameters = {}, options = {}) {
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
                hierarchy:
                    buildHierarchy(
                        result.records
                    ),
                ranks:
                    sortHierarchy(
                        result.records
                    ),
                summary:
                    summarize(
                        result.records
                    )
            };
        }

        async lineage(rank, parameters = {}, options = {}) {
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
                rank:
                    canonicalizeRank(rank),
                lineage:
                    buildLineage(
                        result.records,
                        rank
                    )
            };
        }

        async children(rank, parameters = {}, options = {}) {
            const normalizedRank =
                canonicalizeRank(rank);

            const result =
                await this.list(
                    {
                        ...parameters,
                        parent:
                            normalizedRank,
                        limit:
                            parameters.limit ??
                            MAX_LIMIT
                    },
                    options
                );

            const records =
                result.records.filter(
                    item =>
                        item.parent ===
                        normalizedRank
                );

            return {
                rank:
                    normalizedRank,
                records:
                    sortHierarchy(records),
                summary:
                    summarize(records)
            };
        }

        async compare(left, right, parameters = {}, options = {}) {
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

            const leftRank =
                findRank(
                    result.records,
                    left
                );

            const rightRank =
                findRank(
                    result.records,
                    right
                );

            if (!leftRank || !rightRank) {
                throw new Error(
                    "One or both taxonomic ranks could not be resolved."
                );
            }

            return {
                left:
                    leftRank,
                right:
                    rightRank,
                difference:
                    rightRank.level -
                    leftRank.level,
                relation:
                    leftRank.level === rightRank.level
                        ? "same-level"
                        : (
                            leftRank.level < rightRank.level
                                ? "left-higher"
                                : "right-higher"
                        )
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
                ranks:
                    sortHierarchy(
                        result.records
                    )
            };
        }

        status() {
            return {
                version: VERSION,
                endpoint:
                    "taxa/ranks",
                service:
                    SERVICE_NAME,
                canonicalRanks:
                    CANONICAL_ORDER.length,
                available:
                    Boolean(
                        this.context.api &&
                        typeof this.context.api.get ===
                        "function"
                    ),
                cached:
                    Boolean(this.cache),
                cacheAge:
                    this.cacheTimestamp
                        ? Date.now() -
                          this.cacheTimestamp
                        : null,
                destroyed:
                    this.destroyed
            };
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            this.cache = null;
            this.cacheTimestamp = 0;
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
            RanksService &&
            !existing.destroyed
        ) {
            context.ranks =
                existing;

            return existing;
        }

        if (
            context.ranks instanceof
            RanksService &&
            !context.ranks.destroyed
        ) {
            return context.ranks;
        }

        const service =
            new RanksService(
                context
            );

        context.ranks =
            service;

        context.registerService?.(
            SERVICE_NAME,
            service
        );

        context.registerService?.(
            "taxonomic-ranks",
            service
        );

        dispatch(
            document,
            "speciedex:terminal-ranks-ready",
            {
                context,
                service
            }
        );

        return service;
    }

    function requireService(context) {
        const service =
            context?.ranks ||
            context?.services?.get?.(
                SERVICE_NAME
            );

        if (
            !(
                service instanceof
                RanksService
            )
        ) {
            throw new Error(
                "Ranks service is unavailable."
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
                    "--rank="
                )
            ) {
                parameters.rank =
                    argument.slice(7);
                continue;
            }

            if (
                argument.startsWith(
                    "--name="
                )
            ) {
                parameters.name =
                    argument.slice(7);
                continue;
            }

            if (
                argument.startsWith(
                    "--label="
                )
            ) {
                parameters.label =
                    argument.slice(8);
                continue;
            }

            if (
                argument.startsWith(
                    "--code="
                )
            ) {
                parameters.code =
                    argument.slice(7);
                continue;
            }

            if (
                argument.startsWith(
                    "--parent="
                )
            ) {
                parameters.parent =
                    argument.slice(9);
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
                    "--status="
                )
            ) {
                parameters.status =
                    argument.slice(9);
                continue;
            }

            if (
                argument.startsWith(
                    "--category="
                )
            ) {
                parameters.category =
                    argument.slice(11);
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
                    "--supported="
                )
            ) {
                parameters.supported =
                    argument.slice(12);
                continue;
            }

            if (
                argument.startsWith(
                    "--accepted="
                )
            ) {
                parameters.accepted =
                    argument.slice(11);
                continue;
            }

            if (
                argument.startsWith(
                    "--deprecated="
                )
            ) {
                parameters.deprecated =
                    argument.slice(13);
                continue;
            }

            if (
                argument.startsWith(
                    "--major="
                )
            ) {
                parameters.major =
                    argument.slice(8);
                continue;
            }

            if (
                argument.startsWith(
                    "--minor="
                )
            ) {
                parameters.minor =
                    argument.slice(8);
                continue;
            }

            if (
                argument.startsWith(
                    "--unranked="
                )
            ) {
                parameters.unranked =
                    argument.slice(11);
                continue;
            }

            if (
                argument.startsWith(
                    "--terminal="
                )
            ) {
                parameters.terminal =
                    argument.slice(11);
                continue;
            }

            if (
                argument.startsWith(
                    "--min-level="
                )
            ) {
                parameters.min_level =
                    argument.slice(12);
                continue;
            }

            if (
                argument.startsWith(
                    "--max-level="
                )
            ) {
                parameters.max_level =
                    argument.slice(12);
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
            name: "ranks",
            aliases: [
                "taxonomic-ranks",
                "taxa-ranks"
            ],
            category: "taxonomy",
            description:
                "List supported taxonomic ranks.",
            usage:
                "ranks [query] [limit] [--rank=RANK] [--name=NAME] [--label=LABEL] [--code=CODE] [--parent=RANK] [--group=GROUP] [--status=STATUS] [--category=CATEGORY] [--type=TYPE] [--supported=true|false] [--accepted=true|false] [--deprecated=true|false] [--major=true|false] [--minor=true|false] [--unranked=true|false] [--terminal=true|false] [--min-level=N] [--max-level=N] [--sort=FIELD] [--direction=asc|desc] [--offset=N]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).list(
                        parseCommandArguments(
                            args
                        )
                    )
                )
        },
        {
            name: "rank",
            aliases: [
                "rank-get"
            ],
            category: "taxonomy",
            description:
                "Retrieve one taxonomic rank by name, ID, or alias.",
            usage:
                "rank <rank>",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                const rank =
                    args.join(" ")
                        .trim();

                if (!rank) {
                    throw new Error(
                        "A taxonomic rank is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).get(rank)
                );
            }
        },
        {
            name: "ranks-supported",
            aliases: [
                "supported-ranks"
            ],
            category: "taxonomy",
            description:
                "List supported taxonomic ranks.",
            usage:
                "ranks-supported [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).supported(
                        parseCommandArguments(
                            args
                        )
                    )
                )
        },
        {
            name: "ranks-major",
            aliases: [
                "major-ranks"
            ],
            category: "taxonomy",
            description:
                "List major canonical taxonomic ranks.",
            usage:
                "ranks-major [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).major(
                        parseCommandArguments(
                            args
                        )
                    )
                )
        },
        {
            name: "ranks-hierarchy",
            aliases: [
                "rank-hierarchy"
            ],
            category: "taxonomy",
            description:
                "Build the taxonomic-rank hierarchy.",
            usage:
                "ranks-hierarchy [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).hierarchy(
                        parseCommandArguments(
                            args
                        )
                    )
                )
        },
        {
            name: "rank-lineage",
            category: "taxonomy",
            description:
                "Show the parent lineage for a taxonomic rank.",
            usage:
                "rank-lineage <rank> [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                if (!args.length) {
                    throw new Error(
                        "A taxonomic rank is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).lineage(
                        args[0],
                        parseCommandArguments(
                            args.slice(1)
                        )
                    )
                );
            }
        },
        {
            name: "rank-children",
            category: "taxonomy",
            description:
                "List direct child ranks beneath a taxonomic rank.",
            usage:
                "rank-children <rank> [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                if (!args.length) {
                    throw new Error(
                        "A taxonomic rank is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).children(
                        args[0],
                        parseCommandArguments(
                            args.slice(1)
                        )
                    )
                );
            }
        },
        {
            name: "rank-compare",
            category: "taxonomy",
            description:
                "Compare the relative hierarchy levels of two ranks.",
            usage:
                "rank-compare <left-rank> <right-rank> [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                if (args.length < 2) {
                    throw new Error(
                        "Two taxonomic ranks are required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).compare(
                        args[0],
                        args[1],
                        parseCommandArguments(
                            args.slice(2)
                        )
                    )
                );
            }
        },
        {
            name: "ranks-summary",
            aliases: [
                "rank-summary"
            ],
            category: "taxonomy",
            description:
                "Summarize taxonomic ranks by hierarchy level, group, support, status, category, and type.",
            usage:
                "ranks-summary [filters]",
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
            name: "ranks-status",
            category: "taxonomy",
            description:
                "Show ranks service status.",
            usage:
                "ranks-status",
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
        canonicalOrder:
            CANONICAL_ORDER,
        aliases:
            RANK_ALIASES,
        RanksService,
        normalizeParameters,
        normalizeRecord,
        normalizeResponse,
        normalizeKey,
        canonicalizeRank,
        normalizeAliases,
        inferLevel,
        inferGroup,
        sortHierarchy,
        findRank,
        buildHierarchy,
        buildLineage,
        summarize,
        parseCommandArguments,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalRanks =
        api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules ||
        {};

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
