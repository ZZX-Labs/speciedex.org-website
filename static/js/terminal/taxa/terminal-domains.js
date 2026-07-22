/*
========================================================================
Speciedex.org
Terminal Domains Module
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Domains";


    function initialize(context) {
        const service = {
            async list(parameters = {}) {
                if (!context.api) {
                    throw new Error("Speciedex API client is unavailable.");
                }
                return context.api.get("taxa/domains", parameters);
            }
        };

        context.registerService?.("domains", service);
        return service;
    }

    const commands = [{
        name: "domains",
        category: "taxonomy",
        description: "Search taxonomic domains.",
        usage: "domains [query] [limit]",
        handler: async ({ args, context, writeJSON }) => {
            const query = args[0] || "";
            const limit = Number(args[1]) || 50;
            const service = context.services?.get("domains");
            return writeJSON(await service.list({ q: query, limit }));
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

    window.SpeciedexTerminalDomains = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
