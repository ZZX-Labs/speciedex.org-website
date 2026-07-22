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


    class APIClient {
        constructor(context) {
            this.context = context;
            this.baseURL =
                context.root?.dataset.terminalApiBase ||
                "/api/speciedex/v1/";
        }

        url(path, params = {}) {
            const url = new URL(
                path.replace(/^\/+/, ""),
                new URL(this.baseURL, window.location.origin)
            );
            for (const [key, value] of Object.entries(params)) {
                if (value !== undefined && value !== null && value !== "") {
                    url.searchParams.set(key, String(value));
                }
            }
            return url;
        }

        async request(path, options = {}) {
            const method = options.method || "GET";
            const url = this.url(path, options.params);
            const response = await fetch(url, {
                method,
                headers: {
                    Accept: "application/json",
                    ...(options.body ? { "Content-Type": "application/json" } : {}),
                    ...(options.headers || {})
                },
                body: options.body ? JSON.stringify(options.body) : undefined,
                signal: options.signal || this.context.signal,
                credentials: "same-origin"
            });

            const contentType = response.headers.get("content-type") || "";
            const payload = contentType.includes("application/json")
                ? await response.json()
                : await response.text();

            if (!response.ok) {
                const message =
                    payload?.error?.message ||
                    payload?.message ||
                    `API request failed with HTTP ${response.status}.`;
                throw new Error(message);
            }
            return payload;
        }

        get(path, params, options = {}) {
            return this.request(path, { ...options, params });
        }
    }

    function initialize(context) {
        const client = new APIClient(context);
        context.api = client;
        context.registerService?.("api", client);
        return client;
    }

    const commands = [{
        name: "api",
        category: "data",
        description: "Request a Speciedex API endpoint.",
        usage: "api <path> [key=value ...]",
        handler: async ({ args, context, writeJSON }) => {
            const path = args.shift();
            if (!path) throw new Error("An API path is required.");
            const params = Object.fromEntries(args.map(item => {
                const index = item.indexOf("=");
                return index >= 0
                    ? [item.slice(0, index), item.slice(index + 1)]
                    : [item, "true"];
            }));
            return writeJSON(await context.api.get(path, params));
        }
    }];


    const api = Object.freeze({
        name: MODULE_NAME,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands: typeof commands === "undefined" ? [] : commands
    });

    window.SpeciedexTerminalAPI = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
