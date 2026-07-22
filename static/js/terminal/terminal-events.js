/*
========================================================================
Speciedex.org
Terminal Event Bus
========================================================================

Structured event service for SpeciedexTerminal.

Provides:

    • Synchronous and asynchronous event emission
    • Standard, one-shot, and wildcard subscriptions
    • Listener cleanup and teardown tracking
    • Event history and inspection
    • Namespaced child buses
    • DOM event bridging
    • Terminal command integration

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Events";
    const VERSION = "2.0.0";

    const DEFAULT_HISTORY_LIMIT = 250;
    const MIN_HISTORY_LIMIT = 10;
    const MAX_HISTORY_LIMIT = 5000;

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
            Fall through to a local identifier.
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

    function normalizeName(name) {
        const value =
            String(name ?? "")
                .trim();

        if (!value) {
            throw new TypeError(
                "An event name is required."
            );
        }

        return value;
    }

    function normalizeNamespace(namespace) {
        return String(namespace ?? "")
            .trim()
            .replace(/:+$/g, "");
    }

    function matchesPattern(pattern, name) {
        if (pattern === "*") {
            return true;
        }

        if (!pattern.includes("*")) {
            return pattern === name;
        }

        const escaped =
            pattern
                .split("*")
                .map(part =>
                    part.replace(
                        /[.*+?^${}()|[\]\\]/g,
                        "\\$&"
                    )
                )
                .join(".*");

        return new RegExp(
            `^${escaped}$`
        ).test(name);
    }

    function safeClone(value) {
        if (
            value === null ||
            value === undefined
        ) {
            return value;
        }

        if (
            typeof structuredClone ===
            "function"
        ) {
            try {
                return structuredClone(value);
            } catch (_error) {
                /*
                ----------------------------------------------------------------
                Fall through to a conservative JSON clone.
                ----------------------------------------------------------------
                */
            }
        }

        try {
            return JSON.parse(
                JSON.stringify(value)
            );
        } catch (_error) {
            return String(value);
        }
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
                        composed:
                            options.composed === true,
                        detail
                    }
                )
            );
        } catch (_error) {
            return false;
        }
    }

    class EventBus extends EventTarget {
        constructor(options = {}) {
            super();

            this.namespace =
                normalizeNamespace(
                    options.namespace
                );

            this.historyLimit =
                clampInteger(
                    options.historyLimit,
                    DEFAULT_HISTORY_LIMIT,
                    MIN_HISTORY_LIMIT,
                    MAX_HISTORY_LIMIT
                );

            this.history = [];
            this.subscriptions = new Map();
            this.wildcardSubscriptions = new Map();
            this.bridges = new Map();
            this.destroyed = false;
        }

        qualify(name) {
            const normalized =
                normalizeName(name);

            if (!this.namespace) {
                return normalized;
            }

            if (
                normalized.startsWith(
                    `${this.namespace}:`
                )
            ) {
                return normalized;
            }

            return `${this.namespace}:${normalized}`;
        }

        record(name, detail, metadata = {}) {
            const entry = {
                id: createId(),
                timestamp: nowISO(),
                name,
                detail:
                    safeClone(detail),
                metadata:
                    safeClone(metadata)
            };

            this.history.push(entry);

            if (
                this.history.length >
                this.historyLimit
            ) {
                this.history.splice(
                    0,
                    this.history.length -
                    this.historyLimit
                );
            }

            return entry;
        }

        emit(name, detail = {}, options = {}) {
            if (this.destroyed) {
                throw new Error(
                    "Event bus has been destroyed."
                );
            }

            const qualified =
                this.qualify(name);

            const entry =
                options.record === false
                    ? null
                    : this.record(
                        qualified,
                        detail,
                        {
                            cancelable:
                                options.cancelable === true,
                            bubbles:
                                options.bubbles === true
                        }
                    );

            const event =
                new CustomEvent(
                    qualified,
                    {
                        detail,
                        cancelable:
                            options.cancelable === true
                    }
                );

            const allowed =
                this.dispatchEvent(event);

            this.dispatchWildcards(
                qualified,
                detail,
                entry
            );

            if (options.document === true) {
                dispatch(
                    document,
                    qualified,
                    detail,
                    {
                        bubbles:
                            options.bubbles === true,
                        cancelable:
                            options.cancelable === true,
                        composed:
                            options.composed === true
                    }
                );
            }

            return {
                name: qualified,
                detail,
                entry,
                defaultPrevented:
                    event.defaultPrevented,
                allowed
            };
        }

        async emitAsync(name, detail = {}, options = {}) {
            if (this.destroyed) {
                throw new Error(
                    "Event bus has been destroyed."
                );
            }

            const qualified =
                this.qualify(name);

            const entry =
                options.record === false
                    ? null
                    : this.record(
                        qualified,
                        detail,
                        {
                            asynchronous: true
                        }
                    );

            const listeners = [
                ...(
                    this.subscriptions.get(
                        qualified
                    ) || []
                )
            ];

            const wildcardListeners = [];

            for (
                const [
                    pattern,
                    records
                ] of
                this.wildcardSubscriptions
            ) {
                if (
                    matchesPattern(
                        pattern,
                        qualified
                    )
                ) {
                    wildcardListeners.push(
                        ...records
                    );
                }
            }

            const results = [];
            const errors = [];

            for (
                const record of
                [
                    ...listeners,
                    ...wildcardListeners
                ]
            ) {
                if (!record.active) {
                    continue;
                }

                try {
                    const result =
                        await record.listener({
                            type: qualified,
                            detail,
                            entry,
                            bus: this
                        });

                    results.push(result);
                } catch (error) {
                    errors.push(error);

                    if (
                        options.stopOnError ===
                        true
                    ) {
                        throw error;
                    }
                }

                if (record.once) {
                    record.unsubscribe();
                }
            }

            return {
                name: qualified,
                detail,
                entry,
                results,
                errors
            };
        }

        dispatchWildcards(name, detail, entry) {
            for (
                const [
                    pattern,
                    records
                ] of
                this.wildcardSubscriptions
            ) {
                if (
                    !matchesPattern(
                        pattern,
                        name
                    )
                ) {
                    continue;
                }

                for (const record of [...records]) {
                    if (!record.active) {
                        continue;
                    }

                    try {
                        record.listener({
                            type: name,
                            detail,
                            entry,
                            bus: this
                        });
                    } catch (error) {
                        window.console?.error?.(
                            "Speciedex terminal wildcard event listener failed:",
                            error
                        );
                    }

                    if (record.once) {
                        record.unsubscribe();
                    }
                }
            }
        }

        on(name, listener, options = {}) {
            if (this.destroyed) {
                throw new Error(
                    "Event bus has been destroyed."
                );
            }

            if (
                typeof listener !==
                "function"
            ) {
                throw new TypeError(
                    "An event listener function is required."
                );
            }

            const pattern =
                this.qualify(name);

            if (pattern.includes("*")) {
                return this.onWildcard(
                    pattern,
                    listener,
                    options
                );
            }

            const wrapped =
                event => listener(
                    event,
                    event.detail
                );

            this.addEventListener(
                pattern,
                wrapped,
                options
            );

            const record = {
                id: createId(),
                name: pattern,
                listener,
                wrapped,
                once:
                    options.once === true,
                active: true,
                unsubscribe: null
            };

            const collection =
                this.subscriptions.get(
                    pattern
                ) || new Set();

            collection.add(record);
            this.subscriptions.set(
                pattern,
                collection
            );

            const unsubscribe = () => {
                if (!record.active) {
                    return false;
                }

                record.active = false;

                this.removeEventListener(
                    pattern,
                    wrapped,
                    options
                );

                collection.delete(record);

                if (!collection.size) {
                    this.subscriptions.delete(
                        pattern
                    );
                }

                return true;
            };

            record.unsubscribe =
                unsubscribe;

            return unsubscribe;
        }

        onWildcard(pattern, listener, options = {}) {
            const normalized =
                this.qualify(pattern);

            const collection =
                this.wildcardSubscriptions.get(
                    normalized
                ) || new Set();

            const record = {
                id: createId(),
                pattern: normalized,
                listener,
                once:
                    options.once === true,
                active: true,
                unsubscribe: null
            };

            collection.add(record);

            this.wildcardSubscriptions.set(
                normalized,
                collection
            );

            const unsubscribe = () => {
                if (!record.active) {
                    return false;
                }

                record.active = false;
                collection.delete(record);

                if (!collection.size) {
                    this.wildcardSubscriptions.delete(
                        normalized
                    );
                }

                return true;
            };

            record.unsubscribe =
                unsubscribe;

            return unsubscribe;
        }

        once(name, listener, options = {}) {
            return this.on(
                name,
                listener,
                {
                    ...options,
                    once: true
                }
            );
        }

        off(name, listener = null) {
            const normalized =
                this.qualify(name);

            if (normalized.includes("*")) {
                const records =
                    this.wildcardSubscriptions.get(
                        normalized
                    );

                if (!records) {
                    return 0;
                }

                let removed = 0;

                for (const record of [...records]) {
                    if (
                        listener &&
                        record.listener !== listener
                    ) {
                        continue;
                    }

                    if (record.unsubscribe()) {
                        removed += 1;
                    }
                }

                return removed;
            }

            const records =
                this.subscriptions.get(
                    normalized
                );

            if (!records) {
                return 0;
            }

            let removed = 0;

            for (const record of [...records]) {
                if (
                    listener &&
                    record.listener !== listener
                ) {
                    continue;
                }

                if (record.unsubscribe()) {
                    removed += 1;
                }
            }

            return removed;
        }

        clear(name = null) {
            if (name) {
                return this.off(name);
            }

            let removed = 0;

            for (
                const records of
                this.subscriptions.values()
            ) {
                for (const record of [...records]) {
                    if (record.unsubscribe()) {
                        removed += 1;
                    }
                }
            }

            for (
                const records of
                this.wildcardSubscriptions.values()
            ) {
                for (const record of [...records]) {
                    if (record.unsubscribe()) {
                        removed += 1;
                    }
                }
            }

            return removed;
        }

        waitFor(name, options = {}) {
            const timeout =
                Number(options.timeout) || 0;

            const signal =
                options.signal || null;

            return new Promise(
                (resolve, reject) => {
                    let timer = null;

                    const cleanup = () => {
                        unsubscribe();

                        if (timer !== null) {
                            window.clearTimeout(timer);
                        }

                        signal?.removeEventListener?.(
                            "abort",
                            onAbort
                        );
                    };

                    const onAbort = () => {
                        cleanup();

                        reject(
                            signal.reason ||
                            new DOMException(
                                "The operation was aborted.",
                                "AbortError"
                            )
                        );
                    };

                    const unsubscribe =
                        this.once(
                            name,
                            event => {
                                cleanup();

                                resolve(
                                    event.detail
                                );
                            }
                        );

                    if (timeout > 0) {
                        timer =
                            window.setTimeout(
                                () => {
                                    cleanup();

                                    reject(
                                        new Error(
                                            `Timed out waiting for event "${name}".`
                                        )
                                    );
                                },
                                timeout
                            );
                    }

                    if (signal) {
                        if (signal.aborted) {
                            onAbort();
                            return;
                        }

                        signal.addEventListener(
                            "abort",
                            onAbort,
                            {
                                once: true
                            }
                        );
                    }
                }
            );
        }

        bridge(target, sourceName, targetName = sourceName, options = {}) {
            if (
                !target ||
                typeof target.addEventListener !==
                "function"
            ) {
                throw new TypeError(
                    "A valid event target is required."
                );
            }

            const bridgeId =
                createId();

            const handler = event => {
                this.emit(
                    targetName,
                    event.detail ?? event,
                    {
                        record:
                            options.record !== false
                    }
                );
            };

            target.addEventListener(
                sourceName,
                handler,
                options.listenerOptions
            );

            const remove = () => {
                if (
                    !this.bridges.has(
                        bridgeId
                    )
                ) {
                    return false;
                }

                target.removeEventListener(
                    sourceName,
                    handler,
                    options.listenerOptions
                );

                this.bridges.delete(
                    bridgeId
                );

                return true;
            };

            this.bridges.set(
                bridgeId,
                {
                    id: bridgeId,
                    target,
                    sourceName,
                    targetName,
                    remove
                }
            );

            return remove;
        }

        scope(namespace) {
            const childNamespace =
                [
                    this.namespace,
                    normalizeNamespace(
                        namespace
                    )
                ]
                    .filter(Boolean)
                    .join(":");

            return new ScopedEventBus(
                this,
                childNamespace
            );
        }

        list(options = {}) {
            const name =
                options.name
                    ? this.qualify(
                        options.name
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
                    100,
                    1,
                    this.historyLimit
                );

            const entries =
                this.history.filter(entry =>
                    (
                        !name ||
                        matchesPattern(
                            name,
                            entry.name
                        )
                    ) &&
                    (
                        !contains ||
                        entry.name
                            .toLowerCase()
                            .includes(contains) ||
                        JSON.stringify(
                            entry.detail
                        )
                            .toLowerCase()
                            .includes(contains)
                    )
                );

            const sliced =
                entries.slice(-limit);

            return options.newestFirst
                ? [...sliced].reverse()
                : sliced;
        }

        setHistoryLimit(limit) {
            this.historyLimit =
                clampInteger(
                    limit,
                    this.historyLimit,
                    MIN_HISTORY_LIMIT,
                    MAX_HISTORY_LIMIT
                );

            if (
                this.history.length >
                this.historyLimit
            ) {
                this.history.splice(
                    0,
                    this.history.length -
                    this.historyLimit
                );
            }

            return this.historyLimit;
        }

        clearHistory() {
            const count =
                this.history.length;

            this.history.length = 0;

            return count;
        }

        status() {
            let listenerCount = 0;
            let wildcardCount = 0;

            for (
                const records of
                this.subscriptions.values()
            ) {
                listenerCount +=
                    records.size;
            }

            for (
                const records of
                this.wildcardSubscriptions.values()
            ) {
                wildcardCount +=
                    records.size;
            }

            return {
                version: VERSION,
                namespace:
                    this.namespace || null,
                listeners:
                    listenerCount,
                wildcardListeners:
                    wildcardCount,
                eventNames:
                    [...this.subscriptions.keys()],
                wildcardPatterns:
                    [...this.wildcardSubscriptions.keys()],
                bridges:
                    this.bridges.size,
                history:
                    this.history.length,
                historyLimit:
                    this.historyLimit,
                destroyed:
                    this.destroyed
            };
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            this.clear();

            for (
                const bridge of
                [...this.bridges.values()]
            ) {
                bridge.remove();
            }

            this.clearHistory();
            this.destroyed = true;

            return true;
        }
    }

    class ScopedEventBus {
        constructor(parent, namespace) {
            this.parent = parent;
            this.namespace =
                normalizeNamespace(
                    namespace
                );
        }

        qualify(name) {
            const normalized =
                normalizeName(name);

            if (!this.namespace) {
                return normalized;
            }

            return `${this.namespace}:${normalized}`;
        }

        emit(name, detail = {}, options = {}) {
            return this.parent.emit(
                this.qualify(name),
                detail,
                options
            );
        }

        emitAsync(name, detail = {}, options = {}) {
            return this.parent.emitAsync(
                this.qualify(name),
                detail,
                options
            );
        }

        on(name, listener, options = {}) {
            return this.parent.on(
                this.qualify(name),
                listener,
                options
            );
        }

        once(name, listener, options = {}) {
            return this.parent.once(
                this.qualify(name),
                listener,
                options
            );
        }

        off(name, listener = null) {
            return this.parent.off(
                this.qualify(name),
                listener
            );
        }

        waitFor(name, options = {}) {
            return this.parent.waitFor(
                this.qualify(name),
                options
            );
        }

        scope(namespace) {
            return new ScopedEventBus(
                this.parent,
                [
                    this.namespace,
                    normalizeNamespace(
                        namespace
                    )
                ]
                    .filter(Boolean)
                    .join(":")
            );
        }
    }

    function initialize(context) {
        if (
            context.events instanceof
            EventBus &&
            !context.events.destroyed
        ) {
            return context.events;
        }

        const dataset =
            context.root?.dataset || {};

        const bus =
            new EventBus({
                historyLimit:
                    dataset.
                        terminalEventHistoryLimit,
                namespace:
                    dataset.
                        terminalEventNamespace ||
                    ""
            });

        context.events = bus;

        context.registerService?.(
            "events",
            bus
        );

        dispatch(
            document,
            "speciedex:terminal-events-ready",
            {
                context,
                events: bus
            }
        );

        return bus;
    }

    function requireBus(context) {
        if (
            !(context?.events instanceof EventBus)
        ) {
            throw new Error(
                "Terminal event service is unavailable."
            );
        }

        return context.events;
    }

    function parseDetail(args) {
        if (!args.length) {
            return {};
        }

        const text =
            args.join(" ");

        try {
            return JSON.parse(text);
        } catch (_error) {
            return {
                value: text
            };
        }
    }

    const commands = [
        {
            name: "events",
            aliases: [
                "event-status"
            ],
            category: "system",
            description:
                "Inspect the terminal event bus.",
            usage:
                "events [status|history [pattern] [limit]|clear-history|limit <count>]",
            handler: ({
                args = [],
                context,
                writeJSON,
                write
            }) => {
                const bus =
                    requireBus(context);

                const action =
                    String(args[0] || "status")
                        .toLowerCase();

                if (action === "history") {
                    const result =
                        bus.list({
                            name:
                                args[1] || null,
                            limit:
                                args[2] || 100
                        });

                    return typeof writeJSON ===
                        "function"
                            ? writeJSON(result)
                            : result;
                }

                if (
                    action ===
                    "clear-history"
                ) {
                    const count =
                        bus.clearHistory();

                    return write?.(
                        `Cleared ${count} event-history entr${count === 1 ? "y" : "ies"}.`,
                        "success"
                    );
                }

                if (action === "limit") {
                    if (!args[1]) {
                        return write?.(
                            `Event history limit: ${bus.historyLimit}`,
                            "info"
                        );
                    }

                    const limit =
                        bus.setHistoryLimit(
                            args[1]
                        );

                    return write?.(
                        `Event history limit: ${limit}`,
                        "success"
                    );
                }

                if (action !== "status") {
                    throw new Error(
                        `Unknown events action: ${action}`
                    );
                }

                const status =
                    bus.status();

                return typeof writeJSON ===
                    "function"
                        ? writeJSON(status)
                        : status;
            }
        },
        {
            name: "event-emit",
            aliases: [
                "emit"
            ],
            category: "system",
            description:
                "Emit a terminal event.",
            usage:
                "event-emit <name> [JSON or text detail]",
            handler: ({
                args = [],
                context,
                writeJSON
            }) => {
                const bus =
                    requireBus(context);

                const name =
                    args[0];

                if (!name) {
                    throw new Error(
                        "An event name is required."
                    );
                }

                const result =
                    bus.emit(
                        name,
                        parseDetail(
                            args.slice(1)
                        )
                    );

                const output = {
                    name:
                        result.name,
                    defaultPrevented:
                        result.defaultPrevented,
                    entry:
                        result.entry
                };

                return typeof writeJSON ===
                    "function"
                        ? writeJSON(output)
                        : output;
            }
        }
    ];

    const api = Object.freeze({
        name: MODULE_NAME,
        version: VERSION,
        EventBus,
        ScopedEventBus,
        matchesPattern,
        normalizeName,
        normalizeNamespace,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalEvents =
        api;

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
