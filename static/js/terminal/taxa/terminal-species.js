/*
========================================================================
Speciedex.org
Terminal Species Module
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Species";


    function initialize(context) {
        const service = {
            async list(parameters = {}) {
                if (!context.api) {
                    throw new Error("Speciedex API client is unavailable.");
                }
                return context.api.get("taxa/species", parameters);
            }
        };

        context.registerService?.("species", service);
        return service;
    }

    const commands = [{
        name: "species",
        category: "taxonomy",
        description: "Search canonical species records.",
        usage: "species [query] [limit]",
        handler: async ({ args, context, writeJSON }) => {
            const query = args[0] || "";
            const limit = Number(args[1]) || 50;
            const service = context.services?.get("species");
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

    window.SpeciedexTerminalSpecies = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
