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
        "2.0.0";

    const DEFAULT_COLLECTION =
        "records";

    const DEFAULT_ID_FIELDS =
        Object.freeze([
            "speciedex_id",
            "speciedexId",
            "id",
            "key",
            "uuid",
            "provider_id",
            "providerId"
        ]);

    /*
    ==========================================================================
    Utilities
    ==========================================================================
    */

    function normalizeName(value) {
        const name =
            String(
                value ?? ""
            )
                .trim()
                .toLowerCase()
                .replace(/\s+/g, "-");

        if (!name) {
            throw new Error(
                "Library collection name is required."
            );
        }

        if (
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

    function cloneRecord(record) {
        if (!isRecord(record)) {
            return record;
        }

        return {
            ...record
        };
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
                context;

            this.options = {
                cloneOnWrite:
                    options.cloneOnWrite !==
                    false,

                cloneOnRead:
                    options.cloneOnRead ===
                    true,

                persist:
                    options.persist ===
                    true,

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
                        ]
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
        }

        /*
        ======================================================================
        Internal Helpers
        ======================================================================
        */

        emit(
            type,
            detail = {}
        ) {
            const payload = {
                type,
                revision:
                    this.revision,
                timestamp:
                    new Date().toISOString(),
                ...detail
            };

            this.dispatchEvent(
                new CustomEvent(
                    type,
                    {
                        detail:
                            payload
                    }
                )
            );

            this.context.events?.emit?.(
                `library:${type}`,
                payload
            );

            this.context.root?.dispatchEvent?.(
                new CustomEvent(
                    `speciedex:terminal-library-${type}`,
                    {
                        bubbles:
                            true,
                        detail:
                            payload
                    }
                )
            );

            document.dispatchEvent(
                new CustomEvent(
                    `speciedex:terminal-library-${type}`,
                    {
                        detail:
                            payload
                    }
                )
            );

            const collection =
                detail.collection;

            if (
                collection &&
                this.subscribers.has(
                    collection
                )
            ) {
                for (
                    const callback of
                    this.subscribers.get(
                        collection
                    )
                ) {
                    try {
                        callback(
                            payload
                        );
                    } catch (error) {
                        console.error(
                            "[SpeciedexTerminalLibrary] Subscriber failed:",
                            error
                        );
                    }
                }
            }

            if (
                this.subscribers.has(
                    "*"
                )
            ) {
                for (
                    const callback of
                    this.subscribers.get(
                        "*"
                    )
                ) {
                    try {
                        callback(
                            payload
                        );
                    } catch (error) {
                        console.error(
                            "[SpeciedexTerminalLibrary] Subscriber failed:",
                            error
                        );
                    }
                }
            }

            return payload;
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
                            new Date().toISOString(),
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
                new Date().toISOString();

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

            return this.options.cloneOnWrite
                ? cloneRecords(
                    records
                )
                : [
                    ...records
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
                normalizeName(
                    name
                );

            try {
                this.storage.setItem(
                    this.storageKey(
                        normalized
                    ),
                    JSON.stringify({
                        metadata:
                            this.metadata.get(
                                normalized
                            ) ||
                            null,

                        records:
                            this.collections.get(
                                normalized
                            ) ||
                            []
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
                normalizeName(
                    name
                )
            );
        }

        set(
            name,
            records,
            options = {}
        ) {
            const normalized =
                normalizeName(
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
                normalizeName(
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
                normalizeName(
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
            const normalized =
                normalizeName(
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

            current.push(
                ...additions
            );

            this.collections.set(
                normalized,
                current
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
            const normalized =
                normalizeName(
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
                        options.replace ===
                        true
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

            this.collections.set(
                normalized,
                merged
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
            const normalized =
                normalizeName(
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

                        return replacement ===
                            undefined
                            ? record
                            : replacement;
                    }
                );

            this.collections.set(
                normalized,
                next
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
            const normalized =
                normalizeName(
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
            if (name) {
                const normalized =
                    normalizeName(
                        name
                    );

                const existed =
                    this.collections.delete(
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
                    : normalizeName(
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
                    : normalizeName(
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
                normalizeName(
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

                if (
                    payload.metadata &&
                    typeof payload.metadata ===
                        "object"
                ) {
                    this.metadata.set(
                        normalized,
                        {
                            ...payload.metadata,
                            name:
                                normalized
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

            const restored =
                [];

            for (
                let index = 0;
                index < this.storage.length;
                index += 1
            ) {
                const key =
                    this.storage.key(
                        index
                    );

                if (
                    !key ||
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

                if (
                    this.restore(
                        name
                    )
                ) {
                    restored.push(
                        name
                    );
                }
            }

            return restored;
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
                    normalizeName(
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
                    )
            };
        }

        export(
            name = null
        ) {
            if (name) {
                const normalized =
                    normalizeName(
                        name
                    );

                return {
                    version:
                        VERSION,

                    generatedAt:
                        new Date().toISOString(),

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
                    new Date().toISOString(),

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
            if (
                !payload ||
                typeof payload !==
                "object"
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
                        source:
                            options.source ||
                            "import",

                        ...(payload.metadata || {})
                    }
                );
            }

            if (
                payload.collections &&
                typeof payload.collections ===
                "object"
            ) {
                const imported =
                    [];

                for (
                    const [
                        name,
                        definition
                    ] of Object.entries(
                        payload.collections
                    )
                ) {
                    if (
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
                            source:
                                options.source ||
                                "import",

                            ...(definition.metadata || {})
                        }
                    );

                    imported.push(
                        name
                    );
                }

                return imported;
            }

            throw new Error(
                "Unsupported library import payload."
            );
        }

        destroy() {
            this.subscribers.clear();
            this.collections.clear();
            this.metadata.clear();

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
            context.library instanceof
            DataLibrary
        ) {
            return context.library;
        }

        const library =
            new DataLibrary(
                context,
                {
                    cloneOnWrite:
                        parseBoolean(
                            context.root?.
                                dataset.
                                terminalLibraryCloneOnWrite,
                            true
                        ),

                    cloneOnRead:
                        parseBoolean(
                            context.root?.
                                dataset.
                                terminalLibraryCloneOnRead,
                            false
                        ),

                    persist:
                        parseBoolean(
                            context.root?.
                                dataset.
                                terminalLibraryPersist,
                            false
                        )
                }
            );

        context.library =
            library;

        context.registerService?.(
            "library",
            library
        );

        if (
            library.options.persist
        ) {
            library.restoreAll();
        }

        return library;
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
                    "library",

                category:
                    "data",

                description:
                    "Display data-library status or list collections.",

                usage:
                    "library [list|status] [collection]",

                handler: ({
                    args,
                    context,
                    writeJSON
                }) => {
                    const action =
                        args[0] ||
                        "list";

                    if (
                        action ===
                        "status"
                    ) {
                        return writeJSON(
                            context.library.stats(
                                args[1] ||
                                null
                            )
                        );
                    }

                    return writeJSON(
                        context.library.list()
                    );
                }
            },

            {
                name:
                    "library-show",

                category:
                    "data",

                description:
                    "Display records from a library collection.",

                usage:
                    "library-show <collection> [limit]",

                handler: ({
                    args,
                    context,
                    writeJSON
                }) => {
                    const name =
                        args[0] ||
                        DEFAULT_COLLECTION;

                    const limit =
                        Math.max(
                            1,
                            Number(
                                args[1]
                            ) ||
                            50
                        );

                    return writeJSON(
                        context.library
                            .get(
                                name
                            )
                            .slice(
                                0,
                                limit
                            )
                    );
                }
            },

            {
                name:
                    "library-clear",

                category:
                    "data",

                description:
                    "Clear one collection or the entire data library.",

                usage:
                    "library-clear [collection]",

                handler: ({
                    args,
                    context,
                    write
                }) => {
                    const name =
                        args[0] ||
                        null;

                    context.library.clear(
                        name
                    );

                    return write(
                        name
                            ? `Library collection cleared: ${name}`
                            : "All library collections cleared.",
                        "success"
                    );
                }
            },

            {
                name:
                    "library-copy",

                category:
                    "data",

                description:
                    "Copy one collection into another collection.",

                usage:
                    "library-copy <source> <destination>",

                handler: ({
                    args,
                    context,
                    write
                }) => {
                    if (
                        args.length <
                        2
                    ) {
                        throw new Error(
                            "Usage: library-copy <source> <destination>"
                        );
                    }

                    const [
                        source,
                        destination
                    ] =
                        args;

                    const records =
                        context.library.get(
                            source,
                            {
                                clone:
                                    true
                            }
                        );

                    context.library.set(
                        destination,
                        records,
                        {
                            source:
                                `copy:${source}`
                        }
                    );

                    return write(
                        `Copied ${records.length} records from ${source} to ${destination}.`,
                        "success"
                    );
                }
            },

            {
                name:
                    "library-merge",

                category:
                    "data",

                description:
                    "Merge one collection into another.",

                usage:
                    "library-merge <source> <destination>",

                handler: ({
                    args,
                    context,
                    writeJSON
                }) => {
                    if (
                        args.length <
                        2
                    ) {
                        throw new Error(
                            "Usage: library-merge <source> <destination>"
                        );
                    }

                    const [
                        source,
                        destination
                    ] =
                        args;

                    return writeJSON(
                        context.library.merge(
                            destination,
                            context.library.get(
                                source
                            ),
                            {
                                source:
                                    `merge:${source}`
                            }
                        )
                    );
                }
            },

            {
                name:
                    "library-export",

                category:
                    "data",

                description:
                    "Export one collection or the entire library as JSON.",

                usage:
                    "library-export [collection] [filename]",

                handler: ({
                    args,
                    context,
                    write
                }) => {
                    const collection =
                        args[0] ||
                        null;

                    const filename =
                        args[1] ||
                        (
                            collection
                                ? `speciedex-library-${collection}.json`
                                : "speciedex-library.json"
                        );

                    const data =
                        JSON.stringify(
                            context.library.export(
                                collection
                            ),
                            null,
                            2
                        );

                    const blob =
                        new Blob(
                            [
                                data
                            ],
                            {
                                type:
                                    "application/json"
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

                    return write(
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
            DataLibrary,

            normalizeName,
            resolveRecordID,
            parseBoolean,

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
