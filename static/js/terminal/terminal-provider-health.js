/*
========================================================================
Speciedex.org
Terminal ProviderHealth Module
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "ProviderHealth";


    function initialize(context) {
        const service = {
            name: "provider-health",
            async run(parameters = {}) {
                context.events?.emit("provider-health:run", parameters);
                return parameters;
            }
        };
        context.providerhealth = service;
        context.registerService?.("provider-health", service);
        return service;
    }

    const commands = [{
        name: "provider-health",
        category: "data",
        description: "Inspect provider health summaries.",
        usage: "provider-health [arguments]",
        handler: async ({ args, context, writeJSON }) => {
            const service = context.services?.get("provider-health");
            return writeJSON(await service.run({ args }));
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

    window.SpeciedexTerminalProviderHealth = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
