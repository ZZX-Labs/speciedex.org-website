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
    const VERSION = "2.1.0";

    const BOOKMARKS_SYMBOL =
        Symbol.for(
            "speciedex.terminal.bookmarks.service"
        );
    const SERVICE_NAME = "bookmarks";
    const STORAGE_KEY = "bookmarks";
    const STORAGE_VERSION = 1;
    const DEFAULT_LIMIT = 1000;
    const DEFAULT_IMPORT_LIMIT = 10000;
    const DEFAULT_MAX_TAGS = 64;
    const DEFAULT_MAX_NOTE_LENGTH = 65536;
    const DEFAULT_MAX_VALUE_LENGTH = 1048576;
    const DEFAULT_HISTORY_LIMIT = 500;
    const DEFAULT_STORAGE_DEBOUNCE = 80;
    const RESERVED_KEYS =
        new Set([
            "__proto__",
            "prototype",
            "constructor"
        ]);

    function iso(value = Date.now()) {
        const date = value instanceof Date ? value : new Date(value);
        return Number.isNaN(date.getTime())
            ? new Date().toISOString()
            : date.toISOString();
    }

    function text(value) {
        return String(value ?? "").trim();
    }

    function normalizeTags(value) {
        const source = Array.isArray(value)
            ? value
            : text(value)
                .split(",");

        return Array.from(new Set(
            source
                .map((item) => text(item).toLowerCase())
                .filter(Boolean)
        ));
    }

    function makeID() {
        if (window.crypto && typeof window.crypto.randomUUID === "function") {
            return window.crypto.randomUUID();
        }

        if (window.crypto && typeof window.crypto.getRandomValues === "function") {
            const bytes = new Uint8Array(16);
            window.crypto.getRandomValues(bytes);
            bytes[6] = (bytes[6] & 0x0f) | 0x40;
            bytes[8] = (bytes[8] & 0x3f) | 0x80;

            const hex = Array.from(bytes, (byte) =>
                byte.toString(16).padStart(2, "0")
            ).join("");

            return [
                hex.slice(0, 8),
                hex.slice(8, 12),
                hex.slice(12, 16),
                hex.slice(16, 20),
                hex.slice(20)
            ].join("-");
        }

        return `bookmark-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
            32
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

        if (
            value instanceof
                Map
        ) {
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
                ] of value
            ) {
                const normalized =
                    String(
                        key
                    );

                if (
                    RESERVED_KEYS.has(
                        normalized
                    )
                ) {
                    continue;
                }

                output[
                    normalized
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

        if (
            value instanceof
                Set
        ) {
            return [
                ...value
            ].map(
                item =>
                    clone(
                        item,
                        seen,
                        depth +
                            1
                    )
            );
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
                RESERVED_KEYS.has(
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

    function clampInteger(
        value,
        fallback,
        minimum,
        maximum
    ) {
        const number =
            Number.parseInt(
                value,
                10
            );

        return Number.isFinite(
            number
        )
            ? Math.min(
                maximum,
                Math.max(
                    minimum,
                    number
                )
            )
            : fallback;
    }

    function normalizeCategory(
        value
    ) {
        return text(
            value ||
            "general"
        )
            .toLowerCase()
            .replace(
                /\s+/g,
                "-"
            )
            .replace(
                /[^a-z0-9:_-]/g,
                ""
            ) ||
            "general";
    }

    function formulaSafeText(
        value
    ) {
        const normalized =
            String(
                value ??
                ""
            );

        return /^[=+\-@\t\r]/.test(
            normalized
        )
            ? `'${normalized}`
            : normalized;
    }

    function csvCell(
        value
    ) {
        const normalized =
            formulaSafeText(
                typeof value ===
                    "string"
                    ? value
                    : JSON.stringify(
                        clone(
                            value
                        )
                    )
            );

        return `"${normalized.replace(/"/g, '""')}"`;
    }


    class Bookmarks {
        constructor(context, options = {}) {
            if (!context || typeof context !== "object") {
                throw new TypeError("A terminal context is required.");
            }

            this.context = context;
            this.storage = options.storage || context.storage || null;
            this.storageKey = text(options.storageKey) || STORAGE_KEY;
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

            this.items =
                [];

            this.history =
                [];

            this.destroyed =
                false;

            this.emitting =
                false;

            this.syncingState =
                false;

            this.saveTimer =
                null;

            this.loadPromise =
                null;

            this.metrics = {
                added:
                    0,
                updated:
                    0,
                removed:
                    0,
                cleared:
                    0,
                imports:
                    0,
                exports:
                    0,
                duplicates:
                    0,
                persistenceReads:
                    0,
                persistenceWrites:
                    0,
                persistenceErrors:
                    0,
                opens:
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

        normalizeRecord(record = {}) {
            const label =
                text(
                    record.label
                );

            const value =
                text(
                    record.value
                );

            if (
                !label ||
                !value
            ) {
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

            const createdAt = iso(record.createdAt);
            const updatedAt = iso(record.updatedAt || createdAt);

            return {
                id: text(record.id) || makeID(),
                label,
                value,
                tags:
                    normalizeTags(
                        record.tags
                    ).slice(
                        0,
                        this.maxTags
                    ),

                note:
                    text(
                        record.note
                    ).slice(
                        0,
                        this.maxNoteLength
                    ),

                category:
                    normalizeCategory(
                        record.category
                    ),

                pinned:
                    record.pinned ===
                    true,

                openCount:
                    clampInteger(
                        record.openCount,
                        0,
                        0,
                        Number.MAX_SAFE_INTEGER
                    ),

                lastOpenedAt:
                    record.lastOpenedAt
                        ? iso(
                            record.lastOpenedAt
                        )
                        : null,

                createdAt,
                updatedAt,
                metadata:
                    record.metadata && typeof record.metadata === "object"
                        ? clone(record.metadata)
                        : {}
            };
        }

        ensureAvailable() {
            if (
                this.destroyed
            ) {
                throw new Error(
                    "Bookmarks service has been destroyed."
                );
            }
        }

        async load() {
            this.ensureAvailable();

            let payload =
                [];

            try {
                const value =
                    this.storage?.
                        get?.(
                            this.storageKey,
                            []
                        );

                payload =
                    isPromiseLike(
                        value
                    )
                        ? await value
                        : value;

                this.metrics.persistenceReads +=
                    1;
            } catch (error) {
                this.metrics.persistenceErrors +=
                    1;

                this.report(
                    "load",
                    error
                );

                payload =
                    [];
            }

            if (
                payload &&
                !Array.isArray(
                    payload
                ) &&
                Array.isArray(
                    payload.items
                )
            ) {
                payload =
                    payload.items;
            }

            if (
                !Array.isArray(
                    payload
                )
            ) {
                payload =
                    [];
            }

            const seen =
                new Set();

            this.items =
                payload
                    .map(
                        record =>
                            this.normalizeRecord(
                                record
                            )
                    )
                    .filter(
                        record => {
                            if (
                                !record ||
                                seen.has(
                                    record.id
                                )
                            ) {
                                return false;
                            }

                            seen.add(
                                record.id
                            );

                            return true;
                        }
                    )
                    .slice(
                        0,
                        this.limit
                    );

            this.syncState();

            return this.list();
        }

        buildPayload() {
            return {
                version:
                    STORAGE_VERSION,
                updatedAt:
                    iso(),
                items:
                    this.items.map(
                        item =>
                            clone(
                                item
                            )
                    )
            };
        }

        async save(
            options =
                {}
        ) {
            this.ensureAvailable();

            const payload =
                this.buildPayload();

            window.clearTimeout(
                this.saveTimer
            );

            const persist =
                async () => {
                    this.saveTimer =
                        null;

                    try {
                        const result =
                            this.storage?.
                                set?.(
                                    this.storageKey,
                                    payload
                                );

                        if (
                            isPromiseLike(
                                result
                            )
                        ) {
                            await result;
                        }

                        this.metrics.persistenceWrites +=
                            1;
                    } catch (error) {
                        this.metrics.persistenceErrors +=
                            1;

                        this.report(
                            "save",
                            error
                        );

                        throw error;
                    }

                    this.emit(
                        "saved",
                        {
                            count:
                                this.items.length
                        }
                    );

                    this.syncState();

                    return payload;
                };

            if (
                options.immediate ===
                    true ||
                this.storageDebounce ===
                    0
            ) {
                return persist();
            }

            return new Promise(
                (
                    resolve,
                    reject
                ) => {
                    this.saveTimer =
                        window.setTimeout(
                            () => {
                                persist().
                                    then(
                                        resolve,
                                        reject
                                    );
                            },
                            this.storageDebounce
                        );
                }
            );
        }

        recordHistory(
            action,
            detail =
                {}
        ) {
            this.history.push({
                id:
                    makeID(),
                timestamp:
                    iso(),
                action,
                detail:
                    clone(
                        detail
                    )
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

            if (
                !state?.set
            ) {
                return false;
            }

            this.syncingState =
                true;

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
                            [
                                ...new Set(
                                    this.items.map(
                                        item =>
                                            item.category
                                    )
                                )
                            ],
                        metrics: {
                            ...this.metrics
                        },
                        updatedAt:
                            iso()
                    },
                    {
                        source:
                            "bookmarks",
                        undoable:
                            false,
                        persist:
                            false,
                        broadcast:
                            false
                    }
                );

                return true;
            } catch (_error) {
                return false;
            } finally {
                this.syncingState =
                    false;
            }
        }

        list(options = {}) {
            let result = this.items.slice();
            const query = text(options.query).toLowerCase();
            const tag =
                text(
                    options.tag
                ).toLowerCase();

            const category =
                normalizeCategory(
                    options.category ||
                    ""
                );

            const pinned =
                options.pinned;

            if (query) {
                result = result.filter((item) =>
                    item.label.toLowerCase().includes(query) ||
                    item.value.toLowerCase().includes(query) ||
                    item.note.toLowerCase().includes(query) ||
                    item.tags.some((itemTag) => itemTag.includes(query))
                );
            }

            if (tag) {
                result =
                    result.filter(
                        item =>
                            item.tags.includes(
                                tag
                            )
                    );
            }

            if (
                options.category
            ) {
                result =
                    result.filter(
                        item =>
                            item.category ===
                            category
                    );
            }

            if (
                pinned ===
                    true ||
                pinned ===
                    false
            ) {
                result =
                    result.filter(
                        item =>
                            item.pinned ===
                            pinned
                    );
            }

            const sort = text(options.sort || "newest").toLowerCase();
            result.sort((left, right) => {
                if (sort === "oldest") {
                    return left.createdAt.localeCompare(right.createdAt);
                }
                if (
                    sort ===
                    "label"
                ) {
                    return left.label.localeCompare(
                        right.label
                    );
                }

                if (
                    sort ===
                    "updated"
                ) {
                    return right.updatedAt.localeCompare(
                        left.updatedAt
                    );
                }

                if (
                    sort ===
                    "opened"
                ) {
                    return (
                        right.lastOpenedAt ||
                        ""
                    ).localeCompare(
                        left.lastOpenedAt ||
                        ""
                    );
                }

                if (
                    sort ===
                    "usage"
                ) {
                    return right.openCount -
                        left.openCount;
                }

                if (
                    sort ===
                    "pinned"
                ) {
                    return Number(
                        right.pinned
                    ) -
                    Number(
                        left.pinned
                    ) ||
                    right.updatedAt.localeCompare(
                        left.updatedAt
                    );
                }

                return right.createdAt.localeCompare(
                    left.createdAt
                );
            });

            const limit = Number(options.limit);
            if (Number.isFinite(limit) && limit >= 0) {
                result = result.slice(0, Math.trunc(limit));
            }

            return result.map((item) => clone(item));
        }

        get(idOrLabel) {
            const needle = text(idOrLabel).toLowerCase();
            if (!needle) {
                return null;
            }

            const item = this.items.find((record) =>
                record.id.toLowerCase() === needle ||
                record.label.toLowerCase() === needle
            );

            return item ? clone(item) : null;
        }

        open(
            idOrLabel,
            options =
                {}
        ) {
            this.ensureAvailable();

            const needle =
                text(
                    idOrLabel
                ).toLowerCase();

            const index =
                this.items.findIndex(
                    record =>
                        record.id.toLowerCase() ===
                            needle ||
                        record.label.toLowerCase() ===
                            needle
                );

            if (
                index <
                0
            ) {
                return null;
            }

            const item =
                this.items[
                    index
                ];

            item.openCount +=
                1;

            item.lastOpenedAt =
                iso();

            item.updatedAt =
                iso();

            this.metrics.opens +=
                1;

            this.recordHistory(
                "opened",
                {
                    id:
                        item.id
                }
            );

            this.save();

            if (
                options.execute !==
                    false &&
                typeof this.context.execute ===
                    "function"
            ) {
                this.context.execute(
                    item.value
                );
            }

            this.emit(
                "opened",
                {
                    bookmark:
                        clone(
                            item
                        )
                }
            );

            return clone(
                item
            );
        }


        add(label, value, options = {}) {
            this.ensureAvailable();

            const normalizedLabel = text(label);
            const normalizedValue = text(value);

            if (!normalizedLabel) {
                throw new TypeError("A bookmark label is required.");
            }
            if (!normalizedValue) {
                throw new TypeError("A bookmark value is required.");
            }

            const duplicate = this.items.find((item) =>
                item.label.toLowerCase() === normalizedLabel.toLowerCase() &&
                item.value === normalizedValue
            );

            if (
                duplicate &&
                options.allowDuplicate !==
                true
            ) {
                this.metrics.duplicates +=
                    1;

                return clone(
                    duplicate
                );
            }

            if (this.items.length >= this.limit) {
                throw new RangeError(`Bookmark limit reached (${this.limit}).`);
            }

            const now = iso();
            const record = this.normalizeRecord({
                id: options.id,
                label: normalizedLabel,
                value: normalizedValue,
                tags: options.tags,
                note:
                    options.note,
                category:
                    options.category,
                pinned:
                    options.pinned,
                metadata:
                    options.metadata,
                createdAt: options.createdAt || now,
                updatedAt: options.updatedAt || now
            });

            this.items.push(
                record
            );

            this.metrics.added +=
                1;

            this.recordHistory(
                "added",
                {
                    id:
                        record.id
                }
            );

            this.save();

            this.emit(
                "added",
                {
                    bookmark:
                        clone(
                            record
                        )
                }
            );

            return clone(record);
        }

        update(idOrLabel, changes = {}) {
            this.ensureAvailable();

            const needle = text(idOrLabel).toLowerCase();
            const index = this.items.findIndex((item) =>
                item.id.toLowerCase() === needle ||
                item.label.toLowerCase() === needle
            );

            if (index < 0) {
                return null;
            }

            const current = this.items[index];
            const next = this.normalizeRecord({
                ...current,
                ...changes,
                id: current.id,
                createdAt: current.createdAt,
                updatedAt: iso()
            });

            if (!next) {
                throw new TypeError("Updated bookmark must retain a label and value.");
            }

            this.items[
                index
            ] =
                next;

            this.metrics.updated +=
                1;

            this.recordHistory(
                "updated",
                {
                    id:
                        next.id
                }
            );

            this.save();

            this.emit(
                "updated",
                {
                    bookmark:
                        clone(
                            next
                        )
                }
            );

            return clone(next);
        }

        remove(idOrLabel) {
            this.ensureAvailable();

            const needle = text(idOrLabel).toLowerCase();
            if (!needle) {
                return null;
            }

            const index = this.items.findIndex((item) =>
                item.id.toLowerCase() === needle ||
                item.label.toLowerCase() === needle
            );

            if (index < 0) {
                return null;
            }

            const [
                removed
            ] =
                this.items.splice(
                    index,
                    1
                );

            this.metrics.removed +=
                1;

            this.recordHistory(
                "removed",
                {
                    id:
                        removed.id
                }
            );

            this.save();

            this.emit(
                "removed",
                {
                    bookmark:
                        clone(
                            removed
                        )
                }
            );

            return clone(removed);
        }

        clear() {
            this.ensureAvailable();

            const count =
                this.items.length;
            this.items =
                [];

            this.metrics.cleared +=
                count;

            this.recordHistory(
                "cleared",
                {
                    count
                }
            );

            this.save();

            this.emit(
                "cleared",
                {
                    count
                }
            );
            return count;
        }

        pin(
            idOrLabel,
            pinned =
                true
        ) {
            return this.update(
                idOrLabel,
                {
                    pinned:
                        pinned !==
                        false
                }
            );
        }

        addTags(
            idOrLabel,
            tags
        ) {
            const current =
                this.get(
                    idOrLabel
                );

            if (!current) {
                return null;
            }

            return this.update(
                current.id,
                {
                    tags:
                        normalizeTags([
                            ...current.tags,
                            ...normalizeTags(
                                tags
                            )
                        ]).slice(
                            0,
                            this.maxTags
                        )
                }
            );
        }

        removeTags(
            idOrLabel,
            tags
        ) {
            const current =
                this.get(
                    idOrLabel
                );

            if (!current) {
                return null;
            }

            const remove =
                new Set(
                    normalizeTags(
                        tags
                    )
                );

            return this.update(
                current.id,
                {
                    tags:
                        current.tags.filter(
                            tag =>
                                !remove.has(
                                    tag
                                )
                        )
                }
            );
        }

        bulkRemove(
            ids
        ) {
            const needles =
                new Set(
                    (
                        Array.isArray(
                            ids
                        )
                            ? ids
                            : [
                                ids
                            ]
                    ).map(
                        value =>
                            text(
                                value
                            ).toLowerCase()
                    )
                );

            const removed =
                [];

            this.items =
                this.items.filter(
                    item => {
                        const match =
                            needles.has(
                                item.id.toLowerCase()
                            ) ||
                            needles.has(
                                item.label.toLowerCase()
                            );

                        if (match) {
                            removed.push(
                                item
                            );
                        }

                        return !match;
                    }
                );

            if (
                removed.length
            ) {
                this.metrics.removed +=
                    removed.length;

                this.recordHistory(
                    "bulk-removed",
                    {
                        ids:
                            removed.map(
                                item =>
                                    item.id
                            )
                    }
                );

                this.save();

                this.emit(
                    "bulk-removed",
                    {
                        bookmarks:
                            removed.map(
                                clone
                            )
                    }
                );
            }

            return removed.map(
                clone
            );
        }


        export(
            options =
                {}
        ) {
            this.ensureAvailable();

            this.metrics.exports +=
                1;

            const format =
                text(
                    options.format ||
                    "json"
                ).toLowerCase();

            if (
                format ===
                    "csv"
            ) {
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
                    headers.map(
                        csvCell
                    ).join(
                        ","
                    ),
                    ...this.list({
                        sort:
                            "oldest"
                    }).map(
                        item =>
                            headers.map(
                                key =>
                                    csvCell(
                                        key ===
                                            "tags"
                                            ? item.tags.join(
                                                " "
                                            )
                                            : item[
                                                key
                                            ]
                                    )
                            ).join(
                                ","
                            )
                    )
                ].join(
                    "\r\n"
                );
            }

            if (
                format ===
                    "markdown" ||
                format ===
                    "md"
            ) {
                return [
                    "# SpeciedexTerminal Bookmarks",
                    "",
                    `Exported: ${iso()}`,
                    "",
                    "| Label | Value | Category | Tags | Pinned |",
                    "|---|---|---|---|---|",
                    ...this.list({
                        sort:
                            "label"
                    }).map(
                        item =>
                            `| ${item.label.replace(/\|/g, "\\|")} | ${item.value.replace(/\|/g, "\\|")} | ${item.category} | ${item.tags.join(", ")} | ${item.pinned ? "yes" : "no"} |`
                    )
                ].join(
                    "\n"
                );
            }

            return {
                version:
                    STORAGE_VERSION,
                exportedAt: iso(),
                count: this.items.length,
                items:
                    this.list({
                        sort:
                            "oldest"
                    }),
                history:
                    options.includeHistory ===
                    true
                        ? clone(
                            this.history
                        )
                        : undefined
            };
        }

        import(payload, options = {}) {
            this.ensureAvailable();

            let source =
                payload;

            if (
                typeof source ===
                    "string"
            ) {
                source =
                    JSON.parse(
                        source
                    );
            }

            const records = Array.isArray(payload)
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

            if (!records.length) {
                return {
                    added:
                        0,
                    skipped:
                        0
                };
            }

            let added = 0;
            let skipped = 0;

            if (options.replace === true) {
                this.items = [];
            }

            for (const record of records) {
                const normalized = this.normalizeRecord(record);
                if (!normalized) {
                    skipped += 1;
                    continue;
                }

                const duplicate = this.items.some((item) =>
                    item.id === normalized.id ||
                    (
                        item.label.toLowerCase() === normalized.label.toLowerCase() &&
                        item.value === normalized.value
                    )
                );

                if (duplicate || this.items.length >= this.limit) {
                    skipped += 1;
                    continue;
                }

                this.items.push(normalized);
                added += 1;
            }

            this.metrics.imports +=
                added;

            this.recordHistory(
                "imported",
                {
                    added,
                    skipped
                }
            );

            this.save();

            this.emit(
                "imported",
                {
                    added,
                    skipped
                }
            );

            return { added, skipped };
        }

        emit(
            action,
            detail =
                {}
        ) {
            if (
                this.destroyed &&
                action !==
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

            const payload = {
                action,
                service:
                    this,
                ...detail
            };

            try {
                this.context.events?.emit?.(
                    `bookmarks:${action}`,
                    payload
                );

                document.dispatchEvent(
                    new CustomEvent(
                        `speciedex:terminal-bookmarks-${action}`,
                        {
                            detail:
                                payload
                        }
                    )
                );

                return true;
            } catch (error) {
                this.report(
                    `emit:${action}`,
                    error
                );

                return false;
            } finally {
                this.emitting =
                    false;
            }
        }

        status() {
            return {
                version:
                    VERSION,
                count:
                    this.items.length,
                limit:
                    this.limit,
                importLimit:
                    this.importLimit,
                storageKey:
                    this.storageKey,
                categories:
                    [
                        ...new Set(
                            this.items.map(
                                item =>
                                    item.category
                            )
                        )
                    ],
                tags:
                    [
                        ...new Set(
                            this.items.flatMap(
                                item =>
                                    item.tags
                            )
                        )
                    ],
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

        destroy() {
            if (
                this.destroyed
            ) {
                return false;
            }

            window.clearTimeout(
                this.saveTimer
            );

            this.emit(
                "destroy",
                {
                    timestamp:
                        iso(),
                    version:
                        VERSION
                }
            );

            if (
                this.context.root?.[
                    BOOKMARKS_SYMBOL
                ] ===
                    this
            ) {
                delete this.context.root[
                    BOOKMARKS_SYMBOL
                ];
            }

            this.items =
                [];

            this.history =
                [];

            this.destroyed =
                true;

            return true;
        }

        report(phase, error) {
            this.context.log?.error?.("Terminal bookmarks error", {
                phase,
                error
            });

            document.dispatchEvent(new CustomEvent("speciedex:error", {
                detail: {
                    phase: `terminal-bookmarks:${phase}`,
                    error
                }
            }));
        }
    }

    function initialize(
        context
    ) {
        if (
            !context ||
            typeof context !==
                "object"
        ) {
            throw new TypeError(
                "A terminal context is required."
            );
        }

        const root =
            context.root;

        const existing =
            context.bookmarks instanceof
                Bookmarks
                ? context.bookmarks
                : context.services?.get?.(
                    SERVICE_NAME
                ) ||
                root?.[
                    BOOKMARKS_SYMBOL
                ];

        if (
            existing instanceof
                Bookmarks &&
            !existing.destroyed
        ) {
            context.bookmarks =
                existing;

            context.registerService?.(
                SERVICE_NAME,
                existing
            );

            return existing;
        }

        const dataset =
            root?.
                dataset ||
            {};

        const bookmarks =
            new Bookmarks(
                context,
                {
                    storageKey:
                        dataset.terminalBookmarksStorageKey ||
                        STORAGE_KEY,

                    limit:
                        dataset.terminalBookmarksLimit,

                    importLimit:
                        dataset.terminalBookmarksImportLimit,

                    maxTags:
                        dataset.terminalBookmarksMaxTags,

                    maxNoteLength:
                        dataset.terminalBookmarksMaxNoteLength,

                    maxValueLength:
                        dataset.terminalBookmarksMaxValueLength,

                    historyLimit:
                        dataset.terminalBookmarksHistoryLimit,

                    storageDebounce:
                        dataset.terminalBookmarksStorageDebounce
                }
            );

        root[
            BOOKMARKS_SYMBOL
        ] =
            bookmarks;

        context.bookmarks =
            bookmarks;

        context.registerService?.(
            SERVICE_NAME,
            bookmarks
        );

        document.dispatchEvent(
            new CustomEvent(
                "speciedex:terminal-bookmarks-ready",
                {
                    detail: {
                        context,
                        bookmarks,
                        version:
                            VERSION
                    }
                }
            )
        );

        return bookmarks;
    }

    function outputJSON(writeJSON, write, value) {
        if (typeof writeJSON === "function") {
            return writeJSON(value);
        }
        if (typeof write === "function") {
            return write(JSON.stringify(value, null, 2));
        }
        return value;
    }

    function parseOptions(args) {
        const options = {};
        const positional = [];

        for (let index = 0; index < args.length; index += 1) {
            const item = args[index];

            if (
                item ===
                "--label"
            ) {
                options.label =
                    args[
                        ++index
                    ] ||
                    "";
            } else if (
                item ===
                "--value"
            ) {
                options.value =
                    args[
                        ++index
                    ] ||
                    "";
            } else if (item === "--tag") {
                options.tag = args[++index] || "";
            } else if (item === "--query" || item === "-q") {
                options.query = args[++index] || "";
            } else if (item === "--sort") {
                options.sort = args[++index] || "newest";
            } else if (item === "--limit") {
                options.limit = Number(args[++index]);
            } else if (item === "--tags") {
                options.tags = args[++index] || "";
            } else if (item === "--note") {
                options.note = args[++index] || "";
            } else if (
                item ===
                "--category"
            ) {
                options.category =
                    args[
                        ++index
                    ] ||
                    "general";
            } else if (
                item ===
                "--pinned"
            ) {
                options.pinned =
                    true;
            } else if (
                item ===
                "--unpinned"
            ) {
                options.pinned =
                    false;
            } else if (
                item ===
                "--format"
            ) {
                options.format =
                    args[
                        ++index
                    ] ||
                    "json";
            } else if (
                item ===
                "--include-history"
            ) {
                options.includeHistory =
                    true;
            } else if (item === "--replace") {
                options.replace = true;
            } else {
                positional.push(item);
            }
        }

        return { options, positional };
    }

    const commands = [{
        name: "bookmark",
        aliases: ["bookmarks", "bm"],
        category: "data",
        description: "Add, list, inspect, update, remove, clear, import, or export terminal bookmarks.",
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
        handler: ({ args = [], context, writeJSON, write }) => {
            const bookmarks = context.bookmarks || initialize(context);
            const tokens = Array.from(args);
            const action = text(tokens.shift() || "list").toLowerCase();
            const parsed = parseOptions(tokens);
            const positional = parsed.positional;
            const options = parsed.options;

            if (action === "add") {
                const label = positional.shift();
                const value = positional.join(" ");
                const bookmark = bookmarks.add(label, value, options);
                write?.(`Bookmark added: ${bookmark.label}`, "success");
                return bookmark;
            }

            if (action === "list" || action === "ls") {
                return outputJSON(writeJSON, write, bookmarks.list(options));
            }

            if (action === "show" || action === "get") {
                const bookmark = bookmarks.get(positional.join(" "));
                if (!bookmark) {
                    throw new Error("Bookmark not found.");
                }
                return outputJSON(writeJSON, write, bookmark);
            }

            if (
                action ===
                    "open" ||
                action ===
                    "run"
            ) {
                const bookmark =
                    bookmarks.open(
                        positional.join(
                            " "
                        )
                    );

                if (!bookmark) {
                    throw new Error(
                        "Bookmark not found."
                    );
                }

                write?.(
                    `Bookmark opened: ${bookmark.label}`,
                    "success"
                );

                return bookmark;
            }

            if (
                action ===
                    "update" ||
                action ===
                    "edit"
            ) {
                const target =
                    positional.join(
                        " "
                    );

                const bookmark =
                    bookmarks.update(
                        target,
                        {
                            ...(options.label
                                ? {
                                    label:
                                        options.label
                                }
                                : {}),
                            ...(options.value
                                ? {
                                    value:
                                        options.value
                                }
                                : {}),
                            ...(options.tags !==
                                undefined
                                ? {
                                    tags:
                                        options.tags
                                }
                                : {}),
                            ...(options.note !==
                                undefined
                                ? {
                                    note:
                                        options.note
                                }
                                : {}),
                            ...(options.category
                                ? {
                                    category:
                                        options.category
                                }
                                : {}),
                            ...(options.pinned !==
                                undefined
                                ? {
                                    pinned:
                                        options.pinned
                                }
                                : {})
                        }
                    );

                if (!bookmark) {
                    throw new Error(
                        "Bookmark not found."
                    );
                }

                write?.(
                    `Bookmark updated: ${bookmark.label}`,
                    "success"
                );

                return bookmark;
            }

            if (
                action ===
                    "pin" ||
                action ===
                    "unpin"
            ) {
                const bookmark =
                    bookmarks.pin(
                        positional.join(
                            " "
                        ),
                        action ===
                        "pin"
                    );

                if (!bookmark) {
                    throw new Error(
                        "Bookmark not found."
                    );
                }

                return bookmark;
            }

            if (
                action ===
                    "tag" ||
                action ===
                    "untag"
            ) {
                const target =
                    positional.shift();

                const tags =
                    positional.join(
                        ","
                    );

                const bookmark =
                    action ===
                        "tag"
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

            if (action === "remove" || action === "delete" || action === "rm") {
                const removed = bookmarks.remove(positional.join(" "));
                if (!removed) {
                    throw new Error("Bookmark not found.");
                }
                write?.(`Bookmark removed: ${removed.label}`, "success");
                return removed;
            }

            if (action === "clear") {
                const count = bookmarks.clear();
                write?.(`Removed ${count} bookmark${count === 1 ? "" : "s"}.`, "success");
                return count;
            }

            if (
                action ===
                    "export"
            ) {
                const exported =
                    bookmarks.export(
                        options
                    );

                if (
                    typeof exported ===
                    "string"
                ) {
                    return write?.(
                        exported,
                        "output",
                        {
                            preformatted:
                                true
                        }
                    ) ??
                    exported;
                }

                return outputJSON(
                    writeJSON,
                    write,
                    exported
                );
            }

            if (
                action ===
                    "import"
            ) {
                const payload =
                    positional.join(
                        " "
                    );

                if (!payload) {
                    throw new Error(
                        "Bookmark import JSON is required."
                    );
                }

                return outputJSON(
                    writeJSON,
                    write,
                    bookmarks.import(
                        payload,
                        options
                    )
                );
            }

            if (
                action ===
                    "status"
            ) {
                return outputJSON(
                    writeJSON,
                    write,
                    bookmarks.status()
                );
            }

            if (
                action ===
                    "history"
            ) {
                return outputJSON(
                    writeJSON,
                    write,
                    {
                        history:
                            clone(
                                bookmarks.history
                            )
                    }
                );
            }

            throw new Error(`Unknown bookmark action: ${action}`);
        }
    }];

    const api = Object.freeze({
        name:
            MODULE_NAME,
        version:
            VERSION,
        service:
            SERVICE_NAME,
        BOOKMARKS_SYMBOL,
        Bookmarks,
        clone,
        normalizeCategory,
        formulaSafeText,
        csvCell,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalBookmarks = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: {
            name: MODULE_NAME,
            module: api
        }
    }));
})(window, document);
