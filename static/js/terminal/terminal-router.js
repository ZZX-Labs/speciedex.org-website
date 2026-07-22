/*
========================================================================
Speciedex.org
Terminal Router Module
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Router";


    function initialize(context) {
        const service = {
            name: "router",
            async run(parameters = {}) {
                context.events?.emit("router:run", parameters);
                return parameters;
            }
        };
        context.router = service;
        context.registerService?.("router", service);
        return service;
    }

    const commands = [{
        name: "router",
        category: "data",
        description: "Route terminal commands and internal views.",
        usage: "router [arguments]",
        handler: async ({ args, context, writeJSON }) => {
            const service = context.services?.get("router");
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

    window.SpeciedexTerminalRouter = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
