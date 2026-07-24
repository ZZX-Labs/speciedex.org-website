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
    const VERSION = "3.0.0";
    const API_SYMBOL = Symbol.for("speciedex.terminal.api.client");
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
    const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
    const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

    function isPlainObject(value) {
        return Boolean(value) &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            !(value instanceof Date) &&
            !(value instanceof FormData) &&
            !(value instanceof URLSearchParams) &&
            !(value instanceof Blob) &&
            !(value instanceof ArrayBuffer);
    }

    function normalizeBaseURL(value) {
        const base = String(value || DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL;
        const url = new URL(base, window.location.origin);

        if (url.origin !== window.location.origin) {
            throw new TypeError("The terminal API base URL must use the current origin.");
        }

        if (!url.pathname.endsWith("/")) {
            url.pathname += "/";
        }

        return url;
    }

    function normalizePath(path) {
        const value = String(path ?? "").trim();

        if (!value) {
            throw new TypeError("An API path is required.");
        }

        if (value.includes("\\")) {
            throw new TypeError(`Invalid API path: ${path}`);
        }

        return value.replace(/^\/+/, "");
    }

    function appendParameter(searchParams, key, value) {
        if (value === undefined || value === null || value === "") {
            return;
        }

        if (Array.isArray(value)) {
            value.forEach((item) => appendParameter(searchParams, key, item));
            return;
        }

        if (value instanceof Date) {
            searchParams.append(key, value.toISOString());
            return;
        }

        if (typeof value === "object") {
            searchParams.append(key, JSON.stringify(value));
            return;
        }

        searchParams.append(key, String(value));
    }

    function mergeSignals(signals) {
        const active = signals.filter((signal) => signal instanceof AbortSignal);

        if (!active.length) {
            return { signal: undefined, cleanup() {} };
        }

        if (active.length === 1) {
            return { signal: active[0], cleanup() {} };
        }

        const controller = new AbortController();
        const listeners = [];

        const abort = (signal) => {
            if (!controller.signal.aborted) {
                controller.abort(signal.reason);
            }
        };

        active.forEach((signal) => {
            if (signal.aborted) {
                abort(signal);
                return;
            }

            const listener = () => abort(signal);
            signal.addEventListener("abort", listener, { once: true });
            listeners.push([signal, listener]);
        });

        return {
            signal: controller.signal,
            cleanup() {
                listeners.forEach(([signal, listener]) => {
                    signal.removeEventListener("abort", listener);
                });
            }
        };
    }

    async function parseResponse(response) {
        if (response.status === 204 || response.status === 205) {
            return null;
        }

        const contentType = response.headers.get("content-type") || "";

        if (contentType.includes("application/json") || contentType.includes("+json")) {
            const text = await response.text();
            return text ? JSON.parse(text) : null;
        }

        return response.text();
    }

    function extractErrorMessage(payload, status) {
        if (typeof payload === "string" && payload.trim()) {
            return payload.trim();
        }

        if (payload && typeof payload === "object") {
            return payload.error?.message ||
                payload.error ||
                payload.message ||
                payload.detail ||
                `API request failed with HTTP ${status}.`;
        }

        return `API request failed with HTTP ${status}.`;
    }


    function nowISO() {
        return new Date().toISOString();
    }

    function createID(prefix = "api") {
        if (window.crypto && typeof window.crypto.randomUUID === "function") {
            return `${prefix}:${window.crypto.randomUUID()}`;
        }
        return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
    }

    function clampInteger(value, fallback, minimum, maximum) {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed)
            ? Math.min(maximum, Math.max(minimum, parsed))
            : fallback;
    }

    function sleep(milliseconds, signal = null) {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) {
                reject(signal.reason || new DOMException("The operation was aborted.", "AbortError"));
                return;
            }

            const timer = window.setTimeout(() => {
                cleanup();
                resolve();
            }, Math.max(0, milliseconds));

            const onAbort = () => {
                window.clearTimeout(timer);
                cleanup();
                reject(signal.reason || new DOMException("The operation was aborted.", "AbortError"));
            };

            const cleanup = () => {
                signal?.removeEventListener("abort", onAbort);
            };

            signal?.addEventListener("abort", onAbort, { once: true });
        });
    }

    function parseRetryAfter(response) {
        const value = response.headers.get("retry-after");
        if (!value) {
            return null;
        }

        const seconds = Number(value);
        if (Number.isFinite(seconds)) {
            return Math.max(0, seconds * 1000);
        }

        const timestamp = Date.parse(value);
        return Number.isFinite(timestamp)
            ? Math.max(0, timestamp - Date.now())
            : null;
    }

    function clone(value) {
        if (value === undefined) {
            return undefined;
        }

        if (typeof structuredClone === "function") {
            try {
                return structuredClone(value);
            } catch (_error) {
                /* Continue with JSON fallback. */
            }
        }

        try {
            return JSON.parse(JSON.stringify(value));
        } catch (_error) {
            return String(value);
        }
    }

    class PriorityQueue {
        constructor() {
            this.items = [];
            this.sequence = 0;
        }

        push(task) {
            this.items.push({
                ...task,
                sequence: this.sequence++
            });

            this.items.sort((left, right) =>
                right.priority - left.priority ||
                left.sequence - right.sequence
            );
        }

        shift() {
            return this.items.shift() || null;
        }

        remove(predicate) {
            const removed = [];

            this.items = this.items.filter((task) => {
                if (predicate(task)) {
                    removed.push(task);
                    return false;
                }
                return true;
            });

            return removed;
        }

        clear() {
            const items = this.items;
            this.items = [];
            return items;
        }

        snapshot() {
            return this.items.map((task) => ({
                id: task.id,
                method: task.method,
                path: task.path,
                priority: task.priority,
                group: task.group || null,
                createdAt: task.createdAt
            }));
        }

        get size() {
            return this.items.length;
        }
    }

    class APIError extends Error {
        constructor(message, details = {}) {
            super(message);
            this.name = "SpeciedexAPIError";
            this.status = details.status ?? 0;
            this.statusText = details.statusText || "";
            this.method = details.method || "GET";
            this.url = details.url || "";
            this.payload = details.payload;
            this.response = details.response || null;
            this.cause = details.cause;
            this.requestId = details.requestId || null;
            this.attempt = details.attempt || 0;
            this.code = details.code || null;
            this.retryable = details.retryable === true;
        }
    }

    class APIClient {
        constructor(context = {}, options = {}) {
            this.context = context;
            this.baseURL = normalizeBaseURL(
                options.baseURL ||
                context.root?.dataset?.terminalApiBase ||
                DEFAULT_BASE_URL
            );
            this.timeout = Number.isFinite(Number(options.timeout))
                ? Math.max(0, Number(options.timeout))
                : Number.isFinite(Number(context.root?.dataset?.terminalApiTimeout))
                    ? Math.max(0, Number(context.root.dataset.terminalApiTimeout))
                    : DEFAULT_TIMEOUT_MS;
            this.credentials = options.credentials || "same-origin";
            this.defaultHeaders = Object.freeze({
                Accept: "application/json",
                ...(options.headers || {})
            });

            const dataset = context.root?.dataset || {};

            this.concurrency = clampInteger(
                options.concurrency ?? dataset.terminalApiConcurrency,
                DEFAULT_CONCURRENCY,
                1,
                128
            );

            this.defaultRetries = clampInteger(
                options.retries ?? dataset.terminalApiRetries,
                DEFAULT_RETRIES,
                0,
                20
            );

            this.retryBase = clampInteger(
                options.retryBase ?? dataset.terminalApiRetryBase,
                DEFAULT_RETRY_BASE_MS,
                0,
                60000
            );

            this.retryMax = clampInteger(
                options.retryMax ?? dataset.terminalApiRetryMax,
                DEFAULT_RETRY_MAX_MS,
                0,
                600000
            );

            this.historyLimit = clampInteger(
                options.historyLimit ?? dataset.terminalApiHistoryLimit,
                DEFAULT_HISTORY_LIMIT,
                1,
                100000
            );

            this.cacheTTL = clampInteger(
                options.cacheTTL ?? dataset.terminalApiCacheTtl,
                DEFAULT_CACHE_TTL_MS,
                0,
                86400000
            );

            this.cacheLimit = clampInteger(
                options.cacheLimit ?? dataset.terminalApiCacheLimit,
                DEFAULT_CACHE_LIMIT,
                0,
                100000
            );

            this.dedupeWindow = clampInteger(
                options.dedupeWindow ?? dataset.terminalApiDedupeWindow,
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
            this.interceptors = {
                request: [],
                response: [],
                error: []
            };
            this.destroyed = false;
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
                lastLatency: 0
            };
        }

        url(path, params = {}) {
            const url = new URL(normalizePath(path), this.baseURL);

            if (url.origin !== this.baseURL.origin) {
                throw new TypeError("Cross-origin terminal API requests are not permitted.");
            }

            Object.entries(params || {}).forEach(([key, value]) => {
                appendParameter(url.searchParams, key, value);
            });

            return url;
        }

        async _requestDirect(path, options = {}) {
            const method = String(options.method || "GET").trim().toUpperCase();
            const url = this.url(path, options.params);
            const timeout = options.timeout === undefined
                ? this.timeout
                : Math.max(0, Number(options.timeout) || 0);
            const timeoutController = new AbortController();
            const merged = mergeSignals([
                options.signal,
                this.context.signal,
                timeoutController.signal
            ]);
            let timeoutID = null;

            if (timeout > 0) {
                timeoutID = window.setTimeout(() => {
                    timeoutController.abort(
                        new DOMException(
                            `API request timed out after ${timeout} ms.`,
                            "TimeoutError"
                        )
                    );
                }, timeout);
            }

            const headers = new Headers(this.defaultHeaders);
            Object.entries(options.headers || {}).forEach(([key, value]) => {
                if (value !== undefined && value !== null) {
                    headers.set(key, String(value));
                }
            });

            let body;
            if (!BODYLESS_METHODS.has(method) && options.body !== undefined) {
                if (
                    isPlainObject(options.body) ||
                    Array.isArray(options.body)
                ) {
                    if (!headers.has("Content-Type")) {
                        headers.set("Content-Type", "application/json");
                    }
                    body = JSON.stringify(options.body);
                } else {
                    body = options.body;
                }
            }

            try {
                const response = await window.fetch(url.href, {
                    method,
                    headers,
                    body,
                    signal: merged.signal,
                    credentials: options.credentials || this.credentials,
                    cache: options.cache || "no-store",
                    redirect: options.redirect || "follow"
                });

                let payload;
                try {
                    payload = await parseResponse(response);
                } catch (error) {
                    throw new APIError("Unable to parse the API response.", {
                        status: response.status,
                        statusText: response.statusText,
                        method,
                        url: url.href,
                        response,
                        cause: error
                    });
                }

                if (!response.ok) {
                    throw new APIError(
                        extractErrorMessage(payload, response.status),
                        {
                            status: response.status,
                            statusText: response.statusText,
                            method,
                            url: url.href,
                            payload,
                            response
                        }
                    );
                }

                return payload;
            } catch (error) {
                if (error instanceof APIError) {
                    throw error;
                }

                if (merged.signal?.aborted) {
                    const reason = merged.signal.reason;
                    throw new APIError(
                        reason?.message || "API request was aborted.",
                        {
                            method,
                            url: url.href,
                            cause: error
                        }
                    );
                }

                throw new APIError(
                    error?.message || "Unable to complete the API request.",
                    {
                        method,
                        url: url.href,
                        cause: error
                    }
                );
            } finally {
                if (timeoutID !== null) {
                    window.clearTimeout(timeoutID);
                }
                merged.cleanup();
            }
        }


        assertAvailable() {
            if (this.destroyed) {
                throw new Error("API client has been destroyed.");
            }
        }

        emit(name, detail = {}) {
            const payload = {
                client: this,
                ...detail
            };

            try {
                this.context.events?.emit?.(`api:${name}`, payload);
            } catch (_error) {
                /* Event integration is optional. */
            }

            try {
                this.context.root?.dispatchEvent?.(
                    new CustomEvent(`speciedex:terminal-api-${name}`, {
                        bubbles: true,
                        detail: payload
                    })
                );
            } catch (_error) {
                /* DOM event integration is optional. */
            }

            return true;
        }

        addInterceptor(type, handler) {
            if (!["request", "response", "error"].includes(type)) {
                throw new TypeError(`Unknown interceptor type: ${type}`);
            }

            if (typeof handler !== "function") {
                throw new TypeError("An interceptor function is required.");
            }

            const id = createID(`interceptor:${type}`);
            const record = { id, handler };
            this.interceptors[type].push(record);

            return () => {
                const records = this.interceptors[type];
                const index = records.findIndex((item) => item.id === id);

                if (index < 0) {
                    return false;
                }

                records.splice(index, 1);
                return true;
            };
        }

        async applyInterceptors(type, value, metadata) {
            let current = value;

            for (const record of this.interceptors[type]) {
                const result = await record.handler(current, metadata);
                if (result !== undefined) {
                    current = result;
                }
            }

            return current;
        }

        requestKey(path, options = {}) {
            const method = String(options.method || "GET").toUpperCase();
            const url = this.url(path, options.params);

            let body = "";
            try {
                body = options.body === undefined
                    ? ""
                    : typeof options.body === "string"
                        ? options.body
                        : JSON.stringify(options.body);
            } catch (_error) {
                body = String(options.body);
            }

            return `${method}\u0000${url.href}\u0000${body}`;
        }

        cacheKey(path, options = {}) {
            const method = String(options.method || "GET").toUpperCase();
            return `${method}:${this.url(path, options.params).href}`;
        }

        getCached(key) {
            const record = this.cache.get(key);

            if (!record) {
                this.metrics.cacheMisses += 1;
                return null;
            }

            if (record.expiresAt && Date.now() > record.expiresAt) {
                this.cache.delete(key);
                this.metrics.cacheMisses += 1;
                return null;
            }

            record.lastAccessedAt = Date.now();
            this.metrics.cacheHits += 1;
            return clone(record.value);
        }

        setCached(key, value, ttl = this.cacheTTL) {
            if (this.cacheLimit <= 0) {
                return;
            }

            this.cache.set(key, {
                value: clone(value),
                expiresAt: ttl > 0 ? Date.now() + ttl : null,
                lastAccessedAt: Date.now()
            });

            while (this.cache.size > this.cacheLimit) {
                const oldest = [...this.cache.entries()]
                    .sort((left, right) =>
                        left[1].lastAccessedAt -
                        right[1].lastAccessedAt
                    )[0];

                if (!oldest) {
                    break;
                }

                this.cache.delete(oldest[0]);
            }
        }

        clearCache(pattern = null) {
            if (!pattern) {
                const count = this.cache.size;
                this.cache.clear();
                return count;
            }

            const needle = String(pattern);
            let removed = 0;

            for (const key of [...this.cache.keys()]) {
                if (key.includes(needle)) {
                    this.cache.delete(key);
                    removed += 1;
                }
            }

            return removed;
        }

        enqueue(path, options = {}) {
            this.assertAvailable();

            const key = this.requestKey(path, options);
            const method = String(options.method || "GET").toUpperCase();
            const dedupe = options.dedupe !== false &&
                (method === "GET" || method === "HEAD");

            if (dedupe && this.pending.has(key)) {
                const pending = this.pending.get(key);

                if (Date.now() - pending.createdAt <= this.dedupeWindow) {
                    this.metrics.deduplicated += 1;
                    return pending.promise;
                }

                this.pending.delete(key);
            }

            const id = options.requestId || createID("request");
            const controller = new AbortController();

            let resolveTask;
            let rejectTask;

            const promise = new Promise((resolve, reject) => {
                resolveTask = resolve;
                rejectTask = reject;
            });

            const task = {
                id,
                path,
                method,
                key,
                options: {
                    ...options,
                    method
                },
                priority: Number(options.priority) || 0,
                group: options.group || null,
                controller,
                resolve: resolveTask,
                reject: rejectTask,
                createdAt: nowISO()
            };

            if (task.group) {
                if (!this.groups.has(task.group)) {
                    this.groups.set(task.group, new Set());
                }
                this.groups.get(task.group).add(id);
            }

            this.queue.push(task);
            this.metrics.queued += 1;

            if (dedupe) {
                this.pending.set(key, {
                    createdAt: Date.now(),
                    promise
                });
            }

            this.emit("queued", {
                request: this.describeTask(task)
            });

            this.pump();

            return promise.finally(() => {
                const pending = this.pending.get(key);
                if (pending?.promise === promise) {
                    this.pending.delete(key);
                }
            });
        }

        pump() {
            if (this.destroyed) {
                return;
            }

            while (
                this.active.size < this.concurrency &&
                this.queue.size > 0
            ) {
                const task = this.queue.shift();

                if (!task) {
                    break;
                }

                this.active.set(task.id, task);

                this.executeTask(task)
                    .then(task.resolve, task.reject)
                    .finally(() => {
                        this.active.delete(task.id);

                        if (task.group) {
                            const group = this.groups.get(task.group);
                            group?.delete(task.id);

                            if (group && !group.size) {
                                this.groups.delete(task.group);
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
                priority: task.priority,
                group: task.group,
                createdAt: task.createdAt
            };
        }

        calculateRetryDelay(attempt, response = null) {
            const retryAfter = response
                ? parseRetryAfter(response)
                : null;

            if (retryAfter !== null) {
                return Math.min(this.retryMax, retryAfter);
            }

            const exponential =
                this.retryBase *
                (2 ** Math.max(0, attempt - 1));

            const jitter =
                exponential * 0.15 * Math.random();

            return Math.min(
                this.retryMax,
                exponential + jitter
            );
        }

        shouldRetry(error, method, attempt, retries) {
            if (attempt > retries) {
                return false;
            }

            if (
                error instanceof APIError &&
                RETRYABLE_STATUS.has(error.status)
            ) {
                return true;
            }

            return error instanceof APIError &&
                error.status === 0 &&
                ["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]
                    .includes(method);
        }

        async executeTask(task) {
            const started = performance.now();
            const retries = clampInteger(
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
                        task.options.cache !== "no-store";

                    const cacheKey = this.cacheKey(
                        task.path,
                        task.options
                    );

                    if (cacheable && task.options.revalidate !== true) {
                        const cached = this.getCached(cacheKey);
                        if (cached !== null) {
                            this.metrics.completed += 1;
                            return cached;
                        }
                    }

                    let requestOptions = {
                        ...task.options,
                        signal: mergeSignals([
                            task.options.signal,
                            task.controller.signal,
                            this.context.signal
                        ]).signal
                    };

                    requestOptions = await this.applyInterceptors(
                        "request",
                        requestOptions,
                        {
                            task,
                            attempt
                        }
                    );

                    let payload = await this._requestDirect(
                        task.path,
                        requestOptions
                    );

                    payload = await this.applyInterceptors(
                        "response",
                        payload,
                        {
                            task,
                            attempt
                        }
                    );

                    if (cacheable) {
                        this.setCached(
                            cacheKey,
                            payload,
                            task.options.cacheTTL ??
                            this.cacheTTL
                        );
                    }

                    const latency = performance.now() - started;
                    this.metrics.completed += 1;
                    this.metrics.lastLatency = latency;
                    this.metrics.totalLatency += latency;

                    this.recordHistory({
                        id: task.id,
                        timestamp: nowISO(),
                        method: task.method,
                        path: task.path,
                        ok: true,
                        attempt,
                        latency
                    });

                    this.emit("complete", {
                        request: this.describeTask(task),
                        latency
                    });

                    return payload;
                } catch (error) {
                    let normalized =
                        error instanceof APIError
                            ? error
                            : new APIError(
                                error?.message ||
                                "Unable to complete the API request.",
                                {
                                    method: task.method,
                                    url: this.url(
                                        task.path,
                                        task.options.params
                                    ).href,
                                    cause: error,
                                    requestId: task.id,
                                    attempt
                                }
                            );

                    try {
                        normalized = await this.applyInterceptors(
                            "error",
                            normalized,
                            {
                                task,
                                attempt
                            }
                        );
                    } catch (_interceptorError) {
                        /* Preserve the original error. */
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

                        const delay = this.calculateRetryDelay(
                            attempt,
                            normalized.response
                        );

                        this.emit("retry", {
                            request: this.describeTask(task),
                            attempt,
                            delay,
                            error: normalized
                        });

                        await sleep(
                            delay,
                            task.controller.signal
                        );

                        continue;
                    }

                    this.metrics.failed += 1;

                    this.recordHistory({
                        id: task.id,
                        timestamp: nowISO(),
                        method: task.method,
                        path: task.path,
                        ok: false,
                        attempt,
                        latency: performance.now() - started,
                        error: {
                            message: normalized.message,
                            status: normalized.status,
                            code: normalized.code
                        }
                    });

                    this.emit("error", {
                        request: this.describeTask(task),
                        error: normalized
                    });

                    throw normalized;
                }
            }
        }

        request(path, options = {}) {
            return this.enqueue(path, options);
        }

        cancel(requestId, reason = "cancelled") {
            const id = String(requestId || "");
            const queued = this.queue.remove(
                task => task.id === id
            );

            for (const task of queued) {
                task.controller.abort(reason);
                task.reject(
                    new APIError(
                        "API request was cancelled.",
                        {
                            method: task.method,
                            url: this.url(
                                task.path,
                                task.options.params
                            ).href,
                            requestId: task.id,
                            code: "ABORTED"
                        }
                    )
                );
            }

            const active = this.active.get(id);
            active?.controller.abort(reason);

            return Boolean(
                queued.length ||
                active
            );
        }

        cancelGroup(group, reason = "group-cancelled") {
            const ids = new Set(
                this.groups.get(String(group || "")) ||
                []
            );

            let cancelled = 0;

            for (const id of ids) {
                if (this.cancel(id, reason)) {
                    cancelled += 1;
                }
            }

            this.groups.delete(String(group || ""));

            return cancelled;
        }

        cancelAll(reason = "cancelled") {
            let cancelled = 0;

            for (const task of this.queue.clear()) {
                task.controller.abort(reason);
                task.reject(
                    new APIError(
                        "API request was cancelled.",
                        {
                            method: task.method,
                            requestId: task.id,
                            code: "ABORTED"
                        }
                    )
                );
                cancelled += 1;
            }

            for (const task of this.active.values()) {
                task.controller.abort(reason);
                cancelled += 1;
            }

            return cancelled;
        }

        async batch(requests, options = {}) {
            const values = Array.from(requests || []);
            const group = options.group || createID("batch");

            const jobs = values.map((request, index) =>
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
            const pageSize = clampInteger(
                options.pageSize,
                100,
                1,
                100000
            );
            const maxPages = clampInteger(
                options.maxPages,
                100,
                1,
                100000
            );

            let page = clampInteger(
                options.page,
                1,
                1,
                Number.MAX_SAFE_INTEGER
            );

            const extract = typeof options.extract === "function"
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
                const payload = await this.get(
                    path,
                    {
                        ...(options.params || {}),
                        [options.pageParam || "page"]: page,
                        [options.sizeParam || "limit"]: pageSize
                    },
                    options
                );

                const values = extract(payload);

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

        addProfile(name, profile, options = {}) {
            const key = String(name || "").trim();

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

            const normalized = {
                name: key,
                baseURL: normalizeBaseURL(
                    profile.baseURL ||
                    this.baseURL.href
                ).href,
                headers: clone(
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
            const key = String(name || "");

            if (!this.profiles.has(key)) {
                throw new Error(
                    `Unknown API profile: ${key}`
                );
            }

            this.activeProfile = key;
            return clone(this.profiles.get(key));
        }

        registerProvider(name, definition, options = {}) {
            const key = String(name || "")
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

            const provider = {
                name: key,
                baseURL: normalizeBaseURL(
                    definition.baseURL ||
                    this.baseURL.href
                ).href,
                headers: clone(
                    definition.headers ||
                    {}
                ),
                healthPath:
                    definition.healthPath ||
                    "health",
                metadata: clone(
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
            const url = this.url(
                path,
                options.params
            );

            const source = new EventSource(
                url.href,
                {
                    withCredentials:
                        options.withCredentials === true
                }
            );

            const close = () => source.close();

            source.addEventListener(
                "message",
                event => {
                    let data = event.data;

                    if (options.json !== false) {
                        try {
                            data = JSON.parse(data);
                        } catch (_error) {
                            /* Preserve text. */
                        }
                    }

                    options.onMessage?.(
                        data,
                        event
                    );

                    this.emit("stream-message", {
                        url: url.href,
                        data
                    });
                }
            );

            source.addEventListener(
                "error",
                event => {
                    options.onError?.(event);
                    this.emit("stream-error", {
                        url: url.href
                    });
                }
            );

            options.signal?.addEventListener(
                "abort",
                close,
                {
                    once: true
                }
            );

            return {
                source,
                close,
                url: url.href
            };
        }

        websocket(path, options = {}) {
            const url = this.url(
                path,
                options.params
            );

            url.protocol =
                url.protocol === "https:"
                    ? "wss:"
                    : "ws:";

            const socket = new WebSocket(
                url.href,
                options.protocols
            );

            socket.addEventListener(
                "message",
                event => {
                    let data = event.data;

                    if (
                        options.json !== false &&
                        typeof data === "string"
                    ) {
                        try {
                            data = JSON.parse(data);
                        } catch (_error) {
                            /* Preserve text. */
                        }
                    }

                    options.onMessage?.(
                        data,
                        event,
                        socket
                    );
                }
            );

            return {
                socket,
                send(value) {
                    socket.send(
                        typeof value === "string"
                            ? value
                            : JSON.stringify(value)
                    );
                },
                close(code = 1000, reason = "normal") {
                    socket.close(code, reason);
                },
                url: url.href
            };
        }

        async health(options = {}) {
            const started = performance.now();

            try {
                const payload = await this.get(
                    options.path || "health",
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
                        performance.now() -
                        started,
                    payload
                };
            } catch (error) {
                return {
                    ok: false,
                    latency:
                        performance.now() -
                        started,
                    error: {
                        message: error.message,
                        status: error.status || 0
                    }
                };
            }
        }

        async benchmark(path, options = {}) {
            const count = clampInteger(
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
                const started = performance.now();

                try {
                    await this.get(
                        path,
                        options.params || {},
                        {
                            ...options,
                            cache: false,
                            retries: 0
                        }
                    );

                    latencies.push(
                        performance.now() -
                        started
                    );

                    results.push({
                        ok: true
                    });
                } catch (error) {
                    latencies.push(
                        performance.now() -
                        started
                    );

                    results.push({
                        ok: false,
                        error: error.message
                    });
                }
            }

            const sorted = [...latencies]
                .sort((left, right) =>
                    left - right
                );

            const total = latencies.reduce(
                (sum, value) =>
                    sum + value,
                0
            );

            return {
                path,
                count,
                successful:
                    results.filter(
                        result => result.ok
                    ).length,
                failed:
                    results.filter(
                        result => !result.ok
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
                median:
                    sorted.length
                        ? sorted[
                            Math.floor(
                                sorted.length / 2
                            )
                        ]
                        : 0,
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
                    [...this.active.values()]
                        .map(
                            task =>
                                this.describeTask(task)
                        )
            };
        }

        stats() {
            return {
                version: VERSION,
                baseURL:
                    this.baseURL.href,
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
                metrics: {
                    ...this.metrics,
                    averageLatency:
                        this.metrics.completed
                            ? this.metrics.totalLatency /
                              this.metrics.completed
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

            this.queue.clear();
            this.active.clear();
            this.pending.clear();
            this.groups.clear();
            this.cache.clear();
            this.history = [];
            this.profiles.clear();
            this.providers.clear();

            for (
                const type of
                Object.keys(
                    this.interceptors
                )
            ) {
                this.interceptors[type] = [];
            }

            if (
                this.context.root?.[
                    API_SYMBOL
                ] === this
            ) {
                delete this.context.root[
                    API_SYMBOL
                ];
            }

            this.destroyed = true;

            return true;
        }

        get(path, params = {}, options = {}) {
            return this.request(path, { ...options, method: "GET", params });
        }

        head(path, params = {}, options = {}) {
            return this.request(path, { ...options, method: "HEAD", params });
        }

        post(path, body, options = {}) {
            return this.request(path, { ...options, method: "POST", body });
        }

        put(path, body, options = {}) {
            return this.request(path, { ...options, method: "PUT", body });
        }

        patch(path, body, options = {}) {
            return this.request(path, { ...options, method: "PATCH", body });
        }

        delete(path, options = {}) {
            return this.request(path, { ...options, method: "DELETE" });
        }
    }

    function initialize(context) {
        if (!context || typeof context !== "object") {
            throw new TypeError(
                "A terminal context is required to initialize the API client."
            );
        }

        const root = context.root;

        const existing =
            context.api instanceof APIClient
                ? context.api
                : context.services?.get?.(
                    SERVICE_NAME
                ) ||
                  root?.[
                    API_SYMBOL
                  ];

        if (
            existing instanceof APIClient &&
            !existing.destroyed
        ) {
            context.api = existing;
            context.registerService?.(
                SERVICE_NAME,
                existing
            );
            return existing;
        }

        const client = new APIClient(context);

        if (root) {
            root[API_SYMBOL] = client;
        }

        context.api = client;
        context.registerService?.(
            SERVICE_NAME,
            client
        );

        document.dispatchEvent(
            new CustomEvent(
                "speciedex:terminal-api-ready",
                {
                    detail: {
                        context,
                        api: client,
                        version: VERSION
                    }
                }
            )
        );

        return client;
    }

    function parseCommandParameters(items) {
        return Object.fromEntries(items.map((item) => {
            const index = item.indexOf("=");
            return index >= 0
                ? [item.slice(0, index), item.slice(index + 1)]
                : [item, "true"];
        }));
    }

    const commands = [{
        name: "api",
        aliases: ["request"],
        category: "data",
        description: "Request a Speciedex API endpoint.",
        usage: "api <path> [key=value ...]",
        handler: async ({ args = [], context, writeJSON, writeLine }) => {
            const tokens = Array.from(args);
            const path = tokens.shift();

            if (!path) {
                throw new Error("An API path is required.");
            }

            const client = context.api || initialize(context);
            const payload = await client.get(path, parseCommandParameters(tokens));

            if (typeof writeJSON === "function") {
                writeJSON(payload);
            } else if (typeof writeLine === "function") {
                writeLine(
                    typeof payload === "string"
                        ? payload
                        : JSON.stringify(payload, null, 2)
                );
            }

            return payload;
        }
    }];


    commands.push(
        {
            name: "api-status",
            category: "data",
            description: "Display API client status and metrics.",
            usage: "api-status",
            handler: ({ context, writeJSON, writeLine }) => {
                const value = (context.api || initialize(context)).stats();

                if (typeof writeJSON === "function") {
                    return writeJSON(value);
                }

                return writeLine?.(
                    JSON.stringify(value, null, 2)
                ) || value;
            }
        },
        {
            name: "api-queue",
            category: "data",
            description: "Display queued and active API requests.",
            usage: "api-queue",
            handler: ({ context, writeJSON, writeLine }) => {
                const value = (context.api || initialize(context)).queueStatus();

                if (typeof writeJSON === "function") {
                    return writeJSON(value);
                }

                return writeLine?.(
                    JSON.stringify(value, null, 2)
                ) || value;
            }
        },
        {
            name: "api-cancel",
            category: "data",
            description: "Cancel an API request, group, or all requests.",
            usage: "api-cancel <request-id|group:NAME|all>",
            handler: ({ args = [], context, writeJSON }) => {
                const client = context.api || initialize(context);
                const target = args[0] || "all";

                const cancelled = target === "all"
                    ? client.cancelAll("command")
                    : target.startsWith("group:")
                        ? client.cancelGroup(
                            target.slice(6),
                            "command"
                        )
                        : client.cancel(
                            target,
                            "command"
                        );

                const value = {
                    target,
                    cancelled
                };

                return typeof writeJSON === "function"
                    ? writeJSON(value)
                    : value;
            }
        },
        {
            name: "api-cache",
            category: "data",
            description: "Display or clear the API cache.",
            usage: "api-cache [clear [pattern]]",
            handler: ({ args = [], context, writeJSON }) => {
                const client = context.api || initialize(context);

                const value = args[0] === "clear"
                    ? {
                        removed: client.clearCache(
                            args[1] || null
                        ),
                        remaining: client.cache.size
                    }
                    : {
                        size: client.cache.size,
                        keys: [...client.cache.keys()]
                    };

                return typeof writeJSON === "function"
                    ? writeJSON(value)
                    : value;
            }
        },
        {
            name: "api-history",
            category: "data",
            description: "Display recent API request history.",
            usage: "api-history [limit]",
            handler: ({ args = [], context, writeJSON }) => {
                const client = context.api || initialize(context);
                const limit = clampInteger(
                    args[0],
                    25,
                    1,
                    client.historyLimit
                );

                const value = {
                    history: client.history.slice(
                        -limit
                    )
                };

                return typeof writeJSON === "function"
                    ? writeJSON(value)
                    : value;
            }
        },
        {
            name: "api-health",
            category: "data",
            description: "Check API health and latency.",
            usage: "api-health [path]",
            handler: async ({ args = [], context, writeJSON }) => {
                const value = await (
                    context.api ||
                    initialize(context)
                ).health({
                    path: args[0] || "health"
                });

                return typeof writeJSON === "function"
                    ? writeJSON(value)
                    : value;
            }
        },
        {
            name: "api-benchmark",
            category: "data",
            description: "Benchmark an API endpoint.",
            usage: "api-benchmark <path> [count]",
            handler: async ({ args = [], context, writeJSON }) => {
                if (!args[0]) {
                    throw new Error(
                        "An API path is required."
                    );
                }

                const value = await (
                    context.api ||
                    initialize(context)
                ).benchmark(
                    args[0],
                    {
                        count: args[1]
                    }
                );

                return typeof writeJSON === "function"
                    ? writeJSON(value)
                    : value;
            }
        },
        {
            name: "api-profiles",
            category: "data",
            description: "List API profiles.",
            usage: "api-profiles",
            handler: ({ context, writeJSON }) => {
                const client = context.api || initialize(context);
                const value = {
                    active: client.activeProfile || null,
                    profiles: [...client.profiles.values()]
                };

                return typeof writeJSON === "function"
                    ? writeJSON(value)
                    : value;
            }
        },
        {
            name: "api-providers",
            category: "data",
            description: "List registered API providers.",
            usage: "api-providers",
            handler: ({ context, writeJSON }) => {
                const client = context.api || initialize(context);
                const value = {
                    providers: [...client.providers.values()]
                };

                return typeof writeJSON === "function"
                    ? writeJSON(value)
                    : value;
            }
        }
    );

    const api = Object.freeze({
        name: MODULE_NAME,
        service: SERVICE_NAME,
        version: VERSION,
        API_SYMBOL,
        APIClient,
        APIError,
        PriorityQueue,
        clone,
        sleep,
        parseRetryAfter,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalAPI = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: {
            name: MODULE_NAME,
            module: api
        }
    }));
})(window, document);
