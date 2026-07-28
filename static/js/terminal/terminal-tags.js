/*
========================================================================
Speciedex.org
Terminal Tags Module
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Tags";
    const VERSION = "2.2.0";

    const TAGS_SYMBOL =
        Symbol.for("speciedex.terminal.tags.service");

    const DEFAULT_STORAGE_KEY = "tags:index";
    const DEFAULT_MAX_TAGS_PER_RECORD = 128;
    const DEFAULT_MAX_TAG_LENGTH = 128;
    const DEFAULT_MAX_RECORDS = 100000;
    const DEFAULT_MAX_IMPORT_RECORDS = 100000;
    const DEFAULT_MAX_METADATA_ENTRIES = 100000;
    const DEFAULT_MAX_ALIASES = 128;
    const MAX_BATCH_EVENT_DETAILS = 10000;

    const RESERVED_TAGS = new Set([
        "__proto__",
        "prototype",
        "constructor"
    ]);

    const activeDispatches = new WeakMap();

    function now() {
        return Date.now();
    }

    function iso(timestamp = now()) {
        const date = new Date(timestamp);

        return Number.isFinite(date.getTime())
            ? date.toISOString()
            : new Date().toISOString();
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
            typeof value.querySelector === "function"
        );
    }

    function clone(value, seen = new WeakMap()) {
        if (
            value === undefined ||
            value === null ||
            typeof value !== "object"
        ) {
            return value;
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
            return new RegExp(value.source, value.flags);
        }

        if (value instanceof Map) {
            const output = new Map();
            seen.set(value, output);

            for (const [key, item] of value.entries()) {
                output.set(
                    clone(key, seen),
                    clone(item, seen)
                );
            }

            return output;
        }

        if (value instanceof Set) {
            const output = new Set();
            seen.set(value, output);

            for (const item of value.values()) {
                output.add(clone(item, seen));
            }

            return output;
        }

        if (Array.isArray(value)) {
            const output = [];
            seen.set(value, output);

            for (const item of value) {
                output.push(clone(item, seen));
            }

            return output;
        }

        const output = {};
        seen.set(value, output);

        for (const [key, item] of Object.entries(value)) {
            if (RESERVED_TAGS.has(key)) {
                continue;
            }

            output[key] = clone(item, seen);
        }

        return output;
    }

    function safeDispatch(target, name, detail) {
        if (
            !target ||
            typeof target.dispatchEvent !== "function" ||
            !name
        ) {
            return false;
        }

        let names = activeDispatches.get(target);

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
                new CustomEvent(name, { detail })
            );
        } catch (_error) {
            return false;
        } finally {
            names.delete(name);
        }
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

    function parseNumber(
        value,
        fallback,
        minimum = -Infinity,
        maximum = Infinity
    ) {
        const number = Number(value);

        if (!Number.isFinite(number)) {
            return fallback;
        }

        return Math.min(maximum, Math.max(minimum, number));
    }

    function parseInteger(
        value,
        fallback,
        minimum = Number.MIN_SAFE_INTEGER,
        maximum = Number.MAX_SAFE_INTEGER
    ) {
        const number = Number.parseInt(value, 10);

        if (!Number.isFinite(number)) {
            return fallback;
        }

        return Math.min(maximum, Math.max(minimum, number));
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

    function normalizeRecordId(value) {
        const id = String(value ?? "").trim();

        if (!id) {
            throw new TypeError(
                "A non-empty record identifier is required."
            );
        }

        if (id.includes("\u0000")) {
            throw new TypeError(
                "Record identifier contains an invalid null character."
            );
        }

        return id;
    }

    function normalizeTag(value, options = {}) {
        let tag = String(value ?? "").trim();

        if (!tag) {
            throw new TypeError(
                "Tag must be a non-empty string."
            );
        }

        tag = tag
            .normalize("NFKC")
            .replace(/\s+/g, " ")
            .replace(/^#+/, "")
            .trim();

        if (options.preserveCase !== true) {
            tag = tag.toLowerCase();
        }

        if (!tag) {
            throw new TypeError(
                "Tag must contain visible characters."
            );
        }

        const maxLength =
            parseInteger(
                options.maxLength,
                DEFAULT_MAX_TAG_LENGTH,
                1,
                1024
            );

        if (tag.length > maxLength) {
            throw new RangeError(
                `Tag exceeds maximum length of ${maxLength}.`
            );
        }

        if (RESERVED_TAGS.has(tag)) {
            throw new TypeError(
                "Reserved tag name is not allowed."
            );
        }

        return tag;
    }

    function normalizeTags(values, options = {}) {
        const input =
            Array.isArray(values)
                ? values
                : values instanceof Set
                    ? Array.from(values)
                    : typeof values === "string"
                        ? values.split(",")
                        : [values];

        const output = [];
        const seen = new Set();

        for (const value of input) {
            if (
                value === undefined ||
                value === null ||
                value === ""
            ) {
                continue;
            }

            const tag = normalizeTag(value, options);

            if (!seen.has(tag)) {
                seen.add(tag);
                output.push(tag);
            }
        }

        return output;
    }

    function slugify(value) {
        return String(value ?? "")
            .normalize("NFKD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");
    }

    function parseArguments(args = []) {
        const parsed = {
            action: "status",
            positional: [],
            options: {}
        };

        for (const argument of args) {
            const value = String(argument);

            if (value.startsWith("--")) {
                const [key, ...rest] =
                    value.slice(2).split("=");

                parsed.options[key] =
                    rest.length
                        ? rest.join("=")
                        : true;
            } else {
                parsed.positional.push(value);
            }
        }

        if (parsed.positional.length) {
            parsed.action =
                parsed.positional.shift().toLowerCase();
        }

        return parsed;
    }

    class TagService extends EventTarget {
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
                options.storageKey ||
                DEFAULT_STORAGE_KEY;

            this.maxTagsPerRecord =
                parseInteger(
                    options.maxTagsPerRecord,
                    DEFAULT_MAX_TAGS_PER_RECORD,
                    1,
                    10000
                );

            this.maxTagLength =
                parseInteger(
                    options.maxTagLength,
                    DEFAULT_MAX_TAG_LENGTH,
                    1,
                    1024
                );

            this.maxRecords =
                parseInteger(
                    options.maxRecords,
                    DEFAULT_MAX_RECORDS,
                    1,
                    10000000
                );

            this.maxImportRecords =
                parseInteger(
                    options.maxImportRecords,
                    DEFAULT_MAX_IMPORT_RECORDS,
                    1,
                    10000000
                );

            this.maxMetadataEntries =
                parseInteger(
                    options.maxMetadataEntries,
                    DEFAULT_MAX_METADATA_ENTRIES,
                    1,
                    10000000
                );

            this.maxAliases =
                parseInteger(
                    options.maxAliases,
                    DEFAULT_MAX_ALIASES,
                    0,
                    10000
                );

            this.preserveCase =
                options.preserveCase === true;

            this.autoPersist =
                options.autoPersist !== false;

            this.records = new Map();
            this.tagIndex = new Map();
            this.metadata = new Map();
            this.watchers = new Set();

            this.destroyed = false;
            this.ready = false;
            this.lastError = null;
            this.syncingState = false;
            this.emitting = false;
            this.batchDepth = 0;
            this.pendingPersist = false;
            this.pendingEvents = [];
            this.loadPromise = null;
            this.persistPromise = Promise.resolve();
            this.mutationQueue = Promise.resolve();

            this.metrics = {
                adds: 0,
                removes: 0,
                clears: 0,
                imports: 0,
                exports: 0,
                reads: 0,
                writes: 0,
                errors: 0,
                batches: 0,
                deduplicated: 0,
                stateSyncs: 0,
                watcherErrors: 0,
                persistenceErrors: 0,
                metadataUpdates: 0,
                renames: 0,
                merges: 0
            };
        }

        async initialize() {
            this._assertActive();

            if (!this.loadPromise) {
                this.loadPromise =
                    this.load()
                        .finally(() => {
                            this.loadPromise = null;
                        });
            }

            await this.loadPromise;

            this.ready = true;
            this._syncState();

            this._emit("ready", {
                records: this.records.size,
                tags: this.tagIndex.size
            });

            return this;
        }

        _assertActive() {
            if (this.destroyed) {
                throw new Error(
                    "Tag service has been destroyed."
                );
            }
        }

        _normalizeTag(value) {
            return normalizeTag(value, {
                preserveCase: this.preserveCase,
                maxLength: this.maxTagLength
            });
        }

        _normalizeTags(values) {
            return normalizeTags(values, {
                preserveCase: this.preserveCase,
                maxLength: this.maxTagLength
            });
        }

        _recordError(error) {
            this.lastError =
                error instanceof Error
                    ? error
                    : new Error(String(error));

            this.metrics.errors += 1;

            if (!this.destroyed) {
                this._emit("error", {
                    error: {
                        name: this.lastError.name,
                        message:
                            this.lastError.message,
                        stack:
                            this.lastError.stack || ""
                    }
                });
            }

            return this.lastError;
        }

        _emit(type, detail = {}) {
            if (
                this.destroyed &&
                type !== "destroy"
            ) {
                return null;
            }

            const event = {
                type,
                timestamp: iso(),
                service: this,
                ...detail
            };

            if (
                this.batchDepth > 0 &&
                type !== "error"
            ) {
                if (
                    this.pendingEvents.length <
                    MAX_BATCH_EVENT_DETAILS
                ) {
                    this.pendingEvents.push(event);
                }

                return event;
            }

            if (this.emitting) {
                return event;
            }

            this.emitting = true;

            try {
                safeDispatch(this, type, event);
                safeDispatch(this, "change", event);

                for (const watcher of Array.from(
                    this.watchers
                )) {
                    try {
                        watcher(event, this);
                    } catch (error) {
                        this.metrics.watcherErrors += 1;
                        this.lastError =
                            error instanceof Error
                                ? error
                                : new Error(String(error));
                    }
                }

                try {
                    this.context.events?.emit?.(
                        `tags:${type}`,
                        event
                    );
                } catch (error) {
                    this._recordError(error);
                }

                safeDispatch(
                    document,
                    `speciedex:terminal-tags-${type}`,
                    event
                );

                return event;
            } finally {
                this.emitting = false;
            }
        }

        beginBatch() {
            this._assertActive();
            this.batchDepth += 1;

            return this.batchDepth;
        }

        async endBatch(options = {}) {
            if (this.batchDepth <= 0) {
                return 0;
            }

            this.batchDepth -= 1;

            if (this.batchDepth === 0) {
                const events =
                    this.pendingEvents.splice(0);

                if (
                    this.pendingPersist &&
                    options.persist !== false
                ) {
                    this.pendingPersist = false;
                    await this.persist();
                }

                if (events.length) {
                    this.metrics.batches += 1;

                    this._emit("batch", {
                        count: events.length,
                        events
                    });
                }

                this._syncState();
            }

            return this.batchDepth;
        }

        async batch(callback, options = {}) {
            if (typeof callback !== "function") {
                throw new TypeError(
                    "Tag batch requires a callback."
                );
            }

            this.beginBatch();

            try {
                return await callback(this);
            } finally {
                await this.endBatch(options);
            }
        }

        _syncState() {
            if (
                this.syncingState ||
                this.destroyed ||
                this.batchDepth > 0
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
                    "library.tags",
                    {
                        records: this.records.size,
                        tags: this.tagIndex.size,
                        assignments:
                            this.assignmentCount(),
                        lastUpdated: iso(),
                        top:
                            this.topTags(10)
                    },
                    {
                        source: "tags",
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

        _rebuildIndex() {
            this.tagIndex.clear();

            for (
                const [recordId, tags]
                of this.records
            ) {
                for (const tag of tags) {
                    if (!this.tagIndex.has(tag)) {
                        this.tagIndex.set(
                            tag,
                            new Set()
                        );
                    }

                    this.tagIndex
                        .get(tag)
                        .add(recordId);
                }
            }
        }

        _touchMetadata(tag, update = {}) {
            if (
                !this.metadata.has(tag) &&
                this.metadata.size >=
                    this.maxMetadataEntries
            ) {
                throw new RangeError(
                    `Maximum metadata entry count of ${this.maxMetadataEntries} has been reached.`
                );
            }

            const existing =
                this.metadata.get(tag) || {
                    tag,
                    slug: slugify(tag),
                    createdAt: iso(),
                    updatedAt: iso(),
                    color: null,
                    description: "",
                    aliases: []
                };

            const aliasesSource =
                update.aliases !== undefined
                    ? update.aliases
                    : existing.aliases;

            const aliases =
                this._normalizeTags(
                    aliasesSource || []
                )
                    .filter(alias =>
                        alias !== tag
                    )
                    .slice(0, this.maxAliases);

            const next = {
                ...existing,
                ...clone(update),
                tag,
                slug:
                    update.slug !== undefined
                        ? slugify(update.slug)
                        : existing.slug ||
                            slugify(tag),
                aliases,
                updatedAt: iso()
            };

            this.metadata.set(tag, next);

            return next;
        }

        _serialize() {
            const records = Object.create(null);
            const metadata = Object.create(null);

            for (
                const [recordId, tags]
                of this.records
            ) {
                records[recordId] =
                    Array.from(tags).sort();
            }

            for (
                const [tag, value]
                of this.metadata
            ) {
                metadata[tag] = clone(value);
            }

            return {
                schema:
                    "speciedex-terminal-tags",
                schemaVersion: 1,
                exportedAt: iso(),
                records,
                metadata
            };
        }

        async persist(options = {}) {
            this._assertActive();

            if (
                !this.autoPersist &&
                options.force !== true
            ) {
                return false;
            }

            if (this.batchDepth > 0) {
                this.pendingPersist = true;
                return true;
            }

            const payload =
                this._serialize();

            this.persistPromise =
                this.persistPromise
                    .catch(() => false)
                    .then(async () => {
                        try {
                            if (
                                typeof this.storage?.set ===
                                "function"
                            ) {
                                await this.storage.set(
                                    this.storageKey,
                                    payload
                                );
                            } else if (
                                window.localStorage
                            ) {
                                window.localStorage.setItem(
                                    this.storageKey,
                                    safeStringify(payload, true)
                                );
                            } else {
                                return false;
                            }

                            this.metrics.writes += 1;

                            this._emit("persist", {
                                storageKey:
                                    this.storageKey
                            });

                            return true;
                        } catch (error) {
                            this.metrics.persistenceErrors += 1;
                            this._recordError(error);
                            return false;
                        }
                    });

            return this.persistPromise;
        }

        async load() {
            this._assertActive();

            let payload = null;

            try {
                if (
                    typeof this.storage?.get ===
                    "function"
                ) {
                    payload =
                        await this.storage.get(
                            this.storageKey,
                            null
                        );
                } else if (window.localStorage) {
                    const raw =
                        window.localStorage.getItem(
                            this.storageKey
                        );

                    payload =
                        raw
                            ? JSON.parse(raw)
                            : null;
                }
            } catch (error) {
                this.metrics.persistenceErrors += 1;
                this._recordError(error);
                return false;
            }

            if (!isObject(payload)) {
                return false;
            }

            const nextRecords = new Map();
            const nextMetadata = new Map();

            try {
                const records =
                    isObject(payload.records)
                        ? payload.records
                        : {};

                const metadata =
                    isObject(payload.metadata)
                        ? payload.metadata
                        : {};

                const recordEntries =
                    Object.entries(records)
                        .slice(0, this.maxRecords);

                const metadataEntries =
                    Object.entries(metadata)
                        .slice(
                            0,
                            this.maxMetadataEntries
                        );

                for (
                    const [recordId, tags]
                    of recordEntries
                ) {
                    const normalizedId =
                        normalizeRecordId(recordId);

                    const normalizedTags =
                        this._normalizeTags(tags)
                            .slice(
                                0,
                                this.maxTagsPerRecord
                            );

                    if (normalizedTags.length) {
                        nextRecords.set(
                            normalizedId,
                            new Set(normalizedTags)
                        );
                    }
                }

                for (
                    const [tag, value]
                    of metadataEntries
                ) {
                    const normalized =
                        this._normalizeTag(tag);

                    const source =
                        isObject(value)
                            ? value
                            : {};

                    nextMetadata.set(
                        normalized,
                        {
                            tag: normalized,
                            slug:
                                source.slug ||
                                slugify(normalized),
                            createdAt:
                                source.createdAt ||
                                iso(),
                            updatedAt:
                                source.updatedAt ||
                                iso(),
                            color:
                                source.color || null,
                            description:
                                source.description || "",
                            aliases:
                                this._normalizeTags(
                                    source.aliases || []
                                )
                                    .filter(alias =>
                                        alias !== normalized
                                    )
                                    .slice(
                                        0,
                                        this.maxAliases
                                    )
                        }
                    );
                }
            } catch (error) {
                this._recordError(error);
                return false;
            }

            this.records = nextRecords;
            this.metadata = nextMetadata;
            this._rebuildIndex();

            this.metrics.reads += 1;

            this._emit("load", {
                records: this.records.size,
                tags: this.tagIndex.size
            });

            this._syncState();

            return true;
        }

        add(recordId, tags, options = {}) {
            this._assertActive();

            recordId =
                normalizeRecordId(recordId);

            const normalized =
                this._normalizeTags(tags);

            if (!normalized.length) {
                return [];
            }

            if (
                !this.records.has(recordId) &&
                this.records.size >= this.maxRecords
            ) {
                throw new RangeError(
                    `Maximum record count of ${this.maxRecords} has been reached.`
                );
            }

            const recordTags =
                this.records.get(recordId) ||
                new Set();

            const additions = [];

            for (const tag of normalized) {
                if (recordTags.has(tag)) {
                    this.metrics.deduplicated += 1;
                    continue;
                }

                if (
                    recordTags.size >=
                    this.maxTagsPerRecord
                ) {
                    throw new RangeError(
                        `Record "${recordId}" exceeds ${this.maxTagsPerRecord} tags.`
                    );
                }

                recordTags.add(tag);
                additions.push(tag);

                if (!this.tagIndex.has(tag)) {
                    this.tagIndex.set(
                        tag,
                        new Set()
                    );
                }

                this.tagIndex
                    .get(tag)
                    .add(recordId);

                this._touchMetadata(tag);
            }

            if (recordTags.size) {
                this.records.set(
                    recordId,
                    recordTags
                );
            }

            this.metrics.adds +=
                additions.length;

            if (additions.length) {
                if (options.persist !== false) {
                    if (this.batchDepth > 0) {
                        this.pendingPersist = true;
                    } else {
                        void this.persist();
                    }
                }

                this._emit("add", {
                    recordId,
                    tags: additions,
                    total: recordTags.size
                });

                this._syncState();
            }

            return additions;
        }

        remove(recordId, tags, options = {}) {
            this._assertActive();

            recordId =
                normalizeRecordId(recordId);

            if (!this.records.has(recordId)) {
                return [];
            }

            const recordTags =
                this.records.get(recordId);

            const requested =
                tags === undefined ||
                tags === null
                    ? Array.from(recordTags)
                    : this._normalizeTags(tags);

            const removed = [];

            for (const tag of requested) {
                if (!recordTags.delete(tag)) {
                    continue;
                }

                removed.push(tag);

                const records =
                    this.tagIndex.get(tag);

                if (records) {
                    records.delete(recordId);

                    if (!records.size) {
                        this.tagIndex.delete(tag);

                        if (
                            options.keepMetadata !== true
                        ) {
                            this.metadata.delete(tag);
                        }
                    }
                }
            }

            if (!recordTags.size) {
                this.records.delete(recordId);
            }

            this.metrics.removes +=
                removed.length;

            if (removed.length) {
                if (options.persist !== false) {
                    if (this.batchDepth > 0) {
                        this.pendingPersist = true;
                    } else {
                        void this.persist();
                    }
                }

                this._emit("remove", {
                    recordId,
                    tags: removed
                });

                this._syncState();
            }

            return removed;
        }

        async replace(recordId, tags, options = {}) {
            this._assertActive();

            recordId =
                normalizeRecordId(recordId);

            const desired =
                new Set(
                    this._normalizeTags(tags)
                );

            if (
                desired.size >
                this.maxTagsPerRecord
            ) {
                throw new RangeError(
                    `Record "${recordId}" exceeds ${this.maxTagsPerRecord} tags.`
                );
            }

            const current =
                new Set(
                    this.records.get(recordId) ||
                    []
                );

            const remove =
                Array.from(current)
                    .filter(tag =>
                        !desired.has(tag)
                    );

            const add =
                Array.from(desired)
                    .filter(tag =>
                        !current.has(tag)
                    );

            await this.batch(
                () => {
                    if (remove.length) {
                        this.remove(
                            recordId,
                            remove,
                            {
                                persist: false,
                                keepMetadata:
                                    options.keepMetadata
                            }
                        );
                    }

                    if (add.length) {
                        this.add(
                            recordId,
                            add,
                            { persist: false }
                        );
                    }
                },
                { persist: false }
            );

            if (options.persist !== false) {
                await this.persist();
            }

            const result = {
                recordId,
                added: add,
                removed: remove,
                tags: this.get(recordId)
            };

            this._emit("replace", result);
            this._syncState();

            return result;
        }

        toggle(recordId, tag, options = {}) {
            this._assertActive();

            recordId =
                normalizeRecordId(recordId);

            tag =
                this._normalizeTag(tag);

            if (this.has(recordId, tag)) {
                this.remove(
                    recordId,
                    [tag],
                    options
                );

                return false;
            }

            this.add(
                recordId,
                [tag],
                options
            );

            return true;
        }

        get(recordId) {
            this._assertActive();
            this.metrics.reads += 1;

            recordId =
                normalizeRecordId(recordId);

            return Array.from(
                this.records.get(recordId) ||
                []
            ).sort();
        }

        has(recordId, tag = null) {
            this._assertActive();

            recordId =
                normalizeRecordId(recordId);

            if (!this.records.has(recordId)) {
                return false;
            }

            if (
                tag === null ||
                tag === undefined
            ) {
                return true;
            }

            return this.records
                .get(recordId)
                .has(
                    this._normalizeTag(tag)
                );
        }

        recordsFor(tag) {
            this._assertActive();
            this.metrics.reads += 1;

            tag = this._normalizeTag(tag);

            return Array.from(
                this.tagIndex.get(tag) ||
                []
            ).sort();
        }

        recordsWith(tags, options = {}) {
            this._assertActive();

            const normalized =
                this._normalizeTags(tags);

            if (!normalized.length) {
                return [];
            }

            const mode =
                String(options.mode || "all")
                    .toLowerCase();

            const sets =
                normalized.map(tag =>
                    new Set(
                        this.tagIndex.get(tag) ||
                        []
                    )
                );

            if (mode === "any") {
                const union = new Set();

                for (const set of sets) {
                    for (const recordId of set) {
                        union.add(recordId);
                    }
                }

                return Array.from(union).sort();
            }

            const first =
                sets.shift() ||
                new Set();

            return Array.from(first)
                .filter(recordId =>
                    sets.every(set =>
                        set.has(recordId)
                    )
                )
                .sort();
        }

        list(options = {}) {
            this._assertActive();
            this.metrics.reads += 1;

            const query =
                String(options.query || "")
                    .trim()
                    .toLowerCase();

            const minimum =
                parseInteger(
                    options.minimum,
                    0,
                    0
                );

            const maximum =
                parseInteger(
                    options.maximum,
                    Number.MAX_SAFE_INTEGER,
                    0
                );

            const sort =
                String(options.sort || "name")
                    .toLowerCase();

            const direction =
                options.direction === "desc"
                    ? "desc"
                    : "asc";

            const multiplier =
                direction === "desc"
                    ? -1
                    : 1;

            let items =
                Array.from(this.tagIndex.entries())
                    .map(([tag, records]) => ({
                        tag,
                        slug:
                            this.metadata.get(tag)?.slug ||
                            slugify(tag),
                        count: records.size,
                        records:
                            options.includeRecords === true
                                ? Array.from(records).sort()
                                : undefined,
                        metadata:
                            options.includeMetadata === true
                                ? clone(
                                    this.metadata.get(tag) ||
                                    null
                                )
                                : undefined
                    }));

            if (query) {
                items = items.filter(item => {
                    const metadata =
                        this.metadata.get(item.tag);

                    return (
                        item.tag
                            .toLowerCase()
                            .includes(query) ||
                        metadata?.description
                            ?.toLowerCase()
                            .includes(query) ||
                        metadata?.aliases
                            ?.some(alias =>
                                String(alias)
                                    .toLowerCase()
                                    .includes(query)
                            )
                    );
                });
            }

            items = items.filter(item =>
                item.count >= minimum &&
                item.count <= maximum
            );

            items.sort((left, right) => {
                if (sort === "count") {
                    return (
                        (left.count - right.count) *
                        multiplier
                    ) || left.tag.localeCompare(
                        right.tag,
                        undefined,
                        {
                            numeric: true,
                            sensitivity: "base"
                        }
                    );
                }

                return left.tag.localeCompare(
                    right.tag,
                    undefined,
                    {
                        numeric: true,
                        sensitivity: "base"
                    }
                ) * multiplier;
            });

            const limit =
                parseInteger(
                    options.limit,
                    items.length,
                    0,
                    items.length
                );

            return limit
                ? items.slice(0, limit)
                : [];
        }

        topTags(limit = 10) {
            return this.list({
                sort: "count",
                direction: "desc",
                limit
            });
        }

        setMetadata(tag, update = {}, options = {}) {
            this._assertActive();

            tag = this._normalizeTag(tag);

            if (!isObject(update)) {
                throw new TypeError(
                    "Tag metadata update must be an object."
                );
            }

            const patch = {};

            if (update.description !== undefined) {
                patch.description =
                    String(update.description);
            }

            if (update.color !== undefined) {
                patch.color =
                    update.color === null
                        ? null
                        : String(update.color);
            }

            if (update.slug !== undefined) {
                patch.slug =
                    slugify(update.slug);
            }

            if (update.aliases !== undefined) {
                patch.aliases =
                    this._normalizeTags(
                        update.aliases
                    )
                        .filter(alias =>
                            alias !== tag
                        )
                        .slice(
                            0,
                            this.maxAliases
                        );
            }

            const metadata =
                this._touchMetadata(
                    tag,
                    patch
                );

            this.metrics.metadataUpdates += 1;

            if (options.persist !== false) {
                void this.persist();
            }

            this._emit("metadata", {
                tag,
                metadata: clone(metadata)
            });

            return clone(metadata);
        }

        getMetadata(tag) {
            this._assertActive();

            tag = this._normalizeTag(tag);

            return clone(
                this.metadata.get(tag) ||
                null
            );
        }

        async rename(oldTag, newTag, options = {}) {
            this._assertActive();

            oldTag = this._normalizeTag(oldTag);
            newTag = this._normalizeTag(newTag);

            if (oldTag === newTag) {
                return {
                    oldTag,
                    newTag,
                    records:
                        this.recordsFor(oldTag)
                };
            }

            const affected =
                this.recordsFor(oldTag);

            if (!affected.length) {
                return {
                    oldTag,
                    newTag,
                    records: []
                };
            }

            const oldMetadata =
                clone(
                    this.metadata.get(oldTag) ||
                    null
                );

            const snapshots = new Map();

            for (const recordId of affected) {
                snapshots.set(
                    recordId,
                    new Set(
                        this.records.get(recordId)
                    )
                );
            }

            try {
                for (const recordId of affected) {
                    const recordTags =
                        this.records.get(recordId);

                    recordTags.delete(oldTag);
                    recordTags.add(newTag);

                    if (
                        recordTags.size >
                        this.maxTagsPerRecord
                    ) {
                        throw new RangeError(
                            `Record "${recordId}" exceeds ${this.maxTagsPerRecord} tags.`
                        );
                    }
                }

                this._rebuildIndex();
                this.metadata.delete(oldTag);

                this._touchMetadata(
                    newTag,
                    {
                        ...(oldMetadata || {}),
                        slug:
                            slugify(newTag),
                        aliases:
                            [
                                ...(
                                    oldMetadata?.aliases ||
                                    []
                                ),
                                oldTag
                            ]
                    }
                );
            } catch (error) {
                for (
                    const [recordId, snapshot]
                    of snapshots
                ) {
                    this.records.set(
                        recordId,
                        snapshot
                    );
                }

                this._rebuildIndex();

                if (oldMetadata) {
                    this.metadata.set(
                        oldTag,
                        oldMetadata
                    );
                }

                throw error;
            }

            if (options.persist !== false) {
                await this.persist();
            }

            this.metrics.renames += 1;

            const result = {
                oldTag,
                newTag,
                records: affected
            };

            this._emit("rename", result);
            this._syncState();

            return result;
        }

        async merge(sourceTags, targetTag, options = {}) {
            this._assertActive();

            const sources =
                this._normalizeTags(sourceTags)
                    .filter(tag =>
                        tag !== targetTag
                    );

            targetTag =
                this._normalizeTag(targetTag);

            const affected = new Set();
            const snapshots = new Map();

            for (const source of sources) {
                for (
                    const recordId
                    of this.recordsFor(source)
                ) {
                    affected.add(recordId);

                    if (!snapshots.has(recordId)) {
                        snapshots.set(
                            recordId,
                            new Set(
                                this.records.get(recordId)
                            )
                        );
                    }
                }
            }

            try {
                for (const recordId of affected) {
                    const tags =
                        this.records.get(recordId);

                    for (const source of sources) {
                        tags.delete(source);
                    }

                    tags.add(targetTag);

                    if (
                        tags.size >
                        this.maxTagsPerRecord
                    ) {
                        throw new RangeError(
                            `Record "${recordId}" exceeds ${this.maxTagsPerRecord} tags.`
                        );
                    }
                }

                this._rebuildIndex();

                for (const source of sources) {
                    this.metadata.delete(source);
                }

                if (affected.size) {
                    this._touchMetadata(targetTag);
                }
            } catch (error) {
                for (
                    const [recordId, snapshot]
                    of snapshots
                ) {
                    this.records.set(
                        recordId,
                        snapshot
                    );
                }

                this._rebuildIndex();
                throw error;
            }

            if (options.persist !== false) {
                await this.persist();
            }

            this.metrics.merges += 1;

            const result = {
                sources,
                targetTag,
                records:
                    Array.from(affected).sort()
            };

            this._emit("merge", result);
            this._syncState();

            return result;
        }

        async clear(options = {}) {
            this._assertActive();

            const recordCount =
                this.records.size;

            const tagCount =
                this.tagIndex.size;

            this.records.clear();
            this.tagIndex.clear();

            if (options.keepMetadata !== true) {
                this.metadata.clear();
            }

            this.metrics.clears += 1;

            if (options.persist !== false) {
                await this.persist();
            }

            const result = {
                records: recordCount,
                tags: tagCount
            };

            this._emit("clear", result);
            this._syncState();

            return result;
        }

        assignmentCount() {
            let count = 0;

            for (const tags of this.records.values()) {
                count += tags.size;
            }

            return count;
        }

        export(options = {}) {
            this._assertActive();
            this.metrics.exports += 1;

            const payload =
                this._serialize();

            this._emit("export", {
                records: this.records.size,
                tags: this.tagIndex.size
            });

            return options.stringify === false
                ? payload
                : safeStringify(
                    payload,
                    options.pretty === false
                );
        }

        async import(input, options = {}) {
            this._assertActive();

            const payload =
                typeof input === "string"
                    ? JSON.parse(input)
                    : clone(input);

            if (!isObject(payload)) {
                throw new TypeError(
                    "Tag import must be an object or JSON string."
                );
            }

            const sourceRecords =
                isObject(payload.records)
                    ? payload.records
                    : payload;

            const sourceMetadata =
                isObject(payload.metadata)
                    ? payload.metadata
                    : {};

            const recordEntries =
                Object.entries(sourceRecords);

            if (
                recordEntries.length >
                this.maxImportRecords
            ) {
                throw new RangeError(
                    `Tag import exceeds record limit: ${this.maxImportRecords}`
                );
            }

            const metadataEntries =
                Object.entries(sourceMetadata);

            if (
                metadataEntries.length >
                this.maxMetadataEntries
            ) {
                throw new RangeError(
                    `Tag metadata import exceeds limit: ${this.maxMetadataEntries}`
                );
            }

            const recordsSnapshot =
                new Map(
                    Array.from(this.records.entries())
                        .map(([id, tags]) => [
                            id,
                            new Set(tags)
                        ])
                );

            const metadataSnapshot =
                new Map(
                    Array.from(this.metadata.entries())
                        .map(([tag, value]) => [
                            tag,
                            clone(value)
                        ])
                );

            let importedRecords = 0;
            let importedAssignments = 0;
            const skipped = [];

            try {
                if (options.replace === true) {
                    this.records.clear();
                    this.tagIndex.clear();
                    this.metadata.clear();
                }

                await this.batch(
                    () => {
                        for (
                            const [recordId, tags]
                            of recordEntries
                        ) {
                            try {
                                const additions =
                                    this.add(
                                        recordId,
                                        tags,
                                        { persist: false }
                                    );

                                importedRecords += 1;
                                importedAssignments +=
                                    additions.length;
                            } catch (error) {
                                skipped.push({
                                    recordId,
                                    error:
                                        error.message
                                });

                                if (
                                    options.strict === true
                                ) {
                                    throw error;
                                }
                            }
                        }

                        for (
                            const [tag, metadata]
                            of metadataEntries
                        ) {
                            try {
                                this.setMetadata(
                                    tag,
                                    metadata,
                                    { persist: false }
                                );
                            } catch (error) {
                                skipped.push({
                                    tag,
                                    error:
                                        error.message
                                });

                                if (
                                    options.strict === true
                                ) {
                                    throw error;
                                }
                            }
                        }
                    },
                    { persist: false }
                );
            } catch (error) {
                this.records = recordsSnapshot;
                this.metadata = metadataSnapshot;
                this._rebuildIndex();
                throw error;
            }

            this.metrics.imports += 1;

            if (options.persist !== false) {
                await this.persist();
            }

            const result = {
                records: importedRecords,
                assignments:
                    importedAssignments,
                skipped
            };

            this._emit("import", result);
            this._syncState();

            return result;
        }

        watch(callback, options = {}) {
            this._assertActive();

            if (typeof callback !== "function") {
                throw new TypeError(
                    "Tag watcher must be a function."
                );
            }

            this.watchers.add(callback);

            if (options.immediate === true) {
                callback(
                    {
                        type: "initial",
                        timestamp: iso(),
                        status: this.status()
                    },
                    this
                );
            }

            return () =>
                this.watchers.delete(callback);
        }

        status() {
            return {
                name: "tags",
                module: MODULE_NAME,
                version: VERSION,
                ready: this.ready,
                records: this.records.size,
                tags: this.tagIndex.size,
                assignments:
                    this.assignmentCount(),
                storageKey:
                    this.storageKey,
                persistent:
                    Boolean(
                        this.storage ||
                        window.localStorage
                    ),
                autoPersist:
                    this.autoPersist,
                preserveCase:
                    this.preserveCase,
                maxTagsPerRecord:
                    this.maxTagsPerRecord,
                maxTagLength:
                    this.maxTagLength,
                maxRecords:
                    this.maxRecords,
                maxImportRecords:
                    this.maxImportRecords,
                maxMetadataEntries:
                    this.maxMetadataEntries,
                maxAliases:
                    this.maxAliases,
                batchDepth:
                    this.batchDepth,
                pendingPersist:
                    this.pendingPersist,
                topTags:
                    this.topTags(10),
                metrics: {
                    ...this.metrics
                },
                lastError:
                    this.lastError
                        ? {
                            name:
                                this.lastError.name,
                            message:
                                this.lastError.message
                        }
                        : null,
                destroyed:
                    this.destroyed
            };
        }

        async run(parameters = {}) {
            const args =
                Array.isArray(parameters.args)
                    ? parameters.args
                    : [];

            const parsed =
                parseArguments(args);

            const action =
                parsed.action;

            const positional =
                parsed.positional;

            const options =
                parsed.options;

            switch (action) {
                case "status":
                case "show":
                case "info":
                    return this.status();

                case "list":
                case "all":
                    return {
                        count:
                            this.tagIndex.size,
                        tags:
                            this.list({
                                query:
                                    options.query,
                                minimum:
                                    options.min,
                                maximum:
                                    options.max,
                                sort:
                                    options.sort,
                                direction:
                                    options.desc === true
                                        ? "desc"
                                        : options.direction,
                                limit:
                                    options.limit,
                                includeRecords:
                                    options.records === true,
                                includeMetadata:
                                    options.metadata === true
                            })
                    };

                case "get":
                    if (!positional[0]) {
                        throw new Error(
                            "Usage: tags get <record-id>"
                        );
                    }

                    return {
                        recordId:
                            positional[0],
                        tags:
                            this.get(positional[0])
                    };

                case "add":
                    if (
                        !positional[0] ||
                        positional.length < 2
                    ) {
                        throw new Error(
                            "Usage: tags add <record-id> <tag[,tag...]>"
                        );
                    }

                    return {
                        recordId:
                            positional[0],
                        added:
                            this.add(
                                positional[0],
                                positional
                                    .slice(1)
                                    .join(" ")
                            ),
                        tags:
                            this.get(positional[0])
                    };

                case "remove":
                case "rm":
                case "delete":
                    if (!positional[0]) {
                        throw new Error(
                            "Usage: tags remove <record-id> [tag[,tag...]]"
                        );
                    }

                    return {
                        recordId:
                            positional[0],
                        removed:
                            this.remove(
                                positional[0],
                                positional.length > 1
                                    ? positional
                                        .slice(1)
                                        .join(" ")
                                    : null
                            ),
                        tags:
                            this.records.has(
                                positional[0]
                            )
                                ? this.get(
                                    positional[0]
                                )
                                : []
                    };

                case "replace":
                case "set":
                    if (!positional[0]) {
                        throw new Error(
                            "Usage: tags replace <record-id> <tag[,tag...]>"
                        );
                    }

                    return this.replace(
                        positional[0],
                        positional
                            .slice(1)
                            .join(" ")
                    );

                case "records":
                    if (!positional[0]) {
                        throw new Error(
                            "Usage: tags records <tag[,tag...]> [--mode=all|any]"
                        );
                    }

                    return {
                        tags:
                            this._normalizeTags(
                                positional.join(" ")
                            ),
                        mode:
                            options.mode || "all",
                        records:
                            this.recordsWith(
                                positional.join(" "),
                                {
                                    mode:
                                        options.mode ||
                                        "all"
                                }
                            )
                    };

                case "rename":
                    if (
                        !positional[0] ||
                        !positional[1]
                    ) {
                        throw new Error(
                            "Usage: tags rename <old-tag> <new-tag>"
                        );
                    }

                    return this.rename(
                        positional[0],
                        positional
                            .slice(1)
                            .join(" ")
                    );

                case "merge":
                    if (
                        !positional[0] ||
                        !options.into
                    ) {
                        throw new Error(
                            "Usage: tags merge <tag[,tag...]> --into=<target-tag>"
                        );
                    }

                    return this.merge(
                        positional.join(" "),
                        options.into
                    );

                case "metadata":
                    if (!positional[0]) {
                        throw new Error(
                            "Usage: tags metadata <tag>"
                        );
                    }

                    if (
                        options.description !== undefined ||
                        options.color !== undefined ||
                        options.slug !== undefined ||
                        options.aliases !== undefined
                    ) {
                        return this.setMetadata(
                            positional[0],
                            {
                                description:
                                    options.description,
                                color:
                                    options.color,
                                slug:
                                    options.slug,
                                aliases:
                                    options.aliases
                            }
                        );
                    }

                    return this.getMetadata(
                        positional[0]
                    );

                case "clear":
                    return this.clear({
                        keepMetadata:
                            options["keep-metadata"] === true
                    });

                case "export":
                    return this.export({
                        stringify:
                            options.json !== true,
                        pretty:
                            options.compact !== true
                    });

                case "import":
                    if (!positional.length) {
                        throw new Error(
                            "Usage: tags import <JSON> [--replace]"
                        );
                    }

                    return this.import(
                        positional.join(" "),
                        {
                            replace:
                                options.replace === true,
                            strict:
                                options.strict === true
                        }
                    );

                case "reload":
                    return {
                        loaded:
                            await this.load(),
                        status:
                            this.status()
                    };

                default:
                    throw new Error(
                        `Unknown tags action "${action}".`
                    );
            }
        }

        async destroy() {
            if (this.destroyed) {
                return false;
            }

            try {
                await this.persist({
                    force: true
                });
            } catch (_error) {
                /* Persist errors are already recorded. */
            }

            this._emit("destroy", {
                version: VERSION
            });

            this.watchers.clear();
            this.pendingEvents = [];
            this.records.clear();
            this.tagIndex.clear();
            this.metadata.clear();

            const root =
                this.context.root;

            if (
                root &&
                root[TAGS_SYMBOL] === this
            ) {
                delete root[TAGS_SYMBOL];
            }

            this.destroyed = true;
            this.ready = false;

            return true;
        }
    }

    function getService(context) {
        return (
            context?.tags ||
            context?.services?.get?.("tags") ||
            context?.services?.tags ||
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
            safeContext.tags instanceof
                TagService
                ? safeContext.tags
                : safeContext.services?.get?.(
                    "tags"
                ) ||
                root?.[TAGS_SYMBOL];

        if (
            existing instanceof TagService &&
            !existing.destroyed
        ) {
            safeContext.tags = existing;

            safeContext.registerService?.(
                "tags",
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
            safeContext.config?.tags || {};

        const service =
            new TagService(
                safeContext,
                {
                    storage:
                        safeContext.storage ||
                        safeContext.services?.get?.(
                            "storage"
                        ) ||
                        null,
                    storageKey:
                        dataset.terminalTagsStorageKey ||
                        config.storageKey ||
                        DEFAULT_STORAGE_KEY,
                    maxTagsPerRecord:
                        dataset.terminalTagsMaxPerRecord ||
                        config.maxTagsPerRecord ||
                        DEFAULT_MAX_TAGS_PER_RECORD,
                    maxTagLength:
                        dataset.terminalTagsMaxLength ||
                        config.maxTagLength ||
                        DEFAULT_MAX_TAG_LENGTH,
                    maxRecords:
                        dataset.terminalTagsMaxRecords ||
                        config.maxRecords ||
                        DEFAULT_MAX_RECORDS,
                    maxImportRecords:
                        dataset.terminalTagsMaxImportRecords ||
                        config.maxImportRecords ||
                        DEFAULT_MAX_IMPORT_RECORDS,
                    maxMetadataEntries:
                        dataset.terminalTagsMaxMetadataEntries ||
                        config.maxMetadataEntries ||
                        DEFAULT_MAX_METADATA_ENTRIES,
                    maxAliases:
                        dataset.terminalTagsMaxAliases ||
                        config.maxAliases ||
                        DEFAULT_MAX_ALIASES,
                    preserveCase:
                        parseBoolean(
                            dataset.terminalTagsPreserveCase,
                            config.preserveCase === true
                        ),
                    autoPersist:
                        parseBoolean(
                            dataset.terminalTagsAutoPersist,
                            config.autoPersist !== false
                        )
                }
            );

        root[TAGS_SYMBOL] = service;
        safeContext.tags = service;

        safeContext.registerService?.(
            "tags",
            service
        );

        await service.initialize();

        safeDispatch(
            document,
            "speciedex:terminal-tags-ready",
            {
                service,
                status:
                    service.status(),
                version: VERSION
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

    const commands = [{
        name: "tags",
        aliases: ["tag"],
        category: "data",
        description:
            "Create, inspect, search, rename, merge, and persist tags for terminal records.",
        usage:
            "tags [status|list|get|add|remove|replace|records|rename|merge|" +
            "metadata|clear|export|import|reload] [arguments]",

        handler: async payload => {
            const context =
                resolveCommandContext(payload);

            const service =
                getService(context);

            if (!service) {
                throw new Error(
                    "Tags service is unavailable."
                );
            }

            try {
                if (!service.ready) {
                    await service.initialize();
                }

                const result =
                    await service.run({
                        args:
                            Array.isArray(payload.args)
                                ? payload.args
                                : []
                    });

                if (
                    typeof result === "string" &&
                    typeof payload.write === "function"
                ) {
                    return payload.write(
                        result,
                        "data"
                    );
                }

                if (
                    typeof payload.writeJSON ===
                    "function"
                ) {
                    return payload.writeJSON(result);
                }

                if (
                    typeof payload.write === "function"
                ) {
                    return payload.write(
                        safeStringify(result),
                        "data"
                    );
                }

                return result;
            } catch (error) {
                if (
                    typeof payload.writeError ===
                    "function"
                ) {
                    payload.writeError(
                        error.message
                    );

                    return null;
                }

                throw error;
            }
        }
    }];

    const api = Object.freeze({
        name: MODULE_NAME,
        version: VERSION,
        TAGS_SYMBOL,
        TagService,
        normalizeRecordId,
        normalizeTag,
        normalizeTags,
        slugify,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalTags = api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules || {};

    window.SpeciedexTerminalModules[MODULE_NAME] =
        api;

    safeDispatch(
        document,
        "speciedex:terminal-module-available",
        {
            name: MODULE_NAME,
            module: api
        }
    );
})(window, document);
