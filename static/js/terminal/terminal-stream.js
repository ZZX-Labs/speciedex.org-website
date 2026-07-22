/*
========================================================================
Speciedex.org
Terminal Stream Module
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Stream";


    function initialize(context) {
        const service = {
            name: "stream",
            async run(parameters = {}) {
                context.events?.emit("stream:run", parameters);
                return parameters;
            }
        };
        context.stream = service;
        context.registerService?.("stream", service);
        return service;
    }

    const commands = [{
        name: "stream",
        category: "data",
        description: "Consume incremental Speciedex data streams.",
        usage: "stream [arguments]",
        handler: async ({ args, context, writeJSON }) => {
            const service = context.services?.get("stream");
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

    window.SpeciedexTerminalStream = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
