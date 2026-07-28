/*
========================================================================
Speciedex.org
Terminal Bookmarks
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Bookmarks";
    const VERSION = "2.2.0";
    const SERVICE_NAME = "bookmarks";

    const BOOKMARKS_SYMBOL =
        Symbol.for("speciedex.terminal.bookmarks.service");

    const STORAGE_KEY = "bookmarks";
    const STORAGE_VERSION = 1;
    const DEFAULT_LIMIT = 1000;
    const DEFAULT_IMPORT_LIMIT = 10000;
    const DEFAULT_MAX_TAGS = 64;
    const DEFAULT_MAX_NOTE_LENGTH = 65536;
    const DEFAULT_MAX_VALUE_LENGTH = 1048576;
    const DEFAULT_HISTORY_LIMIT = 500;
    const DEFAULT_STORAGE_DEBOUNCE = 80;
    const MAX_CLONE_DEPTH = 32;

    const RESERVED_KEYS = new Set([
        "__proto__",
        "prototype",
        "constructor"
    ]);

    const activeDispatches = new WeakMap();

    function now() {
        return Date.now();
    }

    function iso(value = now()) {
        const date =
            value instanceof Date
                ? value
                : new Date(value);

        return Number.isFinite(date.getTime())
            ? date.toISOString()
            : new Date().toISOString();
    }

    function text(value) {
        return String(value ?? "").trim();
    }

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

    function isPromiseLike(value) {
        return Boolean(
            value &&
            typeof value.then === "function"
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

    function clampInteger(
        value,
        fallback,
        minimum,
        maximum
    ) {
        const number =
            Number.parseInt(value, 10);

        return Number.isFinite(number)
            ? Math.min(
                maximum,
                Math.max(minimum, number)
            )
            : fallback;
    }

    function makeID() {
        if (
            window.crypto &&
            typeof window.crypto.randomUUID ===
                "function"
        ) {
            return window.crypto.randomUUID();
        }

        if (
            window.crypto &&
            typeof window.crypto.getRandomValues ===
                "function"
        ) {
            const bytes =
                new Uint8Array(16);

            window.crypto.getRandomValues(bytes);

            bytes[6] =
                (bytes[6] & 0x0f) | 0x40;

            bytes[8] =
                (bytes[8] & 0x3f) | 0x80;

            const hex =
                Array.from(
                    bytes,
                    byte =>
                        byte
                            .toString(16)
                            .padStart(2, "0")
                ).join("");

            return [
                hex.slice(0, 8),
                hex.slice(8, 12),
                hex.slice(12, 16),
                hex.slice(16, 20),
                hex.slice(20)
            ].join("-");
        }

        return (
            `bookmark-${now()}-` +
            Math.random()
                .toString(36)
                .slice(2, 10)
        );
    }

    function clone(
        value,
        seen = new WeakMap(),
        depth = 0
    ) {
        if (
            value === null ||
            value === undefined ||
            typeof value !== "object"
        ) {
            return value;
        }

        if (depth > MAX_CLONE_DEPTH) {
            return "[Truncated]";
        }

        if (typeof structuredClone === "function") {
            try {
                return structuredClone(value);
            } catch (_error) {
                /* Continue with deterministic fallback. */
            }
        }

        if (seen.has(value)) {
            return seen.get(value);
        }

        if (value instanceof Date) {
            return new Date(value.getTime());
        }

        if (value instanceof RegExp) {
            return new RegExp(
                value.source,
                value.flags
            );
        }

        if (value instanceof Map) {
            const output = {};
            seen.set(value, output);

            for (const [key, item] of value.entries()) {
                const normalized =
                    String(key);

                if (RESERVED_KEYS.has(normalized)) {
                    continue;
                }

                output[normalized] =
                    clone(
                        item,
                        seen,
                        depth + 1
                    );
            }

            return output;
        }

        if (value instanceof Set) {
            const output = [];
            seen.set(value, output);

            for (const item of value.values()) {
                output.push(
                    clone(
                        item,
                        seen,
                        depth + 1
                    )
                );
            }

            return output;
        }

        if (Array.isArray(value)) {
            const output = [];
            seen.set(value, output);

            for (const item of value) {
                output.push(
                    clone(
                        item,
                        seen,
                        depth + 1
                    )
                );
            }

            return output;
        }

        const output = {};
        seen.set(value, output);

        for (const [key, item] of Object.entries(value)) {
            if (RESERVED_KEYS.has(key)) {
                continue;
            }

            output[key] =
                clone(
                    item,
                    seen,
                    depth + 1
                );
        }

        return output;
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

    function safeDispatch(
        target,
        name,
        detail,
        options = {}
    ) {
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
                        detail,
                        bubbles:
                            options.bubbles === true
                    }
                )
            );
        } catch (_error) {
            return false;
        } finally {
            names.delete(name);
        }
    }

    function normalizeTags(
        value,
        options = {}
    ) {
        const source =
            Array.isArray(value)
                ? value
                : value instanceof Set
                    ? Array.from(value)
                    : text(value).split(",");

        const preserveCase =
            options.preserveCase === true;

        const maximum =
            clampInteger(
                options.maximum,
                DEFAULT_MAX_TAGS,
                0,
                1000
            );

        const output = [];
        const seen = new Set();

        for (const item of source) {
            let tag =
                String(item ?? "")
                    .normalize("NFKC")
                    .trim()
                    .replace(/^#+/, "")
                    .replace(/\s+/g, " ");

            if (!preserveCase) {
                tag = tag.toLowerCase();
            }

            if (!tag) {
                continue;
            }

            if (RESERVED_KEYS.has(tag)) {
                continue;
            }

            if (seen.has(tag)) {
                continue;
            }

            seen.add(tag);
            output.push(tag);

            if (output.length >= maximum) {
                break;
            }
        }

        return output;
    }

    function normalizeCategory(value) {
        return (
            text(value || "general")
                .toLowerCase()
                .normalize("NFKC")
                .replace(/\s+/g, "-")
                .replace(/[^a-z0-9:_-]/g, "")
                .replace(/-+/g, "-")
                .replace(/^[-:]+|[-:]+$/g, "") ||
            "general"
        );
    }

    function formulaSafeText(value) {
        const normalized =
            String(value ?? "");

        return /^[=+\-@\t\r]/.test(normalized)
            ? `'${normalized}`
            : normalized;
    }

    function csvCell(value) {
        const normalized =
            formulaSafeText(
                typeof value === "string"
                    ? value
                    : safeStringify(
                        clone(value),
                        true
                    )
            );

        return (
            `"${normalized.replace(/"/g, '""')}"`
        );
    }

    class Bookmarks extends EventTarget {
        constructor(context = {}, options = {}) {
            super();

            this.context =
                isObject(context)
                    ? context
                    : {};

            this.storage =
                options.storage ||
                this.context.storage ||
                this.context.services?.get?.("storage") ||
                null;

            this.storageKey =
                text(options.storageKey) ||
                STORAGE_KEY;

            this.limit =
                clampInteger(
                    options.limit,
                    DEFAULT_LIMIT,
                    1,
                    1000000
                );

            this.importLimit =
                clampInteger(
                    options.importLimit,
                    DEFAULT_IMPORT_LIMIT,
                    1,
                    1000000
                );

            this.maxTags =
                clampInteger(
                    options.maxTags,
                    DEFAULT_MAX_TAGS,
                    1,
                    1000
                );

            this.maxNoteLength =
                clampInteger(
                    options.maxNoteLength,
                    DEFAULT_MAX_NOTE_LENGTH,
                    0,
                    10485760
                );

            this.maxValueLength =
                clampInteger(
                    options.maxValueLength,
                    DEFAULT_MAX_VALUE_LENGTH,
                    1,
                    104857600
                );

            this.historyLimit =
                clampInteger(
                    options.historyLimit,
                    DEFAULT_HISTORY_LIMIT,
                    1,
                    100000
                );

            this.storageDebounce =
                clampInteger(
                    options.storageDebounce,
                    DEFAULT_STORAGE_DEBOUNCE,
                    0,
                    10000
                );

            this.autoPersist =
                options.autoPersist !== false;

            this.items = [];
            this.history = [];
            this.watchers = new Set();

            this.destroyed = false;
            this.ready = false;
            this.emitting = false;
            this.syncingState = false;
            this.saveTimer = 0;
            this.loadPromise = null;
            this.savePromise = Promise.resolve();
            this.pendingSaveResolvers = [];

            this.metrics = {
                added: 0,
                updated: 0,
                removed: 0,
                cleared: 0,
                imports: 0,
                exports: 0,
                duplicates: 0,
                persistenceReads: 0,
                persistenceWrites: 0,
                persistenceErrors: 0,
                opens: 0,
                watcherErrors: 0,
                stateSyncs: 0
            };
        }

        async initialize() {
            this.ensureAvailable();

            if (!this.loadPromise) {
                this.loadPromise =
                    this.load().finally(() => {
                        this.loadPromise = null;
                    });
            }

            await this.loadPromise;

            this.ready = true;
            this.syncState();

            this.emit("ready", {
                count: this.items.length
            });

            return this;
        }

        ensureAvailable() {
            if (this.destroyed) {
                throw new Error(
                    "Bookmarks service has been destroyed."
                );
            }
        }

        normalizeRecord(record = {}) {
            if (!isObject(record)) {
                return null;
            }

            const label =
                text(record.label);

            const value =
                text(record.value);

            if (!label || !value) {
                return null;
            }

            if (
                value.length >
                this.maxValueLength
            ) {
                throw new RangeError(
                    `Bookmark value exceeds ${this.maxValueLength} characters.`
                );
            }

            const createdAt =
                iso(record.createdAt);

            const updatedAt =
                iso(
                    record.updatedAt ||
                    createdAt
                );

            return {
                id:
                    text(record.id) ||
                    makeID(),
                label,
                value,
                tags:
                    normalizeTags(
                        record.tags,
                        {
                            maximum:
                                this.maxTags
                        }
                    ),
                note:
                    String(record.note ?? "")
                        .slice(
                            0,
                            this.maxNoteLength
                        ),
                category:
                    normalizeCategory(
                        record.category
                    ),
                pinned:
                    record.pinned === true,
                openCount:
                    clampInteger(
                        record.openCount,
                        0,
                        0,
                        Number.MAX_SAFE_INTEGER
                    ),
                lastOpenedAt:
                    record.lastOpenedAt
                        ? iso(record.lastOpenedAt)
                        : null,
                createdAt,
                updatedAt,
                metadata:
                    isObject(record.metadata)
                        ? clone(record.metadata)
                        : {}
            };
        }

        _findIndex(idOrLabel) {
            const needle =
                text(idOrLabel)
                    .toLowerCase();

            if (!needle) {
                return -1;
            }

            return this.items.findIndex(
                record =>
                    record.id.toLowerCase() === needle ||
                    record.label.toLowerCase() === needle
            );
        }

        async _storageGet() {
            if (
                typeof this.storage?.get ===
                "function"
            ) {
                return await this.storage.get(
                    this.storageKey,
                    []
                );
            }

            const raw =
                window.localStorage
                    ?.getItem?.(
                        this.storageKey
                    );

            return raw
                ? JSON.parse(raw)
                : [];
        }

        async _storageSet(payload) {
            if (
                typeof this.storage?.set ===
                "function"
            ) {
                await this.storage.set(
                    this.storageKey,
                    payload
                );

                return true;
            }

            if (window.localStorage) {
                window.localStorage.setItem(
                    this.storageKey,
                    safeStringify(
                        payload,
                        true
                    )
                );

                return true;
            }

            return false;
        }

        async load() {
            this.ensureAvailable();

            let payload = [];

            try {
                payload =
                    await this._storageGet();

                this.metrics.persistenceReads += 1;
            } catch (error) {
                this.metrics.persistenceErrors += 1;
                this.report("load", error);
                payload = [];
            }

            if (
                isObject(payload) &&
                Array.isArray(payload.items)
            ) {
                payload = payload.items;
            }

            if (!Array.isArray(payload)) {
                payload = [];
            }

            const next = [];
            const seenIDs = new Set();
            const seenPairs = new Set();

            for (
                const source
                of payload.slice(
                    0,
                    this.limit
                )
            ) {
                try {
                    const record =
                        this.normalizeRecord(source);

                    if (!record) {
                        continue;
                    }

                    const pair =
                        `${record.label.toLowerCase()}\u0000${record.value}`;

                    if (
                        seenIDs.has(record.id) ||
                        seenPairs.has(pair)
                    ) {
                        this.metrics.duplicates += 1;
                        continue;
                    }

                    seenIDs.add(record.id);
                    seenPairs.add(pair);
                    next.push(record);
                } catch (error) {
                    this.report(
                        "load:record",
                        error
                    );
                }
            }

            this.items = next;
            this.syncState();

            this.emit("loaded", {
                count: this.items.length
            });

            return this.list();
        }

        buildPayload() {
            return {
                version: STORAGE_VERSION,
                updatedAt: iso(),
                items:
                    this.items.map(
                        item => clone(item)
                    )
            };
        }

        async _flushSave() {
            window.clearTimeout(
                this.saveTimer
            );

            this.saveTimer = 0;

            const payload =
                this.buildPayload();

            const resolvers =
                this.pendingSaveResolvers.splice(0);

            this.savePromise =
                this.savePromise
                    .catch(() => false)
                    .then(async () => {
                        try {
                            const stored =
                                await this._storageSet(
                                    payload
                                );

                            if (!stored) {
                                return false;
                            }

                            this.metrics.persistenceWrites += 1;

                            this.emit("saved", {
                                count:
                                    this.items.length
                            });

                            this.syncState();

                            for (
                                const resolver
                                of resolvers
                            ) {
                                resolver.resolve(payload);
                            }

                            return payload;
                        } catch (error) {
                            this.metrics.persistenceErrors += 1;
                            this.report("save", error);

                            for (
                                const resolver
                                of resolvers
                            ) {
                                resolver.reject(error);
                            }

                            throw error;
                        }
                    });

            return this.savePromise;
        }

        save(options = {}) {
            this.ensureAvailable();

            if (
                !this.autoPersist &&
                options.force !== true
            ) {
                return Promise.resolve(false);
            }

            if (
                options.immediate === true ||
                this.storageDebounce === 0
            ) {
                return this._flushSave();
            }

            window.clearTimeout(
                this.saveTimer
            );

            const promise =
                new Promise(
                    (resolve, reject) => {
                        this.pendingSaveResolvers.push({
                            resolve,
                            reject
                        });
                    }
                );

            this.saveTimer =
                window.setTimeout(
                    () => {
                        void this._flushSave();
                    },
                    this.storageDebounce
                );

            return promise;
        }

        recordHistory(action, detail = {}) {
            this.history.push({
                id: makeID(),
                timestamp: iso(),
                action,
                detail: clone(detail)
            });

            while (
                this.history.length >
                this.historyLimit
            ) {
                this.history.shift();
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
                    "terminal.bookmarks",
                    {
                        count:
                            this.items.length,
                        pinned:
                            this.items.filter(
                                item =>
                                    item.pinned
                            ).length,
                        categories:
                            Array.from(
                                new Set(
                                    this.items.map(
                                        item =>
                                            item.category
                                    )
                                )
                            ),
                        metrics: {
                            ...this.metrics
                        },
                        updatedAt: iso()
                    },
                    {
                        source: "bookmarks",
                        undoable: false,
                        persist: false,
                        broadcast: false
                    }
                );

                this.metrics.stateSyncs += 1;

                return true;
            } catch (_error) {
                return false;
            } finally {
                this.syncingState = false;
            }
        }

        list(options = {}) {
            this.ensureAvailable();

            let result =
                this.items.slice();

            const query =
                text(options.query)
                    .toLowerCase();

            const tag =
                text(options.tag)
                    .toLowerCase();

            const category =
                options.category
                    ? normalizeCategory(
                        options.category
                    )
                    : null;

            if (query) {
                result = result.filter(item =>
                    item.label
                        .toLowerCase()
                        .includes(query) ||
                    item.value
                        .toLowerCase()
                        .includes(query) ||
                    item.note
                        .toLowerCase()
                        .includes(query) ||
                    item.category
                        .toLowerCase()
                        .includes(query) ||
                    item.tags.some(
                        itemTag =>
                            itemTag.includes(query)
                    )
                );
            }

            if (tag) {
                result = result.filter(
                    item =>
                        item.tags.includes(tag)
                );
            }

            if (category) {
                result = result.filter(
                    item =>
                        item.category === category
                );
            }

            if (
                options.pinned === true ||
                options.pinned === false
            ) {
                result = result.filter(
                    item =>
                        item.pinned ===
                        options.pinned
                );
            }

            const sort =
                text(
                    options.sort ||
                    "newest"
                ).toLowerCase();

            result.sort((left, right) => {
                switch (sort) {
                    case "oldest":
                        return left.createdAt
                            .localeCompare(
                                right.createdAt
                            );

                    case "label":
                        return left.label
                            .localeCompare(
                                right.label,
                                undefined,
                                {
                                    numeric: true,
                                    sensitivity:
                                        "base"
                                }
                            );

                    case "updated":
                        return right.updatedAt
                            .localeCompare(
                                left.updatedAt
                            );

                    case "opened":
                        return (
                            right.lastOpenedAt ||
                            ""
                        ).localeCompare(
                            left.lastOpenedAt ||
                            ""
                        );

                    case "usage":
                        return (
                            right.openCount -
                            left.openCount
                        ) || right.updatedAt
                            .localeCompare(
                                left.updatedAt
                            );

                    case "pinned":
                        return (
                            Number(right.pinned) -
                            Number(left.pinned)
                        ) || right.updatedAt
                            .localeCompare(
                                left.updatedAt
                            );

                    default:
                        return right.createdAt
                            .localeCompare(
                                left.createdAt
                            );
                }
            });

            const limit =
                Number(options.limit);

            if (
                Number.isFinite(limit) &&
                limit >= 0
            ) {
                result = result.slice(
                    0,
                    Math.trunc(limit)
                );
            }

            return result.map(
                item => clone(item)
            );
        }

        get(idOrLabel) {
            this.ensureAvailable();

            const index =
                this._findIndex(idOrLabel);

            return index >= 0
                ? clone(this.items[index])
                : null;
        }

        async open(idOrLabel, options = {}) {
            this.ensureAvailable();

            const index =
                this._findIndex(idOrLabel);

            if (index < 0) {
                return null;
            }

            const item =
                this.items[index];

            item.openCount += 1;
            item.lastOpenedAt = iso();
            item.updatedAt = iso();

            this.metrics.opens += 1;

            this.recordHistory(
                "opened",
                { id: item.id }
            );

            void this.save();

            if (
                options.execute !== false &&
                typeof this.context.execute ===
                    "function"
            ) {
                await this.context.execute(
                    item.value
                );
            }

            this.emit("opened", {
                bookmark: clone(item)
            });

            return clone(item);
        }

        add(label, value, options = {}) {
            this.ensureAvailable();

            const normalizedLabel =
                text(label);

            const normalizedValue =
                text(value);

            if (!normalizedLabel) {
                throw new TypeError(
                    "A bookmark label is required."
                );
            }

            if (!normalizedValue) {
                throw new TypeError(
                    "A bookmark value is required."
                );
            }

            const duplicate =
                this.items.find(item =>
                    item.label.toLowerCase() ===
                        normalizedLabel.toLowerCase() &&
                    item.value ===
                        normalizedValue
                );

            if (
                duplicate &&
                options.allowDuplicate !== true
            ) {
                this.metrics.duplicates += 1;
                return clone(duplicate);
            }

            if (
                this.items.length >=
                this.limit
            ) {
                throw new RangeError(
                    `Bookmark limit reached (${this.limit}).`
                );
            }

            const timestamp = iso();

            const record =
                this.normalizeRecord({
                    id: options.id,
                    label:
                        normalizedLabel,
                    value:
                        normalizedValue,
                    tags:
                        options.tags,
                    note:
                        options.note,
                    category:
                        options.category,
                    pinned:
                        options.pinned,
                    metadata:
                        options.metadata,
                    createdAt:
                        options.createdAt ||
                        timestamp,
                    updatedAt:
                        options.updatedAt ||
                        timestamp
                });

            this.items.push(record);
            this.metrics.added += 1;

            this.recordHistory(
                "added",
                { id: record.id }
            );

            void this.save();

            this.emit("added", {
                bookmark: clone(record)
            });

            return clone(record);
        }

        update(idOrLabel, changes = {}) {
            this.ensureAvailable();

            const index =
                this._findIndex(idOrLabel);

            if (index < 0) {
                return null;
            }

            const current =
                this.items[index];

            const next =
                this.normalizeRecord({
                    ...current,
                    ...clone(changes),
                    id: current.id,
                    createdAt:
                        current.createdAt,
                    updatedAt: iso()
                });

            if (!next) {
                throw new TypeError(
                    "Updated bookmark must retain a label and value."
                );
            }

            const duplicate =
                this.items.find(
                    (item, candidateIndex) =>
                        candidateIndex !== index &&
                        item.label.toLowerCase() ===
                            next.label.toLowerCase() &&
                        item.value === next.value
                );

            if (duplicate) {
                throw new Error(
                    "An identical bookmark already exists."
                );
            }

            this.items[index] = next;
            this.metrics.updated += 1;

            this.recordHistory(
                "updated",
                { id: next.id }
            );

            void this.save();

            this.emit("updated", {
                bookmark: clone(next)
            });

            return clone(next);
        }

        remove(idOrLabel) {
            this.ensureAvailable();

            const index =
                this._findIndex(idOrLabel);

            if (index < 0) {
                return null;
            }

            const [removed] =
                this.items.splice(index, 1);

            this.metrics.removed += 1;

            this.recordHistory(
                "removed",
                { id: removed.id }
            );

            void this.save();

            this.emit("removed", {
                bookmark: clone(removed)
            });

            return clone(removed);
        }

        async clear(options = {}) {
            this.ensureAvailable();

            const count =
                this.items.length;

            this.items = [];
            this.metrics.cleared += count;

            this.recordHistory(
                "cleared",
                { count }
            );

            if (options.persist !== false) {
                await this.save({
                    immediate: true
                });
            }

            this.emit("cleared", {
                count
            });

            return count;
        }

        pin(idOrLabel, pinned = true) {
            return this.update(
                idOrLabel,
                {
                    pinned:
                        pinned !== false
                }
            );
        }

        addTags(idOrLabel, tags) {
            const current =
                this.get(idOrLabel);

            if (!current) {
                return null;
            }

            return this.update(
                current.id,
                {
                    tags:
                        normalizeTags(
                            [
                                ...current.tags,
                                ...normalizeTags(
                                    tags,
                                    {
                                        maximum:
                                            this.maxTags
                                    }
                                )
                            ],
                            {
                                maximum:
                                    this.maxTags
                            }
                        )
                }
            );
        }

        removeTags(idOrLabel, tags) {
            const current =
                this.get(idOrLabel);

            if (!current) {
                return null;
            }

            const remove =
                new Set(
                    normalizeTags(
                        tags,
                        {
                            maximum:
                                this.maxTags
                        }
                    )
                );

            return this.update(
                current.id,
                {
                    tags:
                        current.tags.filter(
                            tag =>
                                !remove.has(tag)
                        )
                }
            );
        }

        bulkRemove(ids) {
            this.ensureAvailable();

            const values =
                Array.isArray(ids)
                    ? ids
                    : [ids];

            const needles =
                new Set(
                    values
                        .map(value =>
                            text(value)
                                .toLowerCase()
                        )
                        .filter(Boolean)
                );

            const removed = [];

            this.items =
                this.items.filter(item => {
                    const match =
                        needles.has(
                            item.id.toLowerCase()
                        ) ||
                        needles.has(
                            item.label.toLowerCase()
                        );

                    if (match) {
                        removed.push(item);
                    }

                    return !match;
                });

            if (removed.length) {
                this.metrics.removed +=
                    removed.length;

                this.recordHistory(
                    "bulk-removed",
                    {
                        ids:
                            removed.map(
                                item => item.id
                            )
                    }
                );

                void this.save();

                this.emit(
                    "bulk-removed",
                    {
                        bookmarks:
                            removed.map(clone)
                    }
                );
            }

            return removed.map(clone);
        }

        export(options = {}) {
            this.ensureAvailable();

            this.metrics.exports += 1;

            const format =
                text(
                    options.format ||
                    "json"
                ).toLowerCase();

            if (format === "csv") {
                const headers = [
                    "id",
                    "label",
                    "value",
                    "category",
                    "tags",
                    "note",
                    "pinned",
                    "openCount",
                    "createdAt",
                    "updatedAt",
                    "lastOpenedAt"
                ];

                return [
                    headers
                        .map(csvCell)
                        .join(","),
                    ...this.list({
                        sort: "oldest"
                    }).map(item =>
                        headers.map(key =>
                            csvCell(
                                key === "tags"
                                    ? item.tags.join(" ")
                                    : item[key]
                            )
                        ).join(",")
                    )
                ].join("\r\n");
            }

            if (
                format === "markdown" ||
                format === "md"
            ) {
                return [
                    "# SpeciedexTerminal Bookmarks",
                    "",
                    `Exported: ${iso()}`,
                    "",
                    "| Label | Value | Category | Tags | Pinned |",
                    "|---|---|---|---|---|",
                    ...this.list({
                        sort: "label"
                    }).map(item =>
                        `| ${item.label.replace(/\|/g, "\\|")} | ` +
                        `${item.value.replace(/\|/g, "\\|")} | ` +
                        `${item.category} | ` +
                        `${item.tags.join(", ")} | ` +
                        `${item.pinned ? "yes" : "no"} |`
                    )
                ].join("\n");
            }

            return {
                version: STORAGE_VERSION,
                exportedAt: iso(),
                count:
                    this.items.length,
                items:
                    this.list({
                        sort: "oldest"
                    }),
                history:
                    options.includeHistory ===
                        true
                        ? clone(this.history)
                        : undefined
            };
        }

        async import(payload, options = {}) {
            this.ensureAvailable();

            let source = payload;

            if (typeof source === "string") {
                source = JSON.parse(source);
            }

            const records =
                Array.isArray(source)
                    ? source
                    : Array.isArray(source?.items)
                        ? source.items
                        : [];

            if (
                records.length >
                this.importLimit
            ) {
                throw new RangeError(
                    `Bookmark import contains ${records.length} records; maximum is ${this.importLimit}.`
                );
            }

            const snapshot =
                this.items.map(clone);

            let added = 0;
            let skipped = 0;
            const errors = [];

            if (options.replace === true) {
                this.items = [];
            }

            try {
                for (const sourceRecord of records) {
                    try {
                        const normalized =
                            this.normalizeRecord(
                                sourceRecord
                            );

                        if (!normalized) {
                            skipped += 1;
                            continue;
                        }

                        const duplicate =
                            this.items.some(item =>
                                item.id ===
                                    normalized.id ||
                                (
                                    item.label.toLowerCase() ===
                                        normalized.label.toLowerCase() &&
                                    item.value ===
                                        normalized.value
                                )
                            );

                        if (
                            duplicate ||
                            this.items.length >=
                                this.limit
                        ) {
                            skipped += 1;
                            continue;
                        }

                        this.items.push(normalized);
                        added += 1;
                    } catch (error) {
                        skipped += 1;

                        errors.push({
                            message:
                                error.message
                        });

                        if (
                            options.strict === true
                        ) {
                            throw error;
                        }
                    }
                }
            } catch (error) {
                this.items =
                    snapshot.map(clone);

                throw error;
            }

            this.metrics.imports += added;

            this.recordHistory(
                "imported",
                {
                    added,
                    skipped
                }
            );

            if (options.persist !== false) {
                await this.save({
                    immediate: true
                });
            }

            const result = {
                added,
                skipped,
                errors
            };

            this.emit("imported", result);

            return result;
        }

        watch(callback, options = {}) {
            this.ensureAvailable();

            if (typeof callback !== "function") {
                throw new TypeError(
                    "Bookmark watcher must be a function."
                );
            }

            this.watchers.add(callback);

            if (options.immediate === true) {
                callback(
                    {
                        action: "initial",
                        timestamp: iso(),
                        status:
                            this.status()
                    },
                    this
                );
            }

            return () =>
                this.watchers.delete(callback);
        }

        emit(action, detail = {}) {
            if (
                this.destroyed &&
                action !== "destroy"
            ) {
                return false;
            }

            if (this.emitting) {
                return false;
            }

            this.emitting = true;

            const payload = {
                action,
                timestamp: iso(),
                service: this,
                ...detail
            };

            try {
                safeDispatch(
                    this,
                    action,
                    payload
                );

                safeDispatch(
                    this,
                    "change",
                    payload
                );

                for (
                    const watcher
                    of Array.from(this.watchers)
                ) {
                    try {
                        watcher(
                            payload,
                            this
                        );
                    } catch (error) {
                        this.metrics.watcherErrors += 1;
                        this.report(
                            `watcher:${action}`,
                            error
                        );
                    }
                }

                try {
                    this.context.events?.emit?.(
                        `bookmarks:${action}`,
                        payload
                    );
                } catch (error) {
                    this.report(
                        `event:${action}`,
                        error
                    );
                }

                safeDispatch(
                    this.context.root,
                    `speciedex:terminal-bookmarks-${action}`,
                    payload,
                    { bubbles: true }
                );

                safeDispatch(
                    document,
                    `speciedex:terminal-bookmarks-${action}`,
                    payload
                );

                return true;
            } finally {
                this.emitting = false;
            }
        }

        status() {
            return {
                version: VERSION,
                ready: this.ready,
                count:
                    this.items.length,
                limit:
                    this.limit,
                importLimit:
                    this.importLimit,
                storageKey:
                    this.storageKey,
                persistent:
                    Boolean(
                        this.storage ||
                        window.localStorage
                    ),
                autoPersist:
                    this.autoPersist,
                categories:
                    Array.from(
                        new Set(
                            this.items.map(
                                item =>
                                    item.category
                            )
                        )
                    ),
                tags:
                    Array.from(
                        new Set(
                            this.items.flatMap(
                                item =>
                                    item.tags
                            )
                        )
                    ),
                pinned:
                    this.items.filter(
                        item =>
                            item.pinned
                    ).length,
                history:
                    this.history.length,
                metrics: {
                    ...this.metrics
                },
                destroyed:
                    this.destroyed
            };
        }

        async destroy() {
            if (this.destroyed) {
                return false;
            }

            window.clearTimeout(
                this.saveTimer
            );

            this.saveTimer = 0;

            try {
                await this.save({
                    immediate: true,
                    force: true
                });
            } catch (_error) {
                /* Save errors were already reported. */
            }

            this.emit("destroy", {
                version: VERSION
            });

            this.watchers.clear();

            const root =
                this.context.root;

            if (
                root &&
                root[BOOKMARKS_SYMBOL] === this
            ) {
                delete root[BOOKMARKS_SYMBOL];
            }

            this.items = [];
            this.history = [];
            this.destroyed = true;
            this.ready = false;

            return true;
        }

        report(phase, error) {
            try {
                this.context.log?.error?.(
                    "Terminal bookmarks error",
                    {
                        phase,
                        error
                    }
                );
            } catch (_error) {
                /* Logger integration is optional. */
            }

            safeDispatch(
                document,
                "speciedex:error",
                {
                    phase:
                        `terminal-bookmarks:${phase}`,
                    error
                }
            );
        }
    }

    function getService(context) {
        return (
            context?.bookmarks ||
            context?.services?.get?.(
                SERVICE_NAME
            ) ||
            context?.services?.bookmarks ||
            null
        );
    }

    async function initialize(context = {}) {
        const safeContext =
            isObject(context)
                ? context
                : {};

        const root =
            isElement(safeContext.root)
                ? safeContext.root
                : document.documentElement;

        const existing =
            safeContext.bookmarks instanceof
                Bookmarks
                ? safeContext.bookmarks
                : safeContext.services?.get?.(
                    SERVICE_NAME
                ) ||
                root?.[BOOKMARKS_SYMBOL];

        if (
            existing instanceof Bookmarks &&
            !existing.destroyed
        ) {
            safeContext.bookmarks = existing;

            safeContext.registerService?.(
                SERVICE_NAME,
                existing
            );

            if (!existing.ready) {
                await existing.initialize();
            }

            return existing;
        }

        const dataset =
            root.dataset || {};

        const config =
            safeContext.config?.bookmarks ||
            {};

        const bookmarks =
            new Bookmarks(
                {
                    ...safeContext,
                    root
                },
                {
                    storage:
                        safeContext.storage ||
                        safeContext.services?.get?.(
                            "storage"
                        ) ||
                        null,
                    storageKey:
                        dataset.terminalBookmarksStorageKey ||
                        config.storageKey ||
                        STORAGE_KEY,
                    limit:
                        dataset.terminalBookmarksLimit ||
                        config.limit,
                    importLimit:
                        dataset.terminalBookmarksImportLimit ||
                        config.importLimit,
                    maxTags:
                        dataset.terminalBookmarksMaxTags ||
                        config.maxTags,
                    maxNoteLength:
                        dataset.terminalBookmarksMaxNoteLength ||
                        config.maxNoteLength,
                    maxValueLength:
                        dataset.terminalBookmarksMaxValueLength ||
                        config.maxValueLength,
                    historyLimit:
                        dataset.terminalBookmarksHistoryLimit ||
                        config.historyLimit,
                    storageDebounce:
                        dataset.terminalBookmarksStorageDebounce ||
                        config.storageDebounce,
                    autoPersist:
                        parseBoolean(
                            dataset.terminalBookmarksAutoPersist,
                            config.autoPersist !== false
                        )
                }
            );

        root[BOOKMARKS_SYMBOL] =
            bookmarks;

        safeContext.bookmarks =
            bookmarks;

        safeContext.registerService?.(
            SERVICE_NAME,
            bookmarks
        );

        await bookmarks.initialize();

        safeDispatch(
            document,
            "speciedex:terminal-bookmarks-ready",
            {
                context:
                    safeContext,
                bookmarks,
                version: VERSION
            }
        );

        return bookmarks;
    }

    function outputJSON(payload, value) {
        if (
            typeof payload.writeJSON ===
            "function"
        ) {
            return payload.writeJSON(value);
        }

        if (
            typeof payload.write ===
            "function"
        ) {
            return payload.write(
                typeof value === "string"
                    ? value
                    : safeStringify(value),
                "data"
            );
        }

        if (
            typeof payload.writeLine ===
            "function"
        ) {
            return payload.writeLine(
                typeof value === "string"
                    ? value
                    : safeStringify(value)
            );
        }

        return value;
    }

    function parseOptions(args) {
        const options = {};
        const positional = [];

        for (
            let index = 0;
            index < args.length;
            index += 1
        ) {
            const item =
                String(args[index]);

            if (
                item.startsWith("--") &&
                item.includes("=")
            ) {
                const [key, ...rest] =
                    item.slice(2).split("=");

                options[
                    key.replace(
                        /-([a-z])/g,
                        (_match, letter) =>
                            letter.toUpperCase()
                    )
                ] = rest.join("=");

                continue;
            }

            switch (item) {
                case "--label":
                    options.label =
                        args[++index] || "";
                    break;

                case "--value":
                    options.value =
                        args[++index] || "";
                    break;

                case "--tag":
                    options.tag =
                        args[++index] || "";
                    break;

                case "--query":
                case "-q":
                    options.query =
                        args[++index] || "";
                    break;

                case "--sort":
                    options.sort =
                        args[++index] ||
                        "newest";
                    break;

                case "--limit":
                    options.limit =
                        Number(args[++index]);
                    break;

                case "--tags":
                    options.tags =
                        args[++index] || "";
                    break;

                case "--note":
                    options.note =
                        args[++index] || "";
                    break;

                case "--category":
                    options.category =
                        args[++index] ||
                        "general";
                    break;

                case "--pinned":
                    options.pinned = true;
                    break;

                case "--unpinned":
                    options.pinned = false;
                    break;

                case "--format":
                    options.format =
                        args[++index] ||
                        "json";
                    break;

                case "--include-history":
                    options.includeHistory =
                        true;
                    break;

                case "--replace":
                    options.replace = true;
                    break;

                case "--strict":
                    options.strict = true;
                    break;

                default:
                    positional.push(item);
            }
        }

        return {
            options,
            positional
        };
    }

    function resolveCommandContext(payload = {}) {
        return (
            payload.context ||
            payload.terminal?.context ||
            payload.app?.context ||
            payload
        );
    }

    const commands = [{
        name: "bookmark",
        aliases: [
            "bookmarks",
            "bm"
        ],
        category: "data",
        description:
            "Add, list, inspect, update, remove, clear, import, or export terminal bookmarks.",
        usage: [
            "bookmark add <label> <value> [--tags a,b] [--note text]",
            "bookmark list [--query text] [--tag tag] [--sort newest|oldest|label] [--limit n]",
            "bookmark show <id|label>",
            "bookmark open <id|label>",
            "bookmark update <id|label> [--label name] [--value value] [--tags a,b] [--note text] [--category name]",
            "bookmark pin <id|label>",
            "bookmark unpin <id|label>",
            "bookmark tag <id|label> <tag,...>",
            "bookmark untag <id|label> <tag,...>",
            "bookmark remove <id|label>",
            "bookmark clear",
            "bookmark export [--format json|csv|markdown] [--include-history]",
            "bookmark import <json> [--replace]",
            "bookmark status"
        ].join("\n"),

        handler: async payload => {
            const context =
                resolveCommandContext(payload);

            const bookmarks =
                getService(context) ||
                await initialize(context);

            if (!bookmarks.ready) {
                await bookmarks.initialize();
            }

            const tokens =
                Array.isArray(payload.args)
                    ? Array.from(payload.args)
                    : [];

            const action =
                text(
                    tokens.shift() ||
                    "list"
                ).toLowerCase();

            const parsed =
                parseOptions(tokens);

            const positional =
                parsed.positional;

            const options =
                parsed.options;

            if (action === "add") {
                const label =
                    positional.shift();

                const value =
                    positional.join(" ");

                const bookmark =
                    bookmarks.add(
                        label,
                        value,
                        options
                    );

                payload.write?.(
                    `Bookmark added: ${bookmark.label}`,
                    "success"
                );

                return bookmark;
            }

            if (
                action === "list" ||
                action === "ls"
            ) {
                return outputJSON(
                    payload,
                    bookmarks.list(options)
                );
            }

            if (
                action === "show" ||
                action === "get"
            ) {
                const bookmark =
                    bookmarks.get(
                        positional.join(" ")
                    );

                if (!bookmark) {
                    throw new Error(
                        "Bookmark not found."
                    );
                }

                return outputJSON(
                    payload,
                    bookmark
                );
            }

            if (
                action === "open" ||
                action === "run"
            ) {
                const bookmark =
                    await bookmarks.open(
                        positional.join(" ")
                    );

                if (!bookmark) {
                    throw new Error(
                        "Bookmark not found."
                    );
                }

                payload.write?.(
                    `Bookmark opened: ${bookmark.label}`,
                    "success"
                );

                return bookmark;
            }

            if (
                action === "update" ||
                action === "edit"
            ) {
                const target =
                    positional.join(" ");

                const changes = {};

                for (const key of [
                    "label",
                    "value",
                    "tags",
                    "note",
                    "category",
                    "pinned"
                ]) {
                    if (
                        options[key] !== undefined
                    ) {
                        changes[key] =
                            options[key];
                    }
                }

                const bookmark =
                    bookmarks.update(
                        target,
                        changes
                    );

                if (!bookmark) {
                    throw new Error(
                        "Bookmark not found."
                    );
                }

                payload.write?.(
                    `Bookmark updated: ${bookmark.label}`,
                    "success"
                );

                return bookmark;
            }

            if (
                action === "pin" ||
                action === "unpin"
            ) {
                const bookmark =
                    bookmarks.pin(
                        positional.join(" "),
                        action === "pin"
                    );

                if (!bookmark) {
                    throw new Error(
                        "Bookmark not found."
                    );
                }

                return bookmark;
            }

            if (
                action === "tag" ||
                action === "untag"
            ) {
                const target =
                    positional.shift();

                const tags =
                    positional.join(",");

                const bookmark =
                    action === "tag"
                        ? bookmarks.addTags(
                            target,
                            tags
                        )
                        : bookmarks.removeTags(
                            target,
                            tags
                        );

                if (!bookmark) {
                    throw new Error(
                        "Bookmark not found."
                    );
                }

                return bookmark;
            }

            if (
                action === "remove" ||
                action === "delete" ||
                action === "rm"
            ) {
                const removed =
                    bookmarks.remove(
                        positional.join(" ")
                    );

                if (!removed) {
                    throw new Error(
                        "Bookmark not found."
                    );
                }

                payload.write?.(
                    `Bookmark removed: ${removed.label}`,
                    "success"
                );

                return removed;
            }

            if (action === "clear") {
                const count =
                    await bookmarks.clear();

                payload.write?.(
                    `Removed ${count} bookmark${count === 1 ? "" : "s"}.`,
                    "success"
                );

                return count;
            }

            if (action === "export") {
                const exported =
                    bookmarks.export(options);

                if (
                    typeof exported === "string"
                ) {
                    return payload.write?.(
                        exported,
                        "output",
                        {
                            preformatted: true
                        }
                    ) ?? exported;
                }

                return outputJSON(
                    payload,
                    exported
                );
            }

            if (action === "import") {
                const source =
                    positional.join(" ");

                if (!source) {
                    throw new Error(
                        "Bookmark import JSON is required."
                    );
                }

                return outputJSON(
                    payload,
                    await bookmarks.import(
                        source,
                        options
                    )
                );
            }

            if (action === "status") {
                return outputJSON(
                    payload,
                    bookmarks.status()
                );
            }

            if (action === "history") {
                return outputJSON(
                    payload,
                    {
                        history:
                            clone(
                                bookmarks.history
                            )
                    }
                );
            }

            throw new Error(
                `Unknown bookmark action: ${action}`
            );
        }
    }];

    const api = Object.freeze({
        name: MODULE_NAME,
        version: VERSION,
        service: SERVICE_NAME,
        BOOKMARKS_SYMBOL,
        Bookmarks,
        clone,
        normalizeTags,
        normalizeCategory,
        formulaSafeText,
        csvCell,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalBookmarks =
        api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules ||
        {};

    window.SpeciedexTerminalModules[
        MODULE_NAME
    ] = api;

    safeDispatch(
        document,
        "speciedex:terminal-module-available",
        {
            name: MODULE_NAME,
            module: api
        }
    );
})(window, document);
