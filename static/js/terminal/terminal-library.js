/*
========================================================================
Speciedex.org
Terminal Data Library
========================================================================

In-memory data library service for SpeciedexTerminal.

Provides:

    • named record collections
    • collection metadata
    • set, append, merge, update, remove, and clear operations
    • duplicate handling
    • collection subscriptions
    • event propagation
    • persistence hooks
    • import and export
    • collection statistics
    • command-based inspection and mutation

The library acts as the shared local data layer used by search, indexing,
providers, archives, imports, exports, statistics, and visualizations.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME =
        "Library";

    const VERSION =
        "2.2.0";

    const LIBRARY_SYMBOL =
        Symbol.for(
            "speciedex.terminal.library.instance"
        );

    const DEFAULT_COLLECTION =
        "records";

    const RESERVED_KEYS =
        new Set([
            "__proto__",
            "prototype",
            "constructor"
        ]);

    const activeDispatches =
        new WeakMap();

    const DEFAULT_MAX_RECORDS =
        500000;

    const DEFAULT_ID_FIELDS =
        Object.freeze([
            "speciedex_id",
            "speciedexId",
            "id",
            "key",
            "uuid",
            "provider_id",
            "providerId",
            "taxon_id",
            "taxonId",
            "gbif_key",
            "gbifKey",
            "worms_id",
            "wormsId",
            "itis_tsn",
            "itisTsn"
        ]);

    /*
    ==========================================================================
    Utilities
    ==========================================================================
    */

    function isObject(value) {
        return (
            value !== null &&
            typeof value === "object" &&
            !Array.isArray(value)
        );
    }

    function dispatch(target, name, detail, options = {}) {
        if (
            !target ||
            typeof target.dispatchEvent !== "function" ||
            !name
        ) {
            return false;
        }

        let names =
            activeDispatches.get(target);

        if (!names) {
            names = new Set();
            activeDispatches.set(
                target,
                names
            );
        }

        if (names.has(name)) {
            return false;
        }

        names.add(name);

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
        } finally {
            names.delete(name);
        }
    }

    function nowISO(value = Date.now()) {
        const date =
            value instanceof Date
                ? value
                : new Date(value);

        return Number.isFinite(date.getTime())
            ? date.toISOString()
            : nowISO();
    }

    function parseInteger(
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

    function safeStringify(value, compact = false) {
        const seen =
            new WeakSet();

        return JSON.stringify(
            value,
            (_key, item) => {
                if (
                    item &&
                    typeof item === "object"
                ) {
                    if (seen.has(item)) {
                        return "[Circular]";
                    }

                    seen.add(item);
                }

                if (typeof item === "bigint") {
                    return String(item);
                }

                return item;
            },
            compact ? 0 : 2
        );
    }

    function normalizeName(value) {
        const name =
            String(value ?? "")
                .normalize("NFKC")
                .trim()
                .toLowerCase()
                .replace(/\s+/g, "-")
                .replace(/-+/g, "-")
                .slice(0, 128);

        if (!name) {
            throw new Error(
                "Library collection name is required."
            );
        }

        if (
            RESERVED_KEYS.has(name) ||
            !/^[a-z0-9][a-z0-9:_-]*$/.test(
                name
            )
        ) {
            throw new Error(
                `Invalid library collection name: ${value}`
            );
        }

        return name;
    }

    function isRecord(value) {
        return (
            value !== null &&
            typeof value ===
                "object" &&
            !Array.isArray(value)
        );
    }

    function cloneRecord(
        record,
        seen = new WeakMap(),
        depth = 0
    ) {
        if (
            record === null ||
            record === undefined ||
            typeof record !== "object"
        ) {
            return record;
        }

        if (depth > 32) {
            return "[Truncated]";
        }

        if (
            typeof structuredClone === "function"
        ) {
            try {
                return structuredClone(record);
            } catch (_error) {
                /* Continue with fallback. */
            }
        }

        if (seen.has(record)) {
            return seen.get(record);
        }

        if (record instanceof Date) {
            return new Date(
                record.getTime()
            );
        }

        if (record instanceof RegExp) {
            return new RegExp(
                record.source,
                record.flags
            );
        }

        if (record instanceof Map) {
            const output = new Map();
            seen.set(record, output);

            for (
                const [key, value]
                of record.entries()
            ) {
                output.set(
                    cloneRecord(
                        key,
                        seen,
                        depth + 1
                    ),
                    cloneRecord(
                        value,
                        seen,
                        depth + 1
                    )
                );
            }

            return output;
        }

        if (record instanceof Set) {
            const output = new Set();
            seen.set(record, output);

            for (const value of record.values()) {
                output.add(
                    cloneRecord(
                        value,
                        seen,
                        depth + 1
                    )
                );
            }

            return output;
        }

        if (Array.isArray(record)) {
            const output = [];
            seen.set(record, output);

            for (const value of record) {
                output.push(
                    cloneRecord(
                        value,
                        seen,
                        depth + 1
                    )
                );
            }

            return output;
        }

        const output = {};
        seen.set(record, output);

        for (
            const [key, value]
            of Object.entries(record)
        ) {
            if (RESERVED_KEYS.has(key)) {
                continue;
            }

            output[key] =
                cloneRecord(
                    value,
                    seen,
                    depth + 1
                );
        }

        return output;
    }

    function cloneRecords(records) {
        return records.map(
            cloneRecord
        );
    }

    function resolveRecordID(
        record,
        fields =
            DEFAULT_ID_FIELDS
    ) {
        if (!isRecord(record)) {
            return null;
        }

        for (const field of fields) {
            const value =
                record[
                    field
                ];

            if (
                value !== undefined &&
                value !== null &&
                String(value).trim()
            ) {
                return String(value)
                    .trim()
                    .toLowerCase();
            }
        }

        return null;
    }

    function normalizeText(
        value
    ) {
        return String(
            value ??
            ""
        )
            .normalize(
                "NFKC"
            )
            .trim()
            .replace(
                /\s+/g,
                " "
            );
    }

    function deterministicRecordID(
        record
    ) {
        if (!isRecord(record)) {
            return null;
        }

        const scientificName =
            normalizeText(
                record.scientific_name ??
                record.scientificName ??
                record.canonical_name ??
                record.canonicalName ??
                record.name
            ).toLowerCase();

        const provider =
            normalizeText(
                record.provider ??
                record.source ??
                record.dataset ??
                record.authority
            ).toLowerCase();

        const rank =
            normalizeText(
                record.rank ??
                record.taxon_rank ??
                record.taxonRank
            ).toLowerCase();

        if (!scientificName) {
            return null;
        }

        return [
            scientificName,
            rank,
            provider
        ].join(
            "::"
        );
    }

    function recordSearchText(
        record
    ) {
        if (!isRecord(record)) {
            return "";
        }

        return [
            record.speciedex_id,
            record.speciedexId,
            record.id,
            record.uuid,
            record.taxon_id,
            record.taxonId,
            record.scientific_name,
            record.scientificName,
            record.canonical_name,
            record.canonicalName,
            record.common_name,
            record.commonName,
            record.rank,
            record.taxon_rank,
            record.provider,
            record.source,
            record.kingdom,
            record.phylum,
            record.class,
            record.order,
            record.family,
            record.genus,
            record.species,
            record.subspecies
        ]
            .filter(
                value =>
                    value !==
                        undefined &&
                    value !==
                        null
            )
            .map(
                normalizeText
            )
            .join(
                " "
            )
            .toLowerCase();
    }

    function safeStorage() {
        try {
            const key =
                "__speciedex_library_probe__";

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

    function parseBoolean(
        value,
        fallback = false
    ) {
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
            String(value)
                .trim()
                .toLowerCase();

        if (
            ["1", "true", "yes", "on", "enabled"].includes(
                normalized
            )
        ) {
            return true;
        }

        if (
            ["0", "false", "no", "off", "disabled"].includes(
                normalized
            )
        ) {
            return false;
        }

        return fallback;
    }

    /*
    ==========================================================================
    Data Library
    ==========================================================================
    */

    class DataLibrary
        extends EventTarget {
        constructor(
            context,
            options = {}
        ) {
            super();

            this.context =
                isObject(context)
                    ? context
                    : {};

            this.options = {
                cloneOnWrite:
                    parseBoolean(
                        options.cloneOnWrite,
                        true
                    ),

                cloneOnRead:
                    parseBoolean(
                        options.cloneOnRead,
                        false
                    ),

                persist:
                    parseBoolean(
                        options.persist,
                        false
                    ),

                storagePrefix:
                    String(
                        options.storagePrefix ||
                        "speciedex-terminal:library:"
                    ),

                idFields:
                    Array.isArray(
                        options.idFields
                    )
                        ? [
                            ...options.idFields
                        ]
                        : [
                            ...DEFAULT_ID_FIELDS
                        ],

                maxPersistedRecords:
                    parseInteger(
                        options.maxPersistedRecords,
                        5000,
                        0,
                        DEFAULT_MAX_RECORDS
                    ),

                maximumRecords:
                    parseInteger(
                        options.maximumRecords,
                        DEFAULT_MAX_RECORDS,
                        1,
                        5000000
                    )
            };

            this.collections =
                new Map();

            this.metadata =
                new Map();

            this.subscribers =
                new Map();

            this.storage =
                safeStorage();

            this.revision =
                0;

            this.ready =
                true;

            this.destroyed =
                false;

            this.watchers =
                new Set();

            this.emitting =
                false;

            this.syncingState =
                false;

            this.indexes =
                new Map();

            this.aliases =
                new Map([
                    [
                        "species",
                        DEFAULT_COLLECTION
                    ],
                    [
                        "canonical",
                        DEFAULT_COLLECTION
                    ],
                    [
                        "canonical-records",
                        DEFAULT_COLLECTION
                    ]
                ]);

            this.batchDepth =
                0;

            this.pendingEvents =
                [];
        }

        /*
        ======================================================================
        Internal Helpers
        ======================================================================
        */

        assertActive() {
            if (
                this.destroyed
            ) {
                throw new Error(
                    "Data library has been destroyed."
                );
            }
        }

        resolveCollectionName(
            name
        ) {
            const normalized =
                normalizeName(
                    name
                );

            let current =
                normalized;

            const visited =
                new Set();

            while (
                this.aliases.has(
                    current
                )
            ) {
                if (
                    visited.has(
                        current
                    )
                ) {
                    throw new Error(
                        `Library collection alias cycle detected at "${current}".`
                    );
                }

                visited.add(
                    current
                );

                current =
                    normalizeName(
                        this.aliases.get(
                            current
                        )
                    );
            }

            return current;
        }

        invalidateIndex(
            name
        ) {
            this.indexes.delete(
                name
            );
        }

        buildIndex(
            name =
                DEFAULT_COLLECTION
        ) {
            const normalized =
                this.resolveCollectionName(
                    name
                );

            const records =
                this.collections.get(
                    normalized
                ) ||
                [];

            const index = {
                revision:
                    this.metadata.get(
                        normalized
                    )?.revision ||
                    0,
                records:
                    records.map(
                        (
                            record,
                            position
                        ) => ({
                            position,
                            id:
                                resolveRecordID(
                                    record,
                                    this.options.idFields
                                ),
                            text:
                                recordSearchText(
                                    record
                                )
                        })
                    )
            };

            this.indexes.set(
                normalized,
                index
            );

            return index;
        }

        getIndex(
            name =
                DEFAULT_COLLECTION
        ) {
            const normalized =
                this.resolveCollectionName(
                    name
                );

            const currentRevision =
                this.metadata.get(
                    normalized
                )?.revision ||
                0;

            const index =
                this.indexes.get(
                    normalized
                );

            if (
                !index ||
                index.revision !==
                    currentRevision
            ) {
                return this.buildIndex(
                    normalized
                );
            }

            return index;
        }

        beginBatch() {
            this.assertActive();

            this.batchDepth +=
                1;

            return this.batchDepth;
        }

        endBatch() {
            if (
                this.batchDepth <=
                0
            ) {
                return 0;
            }

            this.batchDepth -=
                1;

            if (
                this.batchDepth ===
                    0 &&
                this.pendingEvents.length
            ) {
                const events =
                    this.pendingEvents.splice(
                        0
                    );

                this.emit(
                    "batch",
                    {
                        events,
                        count:
                            events.length
                    }
                );
            }

            return this.batchDepth;
        }

        batch(
            callback
        ) {
            if (
                typeof callback !== "function"
            ) {
                throw new TypeError(
                    "Library batch requires a callback."
                );
            }

            this.beginBatch();

            let result;

            try {
                result =
                    callback(this);
            } catch (error) {
                this.endBatch();
                throw error;
            }

            if (
                result &&
                typeof result.then ===
                    "function"
            ) {
                return Promise.resolve(result)
                    .finally(
                        () =>
                            this.endBatch()
                    );
            }

            this.endBatch();

            return result;
        }

        emit(
            type,
            detail = {}
        ) {
            const payload = {
                type,
                revision:
                    this.revision,
                timestamp:
                    nowISO(),
                ...detail
            };

            if (
                this.batchDepth > 0 &&
                type !== "batch"
            ) {
                this.pendingEvents.push(
                    payload
                );

                return payload;
            }

            if (this.emitting) {
                return payload;
            }

            this.emitting = true;

            try {
                dispatch(
                    this,
                    type,
                    payload
                );

                for (
                    const watcher
                    of Array.from(
                        this.watchers
                    )
                ) {
                    try {
                        watcher(
                            payload,
                            this
                        );
                    } catch (_error) {
                        /* Watcher failures are isolated. */
                    }
                }

                try {
                    this.context.events?.emit?.(
                        `library:${type}`,
                        payload
                    );
                } catch (_error) {
                    /* External event failures are isolated. */
                }

                dispatch(
                    this.context.root,
                    `speciedex:terminal-library-${type}`,
                    payload,
                    {
                        bubbles: true
                    }
                );

                dispatch(
                    document,
                    `speciedex:terminal-library-${type}`,
                    payload
                );

                const collection =
                    detail.collection;

                for (
                    const key of
                    [
                        collection,
                        "*"
                    ]
                ) {
                    if (
                        !key ||
                        !this.subscribers.has(key)
                    ) {
                        continue;
                    }

                    for (
                        const callback
                        of Array.from(
                            this.subscribers.get(key)
                        )
                    ) {
                        try {
                            callback(payload);
                        } catch (error) {
                            console.error(
                                "[SpeciedexTerminalLibrary] Subscriber failed:",
                                error
                            );
                        }
                    }
                }

                this.syncState();

                return payload;
            } finally {
                this.emitting = false;
            }
        }

        syncState() {
            if (
                this.syncingState ||
                this.destroyed
            ) {
                return false;
            }

            const state =
                this.context.state ||
                this.context.stateStore;

            if (!state?.set) {
                return false;
            }

            this.syncingState = true;

            try {
                state.set(
                    "terminal.library",
                    {
                        ready:
                            this.ready,
                        revision:
                            this.revision,
                        collections:
                            this.collections.size,
                        records:
                            [...this.collections.values()]
                                .reduce(
                                    (
                                        total,
                                        records
                                    ) =>
                                        total +
                                        records.length,
                                    0
                                ),
                        updatedAt:
                            nowISO()
                    },
                    {
                        source: "library",
                        undoable: false,
                        persist: false,
                        broadcast: false
                    }
                );

                return true;
            } catch (_error) {
                return false;
            } finally {
                this.syncingState = false;
            }
        }

        watch(callback, options = {}) {
            this.assertActive();

            if (typeof callback !== "function") {
                throw new TypeError(
                    "Library watcher must be a function."
                );
            }

            this.watchers.add(callback);

            if (options.immediate === true) {
                callback(
                    {
                        type: "initial",
                        timestamp:
                            nowISO(),
                        status:
                            this.stats()
                    },
                    this
                );
            }

            return () =>
                this.watchers.delete(
                    callback
                );
        }

        ensureMetadata(
            name
        ) {
            if (
                !this.metadata.has(
                    name
                )
            ) {
                this.metadata.set(
                    name,
                    {
                        name,
                        createdAt:
                            nowISO(),
                        updatedAt:
                            null,
                        records:
                            0,
                        source:
                            "runtime",
                        description:
                            "",
                        tags:
                            [],
                        revision:
                            0
                    }
                );
            }

            return this.metadata.get(
                name
            );
        }

        touchMetadata(
            name,
            options = {}
        ) {
            const metadata =
                this.ensureMetadata(
                    name
                );

            metadata.updatedAt =
                nowISO();

            metadata.records =
                this.collections.get(
                    name
                )?.length ||
                0;

            metadata.revision =
                (
                    metadata.revision ||
                    0
                ) +
                1;

            if (
                options.source !==
                undefined
            ) {
                metadata.source =
                    String(
                        options.source
                    );
            }

            if (
                options.description !==
                undefined
            ) {
                metadata.description =
                    String(
                        options.description
                    );
            }

            if (
                Array.isArray(
                    options.tags
                )
            ) {
                metadata.tags =
                    [
                        ...new Set(
                            options.tags
                                .map(
                                    String
                                )
                                .filter(
                                    Boolean
                                )
                        )
                    ];
            }

            this.revision +=
                1;

            return metadata;
        }

        prepareRecords(
            records
        ) {
            if (!Array.isArray(records)) {
                throw new TypeError(
                    "Library collections must be arrays."
                );
            }

            const valid =
                records.filter(
                    isRecord
                );

            if (
                valid.length >
                this.options.maximumRecords
            ) {
                throw new RangeError(
                    `Library collection exceeds ${this.options.maximumRecords} records.`
                );
            }

            return this.options.cloneOnWrite
                ? cloneRecords(
                    valid
                )
                : [
                    ...valid
                ];
        }

        storageKey(
            name
        ) {
            return (
                this.options.storagePrefix +
                normalizeName(
                    name
                )
            );
        }

        persistCollection(
            name
        ) {
            if (
                !this.options.persist ||
                !this.storage
            ) {
                return false;
            }

            const normalized =
                this.resolveCollectionName(
                    name
                );

            const records =
                this.collections.get(
                    normalized
                ) ||
                [];

            if (
                records.length >
                this.options.maxPersistedRecords
            ) {
                this.emit(
                    "persistence-skipped",
                    {
                        collection:
                            normalized,
                        records:
                            records.length,
                        maximum:
                            this.options.maxPersistedRecords
                    }
                );

                return false;
            }

            try {
                this.storage.setItem(
                    this.storageKey(
                        normalized
                    ),
                    safeStringify({
                        version:
                            VERSION,
                        metadata:
                            this.metadata.get(
                                normalized
                            ) ||
                            null,
                        records
                    })
                );

                return true;
            } catch (error) {
                this.emit(
                    "persistence-error",
                    {
                        collection:
                            normalized,
                        error
                    }
                );

                return false;
            }
        }

        /*
        ======================================================================
        Collection Access
        ======================================================================
        */

        has(
            name
        ) {
            return this.collections.has(
                this.resolveCollectionName(
                    name
                )
            );
        }

        set(
            name,
            records,
            options = {}
        ) {
            this.assertActive();
            const normalized =
                this.resolveCollectionName(
                    name
                );

            const prepared =
                this.prepareRecords(
                    records
                );

            this.collections.set(
                normalized,
                prepared
            );

            this.invalidateIndex(
                normalized
            );

            const metadata =
                this.touchMetadata(
                    normalized,
                    options
                );

            this.persistCollection(
                normalized
            );

            this.emit(
                "updated",
                {
                    collection:
                        normalized,

                    operation:
                        "set",

                    records:
                        prepared,

                    count:
                        prepared.length,

                    metadata
                }
            );

            return this.options.cloneOnRead
                ? cloneRecords(
                    prepared
                )
                : prepared;
        }

        get(
            name =
                DEFAULT_COLLECTION,
            options = {}
        ) {
            const normalized =
                this.resolveCollectionName(
                    name
                );

            const records =
                this.collections.get(
                    normalized
                ) ||
                [];

            const clone =
                options.clone ??
                this.options.cloneOnRead;

            return clone
                ? cloneRecords(
                    records
                )
                : records;
        }

        getMetadata(
            name
        ) {
            const normalized =
                this.resolveCollectionName(
                    name
                );

            const metadata =
                this.metadata.get(
                    normalized
                );

            return metadata
                ? {
                    ...metadata,
                    tags:
                        [
                            ...(metadata.tags || [])
                        ]
                }
                : null;
        }

        list() {
            return [
                ...this.collections.entries()
            ]
                .map(
                    (
                        [
                            name,
                            records
                        ]
                    ) => ({
                        name,
                        records:
                            records.length,
                        metadata:
                            this.getMetadata(
                                name
                            )
                    })
                )
                .sort(
                    (
                        left,
                        right
                    ) =>
                        left.name.localeCompare(
                            right.name
                        )
                );
        }

        /*
        ======================================================================
        Mutation
        ======================================================================
        */

        append(
            name,
            records,
            options = {}
        ) {
            this.assertActive();
            const normalized =
                this.resolveCollectionName(
                    name
                );

            const additions =
                this.prepareRecords(
                    records
                );

            const current =
                this.collections.get(
                    normalized
                ) ||
                [];

            if (
                current.length +
                additions.length >
                this.options.maximumRecords
            ) {
                throw new RangeError(
                    `Library collection "${normalized}" would exceed ${this.options.maximumRecords} records.`
                );
            }

            current.push(
                ...additions
            );

            this.collections.set(
                normalized,
                current
            );

            this.invalidateIndex(
                normalized
            );

            const metadata =
                this.touchMetadata(
                    normalized,
                    options
                );

            this.persistCollection(
                normalized
            );

            this.emit(
                "updated",
                {
                    collection:
                        normalized,

                    operation:
                        "append",

                    records:
                        additions,

                    count:
                        additions.length,

                    total:
                        current.length,

                    metadata
                }
            );

            return additions.length;
        }

        merge(
            name,
            records,
            options = {}
        ) {
            this.assertActive();
            const normalized =
                this.resolveCollectionName(
                    name
                );

            const current =
                this.collections.get(
                    normalized
                ) ||
                [];

            const incoming =
                this.prepareRecords(
                    records
                );

            const byID =
                new Map();

            const withoutID =
                [];

            for (const record of current) {
                const id =
                    resolveRecordID(
                        record,
                        this.options.idFields
                    );

                if (id) {
                    byID.set(
                        id,
                        record
                    );
                } else {
                    withoutID.push(
                        record
                    );
                }
            }

            let inserted =
                0;

            let updated =
                0;

            for (const record of incoming) {
                const id =
                    resolveRecordID(
                        record,
                        this.options.idFields
                    );

                if (!id) {
                    withoutID.push(
                        record
                    );

                    inserted +=
                        1;

                    continue;
                }

                if (
                    byID.has(
                        id
                    )
                ) {
                    byID.set(
                        id,
                        parseBoolean(
                            options.replace,
                            false
                        )
                            ? record
                            : {
                                ...byID.get(
                                    id
                                ),
                                ...record
                            }
                    );

                    updated +=
                        1;
                } else {
                    byID.set(
                        id,
                        record
                    );

                    inserted +=
                        1;
                }
            }

            const merged = [
                ...byID.values(),
                ...withoutID
            ];

            if (
                merged.length >
                this.options.maximumRecords
            ) {
                throw new RangeError(
                    `Library collection "${normalized}" would exceed ${this.options.maximumRecords} records.`
                );
            }

            this.collections.set(
                normalized,
                merged
            );

            this.invalidateIndex(
                normalized
            );

            const metadata =
                this.touchMetadata(
                    normalized,
                    options
                );

            this.persistCollection(
                normalized
            );

            const result = {
                inserted,
                updated,
                total:
                    merged.length
            };

            this.emit(
                "updated",
                {
                    collection:
                        normalized,

                    operation:
                        "merge",

                    records:
                        incoming,

                    ...result,

                    metadata
                }
            );

            return result;
        }

        update(
            name,
            predicate,
            updater
        ) {
            this.assertActive();
            const normalized =
                this.resolveCollectionName(
                    name
                );

            if (
                typeof predicate !==
                "function"
            ) {
                throw new TypeError(
                    "Library update predicate must be a function."
                );
            }

            if (
                typeof updater !==
                "function"
            ) {
                throw new TypeError(
                    "Library updater must be a function."
                );
            }

            const current =
                this.collections.get(
                    normalized
                ) ||
                [];

            let updated =
                0;

            const next =
                current.map(
                    (
                        record,
                        index
                    ) => {
                        if (
                            !predicate(
                                record,
                                index
                            )
                        ) {
                            return record;
                        }

                        updated +=
                            1;

                        const replacement =
                            updater(
                                record,
                                index
                            );

                        if (
                            replacement ===
                            undefined
                        ) {
                            return record;
                        }

                        if (!isRecord(replacement)) {
                            throw new TypeError(
                                "Library updater must return a record object or undefined."
                            );
                        }

                        return this.options.cloneOnWrite
                            ? cloneRecord(replacement)
                            : replacement;
                    }
                );

            this.collections.set(
                normalized,
                next
            );

            this.invalidateIndex(
                normalized
            );

            const metadata =
                this.touchMetadata(
                    normalized
                );

            this.persistCollection(
                normalized
            );

            this.emit(
                "updated",
                {
                    collection:
                        normalized,

                    operation:
                        "update",

                    count:
                        updated,

                    total:
                        next.length,

                    metadata
                }
            );

            return updated;
        }

        remove(
            name,
            predicate
        ) {
            this.assertActive();
            const normalized =
                this.resolveCollectionName(
                    name
                );

            if (
                typeof predicate !==
                "function"
            ) {
                throw new TypeError(
                    "Library remove predicate must be a function."
                );
            }

            const current =
                this.collections.get(
                    normalized
                ) ||
                [];

            const removed =
                [];

            const retained =
                [];

            current.forEach(
                (
                    record,
                    index
                ) => {
                    if (
                        predicate(
                            record,
                            index
                        )
                    ) {
                        removed.push(
                            record
                        );
                    } else {
                        retained.push(
                            record
                        );
                    }
                }
            );

            this.collections.set(
                normalized,
                retained
            );

            this.invalidateIndex(
                normalized
            );

            const metadata =
                this.touchMetadata(
                    normalized
                );

            this.persistCollection(
                normalized
            );

            this.emit(
                "updated",
                {
                    collection:
                        normalized,

                    operation:
                        "remove",

                    records:
                        removed,

                    count:
                        removed.length,

                    total:
                        retained.length,

                    metadata
                }
            );

            return removed;
        }

        clear(
            name = null
        ) {
            this.assertActive();
            if (name) {
                const normalized =
                    this.resolveCollectionName(
                        name
                    );

                const existed =
                    this.collections.delete(
                        normalized
                    );

                this.invalidateIndex(
                    normalized
                );

                this.metadata.delete(
                    normalized
                );

                try {
                    this.storage?.removeItem(
                        this.storageKey(
                            normalized
                        )
                    );
                } catch (error) {
                    /*
                    ----------------------------------------------------------
                    Ignore unavailable storage.
                    ----------------------------------------------------------
                    */
                }

                if (existed) {
                    this.revision +=
                        1;

                    this.emit(
                        "cleared",
                        {
                            collection:
                                normalized
                        }
                    );
                }

                return existed;
            }

            const names =
                [
                    ...this.collections.keys()
                ];

            this.collections.clear();
            this.metadata.clear();
            this.indexes.clear();

            if (
                this.options.persist &&
                this.storage
            ) {
                for (const collection of names) {
                    try {
                        this.storage.removeItem(
                            this.storageKey(
                                collection
                            )
                        );
                    } catch (error) {
                        /*
                        ------------------------------------------------------
                        Ignore unavailable storage.
                        ------------------------------------------------------
                        */
                    }
                }
            }

            this.revision +=
                1;

            this.emit(
                "cleared",
                {
                    collection:
                        null,

                    collections:
                        names
                }
            );

            return true;
        }

        /*
        ======================================================================
        Subscription
        ======================================================================
        */

        subscribe(
            name,
            callback
        ) {
            const normalized =
                name ===
                "*"
                    ? "*"
                    : this.resolveCollectionName(
                        name
                    );

            if (
                typeof callback !==
                "function"
            ) {
                throw new TypeError(
                    "Library subscriber must be a function."
                );
            }

            if (
                !this.subscribers.has(
                    normalized
                )
            ) {
                this.subscribers.set(
                    normalized,
                    new Set()
                );
            }

            this.subscribers.get(
                normalized
            ).add(
                callback
            );

            return () =>
                this.unsubscribe(
                    normalized,
                    callback
                );
        }

        unsubscribe(
            name,
            callback
        ) {
            const normalized =
                name ===
                "*"
                    ? "*"
                    : this.resolveCollectionName(
                        name
                    );

            const callbacks =
                this.subscribers.get(
                    normalized
                );

            if (!callbacks) {
                return false;
            }

            const removed =
                callbacks.delete(
                    callback
                );

            if (!callbacks.size) {
                this.subscribers.delete(
                    normalized
                );
            }

            return removed;
        }

        /*
        ======================================================================
        Persistence
        ======================================================================
        */

        restore(
            name
        ) {
            if (!this.storage) {
                return null;
            }

            const normalized =
                this.resolveCollectionName(
                    name
                );

            try {
                const payload =
                    JSON.parse(
                        this.storage.getItem(
                            this.storageKey(
                                normalized
                            )
                        ) ||
                        "null"
                    );

                if (
                    !payload ||
                    !Array.isArray(
                        payload.records
                    )
                ) {
                    return null;
                }

                this.collections.set(
                    normalized,
                    this.prepareRecords(
                        payload.records
                    )
                );

                this.invalidateIndex(
                    normalized
                );

                if (
                    payload.metadata &&
                    typeof payload.metadata ===
                        "object"
                ) {
                    this.metadata.set(
                        normalized,
                        {
                            ...cloneRecord(
                                payload.metadata
                            ),
                            name:
                                normalized,
                            tags:
                                Array.isArray(
                                    payload.metadata.tags
                                )
                                    ? [
                                        ...new Set(
                                            payload.metadata.tags
                                                .map(String)
                                                .filter(Boolean)
                                        )
                                    ]
                                    : []
                        }
                    );
                } else {
                    this.touchMetadata(
                        normalized,
                        {
                            source:
                                "storage"
                        }
                    );
                }

                this.revision +=
                    1;

                this.emit(
                    "restored",
                    {
                        collection:
                            normalized,

                        records:
                            this.collections.get(
                                normalized
                            ),

                        count:
                            this.collections.get(
                                normalized
                            ).length
                    }
                );

                return this.get(
                    normalized
                );
            } catch (error) {
                this.emit(
                    "persistence-error",
                    {
                        collection:
                            normalized,
                        error
                    }
                );

                return null;
            }
        }

        restoreAll() {
            if (!this.storage) {
                return [];
            }

            const restored = [];

            const keys = [];

            for (
                let index = 0;
                index < this.storage.length;
                index += 1
            ) {
                const key =
                    this.storage.key(index);

                if (key) {
                    keys.push(key);
                }
            }

            for (const key of keys) {
                if (
                    !key.startsWith(
                        this.options.storagePrefix
                    )
                ) {
                    continue;
                }

                const name =
                    key.slice(
                        this.options.storagePrefix.length
                    );

                if (this.restore(name)) {
                    restored.push(name);
                }
            }

            return restored;
        }

        /*
        ======================================================================
        Search and Lookup
        ======================================================================
        */

        findByID(
            id,
            name =
                DEFAULT_COLLECTION
        ) {
            const normalizedID =
                normalizeText(
                    id
                ).toLowerCase();

            if (!normalizedID) {
                return null;
            }

            const normalized =
                this.resolveCollectionName(
                    name
                );

            const records =
                this.collections.get(
                    normalized
                ) ||
                [];

            const index =
                this.getIndex(
                    normalized
                );

            const match =
                index.records.find(
                    item =>
                        item.id ===
                        normalizedID
                );

            return match
                ? records[
                    match.position
                ]
                : null;
        }

        search(
            query,
            options = {}
        ) {
            this.assertActive();

            const name =
                this.resolveCollectionName(
                    options.collection ||
                    DEFAULT_COLLECTION
                );

            const needle =
                normalizeText(
                    query
                ).toLowerCase();

            const limit =
                parseInteger(
                    options.limit,
                    50,
                    1,
                    1000
                );

            if (!needle) {
                return {
                    query:
                        "",
                    total:
                        0,
                    records:
                        [],
                    collection:
                        name,
                    source:
                        "terminal library"
                };
            }

            const records =
                this.collections.get(
                    name
                ) ||
                [];

            const index =
                this.getIndex(
                    name
                );

            const exact = [];
            const prefix = [];
            const contains = [];

            for (
                const item of
                index.records
            ) {
                if (
                    item.id ===
                        needle
                ) {
                    exact.push(
                        item.position
                    );

                    continue;
                }

                if (
                    item.text.startsWith(
                        needle
                    )
                ) {
                    prefix.push(
                        item.position
                    );

                    continue;
                }

                if (
                    item.text.includes(
                        needle
                    )
                ) {
                    contains.push(
                        item.position
                    );
                }
            }

            const positions = [
                ...exact,
                ...prefix,
                ...contains
            ];

            return {
                query:
                    needle,
                total:
                    positions.length,
                records:
                    positions
                        .slice(
                            0,
                            limit
                        )
                        .map(
                            position =>
                                records[
                                    position
                                ]
                        ),
                collection:
                    name,
                source:
                    "terminal library"
            };
        }

        alias(
            alias,
            collection
        ) {
            this.assertActive();

            const aliasName =
                normalizeName(
                    alias
                );

            const target =
                this.resolveCollectionName(
                    collection
                );

            if (
                this.collections.has(
                    aliasName
                )
            ) {
                throw new Error(
                    `Library alias conflicts with an existing collection: ${aliasName}`
                );
            }

            if (
                aliasName ===
                target
            ) {
                throw new Error(
                    `Library collection alias "${aliasName}" cannot target itself.`
                );
            }

            const previous =
                this.aliases.get(
                    aliasName
                );

            this.aliases.set(
                aliasName,
                target
            );

            try {
                const resolved =
                    this.resolveCollectionName(
                        aliasName
                    );

                this.emit(
                    "alias",
                    {
                        alias:
                            aliasName,
                        target,
                        resolved
                    }
                );

                return resolved;
            } catch (error) {
                if (
                    previous ===
                    undefined
                ) {
                    this.aliases.delete(
                        aliasName
                    );
                } else {
                    this.aliases.set(
                        aliasName,
                        previous
                    );
                }

                throw error;
            }
        }

        /*
        ======================================================================
        Statistics and Serialization
        ======================================================================
        */

        stats(
            name = null
        ) {
            if (name) {
                const normalized =
                    this.resolveCollectionName(
                        name
                    );

                const records =
                    this.collections.get(
                        normalized
                    ) ||
                    [];

                const fields =
                    new Set();

                for (const record of records) {
                    if (isRecord(record)) {
                        for (
                            const field of
                            Object.keys(record)
                        ) {
                            fields.add(
                                field
                            );
                        }
                    }
                }

                return {
                    name:
                        normalized,

                    records:
                        records.length,

                    fields:
                        [
                            ...fields
                        ].sort(),

                    metadata:
                        this.getMetadata(
                            normalized
                        )
                };
            }

            const collections =
                this.list();

            return {
                version:
                    VERSION,

                ready:
                    this.ready,

                revision:
                    this.revision,

                collections:
                    collections.length,

                records:
                    collections.reduce(
                        (
                            total,
                            collection
                        ) =>
                            total +
                            collection.records,
                        0
                    ),

                names:
                    collections.map(
                        collection =>
                            collection.name
                    ),

                indexes:
                    this.indexes.size,

                aliases:
                    Object.fromEntries(
                        this.aliases
                    ),

                limits: {
                    maximumRecords:
                        this.options.maximumRecords,
                    maxPersistedRecords:
                        this.options.maxPersistedRecords
                },

                destroyed:
                    this.destroyed
            };
        }

        export(
            name = null
        ) {
            if (name) {
                const normalized =
                    this.resolveCollectionName(
                        name
                    );

                return {
                    version:
                        VERSION,

                    generatedAt:
                        nowISO(),

                    collection:
                        normalized,

                    metadata:
                        this.getMetadata(
                            normalized
                        ),

                    records:
                        this.get(
                            normalized,
                            {
                                clone:
                                    true
                            }
                        )
                };
            }

            return {
                version:
                    VERSION,

                generatedAt:
                    nowISO(),

                revision:
                    this.revision,

                collections:
                    Object.fromEntries(
                        [
                            ...this.collections.entries()
                        ].map(
                            (
                                [
                                    collection,
                                    records
                                ]
                            ) => [
                                collection,
                                {
                                    metadata:
                                        this.getMetadata(
                                            collection
                                        ),

                                    records:
                                        cloneRecords(
                                            records
                                        )
                                }
                            ]
                        )
                    )
            };
        }

        import(
            payload,
            options = {}
        ) {
            this.assertActive();

            if (
                !payload ||
                typeof payload !== "object"
            ) {
                throw new TypeError(
                    "Library import requires an object."
                );
            }

            if (
                payload.collection &&
                Array.isArray(
                    payload.records
                )
            ) {
                return this.set(
                    payload.collection,
                    payload.records,
                    {
                        ...(
                            isObject(
                                payload.metadata
                            )
                                ? cloneRecord(
                                    payload.metadata
                                )
                                : {}
                        ),
                        source:
                            options.source ||
                            payload.metadata?.source ||
                            "import"
                    }
                );
            }

            if (
                payload.collections &&
                isObject(
                    payload.collections
                )
            ) {
                const imported = [];

                return this.batch(
                    () => {
                        for (
                            const [
                                name,
                                definition
                            ] of Object.entries(
                                payload.collections
                            )
                        ) {
                            if (
                                RESERVED_KEYS.has(name) ||
                                !definition ||
                                !Array.isArray(
                                    definition.records
                                )
                            ) {
                                continue;
                            }

                            this.set(
                                name,
                                definition.records,
                                {
                                    ...(
                                        isObject(
                                            definition.metadata
                                        )
                                            ? cloneRecord(
                                                definition.metadata
                                            )
                                            : {}
                                    ),
                                    source:
                                        options.source ||
                                        definition.metadata?.source ||
                                        "import"
                                }
                            );

                            imported.push(
                                normalizeName(name)
                            );
                        }

                        return imported;
                    }
                );
            }

            throw new Error(
                "Unsupported library import payload."
            );
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            this.emit(
                "destroy",
                {
                    version:
                        VERSION
                }
            );

            this.subscribers.clear();
            this.watchers.clear();
            this.collections.clear();
            this.metadata.clear();
            this.indexes.clear();
            this.aliases.clear();
            this.pendingEvents = [];
            this.batchDepth = 0;

            if (
                this.context.root?.[
                    LIBRARY_SYMBOL
                ] ===
                    this
            ) {
                delete this.context.root[
                    LIBRARY_SYMBOL
                ];
            }

            this.ready =
                false;

            this.destroyed =
                true;

            return true;
        }
    }

    /*
    ==========================================================================
    Initialization
    ==========================================================================
    */

    function initialize(
        context = {}
    ) {
        const safeContext =
            isObject(context)
                ? context
                : {};

        const root =
            safeContext.root &&
            typeof safeContext.root.querySelector ===
                "function"
                ? safeContext.root
                : document.documentElement;

        const existing =
            safeContext.library instanceof
                DataLibrary
                ? safeContext.library
                : safeContext.services?.get?.(
                    "library"
                ) ||
                root?.[LIBRARY_SYMBOL];

        if (
            existing instanceof DataLibrary &&
            !existing.destroyed
        ) {
            safeContext.library =
                existing;

            safeContext.registerService?.(
                "library",
                existing
            );

            return existing;
        }

        const dataset =
            root.dataset || {};

        const config =
            safeContext.config?.library ||
            {};

        const library =
            new DataLibrary(
                {
                    ...safeContext,
                    root
                },
                {
                    cloneOnWrite:
                        parseBoolean(
                            dataset.terminalLibraryCloneOnWrite ??
                            config.cloneOnWrite,
                            true
                        ),
                    cloneOnRead:
                        parseBoolean(
                            dataset.terminalLibraryCloneOnRead ??
                            config.cloneOnRead,
                            false
                        ),
                    persist:
                        parseBoolean(
                            dataset.terminalLibraryPersist ??
                            config.persist,
                            false
                        ),
                    storagePrefix:
                        dataset.terminalLibraryStoragePrefix ||
                        config.storagePrefix ||
                        "speciedex-terminal:library:",
                    maxPersistedRecords:
                        parseInteger(
                            dataset.terminalLibraryMaxPersistedRecords ??
                            config.maxPersistedRecords,
                            5000,
                            0,
                            DEFAULT_MAX_RECORDS
                        ),
                    maximumRecords:
                        parseInteger(
                            dataset.terminalLibraryMaximumRecords ??
                            config.maximumRecords,
                            DEFAULT_MAX_RECORDS,
                            1,
                            5000000
                        ),
                    idFields:
                        Array.isArray(
                            config.idFields
                        )
                            ? config.idFields
                            : DEFAULT_ID_FIELDS
                }
            );

        root[LIBRARY_SYMBOL] =
            library;

        safeContext.library =
            library;

        safeContext.registerService?.(
            "library",
            library
        );

        if (library.options.persist) {
            library.restoreAll();
        }

        library.syncState();

        dispatch(
            document,
            "speciedex:terminal-library-ready",
            {
                context:
                    safeContext,
                library,
                version:
                    VERSION
            }
        );

        return library;
    }

    /*
    ==========================================================================
    Commands
    ==========================================================================
    */

    function resolveCommandContext(payload = {}) {
        return (
            payload.context ||
            payload.terminal?.context ||
            payload.app?.context ||
            payload
        );
    }

    function requireLibrary(context) {
        const safeContext =
            isObject(context)
                ? context
                : {};

        const library =
            safeContext.library instanceof
                DataLibrary
                ? safeContext.library
                : safeContext.services?.get?.(
                    "library"
                ) ||
                initialize(safeContext);

        if (
            !(library instanceof DataLibrary) ||
            library.destroyed
        ) {
            throw new Error(
                "Terminal data library is unavailable."
            );
        }

        return library;
    }

    function writeResult(payload, value, type = "data") {
        if (
            typeof payload.writeJSON ===
                "function" &&
            typeof value !== "string"
        ) {
            return payload.writeJSON(value);
        }

        if (
            typeof payload.writeTable ===
                "function" &&
            value?.headers &&
            value?.rows
        ) {
            return payload.writeTable(
                value.headers,
                value.rows
            );
        }

        if (typeof payload.write === "function") {
            return payload.write(
                typeof value === "string"
                    ? value
                    : safeStringify(value),
                type
            );
        }

        if (typeof payload.writeLine === "function") {
            return payload.writeLine(
                typeof value === "string"
                    ? value
                    : safeStringify(value)
            );
        }

        return value;
    }

    const commands =
        [
            {
                name: "library",
                category: "data",
                description:
                    "Display data-library status or list collections.",
                usage:
                    "library [list|status] [collection]",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    const args =
                        Array.isArray(payload.args)
                            ? payload.args
                            : [];

                    const library =
                        requireLibrary(context);

                    const action =
                        String(
                            args[0] ||
                            "list"
                        ).toLowerCase();

                    return writeResult(
                        payload,
                        action === "status"
                            ? library.stats(
                                args[1] ||
                                null
                            )
                            : library.list()
                    );
                }
            },

            {
                name: "library-show",
                category: "data",
                description:
                    "Display records from a library collection.",
                usage:
                    "library-show <collection> [limit]",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    const args =
                        Array.isArray(payload.args)
                            ? payload.args
                            : [];

                    const library =
                        requireLibrary(context);

                    const name =
                        args[0] ||
                        DEFAULT_COLLECTION;

                    const limit =
                        parseInteger(
                            args[1],
                            50,
                            1,
                            1000
                        );

                    const records =
                        library
                            .get(name)
                            .slice(0, limit);

                    if (
                        typeof payload.writeTable ===
                            "function" &&
                        records.length
                    ) {
                        return writeResult(
                            payload,
                            {
                                headers: [
                                    "Scientific Name",
                                    "Common Name",
                                    "Rank",
                                    "Provider",
                                    "ID"
                                ],
                                rows:
                                    records.map(
                                        record => [
                                            record.scientific_name ??
                                                record.scientificName ??
                                                record.canonical_name ??
                                                record.canonicalName ??
                                                "",
                                            record.common_name ??
                                                record.commonName ??
                                                "",
                                            record.rank ??
                                                record.taxon_rank ??
                                                "",
                                            record.provider ??
                                                record.source ??
                                                "",
                                            resolveRecordID(
                                                record,
                                                library.options.idFields
                                            ) ?? ""
                                        ]
                                    )
                            }
                        );
                    }

                    return writeResult(
                        payload,
                        records
                    );
                }
            },

            {
                name: "library-search",
                aliases: [
                    "lib-search"
                ],
                category: "data",
                description:
                    "Search a library collection.",
                usage:
                    "library-search <query> [collection] [limit]",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    const args =
                        Array.isArray(payload.args)
                            ? payload.args
                            : [];

                    if (!args.length) {
                        throw new Error(
                            "Usage: library-search <query> [collection] [limit]"
                        );
                    }

                    const query =
                        args[0];

                    const collection =
                        args[1] ||
                        DEFAULT_COLLECTION;

                    const limit =
                        parseInteger(
                            args[2],
                            50,
                            1,
                            1000
                        );

                    return writeResult(
                        payload,
                        requireLibrary(
                            context
                        ).search(
                            query,
                            {
                                collection,
                                limit
                            }
                        )
                    );
                }
            },

            {
                name: "library-clear",
                category: "data",
                description:
                    "Clear one collection or the entire data library.",
                usage:
                    "library-clear [collection]",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    const args =
                        Array.isArray(payload.args)
                            ? payload.args
                            : [];

                    const name =
                        args[0] ||
                        null;

                    requireLibrary(
                        context
                    ).clear(name);

                    return writeResult(
                        payload,
                        name
                            ? `Library collection cleared: ${name}`
                            : "All library collections cleared.",
                        "success"
                    );
                }
            },

            {
                name: "library-copy",
                category: "data",
                description:
                    "Copy one collection into another collection.",
                usage:
                    "library-copy <source> <destination>",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    const args =
                        Array.isArray(payload.args)
                            ? payload.args
                            : [];

                    if (args.length < 2) {
                        throw new Error(
                            "Usage: library-copy <source> <destination>"
                        );
                    }

                    const [
                        source,
                        destination
                    ] = args;

                    const library =
                        requireLibrary(context);

                    const records =
                        library.get(
                            source,
                            {
                                clone: true
                            }
                        );

                    library.set(
                        destination,
                        records,
                        {
                            source:
                                `copy:${source}`
                        }
                    );

                    return writeResult(
                        payload,
                        `Copied ${records.length} records from ${source} to ${destination}.`,
                        "success"
                    );
                }
            },

            {
                name: "library-merge",
                category: "data",
                description:
                    "Merge one collection into another.",
                usage:
                    "library-merge <source> <destination>",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    const args =
                        Array.isArray(payload.args)
                            ? payload.args
                            : [];

                    if (args.length < 2) {
                        throw new Error(
                            "Usage: library-merge <source> <destination>"
                        );
                    }

                    const [
                        source,
                        destination
                    ] = args;

                    const library =
                        requireLibrary(context);

                    return writeResult(
                        payload,
                        library.merge(
                            destination,
                            library.get(source),
                            {
                                source:
                                    `merge:${source}`
                            }
                        )
                    );
                }
            },

            {
                name: "library-export",
                category: "data",
                description:
                    "Export one collection or the entire library as JSON.",
                usage:
                    "library-export [collection] [filename]",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    const args =
                        Array.isArray(payload.args)
                            ? payload.args
                            : [];

                    const collection =
                        args[0] ||
                        null;

                    const filename =
                        args[1] ||
                        (
                            collection
                                ? `speciedex-library-${normalizeName(collection)}.json`
                                : "speciedex-library.json"
                        );

                    const library =
                        requireLibrary(context);

                    const exportData =
                        library.export(
                            collection
                        );

                    const exporter =
                        context.exporter ||
                        context.services?.get?.(
                            "export"
                        ) ||
                        context.services?.get?.(
                            "exporter"
                        );

                    if (
                        exporter &&
                        typeof exporter.json ===
                            "function"
                    ) {
                        exporter.json(
                            exportData,
                            filename
                        );
                    } else {
                        if (
                            typeof URL?.createObjectURL !==
                                "function"
                        ) {
                            throw new Error(
                                "Browser download URLs are unavailable."
                            );
                        }

                        const blob =
                            new Blob(
                                [
                                    safeStringify(
                                        exportData
                                    )
                                ],
                                {
                                    type:
                                        "application/json;charset=utf-8"
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

                        (document.body ||
                            document.documentElement)
                            .appendChild(anchor);

                        try {
                            anchor.click();
                        } finally {
                            anchor.remove();

                            window.setTimeout(
                                () =>
                                    URL.revokeObjectURL(
                                        url
                                    ),
                                1000
                            );
                        }
                    }

                    return writeResult(
                        payload,
                        `Library exported to ${filename}.`,
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

            DEFAULT_COLLECTION,
            DEFAULT_ID_FIELDS,
            LIBRARY_SYMBOL,
            DataLibrary,

            normalizeName,
            normalizeText,
            resolveRecordID,
            deterministicRecordID,
            recordSearchText,
            parseBoolean,
            parseInteger,
            safeStringify,
            dispatch,
            resolveCommandContext,

            initialize,
            mount:
                initialize,
            init:
                initialize,
            setup:
                initialize,

            commands
        });

    window.SpeciedexTerminalLibrary =
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
            name:
                MODULE_NAME,
            module:
                api
        }
    );
})(window, document);
