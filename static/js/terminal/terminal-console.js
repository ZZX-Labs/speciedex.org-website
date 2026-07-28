/*
========================================================================
Speciedex.org
Terminal Console Bridge
========================================================================

Structured console service for SpeciedexTerminal.

Provides:

    • Structured terminal and browser-console output
    • Safe serialization of arbitrary JavaScript values
    • Buffered, filterable console history
    • Groups, counters, timers, assertions, JSON, and tables
    • Lifecycle events and terminal command integration
    • JSON export with safe browser fallback

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Console";
    const VERSION = "3.2.0";

    const CONSOLE_SYMBOL =
        Symbol.for(
            "speciedex.terminal.console.bridge"
        );

    const DEFAULT_CHANNEL =
        "terminal";

    const DEFAULT_DUPLICATE_WINDOW =
        1000;

    const DEFAULT_DUPLICATE_LIMIT =
        25;

    const DEFAULT_THROTTLE_WINDOW =
        5000;

    const DEFAULT_THROTTLE_LIMIT =
        100;

    const DEFAULT_MAX_TAGS =
        32;

    const DEFAULT_MAX_CHANNELS =
        256;

    const DEFAULT_MAX_IMPORT_ENTRIES =
        10000;

    const DEFAULT_MAX_EXPORT_BYTES =
        128 *
        1024 *
        1024;

    const DEFAULT_REVOKE_DELAY =
        30000;

    const DEFAULT_MAX_EMIT_DEPTH =
        32;

    const RESERVED_KEYS =
        new Set([
            "__proto__",
            "prototype",
            "constructor"
        ]);

    const activeDispatches =
        new WeakMap();

    const DEFAULT_HISTORY_LIMIT = 1000;
    const MIN_HISTORY_LIMIT = 10;
    const MAX_HISTORY_LIMIT = 10000;
    const DEFAULT_LIST_LIMIT = 100;
    const MAX_SERIALIZED_ITEMS = 1024;

    const LEVELS = Object.freeze([
        "trace",
        "debug",
        "info",
        "success",
        "warning",
        "error",
        "system"
    ]);

    const LEVEL_ALIASES = Object.freeze({
        warn: "warning",
        log: "info",
        ok: "success",
        fail: "error"
    });

    const BROWSER_METHODS = Object.freeze({
        trace: "trace",
        debug: "debug",
        info: "info",
        success: "info",
        warning: "warn",
        error: "error",
        system: "info"
    });

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
            Fall through to a deterministic-enough local identifier.
            ------------------------------------------------------------------
            */
        }

        return [
            Date.now().toString(36),
            Math.random().toString(36).slice(2, 12)
        ].join("-");
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

    function parseBoolean(value, fallback = false) {
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

        if (["true", "1", "yes", "on"].includes(normalized)) {
            return true;
        }

        if (["false", "0", "no", "off"].includes(normalized)) {
            return false;
        }

        return fallback;
    }

    function normalizeLevel(level) {
        const normalized =
            String(level || "info")
                .trim()
                .toLowerCase();

        return LEVEL_ALIASES[normalized] || normalized;
    }

    function isPlainObject(value) {
        if (
            value === null ||
            typeof value !== "object"
        ) {
            return false;
        }

        const prototype =
            Object.getPrototypeOf(value);

        return (
            prototype === Object.prototype ||
            prototype === null
        );
    }

    function isElement(value) {
        return Boolean(
            value &&
            value.nodeType === 1 &&
            typeof value.dispatchEvent === "function"
        );
    }

    function isDOMNode(value) {
        return (
            typeof window.Node === "function" &&
            value instanceof window.Node
        );
    }

    function isBlob(value) {
        return (
            typeof window.Blob === "function" &&
            value instanceof window.Blob
        );
    }

    function isURL(value) {
        return (
            typeof window.URL === "function" &&
            value instanceof window.URL
        );
    }

    function safeDateISO(value) {
        try {
            const timestamp =
                value instanceof Date
                    ? value
                    : new Date(value);

            if (Number.isNaN(timestamp.getTime())) {
                return null;
            }

            return timestamp.toISOString();
        } catch (_error) {
            return null;
        }
    }

    function safeSerialize(
        value,
        seen =
            new WeakMap(),
        depth =
            0,
        path =
            "$"
    ) {
        if (
            value ===
                null ||
            value ===
                undefined
        ) {
            return value;
        }

        if (
            depth >
            64
        ) {
            return "[Truncated]";
        }

        const type =
            typeof value;

        if (
            type === "string" ||
            type === "number" ||
            type === "boolean"
        ) {
            return value;
        }

        if (type === "bigint") {
            return `${value.toString()}n`;
        }

        if (type === "symbol") {
            return value.toString();
        }

        if (type === "function") {
            return `[Function ${value.name || "anonymous"}]`;
        }

        if (type !== "object") {
            return String(value);
        }

        if (
            seen.has(
                value
            )
        ) {
            return `[Circular -> ${seen.get(value)}]`;
        }

        seen.set(
            value,
            path
        );

        try {
            if (value instanceof Error) {
                const output = {
                    name: value.name || "Error",
                    message: value.message || "",
                    stack: value.stack || null
                };

                if ("cause" in value) {
                    output.cause =
                        safeSerialize(value.cause, seen, depth + 1, `${path}.cause`);
                }

                for (const [key, item] of Object.entries(value)) {
                    if (!(key in output)) {
                        output[key] =
                            safeSerialize(item, seen, depth + 1, `${path}.${key}`);
                    }
                }

                return output;
            }

            if (value instanceof Date) {
                return (
                    safeDateISO(value) ||
                    "Invalid Date"
                );
            }

            if (value instanceof RegExp) {
                return value.toString();
            }

            if (isURL(value)) {
                return value.href;
            }

            if (isBlob(value)) {
                return {
                    type:
                        value.type ||
                        "application/octet-stream",
                    size: value.size
                };
            }

            if (value instanceof ArrayBuffer) {
                return {
                    type: "ArrayBuffer",
                    byteLength: value.byteLength
                };
            }

            if (ArrayBuffer.isView(value)) {
                const values =
                    Array.from(value)
                        .slice(0, MAX_SERIALIZED_ITEMS);

                return {
                    type:
                        value.constructor?.name ||
                        "TypedArray",
                    length:
                        value.length ??
                        value.byteLength,
                    truncated:
                        (value.length ?? values.length) >
                        values.length,
                    values
                };
            }

            if (value instanceof Map) {
                const entries = [];
                let index = 0;

                for (const [key, item] of value.entries()) {
                    if (index >= MAX_SERIALIZED_ITEMS) {
                        break;
                    }

                    entries.push([
                        safeSerialize(
                            key,
                            seen,
                            depth +
                                1,
                            `${path}.map-key-${index}`
                        ),
                        safeSerialize(
                            item,
                            seen,
                            depth +
                                1,
                            `${path}.map-value-${index}`
                        )
                    ]);

                    index += 1;
                }

                return {
                    type: "Map",
                    size: value.size,
                    truncated:
                        value.size > entries.length,
                    entries
                };
            }

            if (value instanceof Set) {
                const values = [];
                let index = 0;

                for (const item of value.values()) {
                    if (index >= MAX_SERIALIZED_ITEMS) {
                        break;
                    }

                    values.push(
                        safeSerialize(
                            item,
                            seen,
                            depth +
                                1,
                            `${path}.set-${index}`
                        )
                    );

                    index += 1;
                }

                return {
                    type: "Set",
                    size: value.size,
                    truncated:
                        value.size > values.length,
                    values
                };
            }

            if (isDOMNode(value)) {
                return {
                    type:
                        value.nodeName ||
                        value.constructor?.name ||
                        "Node",
                    id:
                        value.id || null,
                    className:
                        typeof value.className === "string"
                            ? value.className
                            : null,
                    text:
                        typeof value.textContent === "string"
                            ? value.textContent.slice(0, 256)
                            : null
                };
            }

            if (Array.isArray(value)) {
                const output =
                    value
                        .slice(0, MAX_SERIALIZED_ITEMS)
                        .map(
                            (
                                item,
                                index
                            ) =>
                                safeSerialize(
                                    item,
                                    seen,
                                    depth +
                                        1,
                                    `${path}[${index}]`
                                )
                        );

                if (value.length > output.length) {
                    output.push(
                        `[${value.length - output.length} more items]`
                    );
                }

                return output;
            }

            const output = {};
            const entries =
                Object.entries(value)
                    .slice(0, MAX_SERIALIZED_ITEMS);

            for (const [key, item] of entries) {
                try {
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
                        safeSerialize(
                            item,
                            seen,
                            depth +
                                1,
                            `${path}.${key}`
                        );
                } catch (error) {
                    output[key] =
                        `[Unserializable: ${error?.message || error}]`;
                }
            }

            if (
                Object.keys(value).length >
                entries.length
            ) {
                output.__truncated__ = true;
            }

            if (!isPlainObject(value)) {
                output.__type__ =
                    value.constructor?.name ||
                    "Object";
            }

            return output;
        } catch (error) {
            return `[Unserializable: ${error?.message || error}]`;
        }
    }

    function clone(
        value
    ) {
        return safeSerialize(
            value,
            new WeakMap(),
            0,
            "$"
        );
    }

    function normalizeChannel(
        value
    ) {
        const normalized =
            String(
                value ||
                DEFAULT_CHANNEL
            )
                .trim()
                .toLowerCase()
                .replace(
                    /\s+/g,
                    "-"
                )
                .replace(
                    /[^a-z0-9:_-]/g,
                    ""
                );

        return normalized ||
            DEFAULT_CHANNEL;
    }

    function normalizeTags(
        values
    ) {
        const source =
            Array.isArray(values)
                ? values
                : values instanceof Set
                    ? Array.from(values)
                    : values === undefined ||
                        values === null
                        ? []
                        : typeof values === "string"
                            ? values.split(",")
                            : [values];

        return [
            ...new Set(
                source
                    .map(value =>
                        String(value)
                            .normalize("NFKC")
                            .trim()
                            .toLowerCase()
                            .replace(/^#+/, "")
                            .replace(/\s+/g, " ")
                    )
                    .filter(
                        value =>
                            value &&
                            !RESERVED_KEYS.has(value)
                    )
            )
        ].slice(
            0,
            DEFAULT_MAX_TAGS
        );
    }

    function sanitizeCSVCell(
        value,
        options =
            {}
    ) {
        let text =
            value ===
                null ||
            value ===
                undefined
                ? ""
                : typeof value ===
                    "string"
                    ? value
                    : JSON.stringify(
                        clone(
                            value
                        )
                    );

        if (
            options.formulaSafe !==
                false &&
            /^[=+\-@\t\r]/.test(
                text
            )
        ) {
            text =
                `'${text}`;
        }

        return `"${text.replace(/"/g, '""')}"`;
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

    function byteLength(
        value
    ) {
        try {
            return new Blob([
                String(
                    value
                )
            ]).size;
        } catch (_error) {
            return String(
                value
            ).length;
        }
    }

    function formatValue(value) {
        if (typeof value === "string") {
            return value;
        }

        if (
            typeof value === "number" ||
            typeof value === "boolean" ||
            value === null ||
            value === undefined
        ) {
            return String(value);
        }

        try {
            return JSON.stringify(
                safeSerialize(value),
                null,
                2
            );
        } catch (_error) {
            try {
                return String(value);
            } catch (_stringError) {
                return "[Unprintable value]";
            }
        }
    }

    function formatValues(values) {
        return values
            .map(formatValue)
            .join(" ");
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

    function sanitizeFilename(value) {
        const filename =
            String(
                value ||
                "speciedex-terminal-console.json"
            )
                .trim()
                .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
                .replace(/\s+/g, "-")
                .replace(/-+/g, "-")
                .replace(/^\.+/, "")
                .slice(0, 180);

        if (!filename) {
            return "speciedex-terminal-console.json";
        }

        return filename
            .toLowerCase()
            .endsWith(".json")
                ? filename
                : `${filename}.json`;
    }

    function downloadText(
        text,
        filename,
        mimeType,
        options =
            {}
    ) {
        const blob =
            new Blob(
                [text],
                {
                    type:
                        mimeType ||
                        "text/plain;charset=utf-8"
                }
            );

        const maximum =
            clampInteger(
                options.maxBytes,
                DEFAULT_MAX_EXPORT_BYTES,
                1,
                1024 *
                1024 *
                1024
            );

        if (
            blob.size >
            maximum
        ) {
            throw new RangeError(
                `Console export size ${blob.size} bytes exceeds ${maximum} bytes.`
            );
        }

        const url =
            URL.createObjectURL(
                blob
            );

        const anchor =
            document.createElement("a");

        anchor.href = url;
        anchor.download = filename;
        anchor.hidden = true;

        document.body?.appendChild(anchor);
        anchor.click();
        anchor.remove();

        window.setTimeout(
            () =>
                URL.revokeObjectURL(
                    url
                ),
            clampInteger(
                options.revokeDelay,
                DEFAULT_REVOKE_DELAY,
                0,
                600000
            )
        );

        return {
            filename,
            bytes:
                blob.size,
            mimeType:
                blob.type
        };
    }

    class ConsoleBridge extends EventTarget {
        constructor(context = {}, options = {}) {
            super();

            this.context =
                context &&
                typeof context === "object"
                    ? context
                    : {};

            this.options = {
                historyLimit:
                    clampInteger(
                        options.historyLimit,
                        DEFAULT_HISTORY_LIMIT,
                        MIN_HISTORY_LIMIT,
                        MAX_HISTORY_LIMIT
                    ),
                mirror:
                    parseBoolean(
                        options.mirror,
                        true
                    ),
                minimumLevel:
                    normalizeLevel(
                        options.minimumLevel ||
                        "trace"
                    ),
                captureFiltered:
                    parseBoolean(
                        options.captureFiltered,
                        true
                    )
            };

            if (
                !LEVELS.includes(
                    this.options.minimumLevel
                )
            ) {
                this.options.minimumLevel =
                    "trace";
            }

            this.history =
                [];

            this.groups =
                [];

            this.timers =
                new Map();

            this.counters =
                new Map();

            this.channels =
                new Map();

            this.bookmarks =
                new Set();

            this.correlations =
                new Map();

            this.suppression =
                new Map();

            this.throttle =
                new Map();

            this.enabled =
                true;

            this.ready =
                true;

            this.destroyed =
                false;

            this.watchers =
                new Set();

            this.emitting =
                false;

            this.emitDepth =
                0;

            this.syncingState =
                false;

            this.captureInstalled =
                false;

            this.abortController =
                new AbortController();

            this.filters = {
                channels:
                    new Set(),
                tags:
                    new Set(),
                modules:
                    new Set(),
                regex:
                    null
            };

            this.options.defaultChannel =
                normalizeChannel(
                    options.defaultChannel ||
                    DEFAULT_CHANNEL
                );

            this.options.captureGlobalErrors =
                parseBoolean(
                    options.captureGlobalErrors,
                    true
                );

            this.options.captureRejections =
                parseBoolean(
                    options.captureRejections,
                    true
                );

            this.options.duplicateWindow =
                clampInteger(
                    options.duplicateWindow,
                    DEFAULT_DUPLICATE_WINDOW,
                    0,
                    60000
                );

            this.options.duplicateLimit =
                clampInteger(
                    options.duplicateLimit,
                    DEFAULT_DUPLICATE_LIMIT,
                    1,
                    100000
                );

            this.options.throttleWindow =
                clampInteger(
                    options.throttleWindow,
                    DEFAULT_THROTTLE_WINDOW,
                    0,
                    600000
                );

            this.options.throttleLimit =
                clampInteger(
                    options.throttleLimit,
                    DEFAULT_THROTTLE_LIMIT,
                    1,
                    1000000
                );

            this.options.maxChannels =
                clampInteger(
                    options.maxChannels,
                    DEFAULT_MAX_CHANNELS,
                    1,
                    10000
                );

            this.options.maxImportEntries =
                clampInteger(
                    options.maxImportEntries,
                    DEFAULT_MAX_IMPORT_ENTRIES,
                    1,
                    1000000
                );

            this.options.maxExportBytes =
                clampInteger(
                    options.maxExportBytes,
                    DEFAULT_MAX_EXPORT_BYTES,
                    1,
                    1024 *
                    1024 *
                    1024
                );

            this.options.maxEmitDepth =
                clampInteger(
                    options.maxEmitDepth,
                    DEFAULT_MAX_EMIT_DEPTH,
                    1,
                    1024
                );

            this.metrics = {
                entries:
                    0,
                written:
                    0,
                mirrored:
                    0,
                filtered:
                    0,
                suppressed:
                    0,
                throttled:
                    0,
                errors:
                    0,
                imports:
                    0,
                exports:
                    0,
                bookmarks:
                    0,
                timers:
                    0,
                counters:
                    0,
                globalErrors:
                    0,
                unhandledRejections:
                    0,
                recursionRejected:
                    0
            };

            this.installGlobalCapture();
        }

        assertAvailable() {
            if (
                this.destroyed
            ) {
                throw new Error(
                    "Console bridge has been destroyed."
                );
            }
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
                this.emitDepth >=
                this.options.maxEmitDepth
            ) {
                this.metrics.recursionRejected +=
                    1;

                return false;
            }

            this.emitDepth +=
                1;

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
                        /* Watcher failures do not break console output. */
                    }
                }

                try {
                    this.context.events?.emit?.(
                        `console:${name}`,
                        detail
                    );
                } catch (_error) {
                    /* Observer failures do not break console output. */
                }

                dispatch(
                    document,
                    `speciedex:terminal-console-${name}`,
                    detail
                );

                dispatch(
                    this.context.root,
                    `speciedex:terminal-console-${name}`,
                    detail,
                    {
                        bubbles:
                            true
                    }
                );

                return true;
            } finally {
                this.emitDepth =
                    Math.max(
                        0,
                        this.emitDepth -
                            1
                    );
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
                    "terminal.console",
                    {
                        enabled:
                            this.enabled,
                        history:
                            this.history.length,
                        minimumLevel:
                            this.options.minimumLevel,
                        mirror:
                            this.options.mirror,
                        channels:
                            [
                                ...this.channels.keys()
                            ],
                        bookmarks:
                            this.bookmarks.size,
                        metrics: {
                            ...this.metrics
                        },
                        updatedAt:
                            nowISO()
                    },
                    {
                        source:
                            "console",
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

        installGlobalCapture() {
            if (
                this.captureInstalled ||
                this.destroyed
            ) {
                return false;
            }

            const signal =
                this.abortController.signal;

            if (
                this.options.captureGlobalErrors
            ) {
                window.addEventListener(
                    "error",
                    event => {
                        this.metrics.globalErrors +=
                            1;

                        this.output(
                            "error",
                            [
                                event.message ||
                                "Unhandled window error",
                                event.error ||
                                null
                            ],
                            {
                                channel:
                                    "runtime",
                                tags: [
                                    "global-error"
                                ],
                                source:
                                    event.filename ||
                                    null,
                                line:
                                    event.lineno ||
                                    null,
                                column:
                                    event.colno ||
                                    null
                            }
                        );
                    },
                    {
                        signal
                    }
                );
            }

            if (
                this.options.captureRejections
            ) {
                window.addEventListener(
                    "unhandledrejection",
                    event => {
                        this.metrics.unhandledRejections +=
                            1;

                        this.output(
                            "error",
                            [
                                "Unhandled promise rejection",
                                event.reason
                            ],
                            {
                                channel:
                                    "runtime",
                                tags: [
                                    "unhandled-rejection"
                                ]
                            }
                        );
                    },
                    {
                        signal
                    }
                );
            }

            this.captureInstalled =
                true;

            return true;
        }

        matchesFilters(
            entry
        ) {
            if (
                this.filters.channels.size &&
                !this.filters.channels.has(
                    entry.channel
                )
            ) {
                return false;
            }

            if (
                this.filters.modules.size &&
                !this.filters.modules.has(
                    entry.module
                )
            ) {
                return false;
            }

            if (
                this.filters.tags.size &&
                !entry.tags.some(
                    tag =>
                        this.filters.tags.has(
                            tag
                        )
                )
            ) {
                return false;
            }

            if (this.filters.regex) {
                this.filters.regex.lastIndex = 0;

                if (
                    !this.filters.regex.test(
                        entry.message
                    )
                ) {
                    return false;
                }
            }

            return true;
        }

        shouldSuppress(
            key,
            now =
                Date.now()
        ) {
            if (
                !this.options.duplicateWindow
            ) {
                return false;
            }

            const record =
                this.suppression.get(
                    key
                ) || {
                    count:
                        0,
                    first:
                        now,
                    last:
                        now
                };

            if (
                now -
                record.first >
                this.options.duplicateWindow
            ) {
                record.count =
                    0;

                record.first =
                    now;
            }

            record.count +=
                1;

            record.last =
                now;

            this.suppression.set(
                key,
                record
            );

            if (
                record.count >
                this.options.duplicateLimit
            ) {
                this.metrics.suppressed +=
                    1;

                return true;
            }

            return false;
        }

        shouldThrottle(
            channel,
            now =
                Date.now()
        ) {
            if (
                !this.options.throttleWindow
            ) {
                return false;
            }

            const record =
                this.throttle.get(
                    channel
                ) || {
                    count:
                        0,
                    first:
                        now
                };

            if (
                now -
                record.first >
                this.options.throttleWindow
            ) {
                record.count =
                    0;

                record.first =
                    now;
            }

            record.count +=
                1;

            this.throttle.set(
                channel,
                record
            );

            if (
                record.count >
                this.options.throttleLimit
            ) {
                this.metrics.throttled +=
                    1;

                return true;
            }

            return false;
        }

        levelIndex(level) {
            const index =
                LEVELS.indexOf(
                    normalizeLevel(level)
                );

            return index >= 0 ? index : 0;
        }

        shouldWrite(level) {
            return (
                this.enabled &&
                !this.destroyed &&
                this.levelIndex(level) >=
                this.levelIndex(
                    this.options.minimumLevel
                )
            );
        }

        createEntry(
            level,
            values,
            metadata =
                {}
        ) {
            this.assertAvailable();

            const channel =
                normalizeChannel(
                    metadata.channel ||
                    metadata.module ||
                    this.options.defaultChannel
                );

            if (
                !this.channels.has(
                    channel
                ) &&
                this.channels.size <
                    this.options.maxChannels
            ) {
                this.channels.set(
                    channel,
                    {
                        createdAt:
                            nowISO(),
                        entries:
                            0
                    }
                );
            }

            const module =
                String(
                    metadata.module ||
                    metadata.sourceModule ||
                    channel
                );

            const tags =
                normalizeTags(
                    metadata.tags
                );

            const correlationId =
                metadata.correlationId ||
                metadata.correlationID ||
                metadata.transactionId ||
                metadata.commandId ||
                null;

            const entry = {
                id:
                    createId(),
                timestamp:
                    nowISO(),
                level:
                    normalizeLevel(
                        level
                    ),
                channel,
                module,
                tags,
                correlationId,
                commandId:
                    metadata.commandId ||
                    null,
                transactionId:
                    metadata.transactionId ||
                    null,
                group:
                    [
                        ...this.groups
                    ],
                message:
                    formatValues(
                        values
                    ),
                values:
                    values.map(
                        (
                            value,
                            index
                        ) =>
                            safeSerialize(
                                value,
                                new WeakMap(),
                                0,
                                `$.values[${index}]`
                            )
                    ),
                metadata:
                    safeSerialize(
                        metadata,
                        new WeakMap(),
                        0,
                        "$.metadata"
                    )
            };

            const duplicateKey =
                [
                    entry.level,
                    entry.channel,
                    entry.message
                ].join(
                    "\u0000"
                );

            if (
                this.shouldSuppress(
                    duplicateKey
                ) ||
                this.shouldThrottle(
                    entry.channel
                )
            ) {
                entry.suppressed =
                    true;

                return entry;
            }

            this.history.push(
                entry
            );

            const channelState =
                this.channels.get(
                    channel
                );

            if (channelState) {
                channelState.entries +=
                    1;
            }

            if (
                correlationId
            ) {
                if (
                    !this.correlations.has(
                        correlationId
                    )
                ) {
                    this.correlations.set(
                        correlationId,
                        []
                    );
                }

                this.correlations.get(
                    correlationId
                ).push(
                    entry.id
                );
            }

            if (
                this.history.length >
                this.options.historyLimit
            ) {
                const removed =
                    this.history.splice(
                        0,
                        this.history.length -
                        this.options.historyLimit
                    );

                for (
                    const item of
                    removed
                ) {
                    this.bookmarks.delete(
                        item.id
                    );
                }
            }

            this.metrics.entries +=
                1;

            return entry;
        }

        emitEntry(
            entry
        ) {
            if (
                entry?.suppressed
            ) {
                return false;
            }

            this.emit(
                "entry",
                entry
            );

            this.syncState();

            return true;
        }

        mirror(level, values) {
            if (!this.options.mirror) {
                return;
            }

            const consoleObject =
                window.console;

            if (!consoleObject) {
                return;
            }

            const method =
                BROWSER_METHODS[level] ||
                "log";

            const writer =
                typeof consoleObject[method] === "function"
                    ? consoleObject[method]
                    : consoleObject.log;

            try {
                writer?.apply(
                    consoleObject,
                    values
                );

                this.metrics.mirrored +=
                    1;
            } catch (_error) {
                /*
                ----------------------------------------------------------------
                Browser console mirroring is non-critical.
                ----------------------------------------------------------------
                */
            }
        }

        writeTerminal(entry) {
            const prefix =
                this.groups.length
                    ? "  ".repeat(
                        this.groups.length
                    )
                    : "";

            const type =
                entry.level === "warning"
                    ? "warning"
                    : entry.level;

            if (
                typeof this.context.write ===
                "function"
            ) {
                this.metrics.written +=
                    1;

                return this.context.write(
                    `${prefix}${entry.message}`,
                    type,
                    {
                        preformatted:
                            entry.message.includes("\n"),
                        consoleEntry: entry
                    }
                );
            }

            const fallback =
                window.console?.[
                    BROWSER_METHODS[entry.level] ||
                    "log"
                ] ||
                window.console?.log;

            fallback?.call(
                window.console,
                `${prefix}${entry.message}`
            );

            return entry;
        }

        output(
            level,
            values,
            metadata =
                {}
        ) {
            this.assertAvailable();

            const normalizedLevel =
                normalizeLevel(
                    level
                );

            if (
                !LEVELS.includes(
                    normalizedLevel
                )
            ) {
                throw new Error(
                    `Unknown console level: ${level}`
                );
            }

            const normalizedValues =
                Array.isArray(
                    values
                )
                    ? values
                    : [
                        values
                    ];

            const shouldWrite =
                this.shouldWrite(
                    normalizedLevel
                );

            const shouldCapture =
                shouldWrite ||
                this.options.captureFiltered;

            const entry =
                shouldCapture
                    ? this.createEntry(
                        normalizedLevel,
                        normalizedValues,
                        metadata
                    )
                    : {
                        id:
                            null,
                        timestamp:
                            nowISO(),
                        level:
                            normalizedLevel,
                        channel:
                            normalizeChannel(
                                metadata.channel ||
                                metadata.module ||
                                this.options.defaultChannel
                            ),
                        module:
                            String(
                                metadata.module ||
                                metadata.sourceModule ||
                                metadata.channel ||
                                this.options.defaultChannel
                            ),
                        tags:
                            normalizeTags(
                                metadata.tags
                            ),
                        correlationId:
                            metadata.correlationId ||
                            null,
                        commandId:
                            metadata.commandId ||
                            null,
                        transactionId:
                            metadata.transactionId ||
                            null,
                        group:
                            [
                                ...this.groups
                            ],
                        message:
                            formatValues(
                                normalizedValues
                            ),
                        values:
                            normalizedValues.map(
                                (
                                    value,
                                    index
                                ) =>
                                    safeSerialize(
                                        value,
                                        new WeakMap(),
                                        0,
                                        `$.values[${index}]`
                                    )
                            ),
                        metadata:
                            safeSerialize(
                                metadata,
                                new WeakMap(),
                                0,
                                "$.metadata"
                            )
                    };

            if (
                entry.suppressed
            ) {
                return entry;
            }

            const passesFilters =
                this.matchesFilters(
                    entry
                );

            this.mirror(
                normalizedLevel,
                normalizedValues
            );

            if (
                shouldWrite &&
                passesFilters
            ) {
                this.writeTerminal(
                    entry
                );
            } else if (
                shouldWrite &&
                !passesFilters
            ) {
                this.metrics.filtered +=
                    1;
            }

            this.emitEntry(
                entry
            );

            return entry;
        }

        log(...values) {
            return this.info(...values);
        }

        info(...values) {
            return this.output(
                "info",
                values
            );
        }

        success(...values) {
            return this.output(
                "success",
                values
            );
        }

        warn(...values) {
            return this.output(
                "warning",
                values
            );
        }

        warning(...values) {
            return this.warn(...values);
        }

        error(...values) {
            return this.output(
                "error",
                values
            );
        }

        debug(...values) {
            return this.output(
                "debug",
                values
            );
        }

        trace(...values) {
            const stack =
                new Error().stack || "";

            return this.output(
                "trace",
                [
                    ...values,
                    stack
                ],
                {
                    trace: true
                }
            );
        }

        system(...values) {
            return this.output(
                "system",
                values
            );
        }

        json(value, label = "") {
            const serialized =
                safeSerialize(
                    value,
                    new WeakMap(),
                    0,
                    "$"
                );

            if (label) {
                this.info(label);
            }

            if (
                typeof this.context.writeJSON ===
                "function"
            ) {
                this.context.writeJSON(
                    serialized
                );
            } else {
                this.writeTerminal({
                    level: "info",
                    message:
                        JSON.stringify(
                            serialized,
                            null,
                            2
                        ),
                    values: [serialized],
                    metadata: {},
                    timestamp: nowISO(),
                    group:
                        [...this.groups]
                });
            }

            const entry =
                this.createEntry(
                    "info",
                    [serialized],
                    {
                        renderer: "json",
                        label
                    }
                );

            this.emitEntry(entry);
            return entry;
        }

        table(rows, columns = null, label = "") {
            const data =
                Array.isArray(rows)
                    ? rows
                    : [];

            if (!data.length) {
                return this.info(
                    label ||
                    "No table rows."
                );
            }

            const headers =
                Array.isArray(columns) &&
                columns.length
                    ? columns.map(String)
                    : [
                        ...new Set(
                            data.flatMap(row =>
                                isPlainObject(row)
                                    ? Object.keys(row)
                                    : []
                            )
                        )
                    ];

            if (!headers.length) {
                headers.push("value");
            }

            const values =
                data.map(row => {
                    if (isPlainObject(row)) {
                        return headers.map(
                            header => row[header]
                        );
                    }

                    if (Array.isArray(row)) {
                        return row;
                    }

                    return [row];
                });

            if (label) {
                this.info(label);
            }

            if (
                typeof this.context.writeTable ===
                "function"
            ) {
                this.context.writeTable(
                    headers,
                    values
                );
            } else {
                this.json(
                    data,
                    ""
                );
            }

            const entry =
                this.createEntry(
                    "info",
                    [data],
                    {
                        renderer: "table",
                        headers,
                        label
                    }
                );

            this.emitEntry(entry);
            return entry;
        }

        channel(
            name,
            options =
                {}
        ) {
            const channel =
                normalizeChannel(
                    name
                );

            const bridge =
                this;

            return Object.freeze({
                trace:
                    (...values) =>
                        bridge.output(
                            "trace",
                            values,
                            {
                                ...options,
                                channel
                            }
                        ),
                debug:
                    (...values) =>
                        bridge.output(
                            "debug",
                            values,
                            {
                                ...options,
                                channel
                            }
                        ),
                info:
                    (...values) =>
                        bridge.output(
                            "info",
                            values,
                            {
                                ...options,
                                channel
                            }
                        ),
                success:
                    (...values) =>
                        bridge.output(
                            "success",
                            values,
                            {
                                ...options,
                                channel
                            }
                        ),
                warn:
                    (...values) =>
                        bridge.output(
                            "warning",
                            values,
                            {
                                ...options,
                                channel
                            }
                        ),
                error:
                    (...values) =>
                        bridge.output(
                            "error",
                            values,
                            {
                                ...options,
                                channel
                            }
                        ),
                system:
                    (...values) =>
                        bridge.output(
                            "system",
                            values,
                            {
                                ...options,
                                channel
                            }
                        ),
                json:
                    (
                        value,
                        label =
                            ""
                    ) =>
                        bridge.output(
                            "info",
                            [
                                label,
                                value
                            ].filter(
                                item =>
                                    item !==
                                    ""
                            ),
                            {
                                ...options,
                                channel,
                                renderer:
                                    "json"
                            }
                        )
            });
        }

        watch(callback, options = {}) {
            this.assertAvailable();

            if (typeof callback !== "function") {
                throw new TypeError(
                    "Console watcher must be a function."
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

        bookmark(
            entryId
        ) {
            const id =
                String(
                    entryId ||
                    ""
                );

            if (
                !this.history.some(
                    entry =>
                        entry.id ===
                        id
                )
            ) {
                return false;
            }

            this.bookmarks.add(
                id
            );

            this.metrics.bookmarks =
                this.bookmarks.size;

            this.emit(
                "bookmark",
                {
                    id
                }
            );

            return true;
        }

        unbookmark(
            entryId
        ) {
            const removed =
                this.bookmarks.delete(
                    String(
                        entryId ||
                        ""
                    )
                );

            this.metrics.bookmarks =
                this.bookmarks.size;

            return removed;
        }

        getBookmarked() {
            return this.history
                .filter(
                    entry =>
                        this.bookmarks.has(
                            entry.id
                        )
                )
                .map(
                    clone
                );
        }

        byCorrelation(
            correlationId
        ) {
            const ids =
                new Set(
                    this.correlations.get(
                        correlationId
                    ) ||
                    []
                );

            return this.history
                .filter(
                    entry =>
                        ids.has(
                            entry.id
                        )
                )
                .map(
                    clone
                );
        }

        snapshot() {
            return {
                generatedAt:
                    nowISO(),
                status:
                    this.status(),
                recent:
                    this.list({
                        limit:
                            100,
                        newestFirst:
                            true
                    }),
                bookmarked:
                    this.getBookmarked(),
                performance:
                    typeof performance !==
                        "undefined"
                        ? {
                            now:
                                performance.now(),
                            timeOrigin:
                                performance.timeOrigin ||
                                null,
                            memory:
                                safeSerialize(
                                    performance.memory ||
                                    null,
                                    new WeakMap(),
                                    0,
                                    "$.performance.memory"
                                )
                        }
                        : null
            };
        }

        group(label = "group") {
            const normalized =
                String(label || "group");

            const entry =
                this.output(
                    "system",
                    [`▼ ${normalized}`],
                    {
                        groupAction: "open"
                    }
                );

            this.groups.push(normalized);

            return entry;
        }

        groupCollapsed(label = "group") {
            const normalized =
                String(label || "group");

            const entry =
                this.output(
                    "system",
                    [`▶ ${normalized}`],
                    {
                        groupAction:
                            "open-collapsed",
                        collapsed: true
                    }
                );

            this.groups.push(normalized);

            return entry;
        }

        groupEnd() {
            const label =
                this.groups.pop();

            if (!label) {
                return this.warn(
                    "No console group is open."
                );
            }

            return this.output(
                "system",
                [`▲ ${label}`],
                {
                    groupAction: "close"
                }
            );
        }

        assert(condition, ...values) {
            if (condition) {
                return true;
            }

            this.error(
                "Assertion failed:",
                ...(
                    values.length
                        ? values
                        : ["No message supplied."]
                )
            );

            return false;
        }

        count(label = "default") {
            const key =
                String(label || "default");

            const value =
                (this.counters.get(key) || 0) +
                1;

            this.counters.set(
                key,
                value
            );

            this.metrics.counters +=
                1;

            this.info(
                `${key}: ${value}`
            );

            return value;
        }

        countReset(label = "default") {
            const key =
                String(label || "default");

            const existed =
                this.counters.delete(key);

            this.info(
                `${key}: 0`
            );

            return existed;
        }

        time(label = "default") {
            const key =
                String(label || "default");

            this.timers.set(
                key,
                performance.now()
            );

            this.metrics.timers +=
                1;

            return key;
        }

        timeLog(label = "default", ...values) {
            const key =
                String(label || "default");

            if (!this.timers.has(key)) {
                this.warn(
                    `Timer "${key}" does not exist.`
                );

                return null;
            }

            const elapsed =
                performance.now() -
                this.timers.get(key);

            this.info(
                `${key}: ${elapsed.toFixed(3)}ms`,
                ...values
            );

            return elapsed;
        }

        timeEnd(label = "default") {
            const key =
                String(label || "default");

            if (!this.timers.has(key)) {
                this.warn(
                    `Timer "${key}" does not exist.`
                );

                return null;
            }

            const elapsed =
                performance.now() -
                this.timers.get(key);

            this.timers.delete(key);

            this.info(
                `${key}: ${elapsed.toFixed(3)}ms`
            );

            return elapsed;
        }

        clear(options = {}) {
            const outputCleared =
                options.output !== false;

            this.history.length = 0;
            this.groups.length = 0;
            this.timers.clear();
            this.counters.clear();
            this.bookmarks.clear();
            this.correlations.clear();
            this.suppression.clear();
            this.throttle.clear();

            if (
                outputCleared &&
                typeof this.context.clear ===
                "function"
            ) {
                this.context.clear();
            }

            const detail = {
                outputCleared
            };

            this.emit(
                "clear",
                detail
            );

            this.syncState();

            return detail;
        }

        setLevel(level) {
            const normalized =
                normalizeLevel(level);

            if (!LEVELS.includes(normalized)) {
                throw new Error(
                    `Unknown console level: ${level}`
                );
            }

            this.options.minimumLevel =
                normalized;

            return normalized;
        }

        setMirror(enabled) {
            this.options.mirror =
                parseBoolean(
                    enabled,
                    Boolean(enabled)
                );

            return this.options.mirror;
        }

        setHistoryLimit(limit) {
            const normalized =
                clampInteger(
                    limit,
                    this.options.historyLimit,
                    MIN_HISTORY_LIMIT,
                    MAX_HISTORY_LIMIT
                );

            this.options.historyLimit =
                normalized;

            if (
                this.history.length >
                normalized
            ) {
                this.history.splice(
                    0,
                    this.history.length -
                    normalized
                );
            }

            return normalized;
        }

        enable() {
            this.enabled = true;
            return this.enabled;
        }

        disable() {
            this.enabled = false;
            return this.enabled;
        }

        status() {
            return {
                version: VERSION,
                enabled: this.enabled,
                destroyed: this.destroyed,
                minimumLevel:
                    this.options.minimumLevel,
                mirror:
                    this.options.mirror,
                captureFiltered:
                    this.options.captureFiltered,
                history:
                    this.history.length,
                historyLimit:
                    this.options.historyLimit,
                groups:
                    [...this.groups],
                timers:
                    [...this.timers.keys()],
                counters:
                    Object.fromEntries(
                        this.counters
                    ),
                levels:
                    [
                        ...LEVELS
                    ],
                channels:
                    Object.fromEntries(
                        this.channels
                    ),
                bookmarks:
                    this.bookmarks.size,
                correlations:
                    this.correlations.size,
                filters: {
                    channels:
                        [
                            ...this.filters.channels
                        ],
                    tags:
                        [
                            ...this.filters.tags
                        ],
                    modules:
                        [
                            ...this.filters.modules
                        ],
                    regex:
                        this.filters.regex?.
                            source ||
                        null
                },
                metrics: {
                    ...this.metrics
                },
                capture: {
                    globalErrors:
                        this.options.captureGlobalErrors,
                    unhandledRejections:
                        this.options.captureRejections
                }
            };
        }

        list(options = {}) {
            const level =
                options.level
                    ? normalizeLevel(
                        options.level
                    )
                    : null;

            const contains =
                String(
                    options.contains || ""
                )
                    .trim()
                    .toLowerCase();

            const limit =
                clampInteger(
                    options.limit,
                    DEFAULT_LIST_LIMIT,
                    1,
                    this.options.historyLimit
                );

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

            const channel =
                options.channel
                    ? normalizeChannel(
                        options.channel
                    )
                    : null;

            const module =
                options.module
                    ? String(
                        options.module
                    )
                    : null;

            const tags =
                normalizeTags(
                    options.tags
                );

            const bookmarked =
                options.bookmarked ===
                true;

            let regex =
                null;

            if (
                options.regex
            ) {
                regex =
                    options.regex instanceof
                        RegExp
                        ? options.regex
                        : new RegExp(
                            String(
                                options.regex
                            ),
                            options.regexFlags ||
                            "i"
                        );
            }

            const entries =
                this.history.filter(entry => {
                    const timestamp =
                        Date.parse(
                            entry.timestamp
                        );

                    return (
                        (!level ||
                            entry.level === level) &&
                        (!contains ||
                            entry.message
                                .toLowerCase()
                                .includes(contains)) &&
                        (!Number.isFinite(since) ||
                            timestamp >= since) &&
                        (!Number.isFinite(until) ||
                            timestamp <= until) &&
                        (!channel ||
                            entry.channel ===
                            channel) &&
                        (!module ||
                            entry.module ===
                            module) &&
                        (!tags.length ||
                            tags.every(
                                tag =>
                                    entry.tags.includes(
                                        tag
                                    )
                            )) &&
                        (!bookmarked ||
                            this.bookmarks.has(
                                entry.id
                            )) &&
                        (!regex ||
                            (
                                regex.lastIndex = 0,
                                regex.test(
                                    entry.message
                                )
                            ))
                    );
                });

            const sliced =
                entries.slice(-limit);

            return options.newestFirst
                ? [...sliced].reverse()
                : sliced;
        }

        export(
            options =
                {}
        ) {
            const payload = {
                version:
                    VERSION,
                generatedAt:
                    nowISO(),
                status:
                    this.status(),
                history:
                    this.history.map(
                        entry => ({
                            ...clone(
                                entry
                            ),
                            bookmarked:
                                this.bookmarks.has(
                                    entry.id
                                )
                        })
                    )
            };

            this.metrics.exports +=
                1;

            if (
                options.format
            ) {
                return this.serialize(
                    options.format,
                    options
                );
            }

            return payload;
        }

        serialize(
            format =
                "json",
            options =
                {}
        ) {
            const normalized =
                String(
                    format ||
                    "json"
                ).toLowerCase();

            const entries =
                options.filtered ===
                    true
                    ? this.list({
                        ...options,
                        limit:
                            options.limit ||
                            this.options.historyLimit
                    })
                    : this.history;

            if (
                normalized ===
                    "jsonl" ||
                normalized ===
                    "ndjson"
            ) {
                return entries.map(
                    entry =>
                        JSON.stringify(
                            clone(
                                entry
                            )
                        )
                ).join(
                    "\n"
                );
            }

            if (
                normalized ===
                    "csv"
            ) {
                const headers = [
                    "timestamp",
                    "level",
                    "channel",
                    "module",
                    "tags",
                    "correlationId",
                    "message"
                ];

                return [
                    headers.map(
                        sanitizeCSVCell
                    ).join(
                        ","
                    ),
                    ...entries.map(
                        entry =>
                            headers.map(
                                key =>
                                    sanitizeCSVCell(
                                        key ===
                                            "tags"
                                            ? entry.tags.join(
                                                " "
                                            )
                                            : entry[
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
                normalized ===
                    "markdown" ||
                normalized ===
                    "md"
            ) {
                return [
                    "# SpeciedexTerminal Console Export",
                    "",
                    `Generated: ${nowISO()}`,
                    "",
                    "| Timestamp | Level | Channel | Module | Message |",
                    "|---|---|---|---|---|",
                    ...entries.map(
                        entry =>
                            `| ${entry.timestamp} | ${entry.level} | ${entry.channel} | ${entry.module} | ${entry.message.replace(/\|/g, "\\|")} |`
                    )
                ].join(
                    "\n"
                );
            }

            return JSON.stringify(
                {
                    version:
                        VERSION,
                    generatedAt:
                        nowISO(),
                    status:
                        this.status(),
                    history:
                        entries.map(
                            clone
                        )
                },
                null,
                options.compact ===
                    true
                    ? 0
                    : 2
            );
        }

        import(
            payload,
            options =
                {}
        ) {
            this.assertAvailable();

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

            const entries =
                Array.isArray(
                    source
                )
                    ? source
                    : Array.isArray(
                        source?.history
                    )
                        ? source.history
                        : [];

            if (
                entries.length >
                this.options.maxImportEntries
            ) {
                throw new RangeError(
                    `Console import contains ${entries.length} entries; maximum is ${this.options.maxImportEntries}.`
                );
            }

            if (
                options.replace ===
                    true
            ) {
                this.clear({
                    output:
                        false
                });
            }

            let imported =
                0;

            for (
                const raw of
                entries
            ) {
                if (
                    !raw ||
                    typeof raw !==
                        "object"
                ) {
                    continue;
                }

                const entry = {
                    id:
                        String(
                            raw.id ||
                            createId()
                        ),
                    timestamp:
                        safeDateISO(
                            raw.timestamp
                        ) ||
                        nowISO(),
                    level:
                        LEVELS.includes(
                            normalizeLevel(
                                raw.level
                            )
                        )
                            ? normalizeLevel(
                                raw.level
                            )
                            : "info",
                    channel:
                        normalizeChannel(
                            raw.channel
                        ),
                    module:
                        String(
                            raw.module ||
                            raw.channel ||
                            DEFAULT_CHANNEL
                        ),
                    tags:
                        normalizeTags(
                            raw.tags
                        ),
                    correlationId:
                        raw.correlationId ||
                        null,
                    commandId:
                        raw.commandId ||
                        null,
                    transactionId:
                        raw.transactionId ||
                        null,
                    group:
                        Array.isArray(
                            raw.group
                        )
                            ? raw.group.map(
                                String
                            )
                            : [],
                    message:
                        String(
                            raw.message ||
                            ""
                        ),
                    values:
                        safeSerialize(
                            raw.values ||
                            [],
                            new WeakMap(),
                            0,
                            "$.values"
                        ),
                    metadata:
                        safeSerialize(
                            raw.metadata ||
                            {},
                            new WeakMap(),
                            0,
                            "$.metadata"
                        )
                };

                this.history.push(
                    entry
                );

                if (
                    raw.bookmarked ===
                    true
                ) {
                    this.bookmarks.add(
                        entry.id
                    );
                }

                imported +=
                    1;
            }

            this.history =
                this.history.slice(
                    -this.options.historyLimit
                );

            this.metrics.imports +=
                imported;

            this.emit(
                "import",
                {
                    imported
                }
            );

            this.syncState();

            return imported;
        }


        destroy() {
            if (
                this.destroyed
            ) {
                return false;
            }

            this.emit(
                "destroy",
                {
                    timestamp:
                        nowISO(),
                    version:
                        VERSION
                }
            );

            try {
                this.abortController.abort();
            } catch (_error) {
                /* Abort cleanup is optional. */
            }

            this.captureInstalled =
                false;

            this.clear({
                output:
                    false
            });

            this.enabled =
                false;

            this.ready =
                false;

            this.watchers.clear();

            if (
                this.context.root?.[
                    CONSOLE_SYMBOL
                ] ===
                    this
            ) {
                delete this.context.root[
                    CONSOLE_SYMBOL
                ];
            }

            this.destroyed =
                true;

            return true;
        }

    }

    function initialize(
        context = {}
    ) {
        const safeContext =
            context &&
            typeof context === "object"
                ? context
                : {};

        const root =
            isElement(safeContext.root)
                ? safeContext.root
                : document.documentElement;

        const existing =
            safeContext.console instanceof
                ConsoleBridge
                ? safeContext.console
                : safeContext.services?.get?.(
                    "console"
                ) ||
                root?.[CONSOLE_SYMBOL];

        if (
            existing instanceof ConsoleBridge &&
            !existing.destroyed
        ) {
            safeContext.console =
                existing;

            safeContext.registerService?.(
                "console",
                existing
            );

            return existing;
        }

        const dataset =
            root.dataset || {};

        const config =
            safeContext.config?.console ||
            {};

        const bridge =
            new ConsoleBridge(
                {
                    ...safeContext,
                    root
                },
                {
                    historyLimit:
                        dataset.terminalConsoleHistoryLimit ||
                        config.historyLimit,
                    mirror:
                        parseBoolean(
                            dataset.terminalConsoleMirror,
                            config.mirror !== false
                        ),
                    minimumLevel:
                        dataset.terminalConsoleLevel ||
                        config.minimumLevel ||
                        "trace",
                    captureFiltered:
                        parseBoolean(
                            dataset.terminalConsoleCaptureFiltered,
                            config.captureFiltered !== false
                        ),
                    defaultChannel:
                        dataset.terminalConsoleChannel ||
                        config.defaultChannel ||
                        DEFAULT_CHANNEL,
                    captureGlobalErrors:
                        parseBoolean(
                            dataset.terminalConsoleCaptureGlobalErrors,
                            config.captureGlobalErrors !== false
                        ),
                    captureRejections:
                        parseBoolean(
                            dataset.terminalConsoleCaptureRejections,
                            config.captureRejections !== false
                        ),
                    duplicateWindow:
                        dataset.terminalConsoleDuplicateWindow ||
                        config.duplicateWindow,
                    duplicateLimit:
                        dataset.terminalConsoleDuplicateLimit ||
                        config.duplicateLimit,
                    throttleWindow:
                        dataset.terminalConsoleThrottleWindow ||
                        config.throttleWindow,
                    throttleLimit:
                        dataset.terminalConsoleThrottleLimit ||
                        config.throttleLimit,
                    maxChannels:
                        dataset.terminalConsoleMaxChannels ||
                        config.maxChannels,
                    maxImportEntries:
                        dataset.terminalConsoleMaxImportEntries ||
                        config.maxImportEntries,
                    maxExportBytes:
                        dataset.terminalConsoleMaxExportBytes ||
                        config.maxExportBytes,
                    maxEmitDepth:
                        dataset.terminalConsoleMaxEmitDepth ||
                        config.maxEmitDepth
                }
            );

        root[CONSOLE_SYMBOL] =
            bridge;

        safeContext.console =
            bridge;

        safeContext.registerService?.(
            "console",
            bridge
        );

        dispatch(
            document,
            "speciedex:terminal-console-ready",
            {
                context:
                    safeContext,
                console:
                    bridge,
                version:
                    VERSION
            }
        );

        return bridge;
    }

    function resolveCommandContext(payload = {}) {
        return (
            payload.context ||
            payload.terminal?.context ||
            payload.app?.context ||
            payload
        );
    }

    function requireBridge(context) {
        const safeContext =
            context &&
            typeof context === "object"
                ? context
                : {};

        const bridge =
            safeContext.console instanceof
                ConsoleBridge
                ? safeContext.console
                : safeContext.services?.get?.(
                    "console"
                ) ||
                initialize(safeContext);

        if (
            !(bridge instanceof ConsoleBridge) ||
            bridge.destroyed
        ) {
            throw new Error(
                "Terminal console service is unavailable."
            );
        }

        return bridge;
    }

    function writeResult(write, message, type = "info") {
        if (typeof write === "function") {
            return write(
                message,
                type
            );
        }

        return message;
    }

    function writeJSONResult(
        writeJSON,
        value,
        write = null,
        writeLine = null
    ) {
        if (typeof writeJSON === "function") {
            return writeJSON(value);
        }

        const serialized =
            typeof value === "string"
                ? value
                : JSON.stringify(
                    clone(value),
                    null,
                    2
                );

        if (typeof write === "function") {
            return write(
                serialized,
                "data"
            );
        }

        if (typeof writeLine === "function") {
            return writeLine(
                serialized
            );
        }

        return value;
    }

    const commands = [
        {
            name: "console",
            aliases: ["console-status"],
            category: "system",
            description:
                "Inspect or configure the terminal console bridge.",
            usage:
                "console [status|level <name>|mirror <on|off>|limit <count>|enable|disable|clear|snapshot]",
            handler: payload => {
                const context =
                    resolveCommandContext(payload);

                const args =
                    Array.isArray(payload.args)
                        ? payload.args
                        : [];

                const writeJSON =
                    payload.writeJSON;

                const write =
                    payload.write;
                const bridge =
                    requireBridge(context);

                const action =
                    String(args[0] || "status")
                        .toLowerCase();

                if (action === "clear") {
                    bridge.clear();

                    return writeResult(
                        write,
                        "Console history and output cleared.",
                        "success"
                    );
                }

                if (action === "level") {
                    if (!args[1]) {
                        throw new Error(
                            "A console level is required."
                        );
                    }

                    const level =
                        bridge.setLevel(
                            args[1]
                        );

                    return writeResult(
                        write,
                        `Console level: ${level}`,
                        "success"
                    );
                }

                if (action === "mirror") {
                    if (!args[1]) {
                        return writeResult(
                            write,
                            `Browser console mirroring: ${bridge.options.mirror ? "on" : "off"}`,
                            "info"
                        );
                    }

                    const enabled =
                        parseBoolean(
                            args[1],
                            null
                        );

                    if (enabled === null) {
                        throw new Error(
                            "Use `console mirror on` or `console mirror off`."
                        );
                    }

                    bridge.setMirror(enabled);

                    return writeResult(
                        write,
                        `Browser console mirroring: ${enabled ? "on" : "off"}`,
                        "success"
                    );
                }

                if (action === "limit") {
                    if (!args[1]) {
                        return writeResult(
                            write,
                            `Console history limit: ${bridge.options.historyLimit}`,
                            "info"
                        );
                    }

                    const limit =
                        bridge.setHistoryLimit(
                            args[1]
                        );

                    return writeResult(
                        write,
                        `Console history limit: ${limit}`,
                        "success"
                    );
                }

                if (
                    action ===
                    "snapshot"
                ) {
                    return writeJSONResult(
                        writeJSON,
                        bridge.snapshot()
                    );
                }

                if (action === "enable") {
                    bridge.enable();

                    return writeResult(
                        write,
                        "Console bridge enabled.",
                        "success"
                    );
                }

                if (action === "disable") {
                    bridge.disable();

                    return writeResult(
                        write,
                        "Console bridge disabled.",
                        "success"
                    );
                }

                if (action !== "status") {
                    throw new Error(
                        `Unknown console action: ${action}`
                    );
                }

                return writeJSONResult(
                    writeJSON,
                    bridge.status()
                );
            }
        },
        {
            name: "console-history",
            aliases: ["clog"],
            category: "system",
            description:
                "Display buffered terminal console entries.",
            usage:
                "console-history [level] [limit] [contains] [--channel=NAME] [--module=NAME] [--tag=TAG] [--regex=PATTERN] [--bookmarked]",
            handler: payload => {
                const context =
                    resolveCommandContext(payload);

                const args =
                    Array.isArray(payload.args)
                        ? payload.args
                        : [];

                const writeJSON =
                    payload.writeJSON;
                const bridge =
                    requireBridge(context);

                const plain =
                    args.filter(
                        argument =>
                            !argument.startsWith(
                                "--"
                            )
                    );

                const option =
                    prefix =>
                        args.find(
                            argument =>
                                argument.startsWith(
                                    prefix
                                )
                        )?.
                        slice(
                            prefix.length
                        ) ||
                        null;

                return writeJSONResult(
                    writeJSON,
                    bridge.list({
                        level:
                            plain[0] ||
                            null,
                        limit:
                            plain[1] ||
                            DEFAULT_LIST_LIMIT,
                        contains:
                            plain
                                .slice(
                                    2
                                )
                                .join(
                                    " "
                                ),
                        channel:
                            option(
                                "--channel="
                            ),
                        module:
                            option(
                                "--module="
                            ),
                        tags:
                            option(
                                "--tag="
                            ),
                        regex:
                            option(
                                "--regex="
                            ),
                        bookmarked:
                            args.includes(
                                "--bookmarked"
                            ),
                        newestFirst:
                            false
                    })
                );
            }
        },
        {
            name: "console-clear-history",
            aliases: ["console-history-clear"],
            category: "system",
            description:
                "Clear buffered console history without clearing terminal output.",
            usage:
                "console-clear-history",
            handler: payload => {
                const context =
                    resolveCommandContext(payload);

                const write =
                    payload.write;
                const bridge =
                    requireBridge(context);

                bridge.clear({
                    output: false
                });

                return writeResult(
                    write,
                    "Console history cleared.",
                    "success"
                );
            }
        },
        {
            name:
                "console-export",

            aliases: [
                "console-save"
            ],

            category:
                "system",

            description:
                "Export console history as JSON, JSONL, CSV, or Markdown.",

            usage:
                "console-export [filename] [json|jsonl|csv|markdown] [--filtered]",

            handler: payload => {
                const context =
                    resolveCommandContext(payload);

                const args =
                    Array.isArray(payload.args)
                        ? payload.args
                        : [];

                const write =
                    payload.write;
                const bridge =
                    requireBridge(
                        context
                    );

                const format =
                    String(
                        args[1] ||
                        "json"
                    ).toLowerCase();

                const extension = {
                    json:
                        "json",
                    jsonl:
                        "jsonl",
                    ndjson:
                        "jsonl",
                    csv:
                        "csv",
                    markdown:
                        "md",
                    md:
                        "md"
                }[
                    format
                ] ||
                "json";

                const filename =
                    String(
                        args[0] ||
                        `speciedex-terminal-console.${extension}`
                    )
                        .replace(
                            /[<>:"/\\|?*\u0000-\u001f]/g,
                            "-"
                        );

                const data =
                    bridge.serialize(
                        format,
                        {
                            filtered:
                                args.includes(
                                    "--filtered"
                                )
                        }
                    );

                const mimeType = {
                    json:
                        "application/json;charset=utf-8",
                    jsonl:
                        "application/x-ndjson;charset=utf-8",
                    ndjson:
                        "application/x-ndjson;charset=utf-8",
                    csv:
                        "text/csv;charset=utf-8",
                    markdown:
                        "text/markdown;charset=utf-8",
                    md:
                        "text/markdown;charset=utf-8"
                }[
                    format
                ] ||
                "application/json;charset=utf-8";

                if (
                    context.exporter &&
                    typeof context.exporter.text ===
                    "function"
                ) {
                    context.exporter.text(
                        data,
                        filename,
                        mimeType,
                        {
                            format
                        }
                    );
                } else {
                    downloadText(
                        data,
                        filename,
                        mimeType,
                        {
                            maxBytes:
                                bridge.options.maxExportBytes
                        }
                    );
                }

                bridge.metrics.exports +=
                    1;

                return writeResult(
                    write,
                    `Console history exported to ${filename}.`,
                    "success"
                );
            }
        },
        {
            name:
                "console-import",

            category:
                "system",

            description:
                "Import console history from JSON.",

            usage:
                "console-import <json> [--replace]",

            handler: payload => {
                const context =
                    resolveCommandContext(payload);

                const args =
                    Array.isArray(payload.args)
                        ? payload.args
                        : [];

                const writeJSON =
                    payload.writeJSON;
                if (
                    !args.length
                ) {
                    throw new Error(
                        "Console import JSON is required."
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

                const bridge =
                    requireBridge(
                        context
                    );

                return writeJSONResult(
                    writeJSON,
                    {
                        imported:
                            bridge.import(
                                importPayload,
                                {
                                    replace
                                }
                            ),
                        status:
                            bridge.status()
                    }
                );
            }
        },

        {
            name:
                "console-bookmark",

            category:
                "system",

            description:
                "Bookmark a console entry.",

            usage:
                "console-bookmark <entry-id>",

            handler: payload => {
                const context =
                    resolveCommandContext(payload);

                const args =
                    Array.isArray(payload.args)
                        ? payload.args
                        : [];

                const writeJSON =
                    payload.writeJSON;
                const bridge =
                    requireBridge(
                        context
                    );

                if (!args[0]) {
                    throw new Error(
                        "A console entry identifier is required."
                    );
                }

                return writeJSONResult(
                    writeJSON,
                    {
                        bookmarked:
                            bridge.bookmark(
                                args[0]
                            ),
                        entry:
                            bridge.history.find(
                                entry =>
                                    entry.id ===
                                    args[0]
                            ) ||
                            null
                    }
                );
            }
        },

        {
            name:
                "console-snapshot",

            category:
                "system",

            description:
                "Create a complete console diagnostics snapshot.",

            usage:
                "console-snapshot",

            handler: payload => {
                const context =
                    resolveCommandContext(payload);

                return writeJSONResult(
                    payload.writeJSON,
                    requireBridge(
                        context
                    ).snapshot(),
                    payload.write,
                    payload.writeLine
                );
            }
        },

        {
            name: "console-test",
            category: "system",
            description:
                "Write one message at every console level.",
            usage:
                "console-test",
            handler: payload => {
                const context =
                    resolveCommandContext(payload);

                const write =
                    payload.write;
                const bridge =
                    requireBridge(context);

                bridge.trace(
                    "Trace message"
                );

                bridge.debug(
                    "Debug message"
                );

                bridge.info(
                    "Information message"
                );

                bridge.success(
                    "Success message"
                );

                bridge.warn(
                    "Warning message"
                );

                bridge.error(
                    "Error message"
                );

                bridge.system(
                    "System message"
                );

                return writeResult(
                    write,
                    "Console test complete.",
                    "success"
                );
            }
        }
    ];

    const api = Object.freeze({
        name:
            MODULE_NAME,
        version:
            VERSION,
        CONSOLE_SYMBOL,
        ConsoleBridge,
        LEVELS,
        normalizeLevel,
        parseBoolean,
        clampInteger,
        safeSerialize,
        clone,
        normalizeChannel,
        normalizeTags,
        sanitizeCSVCell,
        byteLength,
        formatValue,
        formatValues,
        sanitizeFilename,
        dispatch,
        resolveCommandContext,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalConsole = api;

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
