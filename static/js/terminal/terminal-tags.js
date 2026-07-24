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
    const VERSION = "2.1.0";

    const TAGS_SYMBOL =
        Symbol.for(
            "speciedex.terminal.tags.service"
        );

    const DEFAULT_STORAGE_KEY = "tags:index";
    const DEFAULT_MAX_TAGS_PER_RECORD = 128;
    const DEFAULT_MAX_TAG_LENGTH = 128;
    const DEFAULT_MAX_RECORDS = 100000;
    const DEFAULT_MAX_IMPORT_RECORDS = 100000;
    const DEFAULT_MAX_METADATA_ENTRIES = 100000;
    const DEFAULT_MAX_ALIASES = 128;
    const RESERVED_TAGS = new Set(["__proto__", "prototype", "constructor"]);

    function now() {
        return Date.now();
    }

    function iso(timestamp = now()) {
        return new Date(timestamp).toISOString();
    }

    function isObject(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    function clone(
        value,
        seen =
            new WeakMap()
    ) {
        if (
            value ===
                undefined ||
            value ===
                null ||
            typeof value !==
                "object"
        ) {
            return value;
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

        if (
            value instanceof
                Map
        ) {
            const output =
                new Map();

            seen.set(
                value,
                output
            );

            for (
                const [
                    key,
                    item
                ] of value
            ) {
                output.set(
                    clone(
                        key,
                        seen
                    ),
                    clone(
                        item,
                        seen
                    )
                );
            }

            return output;
        }

        if (
            value instanceof
                Set
        ) {
            const output =
                new Set();

            seen.set(
                value,
                output
            );

            for (
                const item of
                value
            ) {
                output.add(
                    clone(
                        item,
                        seen
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
                        seen
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
                RESERVED_TAGS.has(
                    key
                )
            ) {
                continue;
            }

            output[
                key
            ] =
                clone(
                    item,
                    seen
                );
        }

        return output;
    }

    function safeDispatch(
        target,
        name,
        detail
    ) {
        if (
            !target ||
            typeof target.dispatchEvent !==
                "function"
        ) {
            return false;
        }

        try {
            target.dispatchEvent(
                new CustomEvent(
                    name,
                    {
                        detail
                    }
                )
            );

            return true;
        } catch (_error) {
            return false;
        }
    }

    function parseBoolean(value, fallback = false) {
        if (typeof value === "boolean") {
            return value;
        }

        if (value === undefined || value === null || value === "") {
            return fallback;
        }

        return ["1", "true", "yes", "on", "enabled"].includes(
            String(value).trim().toLowerCase()
        );
    }

    function parseNumber(value, fallback, minimum = -Infinity, maximum = Infinity) {
        const number = Number(value);

        if (!Number.isFinite(number)) {
            return fallback;
        }

        return Math.min(maximum, Math.max(minimum, number));
    }

    function normalizeRecordId(value) {
        const id = String(value ?? "").trim();

        if (!id) {
            throw new TypeError("A non-empty record identifier is required.");
        }

        if (id.includes("\u0000")) {
            throw new TypeError("Record identifier contains an invalid null character.");
        }

        return id;
    }

    function normalizeTag(value, options = {}) {
        let tag = String(value ?? "").trim();

        if (!tag) {
            throw new TypeError("Tag must be a non-empty string.");
        }

        if (options.preserveCase !== true) {
            tag = tag.toLowerCase();
        }

        tag = tag
            .normalize("NFKC")
            .replace(/\s+/g, " ")
            .replace(/^#+/, "")
            .trim();

        if (!tag) {
            throw new TypeError("Tag must contain visible characters.");
        }

        if (tag.length > (options.maxLength || DEFAULT_MAX_TAG_LENGTH)) {
            throw new RangeError(
                `Tag exceeds maximum length of ${options.maxLength || DEFAULT_MAX_TAG_LENGTH}.`
            );
        }

        if (RESERVED_TAGS.has(tag)) {
            throw new TypeError("Reserved tag name is not allowed.");
        }

        return tag;
    }

    function normalizeTags(values, options = {}) {
        const input = Array.isArray(values)
            ? values
            : values instanceof Set
                ? Array.from(values)
                : typeof values === "string"
                    ? values.split(",")
                    : [values];

        const output = [];
        const seen = new Set();

        for (const value of input) {
            if (value === undefined || value === null || value === "") {
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
                const [key, ...rest] = value.slice(2).split("=");
                parsed.options[key] = rest.length ? rest.join("=") : true;
            } else {
                parsed.positional.push(value);
            }
        }

        if (parsed.positional.length) {
            parsed.action = parsed.positional.shift().toLowerCase();
        }

        return parsed;
    }

    class TagService extends EventTarget {
        constructor(context = {}, options = {}) {
            super();

            this.context = context;
            this.storage = options.storage ||
                context.storage ||
                context.services?.get?.("storage") ||
                null;
            this.storageKey = options.storageKey || DEFAULT_STORAGE_KEY;
            this.maxTagsPerRecord = parseNumber(
                options.maxTagsPerRecord,
                DEFAULT_MAX_TAGS_PER_RECORD,
                1,
                10000
            );
            this.maxTagLength = parseNumber(
                options.maxTagLength,
                DEFAULT_MAX_TAG_LENGTH,
                1,
                1024
            );
            this.maxRecords = parseNumber(
                options.maxRecords,
                DEFAULT_MAX_RECORDS,
                1,
                10000000
            );
            this.preserveCase = options.preserveCase === true;
            this.autoPersist =
                options.autoPersist !==
                false;

            this.maxImportRecords =
                parseNumber(
                    options.maxImportRecords,
                    DEFAULT_MAX_IMPORT_RECORDS,
                    1,
                    10000000
                );

            this.maxMetadataEntries =
                parseNumber(
                    options.maxMetadataEntries,
                    DEFAULT_MAX_METADATA_ENTRIES,
                    1,
                    10000000
                );

            this.maxAliases =
                parseNumber(
                    options.maxAliases,
                    DEFAULT_MAX_ALIASES,
                    0,
                    10000
                );

            this.records = new Map();
            this.tagIndex = new Map();
            this.metadata = new Map();
            this.watchers = new Set();
            this.destroyed = false;
            this.lastError = null;
            this.emitting = false;
            this.syncingState = false;
            this.batchDepth = 0;
            this.pendingPersist = false;
            this.pendingEvents = [];
            this.loadPromise = null;
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
                metadataUpdates: 0
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

            this._syncState();
        }

        _assertActive() {
            if (this.destroyed) {
                throw new Error("Tag service has been destroyed.");
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
                error instanceof
                    Error
                    ? error
                    : new Error(
                        String(
                            error
                        )
                    );

            this.metrics.errors +=
                1;

            if (
                this.destroyed
            ) {
                return this.lastError;
            }

            this._emit("error", {
                error: {
                    name: this.lastError.name,
                    message: this.lastError.message,
                    stack: this.lastError.stack || ""
                }
            });
        }

        _emit(
            type,
            detail = {}
        ) {
            if (
                this.destroyed &&
                type !==
                    "destroy"
            ) {
                return null;
            }

            const event = {
                type,
                timestamp:
                    iso(),
                ...detail
            };

            if (
                this.batchDepth >
                    0 &&
                type !==
                    "error"
            ) {
                this.pendingEvents.push(
                    event
                );

                return event;
            }

            if (
                this.emitting
            ) {
                return event;
            }

            this.emitting =
                true;

            try {
                safeDispatch(
                    this,
                    type,
                    event
                );

                safeDispatch(
                    this,
                    "change",
                    event
                );

                for (
                    const watcher of
                    Array.from(
                        this.watchers
                    )
                ) {
                    try {
                        watcher(
                            event,
                            this
                        );
                    } catch (error) {
                        this.metrics.watcherErrors +=
                            1;

                        this.lastError =
                            error instanceof
                                Error
                                ? error
                                : new Error(
                                    String(
                                        error
                                    )
                                );
                    }
                }

                try {
                    this.context.events?.emit?.(
                        `tags:${type}`,
                        event
                    );
                } catch (error) {
                    this.metrics.errors +=
                        1;

                    this.lastError =
                        error instanceof
                            Error
                            ? error
                            : new Error(
                                String(
                                    error
                                )
                            );
                }

                safeDispatch(
                    document,
                    `speciedex:terminal-tags-${type}`,
                    event
                );

                return event;
            } finally {
                this.emitting =
                    false;
            }
        }

        beginBatch() {
            this._assertActive();

            this.batchDepth +=
                1;

            return this.batchDepth;
        }

        endBatch(
            options = {}
        ) {
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
                    0
            ) {
                if (
                    this.pendingPersist &&
                    options.persist !==
                        false
                ) {
                    this.pendingPersist =
                        false;

                    this.persist();
                }

                const events =
                    this.pendingEvents.splice(
                        0
                    );

                if (
                    events.length
                ) {
                    this.metrics.batches +=
                        1;

                    this._emit(
                        "batch",
                        {
                            count:
                                events.length,
                            events
                        }
                    );
                }

                this._syncState();
            }

            return this.batchDepth;
        }

        batch(
            callback,
            options = {}
        ) {
            if (
                typeof callback !==
                    "function"
            ) {
                throw new TypeError(
                    "Tag batch requires a callback."
                );
            }

            this.beginBatch();

            try {
                return callback(
                    this
                );
            } finally {
                this.endBatch(
                    options
                );
            }
        }

        _syncState() {
            if (
                this.syncingState ||
                this.destroyed ||
                this.batchDepth >
                    0
            ) {
                return false;
            }

            const state =
                this.context.state ||
                this.context.stateStore;

            if (
                !state?.set
            ) {
                return false;
            }

            this.syncingState =
                true;

            try {
                state.set(
                    "library.tags",
                    {
                        records:
                            this.records.size,
                        tags:
                            this.tagIndex.size,
                        assignments:
                            this.assignmentCount(),
                        lastUpdated:
                            iso(),
                        top:
                            this.topTags(
                                10
                            )
                    },
                    {
                        source:
                            "tags",
                        undoable:
                            false,
                        persist:
                            false,
                        broadcast:
                            false
                    }
                );

                this.metrics.stateSyncs +=
                    1;

                return true;
            } catch (_error) {
                return false;
            } finally {
                this.syncingState =
                    false;
            }
        }

        _rebuildIndex() {
            this.tagIndex.clear();

            for (const [recordId, tags] of this.records) {
                for (const tag of tags) {
                    if (!this.tagIndex.has(tag)) {
                        this.tagIndex.set(tag, new Set());
                    }
                    this.tagIndex.get(tag).add(recordId);
                }
            }
        }

        _touchMetadata(tag, update = {}) {
            if (
                !this.metadata.has(
                    tag
                ) &&
                this.metadata.size >=
                    this.maxMetadataEntries
            ) {
                throw new RangeError(
                    `Maximum metadata entry count of ${this.maxMetadataEntries} has been reached.`
                );
            }

            const existing = this.metadata.get(tag) || {
                tag,
                slug: slugify(tag),
                createdAt: iso(),
                updatedAt: iso(),
                color: null,
                description: "",
                aliases:
                    []
            };

            const next = {
                ...existing,
                ...clone(update),
                tag,
                slug: update.slug || existing.slug || slugify(tag),
                aliases:
                    Array.from(
                        new Set(
                            Array.isArray(
                                update.aliases
                            )
                                ? update.aliases.map(
                                    String
                                )
                                : existing.aliases ||
                                    []
                        )
                    ).slice(
                        0,
                        this.maxAliases
                    ),
                updatedAt:
                    iso()
            };

            this.metadata.set(tag, next);
            return next;
        }

        _serialize() {
            const records = {};
            const metadata = {};

            for (const [recordId, tags] of this.records) {
                records[recordId] = Array.from(tags).sort();
            }

            for (const [tag, value] of this.metadata) {
                metadata[tag] = clone(value);
            }

            return {
                schema: "speciedex-terminal-tags",
                schemaVersion: 1,
                exportedAt: iso(),
                records,
                metadata
            };
        }

        persist() {
            this._assertActive();

            if (
                !this.autoPersist
            ) {
                return false;
            }

            if (
                this.batchDepth >
                    0
            ) {
                this.pendingPersist =
                    true;

                return true;
            }

            const payload =
                this._serialize();

            try {
                if (
                    typeof this.storage?.set ===
                        "function"
                ) {
                    const result =
                        this.storage.set(
                            this.storageKey,
                            payload
                        );

                    if (
                        result &&
                        typeof result.then ===
                            "function"
                    ) {
                        result.catch(
                            error =>
                                this._recordError(
                                    error
                                )
                        );
                    }
                } else if (
                    typeof localStorage !==
                        "undefined"
                ) {
                    localStorage.setItem(
                        this.storageKey,
                        JSON.stringify(
                            payload
                        )
                    );
                } else {
                    return false;
                }

                this.metrics.writes +=
                    1;

                this._emit(
                    "persist",
                    {
                        storageKey:
                            this.storageKey
                    }
                );

                return true;
            } catch (error) {
                this.metrics.persistenceErrors +=
                    1;

                this._recordError(
                    error
                );

                return false;
            }
        }

        async load() {
            let payload =
                null;

            try {
                if (
                    typeof this.storage?.get ===
                        "function"
                ) {
                    payload =
                        this.storage.get(
                            this.storageKey,
                            null
                        );

                    if (
                        payload &&
                        typeof payload.then ===
                            "function"
                    ) {
                        payload =
                            await payload;
                    }
                } else if (
                    typeof localStorage !==
                        "undefined"
                ) {
                    const raw =
                        localStorage.getItem(
                            this.storageKey
                        );

                    payload =
                        raw
                            ? JSON.parse(
                                raw
                            )
                            : null;
                }
            } catch (error) {
                this.metrics.persistenceErrors +=
                    1;

                this._recordError(
                    error
                );
            }

            if (
                !payload ||
                !isObject(
                    payload
                )
            ) {
                return false;
            }

            try {
                this.records.clear();
                this.metadata.clear();

                const records =
                    isObject(
                        payload.records
                    )
                        ? payload.records
                        : {};

                const metadata =
                    isObject(
                        payload.metadata
                    )
                        ? payload.metadata
                        : {};

                const recordEntries =
                    Object.entries(
                        records
                    ).slice(
                        0,
                        this.maxRecords
                    );

                const metadataEntries =
                    Object.entries(
                        metadata
                    ).slice(
                        0,
                        this.maxMetadataEntries
                    );

                for (
                    const [
                        recordId,
                        tags
                    ] of recordEntries
                ) {
                    const normalizedId =
                        normalizeRecordId(
                            recordId
                        );

                    const normalizedTags =
                        this._normalizeTags(
                            tags
                        ).slice(
                            0,
                            this.maxTagsPerRecord
                        );

                    if (
                        normalizedTags.length
                    ) {
                        this.records.set(
                            normalizedId,
                            new Set(
                                normalizedTags
                            )
                        );
                    }
                }

                for (
                    const [
                        tag,
                        value
                    ] of metadataEntries
                ) {
                    const normalized =
                        this._normalizeTag(
                            tag
                        );

                    const source =
                        isObject(
                            value
                        )
                            ? value
                            : {};

                    this.metadata.set(
                        normalized,
                        {
                            tag:
                                normalized,
                            slug:
                                source.slug ||
                                slugify(
                                    normalized
                                ),
                            createdAt:
                                source.createdAt ||
                                iso(),
                            updatedAt:
                                source.updatedAt ||
                                iso(),
                            color:
                                source.color ||
                                null,
                            description:
                                source.description ||
                                "",
                            aliases:
                                Array.isArray(
                                    source.aliases
                                )
                                    ? source.aliases
                                        .map(
                                            String
                                        )
                                        .slice(
                                            0,
                                            this.maxAliases
                                        )
                                    : []
                        }
                    );
                }

                this._rebuildIndex();
                this.metrics.reads +=
                    1;

                this._emit(
                    "load",
                    {
                        records:
                            this.records.size,
                        tags:
                            this.tagIndex.size
                    }
                );

                this._syncState();

                return true;
            } catch (error) {
                this._recordError(
                    error
                );

                return false;
            }
        }

        add(recordId, tags, options = {}) {
            this._assertActive();

            recordId = normalizeRecordId(recordId);
            const normalized = this._normalizeTags(tags);

            if (!normalized.length) {
                return [];
            }

            if (!this.records.has(recordId) && this.records.size >= this.maxRecords) {
                throw new RangeError(
                    `Maximum record count of ${this.maxRecords} has been reached.`
                );
            }

            const recordTags = this.records.get(recordId) || new Set();
            const additions = [];

            for (const tag of normalized) {
                if (
                    recordTags.has(
                        tag
                    )
                ) {
                    this.metrics.deduplicated +=
                        1;

                    continue;
                }

                if (recordTags.size >= this.maxTagsPerRecord) {
                    throw new RangeError(
                        `Record "${recordId}" exceeds ${this.maxTagsPerRecord} tags.`
                    );
                }

                recordTags.add(tag);
                additions.push(tag);

                if (!this.tagIndex.has(tag)) {
                    this.tagIndex.set(tag, new Set());
                }

                this.tagIndex.get(tag).add(recordId);
                this._touchMetadata(tag);
            }

            if (!recordTags.size) {
                return [];
            }

            this.records.set(recordId, recordTags);
            this.metrics.adds += additions.length;

            if (additions.length) {
                if (
                    options.persist !==
                        false
                ) {
                    if (
                        this.batchDepth >
                            0
                    ) {
                        this.pendingPersist =
                            true;
                    } else {
                        this.persist();
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

            recordId = normalizeRecordId(recordId);

            if (!this.records.has(recordId)) {
                return [];
            }

            const recordTags = this.records.get(recordId);
            const requested = tags === undefined || tags === null
                ? Array.from(recordTags)
                : this._normalizeTags(tags);
            const removed = [];

            for (const tag of requested) {
                if (!recordTags.delete(tag)) {
                    continue;
                }

                removed.push(tag);

                const records = this.tagIndex.get(tag);
                if (records) {
                    records.delete(recordId);

                    if (!records.size) {
                        this.tagIndex.delete(tag);

                        if (options.keepMetadata !== true) {
                            this.metadata.delete(tag);
                        }
                    }
                }
            }

            if (!recordTags.size) {
                this.records.delete(recordId);
            }

            this.metrics.removes += removed.length;

            if (removed.length) {
                if (
                    options.persist !==
                        false
                ) {
                    if (
                        this.batchDepth >
                            0
                    ) {
                        this.pendingPersist =
                            true;
                    } else {
                        this.persist();
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

        replace(
            recordId,
            tags,
            options = {}
        ) {
            this._assertActive();

            recordId =
                normalizeRecordId(
                    recordId
                );

            const desired =
                new Set(
                    this._normalizeTags(
                        tags
                    ).slice(
                        0,
                        this.maxTagsPerRecord
                    )
                );

            const current =
                new Set(
                    this.records.get(
                        recordId
                    ) ||
                    []
                );

            const remove =
                Array.from(
                    current
                ).filter(
                    tag =>
                        !desired.has(
                            tag
                        )
                );

            const add =
                Array.from(
                    desired
                ).filter(
                    tag =>
                        !current.has(
                            tag
                        )
                );

            this.batch(
                () => {
                    if (
                        remove.length
                    ) {
                        this.remove(
                            recordId,
                            remove,
                            {
                                persist:
                                    false,
                                keepMetadata:
                                    options.keepMetadata
                            }
                        );
                    }

                    if (
                        add.length
                    ) {
                        this.add(
                            recordId,
                            add,
                            {
                                persist:
                                    false
                            }
                        );
                    }
                },
                {
                    persist:
                        false
                }
            );

            if (
                options.persist !==
                    false
            ) {
                this.persist();
            }

            const result = {
                recordId,
                added:
                    add,
                removed:
                    remove,
                tags:
                    this.get(
                        recordId
                    )
            };

            this._emit(
                "replace",
                result
            );

            this._syncState();

            return result;
        }

        toggle(recordId, tag, options = {}) {
            recordId = normalizeRecordId(recordId);
            tag = this._normalizeTag(tag);

            if (this.has(recordId, tag)) {
                this.remove(recordId, [tag], options);
                return false;
            }

            this.add(recordId, [tag], options);
            return true;
        }

        get(recordId) {
            this._assertActive();
            this.metrics.reads += 1;

            recordId = normalizeRecordId(recordId);
            return Array.from(this.records.get(recordId) || []).sort();
        }

        has(recordId, tag = null) {
            this._assertActive();

            recordId = normalizeRecordId(recordId);

            if (!this.records.has(recordId)) {
                return false;
            }

            if (tag === null || tag === undefined) {
                return true;
            }

            return this.records.get(recordId).has(this._normalizeTag(tag));
        }

        recordsFor(tag) {
            this._assertActive();
            this.metrics.reads += 1;

            tag = this._normalizeTag(tag);
            return Array.from(this.tagIndex.get(tag) || []).sort();
        }

        recordsWith(tags, options = {}) {
            this._assertActive();

            const normalized = this._normalizeTags(tags);

            if (!normalized.length) {
                return [];
            }

            const mode = String(options.mode || "all").toLowerCase();
            const sets = normalized.map((tag) => new Set(this.tagIndex.get(tag) || []));

            if (mode === "any") {
                const union = new Set();
                for (const set of sets) {
                    for (const recordId of set) {
                        union.add(recordId);
                    }
                }
                return Array.from(union).sort();
            }

            const first = sets.shift() || new Set();
            return Array.from(first)
                .filter((recordId) => sets.every((set) => set.has(recordId)))
                .sort();
        }

        list(options = {}) {
            this._assertActive();
            this.metrics.reads += 1;

            const query = String(options.query || "").trim().toLowerCase();
            const minimum = parseNumber(options.minimum, 0, 0);
            const maximum = parseNumber(options.maximum, Infinity, 0);
            const sort = String(options.sort || "name").toLowerCase();
            const direction = options.direction === "desc" ? "desc" : "asc";
            const multiplier = direction === "desc" ? -1 : 1;

            let items = Array.from(this.tagIndex.entries()).map(([tag, records]) => ({
                tag,
                slug: this.metadata.get(tag)?.slug || slugify(tag),
                count: records.size,
                records: options.includeRecords === true
                    ? Array.from(records).sort()
                    : undefined,
                metadata: options.includeMetadata === true
                    ? clone(this.metadata.get(tag) || null)
                    : undefined
            }));

            if (query) {
                items = items.filter((item) => {
                    const metadata = this.metadata.get(item.tag);
                    return item.tag.toLowerCase().includes(query) ||
                        metadata?.description?.toLowerCase().includes(query) ||
                        metadata?.aliases?.some((alias) =>
                            String(alias).toLowerCase().includes(query)
                        );
                });
            }

            items = items.filter((item) => {
                return item.count >= minimum && item.count <= maximum;
            });

            items.sort((left, right) => {
                if (sort === "count") {
                    return (left.count - right.count) * multiplier ||
                        left.tag.localeCompare(right.tag);
                }

                return left.tag.localeCompare(right.tag, undefined, {
                    numeric: true,
                    sensitivity: "base"
                }) * multiplier;
            });

            const limit = parseNumber(options.limit, items.length, 0, items.length);
            return limit ? items.slice(0, limit) : [];
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
                throw new TypeError("Tag metadata update must be an object.");
            }

            const metadata = this._touchMetadata(tag, {
                description: update.description !== undefined
                    ? String(update.description)
                    : undefined,
                color: update.color !== undefined
                    ? String(update.color)
                    : undefined,
                slug: update.slug !== undefined
                    ? slugify(update.slug)
                    : undefined,
                aliases:
                    update.aliases !==
                        undefined
                        ? this._normalizeTags(
                            update.aliases
                        ).slice(
                            0,
                            this.maxAliases
                        )
                        : undefined
            });

            this.metrics.metadataUpdates +=
                1;

            if (options.persist !== false) {
                this.persist();
            }

            this._emit("metadata", {
                tag,
                metadata: clone(metadata)
            });

            return clone(metadata);
        }

        getMetadata(tag) {
            tag = this._normalizeTag(tag);
            return clone(this.metadata.get(tag) || null);
        }

        rename(
            oldTag,
            newTag,
            options = {}
        ) {
            this._assertActive();

            oldTag =
                this._normalizeTag(
                    oldTag
                );

            newTag =
                this._normalizeTag(
                    newTag
                );

            if (
                oldTag ===
                newTag
            ) {
                return {
                    oldTag,
                    newTag,
                    records:
                        this.recordsFor(
                            oldTag
                        )
                };
            }

            const affected =
                this.recordsFor(
                    oldTag
                );

            if (
                !affected.length
            ) {
                return {
                    oldTag,
                    newTag,
                    records:
                        []
                };
            }

            const oldMetadata =
                this.metadata.get(
                    oldTag
                );

            this.batch(
                () => {
                    for (
                        const recordId of
                        affected
                    ) {
                        const recordTags =
                            this.records.get(
                                recordId
                            );

                        recordTags.delete(
                            oldTag
                        );

                        if (
                            !recordTags.has(
                                newTag
                            ) &&
                            recordTags.size >=
                                this.maxTagsPerRecord
                        ) {
                            recordTags.add(
                                oldTag
                            );

                            throw new RangeError(
                                `Record "${recordId}" exceeds ${this.maxTagsPerRecord} tags.`
                            );
                        }

                        recordTags.add(
                            newTag
                        );
                    }

                    this._rebuildIndex();

                    this.metadata.delete(
                        oldTag
                    );

                    this._touchMetadata(
                        newTag,
                        {
                            ...(
                                oldMetadata ||
                                {}
                            ),
                            tag:
                                newTag,
                            slug:
                                slugify(
                                    newTag
                                ),
                            aliases:
                                Array.from(
                                    new Set([
                                        ...(
                                            oldMetadata?.
                                                aliases ||
                                            []
                                        ),
                                        oldTag
                                    ])
                                ).slice(
                                    0,
                                    this.maxAliases
                                )
                        }
                    );
                },
                {
                    persist:
                        false
                }
            );

            if (
                options.persist !==
                    false
            ) {
                this.persist();
            }

            this._emit(
                "rename",
                {
                    oldTag,
                    newTag,
                    records:
                        affected
                }
            );

            this._syncState();

            return {
                oldTag,
                newTag,
                records:
                    affected
            };
        }

        merge(sourceTags, targetTag, options = {}) {
            this._assertActive();

            const sources = this._normalizeTags(sourceTags);
            targetTag = this._normalizeTag(targetTag);

            const affected = new Set();

            for (const source of sources) {
                if (source === targetTag) {
                    continue;
                }

                for (const recordId of this.recordsFor(source)) {
                    affected.add(recordId);
                    const recordTags = this.records.get(recordId);
                    recordTags.delete(source);
                    recordTags.add(targetTag);
                }

                this.tagIndex.delete(source);
                this.metadata.delete(source);
            }

            if (
                affected.size
            ) {
                this._rebuildIndex();
                this._touchMetadata(
                    targetTag
                );
            }

            if (options.persist !== false) {
                this.persist();
            }

            this._emit("merge", {
                sources,
                targetTag,
                records: Array.from(affected).sort()
            });

            this._syncState();

            return {
                sources,
                targetTag,
                records: Array.from(affected).sort()
            };
        }

        clear(options = {}) {
            this._assertActive();

            const recordCount = this.records.size;
            const tagCount = this.tagIndex.size;

            this.records.clear();
            this.tagIndex.clear();

            if (options.keepMetadata !== true) {
                this.metadata.clear();
            }

            this.metrics.clears += 1;

            if (options.persist !== false) {
                this.persist();
            }

            this._emit("clear", {
                records: recordCount,
                tags: tagCount
            });

            this._syncState();

            return {
                records: recordCount,
                tags: tagCount
            };
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

            const payload = this._serialize();

            this._emit("export", {
                records: this.records.size,
                tags: this.tagIndex.size
            });

            return options.stringify === false
                ? payload
                : JSON.stringify(payload, null, options.pretty === false ? 0 : 2);
        }

        import(input, options = {}) {
            this._assertActive();

            const payload = typeof input === "string"
                ? JSON.parse(input)
                : clone(input);

            if (!isObject(payload)) {
                throw new TypeError("Tag import must be an object or JSON string.");
            }

            const sourceRecords = isObject(payload.records)
                ? payload.records
                : payload;
            const sourceMetadata = isObject(payload.metadata)
                ? payload.metadata
                : {};

            if (options.replace === true) {
                this.clear({
                    persist: false,
                    keepMetadata: false
                });
            }

            const recordEntries =
                Object.entries(
                    sourceRecords
                );

            if (
                recordEntries.length >
                this.maxImportRecords
            ) {
                throw new RangeError(
                    `Tag import exceeds record limit: ${this.maxImportRecords}`
                );
            }

            let importedRecords = 0;
            let importedAssignments = 0;
            const skipped = [];

            this.beginBatch();

            try {
                for (
                    const [
                        recordId,
                        tags
                    ] of recordEntries
                ) {
                try {
                    const additions = this.add(recordId, tags, {
                        persist: false
                    });
                    importedRecords += 1;
                    importedAssignments += additions.length;
                } catch (error) {
                    skipped.push({
                        recordId,
                        error: error.message
                    });

                    if (options.strict === true) {
                        throw error;
                    }
                }
            }

            const metadataEntries =
                Object.entries(
                    sourceMetadata
                );

            if (
                metadataEntries.length >
                this.maxMetadataEntries
            ) {
                throw new RangeError(
                    `Tag metadata import exceeds limit: ${this.maxMetadataEntries}`
                );
            }

            for (
                const [
                    tag,
                    metadata
                ] of metadataEntries
            ) {
                try {
                    this.setMetadata(tag, metadata, {
                        persist: false
                    });
                } catch (error) {
                    skipped.push({
                        tag,
                        error: error.message
                    });

                    if (options.strict === true) {
                        throw error;
                    }
                }
            }
            } finally {
                this.endBatch({
                    persist:
                        false
                });
            }

            this.metrics.imports +=
                1;

            if (options.persist !== false) {
                this.persist();
            }

            this._emit("import", {
                records: importedRecords,
                assignments: importedAssignments,
                skipped
            });

            this._syncState();

            return {
                records: importedRecords,
                assignments: importedAssignments,
                skipped
            };
        }

        watch(callback, options = {}) {
            this._assertActive();

            if (
                typeof callback !==
                    "function"
            ) {
                throw new TypeError("Tag watcher must be a function.");
            }

            this.watchers.add(callback);

            if (options.immediate === true) {
                callback({
                    type: "initial",
                    timestamp: iso(),
                    status: this.status()
                }, this);
            }

            return () => this.watchers.delete(callback);
        }

        status() {
            return {
                name: "tags",
                module: MODULE_NAME,
                records: this.records.size,
                tags: this.tagIndex.size,
                assignments: this.assignmentCount(),
                storageKey: this.storageKey,
                persistent: Boolean(this.storage || typeof localStorage !== "undefined"),
                autoPersist: this.autoPersist,
                preserveCase: this.preserveCase,
                maxTagsPerRecord: this.maxTagsPerRecord,
                maxTagLength: this.maxTagLength,
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
                    this.topTags(
                        10
                    ),
                metrics: { ...this.metrics },
                lastError: this.lastError
                    ? {
                        name: this.lastError.name,
                        message: this.lastError.message
                    }
                    : null,
                destroyed: this.destroyed
            };
        }

        async run(parameters = {}) {
            const args = Array.isArray(parameters.args)
                ? parameters.args
                : [];
            const parsed = parseArguments(args);
            const action = parsed.action;
            const positional = parsed.positional;
            const options = parsed.options;

            switch (action) {
                case "status":
                case "show":
                case "info":
                    return this.status();

                case "list":
                case "all":
                    return {
                        count: this.tagIndex.size,
                        tags: this.list({
                            query: options.query,
                            minimum: options.min,
                            maximum: options.max,
                            sort: options.sort,
                            direction: options.desc === true ? "desc" : options.direction,
                            limit: options.limit,
                            includeRecords: options.records === true,
                            includeMetadata: options.metadata === true
                        })
                    };

                case "get":
                    if (!positional[0]) {
                        throw new Error("Usage: tags get <record-id>");
                    }
                    return {
                        recordId: positional[0],
                        tags: this.get(positional[0])
                    };

                case "add":
                    if (!positional[0] || positional.length < 2) {
                        throw new Error("Usage: tags add <record-id> <tag[,tag...]>");
                    }
                    return {
                        recordId: positional[0],
                        added: this.add(
                            positional[0],
                            positional.slice(1).join(" ")
                        ),
                        tags: this.get(positional[0])
                    };

                case "remove":
                case "rm":
                case "delete":
                    if (!positional[0]) {
                        throw new Error("Usage: tags remove <record-id> [tag[,tag...]]");
                    }
                    return {
                        recordId: positional[0],
                        removed: this.remove(
                            positional[0],
                            positional.length > 1
                                ? positional.slice(1).join(" ")
                                : null
                        ),
                        tags: this.records.has(positional[0])
                            ? this.get(positional[0])
                            : []
                    };

                case "replace":
                case "set":
                    if (!positional[0]) {
                        throw new Error("Usage: tags replace <record-id> <tag[,tag...]>");
                    }
                    return this.replace(
                        positional[0],
                        positional.slice(1).join(" ")
                    );

                case "records":
                    if (!positional[0]) {
                        throw new Error("Usage: tags records <tag[,tag...]> [--mode=all|any]");
                    }
                    return {
                        tags: this._normalizeTags(positional.join(" ")),
                        mode: options.mode || "all",
                        records: this.recordsWith(
                            positional.join(" "),
                            { mode: options.mode || "all" }
                        )
                    };

                case "rename":
                    if (!positional[0] || !positional[1]) {
                        throw new Error("Usage: tags rename <old-tag> <new-tag>");
                    }
                    return this.rename(positional[0], positional.slice(1).join(" "));

                case "merge":
                    if (!positional[0] || !options.into) {
                        throw new Error("Usage: tags merge <tag[,tag...]> --into=<target-tag>");
                    }
                    return this.merge(positional.join(" "), options.into);

                case "metadata":
                    if (!positional[0]) {
                        throw new Error("Usage: tags metadata <tag>");
                    }

                    if (
                        options.description !== undefined ||
                        options.color !== undefined ||
                        options.slug !== undefined ||
                        options.aliases !== undefined
                    ) {
                        return this.setMetadata(positional[0], {
                            description: options.description,
                            color: options.color,
                            slug: options.slug,
                            aliases: options.aliases
                        });
                    }

                    return this.getMetadata(positional[0]);

                case "clear":
                    return this.clear({
                        keepMetadata: options["keep-metadata"] === true
                    });

                case "export":
                    return this.export({
                        stringify: options.json !== true,
                        pretty: options.compact !== true
                    });

                case "import":
                    if (!positional.length) {
                        throw new Error("Usage: tags import <JSON> [--replace]");
                    }
                    return this.import(positional.join(" "), {
                        replace: options.replace === true,
                        strict: options.strict === true
                    });

                case "reload":
                    return {
                        loaded:
                            await this.load(),
                        status:
                            this.status()
                    };

                default:
                    throw new Error(
                        `Unknown tags action "${action}". Use status, list, get, add, ` +
                        "remove, replace, records, rename, merge, metadata, clear, " +
                        "export, import, or reload."
                    );
            }
        }

        destroy() {
            if (
                this.destroyed
            ) {
                return false;
            }

            this.persist();

            this._emit(
                "destroy",
                {
                    version:
                        VERSION
                }
            );

            this.watchers.clear();
            this.pendingEvents =
                [];
            this.records.clear();
            this.tagIndex.clear();
            this.metadata.clear();

            if (
                this.context.root?.[
                    TAGS_SYMBOL
                ] ===
                    this
            ) {
                delete this.context.root[
                    TAGS_SYMBOL
                ];
            }

            this.destroyed =
                true;

            return true;
        }

    }

    function getService(context) {
        return context?.tags ||
            context?.services?.get?.("tags") ||
            context?.services?.tags ||
            null;
    }

    function initialize(
        context =
            {}
    ) {
        const root =
            context.root;

        const existing =
            context.tags instanceof
                TagService
                ? context.tags
                : context.services?.get?.(
                    "tags"
                ) ||
                root?.[
                    TAGS_SYMBOL
                ];

        if (
            existing instanceof
                TagService &&
            !existing.destroyed
        ) {
            context.tags =
                existing;

            context.registerService?.(
                "tags",
                existing
            );

            return existing;
        }

        const dataset =
            root?.
                dataset ||
            {};

        const config =
            context.config?.
                tags ||
            {};

        const service =
            new TagService(
                context,
                {
                    storage:
                        context.storage ||
                        context.services?.get?.(
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
                            config.preserveCase ===
                                true
                        ),

                    autoPersist:
                        parseBoolean(
                            dataset.terminalTagsAutoPersist,
                            config.autoPersist !==
                                false
                        )
                }
            );

        root[
            TAGS_SYMBOL
        ] =
            service;

        context.tags =
            service;

        context.registerService?.(
            "tags",
            service
        );

        safeDispatch(
            document,
            "speciedex:terminal-tags-ready",
            {
                service,
                status:
                    service.status(),
                version:
                    VERSION
            }
        );

        return service;
    }

    const commands = [{
        name: "tags",
        aliases: ["tag"],
        category: "data",
        description: "Create, inspect, search, rename, merge, and persist tags for terminal records.",
        usage:
            "tags [status|list|get|add|remove|replace|records|rename|merge|" +
            "metadata|clear|export|import|reload] [arguments]",
        handler: async ({
            args = [],
            context,
            writeJSON,
            write,
            writeError
        }) => {
            const service = getService(context);

            if (!service) {
                throw new Error("Tags service is unavailable.");
            }

            try {
                const result = await service.run({ args });

                if (
                    typeof result === "string" &&
                    typeof write === "function"
                ) {
                    return write(result, "data");
                }

                if (typeof writeJSON === "function") {
                    return writeJSON(result);
                }

                return result;
            } catch (error) {
                if (typeof writeError === "function") {
                    writeError(error.message);
                    return null;
                }

                throw error;
            }
        }
    }];

    const api = Object.freeze({
        name:
            MODULE_NAME,
        version:
            VERSION,
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
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(
        new CustomEvent("speciedex:terminal-module-available", {
            detail: {
                name: MODULE_NAME,
                module: api
            }
        })
    );
})(window, document);
