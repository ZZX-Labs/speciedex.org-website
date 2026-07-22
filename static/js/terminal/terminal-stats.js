/*
========================================================================
Speciedex.org
Terminal Stats Module
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Stats";


    function initialize(context) {
        const service = {
            name: "stats",
            async run(parameters = {}) {
                context.events?.emit("stats:run", parameters);
                return parameters;
            }
        };
        context.stats = service;
        context.registerService?.("stats", service);
        return service;
    }

    const commands = [{
        name: "stats",
        category: "data",
        description: "Calculate and display dataset statistics.",
        usage: "stats [arguments]",
        handler: async ({ args, context, writeJSON }) => {
            const service = context.services?.get("stats");
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

    window.SpeciedexTerminalStats = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
