/*
========================================================================
Speciedex.org
Terminal Recent Activity
========================================================================

Terminal-wide recent activity journal for SpeciedexTerminal.

Tracks:

    • completed commands
    • command failures
    • searches
    • provider activity
    • taxa and species activity
    • maps and visualizations
    • imports and exports
    • downloads
    • notifications
    • bookmarks
    • API activity
    • scans
    • library updates
    • errors and warnings

Provides:

    • bounded in-memory history
    • optional localStorage persistence
    • filtering
    • sorting
    • grouping
    • deduplication
    • favorites
    • pins
    • statistics
    • timeline generation
    • JSON and CSV export
    • terminal commands
    • clean teardown

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME =
        "Recent";

    const VERSION =
        "2.0.0";

    const STORAGE_PREFIX =
        "speciedex-terminal:recent:";

    const DEFAULT_OPTIONS =
        Object.freeze({
            limit:
                5000,

            persist:
                true,

            restore:
                true,

            deduplicate:
                true,

            deduplicateWindow:
                2000,

            persistDelay:
                150,

            includeMetadata:
                true,

            autoBind:
                true
        });

    const TYPES =
        Object.freeze([
            "command",
            "search",
            "provider",
            "taxon",
            "species",
            "map",
            "visualization",
            "download",
            "export",
            "import",
            "notification",
            "bookmark",
            "api",
            "scan",
            "library",
            "error",
            "warning",
            "system",
            "other"
        ]);

    const CATEGORIES =
        Object.freeze([
            "system",
            "data",
            "taxonomy",
            "provider",
            "visualization",
            "network",
            "archive",
            "interface",
            "user",
            "other"
        ]);

    /*
    ==========================================================================
    Utilities
    ==========================================================================
    */

    function makeID() {
        if (
            window.crypto &&
            typeof window.crypto.randomUUID ===
            "function"
        ) {
            return window.crypto.randomUUID();
        }

        return (
            `recent:${Date.now()}:` +
            Math.random()
                .toString(16)
                .slice(2)
        );
    }

    function normalizeText(value) {
        return String(
            value ?? ""
        ).trim();
    }

    function normalizeType(value) {
        const normalized =
            normalizeText(
                value
            ).toLowerCase();

        return TYPES.includes(
            normalized
        )
            ? normalized
            : "other";
    }

    function normalizeCategory(value) {
        const normalized =
            normalizeText(
                value
            ).toLowerCase();

        return CATEGORIES.includes(
            normalized
        )
            ? normalized
            : "other";
    }

    function parseBoolean(
        value,
        fallback = false
    ) {
        if (
            value === undefined ||
            value === null ||
            value === ""
        ) {
            return fallback;
        }

        return ![
            "false",
            "0",
            "no",
            "off"
        ].includes(
            String(value)
                .trim()
                .toLowerCase()
        );
    }

    function clampInteger(
        value,
        fallback,
        minimum,
        maximum
    ) {
        const parsed =
            Number.parseInt(
                value,
                10
            );

        if (!Number.isFinite(parsed)) {
            return fallback;
        }

        return Math.min(
            maximum,
            Math.max(
                minimum,
                parsed
            )
        );
    }

    function safeStorage() {
        try {
            const key =
                "__speciedex_recent_probe__";

            window.localStorage.setItem(
                key,
                key
            );

            window.localStorage.removeItem(
                key
            );

            return window.localStorage;
        } catch (error) {
            return null;
        }
    }

    function safeSerialize(
        value,
        seen = new WeakSet()
    ) {
        if (
            value === null ||
            value === undefined
        ) {
            return value;
        }

        if (
            typeof value ===
                "string" ||
            typeof value ===
                "number" ||
            typeof value ===
                "boolean"
        ) {
            return value;
        }

        if (
            typeof value ===
            "bigint"
        ) {
            return value.toString();
        }

        if (
            value instanceof
            Error
        ) {
            return {
                name:
                    value.name,

                message:
                    value.message,

                stack:
                    value.stack ||
                    null
            };
        }

        if (
            value instanceof
            Date
        ) {
            return value.toISOString();
        }

        if (
            typeof value ===
            "function"
        ) {
            return `[Function ${value.name || "anonymous"}]`;
        }

        if (
            value &&
            typeof value ===
            "object"
        ) {
            if (
                seen.has(
                    value
                )
            ) {
                return "[Circular]";
            }

            seen.add(
                value
            );
        }

        if (
            Array.isArray(value)
        ) {
            return value.map(
                item =>
                    safeSerialize(
                        item,
                        seen
                    )
            );
        }

        if (
            value instanceof
            Map
        ) {
            return Object.fromEntries(
                [...value.entries()].map(
                    (
                        [
                            key,
                            item
                        ]
                    ) => [
                        String(key),
                        safeSerialize(
                            item,
                            seen
                        )
                    ]
                )
            );
        }

        if (
            value instanceof
            Set
        ) {
            return [
                ...value
            ].map(
                item =>
                    safeSerialize(
                        item,
                        seen
                    )
            );
        }

        if (
            value &&
            typeof value ===
            "object"
        ) {
            const output =
                {};

            for (
                const [
                    key,
                    item
                ] of Object.entries(
                    value
                )
            ) {
                output[
                    key
                ] =
                    safeSerialize(
                        item,
                        seen
                    );
            }

            return output;
        }

        return String(
            value
        );
    }

    function escapeCSV(value) {
        const text =
            String(
                value ?? ""
            );

        if (
            /[",\n\r]/.test(
                text
            )
        ) {
            return `"${text.replace(/"/g, '""')}"`;
        }

        return text;
    }

    function normalizeTimestamp(value) {
        if (!value) {
            return new Date().toISOString();
        }

        if (
            value instanceof
            Date
        ) {
            return value.toISOString();
        }

        const timestamp =
            Date.parse(
                value
            );

        return Number.isFinite(
            timestamp
        )
            ? new Date(
                timestamp
            ).toISOString()
            : new Date().toISOString();
    }

    function inferTypeFromEvent(
        eventName
    ) {
        const name =
            String(
                eventName ||
                ""
            ).toLowerCase();

        if (
            name.includes(
                "command"
            )
        ) {
            return "command";
        }

        if (
            name.includes(
                "search"
            )
        ) {
            return "search";
        }

        if (
            name.includes(
                "provider"
            )
        ) {
            return "provider";
        }

        if (
            name.includes(
                "species"
            )
        ) {
            return "species";
        }

        if (
            name.includes(
                "taxon"
            ) ||
            name.includes(
                "taxonomy"
            )
        ) {
            return "taxon";
        }

        if (
            name.includes(
                "map"
            )
        ) {
            return "map";
        }

        if (
            name.includes(
                "visual"
            ) ||
            name.includes(
                "renderer"
            )
        ) {
            return "visualization";
        }

        if (
            name.includes(
                "download"
            )
        ) {
            return "download";
        }

        if (
            name.includes(
                "export"
            )
        ) {
            return "export";
        }

        if (
            name.includes(
                "import"
            )
        ) {
            return "import";
        }

        if (
            name.includes(
                "notification"
            )
        ) {
            return "notification";
        }

        if (
            name.includes(
                "bookmark"
            )
        ) {
            return "bookmark";
        }

        if (
            name.includes(
                "api"
            )
        ) {
            return "api";
        }

        if (
            name.includes(
                "scan"
            )
        ) {
            return "scan";
        }

        if (
            name.includes(
                "library"
            )
        ) {
            return "library";
        }

        if (
            name.includes(
                "error"
            )
        ) {
            return "error";
        }

        if (
            name.includes(
                "warning"
            ) ||
            name.includes(
                "warn"
            )
        ) {
            return "warning";
        }

        return "system";
    }

    function inferCategoryFromType(type) {
        switch (type) {
            case "command":
            case "system":
            case "error":
            case "warning":
                return "system";

            case "search":
            case "library":
            case "import":
            case "export":
                return "data";

            case "species":
            case "taxon":
                return "taxonomy";

            case "provider":
                return "provider";

            case "map":
            case "visualization":
                return "visualization";

            case "api":
            case "scan":
                return "network";

            case "download":
                return "archive";

            case "notification":
            case "bookmark":
                return "interface";

            default:
                return "other";
        }
    }

    function normalizeRecord(
        input,
        options = {}
    ) {
        const type =
            normalizeType(
                input.type ||
                inferTypeFromEvent(
                    input.event
                )
            );

        const timestamp =
            normalizeTimestamp(
                input.timestamp
            );

        return {
            id:
                normalizeText(
                    input.id
                ) ||
                makeID(),

            type,

            category:
                normalizeCategory(
                    input.category ||
                    inferCategoryFromType(
                        type
                    )
                ),

            title:
                normalizeText(
                    input.title ||
                    input.command ||
                    input.query ||
                    input.event ||
                    type
                ),

            description:
                normalizeText(
                    input.description ||
                    input.message ||
                    ""
                ),

            timestamp,

            elapsed:
                Number.isFinite(
                    Number(
                        input.elapsed
                    )
                )
                    ? Number(
                        input.elapsed
                    )
                    : null,

            duration:
                Number.isFinite(
                    Number(
                        input.duration
                    )
                )
                    ? Number(
                        input.duration
                    )
                    : null,

            command:
                normalizeText(
                    input.command
                ),

            arguments:
                Array.isArray(
                    input.arguments
                )
                    ? [
                        ...input.arguments
                    ]
                    : Array.isArray(
                        input.args
                    )
                        ? [
                            ...input.args
                        ]
                        : [],

            query:
                normalizeText(
                    input.query
                ),

            provider:
                normalizeText(
                    input.provider
                ),

            dataset:
                normalizeText(
                    input.dataset ||
                    input.collection
                ),

            species:
                normalizeText(
                    input.species ||
                    input.scientificName ||
                    input.scientific_name
                ),

            commonName:
                normalizeText(
                    input.commonName ||
                    input.common_name
                ),

            taxon:
                normalizeText(
                    input.taxon
                ),

            genus:
                normalizeText(
                    input.genus
                ),

            family:
                normalizeText(
                    input.family
                ),

            order:
                normalizeText(
                    input.order
                ),

            className:
                normalizeText(
                    input.className ||
                    input.class_name ||
                    input.class
                ),

            phylum:
                normalizeText(
                    input.phylum
                ),

            kingdom:
                normalizeText(
                    input.kingdom
                ),

            resultCount:
                Number.isFinite(
                    Number(
                        input.resultCount
                    )
                )
                    ? Number(
                        input.resultCount
                    )
                    : Number.isFinite(
                        Number(
                            input.count
                        )
                    )
                        ? Number(
                            input.count
                        )
                        : null,

            success:
                input.success ===
                undefined
                    ? null
                    : Boolean(
                        input.success
                    ),

            warning:
                Boolean(
                    input.warning
                ),

            error:
                input.error
                    ? safeSerialize(
                        input.error
                    )
                    : null,

            event:
                normalizeText(
                    input.event
                ),

            source:
                normalizeText(
                    input.source ||
                    "terminal"
                ),

            pinned:
                Boolean(
                    input.pinned
                ),

            favorite:
                Boolean(
                    input.favorite
                ),

            count:
                Number.isFinite(
                    Number(
                        input.count
                    )
                )
                    ? Math.max(
                        1,
                        Number(
                            input.count
                        )
                    )
                    : 1,

            metadata:
                options.includeMetadata ===
                false
                    ? {}
                    : safeSerialize(
                        input.metadata ||
                        {}
                    )
        };
    }

    /*
    ==========================================================================
    Recent Activity Service
    ==========================================================================
    */

    class RecentActivity
        extends EventTarget {
        constructor(
            context,
            options = {}
        ) {
            super();

            this.context =
                context;

            this.options = {
                limit:
                    clampInteger(
                        options.limit,
                        DEFAULT_OPTIONS.limit,
                        10,
                        100000
                    ),

                persist:
                    parseBoolean(
                        options.persist,
                        DEFAULT_OPTIONS.persist
                    ),

                restore:
                    parseBoolean(
                        options.restore,
                        DEFAULT_OPTIONS.restore
                    ),

                deduplicate:
                    parseBoolean(
                        options.deduplicate,
                        DEFAULT_OPTIONS.deduplicate
                    ),

                deduplicateWindow:
                    clampInteger(
                        options.deduplicateWindow,
                        DEFAULT_OPTIONS.deduplicateWindow,
                        0,
                        600000
                    ),

                persistDelay:
                    clampInteger(
                        options.persistDelay,
                        DEFAULT_OPTIONS.persistDelay,
                        0,
                        60000
                    ),

                includeMetadata:
                    parseBoolean(
                        options.includeMetadata,
                        DEFAULT_OPTIONS.includeMetadata
                    ),

                autoBind:
                    parseBoolean(
                        options.autoBind,
                        DEFAULT_OPTIONS.autoBind
                    )
            };

            this.items =
                [];

            this.storage =
                safeStorage();

            this.storageKey =
                `${STORAGE_PREFIX}${
                    context.root?.
                        dataset.
                        terminalInstance ||
                    "default"
                }`;

            this.bindings =
                [];

            this.persistTimer =
                0;

            this.destroyed =
                false;

            if (
                this.options.restore
            ) {
                this.restore();
            }

            if (
                this.options.autoBind
            ) {
                this.bindEvents();
            }
        }

        /*
        ======================================================================
        Recording
        ======================================================================
        */

        findDuplicate(
            record
        ) {
            if (
                !this.options.deduplicate
            ) {
                return null;
            }

            const threshold =
                Date.now() -
                this.options.deduplicateWindow;

            for (
                let index =
                    this.items.length -
                    1;
                index >=
                    0;
                index -=
                    1
            ) {
                const item =
                    this.items[
                        index
                    ];

                if (
                    Date.parse(
                        item.timestamp
                    ) <
                    threshold
                ) {
                    break;
                }

                if (
                    item.type ===
                        record.type &&
                    item.title ===
                        record.title &&
                    item.command ===
                        record.command &&
                    item.query ===
                        record.query &&
                    item.provider ===
                        record.provider &&
                    item.species ===
                        record.species
                ) {
                    return item;
                }
            }

            return null;
        }

        add(
            input
        ) {
            if (this.destroyed) {
                throw new Error(
                    "RecentActivity has been destroyed."
                );
            }

            const record =
                normalizeRecord(
                    input,
                    {
                        includeMetadata:
                            this.options.includeMetadata
                    }
                );

            const duplicate =
                this.findDuplicate(
                    record
                );

            if (duplicate) {
                duplicate.count +=
                    1;

                duplicate.timestamp =
                    record.timestamp;

                duplicate.duration =
                    record.duration ??
                    duplicate.duration;

                duplicate.elapsed =
                    record.elapsed ??
                    duplicate.elapsed;

                duplicate.resultCount =
                    record.resultCount ??
                    duplicate.resultCount;

                duplicate.success =
                    record.success ??
                    duplicate.success;

                duplicate.warning =
                    record.warning ||
                    duplicate.warning;

                duplicate.error =
                    record.error ||
                    duplicate.error;

                duplicate.metadata = {
                    ...duplicate.metadata,
                    ...record.metadata
                };

                this.schedulePersist();
                this.emit(
                    "duplicate",
                    duplicate
                );

                return duplicate;
            }

            this.items.push(
                record
            );

            if (
                this.items.length >
                this.options.limit
            ) {
                const pinned =
                    this.items.filter(
                        item =>
                            item.pinned
                    );

                const unpinned =
                    this.items.filter(
                        item =>
                            !item.pinned
                    );

                const remaining =
                    Math.max(
                        0,
                        this.options.limit -
                        pinned.length
                    );

                this.items = [
                    ...pinned,
                    ...unpinned.slice(
                        -remaining
                    )
                ]
                    .sort(
                        (
                            left,
                            right
                        ) =>
                            Date.parse(
                                left.timestamp
                            ) -
                            Date.parse(
                                right.timestamp
                            )
                    )
                    .slice(
                        -this.options.limit
                    );
            }

            this.schedulePersist();
            this.emit(
                "add",
                record
            );

            return record;
        }

        record(
            type,
            title,
            detail = {}
        ) {
            return this.add({
                ...detail,
                type,
                title
            });
        }

        recordEvent(
            eventName,
            detail = {}
        ) {
            const type =
                inferTypeFromEvent(
                    eventName
                );

            const raw =
                detail?.parsed?.raw ||
                detail?.command ||
                detail?.query ||
                detail?.message ||
                eventName;

            const input = {
                event:
                    eventName,

                type,

                category:
                    inferCategoryFromType(
                        type
                    ),

                title:
                    detail.title ||
                    raw,

                description:
                    detail.description ||
                    detail.message ||
                    "",

                command:
                    detail.parsed?.raw ||
                    detail.command ||
                    "",

                arguments:
                    detail.args ||
                    detail.parsed?.args ||
                    [],

                query:
                    detail.query ||
                    "",

                provider:
                    detail.provider ||
                    detail.providerId ||
                    "",

                dataset:
                    detail.dataset ||
                    detail.collection ||
                    "",

                species:
                    detail.species ||
                    detail.scientificName ||
                    detail.scientific_name ||
                    "",

                commonName:
                    detail.commonName ||
                    detail.common_name ||
                    "",

                resultCount:
                    detail.resultCount ??
                    detail.count ??
                    null,

                duration:
                    detail.duration ??
                    detail.elapsed ??
                    null,

                success:
                    eventName.includes(
                        "error"
                    )
                        ? false
                        : detail.success ??
                        null,

                warning:
                    eventName.includes(
                        "warning"
                    ) ||
                    eventName.includes(
                        "warn"
                    ),

                error:
                    detail.error ||
                    null,

                source:
                    detail.source ||
                    "event",

                metadata:
                    detail
            };

            return this.add(
                input
            );
        }

        /*
        ======================================================================
        Event Binding
        ======================================================================
        */

        bind(
            target,
            eventName,
            handler
        ) {
            if (
                !target ||
                typeof target.addEventListener !==
                "function"
            ) {
                return;
            }

            target.addEventListener(
                eventName,
                handler
            );

            this.bindings.push({
                target,
                eventName,
                handler
            });
        }

        bindEvents() {
            const eventNames = [
                "speciedex:terminal-command-start",
                "speciedex:terminal-command-complete",
                "speciedex:terminal-command-error",
                "speciedex:terminal-search",
                "speciedex:terminal-provider-query",
                "speciedex:terminal-provider-health",
                "speciedex:terminal-map-open",
                "speciedex:terminal-renderer",
                "speciedex:terminal-download",
                "speciedex:terminal-export",
                "speciedex:terminal-import",
                "speciedex:terminal-notification",
                "speciedex:terminal-notification-notify",
                "speciedex:terminal-bookmark",
                "speciedex:terminal-library-update",
                "speciedex:terminal-library-updated",
                "speciedex:terminal-api-request",
                "speciedex:terminal-scan",
                "speciedex:terminal-progress-complete",
                "speciedex:terminal-progress-fail",
                "speciedex:terminal-loading-task-end",
                "speciedex:terminal-loading-task-fail",
                "speciedex:terminal-provider-manager-registered",
                "speciedex:terminal-provider-manager-updated",
                "speciedex:terminal-provider-manager-removed"
            ];

            const handler =
                event =>
                    this.recordEvent(
                        event.type,
                        event.detail ||
                        {}
                    );

            for (const eventName of eventNames) {
                this.bind(
                    this.context.root,
                    eventName,
                    handler
                );

                this.bind(
                    document,
                    eventName,
                    handler
                );
            }
        }

        /*
        ======================================================================
        Querying
        ======================================================================
        */

        get(
            id
        ) {
            return (
                this.items.find(
                    item =>
                        item.id ===
                        String(id)
                ) ||
                null
            );
        }

        find(
            query
        ) {
            const needle =
                normalizeText(
                    query
                ).toLowerCase();

            if (!needle) {
                return [
                    ...this.items
                ];
            }

            return this.items.filter(
                item =>
                    [
                        item.title,
                        item.description,
                        item.command,
                        item.query,
                        item.provider,
                        item.dataset,
                        item.species,
                        item.commonName,
                        item.taxon,
                        item.genus,
                        item.family,
                        item.order,
                        item.className,
                        item.phylum,
                        item.kingdom,
                        item.type,
                        item.category,
                        item.event,
                        item.source,
                        JSON.stringify(
                            item.metadata
                        )
                    ]
                        .join(" ")
                        .toLowerCase()
                        .includes(
                            needle
                        )
            );
        }

        filter(
            options = {}
        ) {
            const type =
                options.type
                    ? normalizeType(
                        options.type
                    )
                    : null;

            const category =
                options.category
                    ? normalizeCategory(
                        options.category
                    )
                    : null;

            const provider =
                normalizeText(
                    options.provider
                ).toLowerCase();

            const species =
                normalizeText(
                    options.species
                ).toLowerCase();

            const dataset =
                normalizeText(
                    options.dataset
                ).toLowerCase();

            const contains =
                normalizeText(
                    options.contains ||
                    options.text
                ).toLowerCase();

            const pinned =
                options.pinned;

            const favorite =
                options.favorite;

            const success =
                options.success;

            const since =
                options.since
                    ? Date.parse(
                        options.since
                    )
                    : null;

            const until =
                options.until
                    ? Date.parse(
                        options.until
                    )
                    : null;

            let results =
                this.items.filter(
                    item =>
                        (
                            !type ||
                            item.type ===
                            type
                        ) &&
                        (
                            !category ||
                            item.category ===
                            category
                        ) &&
                        (
                            !provider ||
                            item.provider
                                .toLowerCase()
                                .includes(
                                    provider
                                )
                        ) &&
                        (
                            !species ||
                            [
                                item.species,
                                item.commonName,
                                item.taxon,
                                item.genus
                            ]
                                .join(" ")
                                .toLowerCase()
                                .includes(
                                    species
                                )
                        ) &&
                        (
                            !dataset ||
                            item.dataset
                                .toLowerCase()
                                .includes(
                                    dataset
                                )
                        ) &&
                        (
                            pinned ===
                                undefined ||
                            item.pinned ===
                            pinned
                        ) &&
                        (
                            favorite ===
                                undefined ||
                            item.favorite ===
                            favorite
                        ) &&
                        (
                            success ===
                                undefined ||
                            item.success ===
                            success
                        ) &&
                        (
                            !Number.isFinite(
                                since
                            ) ||
                            Date.parse(
                                item.timestamp
                            ) >=
                            since
                        ) &&
                        (
                            !Number.isFinite(
                                until
                            ) ||
                            Date.parse(
                                item.timestamp
                            ) <=
                            until
                        ) &&
                        (
                            !contains ||
                            [
                                item.title,
                                item.description,
                                item.command,
                                item.query,
                                item.provider,
                                item.dataset,
                                item.species,
                                item.commonName,
                                item.event,
                                JSON.stringify(
                                    item.metadata
                                )
                            ]
                                .join(" ")
                                .toLowerCase()
                                .includes(
                                    contains
                                )
                        )
                );

            const sort =
                String(
                    options.sort ||
                    "newest"
                ).toLowerCase();

            results.sort(
                (
                    left,
                    right
                ) => {
                    switch (sort) {
                        case "oldest":
                            return (
                                Date.parse(
                                    left.timestamp
                                ) -
                                Date.parse(
                                    right.timestamp
                                )
                            );

                        case "type":
                            return (
                                left.type.localeCompare(
                                    right.type
                                ) ||
                                Date.parse(
                                    right.timestamp
                                ) -
                                Date.parse(
                                    left.timestamp
                                )
                            );

                        case "title":
                            return left.title.localeCompare(
                                right.title
                            );

                        case "newest":
                        default:
                            return (
                                Date.parse(
                                    right.timestamp
                                ) -
                                Date.parse(
                                    left.timestamp
                                )
                            );
                    }
                }
            );

            const limit =
                clampInteger(
                    options.limit,
                    100,
                    1,
                    this.options.limit
                );

            return results.slice(
                0,
                limit
            );
        }

        groupBy(
            field = "type",
            options = {}
        ) {
            const records =
                this.filter({
                    ...options,
                    limit:
                        options.limit ||
                        this.options.limit
                });

            const groups =
                new Map();

            for (const item of records) {
                const key =
                    normalizeText(
                        item[
                            field
                        ]
                    ) ||
                    "unknown";

                if (
                    !groups.has(
                        key
                    )
                ) {
                    groups.set(
                        key,
                        []
                    );
                }

                groups.get(
                    key
                ).push(
                    item
                );
            }

            return Object.fromEntries(
                [...groups.entries()]
            );
        }

        /*
        ======================================================================
        Pins and Favorites
        ======================================================================
        */

        pin(
            id
        ) {
            const item =
                this.get(
                    id
                );

            if (!item) {
                return null;
            }

            item.pinned =
                true;

            this.schedulePersist();
            this.emit(
                "pin",
                item
            );

            return item;
        }

        unpin(
            id
        ) {
            const item =
                this.get(
                    id
                );

            if (!item) {
                return null;
            }

            item.pinned =
                false;

            this.schedulePersist();
            this.emit(
                "unpin",
                item
            );

            return item;
        }

        favorite(
            id,
            value = true
        ) {
            const item =
                this.get(
                    id
                );

            if (!item) {
                return null;
            }

            item.favorite =
                Boolean(
                    value
                );

            this.schedulePersist();
            this.emit(
                item.favorite
                    ? "favorite"
                    : "unfavorite",
                item
            );

            return item;
        }

        /*
        ======================================================================
        Statistics and Timeline
        ======================================================================
        */

        statistics() {
            const byType =
                Object.fromEntries(
                    TYPES.map(
                        type => [
                            type,
                            0
                        ]
                    )
                );

            const byCategory =
                Object.fromEntries(
                    CATEGORIES.map(
                        category => [
                            category,
                            0
                        ]
                    )
                );

            const byProvider =
                {};

            const bySpecies =
                {};

            let success =
                0;

            let failure =
                0;

            let warnings =
                0;

            let totalDuration =
                0;

            let durationCount =
                0;

            for (const item of this.items) {
                byType[
                    item.type
                ] =
                    (
                        byType[
                            item.type
                        ] ||
                        0
                    ) +
                    1;

                byCategory[
                    item.category
                ] =
                    (
                        byCategory[
                            item.category
                        ] ||
                        0
                    ) +
                    1;

                if (
                    item.provider
                ) {
                    byProvider[
                        item.provider
                    ] =
                        (
                            byProvider[
                                item.provider
                            ] ||
                            0
                        ) +
                        1;
                }

                if (
                    item.species
                ) {
                    bySpecies[
                        item.species
                    ] =
                        (
                            bySpecies[
                                item.species
                            ] ||
                            0
                        ) +
                        1;
                }

                if (
                    item.success ===
                    true
                ) {
                    success +=
                        1;
                }

                if (
                    item.success ===
                    false ||
                    item.error
                ) {
                    failure +=
                        1;
                }

                if (
                    item.warning
                ) {
                    warnings +=
                        1;
                }

                if (
                    Number.isFinite(
                        item.duration
                    )
                ) {
                    totalDuration +=
                        item.duration;

                    durationCount +=
                        1;
                }
            }

            const topProviders =
                Object.entries(
                    byProvider
                )
                    .sort(
                        (
                            left,
                            right
                        ) =>
                            right[1] -
                            left[1]
                    )
                    .slice(
                        0,
                        20
                    )
                    .map(
                        (
                            [
                                provider,
                                count
                            ]
                        ) => ({
                            provider,
                            count
                        })
                    );

            const topSpecies =
                Object.entries(
                    bySpecies
                )
                    .sort(
                        (
                            left,
                            right
                        ) =>
                            right[1] -
                            left[1]
                    )
                    .slice(
                        0,
                        20
                    )
                    .map(
                        (
                            [
                                species,
                                count
                            ]
                        ) => ({
                            species,
                            count
                        })
                    );

            return {
                version:
                    VERSION,

                total:
                    this.items.length,

                pinned:
                    this.items.filter(
                        item =>
                            item.pinned
                    ).length,

                favorites:
                    this.items.filter(
                        item =>
                            item.favorite
                    ).length,

                success,
                failure,
                warnings,

                averageDuration:
                    durationCount
                        ? totalDuration /
                        durationCount
                        : null,

                oldest:
                    this.items[0]?.timestamp ||
                    null,

                newest:
                    this.items[
                        this.items.length -
                        1
                    ]?.timestamp ||
                    null,

                byType,
                byCategory,
                topProviders,
                topSpecies
            };
        }

        timeline(
            options = {}
        ) {
            const interval =
                String(
                    options.interval ||
                    "hour"
                ).toLowerCase();

            const records =
                this.filter({
                    ...options,
                    limit:
                        options.limit ||
                        this.options.limit,
                    sort:
                        "oldest"
                });

            const buckets =
                new Map();

            for (const item of records) {
                const date =
                    new Date(
                        item.timestamp
                    );

                let key;

                switch (interval) {
                    case "day":
                        key =
                            date.toISOString().slice(
                                0,
                                10
                            );
                        break;

                    case "minute":
                        key =
                            date.toISOString().slice(
                                0,
                                16
                            );
                        break;

                    case "month":
                        key =
                            date.toISOString().slice(
                                0,
                                7
                            );
                        break;

                    case "hour":
                    default:
                        key =
                            date.toISOString().slice(
                                0,
                                13
                            );
                }

                if (
                    !buckets.has(
                        key
                    )
                ) {
                    buckets.set(
                        key,
                        {
                            timestamp:
                                key,
                            count:
                                0,
                            types:
                                {}
                        }
                    );
                }

                const bucket =
                    buckets.get(
                        key
                    );

                bucket.count +=
                    1;

                bucket.types[
                    item.type
                ] =
                    (
                        bucket.types[
                            item.type
                        ] ||
                        0
                    ) +
                    1;
            }

            return [
                ...buckets.values()
            ];
        }

        /*
        ======================================================================
        Persistence
        ======================================================================
        */

        schedulePersist() {
            if (
                !this.options.persist ||
                !this.storage
            ) {
                return;
            }

            window.clearTimeout(
                this.persistTimer
            );

            this.persistTimer =
                window.setTimeout(
                    () =>
                        this.persist(),
                    this.options.persistDelay
                );
        }

        persist() {
            if (
                !this.options.persist ||
                !this.storage
            ) {
                return false;
            }

            try {
                this.storage.setItem(
                    this.storageKey,
                    JSON.stringify({
                        version:
                            VERSION,

                        items:
                            this.items
                    })
                );

                return true;
            } catch (error) {
                this.emit(
                    "persistence-error",
                    {
                        error:
                            error.message
                    }
                );

                return false;
            }
        }

        restore() {
            if (!this.storage) {
                return [];
            }

            try {
                const payload =
                    JSON.parse(
                        this.storage.getItem(
                            this.storageKey
                        ) ||
                        "null"
                    );

                if (
                    !payload ||
                    !Array.isArray(
                        payload.items
                    )
                ) {
                    return [];
                }

                this.items =
                    payload.items
                        .map(
                            item =>
                                normalizeRecord(
                                    item,
                                    {
                                        includeMetadata:
                                            this.options.includeMetadata
                                    }
                                )
                        )
                        .slice(
                            -this.options.limit
                        );

                return [
                    ...this.items
                ];
            } catch (error) {
                this.emit(
                    "restore-error",
                    {
                        error:
                            error.message
                    }
                );

                return [];
            }
        }

        clear(
            options = {}
        ) {
            const preservePinned =
                options.preservePinned ===
                true;

            const previous =
                this.items.length;

            this.items =
                preservePinned
                    ? this.items.filter(
                        item =>
                            item.pinned
                    )
                    : [];

            this.schedulePersist();

            this.emit(
                "clear",
                {
                    removed:
                        previous -
                        this.items.length,

                    remaining:
                        this.items.length
                }
            );

            return previous -
                this.items.length;
        }

        /*
        ======================================================================
        Export
        ======================================================================
        */

        exportJSON(
            options = {}
        ) {
            return {
                version:
                    VERSION,

                generatedAt:
                    new Date().toISOString(),

                statistics:
                    this.statistics(),

                items:
                    this.filter({
                        ...options,
                        limit:
                            options.limit ||
                            this.options.limit
                    })
            };
        }

        exportCSV(
            options = {}
        ) {
            const items =
                this.filter({
                    ...options,
                    limit:
                        options.limit ||
                        this.options.limit,
                    sort:
                        options.sort ||
                        "oldest"
                });

            const header = [
                "id",
                "timestamp",
                "type",
                "category",
                "title",
                "description",
                "command",
                "query",
                "provider",
                "dataset",
                "species",
                "common_name",
                "taxon",
                "genus",
                "family",
                "order",
                "class",
                "phylum",
                "kingdom",
                "result_count",
                "success",
                "warning",
                "duration_ms",
                "pinned",
                "favorite",
                "count",
                "event",
                "source",
                "metadata"
            ];

            const lines = [
                header.join(",")
            ];

            for (const item of items) {
                lines.push(
                    [
                        item.id,
                        item.timestamp,
                        item.type,
                        item.category,
                        item.title,
                        item.description,
                        item.command,
                        item.query,
                        item.provider,
                        item.dataset,
                        item.species,
                        item.commonName,
                        item.taxon,
                        item.genus,
                        item.family,
                        item.order,
                        item.className,
                        item.phylum,
                        item.kingdom,
                        item.resultCount,
                        item.success,
                        item.warning,
                        item.duration,
                        item.pinned,
                        item.favorite,
                        item.count,
                        item.event,
                        item.source,
                        JSON.stringify(
                            item.metadata
                        )
                    ]
                        .map(
                            escapeCSV
                        )
                        .join(",")
                );
            }

            return lines.join(
                "\n"
            );
        }

        /*
        ======================================================================
        Events and Teardown
        ======================================================================
        */

        emit(
            type,
            detail
        ) {
            this.dispatchEvent(
                new CustomEvent(
                    type,
                    {
                        detail
                    }
                )
            );

            this.context.events?.emit?.(
                `recent:${type}`,
                detail
            );

            this.context.root?.
                dispatchEvent?.(
                    new CustomEvent(
                        `speciedex:terminal-recent-${type}`,
                        {
                            bubbles:
                                true,

                            detail
                        }
                    )
                );

            document.dispatchEvent(
                new CustomEvent(
                    `speciedex:terminal-recent-${type}`,
                    {
                        detail
                    }
                )
            );
        }

        destroy() {
            if (this.destroyed) {
                return;
            }

            window.clearTimeout(
                this.persistTimer
            );

            for (const binding of this.bindings) {
                binding.target.removeEventListener(
                    binding.eventName,
                    binding.handler
                );
            }

            this.bindings =
                [];

            this.destroyed =
                true;

            this.dispatchEvent(
                new CustomEvent(
                    "destroy"
                )
            );
        }
    }

    /*
    ==========================================================================
    Initialization
    ==========================================================================
    */

    function initialize(
        context
    ) {
        if (
            context.recent instanceof
            RecentActivity
        ) {
            return context.recent;
        }

        const root =
            context.root;

        const recent =
            new RecentActivity(
                context,
                {
                    limit:
                        clampInteger(
                            root?.
                                dataset.
                                terminalRecentLimit,
                            DEFAULT_OPTIONS.limit,
                            10,
                            100000
                        ),

                    persist:
                        parseBoolean(
                            root?.
                                dataset.
                                terminalRecentPersist,
                            true
                        ),

                    restore:
                        parseBoolean(
                            root?.
                                dataset.
                                terminalRecentRestore,
                            true
                        ),

                    deduplicate:
                        parseBoolean(
                            root?.
                                dataset.
                                terminalRecentDeduplicate,
                            true
                        ),

                    deduplicateWindow:
                        clampInteger(
                            root?.
                                dataset.
                                terminalRecentDeduplicateWindow,
                            DEFAULT_OPTIONS.deduplicateWindow,
                            0,
                            600000
                        ),

                    includeMetadata:
                        parseBoolean(
                            root?.
                                dataset.
                                terminalRecentMetadata,
                            true
                        ),

                    autoBind:
                        parseBoolean(
                            root?.
                                dataset.
                                terminalRecentAutoBind,
                            true
                        )
                }
            );

        context.recent =
            recent;

        context.registerService?.(
            "recent",
            recent
        );

        return recent;
    }

    /*
    ==========================================================================
    Download Helper
    ==========================================================================
    */

    function download(
        content,
        filename,
        mime
    ) {
        const blob =
            new Blob(
                [
                    content
                ],
                {
                    type:
                        mime
                }
            );

        const url =
            URL.createObjectURL(
                blob
            );

        const anchor =
            document.createElement(
                "a"
            );

        anchor.href =
            url;

        anchor.download =
            filename;

        anchor.click();

        window.setTimeout(
            () =>
                URL.revokeObjectURL(
                    url
                ),
            1000
        );

        return filename;
    }

    /*
    ==========================================================================
    Commands
    ==========================================================================
    */

    const commands =
        [
            {
                name:
                    "recent",

                category:
                    "system",

                description:
                    "Display recent terminal activity.",

                usage:
                    "recent [count] [type] [contains]",

                handler: ({
                    args,
                    context,
                    writeJSON
                }) => {
                    const count =
                        clampInteger(
                            args[0],
                            25,
                            1,
                            1000
                        );

                    const possibleType =
                        normalizeText(
                            args[1]
                        ).toLowerCase();

                    const type =
                        TYPES.includes(
                            possibleType
                        )
                            ? possibleType
                            : null;

                    const contains =
                        type
                            ? args.slice(
                                2
                            ).join(
                                " "
                            )
                            : args.slice(
                                1
                            ).join(
                                " "
                            );

                    return writeJSON(
                        context.recent.filter({
                            limit:
                                count,
                            type,
                            contains,
                            sort:
                                "newest"
                        })
                    );
                }
            },

            {
                name:
                    "recent-search",

                category:
                    "system",

                description:
                    "Search recent activity.",

                usage:
                    "recent-search <query>",

                handler: ({
                    args,
                    context,
                    writeJSON
                }) => {
                    const query =
                        args.join(
                            " "
                        );

                    if (!query) {
                        throw new Error(
                            "A recent-activity query is required."
                        );
                    }

                    return writeJSON(
                        context.recent.find(
                            query
                        )
                    );
                }
            },

            {
                name:
                    "recent-commands",

                category:
                    "system",

                description:
                    "Display recent commands.",

                usage:
                    "recent-commands [count]",

                handler: ({
                    args,
                    context,
                    writeJSON
                }) =>
                    writeJSON(
                        context.recent.filter({
                            type:
                                "command",
                            limit:
                                clampInteger(
                                    args[0],
                                    25,
                                    1,
                                    1000
                                ),
                            sort:
                                "newest"
                        })
                    )
            },

            {
                name:
                    "recent-searches",

                category:
                    "system",

                description:
                    "Display recent searches.",

                usage:
                    "recent-searches [count]",

                handler: ({
                    args,
                    context,
                    writeJSON
                }) =>
                    writeJSON(
                        context.recent.filter({
                            type:
                                "search",
                            limit:
                                clampInteger(
                                    args[0],
                                    25,
                                    1,
                                    1000
                                ),
                            sort:
                                "newest"
                        })
                    )
            },

            {
                name:
                    "recent-providers",

                category:
                    "system",

                description:
                    "Display recent provider activity.",

                usage:
                    "recent-providers [count]",

                handler: ({
                    args,
                    context,
                    writeJSON
                }) =>
                    writeJSON(
                        context.recent.filter({
                            type:
                                "provider",
                            limit:
                                clampInteger(
                                    args[0],
                                    25,
                                    1,
                                    1000
                                ),
                            sort:
                                "newest"
                        })
                    )
            },

            {
                name:
                    "recent-taxa",

                category:
                    "system",

                description:
                    "Display recent taxonomic activity.",

                usage:
                    "recent-taxa [count]",

                handler: ({
                    args,
                    context,
                    writeJSON
                }) =>
                    writeJSON(
                        [
                            ...context.recent.filter({
                                type:
                                    "taxon",
                                limit:
                                    clampInteger(
                                        args[0],
                                        25,
                                        1,
                                        1000
                                    ),
                                sort:
                                    "newest"
                            }),
                            ...context.recent.filter({
                                type:
                                    "species",
                                limit:
                                    clampInteger(
                                        args[0],
                                        25,
                                        1,
                                        1000
                                    ),
                                sort:
                                    "newest"
                            })
                        ]
                            .sort(
                                (
                                    left,
                                    right
                                ) =>
                                    Date.parse(
                                        right.timestamp
                                    ) -
                                    Date.parse(
                                        left.timestamp
                                    )
                            )
                            .slice(
                                0,
                                clampInteger(
                                    args[0],
                                    25,
                                    1,
                                    1000
                                )
                            )
                    )
            },

            {
                name:
                    "recent-maps",

                category:
                    "system",

                description:
                    "Display recent map activity.",

                usage:
                    "recent-maps [count]",

                handler: ({
                    args,
                    context,
                    writeJSON
                }) =>
                    writeJSON(
                        context.recent.filter({
                            type:
                                "map",
                            limit:
                                clampInteger(
                                    args[0],
                                    25,
                                    1,
                                    1000
                                ),
                            sort:
                                "newest"
                        })
                    )
            },

            {
                name:
                    "recent-errors",

                category:
                    "system",

                description:
                    "Display recent errors.",

                usage:
                    "recent-errors [count]",

                handler: ({
                    args,
                    context,
                    writeJSON
                }) =>
                    writeJSON(
                        context.recent.filter({
                            type:
                                "error",
                            limit:
                                clampInteger(
                                    args[0],
                                    25,
                                    1,
                                    1000
                                ),
                            sort:
                                "newest"
                        })
                    )
            },

            {
                name:
                    "recent-warnings",

                category:
                    "system",

                description:
                    "Display recent warnings.",

                usage:
                    "recent-warnings [count]",

                handler: ({
                    args,
                    context,
                    writeJSON
                }) =>
                    writeJSON(
                        context.recent.filter({
                            type:
                                "warning",
                            limit:
                                clampInteger(
                                    args[0],
                                    25,
                                    1,
                                    1000
                                ),
                            sort:
                                "newest"
                        })
                    )
            },

            {
                name:
                    "recent-pin",

                category:
                    "system",

                description:
                    "Pin a recent activity entry.",

                usage:
                    "recent-pin <id>",

                handler: ({
                    args,
                    context,
                    writeJSON
                }) => {
                    const item =
                        context.recent.pin(
                            args[0]
                        );

                    if (!item) {
                        throw new Error(
                            `Unknown recent activity ID: ${args[0]}`
                        );
                    }

                    return writeJSON(
                        item
                    );
                }
            },

            {
                name:
                    "recent-unpin",

                category:
                    "system",

                description:
                    "Unpin a recent activity entry.",

                usage:
                    "recent-unpin <id>",

                handler: ({
                    args,
                    context,
                    writeJSON
                }) => {
                    const item =
                        context.recent.unpin(
                            args[0]
                        );

                    if (!item) {
                        throw new Error(
                            `Unknown recent activity ID: ${args[0]}`
                        );
                    }

                    return writeJSON(
                        item
                    );
                }
            },

            {
                name:
                    "recent-favorite",

                category:
                    "system",

                description:
                    "Favorite or unfavorite a recent activity entry.",

                usage:
                    "recent-favorite <id> [true|false]",

                handler: ({
                    args,
                    context,
                    writeJSON
                }) => {
                    const item =
                        context.recent.favorite(
                            args[0],
                            args[1] ===
                                undefined
                                ? true
                                : parseBoolean(
                                    args[1],
                                    true
                                )
                        );

                    if (!item) {
                        throw new Error(
                            `Unknown recent activity ID: ${args[0]}`
                        );
                    }

                    return writeJSON(
                        item
                    );
                }
            },

            {
                name:
                    "recent-stats",

                category:
                    "system",

                description:
                    "Display recent-activity statistics.",

                usage:
                    "recent-stats",

                handler: ({
                    context,
                    writeJSON
                }) =>
                    writeJSON(
                        context.recent.statistics()
                    )
            },

            {
                name:
                    "recent-timeline",

                category:
                    "system",

                description:
                    "Display recent activity grouped over time.",

                usage:
                    "recent-timeline [minute|hour|day|month]",

                handler: ({
                    args,
                    context,
                    writeJSON
                }) =>
                    writeJSON(
                        context.recent.timeline({
                            interval:
                                args[0] ||
                                "hour"
                        })
                    )
            },

            {
                name:
                    "recent-clear",

                category:
                    "system",

                description:
                    "Clear recent activity.",

                usage:
                    "recent-clear [--preserve-pinned]",

                handler: ({
                    parsed,
                    context,
                    write
                }) => {
                    const count =
                        context.recent.clear({
                            preservePinned:
                                parsed.flags[
                                    "preserve-pinned"
                                ] ===
                                true
                        });

                    return write(
                        `Cleared ${count} recent activity entr${count === 1 ? "y" : "ies"}.`,
                        "success"
                    );
                }
            },

            {
                name:
                    "recent-export",

                category:
                    "system",

                description:
                    "Export recent activity as JSON or CSV.",

                usage:
                    "recent-export [json|csv] [filename]",

                handler: ({
                    args,
                    context,
                    write
                }) => {
                    const format =
                        String(
                            args[0] ||
                            "json"
                        ).toLowerCase();

                    if (
                        format ===
                        "csv"
                    ) {
                        const filename =
                            args[1] ||
                            "speciedex-terminal-recent.csv";

                        download(
                            context.recent.exportCSV(),
                            filename,
                            "text/csv"
                        );

                        return write(
                            `Recent activity exported to ${filename}.`,
                            "success"
                        );
                    }

                    const filename =
                        args[1] ||
                        "speciedex-terminal-recent.json";

                    download(
                        JSON.stringify(
                            context.recent.exportJSON(),
                            null,
                            2
                        ),
                        filename,
                        "application/json"
                    );

                    return write(
                        `Recent activity exported to ${filename}.`,
                        "success"
                    );
                }
            }
        ];

    /*
    ==========================================================================
    Public Module API
    ==========================================================================
    */

    const api =
        Object.freeze({
            name:
                MODULE_NAME,

            version:
                VERSION,

            STORAGE_PREFIX,
            DEFAULT_OPTIONS,
            TYPES,
            CATEGORIES,
            RecentActivity,

            makeID,
            normalizeText,
            normalizeType,
            normalizeCategory,
            parseBoolean,
            clampInteger,
            safeSerialize,
            normalizeTimestamp,
            inferTypeFromEvent,
            inferCategoryFromType,
            normalizeRecord,

            initialize,
            mount:
                initialize,
            init:
                initialize,
            setup:
                initialize,

            commands
        });

    window.SpeciedexTerminalRecent =
        api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules ||
        {};

    window.SpeciedexTerminalModules[
        MODULE_NAME
    ] =
        api;

    document.dispatchEvent(
        new CustomEvent(
            "speciedex:terminal-module-available",
            {
                detail: {
                    name:
                        MODULE_NAME,

                    module:
                        api
                }
            }
        )
    );
})(window, document);
