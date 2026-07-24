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
        "2.1.0";

    const LOGGER_SYMBOL =
        Symbol.for(
            "speciedex.terminal.log.instance"
        );

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
                true,

            captureWindowErrors:
                true,

            captureUnhandledRejections:
                true,

            maximumMetadataDepth:
                8,

            maximumMetadataEntries:
                500,

            maximumMessageLength:
                32768
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
            new WeakSet(),
        state = {
            depth:
                0,
            entries:
                0,
            maximumDepth:
                DEFAULT_OPTIONS.maximumMetadataDepth,
            maximumEntries:
                DEFAULT_OPTIONS.maximumMetadataEntries
        }
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
            state.entries >=
            state.maximumEntries
        ) {
            return "[Truncated: metadata entry limit]";
        }

        state.entries +=
            1;

        if (
            state.depth >
            state.maximumDepth
        ) {
            return "[Truncated: metadata depth limit]";
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
                "symbol"
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
                    null,

                cause:
                    value.cause
                        ? safeSerialize(
                            value.cause,
                            seen,
                            {
                                ...state,
                                depth:
                                    state.depth +
                                    1
                            }
                        )
                        : null
            };
        }

        if (
            value instanceof
            Date
        ) {
            return Number.isFinite(
                value.getTime()
            )
                ? value.toISOString()
                : "Invalid Date";
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
            typeof Response !==
                "undefined" &&
            value instanceof
                Response
        ) {
            return {
                type:
                    "Response",
                url:
                    value.url,
                status:
                    value.status,
                statusText:
                    value.statusText,
                ok:
                    value.ok,
                redirected:
                    value.redirected
            };
        }

        if (
            typeof Request !==
                "undefined" &&
            value instanceof
                Request
        ) {
            return {
                type:
                    "Request",
                url:
                    value.url,
                method:
                    value.method,
                mode:
                    value.mode,
                credentials:
                    value.credentials
            };
        }

        if (
            typeof Node !==
                "undefined" &&
            value instanceof
                Node
        ) {
            return {
                type:
                    value.nodeName,
                id:
                    value.id ||
                    null,
                className:
                    typeof value.className ===
                        "string"
                        ? value.className
                        : null,
                text:
                    String(
                        value.textContent ||
                        ""
                    ).slice(
                        0,
                        500
                    )
            };
        }

        if (
            ArrayBuffer.isView(
                value
            )
        ) {
            return {
                type:
                    value.constructor?.name ||
                    "TypedArray",
                length:
                    value.length ??
                    value.byteLength,
                values:
                    Array.from(
                        value
                    ).slice(
                        0,
                        128
                    )
            };
        }

        if (
            value instanceof
            ArrayBuffer
        ) {
            return {
                type:
                    "ArrayBuffer",
                byteLength:
                    value.byteLength
            };
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

        const childState = {
            ...state,
            depth:
                state.depth +
                1
        };

        if (
            Array.isArray(
                value
            )
        ) {
            return value
                .slice(
                    0,
                    state.maximumEntries
                )
                .map(
                    item =>
                        safeSerialize(
                            item,
                            seen,
                            childState
                        )
                );
        }

        if (
            value instanceof
            Map
        ) {
            const output =
                {};

            for (
                const [
                    key,
                    item
                ] of value.entries()
            ) {
                if (
                    state.entries >=
                    state.maximumEntries
                ) {
                    output.__truncated__ =
                        true;

                    break;
                }

                output[
                    String(
                        key
                    )
                ] =
                    safeSerialize(
                        item,
                        seen,
                        childState
                    );
            }

            return output;
        }

        if (
            value instanceof
            Set
        ) {
            return Array.from(
                value
            )
                .slice(
                    0,
                    state.maximumEntries
                )
                .map(
                    item =>
                        safeSerialize(
                            item,
                            seen,
                            childState
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
                if (
                    state.entries >=
                    state.maximumEntries
                ) {
                    output.__truncated__ =
                        true;

                    break;
                }

                try {
                    output[
                        key
                    ] =
                        safeSerialize(
                            item,
                            seen,
                            childState
                        );
                } catch (error) {
                    output[
                        key
                    ] =
                        `[Unserializable: ${error.message}]`;
                }
            }

            return output;
        }

        return String(
            value
        );
    }

    function normalizeMessage(
        message,
        maximumLength =
            DEFAULT_OPTIONS.maximumMessageLength
    ) {
        if (
            message instanceof
            Error
        ) {
            return truncateMessage(
                message.message,
                maximumLength
            );
        }

        if (
            typeof message ===
            "string"
        ) {
            return truncateMessage(
                message,
                maximumLength
            );
        }

        try {
            return truncateMessage(
                JSON.stringify(
                    safeSerialize(
                        message
                    )
                ),
                maximumLength
            );
        } catch (error) {
            const fallback =
                String(
                    message
                );

            return fallback.length >
                maximumLength
                ? `${fallback.slice(0, maximumLength)}…`
                : fallback;
        }
    }

    function truncateMessage(
        message,
        maximumLength
    ) {
        const normalized =
            String(
                message ??
                ""
            );

        return normalized.length >
            maximumLength
            ? `${normalized.slice(0, maximumLength)}…`
            : normalized;
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
                    ),

                captureWindowErrors:
                    parseBoolean(
                        options.captureWindowErrors,
                        DEFAULT_OPTIONS.captureWindowErrors
                    ),

                captureUnhandledRejections:
                    parseBoolean(
                        options.captureUnhandledRejections,
                        DEFAULT_OPTIONS.captureUnhandledRejections
                    ),

                maximumMetadataDepth:
                    clampInteger(
                        options.maximumMetadataDepth,
                        DEFAULT_OPTIONS.maximumMetadataDepth,
                        1,
                        64
                    ),

                maximumMetadataEntries:
                    clampInteger(
                        options.maximumMetadataEntries,
                        DEFAULT_OPTIONS.maximumMetadataEntries,
                        10,
                        100000
                    ),

                maximumMessageLength:
                    clampInteger(
                        options.maximumMessageLength,
                        DEFAULT_OPTIONS.maximumMessageLength,
                        256,
                        1048576
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

            this.abortController =
                new AbortController();

            this.batchDepth =
                0;

            this.pendingEntries =
                [];

            this.dropped =
                0;

            this.capturedErrors =
                0;

            this.installGlobalCapture();
        }

        /*
        ======================================================================
        Runtime Capture and Batching
        ======================================================================
        */

        assertActive() {
            if (
                this.destroyed
            ) {
                throw new Error(
                    "TerminalLogger has been destroyed."
                );
            }
        }

        installGlobalCapture() {
            const signal =
                this.abortController.signal;

            if (
                this.options.captureWindowErrors
            ) {
                window.addEventListener(
                    "error",
                    event => {
                        this.capturedErrors +=
                            1;

                        this.error(
                            event.error ||
                            event.message ||
                            "Unhandled window error.",
                            {
                                filename:
                                    event.filename ||
                                    null,
                                line:
                                    event.lineno ||
                                    null,
                                column:
                                    event.colno ||
                                    null,
                                error:
                                    event.error ||
                                    null
                            },
                            {
                                category:
                                    "runtime",
                                source:
                                    "window.error"
                            }
                        );
                    },
                    {
                        signal
                    }
                );
            }

            if (
                this.options.captureUnhandledRejections
            ) {
                window.addEventListener(
                    "unhandledrejection",
                    event => {
                        this.capturedErrors +=
                            1;

                        this.error(
                            event.reason ||
                            "Unhandled promise rejection.",
                            {
                                reason:
                                    event.reason
                            },
                            {
                                category:
                                    "runtime",
                                source:
                                    "unhandledrejection"
                            }
                        );
                    },
                    {
                        signal
                    }
                );
            }
        }

        beginBatch() {
            this.assertActive();

            this.batchDepth +=
                1;

            return this.batchDepth;
        }

        endBatch() {
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
                    0 &&
                this.pendingEntries.length
            ) {
                const entries =
                    this.pendingEntries.splice(
                        0
                    );

                this.dispatchEvent(
                    new CustomEvent(
                        "batch",
                        {
                            detail: {
                                entries,
                                count:
                                    entries.length
                            }
                        }
                    )
                );

                this.context.events?.emit?.(
                    "log:batch",
                    {
                        entries,
                        count:
                            entries.length
                    }
                );
            }

            return this.batchDepth;
        }

        batch(
            callback
        ) {
            if (
                typeof callback !==
                    "function"
            ) {
                throw new TypeError(
                    "Log batch requires a callback."
                );
            }

            this.beginBatch();

            try {
                return callback(
                    this
                );
            } finally {
                this.endBatch();
            }
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
                        message,
                        this.options.maximumMessageLength
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
                            metadata,
                            new WeakSet(),
                            {
                                depth:
                                    0,
                                entries:
                                    0,
                                maximumDepth:
                                    this.options.maximumMetadataDepth,
                                maximumEntries:
                                    this.options.maximumMetadataEntries
                            }
                        )
                        : {},

                terminal:
                    this.context.root?.
                        dataset.
                        terminalInstance ||
                    "default",

                page:
                    window.location?.
                        pathname ||
                    null,

                session:
                    this.context.session?.id ||
                    null
            };
        }

        push(
            level,
            message,
            metadata = {},
            options = {}
        ) {
            this.assertActive();

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
                const removed =
                    this.entries.length -
                    this.options.limit;

                this.entries.splice(
                    0,
                    removed
                );

                this.dropped +=
                    removed;
            }

            if (
                this.batchDepth >
                    0
            ) {
                this.pendingEntries.push(
                    entry
                );
            } else {
                this.emitEntry(
                    entry
                );
            }

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
                window.console?.[
                    method
                ] ||
                window.console?.log;

            if (
                typeof logger !==
                    "function"
            ) {
                return;
            }

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

            for (
                const callback of
                Array.from(
                    this.subscribers
                )
            ) {
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

            const minimumLevel =
                options.minimumLevel
                    ? normalizeLevel(
                        options.minimumLevel
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
                                !minimumLevel ||
                                LEVEL_PRIORITY[
                                    entry.level
                                ] >=
                                LEVEL_PRIORITY[
                                    minimumLevel
                                ]
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

        latest(
            limit = 25
        ) {
            return this.list({
                limit,
                newestFirst:
                    true
            });
        }

        tail(
            limit = 25
        ) {
            return this.latest(
                limit
            );
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

                retained:
                    this.entries.length,

                dropped:
                    this.dropped,

                capturedErrors:
                    this.capturedErrors,

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

            this.dispatchEvent(
                new CustomEvent(
                    "limit",
                    {
                        detail: {
                            limit:
                                this.options.limit
                        }
                    }
                )
            );

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
                            count,
                            dropped:
                                this.dropped
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

        toJSON(
            options = {}
        ) {
            return JSON.stringify(
                this.export(
                    options
                ),
                null,
                options.compact
                    ? 0
                    : 2
            );
        }

        toJSONL(
            options = {}
        ) {
            return this.list({
                ...options,
                limit:
                    options.limit ||
                    this.options.limit
            })
                .map(
                    entry =>
                        JSON.stringify(
                            entry
                        )
                )
                .join(
                    "\n"
                );
        }

        toText(
            options = {}
        ) {
            return this.list({
                ...options,
                limit:
                    options.limit ||
                    this.options.limit
            })
                .map(
                    entry =>
                        [
                            entry.timestamp,
                            entry.level.toUpperCase(),
                            `[${entry.category}]`,
                            entry.source,
                            entry.message
                        ].join(
                            " "
                        )
                )
                .join(
                    "\n"
                );
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
                        this.options.captureMetadata,

                    captureWindowErrors:
                        this.options.captureWindowErrors,

                    captureUnhandledRejections:
                        this.options.captureUnhandledRejections,

                    maximumMetadataDepth:
                        this.options.maximumMetadataDepth,

                    maximumMetadataEntries:
                        this.options.maximumMetadataEntries,

                    maximumMessageLength:
                        this.options.maximumMessageLength
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

                captureWindowErrors:
                    this.options.captureWindowErrors,

                captureUnhandledRejections:
                    this.options.captureUnhandledRejections,

                batchDepth:
                    this.batchDepth,

                pendingEntries:
                    this.pendingEntries.length,

                destroyed:
                    this.destroyed,

                subscribers:
                    this.subscribers.size,

                counts:
                    this.counts()
            };
        }

        destroy() {
            if (
                this.destroyed
            ) {
                return false;
            }

            this.abortController.abort();
            this.subscribers.clear();
            this.pendingEntries =
                [];
            this.entries =
                [];

            if (
                this.context.root?.[
                    LOGGER_SYMBOL
                ] ===
                    this
            ) {
                delete this.context.root[
                    LOGGER_SYMBOL
                ];
            }

            this.destroyed =
                true;

            this.dispatchEvent(
                new CustomEvent(
                    "destroy",
                    {
                        detail: {
                            version:
                                VERSION
                        }
                    }
                )
            );

            return true;
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
        const root =
            context.root;

        const existing =
            context.log instanceof
                TerminalLogger
                ? context.log
                : root?.[
                    LOGGER_SYMBOL
                ];

        if (
            existing instanceof
                TerminalLogger &&
            !existing.destroyed
        ) {
            context.log =
                existing;

            context.registerService?.(
                "log",
                existing
            );

            return existing;
        }

        const logger =
            new TerminalLogger(
                context,
                {
                    limit:
                        root?.
                            dataset.
                            terminalLogLimit,

                    minimumLevel:
                        root?.
                            dataset.
                            terminalLogLevel ||
                        DEFAULT_OPTIONS.minimumLevel,

                    mirrorToConsole:
                        parseBoolean(
                            root?.
                                dataset.
                                terminalLogMirror,
                            false
                        ),

                    captureMetadata:
                        parseBoolean(
                            root?.
                                dataset.
                                terminalLogMetadata,
                            true
                        ),

                    captureWindowErrors:
                        parseBoolean(
                            root?.
                                dataset.
                                terminalLogCaptureErrors,
                            true
                        ),

                    captureUnhandledRejections:
                        parseBoolean(
                            root?.
                                dataset.
                                terminalLogCaptureRejections,
                            true
                        ),

                    maximumMetadataDepth:
                        root?.
                            dataset.
                            terminalLogMetadataDepth,

                    maximumMetadataEntries:
                        root?.
                            dataset.
                            terminalLogMetadataEntries,

                    maximumMessageLength:
                        root?.
                            dataset.
                            terminalLogMessageLength
                }
            );

        root[
            LOGGER_SYMBOL
        ] =
            logger;

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
                    writeJSON,
                    writeTable
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

                    const entries =
                        context.log.list({
                            limit:
                                count,

                            level,

                            contains
                        });

                    if (
                        typeof writeTable ===
                            "function"
                    ) {
                        return writeTable(
                            [
                                "Time",
                                "Level",
                                "Category",
                                "Source",
                                "Message"
                            ],
                            entries.map(
                                entry => [
                                    entry.timestamp,
                                    entry.level,
                                    entry.category,
                                    entry.source,
                                    entry.message
                                ]
                            )
                        );
                    }

                    return writeJSON(
                        entries
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
                    "log-tail",

                category:
                    "system",

                description:
                    "Display newest retained log entries first.",

                usage:
                    "log-tail [count]",

                handler: ({
                    args,
                    context,
                    writeJSON
                }) =>
                    writeJSON(
                        context.log.latest(
                            clampInteger(
                                args[0],
                                25,
                                1,
                                1000
                            )
                        )
                    )
            },

            {
                name:
                    "log-limit",

                category:
                    "system",

                description:
                    "Display or set retained log-entry capacity.",

                usage:
                    "log-limit [count]",

                handler: ({
                    args,
                    context,
                    write
                }) => {
                    if (!args[0]) {
                        return write(
                            `Log limit: ${context.log.options.limit}`
                        );
                    }

                    const limit =
                        context.log.setLimit(
                            args[0]
                        );

                    return write(
                        `Log limit: ${limit}`,
                        "success"
                    );
                }
            },

            {
                name:
                    "log-mirror",

                category:
                    "system",

                description:
                    "Enable or disable browser-console mirroring.",

                usage:
                    "log-mirror [on|off]",

                handler: ({
                    args,
                    context,
                    write
                }) => {
                    if (!args[0]) {
                        return write(
                            `Console mirroring: ${context.log.options.mirrorToConsole ? "on" : "off"}`
                        );
                    }

                    context.log.options.mirrorToConsole =
                        parseBoolean(
                            args[0],
                            context.log.options.mirrorToConsole
                        );

                    return write(
                        `Console mirroring: ${context.log.options.mirrorToConsole ? "on" : "off"}`,
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
                    "log-export [filename] [json|jsonl|txt]",

                handler: ({
                    args,
                    context,
                    write
                }) => {
                    const filename =
                        args[0] ||
                        "speciedex-terminal-log.json";

                    const format =
                        String(
                            args[1] ||
                            filename.split(".").pop() ||
                            "json"
                        )
                            .trim()
                            .toLowerCase();

                    const payload =
                        format ===
                            "jsonl" ||
                        format ===
                            "ndjson"
                            ? context.log.toJSONL()
                            : format ===
                                "txt" ||
                              format ===
                                "text"
                                ? context.log.toText()
                                : context.log.toJSON();

                    const mimeType =
                        format ===
                            "jsonl" ||
                        format ===
                            "ndjson"
                            ? "application/x-ndjson"
                            : format ===
                                "txt" ||
                              format ===
                                "text"
                                ? "text/plain"
                                : "application/json";

                    const blob =
                        new Blob(
                            [
                                payload
                            ],
                            {
                                type:
                                    mimeType
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
            LOGGER_SYMBOL,
            TerminalLogger,

            normalizeLevel,
            normalizeMessage,
            truncateMessage,
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
