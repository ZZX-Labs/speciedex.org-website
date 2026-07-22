/*
========================================================================
Speciedex.org
Terminal Search Module
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Search";


    function initialize(context) {
        const service = {
            async search(query, options = {}) {
                if (context.workers?.has("search")) {
                    try {
                        return await context.workers.request("search", "search", {
                            query,
                            records: options.records || context.library?.get(options.collection || "records") || [],
                            fields: options.fields || [],
                            limit: options.limit || 50
                        });
                    } catch (error) {}
                }
                if (context.api) {
                    return context.api.get("search", { q: query, limit: options.limit || 50 });
                }
                return [];
            }
        };
        context.search = service;
        context.registerService?.("search", service);
        return service;
    }

    const commands = [{
        name: "search",
        category: "data",
        description: "Search Speciedex records.",
        usage: "search <query>",
        handler: async ({ args, context, writeJSON }) => {
            const query = args.join(" ");
            if (!query) throw new Error("A search query is required.");
            return writeJSON(await context.search.search(query));
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

    window.SpeciedexTerminalSearch = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
