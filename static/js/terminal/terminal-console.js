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
    const VERSION = "3.0.0";

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

    function nowISO() {
        return new Date().toISOString();
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

    function safeSerialize(value, seen = new WeakSet()) {
        if (
            value === null ||
            value === undefined
        ) {
            return value;
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

        if (seen.has(value)) {
            return "[Circular]";
        }

        seen.add(value);

        try {
            if (value instanceof Error) {
                const output = {
                    name: value.name || "Error",
                    message: value.message || "",
                    stack: value.stack || null
                };

                if ("cause" in value) {
                    output.cause =
                        safeSerialize(value.cause, seen);
                }

                for (const [key, item] of Object.entries(value)) {
                    if (!(key in output)) {
                        output[key] =
                            safeSerialize(item, seen);
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
                        safeSerialize(key, seen),
                        safeSerialize(item, seen)
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
                        safeSerialize(item, seen)
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
                        .map(item =>
                            safeSerialize(item, seen)
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
                    output[key] =
                        safeSerialize(item, seen);
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
            typeof target.dispatchEvent !== "function"
        ) {
            return false;
        }

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

    function downloadText(text, filename, mimeType) {
        const blob =
            new Blob(
                [text],
                {
                    type:
                        mimeType ||
                        "text/plain;charset=utf-8"
                }
            );

        const url =
            URL.createObjectURL(blob);

        const anchor =
            document.createElement("a");

        anchor.href = url;
        anchor.download = filename;
        anchor.hidden = true;

        document.body?.appendChild(anchor);
        anchor.click();
        anchor.remove();

        window.setTimeout(
            () => URL.revokeObjectURL(url),
            1000
        );
    }

    class ConsoleBridge extends EventTarget {
        constructor(context, options = {}) {
            super();

            if (!context || typeof context !== "object") {
                throw new TypeError(
                    "A terminal context is required."
                );
            }

            this.context = context;

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

            this.history = [];
            this.groups = [];
            this.timers = new Map();
            this.counters = new Map();
            this.enabled = true;
            this.destroyed = false;
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

        createEntry(level, values, metadata = {}) {
            const entry = {
                id: createId(),
                timestamp: nowISO(),
                level:
                    normalizeLevel(level),
                group:
                    [...this.groups],
                message:
                    formatValues(values),
                values:
                    values.map(value =>
                        safeSerialize(
                            value,
                            new WeakSet()
                        )
                    ),
                metadata:
                    safeSerialize(
                        metadata,
                        new WeakSet()
                    )
            };

            this.history.push(entry);

            if (
                this.history.length >
                this.options.historyLimit
            ) {
                this.history.splice(
                    0,
                    this.history.length -
                    this.options.historyLimit
                );
            }

            return entry;
        }

        emitEntry(entry) {
            dispatch(
                this,
                "entry",
                entry
            );

            try {
                this.context.events?.emit?.(
                    "console:entry",
                    entry
                );
            } catch (_error) {
                /*
                ----------------------------------------------------------------
                Console output must never fail because an observer failed.
                ----------------------------------------------------------------
                */
            }

            dispatch(
                document,
                "speciedex:terminal-console-entry",
                entry
            );

            dispatch(
                this.context.root,
                "speciedex:terminal-console-entry",
                entry,
                {
                    bubbles: true
                }
            );
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

        output(level, values, metadata = {}) {
            if (this.destroyed) {
                throw new Error(
                    "Console bridge has been destroyed."
                );
            }

            const normalizedLevel =
                normalizeLevel(level);

            if (!LEVELS.includes(normalizedLevel)) {
                throw new Error(
                    `Unknown console level: ${level}`
                );
            }

            const normalizedValues =
                Array.isArray(values)
                    ? values
                    : [values];

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
                        id: null,
                        timestamp: nowISO(),
                        level: normalizedLevel,
                        group:
                            [...this.groups],
                        message:
                            formatValues(
                                normalizedValues
                            ),
                        values:
                            normalizedValues.map(value =>
                                safeSerialize(
                                    value,
                                    new WeakSet()
                                )
                            ),
                        metadata:
                            safeSerialize(
                                metadata,
                                new WeakSet()
                            )
                    };

            this.mirror(
                normalizedLevel,
                normalizedValues
            );

            if (shouldWrite) {
                this.writeTerminal(entry);
            }

            this.emitEntry(entry);

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
                    new WeakSet()
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

            dispatch(
                this,
                "clear",
                detail
            );

            try {
                this.context.events?.emit?.(
                    "console:clear",
                    detail
                );
            } catch (_error) {
                /*
                ----------------------------------------------------------------
                Ignore observer failures.
                ----------------------------------------------------------------
                */
            }

            dispatch(
                document,
                "speciedex:terminal-console-clear",
                detail
            );

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
                    [...LEVELS]
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
                            timestamp <= until)
                    );
                });

            const sliced =
                entries.slice(-limit);

            return options.newestFirst
                ? [...sliced].reverse()
                : sliced;
        }

        export() {
            return {
                version: VERSION,
                generatedAt: nowISO(),
                status: this.status(),
                history:
                    this.history.map(entry => ({
                        ...entry,
                        group:
                            [...entry.group]
                    }))
            };
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            this.clear({
                output: false
            });

            this.enabled = false;
            this.destroyed = true;

            dispatch(
                this,
                "destroy",
                {
                    timestamp: nowISO()
                }
            );

            return true;
        }
    }

    function initialize(context) {
        if (
            context.console instanceof
            ConsoleBridge &&
            !context.console.destroyed
        ) {
            return context.console;
        }

        const dataset =
            context.root?.dataset || {};

        const bridge =
            new ConsoleBridge(
                context,
                {
                    historyLimit:
                        dataset.
                            terminalConsoleHistoryLimit,
                    mirror:
                        parseBoolean(
                            dataset.
                                terminalConsoleMirror,
                            true
                        ),
                    minimumLevel:
                        dataset.
                            terminalConsoleLevel ||
                        "trace",
                    captureFiltered:
                        parseBoolean(
                            dataset.
                                terminalConsoleCaptureFiltered,
                            true
                        )
                }
            );

        context.console = bridge;

        context.registerService?.(
            "console",
            bridge
        );

        dispatch(
            document,
            "speciedex:terminal-console-ready",
            {
                context,
                console: bridge
            }
        );

        return bridge;
    }

    function requireBridge(context) {
        if (
            !(context?.console instanceof ConsoleBridge)
        ) {
            throw new Error(
                "Terminal console service is unavailable."
            );
        }

        return context.console;
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

    function writeJSONResult(writeJSON, value) {
        if (typeof writeJSON === "function") {
            return writeJSON(value);
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
                "console [status|level <name>|mirror <on|off>|limit <count>|enable|disable|clear]",
            handler: ({
                args = [],
                context,
                writeJSON,
                write
            }) => {
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
                "console-history [level] [limit] [contains]",
            handler: ({
                args = [],
                context,
                writeJSON
            }) => {
                const bridge =
                    requireBridge(context);

                return writeJSONResult(
                    writeJSON,
                    bridge.list({
                        level:
                            args[0] || null,
                        limit:
                            args[1] ||
                            DEFAULT_LIST_LIMIT,
                        contains:
                            args
                                .slice(2)
                                .join(" "),
                        newestFirst: false
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
            handler: ({
                context,
                write
            }) => {
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
            name: "console-export",
            aliases: ["console-save"],
            category: "system",
            description:
                "Export console history as JSON.",
            usage:
                "console-export [filename]",
            handler: ({
                args = [],
                context,
                write
            }) => {
                const bridge =
                    requireBridge(context);

                const filename =
                    sanitizeFilename(
                        args[0]
                    );

                const data =
                    JSON.stringify(
                        bridge.export(),
                        null,
                        2
                    );

                if (
                    context.exporter &&
                    typeof context.exporter.text ===
                    "function"
                ) {
                    context.exporter.text(
                        data,
                        filename,
                        "application/json"
                    );
                } else {
                    downloadText(
                        data,
                        filename,
                        "application/json;charset=utf-8"
                    );
                }

                return writeResult(
                    write,
                    `Console history exported to ${filename}.`,
                    "success"
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
            handler: ({
                context,
                write
            }) => {
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
        name: MODULE_NAME,
        version: VERSION,
        ConsoleBridge,
        LEVELS,
        normalizeLevel,
        parseBoolean,
        clampInteger,
        safeSerialize,
        formatValue,
        formatValues,
        sanitizeFilename,
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
