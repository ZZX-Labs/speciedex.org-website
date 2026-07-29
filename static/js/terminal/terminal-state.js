/*
========================================================================
Speciedex.org
Terminal State Store
========================================================================

Production state-management service for the Speciedex terminal application.
Provides hierarchical state, immutable snapshots, transactions, history,
undo/redo, watchers, computed values, persistence, cross-tab synchronization,
and domain-specific helpers used by terminal modules.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/
(function (window, document) {
    "use strict";

    const MODULE_NAME = "State";
    const VERSION = "2.2.0";
    const STORE_SYMBOL =
        Symbol.for(
            "speciedex.terminal.state.store"
        );

    const DEFAULT_STORAGE_KEY = "speciedex-terminal:state";
    const DEFAULT_HISTORY_LIMIT = 250;
    const DEFAULT_UNDO_LIMIT = 250;
    const DEFAULT_NOTIFICATION_LIMIT = 500;
    const DEFAULT_SEARCH_RESULT_LIMIT = 1000;
    const DEFAULT_SCAN_ISSUE_LIMIT = 5000;
    const DEFAULT_LIBRARY_RECORD_LIMIT = 25000;
    const FORBIDDEN_PATH_PARTS = new Set([
        "__proto__",
        "prototype",
        "constructor"
    ]);
    const DELETE = Symbol("speciedex.state.delete");

    const activeDispatches =
        new WeakMap();

    const ROOT_KEYS = Object.freeze([
        "runtime",
        "session",
        "providers",
        "search",
        "scan",
        "stream",
        "library",
        "index",
        "visualization",
        "notifications",
        "loading",
        "jobs",
        "settings",
        "statistics",
        "timeline",
        "map",
        "terminal",
        "diagnostics"
    ]);

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

    function dispatchSafe(
        target,
        name,
        detail,
        options = {}
    ) {
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

    function nowISO() {
        return new Date().toISOString();
    }

    function randomId(prefix = "state") {
        if (window.crypto && typeof window.crypto.randomUUID === "function") {
            return `${prefix}:${window.crypto.randomUUID()}`;
        }
        return `${prefix}:${Date.now().toString(36)}:${Math.random()
            .toString(36).slice(2)}`;
    }

    function isObject(value) {
        return value !== null && typeof value === "object" &&
            !Array.isArray(value);
    }

    function isPlainObject(value) {
        if (!isObject(value)) {
            return false;
        }
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    }

    function clone(
        value,
        seen =
            new WeakMap(),
        allowStructuredClone =
            true
    ) {
        if (
            value ===
                null ||
            typeof value !==
                "object"
        ) {
            return value;
        }

        if (
            allowStructuredClone &&
            typeof window.structuredClone ===
                "function"
        ) {
            try {
                return window.structuredClone(
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
            value instanceof
                RegExp
        ) {
            return new RegExp(
                value.source,
                value.flags
            );
        }

        if (
            value instanceof
                Map
        ) {
            const result =
                new Map();

            seen.set(
                value,
                result
            );

            for (
                const [
                    key,
                    item
                ] of value
            ) {
                result.set(
                    clone(
                        key,
                        seen,
                        false
                    ),
                    clone(
                        item,
                        seen,
                        false
                    )
                );
            }

            return result;
        }

        if (
            value instanceof
                Set
        ) {
            const result =
                new Set();

            seen.set(
                value,
                result
            );

            for (
                const item of
                value
            ) {
                result.add(
                    clone(
                        item,
                        seen,
                        false
                    )
                );
            }

            return result;
        }

        if (
            Array.isArray(
                value
            )
        ) {
            const result =
                [];

            seen.set(
                value,
                result
            );

            for (
                const item of
                value
            ) {
                result.push(
                    clone(
                        item,
                        seen,
                        false
                    )
                );
            }

            return result;
        }

        if (
            isObject(
                value
            )
        ) {
            const result =
                {};

            seen.set(
                value,
                result
            );

            for (
                const key of
                Object.keys(
                    value
                )
            ) {
                if (
                    FORBIDDEN_PATH_PARTS.has(
                        key
                    )
                ) {
                    continue;
                }

                result[
                    key
                ] =
                    clone(
                        value[
                            key
                        ],
                        seen,
                        false
                    );
            }

            return result;
        }

        return value;
    }

    function deepEqual(
        left,
        right,
        seen =
            new WeakMap()
    ) {
        if (
            Object.is(
                left,
                right
            )
        ) {
            return true;
        }

        if (
            left ===
                null ||
            right ===
                null ||
            typeof left !==
                "object" ||
            typeof right !==
                "object"
        ) {
            return false;
        }

        if (
            seen.get(
                left
            ) ===
                right
        ) {
            return true;
        }

        seen.set(
            left,
            right
        );

        if (
            left instanceof
                Date ||
            right instanceof
                Date
        ) {
            return (
                left instanceof
                    Date &&
                right instanceof
                    Date &&
                left.getTime() ===
                    right.getTime()
            );
        }

        if (
            left instanceof
                RegExp ||
            right instanceof
                RegExp
        ) {
            return (
                left instanceof
                    RegExp &&
                right instanceof
                    RegExp &&
                left.source ===
                    right.source &&
                left.flags ===
                    right.flags
            );
        }

        if (
            left instanceof
                Map ||
            right instanceof
                Map
        ) {
            if (
                !(
                    left instanceof
                        Map &&
                    right instanceof
                        Map
                ) ||
                left.size !==
                    right.size
            ) {
                return false;
            }

            for (
                const [
                    key,
                    value
                ] of left
            ) {
                if (
                    !right.has(
                        key
                    ) ||
                    !deepEqual(
                        value,
                        right.get(
                            key
                        ),
                        seen
                    )
                ) {
                    return false;
                }
            }

            return true;
        }

        if (
            left instanceof
                Set ||
            right instanceof
                Set
        ) {
            if (
                !(
                    left instanceof
                        Set &&
                    right instanceof
                        Set
                ) ||
                left.size !==
                    right.size
            ) {
                return false;
            }

            return [
                ...left
            ].every(
                value =>
                    right.has(
                        value
                    )
            );
        }

        if (
            Array.isArray(
                left
            ) !==
            Array.isArray(
                right
            )
        ) {
            return false;
        }

        if (
            Array.isArray(
                left
            )
        ) {
            return (
                left.length ===
                    right.length &&
                left.every(
                    (
                        value,
                        index
                    ) =>
                        deepEqual(
                            value,
                            right[
                                index
                            ],
                            seen
                        )
                )
            );
        }

        const leftKeys =
            Object.keys(
                left
            );

        const rightKeys =
            Object.keys(
                right
            );

        if (
            leftKeys.length !==
                rightKeys.length
        ) {
            return false;
        }

        return leftKeys.every(
            key =>
                Object.prototype.hasOwnProperty.call(
                    right,
                    key
                ) &&
                deepEqual(
                    left[
                        key
                    ],
                    right[
                        key
                    ],
                    seen
                )
        );
    }

    function splitPath(path) {
        if (path === undefined || path === null || path === "") {
            return [];
        }
        if (Array.isArray(path)) {
            return path.map(part => String(part)).filter(Boolean);
        }
        return String(path)
            .replace(/\[(?:"([^"]+)"|'([^']+)'|(\d+))\]/g,
                (_, doubleQuoted, singleQuoted, numeric) =>
                    `.${doubleQuoted || singleQuoted || numeric}`)
            .split(".")
            .map(part => part.trim())
            .filter(Boolean);
    }

    function assertSafePath(
        path
    ) {
        const parts =
            splitPath(
                path
            );

        for (
            const part of
            parts
        ) {
            if (
                FORBIDDEN_PATH_PARTS.has(
                    part
                )
            ) {
                throw new TypeError(
                    `Unsafe state path component: ${part}`
                );
            }
        }

        return parts;
    }

    function pathString(path) {
        return assertSafePath(
            path
        ).join(
            "."
        );
    }

    function getAt(root, path, fallback) {
        const parts =
            assertSafePath(path);

        let current =
            root;

        for (const part of parts) {
            if (
                current === null ||
                current === undefined ||
                !Object.prototype.hasOwnProperty.call(
                    Object(current),
                    part
                )
            ) {
                return fallback;
            }

            current =
                current[part];
        }

        return current;
    }

    function hasAt(root, path) {
        const sentinel = Symbol("missing");
        return getAt(root, path, sentinel) !== sentinel;
    }

    function setAt(root, path, value) {
        const parts = assertSafePath(path);
        if (!parts.length) {
            throw new TypeError("A non-empty state path is required.");
        }
        let current = root;
        for (let index = 0; index < parts.length - 1; index += 1) {
            const key = parts[index];
            const next = parts[index + 1];
            if (!isObject(current[key]) && !Array.isArray(current[key])) {
                current[key] = /^\d+$/.test(next) ? [] : {};
            }
            current = current[key];
        }
        current[parts[parts.length - 1]] = value;
    }

    function deleteAt(root, path) {
        const parts = assertSafePath(path);
        if (!parts.length) {
            return false;
        }
        let current = root;
        for (let index = 0; index < parts.length - 1; index += 1) {
            current = current?.[parts[index]];
            if (current === null || current === undefined) {
                return false;
            }
        }
        const key = parts[parts.length - 1];
        if (!Object.prototype.hasOwnProperty.call(Object(current), key)) {
            return false;
        }
        if (Array.isArray(current) && /^\d+$/.test(key)) {
            current.splice(Number(key), 1);
        } else {
            delete current[key];
        }
        return true;
    }

    function mergeDeep(target, source) {
        const output = isPlainObject(target) ? clone(target) : {};
        for (
            const [key, value]
            of Object.entries(source || {})
        ) {
            if (
                FORBIDDEN_PATH_PARTS.has(
                    key
                )
            ) {
                continue;
            }

            if (isPlainObject(value)) {
                output[key] = mergeDeep(output[key], value);
            } else {
                output[key] = clone(value);
            }
        }
        return output;
    }

    function serializable(
        value,
        seen =
            new WeakSet(),
        depth =
            0
    ) {
        if (
            depth >
            32
        ) {
            return "[Truncated]";
        }

        if (
            value ===
                null ||
            value ===
                undefined ||
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
            typeof value ===
                "symbol"
        ) {
            return value.toString();
        }

        if (
            value instanceof
                Date
        ) {
            return Number.isFinite(
                value.getTime()
            )
                ? value.toISOString()
                : null;
        }

        if (
            value instanceof
                RegExp
        ) {
            return value.toString();
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
                    serializable(
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
            return Object.fromEntries(
                [
                    ...value.entries()
                ].map(
                    (
                        [
                            key,
                            item
                        ]
                    ) => [
                        String(
                            key
                        ),
                        serializable(
                            item,
                            seen,
                            depth +
                                1
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
                    serializable(
                        item,
                        seen,
                        depth +
                            1
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
                    FORBIDDEN_PATH_PARTS.has(
                        key
                    )
                ) {
                    continue;
                }

                output[
                    key
                ] =
                    serializable(
                        item,
                        seen,
                        depth +
                            1
                    );
            }

            return output;
        }

        return String(
            value
        );
    }

    function defaultState() {
        const startedAt = nowISO();
        return {
            runtime: {
                version: VERSION,
                startedAt,
                updatedAt: startedAt,
                ready: false,
                booted: false,
                online: window.navigator?.onLine !== false,
                visible: document.visibilityState !== "hidden",
                locale: window.navigator?.language || "en-US",
                errors: 0
            },
            session: {
                id: randomId("session"),
                startedAt,
                lastActivityAt: startedAt,
                commandCount: 0,
                changes: 0
            },
            providers: {
                enabled: {},
                eligible: {},
                health: {},
                latency: {},
                statistics: {},
                active: null,
                lastUpdatedAt: null
            },
            search: {
                query: "",
                filters: {},
                sort: null,
                page: 1,
                pageSize: 50,
                results: [],
                count: 0,
                running: false,
                error: null,
                lastRun: null
            },
            scan: {
                running: false,
                progress: 0,
                target: null,
                issues: [],
                error: null,
                lastRun: null
            },
            stream: {
                connected: false,
                connecting: false,
                endpoint: null,
                records: 0,
                rate: 0,
                lastRecord: null,
                error: null
            },
            library: {
                collections: {},
                active: null,
                selection: [],
                count: 0,
                updatedAt: null
            },
            index: {
                ready: false,
                building: false,
                documents: 0,
                fields: [],
                version: 0,
                updatedAt: null,
                error: null
            },
            visualization: {
                active: null,
                mode: null,
                data: null,
                options: {},
                selection: null,
                loading: false
            },
            notifications: {
                unread: 0,
                items: []
            },
            loading: {
                active: false,
                tasks: {},
                completed: 0,
                failed: 0,
                progress: 0
            },
            jobs: {
                active: {},
                queued: [],
                completed: [],
                failed: []
            },
            settings: {
                persistence: true,
                synchronization: true,
                reducedMotion: false,
                pageSize: 50
            },
            statistics: {
                records: 0,
                species: 0,
                providers: 0,
                updatedAt: null,
                values: {}
            },
            timeline: {
                range: null,
                cursor: null,
                playing: false,
                speed: 1,
                records: []
            },
            map: {
                center: [0, 0],
                zoom: 2,
                bounds: null,
                layers: {},
                markers: [],
                selection: null
            },
            terminal: {
                prompt: "public@speciedex:~$",
                busy: false,
                fullscreen: false,
                focused: false,
                historyIndex: 0,
                commandCount: 0,
                lastCommand: null
            },
            diagnostics: {
                enabled: false,
                warnings: [],
                errors: [],
                metrics: {},
                updatedAt: null
            }
        };
    }

    function normalizeInitialState(initial) {
        return mergeDeep(defaultState(), isPlainObject(initial) ? initial : {});
    }

    class StateStore extends EventTarget {
        constructor(initial = {}, options = {}) {
            super();
            this.version = VERSION;
            this.id = randomId("store");
            this.tree = normalizeInitialState(initial);
            this.initial = clone(this.tree);
            this.history = [];
            this.undoStack = [];
            this.redoStack = [];
            this.watchers = new Map();
            this.globalWatchers = new Set();
            this.computed = new Map();
            this.transaction = null;
            this.destroyed = false;
            this.replaying = false;
            this.revision = 0;
            this.historyLimit =
                clampInteger(
                    options.historyLimit,
                    DEFAULT_HISTORY_LIMIT,
                    1,
                    100000
                );

            this.undoLimit =
                clampInteger(
                    options.undoLimit,
                    DEFAULT_UNDO_LIMIT,
                    1,
                    100000
                );
            this.storageKey = String(options.storageKey || DEFAULT_STORAGE_KEY);
            this.persistEnabled =
                parseBoolean(
                    options.persist,
                    true
                );

            this.syncEnabled =
                parseBoolean(
                    options.sync,
                    true
                );
            this.persistTimer = null;
            this.channel = null;
            this.listenerDisposers = [];
            this.origin = randomId("origin");
            this.contextRoot =
                options.contextRoot ||
                null;
            this.notifying = false;
            this.notificationQueue = [];
            this.maximumNotificationItems =
                clampInteger(
                    options.maximumNotificationItems,
                    DEFAULT_NOTIFICATION_LIMIT,
                    1,
                    100000
                );

            this.maximumSearchResults =
                clampInteger(
                    options.maximumSearchResults,
                    DEFAULT_SEARCH_RESULT_LIMIT,
                    1,
                    1000000
                );

            this.maximumScanIssues =
                clampInteger(
                    options.maximumScanIssues,
                    DEFAULT_SCAN_ISSUE_LIMIT,
                    1,
                    1000000
                );

            this.maximumLibraryRecords =
                clampInteger(
                    options.maximumLibraryRecords,
                    DEFAULT_LIBRARY_RECORD_LIMIT,
                    1,
                    1000000
                );
            this.lastRemoteRevision = 0;

            /*
            --------------------------------------------------------------
            Track active event names across the full event fan-out. This
            blocks same-event re-entry without suppressing unrelated nested
            lifecycle events.
            --------------------------------------------------------------
            */
            this.activeEmits =
                new Set();

            this.maximumNotificationsPerDrain =
                clampInteger(
                    options.maximumNotificationsPerDrain,
                    4096,
                    32,
                    100000
                );

            this.context =
                isObject(options.context)
                    ? options.context
                    : {};

            this.metricsState = {
                changes: 0,
                notificationsQueued: 0,
                watcherErrors: 0,
                persistenceErrors: 0,
                syncReceived: 0,
                syncIgnored: 0
            };
            this.attachRuntimeListeners();
            this.attachSynchronization();
        }

        assertActive() {
            if (this.destroyed) {
                throw new Error("The state store has been destroyed.");
            }
        }

        get(path, fallback = undefined, options = {}) {
            this.assertActive();
            const value = getAt(this.tree, path, fallback);
            return options.clone === true ? clone(value) : value;
        }

        select(path, fallback = undefined) {
            return clone(this.get(path, fallback));
        }

        has(path) {
            this.assertActive();
            return hasAt(this.tree, path);
        }

        keys(path = "") {
            const value = this.get(path, {});
            return value && typeof value === "object" ? Object.keys(value) : [];
        }

        entries(path = "") {
            const value = this.get(path, {});
            return value && typeof value === "object" ? Object.entries(value) : [];
        }

        set(path, value, options = {}) {
            this.assertActive();
            const normalizedPath = pathString(path);
            if (!normalizedPath) {
                throw new TypeError("A non-empty state path is required.");
            }
            const existed = this.has(normalizedPath);
            const previous = clone(this.get(normalizedPath));
            const next = typeof value === "function"
                ? value(clone(previous), this)
                : value;
            if (next === DELETE) {
                return this.delete(normalizedPath, options);
            }
            const stored = clone(next);
            if (!options.force && existed && deepEqual(previous, stored)) {
                return this.get(normalizedPath);
            }
            setAt(this.tree, normalizedPath, stored);
            return this.recordChange({
                path: normalizedPath,
                previous,
                value: clone(stored),
                existed,
                deleted: false,
                source: options.source || "set",
                silent: options.silent === true,
                undoable: options.undoable !== false,
                persist: options.persist !== false,
                broadcast: options.broadcast !== false
            });
        }

        update(path, updater, options = {}) {
            if (typeof updater !== "function") {
                throw new TypeError("State update requires a function.");
            }
            return this.set(path, updater, options);
        }

        merge(path, patch, options = {}) {
            if (!isPlainObject(patch)) {
                throw new TypeError("State merge requires a plain object.");
            }
            const current = this.select(path, {});
            return this.set(path, mergeDeep(current, patch), {
                ...options,
                source: options.source || "merge"
            });
        }

        delete(path, options = {}) {
            this.assertActive();
            const normalizedPath = pathString(path);
            if (!normalizedPath || !this.has(normalizedPath)) {
                return false;
            }
            const previous = clone(this.get(normalizedPath));
            deleteAt(this.tree, normalizedPath);
            this.recordChange({
                path: normalizedPath,
                previous,
                value: undefined,
                existed: true,
                deleted: true,
                source: options.source || "delete",
                silent: options.silent === true,
                undoable: options.undoable !== false,
                persist: options.persist !== false,
                broadcast: options.broadcast !== false
            });
            return true;
        }

        ensure(path, fallback, options = {}) {
            if (!this.has(path)) {
                return this.set(path, fallback, {
                    ...options,
                    source: options.source || "ensure"
                });
            }
            return this.get(path);
        }

        toggle(path, options = {}) {
            return this.update(path, value => !Boolean(value), {
                ...options,
                source: options.source || "toggle"
            });
        }

        increment(path, amount = 1, options = {}) {
            const delta = Number(amount);
            return this.update(path, value =>
                (Number(value) || 0) + (Number.isFinite(delta) ? delta : 0), {
                ...options,
                source: options.source || "increment"
            });
        }

        push(path, value, options = {}) {
            return this.update(path, current => {
                const list = Array.isArray(current) ? current : [];
                list.push(clone(value));
                return list;
            }, { ...options, source: options.source || "push" });
        }

        remove(path, predicate, options = {}) {
            if (typeof predicate !== "function") {
                throw new TypeError("State remove requires a predicate.");
            }
            return this.update(path, current =>
                (Array.isArray(current) ? current : []).filter(
                    (item, index) => !predicate(item, index)
                ), { ...options, source: options.source || "remove" });
        }

        batch(changes, options = {}) {
            if (!Array.isArray(changes)) {
                throw new TypeError("State batch requires an array.");
            }
            this.beginTransaction(options.label || "batch", options);
            try {
                for (const change of changes) {
                    if (!change || !change.path) {
                        continue;
                    }
                    if (change.delete === true) {
                        this.delete(change.path, change.options || {});
                    } else if (change.merge === true) {
                        this.merge(change.path, change.value || {},
                            change.options || {});
                    } else {
                        this.set(change.path, change.value,
                            change.options || {});
                    }
                }
                return this.commit(options);
            } catch (error) {
                this.rollback({ source: "batch-error" });
                throw error;
            }
        }

        beginTransaction(label = "transaction", options = {}) {
            this.assertActive();
            if (this.transaction) {
                this.transaction.depth += 1;
                return this.transaction;
            }
            this.transaction = {
                id: randomId("transaction"),
                label: String(label || "transaction"),
                startedAt: nowISO(),
                depth: 1,
                changes: [],
                options: { ...options }
            };
            this.emit("transactionstart", clone(this.transaction));
            return this.transaction;
        }

        commit(options = {}) {
            this.assertActive();
            if (!this.transaction) {
                return false;
            }
            if (this.transaction.depth > 1) {
                this.transaction.depth -= 1;
                return true;
            }
            const transaction = this.transaction;
            this.transaction = null;
            if (!transaction.changes.length) {
                this.emit("transactionempty", clone(transaction));
                return true;
            }
            if (!this.replaying && options.undoable !== false) {
                this.pushUndo({
                    type: "transaction",
                    label: transaction.label,
                    timestamp: nowISO(),
                    changes: clone(transaction.changes)
                });
            }
            this.emit(
                "transaction",
                clone(transaction)
            );

            if (
                transaction.options.persist !== false &&
                options.persist !== false
            ) {
                this.schedulePersist();
            }

            if (
                transaction.options.broadcast !== false &&
                options.broadcast !== false
            ) {
                this.broadcast({
                    type:
                        "snapshot",
                    snapshot:
                        this.snapshot()
                });
            }
            return true;
        }

        rollback(options = {}) {
            this.assertActive();
            if (!this.transaction) {
                return false;
            }
            const transaction = this.transaction;
            this.transaction = null;
            this.replaying = true;
            try {
                for (const change of [...transaction.changes].reverse()) {
                    this.applyInverse(change, {
                        source: options.source || "rollback",
                        silent: true,
                        persist: false,
                        broadcast: false
                    });
                }
            } finally {
                this.replaying = false;
            }
            this.emit("rollback", clone(transaction));
            this.emit("change", {
                path: "",
                source: "rollback",
                snapshot: this.snapshot()
            });
            return true;
        }

        transactionScope(label, callback, options = {}) {
            if (typeof callback !== "function") {
                throw new TypeError("Transaction scope requires a callback.");
            }
            this.beginTransaction(label, options);
            try {
                const result = callback(this);
                if (result && typeof result.then === "function") {
                    return result.then(value => {
                        this.commit(options);
                        return value;
                    }).catch(error => {
                        this.rollback({ source: "transaction-error" });
                        throw error;
                    });
                }
                this.commit(options);
                return result;
            } catch (error) {
                this.rollback({ source: "transaction-error" });
                throw error;
            }
        }

        recordChange(change) {
            this.revision += 1;
            this.metricsState.changes += 1;

            const record = {
                id: randomId("change"),
                revision: this.revision,
                timestamp: nowISO(),
                ...change
            };
            this.invalidateComputed(
                record.path
            );

            this.history.push(
                clone(record)
            );
            if (this.history.length > this.historyLimit) {
                this.history.splice(0, this.history.length - this.historyLimit);
            }
            setAt(this.tree, "runtime.updatedAt", record.timestamp);
            setAt(this.tree, "session.lastActivityAt", record.timestamp);
            setAt(this.tree, "session.changes",
                (Number(getAt(this.tree, "session.changes", 0)) || 0) + 1);
            if (this.transaction) {
                this.transaction.changes.push(clone(record));
            } else if (!this.replaying && change.undoable) {
                this.pushUndo({
                    type: "change",
                    label: change.source,
                    timestamp: record.timestamp,
                    changes: [clone(record)]
                });
            }
            if (!change.silent) {
                this.notify(record);
            }
            if (!this.transaction) {
                if (change.persist) {
                    this.schedulePersist();
                }
                if (change.broadcast) {
                    this.broadcast({ type: "change", change: record });
                }
            }
            return this.get(change.path);
        }

        pushUndo(entry) {
            this.undoStack.push(entry);
            if (this.undoStack.length > this.undoLimit) {
                this.undoStack.splice(0,
                    this.undoStack.length - this.undoLimit);
            }
            this.redoStack.length = 0;
        }

        applyInverse(change, options = {}) {
            if (!change.existed) {
                return this.delete(change.path, {
                    ...options,
                    undoable: false
                });
            }
            return this.set(change.path, clone(change.previous), {
                ...options,
                force: true,
                undoable: false
            });
        }

        applyForward(change, options = {}) {
            if (change.deleted) {
                return this.delete(change.path, {
                    ...options,
                    undoable: false
                });
            }
            return this.set(change.path, clone(change.value), {
                ...options,
                force: true,
                undoable: false
            });
        }

        undo() {
            this.assertActive();
            const entry = this.undoStack.pop();
            if (!entry) {
                return false;
            }
            this.replaying = true;
            try {
                for (const change of [...entry.changes].reverse()) {
                    this.applyInverse(change, {
                        source: "undo",
                        persist: false,
                        broadcast: false
                    });
                }
            } finally {
                this.replaying = false;
            }
            this.redoStack.push(entry);
            this.emit("undo", clone(entry));
            this.schedulePersist();
            this.broadcast({ type: "snapshot", snapshot: this.snapshot() });
            return true;
        }

        redo() {
            this.assertActive();
            const entry = this.redoStack.pop();
            if (!entry) {
                return false;
            }
            this.replaying = true;
            try {
                for (const change of entry.changes) {
                    this.applyForward(change, {
                        source: "redo",
                        persist: false,
                        broadcast: false
                    });
                }
            } finally {
                this.replaying = false;
            }
            this.undoStack.push(entry);
            this.emit("redo", clone(entry));
            this.schedulePersist();
            this.broadcast({ type: "snapshot", snapshot: this.snapshot() });
            return true;
        }

        watch(path, callback, options = {}) {
            this.assertActive();
            if (typeof callback !== "function") {
                throw new TypeError("State watcher requires a callback.");
            }
            const key = pathString(path);
            if (!this.watchers.has(key)) {
                this.watchers.set(key, new Set());
            }
            const watcher = { callback, options: { ...options } };
            this.watchers.get(key).add(watcher);
            if (options.immediate === true) {
                callback(this.select(key), undefined, {
                    path: key,
                    source: "immediate",
                    state: this
                });
            }
            return () => this.unwatch(key, callback);
        }

        unwatch(path, callback) {
            const key = pathString(path);
            const watchers = this.watchers.get(key);
            if (!watchers) {
                return false;
            }
            let removed = false;
            for (const watcher of watchers) {
                if (!callback || watcher.callback === callback) {
                    watchers.delete(watcher);
                    removed = true;
                }
            }
            if (!watchers.size) {
                this.watchers.delete(key);
            }
            return removed;
        }

        watchAll(callback, options = {}) {
            this.assertActive();

            if (typeof callback !== "function") {
                throw new TypeError("Global state watcher requires a callback.");
            }
            const watcher = { callback, options: { ...options } };
            this.globalWatchers.add(watcher);
            return () => this.globalWatchers.delete(watcher);
        }

        unwatchAll(callback) {
            let removed = false;
            for (const watcher of this.globalWatchers) {
                if (!callback || watcher.callback === callback) {
                    this.globalWatchers.delete(watcher);
                    removed = true;
                }
            }
            return removed;
        }

        matchesWatcher(watchedPath, changedPath, options) {
            if (!watchedPath) {
                return true;
            }
            if (watchedPath === changedPath) {
                return true;
            }
            if (options.deep !== false && changedPath.startsWith(
                `${watchedPath}.`)) {
                return true;
            }
            if (options.ancestors === true && watchedPath.startsWith(
                `${changedPath}.`)) {
                return true;
            }
            return false;
        }

        notify(
            change
        ) {
            this.notificationQueue.push(
                clone(
                    change
                )
            );

            if (
                this.notifying
            ) {
                this.metricsState.notificationsQueued +=
                    1;

                return;
            }

            this.notifying =
                true;

            let processed =
                0;

            try {
                while (
                    this.notificationQueue.length
                ) {
                    processed +=
                        1;

                    if (
                        processed >
                        this.maximumNotificationsPerDrain
                    ) {
                        const remaining =
                            this.notificationQueue.length;

                        this.notificationQueue.length =
                            0;

                        const error =
                            new Error(
                                "State watcher recursion limit exceeded. " +
                                `${processed - 1} notifications were processed ` +
                                `and ${remaining} queued notifications were discarded.`
                            );

                        this.metricsState.watcherErrors +=
                            1;

                        /*
                        --------------------------------------------------
                        Dispatch directly; calling this.emit("watchererror")
                        here could itself re-enter a faulty event bridge.
                        --------------------------------------------------
                        */
                        dispatchSafe(
                            this,
                            "watchererror",
                            {
                                error,
                                path:
                                    change?.path ||
                                    "*",
                                recursive:
                                    true,
                                processed:
                                    processed - 1,
                                discarded:
                                    remaining
                            }
                        );

                        console.error(
                            "[SpeciedexTerminalState] " +
                            "Watcher recursion stopped:",
                            error
                        );

                        break;
                    }

                    const current =
                        this.notificationQueue.shift();

                    /*
                    ------------------------------------------------------
                    Watchers receive the live store reference locally.
                    emit() strips it before crossing the event bus or DOM.
                    ------------------------------------------------------
                    */
                    const detail = {
                        ...clone(
                            current
                        ),
                        state:
                            this
                    };

                    this.emit(
                        "change",
                        detail
                    );

                    this.emit(
                        `change:${current.path}`,
                        detail
                    );

                    for (
                        const [
                            watchedPath,
                            watchers
                        ] of [
                            ...this.watchers
                        ]
                    ) {
                        for (
                            const watcher of
                            [
                                ...watchers
                            ]
                        ) {
                            if (
                                !this.matchesWatcher(
                                    watchedPath,
                                    current.path,
                                    watcher.options
                                )
                            ) {
                                continue;
                            }

                            try {
                                watcher.callback(
                                    this.select(
                                        watchedPath
                                    ),
                                    clone(
                                        current.previous
                                    ),
                                    detail
                                );
                            } catch (error) {
                                this.reportWatcherError(
                                    error,
                                    watchedPath
                                );
                            }

                            if (
                                watcher.options.once ===
                                    true
                            ) {
                                watchers.delete(
                                    watcher
                                );
                            }
                        }

                        if (
                            !watchers.size
                        ) {
                            this.watchers.delete(
                                watchedPath
                            );
                        }
                    }

                    for (
                        const watcher of
                        [
                            ...this.globalWatchers
                        ]
                    ) {
                        try {
                            watcher.callback(
                                detail
                            );
                        } catch (error) {
                            this.reportWatcherError(
                                error,
                                "*"
                            );
                        }

                        if (
                            watcher.options.once ===
                                true
                        ) {
                            this.globalWatchers.delete(
                                watcher
                            );
                        }
                    }
                }
            } finally {
                this.notifying =
                    false;
            }
        }

        reportWatcherError(error, path) {
            this.metricsState.watcherErrors += 1;

            this.emit("watchererror", { error, path });
            if (window.console && typeof window.console.error === "function") {
                window.console.error(
                    `[SpeciedexTerminalState] Watcher failed at "${path}":`,
                    error
                );
            }
        }

        defineComputed(name, dependencies, compute, options = {}) {
            if (typeof dependencies === "function") {
                options = compute || {};
                compute = dependencies;
                dependencies = [];
            }
            if (typeof compute !== "function") {
                throw new TypeError("Computed state requires a function.");
            }
            const key =
                String(
                    name ||
                    ""
                ).trim();

            if (
                !key ||
                FORBIDDEN_PATH_PARTS.has(
                    key
                )
            ) {
                throw new TypeError("Computed state requires a name.");
            }
            this.computed.set(key, {
                dependencies: Array.isArray(dependencies)
                    ? dependencies.map(pathString)
                    : [],
                compute,
                cache: options.cache !== false,
                valid: false,
                computing: false,
                value: undefined
            });
            return this;
        }

        compute(name, fallback = undefined) {
            this.assertActive();

            const entry =
                this.computed.get(
                    String(name)
                );

            if (!entry) {
                return fallback;
            }

            if (
                entry.cache &&
                entry.valid
            ) {
                return clone(
                    entry.value
                );
            }

            if (entry.computing) {
                throw new Error(
                    `Circular computed-state dependency: ${name}`
                );
            }

            entry.computing = true;

            try {
                const value =
                    entry.compute(
                        this
                    );

                entry.value =
                    clone(value);

                entry.valid = true;

                return clone(
                    value
                );
            } finally {
                entry.computing = false;
            }
        }

        invalidateComputed(changedPath = "") {
            for (const entry of this.computed.values()) {
                if (!entry.dependencies.length || entry.dependencies.some(path =>
                    path === changedPath || changedPath.startsWith(`${path}.`) ||
                    path.startsWith(`${changedPath}.`))) {
                    entry.valid = false;
                }
            }
        }

        snapshot(path = "") {
            this.assertActive();
            return clone(path ? this.get(path) : this.tree);
        }

        export(options = {}) {
            const envelope = options.envelope === false
                ? this.snapshot()
                : {
                    format: "speciedex-terminal-state",
                    version: VERSION,
                    exportedAt: nowISO(),
                    revision: this.revision,
                    state: this.snapshot()
                };
            return JSON.stringify(
                serializable(
                    envelope
                ),
                null,
                options.pretty ===
                    false
                    ? 0
                    : 2
            );
        }

        import(input, options = {}) {
            this.assertActive();
            const parsed = typeof input === "string" ? JSON.parse(input) : input;
            const state = parsed?.format === "speciedex-terminal-state"
                ? parsed.state
                : parsed;
            if (!isPlainObject(state)) {
                throw new TypeError("Imported state must be a plain object.");
            }
            const previous = this.snapshot();
            this.tree = options.replace === false
                ? mergeDeep(this.tree, state)
                : normalizeInitialState(state);
            this.revision += 1;
            if (options.clearHistory !== false) {
                this.history.length = 0;
                this.undoStack.length = 0;
                this.redoStack.length = 0;
            }
            this.invalidateComputed();
            this.emit("import", {
                previous,
                value: this.snapshot(),
                source: options.source || "import"
            });
            this.emit("change", {
                path: "",
                previous,
                value: this.snapshot(),
                source: options.source || "import"
            });
            if (options.persist !== false) {
                this.save();
            }
            if (options.broadcast !== false) {
                this.broadcast({ type: "snapshot", snapshot: this.snapshot() });
            }
            return this.snapshot();
        }

        reset(options = {}) {
            const target = options.toInitial === true
                ? clone(this.initial)
                : defaultState();
            const previous = this.snapshot();
            this.tree = normalizeInitialState(target);
            this.history.length = 0;
            this.undoStack.length = 0;
            this.redoStack.length = 0;
            this.revision += 1;
            this.invalidateComputed();
            this.emit("reset", { previous, value: this.snapshot() });
            this.emit("change", {
                path: "",
                previous,
                value: this.snapshot(),
                source: "reset"
            });
            if (options.persist !== false) {
                this.save();
            }

            if (options.broadcast !== false) {
                this.broadcast({
                    type:
                        "snapshot",
                    snapshot:
                        this.snapshot()
                });
            }

            return this.snapshot();
        }

        clear(options = {}) {
            return this.reset(options);
        }

        storage() {
            try {
                const storage = window.localStorage;
                const probe = `${this.storageKey}:probe`;
                storage.setItem(probe, "1");
                storage.removeItem(probe);
                return storage;
            } catch (error) {
                return null;
            }
        }

        save() {
            if (!this.persistEnabled) {
                return false;
            }
            const storage = this.storage();
            if (!storage) {
                return false;
            }
            try {
                storage.setItem(this.storageKey, this.export({ pretty: false }));
                this.emit("save", {
                    key: this.storageKey,
                    revision: this.revision
                });
                return true;
            } catch (error) {
                this.metricsState.persistenceErrors += 1;

                this.emit("persistenceerror", {
                    operation: "save",
                    error
                });
                return false;
            }
        }

        load(options = {}) {
            const storage = this.storage();
            if (!storage) {
                return false;
            }
            try {
                const raw = storage.getItem(this.storageKey);
                if (!raw) {
                    return false;
                }
                this.import(raw, {
                    source: "storage",
                    persist: false,
                    broadcast: options.broadcast === true,
                    clearHistory: true
                });
                this.emit("load", { key: this.storageKey });
                return true;
            } catch (error) {
                this.metricsState.persistenceErrors += 1;

                this.emit("persistenceerror", {
                    operation: "load",
                    error
                });
                return false;
            }
        }

        clearPersisted() {
            const storage = this.storage();
            if (!storage) {
                return false;
            }
            try {
                storage.removeItem(this.storageKey);
                this.emit("persistedclear", { key: this.storageKey });
                return true;
            } catch (error) {
                return false;
            }
        }

        schedulePersist() {
            if (!this.persistEnabled || this.transaction || this.replaying) {
                return;
            }
            window.clearTimeout(this.persistTimer);
            this.persistTimer = window.setTimeout(() => this.save(), 75);
        }

        attachSynchronization() {
            if (!this.syncEnabled) {
                return;
            }
            if (typeof window.BroadcastChannel === "function") {
                try {
                    this.channel = new window.BroadcastChannel(
                        `${this.storageKey}:channel`
                    );
                    const channelListener =
                        event =>
                            this.receiveBroadcast(
                                event.data
                            );

                    this.channel.addEventListener(
                        "message",
                        channelListener
                    );

                    this.listenerDisposers.push(
                        () =>
                            this.channel?.
                                removeEventListener?.(
                                    "message",
                                    channelListener
                                )
                    );
                } catch (error) {
                    this.channel = null;
                }
            }
            const storageListener = event => {
                if (event.key !== this.storageKey || !event.newValue) {
                    return;
                }
                try {
                    this.import(event.newValue, {
                        source: "storage-event",
                        persist: false,
                        broadcast: false,
                        clearHistory: false
                    });
                } catch (error) {
                    this.emit("syncerror", { error });
                }
            };
            window.addEventListener("storage", storageListener);
            this.listenerDisposers.push(() =>
                window.removeEventListener("storage", storageListener));
        }

        broadcast(message) {
            if (!this.syncEnabled || this.replaying || this.transaction ||
                !this.channel) {
                return false;
            }
            try {
                this.channel.postMessage({
                    ...clone(message),
                    origin: this.origin,
                    revision: this.revision,
                    timestamp: nowISO()
                });
                return true;
            } catch (error) {
                this.emit("syncerror", { error });
                return false;
            }
        }

        receiveBroadcast(message) {
            if (
                !message ||
                message.origin ===
                    this.origin
            ) {
                return;
            }

            const remoteRevision =
                Number(
                    message.revision
                ) ||
                0;

            if (
                remoteRevision &&
                remoteRevision <=
                    this.lastRemoteRevision
            ) {
                this.metricsState.syncIgnored +=
                    1;

                return;
            }

            this.lastRemoteRevision =
                Math.max(
                    this.lastRemoteRevision,
                    remoteRevision
                );

            this.metricsState.syncReceived +=
                1;

            this.replaying = true;
            try {
                if (message.type === "snapshot" && isPlainObject(message.snapshot)) {
                    this.import(message.snapshot, {
                        source: "broadcast",
                        persist: false,
                        broadcast: false,
                        clearHistory: false
                    });
                } else if (message.type === "change" && message.change) {
                    this.applyForward(message.change, {
                        source: "broadcast",
                        persist: false,
                        broadcast: false,
                        undoable: false
                    });
                }
            } finally {
                this.replaying = false;
            }
            this.emit("sync", clone(message));
        }

        syncFrom(snapshot, options = {}) {
            return this.import(snapshot, {
                replace: options.replace !== false,
                source: options.source || "sync",
                persist: options.persist !== false,
                broadcast: options.broadcast !== false,
                clearHistory: options.clearHistory === true
            });
        }

        attachRuntimeListeners() {
            const online = () => {
                if (this.destroyed) {
                    return;
                }

                this.set("runtime.online", true, {
                source: "browser",
                undoable: false,
                persist: false,
                broadcast: false
                });
            };

            const offline = () => {
                if (this.destroyed) {
                    return;
                }

                this.set("runtime.online", false, {
                source: "browser",
                undoable: false,
                persist: false,
                broadcast: false
                });
            };

            const visibility = () => {
                if (this.destroyed) {
                    return;
                }

                this.set(
                "runtime.visible",
                document.visibilityState !== "hidden",
                {
                    source: "browser",
                    undoable: false,
                    persist: false,
                    broadcast: false
                }
                );
            };

            window.addEventListener("online", online);
            window.addEventListener("offline", offline);
            document.addEventListener("visibilitychange", visibility);
            this.listenerDisposers.push(
                () => window.removeEventListener("online", online),
                () => window.removeEventListener("offline", offline),
                () => document.removeEventListener(
                    "visibilitychange", visibility)
            );
        }

        emit(name, detail = {}) {
            if (
                this.destroyed &&
                name !== "destroy"
            ) {
                return false;
            }

            const eventName =
                String(name || "").trim();

            if (
                !eventName ||
                this.activeEmits.has(eventName)
            ) {
                return false;
            }

            this.invalidateComputed(
                detail?.path ||
                ""
            );

            /*
            --------------------------------------------------------------
            The live StateStore reference is useful to local watchers but
            must never be recursively serialized into event-bus/DOM payloads.
            --------------------------------------------------------------
            */
            const sourceDetail =
                detail &&
                typeof detail === "object"
                    ? {
                        ...detail
                    }
                    : {
                        value:
                            detail
                    };

            if (
                sourceDetail.state ===
                this
            ) {
                delete sourceDetail.state;
            }

            const payload = {
                storeId:
                    this.id,
                ...serializable(
                    sourceDetail
                )
            };

            this.activeEmits.add(
                eventName
            );

            try {
                dispatchSafe(
                    this,
                    eventName,
                    payload
                );

                try {
                    this.context.events?.emit?.(
                        `state:${eventName}`,
                        payload
                    );
                } catch (_error) {
                    /* External event-bus failures are isolated. */
                }

                dispatchSafe(
                    this.contextRoot,
                    `speciedex:terminal-state-${eventName}`,
                    payload,
                    {
                        bubbles:
                            true
                    }
                );

                /*
                ----------------------------------------------------------
                Do not deliver the same state event twice to document.
                Connected roots already bubble there.
                ----------------------------------------------------------
                */
                if (
                    !this.contextRoot ||
                    !this.contextRoot.isConnected
                ) {
                    dispatchSafe(
                        document,
                        `speciedex:terminal-state-${eventName}`,
                        payload
                    );
                }

                return true;
            } finally {
                this.activeEmits.delete(
                    eventName
                );
            }
        }

        metrics() {
            let watcherCount = this.globalWatchers.size;
            for (const watchers of this.watchers.values()) {
                watcherCount += watchers.size;
            }
            return {
                id: this.id,
                version: this.version,
                revision: this.revision,
                roots: Object.keys(this.tree).length,
                history: this.history.length,
                undo: this.undoStack.length,
                redo: this.redoStack.length,
                watchers: watcherCount,
                computed: this.computed.size,
                transaction: this.transaction
                    ? this.transaction.label
                    : null,
                persisted: this.persistEnabled,
                synchronized: this.syncEnabled,
                notifying: this.notifying,
                activeEmits:
                    this.activeEmits.size,
                notificationQueue:
                    this.notificationQueue.length,
                lastRemoteRevision:
                    this.lastRemoteRevision,
                counters: {
                    ...this.metricsState
                },
                destroyed: this.destroyed
            };
        }

        beginTask(id, label = id, metadata = {}) {
            const taskId =
                String(
                    id ||
                    randomId("task")
                )
                    .replace(
                        /[^a-zA-Z0-9:_-]/g,
                        "_"
                    );
            this.transactionScope("begin-task", () => {
                this.set(`loading.tasks.${taskId}`, {
                    id: taskId,
                    label: String(label || taskId),
                    metadata: clone(metadata),
                    state: "running",
                    progress: 0,
                    startedAt: nowISO(),
                    finishedAt: null,
                    error: null
                });
                this.set("loading.active", true);
                this.recalculateLoading();
            });
            return taskId;
        }

        updateTask(id, patch = {}) {
            const path =
                `loading.tasks.${String(id).replace(/[^a-zA-Z0-9:_-]/g, "_")}`;
            if (!this.has(path)) {
                return false;
            }
            this.merge(path, patch, { source: "task-update" });
            this.recalculateLoading();
            return this.get(path);
        }

        finishTask(id, success = true, result = null) {
            const path =
                `loading.tasks.${String(id).replace(/[^a-zA-Z0-9:_-]/g, "_")}`;
            if (!this.has(path)) {
                return false;
            }
            this.transactionScope("finish-task", () => {
                this.merge(path, {
                    state: success ? "complete" : "failed",
                    progress: 100,
                    result: success ? clone(result) : null,
                    error: success ? null : String(
                        result?.message || result || "Task failed"
                    ),
                    finishedAt: nowISO()
                });
                this.increment(success
                    ? "loading.completed"
                    : "loading.failed", 1);
                this.recalculateLoading();
            });
            return this.get(path);
        }

        recalculateLoading() {
            const tasks = Object.values(this.get("loading.tasks", {}));
            const running = tasks.filter(task => task.state === "running");
            const progress = tasks.length
                ? tasks.reduce((sum, task) =>
                    sum + Math.max(0, Math.min(100,
                        Number(task.progress) || 0)), 0) / tasks.length
                : 0;
            this.set("loading.active", running.length > 0, {
                source: "loading",
                undoable: false
            });
            this.set("loading.progress", Math.round(progress), {
                source: "loading",
                undoable: false
            });
        }

        notifyUser(message, type = "info", options = {}) {
            const item = {
                id: options.id || randomId("notification"),
                type: String(type || "info"),
                title: options.title || null,
                message: String(message || ""),
                read: false,
                sticky: options.sticky === true,
                metadata: clone(options.metadata || {}),
                timestamp: nowISO()
            };
            this.transactionScope("notification", () => {
                this.push(
                    "notifications.items",
                    item
                );

                const items =
                    this.select(
                        "notifications.items",
                        []
                    );

                if (
                    items.length >
                    this.maximumNotificationItems
                ) {
                    this.set(
                        "notifications.items",
                        items.slice(
                            -this.maximumNotificationItems
                        )
                    );
                }

                this.increment(
                    "notifications.unread",
                    1
                );
            });
            return item;
        }

        markNotificationRead(id) {
            const items = this.select("notifications.items", []);
            const item = items.find(entry => entry.id === id);
            if (!item || item.read) {
                return false;
            }
            item.read = true;
            this.set("notifications.items", items);
            this.set("notifications.unread",
                items.filter(entry => !entry.read).length);
            return true;
        }

        clearNotifications() {
            this.batch([
                { path: "notifications.items", value: [] },
                { path: "notifications.unread", value: 0 }
            ], { label: "clear-notifications" });
        }

        beginSearch(query, options = {}) {
            this.transactionScope("begin-search", () => {
                this.set("search.query", String(query || ""));
                this.set("search.filters", clone(options.filters || {}));
                this.set("search.running", true);
                this.set("search.error", null);
                this.set("search.lastRun", nowISO());
            });
        }

        completeSearch(results = [], options = {}) {
            const normalized =
                Array.isArray(
                    results
                )
                    ? results.slice(
                        0,
                        this.maximumSearchResults
                    )
                    : [];
            this.transactionScope("complete-search", () => {
                this.set("search.results", normalized);
                this.set("search.count",
                    Number.isFinite(options.count)
                        ? options.count
                        : normalized.length);
                this.set("search.running", false);
                this.set("search.error", options.error || null);
            });
            return normalized;
        }

        beginScan(target = null) {
            this.batch([
                { path: "scan.running", value: true },
                { path: "scan.progress", value: 0 },
                { path: "scan.target", value: target },
                { path: "scan.error", value: null }
            ], { label: "begin-scan" });
        }

        finishScan(issues = [], error = null) {
            this.batch([
                { path: "scan.running", value: false },
                { path: "scan.progress", value: 100 },
                {
                    path: "scan.issues",
                    value:
                        Array.isArray(
                            issues
                        )
                            ? issues.slice(
                                0,
                                this.maximumScanIssues
                            )
                            : []
                },
                { path: "scan.error", value: error ? String(error) : null },
                { path: "scan.lastRun", value: nowISO() }
            ], { label: "finish-scan" });
        }

        providerUpdate(name, data = {}) {
            const provider = String(name || "").trim();
            if (
                !provider ||
                FORBIDDEN_PATH_PARTS.has(
                    provider
                ) ||
                provider.includes(".")
            ) {
                throw new TypeError(
                    "A safe provider name is required."
                );
            }
            const value = this.merge(`providers.statistics.${provider}`, data, {
                source: "provider"
            });
            this.set("providers.lastUpdatedAt", nowISO(), {
                source: "provider",
                undoable: false
            });
            return value;
        }

        libraryCollection(name, records = []) {
            const collection = String(name || "").trim();
            if (
                !collection ||
                FORBIDDEN_PATH_PARTS.has(
                    collection
                ) ||
                collection.includes(".")
            ) {
                throw new TypeError(
                    "A safe collection name is required."
                );
            }
            const normalized =
                Array.isArray(
                    records
                )
                    ? records.slice(
                        0,
                        this.maximumLibraryRecords
                    )
                    : [];
            this.transactionScope("library-collection", () => {
                this.set(`library.collections.${collection}`, normalized);
                this.set("library.active", collection);
                this.set("library.count", normalized.length);
                this.set("library.updatedAt", nowISO());
            });
            return normalized;
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            window.clearTimeout(
                this.persistTimer
            );

            if (this.persistEnabled) {
                this.save();
            }

            for (
                const dispose
                of this.listenerDisposers.splice(0)
            ) {
                try {
                    dispose();
                } catch (_error) {
                    /* Ignore teardown failures. */
                }
            }

            if (this.channel) {
                try {
                    this.channel.close();
                } catch (_error) {
                    /* Ignore channel teardown failures. */
                }

                this.channel = null;
            }

            this.emit(
                "destroy",
                {
                    version:
                        VERSION
                }
            );

            this.watchers.clear();
            this.globalWatchers.clear();
            this.activeEmits.clear();
            this.notificationQueue.length = 0;
            this.computed.clear();
            this.notificationQueue = [];
            this.transaction = null;

            if (
                this.contextRoot?.[
                    STORE_SYMBOL
                ] ===
                    this
            ) {
                delete this.contextRoot[
                    STORE_SYMBOL
                ];
            }

            if (
                this.context.state ===
                    this
            ) {
                delete this.context.state;
            }

            if (
                this.context.stateStore ===
                    this
            ) {
                delete this.context.stateStore;
            }

            this.destroyed = true;

            return true;
        }

        dispose() {
            this.destroy();
        }
    }

    StateStore.DELETE = DELETE;
    StateStore.ROOT_KEYS = ROOT_KEYS;
    StateStore.VERSION = VERSION;

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
            safeContext.stateStore instanceof
                StateStore
                ? safeContext.stateStore
                : safeContext.state instanceof
                    StateStore
                    ? safeContext.state
                    : safeContext.services?.get?.(
                        "state"
                    ) ||
                    root?.[
                        STORE_SYMBOL
                    ];

        if (
            existing instanceof
                StateStore &&
            !existing.destroyed
        ) {
            safeContext.state =
                existing;

            safeContext.stateStore =
                existing;

            safeContext.registerService?.(
                "state",
                existing
            );

            return existing;
        }

        const dataset =
            root.dataset ||
            {};

        const config =
            safeContext.config?.
                state ||
            {};

        const store =
            new StateStore(
                config.initial ||
                {},
                {
                    context:
                        safeContext,

                    contextRoot:
                        root,

                    storageKey:
                        dataset.
                            terminalStateKey ||
                        config.storageKey ||
                        DEFAULT_STORAGE_KEY,

                    historyLimit:
                        clampInteger(
                            dataset.
                                terminalStateHistory ??
                            config.historyLimit,
                            DEFAULT_HISTORY_LIMIT,
                            1,
                            100000
                        ),

                    undoLimit:
                        clampInteger(
                            dataset.
                                terminalStateUndo ??
                            config.undoLimit,
                            DEFAULT_UNDO_LIMIT,
                            1,
                            100000
                        ),

                    persist:
                        parseBoolean(
                            dataset.
                                terminalStatePersistence ??
                            config.persist,
                            true
                        ),

                    sync:
                        parseBoolean(
                            dataset.
                                terminalStateSynchronization ??
                            config.sync,
                            true
                        ),

                    maximumNotificationItems:
                        clampInteger(
                            dataset.
                                terminalStateNotificationLimit ??
                            config.maximumNotificationItems,
                            DEFAULT_NOTIFICATION_LIMIT,
                            1,
                            100000
                        ),

                    maximumSearchResults:
                        clampInteger(
                            dataset.
                                terminalStateSearchResultLimit ??
                            config.maximumSearchResults,
                            DEFAULT_SEARCH_RESULT_LIMIT,
                            1,
                            1000000
                        ),

                    maximumScanIssues:
                        clampInteger(
                            dataset.
                                terminalStateScanIssueLimit ??
                            config.maximumScanIssues,
                            DEFAULT_SCAN_ISSUE_LIMIT,
                            1,
                            1000000
                        ),

                    maximumLibraryRecords:
                        clampInteger(
                            dataset.
                                terminalStateLibraryRecordLimit ??
                            config.maximumLibraryRecords,
                            DEFAULT_LIBRARY_RECORD_LIMIT,
                            1,
                            1000000
                        )
                }
            );

        root[
            STORE_SYMBOL
        ] =
            store;

        if (store.persistEnabled) {
            store.load({
                broadcast:
                    false
            });
        }

        safeContext.state =
            store;

        safeContext.stateStore =
            store;

        safeContext.registerService?.(
            "state",
            store
        );

        dispatchSafe(
            document,
            "speciedex:terminal-state-ready",
            {
                context:
                    safeContext,
                store,
                version:
                    VERSION
            }
        );

        return store;
    }

    function resolveCommandContext(payload = {}) {
        return (
            payload.context ||
            payload.terminal?.context ||
            payload.app?.context ||
            payload
        );
    }

    function requireState(context = {}) {
        const safeContext =
            isObject(context)
                ? context
                : {};

        const store =
            safeContext.stateStore ||
            safeContext.state ||
            safeContext.services?.get?.(
                "state"
            ) ||
            initialize(safeContext);

        if (
            !(store instanceof StateStore) ||
            store.destroyed
        ) {
            throw new Error(
                "State service is unavailable."
            );
        }

        return store;
    }

    function writeResult(
        payload,
        value,
        type = "data"
    ) {
        if (
            typeof payload.writeJSON ===
                "function" &&
            typeof value !==
                "string"
        ) {
            return payload.writeJSON(
                value
            );
        }

        if (
            typeof payload.write ===
                "function"
        ) {
            return payload.write(
                typeof value ===
                    "string"
                    ? value
                    : JSON.stringify(
                        serializable(value),
                        null,
                        2
                    ),
                type
            );
        }

        if (
            typeof payload.writeLine ===
                "function"
        ) {
            return payload.writeLine(
                typeof value ===
                    "string"
                    ? value
                    : JSON.stringify(
                        serializable(value),
                        null,
                        2
                    )
            );
        }

        return value;
    }

    const commands = [
        {
            name: "state",
            aliases: ["store"],
            category: "system",
            description: "Inspect or manage terminal application state.",
            usage: "state [show|get|set|delete|undo|redo|save|load|reset|metrics] [path] [value]",
            handler: ({
                args = [],
                context,
                writeJSON,
                write
            }) => {
                const state = context.stateStore || context.state;
                if (!state) {
                    throw new Error("State service is unavailable.");
                }
                const action = String(args[0] || "show").toLowerCase();
                const path = args[1] || "";
                if (action === "show") {
                    return writeJSON(path
                        ? state.snapshot(path)
                        : state.snapshot());
                }
                if (action === "get") {
                    return writeJSON(state.snapshot(path));
                }
                if (action === "set") {
                    if (!path) {
                        throw new Error("Usage: state set <path> <value>");
                    }
                    const raw = args.slice(2).join(" ");
                    let value = raw;
                    try {
                        value = JSON.parse(raw);
                    } catch (error) {}
                    state.set(path, value, { source: "command" });
                    return writeJSON(state.snapshot(path));
                }
                if (action === "delete") {
                    return write(state.delete(path)
                        ? `Deleted state path: ${path}`
                        : `State path not found: ${path}`,
                    "info");
                }
                if (action === "undo" || action === "redo") {
                    return write(state[action]()
                        ? `State ${action} complete.`
                        : `Nothing to ${action}.`, "info");
                }
                if (action === "save" || action === "load") {
                    return write(state[action]()
                        ? `State ${action} complete.`
                        : `State ${action} was unavailable.`, "info");
                }
                if (action === "reset") {
                    state.reset();
                    return write("State reset complete.", "success");
                }
                if (action === "metrics") {
                    return writeJSON(state.metrics());
                }
                throw new Error(`Unknown state action: ${action}`);
            }
        }
    ];

    for (const command of commands) {
        const handler =
            command.handler;

        command.handler =
            payload => {
                const safePayload =
                    isObject(payload)
                        ? payload
                        : {};

                safePayload.context =
                    resolveCommandContext(
                        safePayload
                    );

                const store =
                    requireState(
                        safePayload.context
                    );

                safePayload.context.state =
                    store;

                safePayload.context.stateStore =
                    store;

                safePayload.args =
                    Array.isArray(
                        safePayload.args
                    )
                        ? [
                            ...safePayload.args
                        ]
                        : [];

                safePayload.writeJSON =
                    typeof safePayload.writeJSON ===
                        "function"
                        ? safePayload.writeJSON
                        : value =>
                            writeResult(
                                safePayload,
                                value
                            );

                safePayload.write =
                    typeof safePayload.write ===
                        "function"
                        ? safePayload.write
                        : (
                            value,
                            type
                        ) =>
                            writeResult(
                                safePayload,
                                value,
                                type
                            );

                return handler(
                    safePayload
                );
            };
    }

    const api = Object.freeze({
        name: MODULE_NAME,
        version: VERSION,
        StateStore,
        STORE_SYMBOL,
        ROOT_KEYS,
        FORBIDDEN_PATH_PARTS,
        DELETE,
        clone,
        deepEqual,
        splitPath,
        pathString,
        serializable,
        parseBoolean,
        clampInteger,
        dispatchSafe,
        resolveCommandContext,
        create(initial = {}, options = {}) {
            return new StateStore(initial, options);
        },
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalState = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    dispatchSafe(
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