/*
========================================================================
Speciedex.org
Terminal ProviderManager Module
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "ProviderManager";


    function initialize(context) {
        const service = {
            name: "provider-manager",
            async run(parameters = {}) {
                context.events?.emit("provider-manager:run", parameters);
                return parameters;
            }
        };
        context.providermanager = service;
        context.registerService?.("provider-manager", service);
        return service;
    }

    const commands = [{
        name: "provider-manager",
        category: "data",
        description: "Manage enabled provider configurations.",
        usage: "provider-manager [arguments]",
        handler: async ({ args, context, writeJSON }) => {
            const service = context.services?.get("provider-manager");
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

    window.SpeciedexTerminalProviderManager = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
