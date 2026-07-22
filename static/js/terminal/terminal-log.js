/*
========================================================================
Speciedex.org
Terminal Logging Service
========================================================================

Structured runtime logging service for SpeciedexTerminal.

Provides:

    • normalized log levels
    • bounded log retention
    • structured metadata
    • category and source fields
    • filtering and querying
    • subscriptions
    • counters and statistics
    • event propagation
    • export and clearing
    • command-based inspection

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME =
        "Log";

    const VERSION =
        "2.0.0";

    const LEVELS =
        Object.freeze([
            "trace",
            "debug",
            "info",
            "success",
            "warning",
            "error",
            "critical"
        ]);

    const LEVEL_PRIORITY =
        Object.freeze({
            trace:
                0,

            debug:
                1,

            info:
                2,

            success:
                3,

            warning:
                4,

            error:
                5,

            critical:
                6
        });

    const DEFAULT_OPTIONS =
        Object.freeze({
            limit:
                1000,

            minimumLevel:
                "trace",

            mirrorToConsole:
                false,

            captureMetadata:
                true
        });

    /*
    ==========================================================================
    Utilities
    ==========================================================================
    */

    function normalizeLevel(
        level
    ) {
        const value =
            String(
                level ?? ""
            )
                .trim()
                .toLowerCase();

        if (
            value ===
            "warn"
        ) {
            return "warning";
        }

        if (
            value ===
            "fatal"
        ) {
            return "critical";
        }

        return LEVELS.includes(
            value
        )
            ? value
            : "info";
    }

    function clampInteger(
        value,
        fallback,
        minimum,
        maximum
    ) {
        const parsed =
            Number.parseInt(
                value,
                10
            );

        if (!Number.isFinite(parsed)) {
            return fallback;
        }

        return Math.min(
            maximum,
            Math.max(
                minimum,
                parsed
            )
        );
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

    function safeSerialize(
        value,
        seen =
            new WeakSet()
    ) {
        if (
            value === null ||
            value === undefined
        ) {
            return value;
        }

        if (
            typeof value ===
            "string" ||
            typeof value ===
            "number" ||
            typeof value ===
            "boolean"
        ) {
            return value;
        }

        if (
            typeof value ===
            "bigint"
        ) {
            return value.toString();
        }

        if (
            typeof value ===
            "function"
        ) {
            return `[Function ${value.name || "anonymous"}]`;
        }

        if (
            value instanceof
            Error
        ) {
            return {
                name:
                    value.name,

                message:
                    value.message,

                stack:
                    value.stack ||
                    null
            };
        }

        if (
            value instanceof
            Date
        ) {
            return value.toISOString();
        }

        if (
            value instanceof
            RegExp
        ) {
            return value.toString();
        }

        if (
            value instanceof
            URL
        ) {
            return value.href;
        }

        if (
            value &&
            typeof value ===
            "object"
        ) {
            if (
                seen.has(
                    value
                )
            ) {
                return "[Circular]";
            }

            seen.add(
                value
            );
        }

        if (
            Array.isArray(
                value
            )
        ) {
            return value.map(
                item =>
                    safeSerialize(
                        item,
                        seen
                    )
            );
        }

        if (
            value instanceof
            Map
        ) {
            return Object.fromEntries(
                [...value.entries()].map(
                    (
                        [
                            key,
                            item
                        ]
                    ) => [
                        String(key),
                        safeSerialize(
                            item,
                            seen
                        )
                    ]
                )
            );
        }

        if (
            value instanceof
            Set
        ) {
            return [
                ...value
            ].map(
                item =>
                    safeSerialize(
                        item,
                        seen
                    )
            );
        }

        if (
            value &&
            typeof value ===
            "object"
        ) {
            const output =
                {};

            for (
                const [
                    key,
                    item
                ] of Object.entries(
                    value
                )
            ) {
                output[
                    key
                ] =
                    safeSerialize(
                        item,
                        seen
                    );
            }

            return output;
        }

        return String(
            value
        );
    }

    function normalizeMessage(
        message
    ) {
        if (
            message instanceof
            Error
        ) {
            return message.message;
        }

        if (
            typeof message ===
            "string"
        ) {
            return message;
        }

        try {
            return JSON.stringify(
                safeSerialize(
                    message
                )
            );
        } catch (error) {
            return String(
                message
            );
        }
    }

    function matchesText(
        entry,
        text
    ) {
        const needle =
            String(
                text ?? ""
            )
                .trim()
                .toLowerCase();

        if (!needle) {
            return true;
        }

        const haystack =
            [
                entry.message,
                entry.level,
                entry.category,
                entry.source,
                JSON.stringify(
                    entry.metadata
                )
            ]
                .join(" ")
                .toLowerCase();

        return haystack.includes(
            needle
        );
    }

    /*
    ==========================================================================
    Terminal Logger
    ==========================================================================
    */

    class TerminalLogger
        extends EventTarget {
        constructor(
            context,
            options = {}
        ) {
            super();

            this.context =
                context;

            this.options = {
                limit:
                    clampInteger(
                        options.limit,
                        DEFAULT_OPTIONS.limit,
                        10,
                        100000
                    ),

                minimumLevel:
                    normalizeLevel(
                        options.minimumLevel ||
                        DEFAULT_OPTIONS.minimumLevel
                    ),

                mirrorToConsole:
                    parseBoolean(
                        options.mirrorToConsole,
                        DEFAULT_OPTIONS.mirrorToConsole
                    ),

                captureMetadata:
                    parseBoolean(
                        options.captureMetadata,
                        DEFAULT_OPTIONS.captureMetadata
                    )
            };

            this.entries =
                [];

            this.sequence =
                0;

            this.subscribers =
                new Set();

            this.destroyed =
                false;
        }

        /*
        ======================================================================
        Core Logging
        ======================================================================
        */

        shouldCapture(
            level
        ) {
            return (
                LEVEL_PRIORITY[
                    normalizeLevel(
                        level
                    )
                ] >=
                LEVEL_PRIORITY[
                    this.options.minimumLevel
                ]
            );
        }

        createEntry(
            level,
            message,
            metadata = {},
            options = {}
        ) {
            const normalizedLevel =
                normalizeLevel(
                    level
                );

            return {
                id:
                    `log:${Date.now()}:${++this.sequence}`,

                timestamp:
                    new Date().toISOString(),

                monotonic:
                    performance.now(),

                level:
                    normalizedLevel,

                message:
                    normalizeMessage(
                        message
                    ),

                category:
                    String(
                        options.category ||
                        metadata?.category ||
                        "terminal"
                    ),

                source:
                    String(
                        options.source ||
                        metadata?.source ||
                        MODULE_NAME
                    ),

                metadata:
                    this.options.captureMetadata
                        ? safeSerialize(
                            metadata
                        )
                        : {},

                terminal:
                    this.context.root?.
                        dataset.
                        terminalInstance ||
                    "default"
            };
        }

        push(
            level,
            message,
            metadata = {},
            options = {}
        ) {
            if (this.destroyed) {
                throw new Error(
                    "TerminalLogger has been destroyed."
                );
            }

            const normalizedLevel =
                normalizeLevel(
                    level
                );

            if (
                !this.shouldCapture(
                    normalizedLevel
                )
            ) {
                return null;
            }

            const entry =
                this.createEntry(
                    normalizedLevel,
                    message,
                    metadata,
                    options
                );

            this.entries.push(
                entry
            );

            if (
                this.entries.length >
                this.options.limit
            ) {
                this.entries.splice(
                    0,
                    this.entries.length -
                    this.options.limit
                );
            }

            this.emitEntry(
                entry
            );

            if (
                this.options.mirrorToConsole
            ) {
                this.mirror(
                    entry
                );
            }

            return entry;
        }

        mirror(
            entry
        ) {
            const method =
                entry.level ===
                    "warning"
                    ? "warn"
                    : [
                        "error",
                        "critical"
                    ].includes(
                        entry.level
                    )
                        ? "error"
                        : [
                            "trace",
                            "debug",
                            "info"
                        ].includes(
                            entry.level
                        )
                            ? entry.level
                            : "log";

            const logger =
                window.console[
                    method
                ] ||
                window.console.log;

            logger.call(
                window.console,
                `[SpeciedexTerminal:${entry.category}]`,
                entry.message,
                entry.metadata
            );
        }

        emitEntry(
            entry
        ) {
            this.dispatchEvent(
                new CustomEvent(
                    "entry",
                    {
                        detail:
                            entry
                    }
                )
            );

            for (const callback of this.subscribers) {
                try {
                    callback(
                        entry
                    );
                } catch (error) {
                    console.error(
                        "[SpeciedexTerminalLog] Subscriber failed:",
                        error
                    );
                }
            }

            this.context.events?.emit?.(
                "log",
                entry
            );

            this.context.events?.emit?.(
                "log:entry",
                entry
            );

            this.context.root?.
                dispatchEvent?.(
                    new CustomEvent(
                        "speciedex:terminal-log-entry",
                        {
                            bubbles:
                                true,

                            detail:
                                entry
                        }
                    )
                );

            document.dispatchEvent(
                new CustomEvent(
                    "speciedex:terminal-log-entry",
                    {
                        detail:
                            entry
                    }
                )
            );
        }

        /*
        ======================================================================
        Convenience Methods
        ======================================================================
        */

        trace(
            message,
            metadata,
            options
        ) {
            return this.push(
                "trace",
                message,
                metadata,
                options
            );
        }

        debug(
            message,
            metadata,
            options
        ) {
            return this.push(
                "debug",
                message,
                metadata,
                options
            );
        }

        info(
            message,
            metadata,
            options
        ) {
            return this.push(
                "info",
                message,
                metadata,
                options
            );
        }

        success(
            message,
            metadata,
            options
        ) {
            return this.push(
                "success",
                message,
                metadata,
                options
            );
        }

        warn(
            message,
            metadata,
            options
        ) {
            return this.push(
                "warning",
                message,
                metadata,
                options
            );
        }

        warning(
            message,
            metadata,
            options
        ) {
            return this.warn(
                message,
                metadata,
                options
            );
        }

        error(
            message,
            metadata,
            options
        ) {
            return this.push(
                "error",
                message,
                metadata,
                options
            );
        }

        critical(
            message,
            metadata,
            options
        ) {
            return this.push(
                "critical",
                message,
                metadata,
                options
            );
        }

        /*
        ======================================================================
        Querying
        ======================================================================
        */

        list(
            options = {}
        ) {
            const level =
                options.level
                    ? normalizeLevel(
                        options.level
                    )
                    : null;

            const category =
                options.category
                    ? String(
                        options.category
                    ).toLowerCase()
                    : null;

            const source =
                options.source
                    ? String(
                        options.source
                    ).toLowerCase()
                    : null;

            const text =
                options.text ||
                options.contains ||
                "";

            const since =
                options.since
                    ? Date.parse(
                        options.since
                    )
                    : null;

            const until =
                options.until
                    ? Date.parse(
                        options.until
                    )
                    : null;

            const limit =
                clampInteger(
                    options.limit,
                    100,
                    1,
                    this.options.limit
                );

            const filtered =
                this.entries.filter(
                    entry => {
                        const timestamp =
                            Date.parse(
                                entry.timestamp
                            );

                        return (
                            (
                                !level ||
                                entry.level ===
                                level
                            ) &&
                            (
                                !category ||
                                entry.category
                                    .toLowerCase() ===
                                category
                            ) &&
                            (
                                !source ||
                                entry.source
                                    .toLowerCase() ===
                                source
                            ) &&
                            matchesText(
                                entry,
                                text
                            ) &&
                            (
                                !Number.isFinite(
                                    since
                                ) ||
                                timestamp >=
                                since
                            ) &&
                            (
                                !Number.isFinite(
                                    until
                                ) ||
                                timestamp <=
                                until
                            )
                        );
                    }
                );

            const result =
                filtered.slice(
                    -limit
                );

            return options.newestFirst
                ? result.reverse()
                : result;
        }

        find(
            id
        ) {
            const normalized =
                String(
                    id ?? ""
                ).trim();

            return (
                this.entries.find(
                    entry =>
                        entry.id ===
                        normalized
                ) ||
                null
            );
        }

        counts() {
            const byLevel =
                Object.fromEntries(
                    LEVELS.map(
                        level => [
                            level,
                            0
                        ]
                    )
                );

            const byCategory =
                {};

            const bySource =
                {};

            for (const entry of this.entries) {
                byLevel[
                    entry.level
                ] =
                    (
                        byLevel[
                            entry.level
                        ] ||
                        0
                    ) +
                    1;

                byCategory[
                    entry.category
                ] =
                    (
                        byCategory[
                            entry.category
                        ] ||
                        0
                    ) +
                    1;

                bySource[
                    entry.source
                ] =
                    (
                        bySource[
                            entry.source
                        ] ||
                        0
                    ) +
                    1;
            }

            return {
                total:
                    this.entries.length,

                byLevel,
                byCategory,
                bySource
            };
        }

        /*
        ======================================================================
        Configuration
        ======================================================================
        */

        setLevel(
            level
        ) {
            const normalized =
                normalizeLevel(
                    level
                );

            this.options.minimumLevel =
                normalized;

            this.dispatchEvent(
                new CustomEvent(
                    "level",
                    {
                        detail: {
                            level:
                                normalized
                        }
                    }
                )
            );

            return normalized;
        }

        setLimit(
            limit
        ) {
            this.options.limit =
                clampInteger(
                    limit,
                    this.options.limit,
                    10,
                    100000
                );

            if (
                this.entries.length >
                this.options.limit
            ) {
                this.entries =
                    this.entries.slice(
                        -this.options.limit
                    );
            }

            return this.options.limit;
        }

        subscribe(
            callback
        ) {
            if (
                typeof callback !==
                "function"
            ) {
                throw new TypeError(
                    "Log subscriber must be a function."
                );
            }

            this.subscribers.add(
                callback
            );

            return () =>
                this.unsubscribe(
                    callback
                );
        }

        unsubscribe(
            callback
        ) {
            return this.subscribers.delete(
                callback
            );
        }

        /*
        ======================================================================
        Export and Lifecycle
        ======================================================================
        */

        clear() {
            const count =
                this.entries.length;

            this.entries =
                [];

            this.dispatchEvent(
                new CustomEvent(
                    "clear",
                    {
                        detail: {
                            count
                        }
                    }
                )
            );

            this.context.events?.emit?.(
                "log:clear",
                {
                    count
                }
            );

            return count;
        }

        export(
            options = {}
        ) {
            return {
                version:
                    VERSION,

                generatedAt:
                    new Date().toISOString(),

                options: {
                    minimumLevel:
                        this.options.minimumLevel,

                    limit:
                        this.options.limit,

                    mirrorToConsole:
                        this.options.mirrorToConsole,

                    captureMetadata:
                        this.options.captureMetadata
                },

                counts:
                    this.counts(),

                entries:
                    this.list({
                        ...options,

                        limit:
                            options.limit ||
                            this.options.limit
                    })
            };
        }

        status() {
            return {
                version:
                    VERSION,

                minimumLevel:
                    this.options.minimumLevel,

                limit:
                    this.options.limit,

                mirrorToConsole:
                    this.options.mirrorToConsole,

                captureMetadata:
                    this.options.captureMetadata,

                subscribers:
                    this.subscribers.size,

                counts:
                    this.counts()
            };
        }

        destroy() {
            if (this.destroyed) {
                return;
            }

            this.subscribers.clear();
            this.entries =
                [];

            this.destroyed =
                true;

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
            context.log instanceof
            TerminalLogger
        ) {
            return context.log;
        }

        const logger =
            new TerminalLogger(
                context,
                {
                    limit:
                        context.root?.
                            dataset.
                            terminalLogLimit,

                    minimumLevel:
                        context.root?.
                            dataset.
                            terminalLogLevel ||
                        DEFAULT_OPTIONS.minimumLevel,

                    mirrorToConsole:
                        parseBoolean(
                            context.root?.
                                dataset.
                                terminalLogMirror,
                            false
                        ),

                    captureMetadata:
                        parseBoolean(
                            context.root?.
                                dataset.
                                terminalLogMetadata,
                            true
                        )
                }
            );

        context.log =
            logger;

        context.registerService?.(
            "log",
            logger
        );

        logger.info(
            "Terminal logging service initialized.",
            {
                version:
                    VERSION
            },
            {
                category:
                    "system",

                source:
                    MODULE_NAME
            }
        );

        return logger;
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
                    "log",

                category:
                    "system",

                description:
                    "Display recent terminal log entries.",

                usage:
                    "log [count] [level] [contains]",

                handler: ({
                    args,
                    context,
                    writeJSON
                }) => {
                    const count =
                        clampInteger(
                            args[0],
                            25,
                            1,
                            1000
                        );

                    const level =
                        args[1] &&
                        LEVELS.includes(
                            normalizeLevel(
                                args[1]
                            )
                        )
                            ? normalizeLevel(
                                args[1]
                            )
                            : null;

                    const contains =
                        level
                            ? args.slice(2).join(
                                " "
                            )
                            : args.slice(1).join(
                                " "
                            );

                    return writeJSON(
                        context.log.list({
                            limit:
                                count,

                            level,

                            contains
                        })
                    );
                }
            },

            {
                name:
                    "log-status",

                category:
                    "system",

                description:
                    "Display terminal logging service status.",

                usage:
                    "log-status",

                handler: ({
                    context,
                    writeJSON
                }) =>
                    writeJSON(
                        context.log.status()
                    )
            },

            {
                name:
                    "log-level",

                category:
                    "system",

                description:
                    "Display or set the minimum captured log level.",

                usage:
                    "log-level [trace|debug|info|success|warning|error|critical]",

                handler: ({
                    args,
                    context,
                    write
                }) => {
                    if (!args[0]) {
                        return write(
                            `Log level: ${context.log.options.minimumLevel}`
                        );
                    }

                    const level =
                        normalizeLevel(
                            args[0]
                        );

                    context.log.setLevel(
                        level
                    );

                    return write(
                        `Log level: ${level}`,
                        "success"
                    );
                }
            },

            {
                name:
                    "log-counts",

                category:
                    "system",

                description:
                    "Display log-entry counts by level, category, and source.",

                usage:
                    "log-counts",

                handler: ({
                    context,
                    writeJSON
                }) =>
                    writeJSON(
                        context.log.counts()
                    )
            },

            {
                name:
                    "log-clear",

                category:
                    "system",

                description:
                    "Clear retained terminal log entries.",

                usage:
                    "log-clear",

                handler: ({
                    context,
                    write
                }) => {
                    const count =
                        context.log.clear();

                    return write(
                        `Cleared ${count} log entr${count === 1 ? "y" : "ies"}.`,
                        "success"
                    );
                }
            },

            {
                name:
                    "log-export",

                category:
                    "system",

                description:
                    "Export terminal logs as JSON.",

                usage:
                    "log-export [filename]",

                handler: ({
                    args,
                    context,
                    write
                }) => {
                    const filename =
                        args[0] ||
                        "speciedex-terminal-log.json";

                    const payload =
                        JSON.stringify(
                            context.log.export(),
                            null,
                            2
                        );

                    const blob =
                        new Blob(
                            [
                                payload
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
                        `Log exported to ${filename}.`,
                        "success"
                    );
                }
            },

            {
                name:
                    "log-test",

                category:
                    "system",

                description:
                    "Write one test entry at each log level.",

                usage:
                    "log-test",

                handler: ({
                    context,
                    write
                }) => {
                    for (const level of LEVELS) {
                        context.log.push(
                            level,
                            `SpeciedexTerminal ${level} log test.`,
                            {
                                test:
                                    true
                            },
                            {
                                category:
                                    "diagnostic",

                                source:
                                    "log-test"
                            }
                        );
                    }

                    return write(
                        "Log test entries created.",
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

            LEVELS,
            LEVEL_PRIORITY,
            DEFAULT_OPTIONS,
            TerminalLogger,

            normalizeLevel,
            normalizeMessage,
            safeSerialize,
            parseBoolean,
            clampInteger,

            initialize,
            mount:
                initialize,
            init:
                initialize,
            setup:
                initialize,

            commands
        });

    window.SpeciedexTerminalLog =
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
