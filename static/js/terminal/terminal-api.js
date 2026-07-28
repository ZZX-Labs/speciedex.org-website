/*
========================================================================
Speciedex.org
Terminal API Client
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "API";
    const SERVICE_NAME = "api";
    const VERSION = "3.2.0";

    const API_SYMBOL =
        Symbol.for("speciedex.terminal.api.client");

    const DEFAULT_BASE_URL = "/api/speciedex/v1/";
    const DEFAULT_TIMEOUT_MS = 30000;
    const DEFAULT_CONCURRENCY = 6;
    const DEFAULT_RETRIES = 2;
    const DEFAULT_RETRY_BASE_MS = 400;
    const DEFAULT_RETRY_MAX_MS = 15000;
    const DEFAULT_HISTORY_LIMIT = 1000;
    const DEFAULT_CACHE_TTL_MS = 30000;
    const DEFAULT_CACHE_LIMIT = 500;
    const DEFAULT_DEDUPE_WINDOW_MS = 1000;

    const RETRYABLE_STATUS =
        new Set([408, 425, 429, 500, 502, 503, 504]);

    const BODYLESS_METHODS =
        new Set(["GET", "HEAD"]);

    const activeDispatches = new WeakMap();

    const RESERVED_KEYS =
        new Set([
            "__proto__",
            "prototype",
            "constructor"
        ]);

    function monotonicNow() {
        return (
            typeof performance !== "undefined" &&
            typeof performance.now === "function"
        )
            ? monotonicNow()
            : Date.now();
    }

    function now() {
        return Date.now();
    }

    function iso(timestamp = now()) {
        const date = new Date(timestamp);

        return Number.isFinite(date.getTime())
            ? date.toISOString()
            : new Date().toISOString();
    }

    function isObject(value) {
        return (
            value !== null &&
            typeof value === "object"
        );
    }

    function isPlainObject(value) {
        if (
            !isObject(value) ||
            Array.isArray(value) ||
            value instanceof Date
        ) {
            return false;
        }

        if (
            typeof FormData === "function" &&
            value instanceof FormData
        ) {
            return false;
        }

        if (
            typeof URLSearchParams === "function" &&
            value instanceof URLSearchParams
        ) {
            return false;
        }

        if (
            typeof Blob === "function" &&
            value instanceof Blob
        ) {
            return false;
        }

        if (
            typeof ArrayBuffer === "function" &&
            value instanceof ArrayBuffer
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

    function parseBoolean(value, fallback = false) {
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
            String(value).trim().toLowerCase();

        if (
            ["1", "true", "yes", "on", "enabled"].includes(normalized)
        ) {
            return true;
        }

        if (
            ["0", "false", "no", "off", "disabled"].includes(normalized)
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
            Number.parseInt(value, 10);

        return Number.isFinite(parsed)
            ? Math.min(
                maximum,
                Math.max(minimum, parsed)
            )
            : fallback;
    }

    function clone(value, seen = new WeakMap()) {
        if (
            value === undefined ||
            value === null ||
            typeof value !== "object"
        ) {
            return typeof value === "bigint"
                ? String(value)
                : value;
        }

        if (typeof structuredClone === "function") {
            try {
                return structuredClone(value);
            } catch (_error) {
                /* Continue with deterministic fallback. */
            }
        }

        if (seen.has(value)) {
            return seen.get(value);
        }

        if (value instanceof Date) {
            return new Date(value.getTime());
        }

        if (value instanceof RegExp) {
            return new RegExp(
                value.source,
                value.flags
            );
        }

        if (value instanceof Map) {
            const output = new Map();
            seen.set(value, output);

            for (const [key, item] of value.entries()) {
                output.set(
                    clone(key, seen),
                    clone(item, seen)
                );
            }

            return output;
        }

        if (value instanceof Set) {
            const output = new Set();
            seen.set(value, output);

            for (const item of value.values()) {
                output.add(
                    clone(item, seen)
                );
            }

            return output;
        }

        if (Array.isArray(value)) {
            const output = [];
            seen.set(value, output);

            for (const item of value) {
                output.push(
                    clone(item, seen)
                );
            }

            return output;
        }

        const output = {};
        seen.set(value, output);

        for (const [key, item] of Object.entries(value)) {
            if (
                RESERVED_KEYS.has(key)
            ) {
                continue;
            }

            output[key] =
                clone(item, seen);
        }

        return output;
    }

    function safeStringify(value, compact = false) {
        const seen = new WeakSet();

        return JSON.stringify(
            value,
            (_key, item) => {
                if (
                    item &&
                    typeof item === "object"
                ) {
                    if (seen.has(item)) {
                        return "[Circular]";
                    }

                    seen.add(item);
                }

                if (typeof item === "bigint") {
                    return String(item);
                }

                return item;
            },
            compact ? 0 : 2
        );
    }

    function safeDispatch(
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
                        detail,
                        bubbles:
                            options.bubbles === true
                    }
                )
            );
        } catch (_error) {
            return false;
        } finally {
            names.delete(name);
        }
    }

    function normalizeBaseURL(
        value,
        options = {}
    ) {
        const base =
            String(
                value ||
                DEFAULT_BASE_URL
            ).trim() ||
            DEFAULT_BASE_URL;

        const origin =
            window.location?.origin &&
            window.location.origin !== "null"
                ? window.location.origin
                : document.baseURI
                    ? new URL(document.baseURI).origin
                    : "http://localhost";

        const url =
            new URL(base, origin);

        if (
            options.allowCrossOrigin !== true &&
            url.origin !== origin
        ) {
            throw new TypeError(
                "The terminal API base URL must use the current origin."
            );
        }

        if (!url.pathname.endsWith("/")) {
            url.pathname += "/";
        }

        return url;
    }

    function normalizePath(path) {
        const value =
            String(path ?? "").trim();

        if (!value) {
            throw new TypeError(
                "An API path is required."
            );
        }

        if (value.includes("\\")) {
            throw new TypeError(
                `Invalid API path: ${path}`
            );
        }

        if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
            throw new TypeError(
                "Absolute API URLs are not allowed."
            );
        }

        const normalized =
            value.replace(/^\/+/, "");

        if (
            normalized
                .split("/")
                .some(part => part === "..")
        ) {
            throw new TypeError(
                "Parent-directory API paths are not allowed."
            );
        }

        return normalized;
    }

    function appendParameter(
        searchParams,
        key,
        value
    ) {
        if (
            value === undefined ||
            value === null ||
            value === ""
        ) {
            return;
        }

        if (Array.isArray(value)) {
            for (const item of value) {
                appendParameter(
                    searchParams,
                    key,
                    item
                );
            }

            return;
        }

        if (value instanceof Date) {
            searchParams.append(
                key,
                value.toISOString()
            );

            return;
        }

        if (typeof value === "object") {
            searchParams.append(
                key,
                safeStringify(value, true)
            );

            return;
        }

        searchParams.append(
            key,
            String(value)
        );
    }

    function mergeSignals(signals = []) {
        const active =
            signals.filter(signal =>
                signal &&
                typeof signal.aborted === "boolean"
            );

        if (!active.length) {
            return {
                signal: undefined,
                cleanup() {}
            };
        }

        if (active.length === 1) {
            return {
                signal: active[0],
                cleanup() {}
            };
        }

        if (
            typeof AbortSignal !== "undefined" &&
            typeof AbortSignal.any === "function"
        ) {
            return {
                signal:
                    AbortSignal.any(active),
                cleanup() {}
            };
        }

        if (typeof AbortController !== "function") {
            return {
                signal: active[0],
                cleanup() {}
            };
        }

        const controller =
            new AbortController();

        const listeners = [];

        const abort = signal => {
            if (!controller.signal.aborted) {
                try {
                    controller.abort(signal.reason);
                } catch (_error) {
                    controller.abort();
                }
            }
        };

        for (const signal of active) {
            if (signal.aborted) {
                abort(signal);
                continue;
            }

            const listener = () =>
                abort(signal);

            signal.addEventListener?.(
                "abort",
                listener,
                {
                    once: true
                }
            );

            listeners.push([
                signal,
                listener
            ]);
        }

        return {
            signal:
                controller.signal,

            cleanup() {
                for (
                    const [signal, listener]
                    of listeners
                ) {
                    signal.removeEventListener?.(
                        "abort",
                        listener
                    );
                }
            }
        };
    }

    async function parseResponse(response) {
        if (
            response.status === 204 ||
            response.status === 205 ||
            response.status === 304
        ) {
            return null;
        }

        if (
            response.type === "opaque"
        ) {
            return null;
        }

        const contentType =
            response.headers
                .get("content-type") ||
            "";

        if (
            contentType.includes("application/json") ||
            contentType.includes("+json")
        ) {
            const text =
                await response.text();

            return text
                ? JSON.parse(
                    text,
                    (
                        key,
                        value
                    ) =>
                        RESERVED_KEYS.has(key)
                            ? undefined
                            : value
                )
                : null;
        }

        if (
            contentType.startsWith("text/") ||
            contentType.includes("xml") ||
            contentType.includes("javascript")
        ) {
            return response.text();
        }

        return response.arrayBuffer();
    }

    function extractErrorMessage(
        payload,
        status
    ) {
        if (
            typeof payload === "string" &&
            payload.trim()
        ) {
            return payload.trim();
        }

        if (
            payload &&
            typeof payload === "object"
        ) {
            if (
                typeof payload.error === "object" &&
                payload.error?.message
            ) {
                return payload.error.message;
            }

            return (
                payload.error ||
                payload.message ||
                payload.detail ||
                `API request failed with HTTP ${status}.`
            );
        }

        return (
            `API request failed with HTTP ${status}.`
        );
    }

    function createID(prefix = "api") {
        if (
            window.crypto &&
            typeof window.crypto.randomUUID ===
                "function"
        ) {
            return (
                `${prefix}:${window.crypto.randomUUID()}`
            );
        }

        return (
            `${prefix}:${now().toString(36)}:` +
            `${Math.random().toString(36).slice(2)}`
        );
    }

    function abortError(
        message = "The operation was aborted."
    ) {
        try {
            return new DOMException(
                message,
                "AbortError"
            );
        } catch (_error) {
            const error = new Error(message);
            error.name = "AbortError";
            return error;
        }
    }

    function sleep(
        milliseconds,
        signal = null
    ) {
        return new Promise(
            (resolve, reject) => {
                if (signal?.aborted) {
                    reject(
                        signal.reason ||
                        abortError()
                    );

                    return;
                }

                let settled = false;

                const cleanup = () => {
                    signal?.removeEventListener(
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

                const onResolve =
                    finish(resolve);

                const onReject =
                    finish(reject);

                const timer =
                    window.setTimeout(
                        () => {
                            onResolve();
                        },
                        Math.max(
                            0,
                            Number(milliseconds) || 0
                        )
                    );

                const onAbort = () => {
                    window.clearTimeout(timer);

                    onReject(
                        signal.reason ||
                        abortError()
                    );
                };

                signal?.addEventListener(
                    "abort",
                    onAbort,
                    { once: true }
                );
            }
        );
    }

    function parseRetryAfter(response) {
        const value =
            response?.headers
                ?.get?.("retry-after");

        if (!value) {
            return null;
        }

        const seconds =
            Number(value);

        if (Number.isFinite(seconds)) {
            return Math.max(
                0,
                seconds * 1000
            );
        }

        const timestamp =
            Date.parse(value);

        return Number.isFinite(timestamp)
            ? Math.max(
                0,
                timestamp - now()
            )
            : null;
    }

    function parseCommandParameters(items = []) {
        const output =
            Object.create(null);

        for (const item of items) {
            const text = String(item);
            const index = text.indexOf("=");

            const key =
                index >= 0
                    ? text.slice(0, index)
                    : text;

            if (
                !key ||
                RESERVED_KEYS.has(key)
            ) {
                continue;
            }

            const value =
                index >= 0
                    ? text.slice(index + 1)
                    : "true";

            if (Object.prototype.hasOwnProperty.call(
                output,
                key
            )) {
                output[key] =
                    Array.isArray(output[key])
                        ? [
                            ...output[key],
                            value
                        ]
                        : [
                            output[key],
                            value
                        ];
            } else {
                output[key] = value;
            }
        }

        return output;
    }

    class PriorityQueue {
        constructor() {
            this.items = [];
            this.sequence = 0;
        }

        push(task) {
            this.items.push({
                ...task,
                sequence:
                    this.sequence++
            });

            this.items.sort(
                (left, right) =>
                    right.priority -
                        left.priority ||
                    left.sequence -
                        right.sequence
            );
        }

        shift() {
            return (
                this.items.shift() ||
                null
            );
        }

        remove(predicate) {
            const removed = [];

            this.items =
                this.items.filter(task => {
                    if (predicate(task)) {
                        removed.push(task);
                        return false;
                    }

                    return true;
                });

            return removed;
        }

        clear() {
            const items =
                this.items;

            this.items = [];

            return items;
        }

        snapshot() {
            return this.items.map(task => ({
                id: task.id,
                method: task.method,
                path: task.path,
                priority: task.priority,
                group:
                    task.group || null,
                createdAt:
                    task.createdAt
            }));
        }

        get size() {
            return this.items.length;
        }
    }

    class APIError extends Error {
        constructor(message, details = {}) {
            super(message);

            this.name =
                "SpeciedexAPIError";

            this.status =
                details.status ?? 0;

            this.statusText =
                details.statusText || "";

            this.method =
                details.method || "GET";

            this.url =
                details.url || "";

            this.payload =
                details.payload;

            this.response =
                details.response || null;

            this.cause =
                details.cause;

            this.requestId =
                details.requestId || null;

            this.attempt =
                details.attempt || 0;

            this.code =
                details.code || null;

            this.retryable =
                details.retryable === true;
        }

        toJSON() {
            return {
                name: this.name,
                message: this.message,
                status: this.status,
                statusText:
                    this.statusText,
                method: this.method,
                url: this.url,
                requestId:
                    this.requestId,
                attempt: this.attempt,
                code: this.code,
                retryable:
                    this.retryable,
                payload:
                    clone(this.payload)
            };
        }
    }

    class APIClient extends EventTarget {
        constructor(context = {}, options = {}) {
            super();

            this.context =
                isObject(context)
                    ? context
                    : {};

            const root =
                isElement(this.context.root)
                    ? this.context.root
                    : document.documentElement;

            this.context.root =
                root;

            const dataset =
                root?.dataset || {};

            this.allowCrossOrigin =
                parseBoolean(
                    options.allowCrossOrigin ??
                    dataset.terminalApiAllowCrossOrigin,
                    false
                );

            this.baseURL =
                normalizeBaseURL(
                    options.baseURL ||
                    dataset.terminalApiBase ||
                    DEFAULT_BASE_URL,
                    {
                        allowCrossOrigin:
                            this.allowCrossOrigin
                    }
                );

            this.timeout =
                Number.isFinite(
                    Number(
                        options.timeout ??
                        dataset.terminalApiTimeout
                    )
                )
                    ? Math.max(
                        0,
                        Number(
                            options.timeout ??
                            dataset.terminalApiTimeout
                        )
                    )
                    : DEFAULT_TIMEOUT_MS;

            this.credentials =
                options.credentials ||
                dataset.terminalApiCredentials ||
                "same-origin";

            this.defaultHeaders =
                Object.freeze({
                    Accept:
                        "application/json",
                    ...(options.headers || {})
                });

            this.concurrency =
                clampInteger(
                    options.concurrency ??
                    dataset.terminalApiConcurrency,
                    DEFAULT_CONCURRENCY,
                    1,
                    128
                );

            this.defaultRetries =
                clampInteger(
                    options.retries ??
                    dataset.terminalApiRetries,
                    DEFAULT_RETRIES,
                    0,
                    20
                );

            this.retryBase =
                clampInteger(
                    options.retryBase ??
                    dataset.terminalApiRetryBase,
                    DEFAULT_RETRY_BASE_MS,
                    0,
                    60000
                );

            this.retryMax =
                clampInteger(
                    options.retryMax ??
                    dataset.terminalApiRetryMax,
                    DEFAULT_RETRY_MAX_MS,
                    0,
                    600000
                );

            this.historyLimit =
                clampInteger(
                    options.historyLimit ??
                    dataset.terminalApiHistoryLimit,
                    DEFAULT_HISTORY_LIMIT,
                    1,
                    100000
                );

            this.cacheTTL =
                clampInteger(
                    options.cacheTTL ??
                    dataset.terminalApiCacheTtl,
                    DEFAULT_CACHE_TTL_MS,
                    0,
                    86400000
                );

            this.cacheLimit =
                clampInteger(
                    options.cacheLimit ??
                    dataset.terminalApiCacheLimit,
                    DEFAULT_CACHE_LIMIT,
                    0,
                    100000
                );

            this.dedupeWindow =
                clampInteger(
                    options.dedupeWindow ??
                    dataset.terminalApiDedupeWindow,
                    DEFAULT_DEDUPE_WINDOW_MS,
                    0,
                    60000
                );

            this.queue = new PriorityQueue();
            this.active = new Map();
            this.pending = new Map();
            this.groups = new Map();
            this.cache = new Map();
            this.history = [];
            this.profiles = new Map();
            this.providers = new Map();
            this.streams = new Set();
            this.sockets = new Set();

            this.interceptors = {
                request: [],
                response: [],
                error: []
            };

            this.activeProfile = null;
            this.destroyed = false;
            this.watchers = new Set();
            this.emitting = false;

            this.metrics = {
                queued: 0,
                started: 0,
                completed: 0,
                failed: 0,
                aborted: 0,
                retried: 0,
                deduplicated: 0,
                cacheHits: 0,
                cacheMisses: 0,
                totalLatency: 0,
                lastLatency: 0,
                streamsOpened: 0,
                socketsOpened: 0
            };
        }

        watch(callback, options = {}) {
            this.assertAvailable();

            if (typeof callback !== "function") {
                throw new TypeError(
                    "API watcher must be a function."
                );
            }

            this.watchers.add(callback);

            if (options.immediate === true) {
                callback(
                    {
                        type:
                            "initial",
                        timestamp:
                            iso(),
                        stats:
                            this.stats()
                    },
                    this
                );
            }

            return () =>
                this.watchers.delete(callback);
        }

        assertAvailable() {
            if (this.destroyed) {
                throw new Error(
                    "API client has been destroyed."
                );
            }
        }

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

            const payload = {
                client: this,
                timestamp:
                    iso(),
                ...detail
            };

            this.emitting =
                true;

            try {
                safeDispatch(
                    this,
                    name,
                    payload
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
                                type:
                                    name,
                                ...clone(payload)
                            },
                            this
                        );
                    } catch (_error) {
                        /* Watcher failures are isolated. */
                    }
                }

                try {
                    this.context.events?.emit?.(
                        `api:${name}`,
                        payload
                    );
                } catch (_error) {
                    /* Event bus is optional. */
                }

                safeDispatch(
                    this.context.root,
                    `speciedex:terminal-api-${name}`,
                    payload,
                    {
                        bubbles: true
                    }
                );

                safeDispatch(
                    document,
                    `speciedex:terminal-api-${name}`,
                    payload
                );

                return true;
            } finally {
                this.emitting =
                    false;
            }
        }

        url(path, params = {}) {
            const normalized =
                normalizePath(path);

            const url =
                new URL(
                    normalized,
                    this.baseURL
                );

            if (
                !this.allowCrossOrigin &&
                url.origin !==
                    this.baseURL.origin
            ) {
                throw new TypeError(
                    "Cross-origin terminal API requests are not permitted."
                );
            }

            for (
                const [key, value]
                of Object.entries(
                    isObject(params)
                        ? params
                        : {}
                )
            ) {
                if (RESERVED_KEYS.has(key)) {
                    continue;
                }

                appendParameter(
                    url.searchParams,
                    key,
                    value
                );
            }

            return url;
        }

        _effectiveConfiguration() {
            const profile =
                this.activeProfile
                    ? this.profiles.get(
                        this.activeProfile
                    )
                    : null;

            return {
                baseURL:
                    profile?.baseURL
                        ? new URL(profile.baseURL)
                        : this.baseURL,
                headers:
                    profile?.headers || {},
                credentials:
                    profile?.credentials ||
                    this.credentials
            };
        }

        addInterceptor(type, handler) {
            this.assertAvailable();

            if (
                ![
                    "request",
                    "response",
                    "error"
                ].includes(type)
            ) {
                throw new TypeError(
                    `Unknown interceptor type: ${type}`
                );
            }

            if (typeof handler !== "function") {
                throw new TypeError(
                    "An interceptor function is required."
                );
            }

            const id =
                createID(`interceptor:${type}`);

            const record = {
                id,
                handler
            };

            this.interceptors[type].push(record);

            return () => {
                const records =
                    this.interceptors[type];

                const index =
                    records.findIndex(item =>
                        item.id === id
                    );

                if (index < 0) {
                    return false;
                }

                records.splice(index, 1);

                return true;
            };
        }

        async applyInterceptors(
            type,
            value,
            metadata
        ) {
            let current = value;

            for (
                const record
                of this.interceptors[type]
            ) {
                const result =
                    await record.handler(
                        current,
                        metadata
                    );

                if (result !== undefined) {
                    current = result;
                }
            }

            return current;
        }

        requestKey(path, options = {}) {
            const method =
                String(
                    options.method ||
                    "GET"
                ).toUpperCase();

            const url =
                this.url(
                    path,
                    options.params
                );

            let body = "";

            try {
                body =
                    options.body === undefined
                        ? ""
                        : typeof options.body ===
                            "string"
                            ? options.body
                            : safeStringify(
                                options.body,
                                true
                            );
            } catch (_error) {
                body = String(
                    options.body
                );
            }

            return (
                `${method}\u0000` +
                `${url.href}\u0000` +
                body
            );
        }

        cacheKey(path, options = {}) {
            const method =
                String(
                    options.method ||
                    "GET"
                ).toUpperCase();

            const effective =
                this._effectiveConfiguration();

            const previous =
                this.baseURL;

            try {
                this.baseURL =
                    effective.baseURL ||
                    previous;

                return (
                    `${method}:` +
                    this.url(
                        path,
                        options.params
                    ).href
                );
            } finally {
                this.baseURL =
                    previous;
            }
        }

        getCached(key) {
            const record =
                this.cache.get(key);

            if (!record) {
                this.metrics.cacheMisses += 1;
                return {
                    hit: false,
                    value: undefined
                };
            }

            if (
                record.expiresAt &&
                now() > record.expiresAt
            ) {
                this.cache.delete(key);
                this.metrics.cacheMisses += 1;

                return {
                    hit: false,
                    value: undefined
                };
            }

            record.lastAccessedAt = now();
            this.metrics.cacheHits += 1;

            return {
                hit: true,
                value:
                    clone(record.value)
            };
        }

        setCached(
            key,
            value,
            ttl = this.cacheTTL
        ) {
            if (this.cacheLimit <= 0) {
                return false;
            }

            this.cache.set(
                key,
                {
                    value: clone(value),
                    expiresAt:
                        ttl > 0
                            ? now() + ttl
                            : null,
                    lastAccessedAt:
                        now()
                }
            );

            while (
                this.cache.size >
                this.cacheLimit
            ) {
                let oldestKey = null;
                let oldestTime = Infinity;

                for (
                    const [candidateKey, record]
                    of this.cache
                ) {
                    if (
                        record.lastAccessedAt <
                        oldestTime
                    ) {
                        oldestTime =
                            record.lastAccessedAt;

                        oldestKey =
                            candidateKey;
                    }
                }

                if (oldestKey === null) {
                    break;
                }

                this.cache.delete(oldestKey);
            }

            return true;
        }

        clearCache(pattern = null) {
            if (!pattern) {
                const count =
                    this.cache.size;

                this.cache.clear();

                return count;
            }

            const needle =
                String(pattern);

            let removed = 0;

            for (
                const key
                of Array.from(this.cache.keys())
            ) {
                if (key.includes(needle)) {
                    this.cache.delete(key);
                    removed += 1;
                }
            }

            return removed;
        }

        async _requestDirect(path, options = {}) {
            this.assertAvailable();

            const method =
                String(
                    options.method ||
                    "GET"
                )
                    .trim()
                    .toUpperCase();

            const effective =
                this._effectiveConfiguration();

            const oldBase =
                this.baseURL;

            if (effective.baseURL) {
                this.baseURL =
                    effective.baseURL;
            }

            let url;

            try {
                url =
                    this.url(
                        path,
                        options.params
                    );
            } finally {
                this.baseURL =
                    oldBase;
            }

            const timeout =
                options.timeout === undefined
                    ? this.timeout
                    : Math.max(
                        0,
                        Number(options.timeout) ||
                        0
                    );

            if (
                typeof window.fetch !==
                    "function"
            ) {
                throw new APIError(
                    "Fetch is unavailable in this environment.",
                    {
                        method,
                        url:
                            url.href,
                        code:
                            "FETCH_UNAVAILABLE",
                        retryable:
                            false
                    }
                );
            }

            const timeoutController =
                typeof AbortController ===
                    "function"
                    ? new AbortController()
                    : {
                        signal:
                            undefined,
                        abort() {}
                    };

            const merged =
                mergeSignals([
                    options.signal,
                    this.context.signal,
                    timeoutController.signal
                ]);

            let timeoutID = null;

            if (timeout > 0) {
                timeoutID =
                    window.setTimeout(
                        () => {
                            const error =
                                new Error(
                                    `API request timed out after ${timeout} ms.`
                                );

                            error.name =
                                "TimeoutError";

                            try {
                                timeoutController.abort(
                                    error
                                );
                            } catch (_error) {
                                timeoutController.abort();
                            }
                        },
                        timeout
                    );
            }

            const headers =
                typeof Headers === "function"
                    ? new Headers(
                        this.defaultHeaders
                    )
                    : {
                        values:
                            new Map(
                                Object.entries(
                                    this.defaultHeaders
                                )
                            ),
                        set(key, value) {
                            this.values.set(
                                String(key),
                                String(value)
                            );
                        },
                        has(key) {
                            return this.values.has(
                                String(key)
                            );
                        },
                        [Symbol.iterator]() {
                            return this.values[
                                Symbol.iterator
                            ]();
                        }
                    };

            for (
                const [key, value]
                of Object.entries(
                    effective.headers || {}
                )
            ) {
                if (
                    value !== undefined &&
                    value !== null
                ) {
                    headers.set(
                        key,
                        String(value)
                    );
                }
            }

            for (
                const [key, value]
                of Object.entries(
                    options.headers || {}
                )
            ) {
                if (
                    value !== undefined &&
                    value !== null
                ) {
                    headers.set(
                        key,
                        String(value)
                    );
                }
            }

            let body;

            if (
                !BODYLESS_METHODS.has(method) &&
                options.body !== undefined
            ) {
                if (
                    isPlainObject(options.body) ||
                    Array.isArray(options.body)
                ) {
                    if (
                        !headers.has("Content-Type")
                    ) {
                        headers.set(
                            "Content-Type",
                            "application/json"
                        );
                    }

                    body =
                        safeStringify(
                            options.body,
                            true
                        );
                } else {
                    body = options.body;
                }
            }

            try {
                const response =
                    await window.fetch(
                        url.href,
                        {
                            method,
                            headers,
                            body,
                            signal:
                                merged.signal,
                            credentials:
                                options.credentials ||
                                effective.credentials,
                            cache:
                                options.fetchCache ||
                                (
                                    options.cache === false
                                        ? "no-store"
                                        : typeof options.cache ===
                                            "string"
                                            ? options.cache
                                            : "no-store"
                                ),
                            redirect:
                                options.redirect ||
                                "follow"
                        }
                    );

                let payload;

                try {
                    payload =
                        await parseResponse(
                            response
                        );
                } catch (error) {
                    throw new APIError(
                        "Unable to parse the API response.",
                        {
                            status:
                                response.status,
                            statusText:
                                response.statusText,
                            method,
                            url:
                                url.href,
                            response,
                            cause: error
                        }
                    );
                }

                if (!response.ok) {
                    throw new APIError(
                        extractErrorMessage(
                            payload,
                            response.status
                        ),
                        {
                            status:
                                response.status,
                            statusText:
                                response.statusText,
                            method,
                            url:
                                url.href,
                            payload,
                            response,
                            retryable:
                                RETRYABLE_STATUS.has(
                                    response.status
                                )
                        }
                    );
                }

                return {
                    payload,
                    response
                };
            } catch (error) {
                if (error instanceof APIError) {
                    throw error;
                }

                if (merged.signal?.aborted) {
                    const reason =
                        merged.signal.reason;

                    throw new APIError(
                        reason?.message ||
                        "API request was aborted.",
                        {
                            method,
                            url:
                                url.href,
                            cause: error,
                            code:
                                reason?.name ===
                                "TimeoutError"
                                    ? "TIMEOUT"
                                    : "ABORTED",
                            retryable:
                                false
                        }
                    );
                }

                throw new APIError(
                    error?.message ||
                    "Unable to complete the API request.",
                    {
                        method,
                        url:
                            url.href,
                        cause: error,
                        retryable:
                            true
                    }
                );
            } finally {
                if (timeoutID !== null) {
                    window.clearTimeout(timeoutID);
                }

                merged.cleanup();
            }
        }

        enqueue(path, options = {}) {
            this.assertAvailable();

            const method =
                String(
                    options.method ||
                    "GET"
                ).toUpperCase();

            const key =
                this.requestKey(
                    path,
                    {
                        ...options,
                        method
                    }
                );

            const dedupe =
                options.dedupe !== false &&
                (
                    method === "GET" ||
                    method === "HEAD"
                );

            if (
                dedupe &&
                this.pending.has(key)
            ) {
                const pending =
                    this.pending.get(key);

                if (
                    now() -
                    pending.createdAt <=
                    this.dedupeWindow
                ) {
                    this.metrics.deduplicated += 1;

                    return pending.promise;
                }

                this.pending.delete(key);
            }

            const id =
                options.requestId ||
                createID("request");

            const controller =
                typeof AbortController ===
                    "function"
                    ? new AbortController()
                    : {
                        signal: {
                            aborted: false,
                            reason: null
                        },
                        abort(reason) {
                            this.signal.aborted =
                                true;
                            this.signal.reason =
                                reason;
                        }
                    };

            let resolveTask;
            let rejectTask;

            const promise =
                new Promise(
                    (resolve, reject) => {
                        resolveTask = resolve;
                        rejectTask = reject;
                    }
                );

            const task = {
                id,
                path:
                    normalizePath(path),
                method,
                key,
                options: {
                    ...options,
                    method
                },
                priority:
                    Number(options.priority) || 0,
                group:
                    options.group || null,
                controller,
                resolve:
                    resolveTask,
                reject:
                    rejectTask,
                createdAt:
                    iso()
            };

            if (task.group) {
                if (
                    !this.groups.has(task.group)
                ) {
                    this.groups.set(
                        task.group,
                        new Set()
                    );
                }

                this.groups
                    .get(task.group)
                    .add(id);
            }

            this.queue.push(task);
            this.metrics.queued += 1;

            if (dedupe) {
                this.pending.set(
                    key,
                    {
                        createdAt: now(),
                        promise
                    }
                );
            }

            this.emit("queued", {
                request:
                    this.describeTask(task)
            });

            this.pump();

            return promise.finally(() => {
                const pending =
                    this.pending.get(key);

                if (
                    pending?.promise ===
                    promise
                ) {
                    this.pending.delete(key);
                }
            });
        }

        pump() {
            if (this.destroyed) {
                return;
            }

            while (
                this.active.size <
                    this.concurrency &&
                this.queue.size > 0
            ) {
                const task =
                    this.queue.shift();

                if (!task) {
                    break;
                }

                this.active.set(
                    task.id,
                    task
                );

                this.executeTask(task)
                    .then(
                        task.resolve,
                        task.reject
                    )
                    .finally(() => {
                        this.active.delete(
                            task.id
                        );

                        if (task.group) {
                            const group =
                                this.groups.get(
                                    task.group
                                );

                            group?.delete(task.id);

                            if (
                                group &&
                                !group.size
                            ) {
                                this.groups.delete(
                                    task.group
                                );
                            }
                        }

                        this.pump();
                    });
            }
        }

        describeTask(task) {
            return {
                id: task.id,
                method: task.method,
                path: task.path,
                priority:
                    task.priority,
                group:
                    task.group,
                createdAt:
                    task.createdAt
            };
        }

        calculateRetryDelay(
            attempt,
            response = null
        ) {
            const retryAfter =
                response
                    ? parseRetryAfter(
                        response
                    )
                    : null;

            if (retryAfter !== null) {
                return Math.min(
                    this.retryMax,
                    retryAfter
                );
            }

            const exponential =
                this.retryBase *
                (2 ** Math.max(
                    0,
                    attempt - 1
                ));

            const jitter =
                exponential *
                0.15 *
                Math.random();

            return Math.min(
                this.retryMax,
                exponential + jitter
            );
        }

        shouldRetry(
            error,
            method,
            attempt,
            retries
        ) {
            if (attempt >= retries + 1) {
                return false;
            }

            if (
                error?.code === "ABORTED" ||
                error?.code === "TIMEOUT"
            ) {
                return false;
            }

            if (
                error instanceof APIError &&
                RETRYABLE_STATUS.has(
                    error.status
                )
            ) {
                return true;
            }

            return (
                error instanceof APIError &&
                error.status === 0 &&
                [
                    "GET",
                    "HEAD",
                    "OPTIONS",
                    "PUT",
                    "DELETE"
                ].includes(method)
            );
        }

        async executeTask(task) {
            const started =
                monotonicNow();

            const retries =
                clampInteger(
                    task.options.retries,
                    this.defaultRetries,
                    0,
                    20
                );

            let attempt = 0;

            this.metrics.started += 1;

            while (true) {
                attempt += 1;

                try {
                    const cacheable =
                        task.method === "GET" &&
                        task.options.cache !== false &&
                        task.options.cache !==
                            "no-store";

                    const key =
                        this.cacheKey(
                            task.path,
                            task.options
                        );

                    if (
                        cacheable &&
                        task.options.revalidate !== true
                    ) {
                        const cached =
                            this.getCached(key);

                        if (cached.hit) {
                            const latency =
                                monotonicNow() -
                                started;

                            this.metrics.completed += 1;
                            this.metrics.lastLatency =
                                latency;
                            this.metrics.totalLatency +=
                                latency;

                            this.recordHistory({
                                id: task.id,
                                timestamp: iso(),
                                method:
                                    task.method,
                                path:
                                    task.path,
                                ok: true,
                                cached: true,
                                attempt,
                                latency
                            });

                            return cached.value;
                        }
                    }

                    const merged =
                        mergeSignals([
                            task.options.signal,
                            task.controller.signal,
                            this.context.signal
                        ]);

                    let requestOptions = {
                        ...task.options,
                        signal:
                            merged.signal
                    };

                    try {
                        requestOptions =
                            await this.applyInterceptors(
                                "request",
                                requestOptions,
                                {
                                    task,
                                    attempt
                                }
                            );

                        const result =
                            await this._requestDirect(
                                task.path,
                                requestOptions
                            );

                        let payload =
                            result.payload;

                        payload =
                            await this.applyInterceptors(
                                "response",
                                payload,
                                {
                                    task,
                                    attempt,
                                    response:
                                        result.response
                                }
                            );

                        if (cacheable) {
                            this.setCached(
                                key,
                                payload,
                                task.options.cacheTTL ??
                                this.cacheTTL
                            );
                        }

                        const latency =
                            monotonicNow() -
                            started;

                        this.metrics.completed += 1;
                        this.metrics.lastLatency =
                            latency;
                        this.metrics.totalLatency +=
                            latency;

                        this.recordHistory({
                            id: task.id,
                            timestamp: iso(),
                            method:
                                task.method,
                            path:
                                task.path,
                            ok: true,
                            cached: false,
                            attempt,
                            latency
                        });

                        this.emit("complete", {
                            request:
                                this.describeTask(task),
                            latency
                        });

                        return payload;
                    } finally {
                        merged.cleanup();
                    }
                } catch (error) {
                    let normalized =
                        error instanceof APIError
                            ? error
                            : new APIError(
                                error?.message ||
                                "Unable to complete the API request.",
                                {
                                    method:
                                        task.method,
                                    url:
                                        this.url(
                                            task.path,
                                            task.options.params
                                        ).href,
                                    cause: error,
                                    requestId:
                                        task.id,
                                    attempt
                                }
                            );

                    normalized.requestId =
                        normalized.requestId ||
                        task.id;

                    normalized.attempt =
                        attempt;

                    try {
                        const intercepted =
                            await this.applyInterceptors(
                                "error",
                                normalized,
                                {
                                    task,
                                    attempt
                                }
                            );

                        if (intercepted !== undefined) {
                            normalized =
                                intercepted;
                        }
                    } catch (_error) {
                        /* Preserve original normalized error. */
                    }

                    if (
                        task.controller.signal.aborted
                    ) {
                        this.metrics.aborted += 1;
                        normalized.code =
                            normalized.code ||
                            "ABORTED";
                    }

                    if (
                        this.shouldRetry(
                            normalized,
                            task.method,
                            attempt,
                            retries
                        )
                    ) {
                        this.metrics.retried += 1;

                        const delay =
                            this.calculateRetryDelay(
                                attempt,
                                normalized.response
                            );

                        this.emit("retry", {
                            request:
                                this.describeTask(task),
                            attempt,
                            delay,
                            error:
                                normalized.toJSON?.() ||
                                normalized
                        });

                        await sleep(
                            delay,
                            task.controller.signal
                        );

                        continue;
                    }

                    const latency =
                        monotonicNow() -
                        started;

                    this.metrics.failed += 1;
                    this.metrics.lastLatency =
                        latency;
                    this.metrics.totalLatency +=
                        latency;

                    this.recordHistory({
                        id: task.id,
                        timestamp: iso(),
                        method:
                            task.method,
                        path:
                            task.path,
                        ok: false,
                        attempt,
                        latency,
                        error: {
                            message:
                                normalized.message,
                            status:
                                normalized.status,
                            code:
                                normalized.code
                        }
                    });

                    this.emit("error", {
                        request:
                            this.describeTask(task),
                        error:
                            normalized.toJSON?.() ||
                            normalized
                    });

                    throw normalized;
                }
            }
        }

        request(path, options = {}) {
            return this.enqueue(
                path,
                options
            );
        }

        cancel(
            requestId,
            reason = "cancelled"
        ) {
            const id =
                String(requestId || "");

            const queued =
                this.queue.remove(
                    task =>
                        task.id === id
                );

            for (const task of queued) {
                try {
                    task.controller.abort(
                        reason
                    );
                } catch (_error) {
                    task.controller.abort();
                }

                task.reject(
                    new APIError(
                        "API request was cancelled.",
                        {
                            method:
                                task.method,
                            url:
                                this.url(
                                    task.path,
                                    task.options.params
                                ).href,
                            requestId:
                                task.id,
                            code:
                                "ABORTED"
                        }
                    )
                );

                this.metrics.aborted += 1;

                if (task.group) {
                    const group =
                        this.groups.get(
                            task.group
                        );

                    group?.delete(
                        task.id
                    );

                    if (
                        group &&
                        !group.size
                    ) {
                        this.groups.delete(
                            task.group
                        );
                    }
                }
            }

            const active =
                this.active.get(id);

            if (active) {
                try {
                    active.controller.abort(
                        reason
                    );
                } catch (_error) {
                    active.controller.abort();
                }
            }

            return Boolean(
                queued.length ||
                active
            );
        }

        cancelGroup(
            group,
            reason = "group-cancelled"
        ) {
            const name =
                String(group || "");

            const ids =
                new Set(
                    this.groups.get(name) ||
                    []
                );

            let cancelled = 0;

            for (const id of ids) {
                if (
                    this.cancel(id, reason)
                ) {
                    cancelled += 1;
                }
            }

            this.groups.delete(name);

            return cancelled;
        }

        cancelAll(reason = "cancelled") {
            let cancelled = 0;

            for (
                const task
                of this.queue.clear()
            ) {
                try {
                    task.controller.abort(
                        reason
                    );
                } catch (_error) {
                    task.controller.abort();
                }

                task.reject(
                    new APIError(
                        "API request was cancelled.",
                        {
                            method:
                                task.method,
                            requestId:
                                task.id,
                            code:
                                "ABORTED"
                        }
                    )
                );

                cancelled += 1;
                this.metrics.aborted += 1;
            }

            for (
                const task
                of this.active.values()
            ) {
                try {
                    task.controller.abort(
                        reason
                    );
                } catch (_error) {
                    task.controller.abort();
                }

                cancelled += 1;
            }

            return cancelled;
        }

        async batch(requests, options = {}) {
            const values =
                Array.from(requests || []);

            const group =
                options.group ||
                createID("batch");

            const jobs =
                values.map(
                    (request, index) =>
                        this.request(
                            request.path,
                            {
                                ...request,
                                group,
                                requestId:
                                    request.requestId ||
                                    `${group}:${index + 1}`
                            }
                        )
                );

            return options.settle === true
                ? Promise.allSettled(jobs)
                : Promise.all(jobs);
        }

        async paginate(path, options = {}) {
            const records = [];

            const pageSize =
                clampInteger(
                    options.pageSize,
                    100,
                    1,
                    100000
                );

            const maxPages =
                clampInteger(
                    options.maxPages,
                    100,
                    1,
                    100000
                );

            let page =
                clampInteger(
                    options.page,
                    1,
                    1,
                    Number.MAX_SAFE_INTEGER
                );

            const extract =
                typeof options.extract ===
                "function"
                    ? options.extract
                    : payload =>
                        Array.isArray(payload)
                            ? payload
                            : payload?.records ||
                                payload?.results ||
                                payload?.items ||
                                payload?.data ||
                                [];

            for (
                let index = 0;
                index < maxPages;
                index += 1
            ) {
                const payload =
                    await this.get(
                        path,
                        {
                            ...(options.params || {}),
                            [
                                options.pageParam ||
                                "page"
                            ]: page,
                            [
                                options.sizeParam ||
                                "limit"
                            ]: pageSize
                        },
                        options
                    );

                const values =
                    extract(payload);

                if (!Array.isArray(values)) {
                    throw new TypeError(
                        "Pagination extractor must return an array."
                    );
                }

                records.push(...values);

                if (values.length < pageSize) {
                    break;
                }

                page += 1;
            }

            return records;
        }

        addProfile(
            name,
            profile,
            options = {}
        ) {
            this.assertAvailable();

            const key =
                String(name || "").trim();

            if (!key) {
                throw new TypeError(
                    "An API profile name is required."
                );
            }

            if (
                this.profiles.has(key) &&
                options.replace !== true
            ) {
                throw new Error(
                    `API profile already exists: ${key}`
                );
            }

            if (
                !isObject(profile)
            ) {
                throw new TypeError(
                    "API profile definition must be an object."
                );
            }

            const normalized = {
                name: key,
                baseURL:
                    normalizeBaseURL(
                        profile.baseURL ||
                        this.baseURL.href,
                        {
                            allowCrossOrigin:
                                this.allowCrossOrigin
                        }
                    ).href,
                headers:
                    clone(
                        profile.headers ||
                        {}
                    ),
                credentials:
                    profile.credentials ||
                    this.credentials
            };

            this.profiles.set(
                key,
                normalized
            );

            return clone(normalized);
        }

        useProfile(name) {
            this.assertAvailable();

            if (
                name === null ||
                name === undefined ||
                name === ""
            ) {
                this.activeProfile = null;
                return null;
            }

            const key =
                String(name);

            if (!this.profiles.has(key)) {
                throw new Error(
                    `Unknown API profile: ${key}`
                );
            }

            this.activeProfile = key;

            return clone(
                this.profiles.get(key)
            );
        }

        registerProvider(
            name,
            definition,
            options = {}
        ) {
            this.assertAvailable();

            const key =
                String(name || "")
                    .trim()
                    .toLowerCase();

            if (!key) {
                throw new TypeError(
                    "A provider name is required."
                );
            }

            if (
                this.providers.has(key) &&
                options.replace !== true
            ) {
                throw new Error(
                    `API provider already exists: ${key}`
                );
            }

            if (
                !isObject(definition)
            ) {
                throw new TypeError(
                    "API provider definition must be an object."
                );
            }

            const provider = {
                name: key,
                baseURL:
                    normalizeBaseURL(
                        definition.baseURL ||
                        this.baseURL.href,
                        {
                            allowCrossOrigin:
                                this.allowCrossOrigin
                        }
                    ).href,
                headers:
                    clone(
                        definition.headers ||
                        {}
                    ),
                healthPath:
                    definition.healthPath ||
                    "health",
                metadata:
                    clone(
                        definition.metadata ||
                        {}
                    )
            };

            this.providers.set(
                key,
                provider
            );

            return clone(provider);
        }

        eventSource(path, options = {}) {
            this.assertAvailable();

            if (
                typeof window.EventSource !==
                "function"
            ) {
                throw new Error(
                    "EventSource is unavailable in this browser."
                );
            }

            const url =
                this.url(
                    path,
                    options.params
                );

            const source =
                new window.EventSource(
                    url.href,
                    {
                        withCredentials:
                            options.withCredentials ===
                            true
                    }
                );

            const record = {
                source,
                url: url.href,
                close: null
            };

            const close = () => {
                source.close();
                this.streams.delete(record);
                options.signal?.removeEventListener(
                    "abort",
                    close
                );
            };

            record.close = close;

            source.addEventListener(
                "message",
                event => {
                    let data =
                        event.data;

                    if (options.json !== false) {
                        try {
                            data =
                                JSON.parse(
                                    data,
                                    (
                                        key,
                                        value
                                    ) =>
                                        RESERVED_KEYS.has(
                                            key
                                        )
                                            ? undefined
                                            : value
                                );
                        } catch (_error) {
                            /* Preserve text. */
                        }
                    }

                    options.onMessage?.(
                        data,
                        event
                    );

                    this.emit(
                        "stream-message",
                        {
                            url:
                                url.href,
                            data
                        }
                    );
                }
            );

            source.addEventListener(
                "error",
                event => {
                    options.onError?.(event);

                    this.emit(
                        "stream-error",
                        {
                            url:
                                url.href
                        }
                    );
                }
            );

            options.signal?.addEventListener(
                "abort",
                close,
                { once: true }
            );

            this.streams.add(record);
            this.metrics.streamsOpened += 1;

            return record;
        }

        websocket(path, options = {}) {
            this.assertAvailable();

            if (
                typeof window.WebSocket !==
                "function"
            ) {
                throw new Error(
                    "WebSocket is unavailable in this browser."
                );
            }

            const url =
                this.url(
                    path,
                    options.params
                );

            url.protocol =
                url.protocol === "https:"
                    ? "wss:"
                    : "ws:";

            const socket =
                options.protocols === undefined
                    ? new window.WebSocket(
                        url.href
                    )
                    : new window.WebSocket(
                        url.href,
                        options.protocols
                    );

            const record = {
                socket,
                url: url.href,
                send: null,
                close: null
            };

            record.send = value => {
                socket.send(
                    typeof value === "string"
                        ? value
                        : safeStringify(
                            value,
                            true
                        )
                );
            };

            record.close = (
                code = 1000,
                reason = "normal"
            ) => {
                try {
                    socket.close(
                        code,
                        reason
                    );
                } finally {
                    this.sockets.delete(record);
                }
            };

            socket.addEventListener(
                "message",
                event => {
                    let data =
                        event.data;

                    if (
                        options.json !== false &&
                        typeof data === "string"
                    ) {
                        try {
                            data =
                                JSON.parse(
                                    data,
                                    (
                                        key,
                                        value
                                    ) =>
                                        RESERVED_KEYS.has(
                                            key
                                        )
                                            ? undefined
                                            : value
                                );
                        } catch (_error) {
                            /* Preserve text. */
                        }
                    }

                    options.onMessage?.(
                        data,
                        event,
                        socket
                    );

                    this.emit(
                        "socket-message",
                        {
                            url:
                                url.href,
                            data
                        }
                    );
                }
            );

            socket.addEventListener(
                "close",
                event => {
                    this.sockets.delete(record);
                    options.onClose?.(
                        event,
                        socket
                    );
                }
            );

            socket.addEventListener(
                "error",
                event => {
                    options.onError?.(
                        event,
                        socket
                    );
                }
            );

            options.signal?.addEventListener(
                "abort",
                () => record.close(
                    1000,
                    "aborted"
                ),
                { once: true }
            );

            this.sockets.add(record);
            this.metrics.socketsOpened += 1;

            return record;
        }

        async health(options = {}) {
            const started =
                monotonicNow();

            try {
                const payload =
                    await this.get(
                        options.path ||
                        "health",
                        options.params || {},
                        {
                            ...options,
                            cache: false,
                            retries: 0
                        }
                    );

                return {
                    ok: true,
                    latency:
                        monotonicNow() -
                        started,
                    payload
                };
            } catch (error) {
                return {
                    ok: false,
                    latency:
                        monotonicNow() -
                        started,
                    error: {
                        message:
                            error.message,
                        status:
                            error.status || 0,
                        code:
                            error.code || null
                    }
                };
            }
        }

        async benchmark(path, options = {}) {
            const count =
                clampInteger(
                    options.count,
                    5,
                    1,
                    1000
                );

            const latencies = [];
            const results = [];

            for (
                let index = 0;
                index < count;
                index += 1
            ) {
                const started =
                    monotonicNow();

                try {
                    await this.get(
                        path,
                        options.params || {},
                        {
                            ...options,
                            cache: false,
                            retries: 0,
                            dedupe: false
                        }
                    );

                    latencies.push(
                        monotonicNow() -
                        started
                    );

                    results.push({
                        ok: true
                    });
                } catch (error) {
                    latencies.push(
                        monotonicNow() -
                        started
                    );

                    results.push({
                        ok: false,
                        error:
                            error.message
                    });
                }
            }

            const sorted =
                [...latencies].sort(
                    (left, right) =>
                        left - right
                );

            const total =
                latencies.reduce(
                    (sum, value) =>
                        sum + value,
                    0
                );

            const middle =
                Math.floor(
                    sorted.length / 2
                );

            const median =
                !sorted.length
                    ? 0
                    : sorted.length % 2
                        ? sorted[middle]
                        : (
                            sorted[middle - 1] +
                            sorted[middle]
                        ) / 2;

            return {
                path,
                count,
                successful:
                    results.filter(
                        result =>
                            result.ok
                    ).length,
                failed:
                    results.filter(
                        result =>
                            !result.ok
                    ).length,
                minimum:
                    sorted[0] || 0,
                maximum:
                    sorted[
                        sorted.length - 1
                    ] || 0,
                average:
                    latencies.length
                        ? total /
                            latencies.length
                        : 0,
                median,
                latencies,
                results
            };
        }

        recordHistory(entry) {
            this.history.push(
                clone(entry)
            );

            while (
                this.history.length >
                this.historyLimit
            ) {
                this.history.shift();
            }
        }

        queueStatus() {
            return {
                queued:
                    this.queue.snapshot(),
                active:
                    Array.from(
                        this.active.values()
                    ).map(task =>
                        this.describeTask(task)
                    )
            };
        }

        stats() {
            const finished =
                this.metrics.completed +
                this.metrics.failed;

            return {
                version: VERSION,
                baseURL:
                    this.baseURL.href,
                activeProfile:
                    this.activeProfile,
                timeout:
                    this.timeout,
                concurrency:
                    this.concurrency,
                retries:
                    this.defaultRetries,
                queued:
                    this.queue.size,
                active:
                    this.active.size,
                pending:
                    this.pending.size,
                cache:
                    this.cache.size,
                history:
                    this.history.length,
                profiles:
                    this.profiles.size,
                providers:
                    this.providers.size,
                streams:
                    this.streams.size,
                sockets:
                    this.sockets.size,
                watchers:
                    this.watchers.size,
                metrics: {
                    ...clone(
                        this.metrics
                    ),
                    averageLatency:
                        finished
                            ? this.metrics.totalLatency /
                                finished
                            : 0
                },
                destroyed:
                    this.destroyed
            };
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            this.cancelAll(
                "client-destroyed"
            );

            for (
                const stream
                of Array.from(
                    this.streams
                )
            ) {
                try {
                    stream.close();
                } catch (_error) {
                    /* Continue teardown. */
                }
            }

            for (
                const socket
                of Array.from(
                    this.sockets
                )
            ) {
                try {
                    socket.close(
                        1000,
                        "client-destroyed"
                    );
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

            this.queue.clear();
            this.active.clear();
            this.pending.clear();
            this.groups.clear();
            this.cache.clear();
            this.history = [];
            this.profiles.clear();
            this.providers.clear();
            this.streams.clear();
            this.sockets.clear();
            this.watchers.clear();

            for (
                const type
                of Object.keys(
                    this.interceptors
                )
            ) {
                this.interceptors[type] =
                    [];
            }

            const root =
                this.context.root;

            if (
                root &&
                root[API_SYMBOL] ===
                    this
            ) {
                delete root[
                    API_SYMBOL
                ];
            }

            if (
                this.context.api ===
                    this
            ) {
                delete this.context.api;
            }

            this.destroyed =
                true;

            return true;
        }

        get(
            path,
            params = {},
            options = {}
        ) {
            return this.request(
                path,
                {
                    ...options,
                    method: "GET",
                    params
                }
            );
        }

        head(
            path,
            params = {},
            options = {}
        ) {
            return this.request(
                path,
                {
                    ...options,
                    method: "HEAD",
                    params
                }
            );
        }

        post(path, body, options = {}) {
            return this.request(
                path,
                {
                    ...options,
                    method: "POST",
                    body
                }
            );
        }

        put(path, body, options = {}) {
            return this.request(
                path,
                {
                    ...options,
                    method: "PUT",
                    body
                }
            );
        }

        patch(path, body, options = {}) {
            return this.request(
                path,
                {
                    ...options,
                    method: "PATCH",
                    body
                }
            );
        }

        delete(path, options = {}) {
            return this.request(
                path,
                {
                    ...options,
                    method: "DELETE"
                }
            );
        }
    }

    function getService(context = {}) {
        return (
            context?.api ||
            context?.services?.get?.(
                SERVICE_NAME
            ) ||
            context?.services?.api ||
            null
        );
    }

    function initialize(context = {}) {
        const safeContext =
            isObject(context)
                ? context
                : {};

        const root =
            isElement(safeContext.root)
                ? safeContext.root
                : document.documentElement;

        const existing =
            safeContext.api instanceof
                APIClient
                ? safeContext.api
                : safeContext.services?.get?.(
                    SERVICE_NAME
                ) ||
                root?.[API_SYMBOL];

        if (
            existing instanceof APIClient &&
            !existing.destroyed
        ) {
            safeContext.api = existing;

            safeContext.registerService?.(
                SERVICE_NAME,
                existing
            );

            return existing;
        }

        const config =
            safeContext.config?.api || {};

        const client =
            new APIClient(
                {
                    ...safeContext,
                    root
                },
                config
            );

        root[API_SYMBOL] = client;
        safeContext.api = client;

        safeContext.registerService?.(
            SERVICE_NAME,
            client
        );

        safeDispatch(
            document,
            "speciedex:terminal-api-ready",
            {
                context:
                    safeContext,
                api: client,
                version: VERSION
            }
        );

        return client;
    }

    function resolveCommandContext(payload = {}) {
        return (
            payload.context ||
            payload.terminal?.context ||
            payload.app?.context ||
            payload
        );
    }

    function writeResult(payload, value) {
        if (
            typeof payload.writeJSON ===
            "function"
        ) {
            return payload.writeJSON(value);
        }

        if (
            typeof payload.writeLine ===
            "function"
        ) {
            return payload.writeLine(
                typeof value === "string"
                    ? value
                    : safeStringify(value)
            );
        }

        if (
            typeof payload.write ===
            "function"
        ) {
            return payload.write(
                typeof value === "string"
                    ? value
                    : safeStringify(value),
                "data"
            );
        }

        return value;
    }

    const commands = [
        {
            name: "api",
            aliases: ["request"],
            category: "data",
            description:
                "Request a Speciedex API endpoint.",
            usage:
                "api <path> [key=value ...]",

            handler: async payload => {
                const context =
                    resolveCommandContext(payload);

                const tokens =
                    Array.isArray(payload.args)
                        ? Array.from(payload.args)
                        : [];

                const path =
                    tokens.shift();

                if (!path) {
                    throw new Error(
                        "An API path is required."
                    );
                }

                const client =
                    getService(context) ||
                    initialize(context);

                const response =
                    await client.get(
                        path,
                        parseCommandParameters(
                            tokens
                        )
                    );

                return writeResult(
                    payload,
                    response
                );
            }
        },

        {
            name: "api-status",
            category: "data",
            description:
                "Display API client status and metrics.",
            usage: "api-status",

            handler: payload => {
                const context =
                    resolveCommandContext(payload);

                const value =
                    (
                        getService(context) ||
                        initialize(context)
                    ).stats();

                return writeResult(
                    payload,
                    value
                );
            }
        },

        {
            name: "api-queue",
            category: "data",
            description:
                "Display queued and active API requests.",
            usage: "api-queue",

            handler: payload => {
                const context =
                    resolveCommandContext(payload);

                const value =
                    (
                        getService(context) ||
                        initialize(context)
                    ).queueStatus();

                return writeResult(
                    payload,
                    value
                );
            }
        },

        {
            name: "api-cancel",
            category: "data",
            description:
                "Cancel an API request, group, or all requests.",
            usage:
                "api-cancel <request-id|group:NAME|all>",

            handler: payload => {
                const context =
                    resolveCommandContext(payload);

                const client =
                    getService(context) ||
                    initialize(context);

                const args =
                    Array.isArray(payload.args)
                        ? payload.args
                        : [];

                const target =
                    args[0] || "all";

                const cancelled =
                    target === "all"
                        ? client.cancelAll(
                            "command"
                        )
                        : target.startsWith(
                            "group:"
                        )
                            ? client.cancelGroup(
                                target.slice(6),
                                "command"
                            )
                            : client.cancel(
                                target,
                                "command"
                            );

                return writeResult(
                    payload,
                    {
                        target,
                        cancelled
                    }
                );
            }
        },

        {
            name: "api-cache",
            category: "data",
            description:
                "Display or clear the API cache.",
            usage:
                "api-cache [clear [pattern]]",

            handler: payload => {
                const context =
                    resolveCommandContext(payload);

                const client =
                    getService(context) ||
                    initialize(context);

                const args =
                    Array.isArray(payload.args)
                        ? payload.args
                        : [];

                const value =
                    args[0] === "clear"
                        ? {
                            removed:
                                client.clearCache(
                                    args[1] || null
                                ),
                            remaining:
                                client.cache.size
                        }
                        : {
                            size:
                                client.cache.size,
                            keys:
                                Array.from(
                                    client.cache.keys()
                                )
                        };

                return writeResult(
                    payload,
                    value
                );
            }
        },

        {
            name: "api-history",
            category: "data",
            description:
                "Display recent API request history.",
            usage:
                "api-history [limit]",

            handler: payload => {
                const context =
                    resolveCommandContext(payload);

                const client =
                    getService(context) ||
                    initialize(context);

                const args =
                    Array.isArray(payload.args)
                        ? payload.args
                        : [];

                const limit =
                    clampInteger(
                        args[0],
                        25,
                        1,
                        client.historyLimit
                    );

                return writeResult(
                    payload,
                    {
                        history:
                            client.history.slice(
                                -limit
                            )
                    }
                );
            }
        },

        {
            name: "api-health",
            category: "data",
            description:
                "Check API health and latency.",
            usage:
                "api-health [path]",

            handler: async payload => {
                const context =
                    resolveCommandContext(payload);

                const args =
                    Array.isArray(payload.args)
                        ? payload.args
                        : [];

                const value =
                    await (
                        getService(context) ||
                        initialize(context)
                    ).health({
                        path:
                            args[0] ||
                            "health"
                    });

                return writeResult(
                    payload,
                    value
                );
            }
        },

        {
            name: "api-benchmark",
            category: "data",
            description:
                "Benchmark an API endpoint.",
            usage:
                "api-benchmark <path> [count]",

            handler: async payload => {
                const context =
                    resolveCommandContext(payload);

                const args =
                    Array.isArray(payload.args)
                        ? payload.args
                        : [];

                if (!args[0]) {
                    throw new Error(
                        "An API path is required."
                    );
                }

                const value =
                    await (
                        getService(context) ||
                        initialize(context)
                    ).benchmark(
                        args[0],
                        {
                            count:
                                args[1]
                        }
                    );

                return writeResult(
                    payload,
                    value
                );
            }
        },

        {
            name: "api-profiles",
            category: "data",
            description:
                "List API profiles.",
            usage: "api-profiles",

            handler: payload => {
                const context =
                    resolveCommandContext(payload);

                const client =
                    getService(context) ||
                    initialize(context);

                return writeResult(
                    payload,
                    {
                        active:
                            client.activeProfile ||
                            null,
                        profiles:
                            Array.from(
                                client.profiles.values()
                            ).map(clone)
                    }
                );
            }
        },

        {
            name: "api-providers",
            category: "data",
            description:
                "List registered API providers.",
            usage: "api-providers",

            handler: payload => {
                const context =
                    resolveCommandContext(payload);

                const client =
                    getService(context) ||
                    initialize(context);

                return writeResult(
                    payload,
                    {
                        providers:
                            Array.from(
                                client.providers.values()
                            ).map(clone)
                    }
                );
            }
        }
    ];

    for (
        const command
        of commands
    ) {
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
                            safePayload.writeLine?.(
                                typeof value ===
                                    "string"
                                    ? value
                                    : safeStringify(
                                        value
                                    ),
                                type
                            ) ??
                            value;

                return handler(
                    safePayload
                );
            };
    }

    const api = Object.freeze({
        name: MODULE_NAME,
        service: SERVICE_NAME,
        version: VERSION,
        API_SYMBOL,
        APIClient,
        APIError,
        PriorityQueue,
        clone,
        safeStringify,
        safeDispatch,
        normalizeBaseURL,
        normalizePath,
        appendParameter,
        mergeSignals,
        parseResponse,
        extractErrorMessage,
        createID,
        abortError,
        sleep,
        parseRetryAfter,
        parseCommandParameters,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalAPI = api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules || {};

    window.SpeciedexTerminalModules[MODULE_NAME] =
        api;

    safeDispatch(
        document,
        "speciedex:terminal-module-available",
        {
            name: MODULE_NAME,
            module: api
        }
    );
})(window, document);
