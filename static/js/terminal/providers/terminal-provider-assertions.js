/*
========================================================================
Speciedex.org
Terminal ProviderAssertions Module
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "ProviderAssertions";


    function initialize(context) {
        const service = {
            async list(parameters = {}) {
                if (!context.api) {
                    throw new Error("Speciedex API client is unavailable.");
                }
                return context.api.get("providers/assertions", parameters);
            }
        };

        context.registerService?.("provider-assertions", service);
        return service;
    }

    const commands = [{
        name: "provider-assertions",
        category: "providers",
        description: "Inspect assertions grouped by provider.",
        usage: "provider-assertions [query] [limit]",
        handler: async ({ args, context, writeJSON }) => {
            const query = args[0] || "";
            const limit = Number(args[1]) || 50;
            const service = context.services?.get("provider-assertions");
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

    window.SpeciedexTerminalProviderAssertions = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
