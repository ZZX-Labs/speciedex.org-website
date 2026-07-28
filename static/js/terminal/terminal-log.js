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
        "2.2.0";

    const LOGGER_SYMBOL =
        Symbol.for(
            "speciedex.terminal.log.instance"
        );

    const RESERVED_KEYS =
        new Set([
            "__proto__",
            "prototype",
            "constructor"
        ]);

    const activeDispatches =
        new WeakMap();

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

    function isObject(value) {
        return (
            value !== null &&
            typeof value === "object" &&
            !Array.isArray(value)
        );
    }

    function nowISO(value = Date.now()) {
        const date =
            value instanceof Date
                ? value
                : new Date(value);

        return Number.isFinite(date.getTime())
            ? date.toISOString()
            : new Date().toISOString();
    }

    function monotonicNow() {
        return (
            typeof performance !== "undefined" &&
            typeof performance.now === "function"
        )
            ? performance.now()
            : Date.now();
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
            activeDispatches.set(
                target,
                names
            );
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

    function safeStringify(value, compact = false) {
        return JSON.stringify(
            safeSerialize(value),
            null,
            compact ? 0 : 2
        );
    }

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
            String(value)
                .trim()
                .toLowerCase();

        if (
            ["1", "true", "yes", "on", "enabled"].includes(
                normalized
            )
        ) {
            return true;
        }

        if (
            ["0", "false", "no", "off", "disabled"].includes(
                normalized
            )
        ) {
            return false;
        }

        return fallback;
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

                const normalizedKey =
                    String(key);

                if (RESERVED_KEYS.has(normalizedKey)) {
                    continue;
                }

                output[
                    normalizedKey
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

                if (RESERVED_KEYS.has(key)) {
                    continue;
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
                safeStringify(
                    entry.metadata,
                    true
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
                isObject(context)
                    ? context
                    : {};

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

            this.ready =
                true;

            this.destroyed =
                false;

            this.abortController =
                typeof AbortController ===
                    "function"
                    ? new AbortController()
                    : null;

            this.boundListeners =
                [];

            this.watchers =
                new Set();

            this.emitting =
                false;

            this.syncingState =
                false;

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

        emit(name, detail = {}) {
            if (
                this.destroyed &&
                name !== "destroy"
            ) {
                return false;
            }

            if (this.emitting) {
                return false;
            }

            this.emitting = true;

            try {
                dispatch(
                    this,
                    name,
                    detail
                );

                for (
                    const watcher
                    of Array.from(
                        this.watchers
                    )
                ) {
                    try {
                        watcher(
                            {
                                type: name,
                                timestamp:
                                    nowISO(),
                                detail
                            },
                            this
                        );
                    } catch (_error) {
                        /* Watcher failures are isolated. */
                    }
                }

                try {
                    this.context.events?.emit?.(
                        `log:${name}`,
                        detail
                    );
                } catch (_error) {
                    /* External event failures are isolated. */
                }

                dispatch(
                    this.context.root,
                    `speciedex:terminal-log-${name}`,
                    detail,
                    {
                        bubbles: true
                    }
                );

                return true;
            } finally {
                this.emitting = false;
            }
        }

        watch(callback, options = {}) {
            this.assertActive();

            if (typeof callback !== "function") {
                throw new TypeError(
                    "Log watcher must be a function."
                );
            }

            this.watchers.add(callback);

            if (options.immediate === true) {
                callback(
                    {
                        type: "initial",
                        timestamp:
                            nowISO(),
                        status:
                            this.status()
                    },
                    this
                );
            }

            return () =>
                this.watchers.delete(
                    callback
                );
        }

        addManagedListener(
            target,
            name,
            handler,
            options = {}
        ) {
            if (
                !target ||
                typeof target.addEventListener !==
                    "function"
            ) {
                return false;
            }

            const listenerOptions = {
                ...options
            };

            if (this.abortController?.signal) {
                listenerOptions.signal =
                    this.abortController.signal;
            }

            try {
                target.addEventListener(
                    name,
                    handler,
                    listenerOptions
                );

                return true;
            } catch (_error) {
                const capture =
                    options.capture === true;

                target.addEventListener(
                    name,
                    handler,
                    capture
                );

                this.boundListeners.push(
                    () =>
                        target.removeEventListener(
                            name,
                            handler,
                            capture
                        )
                );

                return true;
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
                    "terminal.log",
                    {
                        ready:
                            this.ready,
                        entries:
                            this.entries.length,
                        dropped:
                            this.dropped,
                        minimumLevel:
                            this.options.minimumLevel,
                        updatedAt:
                            nowISO()
                    },
                    {
                        source: "log",
                        undoable: false,
                        persist: false,
                        broadcast: false
                    }
                );

                return true;
            } catch (_error) {
                return false;
            } finally {
                this.syncingState = false;
            }
        }

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
            if (
                this.options.captureWindowErrors
            ) {
                this.addManagedListener(
                    window,
                    "error",
                    event => {
                        if (this.destroyed) {
                            return;
                        }

                        this.capturedErrors += 1;

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
                    }
                );
            }

            if (
                this.options.captureUnhandledRejections
            ) {
                this.addManagedListener(
                    window,
                    "unhandledrejection",
                    event => {
                        if (this.destroyed) {
                            return;
                        }

                        this.capturedErrors += 1;

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

                this.emit(
                    "batch",
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
                typeof callback !== "function"
            ) {
                throw new TypeError(
                    "Log batch requires a callback."
                );
            }

            this.beginBatch();

            let result;

            try {
                result =
                    callback(this);
            } catch (error) {
                this.endBatch();
                throw error;
            }

            if (
                result &&
                typeof result.then ===
                    "function"
            ) {
                return Promise.resolve(result)
                    .finally(
                        () =>
                            this.endBatch()
                    );
            }

            this.endBatch();

            return result;
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
                    nowISO(),

                monotonic:
                    monotonicNow(),

                level:
                    normalizedLevel,

                message:
                    normalizeMessage(
                        message,
                        this.options.maximumMessageLength
                    ),

                category:
                    truncateMessage(
                        options.category ||
                        metadata?.category ||
                        "terminal",
                        256
                    ),

                source:
                    truncateMessage(
                        options.source ||
                        metadata?.source ||
                        MODULE_NAME,
                        256
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
            dispatch(
                this,
                "entry",
                entry
            );

            for (
                const callback of
                Array.from(
                    this.subscribers
                )
            ) {
                try {
                    callback(entry);
                } catch (error) {
                    console.error(
                        "[SpeciedexTerminalLog] Subscriber failed:",
                        error
                    );
                }
            }

            for (
                const watcher
                of Array.from(
                    this.watchers
                )
            ) {
                try {
                    watcher(
                        {
                            type: "entry",
                            timestamp:
                                nowISO(),
                            detail:
                                entry
                        },
                        this
                    );
                } catch (_error) {
                    /* Watcher failures are isolated. */
                }
            }

            try {
                this.context.events?.emit?.(
                    "log",
                    entry
                );

                this.context.events?.emit?.(
                    "log:entry",
                    entry
                );
            } catch (_error) {
                /* External event failures are isolated. */
            }

            dispatch(
                this.context.root,
                "speciedex:terminal-log-entry",
                entry,
                {
                    bubbles: true
                }
            );

            dispatch(
                document,
                "speciedex:terminal-log-entry",
                entry
            );

            this.syncState();
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
                                String(
                                    entry.category
                                ).toLowerCase() ===
                                category
                            ) &&
                            (
                                !source ||
                                String(
                                    entry.source
                                ).toLowerCase() ===
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

            return parseBoolean(
                options.newestFirst,
                false
            )
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
                Object.create(null);

            const bySource =
                Object.create(null);

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
            const raw =
                String(level ?? "")
                    .trim()
                    .toLowerCase();

            if (
                raw !== "warn" &&
                raw !== "fatal" &&
                !LEVELS.includes(raw)
            ) {
                throw new Error(
                    `Unsupported log level: ${level}`
                );
            }

            const normalized =
                normalizeLevel(level);

            this.options.minimumLevel =
                normalized;

            this.emit(
                "level",
                {
                    level:
                        normalized
                }
            );

            this.syncState();

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
                const removed =
                    this.entries.length -
                    this.options.limit;

                this.entries =
                    this.entries.slice(
                        -this.options.limit
                    );

                this.dropped +=
                    removed;
            }

            this.emit(
                "limit",
                {
                    limit:
                        this.options.limit
                }
            );

            this.syncState();

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
            this.assertActive();

            const count =
                this.entries.length;

            this.entries = [];
            this.pendingEntries = [];

            this.emit(
                "clear",
                {
                    count,
                    dropped:
                        this.dropped
                }
            );

            this.syncState();

            return count;
        }

        toJSON(
            options = {}
        ) {
            return safeStringify(
                this.export(
                    options
                ),
                parseBoolean(
                    options.compact,
                    false
                )
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
                        safeStringify(
                            entry,
                            true
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
                    nowISO(),

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

                ready:
                    this.ready,

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

                watchers:
                    this.watchers.size,

                counts:
                    this.counts()
            };
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            try {
                this.abortController?.abort?.();
            } catch (_error) {
                /* Continue teardown. */
            }

            for (
                const dispose
                of this.boundListeners.splice(0)
            ) {
                try {
                    dispose();
                } catch (_error) {
                    /* Continue teardown. */
                }
            }

            this.emit(
                "destroy",
                {
                    version:
                        VERSION
                }
            );

            this.subscribers.clear();
            this.watchers.clear();
            this.pendingEntries = [];
            this.entries = [];
            this.batchDepth = 0;

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

            this.ready =
                false;

            this.destroyed =
                true;

            return true;
        }

    }

    /*
    ==========================================================================
    Initialization
    ==========================================================================
    */

    function initialize(
        context = {}
    ) {
        const safeContext =
            isObject(context)
                ? context
                : {};

        const root =
            safeContext.root &&
            typeof safeContext.root.dispatchEvent ===
                "function"
                ? safeContext.root
                : document.documentElement;

        const existing =
            safeContext.log instanceof
                TerminalLogger
                ? safeContext.log
                : safeContext.logger instanceof
                    TerminalLogger
                    ? safeContext.logger
                    : safeContext.services?.get?.(
                        "log"
                    ) ||
                    safeContext.services?.get?.(
                        "logger"
                    ) ||
                    root?.[LOGGER_SYMBOL];

        if (
            existing instanceof TerminalLogger &&
            !existing.destroyed
        ) {
            safeContext.log =
                existing;

            safeContext.logger =
                existing;

            safeContext.registerService?.(
                "log",
                existing
            );

            safeContext.registerService?.(
                "logger",
                existing
            );

            return existing;
        }

        const dataset =
            root.dataset || {};

        const config =
            safeContext.config?.log ||
            safeContext.config?.logger ||
            {};

        const logger =
            new TerminalLogger(
                {
                    ...safeContext,
                    root
                },
                {
                    limit:
                        dataset.terminalLogLimit ||
                        config.limit,
                    minimumLevel:
                        dataset.terminalLogLevel ||
                        config.minimumLevel ||
                        DEFAULT_OPTIONS.minimumLevel,
                    mirrorToConsole:
                        parseBoolean(
                            dataset.terminalLogMirror ??
                            config.mirrorToConsole,
                            DEFAULT_OPTIONS.mirrorToConsole
                        ),
                    captureMetadata:
                        parseBoolean(
                            dataset.terminalLogMetadata ??
                            config.captureMetadata,
                            DEFAULT_OPTIONS.captureMetadata
                        ),
                    captureWindowErrors:
                        parseBoolean(
                            dataset.terminalLogCaptureErrors ??
                            config.captureWindowErrors,
                            DEFAULT_OPTIONS.captureWindowErrors
                        ),
                    captureUnhandledRejections:
                        parseBoolean(
                            dataset.terminalLogCaptureRejections ??
                            config.captureUnhandledRejections,
                            DEFAULT_OPTIONS.captureUnhandledRejections
                        ),
                    maximumMetadataDepth:
                        dataset.terminalLogMetadataDepth ||
                        config.maximumMetadataDepth,
                    maximumMetadataEntries:
                        dataset.terminalLogMetadataEntries ||
                        config.maximumMetadataEntries,
                    maximumMessageLength:
                        dataset.terminalLogMessageLength ||
                        config.maximumMessageLength
                }
            );

        root[LOGGER_SYMBOL] =
            logger;

        safeContext.log =
            logger;

        safeContext.logger =
            logger;

        safeContext.registerService?.(
            "log",
            logger
        );

        safeContext.registerService?.(
            "logger",
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

        logger.syncState();

        dispatch(
            document,
            "speciedex:terminal-log-ready",
            {
                context:
                    safeContext,
                logger,
                version:
                    VERSION
            }
        );

        return logger;
    }

    /*
    ==========================================================================
    Commands
    ==========================================================================
    */

    function resolveCommandContext(payload = {}) {
        return (
            payload.context ||
            payload.terminal?.context ||
            payload.app?.context ||
            payload
        );
    }

    function requireLogger(context) {
        const safeContext =
            isObject(context)
                ? context
                : {};

        const logger =
            safeContext.log instanceof
                TerminalLogger
                ? safeContext.log
                : safeContext.logger instanceof
                    TerminalLogger
                    ? safeContext.logger
                    : safeContext.services?.get?.(
                        "log"
                    ) ||
                    safeContext.services?.get?.(
                        "logger"
                    ) ||
                    initialize(safeContext);

        if (
            !(logger instanceof TerminalLogger) ||
            logger.destroyed
        ) {
            throw new Error(
                "Terminal logging service is unavailable."
            );
        }

        return logger;
    }

    function writeResult(payload, value, type = "data") {
        if (
            typeof payload.writeJSON ===
                "function" &&
            typeof value !== "string"
        ) {
            return payload.writeJSON(value);
        }

        if (
            typeof payload.writeTable ===
                "function" &&
            value?.headers &&
            value?.rows
        ) {
            return payload.writeTable(
                value.headers,
                value.rows
            );
        }

        if (typeof payload.write === "function") {
            return payload.write(
                typeof value === "string"
                    ? value
                    : safeStringify(value),
                type
            );
        }

        if (typeof payload.writeLine === "function") {
            return payload.writeLine(
                typeof value === "string"
                    ? value
                    : safeStringify(value)
            );
        }

        return value;
    }

    const commands =
        [
            {
                name: "log",
                category: "system",
                description:
                    "Display recent terminal log entries.",
                usage:
                    "log [count] [level] [contains]",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    const args =
                        Array.isArray(payload.args)
                            ? payload.args
                            : [];

                    const logger =
                        requireLogger(context);

                    const count =
                        clampInteger(
                            args[0],
                            25,
                            1,
                            1000
                        );

                    const rawLevel =
                        String(
                            args[1] || ""
                        ).trim().toLowerCase();

                    const level =
                        rawLevel &&
                        (
                            LEVELS.includes(rawLevel) ||
                            rawLevel === "warn" ||
                            rawLevel === "fatal"
                        )
                            ? normalizeLevel(rawLevel)
                            : null;

                    const contains =
                        level
                            ? args.slice(2).join(" ")
                            : args.slice(1).join(" ");

                    const entries =
                        logger.list({
                            limit:
                                count,
                            level,
                            contains
                        });

                    if (
                        typeof payload.writeTable ===
                            "function"
                    ) {
                        return writeResult(
                            payload,
                            {
                                headers: [
                                    "Time",
                                    "Level",
                                    "Category",
                                    "Source",
                                    "Message"
                                ],
                                rows:
                                    entries.map(
                                        entry => [
                                            entry.timestamp,
                                            entry.level,
                                            entry.category,
                                            entry.source,
                                            entry.message
                                        ]
                                    )
                            }
                        );
                    }

                    return writeResult(
                        payload,
                        entries
                    );
                }
            },

            {
                name: "log-status",
                category: "system",
                description:
                    "Display terminal logging service status.",
                usage:
                    "log-status",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    return writeResult(
                        payload,
                        requireLogger(
                            context
                        ).status()
                    );
                }
            },

            {
                name: "log-level",
                category: "system",
                description:
                    "Display or set the minimum captured log level.",
                usage:
                    "log-level [trace|debug|info|success|warning|error|critical]",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    const args =
                        Array.isArray(payload.args)
                            ? payload.args
                            : [];

                    const logger =
                        requireLogger(context);

                    if (!args[0]) {
                        return writeResult(
                            payload,
                            `Log level: ${logger.options.minimumLevel}`
                        );
                    }

                    const level =
                        logger.setLevel(
                            args[0]
                        );

                    return writeResult(
                        payload,
                        `Log level: ${level}`,
                        "success"
                    );
                }
            },

            {
                name: "log-counts",
                category: "system",
                description:
                    "Display log-entry counts by level, category, and source.",
                usage:
                    "log-counts",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    return writeResult(
                        payload,
                        requireLogger(
                            context
                        ).counts()
                    );
                }
            },

            {
                name: "log-clear",
                category: "system",
                description:
                    "Clear retained terminal log entries.",
                usage:
                    "log-clear",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    const count =
                        requireLogger(
                            context
                        ).clear();

                    return writeResult(
                        payload,
                        `Cleared ${count} log entr${count === 1 ? "y" : "ies"}.`,
                        "success"
                    );
                }
            },

            {
                name: "log-tail",
                category: "system",
                description:
                    "Display newest retained log entries first.",
                usage:
                    "log-tail [count]",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    const args =
                        Array.isArray(payload.args)
                            ? payload.args
                            : [];

                    return writeResult(
                        payload,
                        requireLogger(
                            context
                        ).latest(
                            clampInteger(
                                args[0],
                                25,
                                1,
                                1000
                            )
                        )
                    );
                }
            },

            {
                name: "log-limit",
                category: "system",
                description:
                    "Display or set retained log-entry capacity.",
                usage:
                    "log-limit [count]",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    const args =
                        Array.isArray(payload.args)
                            ? payload.args
                            : [];

                    const logger =
                        requireLogger(context);

                    if (!args[0]) {
                        return writeResult(
                            payload,
                            `Log limit: ${logger.options.limit}`
                        );
                    }

                    const limit =
                        logger.setLimit(
                            args[0]
                        );

                    return writeResult(
                        payload,
                        `Log limit: ${limit}`,
                        "success"
                    );
                }
            },

            {
                name: "log-mirror",
                category: "system",
                description:
                    "Enable or disable browser-console mirroring.",
                usage:
                    "log-mirror [on|off]",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    const args =
                        Array.isArray(payload.args)
                            ? payload.args
                            : [];

                    const logger =
                        requireLogger(context);

                    if (!args[0]) {
                        return writeResult(
                            payload,
                            `Console mirroring: ${logger.options.mirrorToConsole ? "on" : "off"}`
                        );
                    }

                    logger.options.mirrorToConsole =
                        parseBoolean(
                            args[0],
                            logger.options.mirrorToConsole
                        );

                    logger.emit(
                        "mirror",
                        {
                            enabled:
                                logger.options.mirrorToConsole
                        }
                    );

                    return writeResult(
                        payload,
                        `Console mirroring: ${logger.options.mirrorToConsole ? "on" : "off"}`,
                        "success"
                    );
                }
            },

            {
                name: "log-export",
                category: "system",
                description:
                    "Export terminal logs as JSON.",
                usage:
                    "log-export [filename] [json|jsonl|txt]",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    const args =
                        Array.isArray(payload.args)
                            ? payload.args
                            : [];

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

                    const logger =
                        requireLogger(context);

                    const content =
                        format === "jsonl" ||
                        format === "ndjson"
                            ? logger.toJSONL()
                            : format === "txt" ||
                              format === "text"
                                ? logger.toText()
                                : logger.toJSON();

                    const mimeType =
                        format === "jsonl" ||
                        format === "ndjson"
                            ? "application/x-ndjson"
                            : format === "txt" ||
                              format === "text"
                                ? "text/plain;charset=utf-8"
                                : "application/json;charset=utf-8";

                    const exporter =
                        context.exporter ||
                        context.services?.get?.(
                            "export"
                        ) ||
                        context.services?.get?.(
                            "exporter"
                        );

                    if (
                        exporter &&
                        typeof exporter.download ===
                            "function"
                    ) {
                        exporter.download(
                            content,
                            filename,
                            mimeType
                        );
                    } else {
                        if (
                            typeof URL?.createObjectURL !==
                                "function"
                        ) {
                            throw new Error(
                                "Browser download URLs are unavailable."
                            );
                        }

                        const blob =
                            new Blob(
                                [content],
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

                        (document.body ||
                            document.documentElement)
                            .appendChild(anchor);

                        try {
                            anchor.click();
                        } finally {
                            anchor.remove();

                            window.setTimeout(
                                () =>
                                    URL.revokeObjectURL(
                                        url
                                    ),
                                1000
                            );
                        }
                    }

                    return writeResult(
                        payload,
                        `Log exported to ${filename}.`,
                        "success"
                    );
                }
            },

            {
                name: "log-test",
                category: "system",
                description:
                    "Write one test entry at each log level.",
                usage:
                    "log-test",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    const logger =
                        requireLogger(context);

                    for (const level of LEVELS) {
                        logger.push(
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

                    return writeResult(
                        payload,
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
            safeStringify,
            parseBoolean,
            clampInteger,
            dispatch,
            resolveCommandContext,

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

    dispatch(
        document,
        "speciedex:terminal-module-available",
        {
            name:
                MODULE_NAME,
            module:
                api
        }
    );
})(window, document);
