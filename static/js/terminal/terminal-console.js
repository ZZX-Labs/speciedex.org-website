/*
========================================================================
Speciedex.org
Terminal Console Bridge
========================================================================

Structured console service for SpeciedexTerminal.

Provides:

    • info, success, warn, error, debug, trace, and system messages
    • grouped output
    • JSON and table rendering
    • timers and counters
    • assertions
    • buffered console history
    • level filtering
    • browser console mirroring
    • command-based inspection and export
    • safe formatting of arbitrary JavaScript values

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Console";
    const DEFAULT_HISTORY_LIMIT = 1000;

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

    function normalizeLevel(level) {
        const normalized =
            String(level || "info")
                .trim()
                .toLowerCase();

        return LEVEL_ALIASES[normalized] || normalized;
    }

    function isPlainObject(value) {
        return (
            value !== null &&
            typeof value === "object" &&
            (
                Object.getPrototypeOf(value) === Object.prototype ||
                Object.getPrototypeOf(value) === null
            )
        );
    }

    function safeSerialize(value, seen = new WeakSet()) {
        if (value === null || value === undefined) {
            return value;
        }

        if (
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
        ) {
            return value;
        }

        if (typeof value === "bigint") {
            return `${value.toString()}n`;
        }

        if (typeof value === "symbol") {
            return value.toString();
        }

        if (typeof value === "function") {
            return `[Function ${value.name || "anonymous"}]`;
        }

        if (value instanceof Error) {
            return {
                name: value.name,
                message: value.message,
                stack: value.stack || null
            };
        }

        if (value instanceof Date) {
            return value.toISOString();
        }

        if (value instanceof RegExp) {
            return value.toString();
        }

        if (value instanceof Map) {
            return {
                type: "Map",
                entries: [...value.entries()].map(([key, item]) => [
                    safeSerialize(key, seen),
                    safeSerialize(item, seen)
                ])
            };
        }

        if (value instanceof Set) {
            return {
                type: "Set",
                values: [...value.values()].map(item =>
                    safeSerialize(item, seen)
                )
            };
        }

        if (value instanceof Node) {
            return {
                type: value.nodeName,
                id: value.id || null,
                className:
                    typeof value.className === "string"
                        ? value.className
                        : null
            };
        }

        if (typeof value === "object") {
            if (seen.has(value)) {
                return "[Circular]";
            }

            seen.add(value);

            if (Array.isArray(value)) {
                return value.map(item =>
                    safeSerialize(item, seen)
                );
            }

            const output = {};

            for (const [key, item] of Object.entries(value)) {
                try {
                    output[key] = safeSerialize(item, seen);
                } catch (error) {
                    output[key] = `[Unserializable: ${error.message}]`;
                }
            }

            return output;
        }

        return String(value);
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
        } catch (error) {
            return String(value);
        }
    }

    function formatValues(values) {
        return values
            .map(formatValue)
            .join(" ");
    }

    class ConsoleBridge extends EventTarget {
        constructor(context, options = {}) {
            super();

            this.context = context;
            this.options = {
                historyLimit:
                    Number(options.historyLimit) ||
                    DEFAULT_HISTORY_LIMIT,
                mirror:
                    options.mirror !== false,
                minimumLevel:
                    normalizeLevel(
                        options.minimumLevel || "trace"
                    )
            };

            this.history = [];
            this.groups = [];
            this.timers = new Map();
            this.counters = new Map();
            this.enabled = true;
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
                this.levelIndex(level) >=
                this.levelIndex(
                    this.options.minimumLevel
                )
            );
        }

        createEntry(level, values, metadata = {}) {
            const normalizedLevel =
                normalizeLevel(level);

            const entry = {
                id:
                    crypto.randomUUID?.() ||
                    `${Date.now()}-${Math.random()}`,
                timestamp:
                    new Date().toISOString(),
                level:
                    normalizedLevel,
                group:
                    [...this.groups],
                message:
                    formatValues(values),
                values:
                    values.map(value =>
                        safeSerialize(value)
                    ),
                metadata:
                    safeSerialize(metadata)
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
            this.dispatchEvent(
                new CustomEvent(
                    "entry",
                    {
                        detail: entry
                    }
                )
            );

            this.context.events?.emit?.(
                "console:entry",
                entry
            );

            document.dispatchEvent(
                new CustomEvent(
                    "speciedex:terminal-console-entry",
                    {
                        detail: entry
                    }
                )
            );
        }

        mirror(level, values) {
            if (!this.options.mirror) {
                return;
            }

            const method =
                level === "warning"
                    ? "warn"
                    : level === "success" ||
                      level === "system"
                        ? "info"
                        : (
                            typeof window.console?.[level] ===
                            "function"
                                ? level
                                : "log"
                        );

            window.console?.[method]?.(
                ...values
            );
        }

        output(level, values, metadata = {}) {
            const normalizedLevel =
                normalizeLevel(level);

            const entry =
                this.createEntry(
                    normalizedLevel,
                    values,
                    metadata
                );

            this.mirror(
                normalizedLevel,
                values
            );

            if (this.shouldWrite(normalizedLevel)) {
                const prefix =
                    this.groups.length
                        ? `${"  ".repeat(this.groups.length)}`
                        : "";

                this.context.write(
                    `${prefix}${entry.message}`,
                    normalizedLevel === "warning"
                        ? "warning"
                        : normalizedLevel,
                    {
                        preformatted:
                            entry.message.includes("\n")
                    }
                );
            }

            this.emitEntry(entry);

            return entry;
        }

        log(...values) {
            return this.output(
                "info",
                values
            );
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
            const error =
                new Error();

            return this.output(
                "trace",
                [
                    ...values,
                    error.stack || ""
                ]
            );
        }

        system(...values) {
            return this.output(
                "system",
                values
            );
        }

        json(value, label = "") {
            if (label) {
                this.info(label);
            }

            const serialized =
                safeSerialize(value);

            this.context.writeJSON(
                serialized
            );

            return this.createEntry(
                "info",
                [serialized],
                {
                    renderer: "json",
                    label
                }
            );
        }

        table(rows, columns = null, label = "") {
            const data =
                Array.isArray(rows)
                    ? rows
                    : [];

            if (!data.length) {
                return this.info(
                    label || "No table rows."
                );
            }

            const headers =
                columns?.length
                    ? columns
                    : [
                        ...new Set(
                            data.flatMap(row =>
                                isPlainObject(row)
                                    ? Object.keys(row)
                                    : []
                            )
                        )
                    ];

            const values =
                data.map(row =>
                    headers.map(header =>
                        isPlainObject(row)
                            ? row[header]
                            : ""
                    )
                );

            if (label) {
                this.info(label);
            }

            this.context.writeTable(
                headers,
                values
            );

            return this.createEntry(
                "info",
                [data],
                {
                    renderer: "table",
                    headers,
                    label
                }
            );
        }

        group(label = "group") {
            this.groups.push(
                String(label)
            );

            return this.output(
                "system",
                [`▼ ${label}`],
                {
                    groupAction: "open"
                }
            );
        }

        groupCollapsed(label = "group") {
            this.groups.push(
                String(label)
            );

            return this.output(
                "system",
                [`▶ ${label}`],
                {
                    groupAction: "open-collapsed"
                }
            );
        }

        groupEnd() {
            const label =
                this.groups.pop() ||
                "group";

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
                String(label);

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
                String(label);

            this.counters.set(
                key,
                0
            );

            this.info(
                `${key}: 0`
            );

            return 0;
        }

        time(label = "default") {
            const key =
                String(label);

            this.timers.set(
                key,
                performance.now()
            );

            return key;
        }

        timeLog(label = "default", ...values) {
            const key =
                String(label);

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
                String(label);

            const elapsed =
                this.timeLog(key);

            this.timers.delete(key);

            return elapsed;
        }

        clear() {
            this.history = [];
            this.groups = [];
            this.timers.clear();
            this.counters.clear();
            this.context.clear();

            this.dispatchEvent(
                new CustomEvent("clear")
            );
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
                Boolean(enabled);

            return this.options.mirror;
        }

        enable() {
            this.enabled = true;
        }

        disable() {
            this.enabled = false;
        }

        list(options = {}) {
            const level =
                options.level
                    ? normalizeLevel(options.level)
                    : null;

            const contains =
                String(options.contains || "")
                    .toLowerCase();

            const limit =
                Math.max(
                    1,
                    Math.min(
                        this.options.historyLimit,
                        Number(options.limit) || 100
                    )
                );

            return this.history
                .filter(entry =>
                    (!level || entry.level === level) &&
                    (
                        !contains ||
                        entry.message
                            .toLowerCase()
                            .includes(contains)
                    )
                )
                .slice(-limit);
        }

        export() {
            return {
                generatedAt:
                    new Date().toISOString(),
                minimumLevel:
                    this.options.minimumLevel,
                mirror:
                    this.options.mirror,
                enabled:
                    this.enabled,
                history:
                    [...this.history]
            };
        }

        destroy() {
            this.clear();
            this.enabled = false;
        }
    }

    function initialize(context) {
        const bridge =
            new ConsoleBridge(
                context,
                {
                    historyLimit:
                        context.root?.
                            dataset.
                            terminalConsoleHistoryLimit,
                    mirror:
                        context.root?.
                            dataset.
                            terminalConsoleMirror !== "false",
                    minimumLevel:
                        context.root?.
                            dataset.
                            terminalConsoleLevel || "trace"
                }
            );

        context.console =
            bridge;

        context.registerService?.(
            "console",
            bridge
        );

        return bridge;
    }

    const commands = [
        {
            name: "console",
            category: "system",
            description:
                "Inspect or configure the terminal console bridge.",
            usage:
                "console [status|level <name>|mirror <on|off>|clear]",
            handler: ({
                args,
                context,
                writeJSON,
                write
            }) => {
                const consoleBridge =
                    context.console;

                const action =
                    args[0] || "status";

                if (action === "clear") {
                    consoleBridge.clear();

                    return write(
                        "Console history and output cleared.",
                        "success"
                    );
                }

                if (action === "level") {
                    const level =
                        args[1];

                    if (!level) {
                        throw new Error(
                            "A console level is required."
                        );
                    }

                    consoleBridge.setLevel(
                        level
                    );

                    return write(
                        `Console level: ${level}`,
                        "success"
                    );
                }

                if (action === "mirror") {
                    const value =
                        String(args[1] || "")
                            .toLowerCase();

                    if (
                        ![
                            "on",
                            "off",
                            "true",
                            "false",
                            "1",
                            "0"
                        ].includes(value)
                    ) {
                        throw new Error(
                            "Use `console mirror on` or `console mirror off`."
                        );
                    }

                    const enabled =
                        ["on", "true", "1"]
                            .includes(value);

                    consoleBridge.setMirror(
                        enabled
                    );

                    return write(
                        `Browser console mirroring: ${enabled ? "on" : "off"}`,
                        "success"
                    );
                }

                return writeJSON({
                    enabled:
                        consoleBridge.enabled,
                    minimumLevel:
                        consoleBridge.options.minimumLevel,
                    mirror:
                        consoleBridge.options.mirror,
                    history:
                        consoleBridge.history.length,
                    groups:
                        [...consoleBridge.groups],
                    timers:
                        consoleBridge.timers.size,
                    counters:
                        consoleBridge.counters.size,
                    levels:
                        LEVELS
                });
            }
        },
        {
            name: "console-history",
            category: "system",
            description:
                "Display buffered terminal console entries.",
            usage:
                "console-history [level] [limit]",
            handler: ({
                args,
                context,
                writeJSON
            }) =>
                writeJSON(
                    context.console.list({
                        level:
                            args[0] || null,
                        limit:
                            Number(args[1]) || 100
                    })
                )
        },
        {
            name: "console-export",
            category: "system",
            description:
                "Export console history as JSON.",
            usage:
                "console-export [filename]",
            handler: ({
                args,
                context,
                write
            }) => {
                const filename =
                    args[0] ||
                    "speciedex-terminal-console.json";

                const data =
                    JSON.stringify(
                        context.console.export(),
                        null,
                        2
                    );

                if (
                    context.exporter?.
                        text
                ) {
                    context.exporter.text(
                        data,
                        filename
                    );
                } else {
                    const blob =
                        new Blob(
                            [data],
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
                }

                return write(
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
                context.console.trace(
                    "Trace message"
                );

                context.console.debug(
                    "Debug message"
                );

                context.console.info(
                    "Information message"
                );

                context.console.success(
                    "Success message"
                );

                context.console.warn(
                    "Warning message"
                );

                context.console.error(
                    "Error message"
                );

                context.console.system(
                    "System message"
                );

                return write(
                    "Console test complete.",
                    "success"
                );
            }
        }
    ];

    const api = Object.freeze({
        name: MODULE_NAME,
        ConsoleBridge,
        LEVELS,
        normalizeLevel,
        safeSerialize,
        formatValue,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalConsole =
        api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules || {};

    window.SpeciedexTerminalModules[
        MODULE_NAME
    ] = api;

    document.dispatchEvent(
        new CustomEvent(
            "speciedex:terminal-module-available",
            {
                detail: {
                    name: MODULE_NAME,
                    module: api
                }
            }
        )
    );
})(window, document);
