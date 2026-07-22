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
    const DEFAULT_STORAGE_KEY = "tags:index";
    const DEFAULT_MAX_TAGS_PER_RECORD = 128;
    const DEFAULT_MAX_TAG_LENGTH = 128;
    const DEFAULT_MAX_RECORDS = 100000;
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

    function clone(value) {
        if (typeof structuredClone === "function") {
            try {
                return structuredClone(value);
            } catch (error) {
                /* Fall through. */
            }
        }

        if (value === undefined || value === null || typeof value !== "object") {
            return value;
        }

        try {
            return JSON.parse(JSON.stringify(value));
        } catch (error) {
            return value;
        }
    }

    function safeDispatch(target, name, detail) {
        try {
            target.dispatchEvent(new CustomEvent(name, { detail }));
        } catch (error) {
            /* Event delivery must not break tag operations. */
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
            this.autoPersist = options.autoPersist !== false;
            this.records = new Map();
            this.tagIndex = new Map();
            this.metadata = new Map();
            this.watchers = new Set();
            this.destroyed = false;
            this.lastError = null;
            this.metrics = {
                adds: 0,
                removes: 0,
                clears: 0,
                imports: 0,
                exports: 0,
                reads: 0,
                writes: 0,
                errors: 0
            };

            this.load();
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
            this.lastError = error instanceof Error
                ? error
                : new Error(String(error));
            this.metrics.errors += 1;

            this._emit("error", {
                error: {
                    name: this.lastError.name,
                    message: this.lastError.message,
                    stack: this.lastError.stack || ""
                }
            });
        }

        _emit(type, detail = {}) {
            const event = {
                type,
                timestamp: iso(),
                ...detail
            };

            safeDispatch(this, type, event);
            safeDispatch(this, "change", event);

            for (const watcher of Array.from(this.watchers)) {
                try {
                    watcher(event, this);
                } catch (error) {
                    this._recordError(error);
                }
            }

            try {
                this.context.events?.emit?.(`tags:${type}`, event);
            } catch (error) {
                this._recordError(error);
            }

            return event;
        }

        _syncState() {
            const state = this.context.state || this.context.stateStore;

            try {
                state?.set?.("library.tags", {
                    records: this.records.size,
                    tags: this.tagIndex.size,
                    assignments: this.assignmentCount(),
                    lastUpdated: iso(),
                    top: this.topTags(10)
                });
            } catch (error) {
                /* State synchronization is advisory. */
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
            const existing = this.metadata.get(tag) || {
                tag,
                slug: slugify(tag),
                createdAt: iso(),
                updatedAt: iso(),
                color: null,
                description: "",
                aliases: []
            };

            const next = {
                ...existing,
                ...clone(update),
                tag,
                slug: update.slug || existing.slug || slugify(tag),
                updatedAt: iso()
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

            if (!this.autoPersist || !this.storage) {
                return false;
            }

            try {
                if (typeof this.storage.set === "function") {
                    this.storage.set(this.storageKey, this._serialize());
                } else if (typeof localStorage !== "undefined") {
                    localStorage.setItem(
                        this.storageKey,
                        JSON.stringify(this._serialize())
                    );
                } else {
                    return false;
                }

                this.metrics.writes += 1;
                this._emit("persist", {
                    storageKey: this.storageKey
                });
                return true;
            } catch (error) {
                this._recordError(error);
                return false;
            }
        }

        load() {
            let payload = null;

            try {
                if (this.storage && typeof this.storage.get === "function") {
                    payload = this.storage.get(this.storageKey, null);
                } else if (typeof localStorage !== "undefined") {
                    const raw = localStorage.getItem(this.storageKey);
                    payload = raw ? JSON.parse(raw) : null;
                }
            } catch (error) {
                this._recordError(error);
            }

            if (!payload || !isObject(payload)) {
                return false;
            }

            try {
                this.records.clear();
                this.metadata.clear();

                const records = isObject(payload.records) ? payload.records : {};
                const metadata = isObject(payload.metadata) ? payload.metadata : {};

                for (const [recordId, tags] of Object.entries(records)) {
                    const normalizedId = normalizeRecordId(recordId);
                    const normalizedTags = this._normalizeTags(tags);

                    if (normalizedTags.length) {
                        this.records.set(normalizedId, new Set(normalizedTags));
                    }
                }

                for (const [tag, value] of Object.entries(metadata)) {
                    const normalized = this._normalizeTag(tag);
                    this.metadata.set(normalized, {
                        tag: normalized,
                        slug: value.slug || slugify(normalized),
                        createdAt: value.createdAt || iso(),
                        updatedAt: value.updatedAt || iso(),
                        color: value.color || null,
                        description: value.description || "",
                        aliases: Array.isArray(value.aliases)
                            ? value.aliases.map(String)
                            : []
                    });
                }

                this._rebuildIndex();
                this.metrics.reads += 1;
                this._emit("load", {
                    records: this.records.size,
                    tags: this.tagIndex.size
                });
                return true;
            } catch (error) {
                this._recordError(error);
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
                if (recordTags.has(tag)) {
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
                if (options.persist !== false) {
                    this.persist();
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
                if (options.persist !== false) {
                    this.persist();
                }

                this._emit("remove", {
                    recordId,
                    tags: removed
                });

                this._syncState();
            }

            return removed;
        }

        replace(recordId, tags, options = {}) {
            this._assertActive();

            recordId = normalizeRecordId(recordId);
            const desired = new Set(this._normalizeTags(tags));
            const current = new Set(this.records.get(recordId) || []);
            const remove = Array.from(current).filter((tag) => !desired.has(tag));
            const add = Array.from(desired).filter((tag) => !current.has(tag));

            if (remove.length) {
                this.remove(recordId, remove, {
                    persist: false,
                    keepMetadata: options.keepMetadata
                });
            }

            if (add.length) {
                this.add(recordId, add, {
                    persist: false
                });
            }

            if (options.persist !== false) {
                this.persist();
            }

            this._emit("replace", {
                recordId,
                added: add,
                removed: remove,
                tags: this.get(recordId)
            });

            this._syncState();

            return {
                recordId,
                added: add,
                removed: remove,
                tags: this.get(recordId)
            };
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
                aliases: update.aliases !== undefined
                    ? this._normalizeTags(update.aliases)
                    : undefined
            });

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

        rename(oldTag, newTag, options = {}) {
            this._assertActive();

            oldTag = this._normalizeTag(oldTag);
            newTag = this._normalizeTag(newTag);

            if (oldTag === newTag) {
                return {
                    oldTag,
                    newTag,
                    records: this.recordsFor(oldTag)
                };
            }

            const affected = this.recordsFor(oldTag);

            if (!affected.length) {
                return {
                    oldTag,
                    newTag,
                    records: []
                };
            }

            const oldMetadata = this.metadata.get(oldTag);

            for (const recordId of affected) {
                const recordTags = this.records.get(recordId);
                recordTags.delete(oldTag);
                recordTags.add(newTag);
            }

            this.tagIndex.delete(oldTag);

            if (!this.tagIndex.has(newTag)) {
                this.tagIndex.set(newTag, new Set());
            }

            for (const recordId of affected) {
                this.tagIndex.get(newTag).add(recordId);
            }

            this.metadata.delete(oldTag);
            this._touchMetadata(newTag, {
                ...(oldMetadata || {}),
                tag: newTag,
                slug: slugify(newTag),
                aliases: Array.from(new Set([
                    ...(oldMetadata?.aliases || []),
                    oldTag
                ]))
            });

            if (options.persist !== false) {
                this.persist();
            }

            this._emit("rename", {
                oldTag,
                newTag,
                records: affected
            });

            this._syncState();

            return {
                oldTag,
                newTag,
                records: affected
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

            if (affected.size) {
                this.tagIndex.set(targetTag, new Set([
                    ...(this.tagIndex.get(targetTag) || []),
                    ...affected
                ]));
                this._touchMetadata(targetTag);
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

            let importedRecords = 0;
            let importedAssignments = 0;
            const skipped = [];

            for (const [recordId, tags] of Object.entries(sourceRecords)) {
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

            for (const [tag, metadata] of Object.entries(sourceMetadata)) {
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

            this.metrics.imports += 1;

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
            if (typeof callback !== "function") {
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
                maxRecords: this.maxRecords,
                topTags: this.topTags(10),
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
                        loaded: this.load(),
                        status: this.status()
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
            if (this.destroyed) {
                return false;
            }

            this.persist();
            this.watchers.clear();
            this.destroyed = true;
            this._emit("destroy", {});
            return true;
        }
    }

    function getService(context) {
        return context?.tags ||
            context?.services?.get?.("tags") ||
            context?.services?.tags ||
            null;
    }

    function initialize(context = {}) {
        const dataset = context.root?.dataset || {};
        const config = context.config?.tags || {};

        const service = new TagService(context, {
            storage:
                context.storage ||
                context.services?.get?.("storage") ||
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
            preserveCase: parseBoolean(
                dataset.terminalTagsPreserveCase,
                config.preserveCase === true
            ),
            autoPersist: parseBoolean(
                dataset.terminalTagsAutoPersist,
                config.autoPersist !== false
            )
        });

        context.tags = service;
        context.registerService?.("tags", service);

        safeDispatch(document, "speciedex:terminal-tags-ready", {
            service,
            status: service.status()
        });

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
        name: MODULE_NAME,
        TagService,
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
