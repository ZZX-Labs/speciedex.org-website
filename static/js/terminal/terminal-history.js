/*
========================================================================
Speciedex.org
Terminal History Utilities
========================================================================

Structured command-history service for SpeciedexTerminal.

Provides:

    • Durable command-history access
    • Deduplication and configurable limits
    • Previous/next navigation state
    • Search, filtering, import, and export
    • Safe persistence hooks
    • Lifecycle events and service registration
    • Terminal command integration

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "History";
    const VERSION = "2.2.0";

    const HISTORY_SYMBOL =
        Symbol.for(
            "speciedex.terminal.history.service"
        );

    const DEFAULT_STORAGE_KEY =
        "history";

    const DEFAULT_LIMIT =
        500;

    const MIN_LIMIT =
        10;

    const MAX_LIMIT =
        10000;

    const DEFAULT_IMPORT_LIMIT =
        10000;

    const DEFAULT_METADATA_DEPTH =
        16;

    const RESERVED_KEYS =
        new Set([
            "__proto__",
            "prototype",
            "constructor"
        ]);

    const activeDispatches =
        new WeakMap();

    function isObject(value) {
        return (
            value !== null &&
            typeof value === "object" &&
            !Array.isArray(value)
        );
    }

    function isElement(value) {
        return Boolean(
            value &&
            value.nodeType === 1 &&
            typeof value.dispatchEvent === "function"
        );
    }

    function parseBoolean(value, fallback = false) {
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
            String(value).trim().toLowerCase();

        if (
            ["1", "true", "yes", "on", "enabled"].includes(normalized)
        ) {
            return true;
        }

        if (
            ["0", "false", "no", "off", "disabled"].includes(normalized)
        ) {
            return false;
        }

        return fallback;
    }

    function safeStringify(value, compact = false) {
        const seen = new WeakSet();

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
            activeDispatches.set(target, names);
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

    function clone(
        value,
        seen =
            new WeakMap(),
        depth =
            0
    ) {
        if (
            value ===
                null ||
            value ===
                undefined ||
            typeof value !==
                "object"
        ) {
            return value;
        }

        if (
            depth >
            DEFAULT_METADATA_DEPTH
        ) {
            return "[Truncated]";
        }

        if (
            typeof structuredClone ===
                "function"
        ) {
            try {
                return structuredClone(
                    value
                );
            } catch (_error) {
                /* Continue with deterministic fallback. */
            }
        }

        if (
            seen.has(
                value
            )
        ) {
            return seen.get(
                value
            );
        }

        if (
            value instanceof
                Date
        ) {
            return new Date(
                value.getTime()
            );
        }

        if (
            value instanceof
                RegExp
        ) {
            return new RegExp(
                value.source,
                value.flags
            );
        }

        if (value instanceof Map) {
            const output =
                new Map();

            seen.set(
                value,
                output
            );

            for (
                const [key, item]
                of value.entries()
            ) {
                output.set(
                    clone(
                        key,
                        seen,
                        depth + 1
                    ),
                    clone(
                        item,
                        seen,
                        depth + 1
                    )
                );
            }

            return output;
        }

        if (value instanceof Set) {
            const output =
                new Set();

            seen.set(
                value,
                output
            );

            for (const item of value.values()) {
                output.add(
                    clone(
                        item,
                        seen,
                        depth + 1
                    )
                );
            }

            return output;
        }

        if (
            Array.isArray(
                value
            )
        ) {
            const output =
                [];

            seen.set(
                value,
                output
            );

            for (
                const item of
                value
            ) {
                output.push(
                    clone(
                        item,
                        seen,
                        depth +
                            1
                    )
                );
            }

            return output;
        }

        const output =
            {};

        seen.set(
            value,
            output
        );

        for (
            const [
                key,
                item
            ] of Object.entries(
                value
            )
        ) {
            if (
                RESERVED_KEYS.has(key)
            ) {
                continue;
            }

            output[
                key
            ] =
                clone(
                    item,
                    seen,
                    depth +
                        1
                );
        }

        return output;
    }

    function isPromiseLike(
        value
    ) {
        return Boolean(
            value &&
            typeof value.then ===
                "function"
        );
    }

    function normalizeCommand(value) {
        return String(value ?? "")
            .replace(/\r\n?/g, "\n")
            .trim();
    }

    function nowISO(value = Date.now()) {
        const date =
            value instanceof Date
                ? value
                : new Date(value);

        return Number.isFinite(date.getTime())
            ? date.toISOString()
            : new Date().toISOString();
    }

    function createId() {
        try {
            if (
                window.crypto &&
                typeof window.crypto.randomUUID === "function"
            ) {
                return window.crypto.randomUUID();
            }
        } catch (_error) {
            /*
            ------------------------------------------------------------------
            Fall through to a local identifier.
            ------------------------------------------------------------------
            */
        }

        return [
            Date.now().toString(36),
            Math.random().toString(36).slice(2, 12)
        ].join("-");
    }

    function normalizeEntry(entry, index = 0) {
        if (typeof entry === "string") {
            const command =
                normalizeCommand(entry);

            return command
                ? {
                    id: createId(),
                    command,
                    timestamp: nowISO(),
                    source: "legacy",
                    metadata: {},
                    index
                }
                : null;
        }

        if (
            !entry ||
            typeof entry !== "object"
        ) {
            return null;
        }

        const command =
            normalizeCommand(
                entry.command ??
                entry.value ??
                entry.text
            );

        if (!command) {
            return null;
        }

        return {
            id:
                String(
                    entry.id ||
                    createId()
                ).trim() ||
                createId(),
            command,
            timestamp:
                Number.isFinite(
                    Date.parse(entry.timestamp)
                )
                    ? new Date(
                        entry.timestamp
                    ).toISOString()
                    : nowISO(),
            source:
                String(
                    entry.source ||
                    "terminal"
                ).trim() ||
                "terminal",
            metadata:
                entry.metadata &&
                typeof entry.metadata ===
                    "object"
                    ? clone(
                        entry.metadata
                    )
                    : {},
            index
        };
    }

    class HistoryService extends EventTarget {
        constructor(context = {}, options = {}) {
            super();

            this.context =
                isObject(context)
                    ? context
                    : {};

            this.storageKey =
                String(
                    options.storageKey ||
                    DEFAULT_STORAGE_KEY
                );

            this.importLimit =
                clampInteger(
                    options.importLimit,
                    DEFAULT_IMPORT_LIMIT,
                    1,
                    MAX_LIMIT
                );

            this.limit =
                clampInteger(
                    options.limit,
                    DEFAULT_LIMIT,
                    MIN_LIMIT,
                    MAX_LIMIT
                );

            this.dedupe =
                parseBoolean(
                    options.dedupe,
                    true
                );

            this.entries =
                [];

            this.position =
                0;

            this.draft =
                "";

            this.ready =
                false;

            this.destroyed =
                false;

            this.emitting =
                false;

            this.watchers =
                new Set();

            this.syncingState =
                false;

            this.syncingApp =
                false;

            this.loading =
                false;

            this.loadPromise =
                null;

            this.metrics = {
                added:
                    0,
                deduplicated:
                    0,
                removed:
                    0,
                cleared:
                    0,
                navigations:
                    0,
                searches:
                    0,
                imports:
                    0,
                exports:
                    0,
                persistenceWrites:
                    0,
                persistenceReads:
                    0,
                persistenceErrors:
                    0,
                appSyncs:
                    0
            };

            this.loadPromise =
                Promise.resolve(
                    this.load()
                ).finally(
                    () => {
                        this.loadPromise =
                            null;
                    }
                );
        }

        ensureAvailable() {
            if (this.destroyed) {
                throw new Error(
                    "History service has been destroyed."
                );
            }
        }

        async load() {
            this.ensureAvailable();

            if (
                this.loading
            ) {
                return this.loadPromise
                    ? await this.loadPromise
                    : this.entries;
            }

            this.loading =
                true;

            try {
                const appHistory =
                    Array.isArray(
                        this.context.app?.
                            history
                    )
                        ? this.context.app.history
                        : [];

                let storedHistory =
                    [];

                try {
                    const value =
                        this.context.storage?.
                            get?.(
                                this.storageKey,
                                []
                            );

                    storedHistory =
                        isPromiseLike(
                            value
                        )
                            ? await value
                            : value;

                    this.metrics.persistenceReads +=
                        1;
                } catch (_error) {
                    this.metrics.persistenceErrors +=
                        1;

                    storedHistory =
                        [];
                }

                const source =
                    appHistory.length
                        ? appHistory
                        : (
                            Array.isArray(
                                storedHistory
                            )
                                ? storedHistory
                                : Array.isArray(
                                    storedHistory?.
                                        history
                                )
                                    ? storedHistory.history
                                    : []
                        );

                this.entries =
                    source
                        .map(
                            (
                                entry,
                                index
                            ) =>
                                normalizeEntry(
                                    entry,
                                    index
                                )
                        )
                        .filter(
                            Boolean
                        )
                        .slice(
                            -this.limit
                        );

                this.position =
                    this.entries.length;

                this.syncApp();

                this.ready =
                    true;

                this.syncState();

                this.emit(
                    "load",
                    {
                        count:
                            this.entries.length
                    }
                );

                return this.entries;
            } finally {
                this.loading =
                    false;
            }
        }

        async whenReady() {
            this.ensureAvailable();

            if (this.loadPromise) {
                await this.loadPromise;
            }

            return this;
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
                    "terminal.history",
                    {
                        ready:
                            this.ready,
                        count:
                            this.entries.length,
                        position:
                            this.position,
                        limit:
                            this.limit,
                        updatedAt:
                            nowISO()
                    },
                    {
                        source: "history",
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
            this.ensureAvailable();

            if (typeof callback !== "function") {
                throw new TypeError(
                    "History watcher must be a function."
                );
            }

            this.watchers.add(callback);

            if (options.immediate === true) {
                callback(
                    {
                        type: "initial",
                        timestamp: nowISO(),
                        status:
                            this.status()
                    },
                    this
                );
            }

            return () =>
                this.watchers.delete(callback);
        }

        syncApp() {
            if (
                this.syncingApp ||
                !this.context.app
            ) {
                return false;
            }

            this.syncingApp =
                true;

            try {
                this.context.app.history =
                    this.entries.map(
                        entry =>
                            entry.command
                    );

                this.context.app.historyIndex =
                    this.position;

                this.metrics.appSyncs +=
                    1;

                return true;
            } finally {
                this.syncingApp =
                    false;
            }
        }

        persist() {
            this.syncApp();

            try {
                const result =
                    this.context.app?.
                        persistHistory?.();

                if (
                    isPromiseLike(
                        result
                    )
                ) {
                    result.catch(
                        () => {
                            this.metrics.persistenceErrors +=
                                1;
                        }
                    );
                }
            } catch (_error) {
                this.metrics.persistenceErrors +=
                    1;
            }

            try {
                const result =
                    this.context.storage?.
                        set?.(
                            this.storageKey,
                            this.entries.map(
                                entry => ({
                                    ...entry,
                                    metadata:
                                        clone(
                                            entry.metadata
                                        )
                                })
                            )
                        );

                if (
                    isPromiseLike(
                        result
                    )
                ) {
                    result.catch(
                        () => {
                            this.metrics.persistenceErrors +=
                                1;
                        }
                    );
                }

                if (
                    this.context.storage &&
                    typeof this.context.storage.set ===
                        "function"
                ) {
                    this.metrics.persistenceWrites +=
                        1;
                }
            } catch (_error) {
                this.metrics.persistenceErrors +=
                    1;
            }

            this.syncState();

            return true;
        }

        emit(
            name,
            detail
        ) {
            if (
                this.destroyed &&
                name !==
                    "destroy"
            ) {
                return false;
            }

            if (
                this.emitting
            ) {
                return false;
            }

            this.emitting =
                true;

            try {
                dispatch(
                    this,
                    name,
                    detail
                );

                for (
                    const watcher
                    of Array.from(this.watchers)
                ) {
                    try {
                        watcher(
                            {
                                type: name,
                                timestamp: nowISO(),
                                detail
                            },
                            this
                        );
                    } catch (_error) {
                        /* Watcher failures must not break history. */
                    }
                }

                try {
                    this.context.events?.emit?.(
                        `history:${name}`,
                        detail
                    );
                } catch (_error) {
                    /* Observer failures must not break history. */
                }

                dispatch(
                    this.context.root,
                    `speciedex:terminal-history-${name}`,
                    detail,
                    {
                        bubbles:
                            true
                    }
                );

                return true;
            } finally {
                this.emitting =
                    false;
            }
        }

        add(command, options = {}) {
            this.ensureAvailable();

            const normalized =
                normalizeCommand(command);

            if (!normalized) {
                return null;
            }

            if (
                this.dedupe &&
                this.entries.length &&
                this.entries[
                    this.entries.length -
                    1
                ].command ===
                    normalized
            ) {
                this.metrics.deduplicated +=
                    1;
                this.position =
                    this.entries.length;

                this.draft = "";

                this.syncApp();
                this.syncState();

                const existing =
                    this.entries[
                        this.entries.length - 1
                    ];

                this.emit(
                    "deduplicate",
                    {
                        entry:
                            clone(existing),
                        count:
                            this.entries.length
                    }
                );

                return existing;
            }

            const entry =
                normalizeEntry(
                    {
                        command: normalized,
                        timestamp:
                            options.timestamp ||
                            nowISO(),
                        source:
                            options.source ||
                            "terminal",
                        metadata:
                            options.metadata || {}
                    },
                    this.entries.length
                );

            this.entries.push(
                entry
            );

            this.metrics.added +=
                1;

            if (
                this.entries.length >
                this.limit
            ) {
                this.entries.splice(
                    0,
                    this.entries.length -
                    this.limit
                );
            }

            this.entries.forEach(
                (item, index) => {
                    item.index =
                        index;
                }
            );

            this.position =
                this.entries.length;

            this.draft = "";

            if (options.persist !== false) {
                this.persist();
            }

            this.emit(
                "add",
                {
                    entry,
                    count:
                        this.entries.length
                }
            );

            return entry;
        }

        previous(currentValue = "") {
            this.ensureAvailable();

            if (!this.entries.length) {
                return null;
            }

            if (
                this.position ===
                this.entries.length
            ) {
                this.draft =
                    String(currentValue ?? "");
            }

            this.position =
                Math.max(
                    0,
                    this.position - 1
                );

            this.syncApp();
            this.syncState();

            this.metrics.navigations +=
                1;

            const entry =
                this.entries[
                    this.position
                ] || null;

            this.emit(
                "navigate",
                {
                    direction:
                        "previous",
                    position:
                        this.position,
                    entry
                }
            );

            return entry?.command ?? null;
        }

        next() {
            this.ensureAvailable();

            if (!this.entries.length) {
                return this.draft;
            }

            if (
                this.position <
                this.entries.length
            ) {
                this.position += 1;
            }

            this.syncApp();
            this.syncState();

            this.metrics.navigations +=
                1;

            const command =
                this.position >=
                this.entries.length
                    ? this.draft
                    : this.entries[
                        this.position
                    ]?.command ?? "";

            this.emit(
                "navigate",
                {
                    direction:
                        "next",
                    position:
                        this.position,
                    command
                }
            );

            return command;
        }

        resetNavigation(draft = "") {
            this.position =
                this.entries.length;

            this.draft =
                String(draft ?? "");

            this.syncApp();

            return this.position;
        }

        get(index) {
            this.ensureAvailable();

            const normalizedIndex =
                Number(index);

            if (
                !Number.isInteger(
                    normalizedIndex
                )
            ) {
                return null;
            }

            if (normalizedIndex < 0) {
                return (
                    this.entries[
                        this.entries.length +
                        normalizedIndex
                    ] || null
                );
            }

            return (
                this.entries[
                    normalizedIndex
                ] || null
            );
        }

        list(options = {}) {
            this.ensureAvailable();

            const contains =
                String(
                    options.contains || ""
                )
                    .trim()
                    .toLowerCase();

            const source =
                options.source
                    ? String(
                        options.source
                    ).trim()
                    : null;

            const since =
                options.since
                    ? Date.parse(
                        options.since
                    )
                    : Number.NaN;

            const until =
                options.until
                    ? Date.parse(
                        options.until
                    )
                    : Number.NaN;

            const limit =
                clampInteger(
                    options.limit,
                    100,
                    1,
                    this.limit
                );

            const filtered =
                this.entries.filter(entry => {
                    const timestamp =
                        Date.parse(
                            entry.timestamp
                        );

                    return (
                        (
                            !contains ||
                            entry.command
                                .toLowerCase()
                                .includes(
                                    contains
                                )
                        ) &&
                        (
                            !source ||
                            entry.source ===
                            source
                        ) &&
                        (
                            !Number.isFinite(
                                since
                            ) ||
                            timestamp >= since
                        ) &&
                        (
                            !Number.isFinite(
                                until
                            ) ||
                            timestamp <= until
                        )
                    );
                });

            const sliced =
                filtered.slice(-limit);

            return options.newestFirst === false
                ? sliced
                : [...sliced].reverse();
        }

        search(query, options = {}) {
            this.metrics.searches +=
                1;

            return this.list({
                ...options,
                contains: query
            });
        }

        remove(indexOrId) {
            this.ensureAvailable();

            let index = -1;

            if (
                Number.isInteger(
                    Number(indexOrId)
                )
            ) {
                index =
                    Number(indexOrId);

                if (index < 0) {
                    index =
                        this.entries.length +
                        index;
                }
            } else {
                index =
                    this.entries.findIndex(
                        entry =>
                            entry.id ===
                            String(indexOrId)
                    );
            }

            if (
                index < 0 ||
                index >=
                    this.entries.length
            ) {
                return null;
            }

            const [
                removed
            ] =
                this.entries.splice(
                    index,
                    1
                );

            this.entries.forEach(
                (item, entryIndex) => {
                    item.index =
                        entryIndex;
                }
            );

            this.position =
                Math.min(
                    this.position,
                    this.entries.length
                );

            this.persist();

            this.metrics.removed +=
                1;

            this.emit(
                "remove",
                {
                    entry: removed,
                    index
                }
            );

            return removed;
        }

        clear(options = {}) {
            this.ensureAvailable();

            const count =
                this.entries.length;

            this.entries.length = 0;
            this.position = 0;
            this.draft = "";

            if (options.persist !== false) {
                this.persist();
            } else {
                this.syncApp();
            }

            this.metrics.cleared +=
                count;

            this.emit(
                "clear",
                {
                    count
                }
            );

            return count;
        }

        setLimit(limit) {
            this.ensureAvailable();

            this.limit =
                clampInteger(
                    limit,
                    this.limit,
                    MIN_LIMIT,
                    MAX_LIMIT
                );

            if (
                this.entries.length >
                this.limit
            ) {
                this.entries.splice(
                    0,
                    this.entries.length -
                    this.limit
                );
            }

            this.entries.forEach(
                (item, index) => {
                    item.index =
                        index;
                }
            );

            this.position =
                Math.min(
                    this.position,
                    this.entries.length
                );

            this.persist();

            this.emit(
                "limit",
                {
                    limit:
                        this.limit
                }
            );

            return this.limit;
        }

        import(
            data,
            options =
                {}
        ) {
            this.ensureAvailable();

            let source =
                data;

            if (
                typeof source ===
                    "string"
            ) {
                try {
                    source =
                        JSON.parse(
                            source
                        );
                } catch (_error) {
                    source =
                        source
                            .split(
                                /\r?\n/
                            )
                            .filter(
                                Boolean
                            );
                }
            }

            const values =
                Array.isArray(
                    source
                )
                    ? source
                    : Array.isArray(
                        source?.history
                    )
                        ? source.history
                        : Array.isArray(
                            source?.entries
                        )
                            ? source.entries
                            : [];

            if (
                values.length >
                this.importLimit
            ) {
                throw new RangeError(
                    `History import contains ${values.length} entries; maximum is ${this.importLimit}.`
                );
            }

            const imported =
                values
                    .map(
                        (
                            entry,
                            index
                        ) =>
                            normalizeEntry(
                                entry,
                                index
                            )
                    )
                    .filter(
                        Boolean
                    );

            if (
                parseBoolean(
                    options.replace,
                    false
                )
            ) {
                this.entries =
                    [];
            }

            const seen =
                new Set(
                    this.entries.map(
                        entry =>
                            `${entry.timestamp} ${entry.command}`
                    )
                );

            let accepted =
                0;

            for (
                const entry of
                imported
            ) {
                const key =
                    `${entry.timestamp} ${entry.command}`;

                if (
                    this.dedupe &&
                    seen.has(
                        key
                    )
                ) {
                    this.metrics.deduplicated +=
                        1;

                    continue;
                }

                seen.add(
                    key
                );

                this.entries.push(
                    entry
                );

                accepted +=
                    1;
            }

            this.entries =
                this.entries.slice(
                    -this.limit
                );

            this.position =
                this.entries.length;

            this.draft =
                "";

            this.persist();

            this.metrics.imports +=
                accepted;

            this.emit(
                "import",
                {
                    imported:
                        accepted,
                    attempted:
                        imported.length,
                    count:
                        this.entries.length
                }
            );

            return accepted;
        }

        export(options = {}) {
            this.ensureAvailable();

            this.metrics.exports +=
                1;

            const entries =
                parseBoolean(
                    options.commandsOnly,
                    false
                )
                    ? this.entries.map(
                        entry =>
                            entry.command
                    )
                    : this.entries.map(
                        entry => ({
                            ...entry,
                            metadata:
                                clone(
                                    entry.metadata
                                )
                        })
                    );

            return {
                version: VERSION,
                generatedAt:
                    nowISO(),
                limit:
                    this.limit,
                count:
                    this.entries.length,
                history:
                    entries
            };
        }

        status() {
            return {
                version: VERSION,
                ready:
                    this.ready,
                count:
                    this.entries.length,
                limit:
                    this.limit,
                position:
                    this.position,
                dedupe:
                    this.dedupe,
                storageKey:
                    this.storageKey,
                importLimit:
                    this.importLimit,
                loading:
                    this.loading,
                metrics: {
                    ...this.metrics
                },
                destroyed:
                    this.destroyed
            };
        }

        destroy() {
            if (
                this.destroyed
            ) {
                return false;
            }

            this.persist();

            this.emit(
                "destroy",
                {
                    timestamp:
                        nowISO(),
                    version:
                        VERSION
                }
            );

            if (
                this.context.root?.[
                    HISTORY_SYMBOL
                ] ===
                    this
            ) {
                delete this.context.root[
                    HISTORY_SYMBOL
                ];
            }

            this.watchers.clear();

            this.entries =
                [];

            this.position =
                0;

            this.draft =
                "";

            this.ready =
                false;

            this.destroyed =
                true;

            return true;
        }

    }

    function initialize(
        context = {}
    ) {
        const safeContext =
            isObject(context)
                ? context
                : {};

        const root =
            isElement(safeContext.root)
                ? safeContext.root
                : document.documentElement;

        const existing =
            safeContext.historyService instanceof
                HistoryService
                ? safeContext.historyService
                : safeContext.services?.get?.(
                    "history"
                ) ||
                root?.[HISTORY_SYMBOL];

        if (
            existing instanceof HistoryService &&
            !existing.destroyed
        ) {
            safeContext.historyService =
                existing;

            safeContext.history =
                existing;

            safeContext.registerService?.(
                "history",
                existing
            );

            return existing;
        }

        const dataset =
            root.dataset || {};

        const config =
            safeContext.config?.history ||
            {};

        const service =
            new HistoryService(
                {
                    ...safeContext,
                    root
                },
                {
                    limit:
                        dataset.terminalHistoryLimit ||
                        config.limit,
                    dedupe:
                        dataset.terminalHistoryDedupe ??
                        config.dedupe,
                    storageKey:
                        dataset.terminalHistoryStorageKey ||
                        config.storageKey ||
                        DEFAULT_STORAGE_KEY,
                    importLimit:
                        dataset.terminalHistoryImportLimit ||
                        config.importLimit ||
                        DEFAULT_IMPORT_LIMIT
                }
            );

        root[HISTORY_SYMBOL] =
            service;

        safeContext.historyService =
            service;

        safeContext.history =
            service;

        safeContext.registerService?.(
            "history",
            service
        );

        dispatch(
            document,
            "speciedex:terminal-history-ready",
            {
                context:
                    safeContext,
                history:
                    service,
                version:
                    VERSION
            }
        );

        return service;
    }

    function resolveCommandContext(payload = {}) {
        return (
            payload.context ||
            payload.terminal?.context ||
            payload.app?.context ||
            payload
        );
    }

    function requireHistory(context) {
        const safeContext =
            isObject(context)
                ? context
                : {};

        const service =
            safeContext.historyService instanceof
                HistoryService
                ? safeContext.historyService
                : safeContext.services?.get?.(
                    "history"
                ) ||
                initialize(safeContext);

        if (
            !(service instanceof HistoryService) ||
            service.destroyed
        ) {
            throw new Error(
                "Terminal history service is unavailable."
            );
        }

        return service;
    }

    function writeText(write, message, type = "output") {
        if (typeof write === "function") {
            return write(
                message,
                type,
                {
                    preformatted: true
                }
            );
        }

        return message;
    }

    function writeResult(payload, value, type = "data") {
        if (
            typeof payload.writeJSON ===
                "function" &&
            typeof value !== "string"
        ) {
            return payload.writeJSON(value);
        }

        if (typeof payload.write === "function") {
            return writeText(
                payload.write,
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

    const commands = [
        {
            name: "history",
            aliases: [
                "history-list"
            ],
            category: "system",
            description:
                "Display terminal command history.",
            usage:
                "history [limit] [search terms]",
            handler: async payload => {
                const context =
                    resolveCommandContext(payload);

                const args =
                    Array.isArray(payload.args)
                        ? payload.args
                        : [];

                const service =
                    requireHistory(context);

                await service.whenReady();

                const write =
                    payload.write ||
                    payload.writeLine;

                const first =
                    Number.parseInt(
                        args[0],
                        10
                    );

                const hasLimit =
                    Number.isFinite(first);

                const limit =
                    hasLimit
                        ? first
                        : 100;

                const contains =
                    args
                        .slice(
                            hasLimit
                                ? 1
                                : 0
                        )
                        .join(" ");

                const entries =
                    service.list({
                        limit,
                        contains,
                        newestFirst: false
                    });

                if (!entries.length) {
                    return writeText(
                        write,
                        "Command history is empty."
                    );
                }

                return writeText(
                    write,
                    entries
                        .map(
                            (entry, index) =>
                                `${String(index + 1).padStart(4)}  ${entry.command}`
                        )
                        .join("\n")
                );
            }
        },
        {
            name:
                "history-search",

            aliases: [
                "hgrep"
            ],

            category:
                "system",

            description:
                "Search terminal command history.",

            usage:
                "history-search <query> [limit]",

            handler: async payload => {
                const context =
                    resolveCommandContext(payload);

                const args =
                    Array.isArray(payload.args)
                        ? payload.args
                        : [];

                const service =
                    requireHistory(context);

                await service.whenReady();
                if (
                    !args.length
                ) {
                    throw new Error(
                        "A history search query is required."
                    );
                }

                const final =
                    Number.parseInt(
                        args[
                            args.length -
                            1
                        ],
                        10
                    );

                const hasLimit =
                    Number.isFinite(
                        final
                    );

                const query =
                    args
                        .slice(
                            0,
                            hasLimit
                                ? -1
                                : undefined
                        )
                        .join(
                            " "
                        );

                const result =
                    service.search(
                        query,
                        {
                            limit:
                                hasLimit
                                    ? final
                                    : 100,
                            newestFirst:
                                true
                        }
                    );

                return writeResult(
                    payload,
                    result
                );
            }
        },
        {
            name: "history-clear",
            category: "system",
            description:
                "Clear terminal command history.",
            usage:
                "history-clear",
            handler: async payload => {
                const context =
                    resolveCommandContext(payload);

                const service =
                    requireHistory(context);

                await service.whenReady();

                const count =
                    service.clear();

                const write =
                    payload.write ||
                    payload.writeLine;

                return writeText(
                    write,
                    `Cleared ${count} command-history entr${count === 1 ? "y" : "ies"}.`,
                    "success"
                );
            }
        },
        {
            name: "history-remove",
            category: "system",
            description:
                "Remove one command-history entry by index or ID.",
            usage:
                "history-remove <index|id>",
            handler: async payload => {
                const context =
                    resolveCommandContext(payload);

                const args =
                    Array.isArray(payload.args)
                        ? payload.args
                        : [];

                const service =
                    requireHistory(context);

                await service.whenReady();

                const write =
                    payload.write ||
                    payload.writeLine;
                if (!args[0]) {
                    throw new Error(
                        "A history index or ID is required."
                    );
                }

                const removed =
                    service.remove(
                        args[0]
                    );

                if (!removed) {
                    throw new Error(
                        `History entry not found: ${args[0]}`
                    );
                }

                return writeText(
                    write,
                    `Removed history entry: ${removed.command}`,
                    "success"
                );
            }
        },
        {
            name:
                "history-limit",

            category:
                "system",

            description:
                "Display or change the command-history limit.",

            usage:
                "history-limit [number]",

            handler: async payload => {
                const context =
                    resolveCommandContext(payload);

                const args =
                    Array.isArray(payload.args)
                        ? payload.args
                        : [];

                const service =
                    requireHistory(context);

                await service.whenReady();

                if (
                    !args[0]
                ) {
                    return writeResult(
                        payload,
                        {
                            limit:
                                service.limit
                        }
                    );
                }

                return writeResult(
                    payload,
                    {
                        limit:
                            service.setLimit(
                                args[0]
                            )
                    }
                );
            }
        },

        {
            name:
                "history-import",

            category:
                "system",

            description:
                "Import command history from JSON or newline-separated text.",

            usage:
                "history-import <json-or-text> [--replace]",

            handler: async payload => {
                const context =
                    resolveCommandContext(payload);

                const args =
                    Array.isArray(payload.args)
                        ? payload.args
                        : [];

                const service =
                    requireHistory(context);

                await service.whenReady();
                if (
                    !args.length
                ) {
                    throw new Error(
                        "History import data is required."
                    );
                }

                const replace =
                    args.includes(
                        "--replace"
                    );

                const importPayload =
                    args
                        .filter(
                            argument =>
                                argument !==
                                "--replace"
                        )
                        .join(
                            " "
                        );

                return writeResult(
                    payload,
                    {
                        imported:
                            service.import(
                                importPayload,
                                {
                                    replace
                                }
                            ),
                        status:
                            service.status()
                    }
                );
            }
        },

        {
            name: "history-status",
            category: "system",
            description:
                "Show command-history service status.",
            usage:
                "history-status",
            handler: async payload => {
                const context =
                    resolveCommandContext(payload);

                const service =
                    requireHistory(context);

                await service.whenReady();

                return writeResult(
                    payload,
                    service.status()
                );
            }
        },
        {
            name: "history-export",
            category: "system",
            description:
                "Export command history as JSON.",
            usage:
                "history-export [filename]",
            handler: async payload => {
                const context =
                    resolveCommandContext(payload);

                const args =
                    Array.isArray(payload.args)
                        ? payload.args
                        : [];

                const service =
                    requireHistory(context);

                await service.whenReady();

                const write =
                    payload.write ||
                    payload.writeLine;

                const filename =
                    args[0] ||
                    "speciedex-terminal-history.json";

                const exportPayload =
                    service.export();

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
                        exportPayload,
                        filename
                    );
                } else {
                    const blob =
                        new Blob(
                            [
                                safeStringify(
                                    exportPayload
                                )
                            ],
                            {
                                type:
                                    "application/json;charset=utf-8"
                            }
                        );

                    if (
                        typeof URL?.createObjectURL !==
                            "function"
                    ) {
                        throw new Error(
                            "Browser download URLs are unavailable."
                        );
                    }

                    const url =
                        URL.createObjectURL(
                            blob
                        );

                    const anchor =
                        document.createElement(
                            "a"
                        );

                    anchor.href = url;
                    anchor.download =
                        filename;
                    anchor.hidden = true;

                    (document.body ||
                        document.documentElement)
                        .appendChild(anchor);

                    try {
                        anchor.click();
                    } finally {
                        anchor.remove();
                    }

                    window.setTimeout(
                        () =>
                            URL.revokeObjectURL(
                                url
                            ),
                        1000
                    );
                }

                return writeText(
                    write,
                    `Command history exported to ${filename}.`,
                    "success"
                );
            }
        }
    ];

    const api = Object.freeze({
        name: MODULE_NAME,
        version:
            VERSION,
        HISTORY_SYMBOL,
        HistoryService,
        clone,
        isPromiseLike,
        normalizeCommand,
        normalizeEntry,
        safeStringify,
        parseBoolean,
        dispatch,
        resolveCommandContext,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalHistory =
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
