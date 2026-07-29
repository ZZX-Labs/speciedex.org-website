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
    const VERSION = "2.3.0";

    const RELEASE_CHANNEL =
        "System Prototype";

    const PRODUCT_LABEL =
        "SpeciedexTerminal System Prototype 0.0.0a";

    const EVENTS_SYMBOL =
        Symbol.for(
            "speciedex.terminal.events.bus"
        );

    const DEFAULT_HISTORY_LIMIT = 250;
    const MIN_HISTORY_LIMIT = 10;
    const MAX_HISTORY_LIMIT = 5000;
    const DEFAULT_MAX_LISTENERS = 10000;
    const DEFAULT_MAX_WILDCARD_LISTENERS = 5000;
    const DEFAULT_MAX_BRIDGES = 512;
    const DEFAULT_ASYNC_CONCURRENCY = 16;
    const DEFAULT_MAX_EMIT_DEPTH = 64;
    const DEFAULT_CLONE_DEPTH = 32;
    const RESERVED_NAMES =
        new Set([
            "__proto__",
            "prototype",
            "constructor"
        ]);

    const activeDispatches =
        new WeakMap();

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
                .normalize("NFKC")
                .trim()
                .replace(/\s+/g, "-");

        if (!value) {
            throw new TypeError(
                "An event name is required."
            );
        }

        if (
            RESERVED_NAMES.has(value) ||
            value.includes("\u0000")
        ) {
            throw new TypeError(
                `Reserved or invalid event name: ${value}`
            );
        }

        return value;
    }

    function normalizeNamespace(namespace) {
        const value =
            String(
                namespace ??
                ""
            )
                .normalize(
                    "NFKC"
                )
                .trim()
                .replace(
                    /^:+|:+$/g,
                    ""
                )
                .replace(
                    /\s+/g,
                    "-"
                );

        if (!value) {
            return "";
        }

        if (
            value.includes(
                "\u0000"
            ) ||
            value
                .split(":")
                .some(
                    part =>
                        !part ||
                        RESERVED_NAMES.has(
                            part
                        )
                )
        ) {
            throw new TypeError(
                `Reserved or invalid event namespace: ${value}`
            );
        }

        return value;
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

    function safeClone(
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
            DEFAULT_CLONE_DEPTH
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
            return `[Circular -> ${seen.get(value)}]`;
        }

        seen.set(
            value,
            `$depth:${depth}`
        );

        if (
            value instanceof
                Date
        ) {
            return Number.isNaN(
                value.getTime()
            )
                ? "Invalid Date"
                : value.toISOString();
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
            Array.isArray(
                value
            )
        ) {
            return value.map(
                item =>
                    safeClone(
                        item,
                        seen,
                        depth +
                            1
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
                ] of value
            ) {
                const normalizedKey =
                    String(
                        key
                    );

                if (
                    RESERVED_NAMES.has(
                        normalizedKey
                    )
                ) {
                    continue;
                }

                output[
                    normalizedKey
                ] =
                    safeClone(
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
                    safeClone(
                        item,
                        seen,
                        depth +
                            1
                    )
            );
        }

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
                RESERVED_NAMES.has(
                    key
                )
            ) {
                continue;
            }

            try {
                output[
                    key
                ] =
                    safeClone(
                        item,
                        seen,
                        depth +
                            1
                    );
            } catch (error) {
                output[
                    key
                ] =
                    `[Unclonable: ${error?.message || error}]`;
            }
        }

        return output;
    }

    function parseJSON(
        value
    ) {
        return JSON.parse(
            value,
            (
                key,
                item
            ) =>
                RESERVED_NAMES.has(
                    key
                )
                    ? undefined
                    : item
        );
    }

    function isAbortError(
        error
    ) {
        return Boolean(
            error &&
            (
                error.name ===
                    "AbortError" ||
                error.code ===
                    20
            )
        );
    }

    function createAbortError(
        message =
            "The operation was aborted."
    ) {
        try {
            return new DOMException(
                message,
                "AbortError"
            );
        } catch (_error) {
            const error =
                new Error(
                    message
                );

            error.name =
                "AbortError";

            return error;
        }
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
                        composed:
                            options.composed === true,
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

            this.maxListeners =
                clampInteger(
                    options.maxListeners,
                    DEFAULT_MAX_LISTENERS,
                    1,
                    1000000
                );

            this.maxWildcardListeners =
                clampInteger(
                    options.maxWildcardListeners,
                    DEFAULT_MAX_WILDCARD_LISTENERS,
                    1,
                    1000000
                );

            this.maxBridges =
                clampInteger(
                    options.maxBridges,
                    DEFAULT_MAX_BRIDGES,
                    1,
                    100000
                );

            this.asyncConcurrency =
                clampInteger(
                    options.asyncConcurrency,
                    DEFAULT_ASYNC_CONCURRENCY,
                    1,
                    1024
                );

            this.maxEmitDepth =
                clampInteger(
                    options.maxEmitDepth,
                    DEFAULT_MAX_EMIT_DEPTH,
                    1,
                    1024
                );

            this.history = [];
            this.subscriptions = new Map();
            this.wildcardSubscriptions = new Map();
            this.bridges = new Map();
            this.scopes = new Set();
            this.destroyed = false;
            this.emitDepth = 0;
            this.activeEmissions = new Map();
            this.metrics = {
                emitted: 0,
                emittedAsync: 0,
                recorded: 0,
                listenerErrors: 0,
                wildcardErrors: 0,
                subscriptions: 0,
                unsubscriptions: 0,
                waits: 0,
                waitTimeouts: 0,
                waitAborts: 0,
                bridgesCreated: 0,
                bridgesRemoved: 0,
                recursionRejected: 0
            };
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

        listenerCount() {
            let count =
                0;

            for (
                const records of
                this.subscriptions.values()
            ) {
                count +=
                    records.size;
            }

            return count;
        }

        wildcardListenerCount() {
            let count =
                0;

            for (
                const records of
                this.wildcardSubscriptions.values()
            ) {
                count +=
                    records.size;
            }

            return count;
        }

        assertAvailable() {
            if (
                this.destroyed
            ) {
                throw new Error(
                    "Event bus has been destroyed."
                );
            }
        }

        enterEmission(
            name
        ) {
            if (
                this.emitDepth >=
                this.maxEmitDepth
            ) {
                this.metrics.recursionRejected += 1;

                throw new RangeError(
                    `Maximum event emission depth exceeded: ${this.maxEmitDepth}`
                );
            }

            this.emitDepth += 1;

            this.activeEmissions.set(
                name,
                (
                    this.activeEmissions.get(name) ||
                    0
                ) + 1
            );
        }

        leaveEmission(
            name
        ) {
            this.emitDepth =
                Math.max(
                    0,
                    this.emitDepth - 1
                );

            const count =
                (
                    this.activeEmissions.get(name) ||
                    1
                ) - 1;

            if (count <= 0) {
                this.activeEmissions.delete(name);
            } else {
                this.activeEmissions.set(
                    name,
                    count
                );
            }
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

            this.history.push(
                entry
            );

            this.metrics.recorded +=
                1;

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

        emit(
            name,
            detail =
                {},
            options =
                {}
        ) {
            this.assertAvailable();

            const qualified =
                this.qualify(
                    name
                );

            this.enterEmission(
                qualified
            );

            try {
                const entry =
                    options.record ===
                        false
                        ? null
                        : this.record(
                            qualified,
                            detail,
                            {
                                cancelable:
                                    options.cancelable ===
                                    true,
                                bubbles:
                                    options.bubbles ===
                                    true
                            }
                        );

                const event =
                    new CustomEvent(
                        qualified,
                        {
                            detail,
                            cancelable:
                                options.cancelable ===
                                true
                        }
                    );

                const allowed =
                    this.dispatchEvent(
                        event
                    );

                this.dispatchWildcards(
                    qualified,
                    detail,
                    entry
                );

                if (
                    options.document ===
                        true
                ) {
                    dispatch(
                        document,
                        qualified,
                        detail,
                        {
                            bubbles:
                                options.bubbles ===
                                true,
                            cancelable:
                                options.cancelable ===
                                true,
                            composed:
                                options.composed ===
                                true
                        }
                    );
                }

                this.metrics.emitted +=
                    1;

                return {
                    name:
                        qualified,
                    detail,
                    entry,
                    defaultPrevented:
                        event.defaultPrevented,
                    allowed
                };
            } finally {
                this.leaveEmission(
                    qualified
                );
            }
        }

        async emitAsync(
            name,
            detail =
                {},
            options =
                {}
        ) {
            this.assertAvailable();

            const qualified =
                this.qualify(
                    name
                );

            const signal =
                options.signal ||
                null;

            if (
                signal?.aborted
            ) {
                throw signal.reason ||
                    createAbortError();
            }

            this.enterEmission(
                qualified
            );

            try {
                const entry =
                    options.record ===
                        false
                        ? null
                        : this.record(
                            qualified,
                            detail,
                            {
                                asynchronous:
                                    true
                            }
                        );

                const listeners = [
                    ...(
                        this.subscriptions.get(
                            qualified
                        ) ||
                        []
                    )
                ];

                const wildcardListeners =
                    [];

                for (
                    const [
                        pattern,
                        records
                    ] of this.wildcardSubscriptions
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

                const records = [
                    ...listeners,
                    ...wildcardListeners
                ].filter(
                    record =>
                        record.active
                );

                const results =
                    new Array(
                        records.length
                    );

                const errors =
                    [];

                let cursor =
                    0;

                const worker =
                    async () => {
                        while (
                            cursor <
                            records.length
                        ) {
                            if (
                                signal?.aborted
                            ) {
                                throw signal.reason ||
                                    createAbortError();
                            }

                            const index =
                                cursor;

                            cursor +=
                                1;

                            const record =
                                records[
                                    index
                                ];

                            try {
                                results[
                                    index
                                ] =
                                    await record.listener({
                                        type:
                                            qualified,
                                        detail,
                                        entry,
                                        bus:
                                            this
                                    });
                            } catch (error) {
                                this.metrics.listenerErrors +=
                                    1;

                                errors.push({
                                    index,
                                    listenerId:
                                        record.id,
                                    error
                                });

                                if (
                                    options.stopOnError ===
                                    true
                                ) {
                                    throw error;
                                }
                            } finally {
                                if (
                                    record.once
                                ) {
                                    record.unsubscribe();
                                }
                            }
                        }
                    };

                const workers =
                    Array.from(
                        {
                            length:
                                Math.min(
                                    this.asyncConcurrency,
                                    Math.max(
                                        1,
                                        records.length
                                    )
                                )
                        },
                        () =>
                            worker()
                    );

                await Promise.all(
                    workers
                );

                this.metrics.emittedAsync +=
                    1;

                return {
                    name:
                        qualified,
                    detail,
                    entry,
                    results,
                    errors
                };
            } finally {
                this.leaveEmission(
                    qualified
                );
            }
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
                        this.metrics.wildcardErrors +=
                            1;

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
            this.assertAvailable();

            if (
                !String(name).includes("*") &&
                this.listenerCount() >=
                    this.maxListeners
            ) {
                throw new RangeError(
                    `Event listener limit reached: ${this.maxListeners}`
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

            let record =
                null;

            const wrapped =
                event => {
                    try {
                        return listener(
                            event,
                            event.detail
                        );
                    } finally {
                        if (
                            record?.once
                        ) {
                            record.unsubscribe();
                        }
                    }
                };

            this.addEventListener(
                pattern,
                wrapped,
                {
                    capture:
                        options.capture ===
                        true,
                    passive:
                        options.passive ===
                        true
                }
            );

            record = {
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

            let abortListener = null;

            const unsubscribe = () => {
                if (!record.active) {
                    return false;
                }

                record.active = false;

                if (
                    abortListener &&
                    options.signal
                ) {
                    options.signal.removeEventListener(
                        "abort",
                        abortListener
                    );
                }

                this.removeEventListener(
                    pattern,
                    wrapped,
                    {
                        capture:
                            options.capture ===
                            true
                    }
                );

                collection.delete(record);

                if (!collection.size) {
                    this.subscriptions.delete(
                        pattern
                    );
                }

                this.metrics.unsubscriptions +=
                    1;

                return true;
            };

            record.unsubscribe =
                unsubscribe;

            this.metrics.subscriptions +=
                1;

            if (options.signal) {
                if (options.signal.aborted) {
                    unsubscribe();
                } else {
                    abortListener = unsubscribe;

                    options.signal.addEventListener(
                        "abort",
                        abortListener,
                        { once: true }
                    );
                }
            }

            return unsubscribe;
        }

        onWildcard(
            pattern,
            listener,
            options =
                {}
        ) {
            this.assertAvailable();

            if (typeof listener !== "function") {
                throw new TypeError(
                    "A wildcard event listener function is required."
                );
            }

            if (
                this.wildcardListenerCount() >=
                this.maxWildcardListeners
            ) {
                throw new RangeError(
                    `Wildcard listener limit reached: ${this.maxWildcardListeners}`
                );
            }

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

            let abortListener = null;

            const unsubscribe = () => {
                if (!record.active) {
                    return false;
                }

                record.active = false;

                if (
                    abortListener &&
                    options.signal
                ) {
                    options.signal.removeEventListener(
                        "abort",
                        abortListener
                    );
                }

                collection.delete(record);

                if (!collection.size) {
                    this.wildcardSubscriptions.delete(
                        normalized
                    );
                }

                this.metrics.unsubscriptions += 1;

                return true;
            };

            record.unsubscribe =
                unsubscribe;

            this.metrics.subscriptions +=
                1;

            if (options.signal) {
                if (options.signal.aborted) {
                    unsubscribe();
                } else {
                    abortListener = unsubscribe;

                    options.signal.addEventListener(
                        "abort",
                        abortListener,
                        { once: true }
                    );
                }
            }

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
            this.assertAvailable();

            this.metrics.waits += 1;

            const timeout =
                Math.max(
                    0,
                    Number(options.timeout) || 0
                );

            const signal =
                options.signal || null;

            return new Promise(
                (resolve, reject) => {
                    let timer = null;
                    let settled = false;
                    let unsubscribe = () => false;

                    const cleanup = () => {
                        unsubscribe();

                        if (timer !== null) {
                            window.clearTimeout(timer);
                            timer = null;
                        }

                        signal?.removeEventListener?.(
                            "abort",
                            onAbort
                        );
                    };

                    const finish = callback => value => {
                        if (settled) {
                            return;
                        }

                        settled = true;
                        cleanup();
                        callback(value);
                    };

                    const resolveOnce =
                        finish(resolve);

                    const rejectOnce =
                        finish(reject);

                    const onAbort = () => {
                        this.metrics.waitAborts += 1;

                        rejectOnce(
                            signal.reason ||
                            createAbortError()
                        );
                    };

                    unsubscribe =
                        this.once(
                            name,
                            event => {
                                resolveOnce(
                                    event.detail
                                );
                            }
                        );

                    if (timeout > 0) {
                        timer =
                            window.setTimeout(
                                () => {
                                    this.metrics.waitTimeouts += 1;

                                    rejectOnce(
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
                            { once: true }
                        );
                    }
                }
            );
        }

        bridge(
            target,
            sourceName,
            targetName =
                sourceName,
            options =
                {}
        ) {
            this.assertAvailable();

            if (
                this.bridges.size >=
                this.maxBridges
            ) {
                throw new RangeError(
                    `Event bridge limit reached: ${this.maxBridges}`
                );
            }

            if (
                !target ||
                typeof target.addEventListener !==
                "function"
            ) {
                throw new TypeError(
                    "A valid event target is required."
                );
            }

            const dedupeKey =
                options.key ||
                `${sourceName}->${targetName}`;

            for (
                const bridge of
                this.bridges.values()
            ) {
                if (
                    bridge.target ===
                        target &&
                    bridge.dedupeKey ===
                        dedupeKey
                ) {
                    return bridge.remove;
                }
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

            const listenerOptions =
                options.listenerOptions || {};

            target.addEventListener(
                sourceName,
                handler,
                listenerOptions
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
                    {
                        capture:
                            listenerOptions.capture === true
                    }
                );

                this.bridges.delete(
                    bridgeId
                );

                this.metrics.bridgesRemoved +=
                    1;

                return true;
            };

            this.bridges.set(
                bridgeId,
                {
                    id: bridgeId,
                    target,
                    sourceName,
                    targetName,
                    dedupeKey,
                    remove
                }
            );

            this.metrics.bridgesCreated +=
                1;

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

            const scope =
                new ScopedEventBus(
                    this,
                    childNamespace
                );

            this.scopes.add(
                scope
            );

            return scope;
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
                        (() => {
                            try {
                                return JSON.stringify(
                                    safeClone(
                                        entry.detail
                                    )
                                )
                                    .toLowerCase()
                                    .includes(
                                        contains
                                    );
                            } catch (_error) {
                                return false;
                            }
                        })()
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
                version:
                    VERSION,

                releaseChannel:
                    RELEASE_CHANNEL,

                productLabel:
                    PRODUCT_LABEL,

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
                scopes:
                    this.scopes.size,
                emitDepth:
                    this.emitDepth,
                activeEmissions:
                    Object.fromEntries(
                        this.activeEmissions
                    ),
                limits: {
                    listeners:
                        this.maxListeners,
                    wildcardListeners:
                        this.maxWildcardListeners,
                    bridges:
                        this.maxBridges,
                    asyncConcurrency:
                        this.asyncConcurrency,
                    emitDepth:
                        this.maxEmitDepth
                },
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

            for (
                const scope of
                [
                    ...this.scopes
                ]
            ) {
                scope.destroy();
            }

            this.scopes.clear();

            this.clear();

            for (
                const bridge of
                [
                    ...this.bridges.values()
                ]
            ) {
                bridge.remove();
            }

            this.clearHistory();
            this.activeEmissions.clear();

            dispatch(
                this,
                "destroy",
                {
                    version:
                        VERSION,
                    timestamp:
                        nowISO()
                }
            );

            this.destroyed =
                true;

            return true;
        }

    }

    class ScopedEventBus {
        constructor(parent, namespace) {
            this.parent =
                parent;

            this.namespace =
                normalizeNamespace(
                    namespace
                );

            this.disposers =
                new Set();

            this.destroyed =
                false;
        }

        assertAvailable() {
            if (
                this.destroyed
            ) {
                throw new Error(
                    "Scoped event bus has been destroyed."
                );
            }

            this.parent.assertAvailable();
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
            this.assertAvailable();

            return this.parent.emit(
                this.qualify(
                    name
                ),
                detail,
                options
            );
        }

        async emitAsync(name, detail = {}, options = {}) {
            this.assertAvailable();

            return this.parent.emitAsync(
                this.qualify(
                    name
                ),
                detail,
                options
            );
        }

        on(
            name,
            listener,
            options =
                {}
        ) {
            this.assertAvailable();

            let disposed =
                false;

            let unsubscribe =
                null;

            const dispose =
                () => {
                    if (disposed) {
                        return false;
                    }

                    disposed =
                        true;

                    this.disposers.delete(
                        dispose
                    );

                    return unsubscribe?.() ||
                        false;
                };

            unsubscribe =
                this.parent.on(
                    this.qualify(
                        name
                    ),
                    (
                        event,
                        detail
                    ) => {
                        try {
                            return listener(
                                event,
                                detail
                            );
                        } finally {
                            if (
                                options.once ===
                                    true
                            ) {
                                dispose();
                            }
                        }
                    },
                    {
                        ...options,
                        once:
                            false
                    }
                );

            this.disposers.add(
                dispose
            );

            return dispose;
        }

        once(
            name,
            listener,
            options =
                {}
        ) {
            return this.on(
                name,
                listener,
                {
                    ...options,
                    once:
                        true
                }
            );
        }

        off(name, listener = null) {
            this.assertAvailable();

            return this.parent.off(
                this.qualify(
                    name
                ),
                listener
            );
        }

        waitFor(name, options = {}) {
            this.assertAvailable();

            return this.parent.waitFor(
                this.qualify(
                    name
                ),
                options
            );
        }

        scope(namespace) {
            this.assertAvailable();

            const childNamespace =
                [
                    this.namespace,
                    normalizeNamespace(
                        namespace
                    )
                ]
                    .filter(Boolean)
                    .join(":");

            const scope =
                new ScopedEventBus(
                    this.parent,
                    childNamespace
                );

            this.parent.scopes.add(
                scope
            );

            return scope;
        }

        status() {
            return {
                namespace:
                    this.namespace ||
                    null,
                subscriptions:
                    this.disposers.size,
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

            for (
                const dispose of
                [
                    ...this.disposers
                ]
            ) {
                try {
                    dispose();
                } catch (_error) {
                    /* Continue cleanup. */
                }
            }

            this.disposers.clear();

            this.parent.scopes.delete(
                this
            );

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
            safeContext.root &&
            typeof safeContext.root === "object"
                ? safeContext.root
                : document.documentElement;

        const existing =
            safeContext.events instanceof
                EventBus
                ? safeContext.events
                : safeContext.services?.get?.(
                    "events"
                ) ||
                root?.[EVENTS_SYMBOL];

        if (
            existing instanceof EventBus &&
            !existing.destroyed
        ) {
            safeContext.events =
                existing;

            safeContext.registerService?.(
                "events",
                existing
            );

            return existing;
        }

        const dataset =
            safeContext.root?.dataset ||
            {};

        const config =
            safeContext.config?.events ||
            {};

        const bus =
            new EventBus({
                historyLimit:
                    dataset.terminalEventHistoryLimit ||
                    config.historyLimit,
                namespace:
                    dataset.terminalEventNamespace ||
                    config.namespace ||
                    "",
                maxListeners:
                    dataset.terminalEventMaxListeners ||
                    config.maxListeners,
                maxWildcardListeners:
                    dataset.terminalEventMaxWildcardListeners ||
                    config.maxWildcardListeners,
                maxBridges:
                    dataset.terminalEventMaxBridges ||
                    config.maxBridges,
                asyncConcurrency:
                    dataset.terminalEventAsyncConcurrency ||
                    config.asyncConcurrency,
                maxEmitDepth:
                    dataset.terminalEventMaxDepth ||
                    config.maxEmitDepth
            });

        root[EVENTS_SYMBOL] =
            bus;

        safeContext.events =
            bus;

        safeContext.registerService?.(
            "events",
            bus
        );

        dispatch(
            document,
            "speciedex:terminal-events-ready",
            {
                context:
                    safeContext,
                events:
                    bus,

                version:
                    VERSION,

                releaseChannel:
                    RELEASE_CHANNEL,

                productLabel:
                    PRODUCT_LABEL
            }
        );

        return bus;
    }

    function resolveCommandContext(payload = {}) {
        return (
            payload.context ||
            payload.terminal?.context ||
            payload.app?.context ||
            payload
        );
    }

    function requireBus(context) {
        const safeContext =
            context &&
            typeof context === "object"
                ? context
                : {};

        const bus =
            safeContext.events instanceof
                EventBus
                ? safeContext.events
                : safeContext.services?.get?.(
                    "events"
                ) ||
                initialize(safeContext);

        if (
            !(bus instanceof EventBus) ||
            bus.destroyed
        ) {
            throw new Error(
                "Terminal event service is unavailable."
            );
        }

        return bus;
    }

    function writeResult(payload, value, type = "data") {
        if (
            typeof payload.writeJSON ===
                "function" &&
            typeof value !== "string"
        ) {
            return payload.writeJSON(value);
        }

        if (typeof payload.write === "function") {
            return payload.write(
                typeof value === "string"
                    ? value
                    : JSON.stringify(
                        safeClone(value),
                        null,
                        2
                    ),
                type
            );
        }

        if (typeof payload.writeLine === "function") {
            return payload.writeLine(
                typeof value === "string"
                    ? value
                    : JSON.stringify(
                        safeClone(value),
                        null,
                        2
                    )
            );
        }

        return value;
    }

    function parseDetail(args) {
        if (!args.length) {
            return {};
        }

        const text =
            args.join(" ");

        try {
            return parseJSON(
                text
            );
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
                "events [status|history [pattern] [limit]|listeners|bridges|clear-history|limit <count>]",
            handler: payload => {
                const context =
                    resolveCommandContext(payload);

                const args =
                    Array.isArray(payload.args)
                        ? payload.args
                        : [];

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

                    return writeResult(
                        payload,
                        result
                    );
                }

                if (
                    action ===
                    "clear-history"
                ) {
                    const count =
                        bus.clearHistory();

                    return writeResult(
                        payload,
                        `Cleared ${count} event-history entr${count === 1 ? "y" : "ies"}.`,
                        "success"
                    );
                }

                if (action === "limit") {
                    if (!args[1]) {
                        return writeResult(
                            payload,
                            `Event history limit: ${bus.historyLimit}`,
                            "info"
                        );
                    }

                    const limit =
                        bus.setHistoryLimit(
                            args[1]
                        );

                    return writeResult(
                        payload,
                        `Event history limit: ${limit}`,
                        "success"
                    );
                }

                if (
                    action ===
                    "listeners"
                ) {
                    const output = {
                        subscriptions:
                            Array.from(
                                bus.subscriptions.entries()
                            ).map(
                                (
                                    [
                                        name,
                                        records
                                    ]
                                ) => ({
                                    name,
                                    listeners:
                                        records.size
                                })
                            ),
                        wildcards:
                            Array.from(
                                bus.wildcardSubscriptions.entries()
                            ).map(
                                (
                                    [
                                        pattern,
                                        records
                                    ]
                                ) => ({
                                    pattern,
                                    listeners:
                                        records.size
                                })
                            )
                    };

                    return writeResult(
                        payload,
                        output
                    );
                }

                if (
                    action ===
                    "bridges"
                ) {
                    const output =
                        Array.from(
                            bus.bridges.values()
                        ).map(
                            bridge => ({
                                id:
                                    bridge.id,
                                sourceName:
                                    bridge.sourceName,
                                targetName:
                                    bridge.targetName,
                                dedupeKey:
                                    bridge.dedupeKey
                            })
                        );

                    return writeResult(
                        payload,
                        output
                    );
                }

                if (action !== "status") {
                    throw new Error(
                        `Unknown events action: ${action}`
                    );
                }

                const status =
                    bus.status();

                return writeResult(
                    payload,
                    status
                );
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
            handler: payload => {
                const context =
                    resolveCommandContext(payload);

                const args =
                    Array.isArray(payload.args)
                        ? payload.args
                        : [];

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

                return writeResult(
                    payload,
                    output
                );
            }
        },
        {
            name:
                "event-emit-async",

            aliases: [
                "emit-async"
            ],

            category:
                "system",

            description:
                "Emit a terminal event asynchronously.",

            usage:
                "event-emit-async <name> [JSON or text detail]",

            handler: async payload => {
                const context =
                    resolveCommandContext(payload);

                const args =
                    Array.isArray(payload.args)
                        ? payload.args
                        : [];

                const bus =
                    requireBus(
                        context
                    );

                const name =
                    args[0];

                if (!name) {
                    throw new Error(
                        "An event name is required."
                    );
                }

                const result =
                    await bus.emitAsync(
                        name,
                        parseDetail(
                            args.slice(
                                1
                            )
                        )
                    );

                const output = {
                    name:
                        result.name,
                    entry:
                        result.entry,
                    results:
                        result.results,
                    errors:
                        result.errors.map(
                            item => ({
                                listenerId:
                                    item.listenerId,
                                message:
                                    item.error?.message ||
                                    String(
                                        item.error
                                    )
                            })
                        )
                };

                return writeResult(
                    payload,
                    output
                );
            }
        }
    ];

    const api = Object.freeze({
        name:
            MODULE_NAME,

        version:
            VERSION,

        releaseChannel:
            RELEASE_CHANNEL,

        productLabel:
            PRODUCT_LABEL,

        EVENTS_SYMBOL,
        EventBus,
        ScopedEventBus,
        matchesPattern,
        normalizeName,
        normalizeNamespace,
        safeClone,
        parseJSON,
        isAbortError,
        createAbortError,
        dispatch,
        resolveCommandContext,
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
            name:
                MODULE_NAME,

            module:
                api,

            version:
                VERSION,

            releaseChannel:
                RELEASE_CHANNEL,

            productLabel:
                PRODUCT_LABEL
        }
    );
})(window, document);