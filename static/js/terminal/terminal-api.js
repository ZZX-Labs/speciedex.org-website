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
    const DEFAULT_BASE_URL = "/api/speciedex/v1/";
    const DEFAULT_TIMEOUT_MS = 30000;
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

        async request(path, options = {}) {
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
            throw new TypeError("A terminal context is required to initialize the API client.");
        }

        if (context.api instanceof APIClient) {
            return context.api;
        }

        const client = new APIClient(context);
        context.api = client;

        if (typeof context.registerService === "function") {
            context.registerService(SERVICE_NAME, client);
        }

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

    const api = Object.freeze({
        name: MODULE_NAME,
        service: SERVICE_NAME,
        APIClient,
        APIError,
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
