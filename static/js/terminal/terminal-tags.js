/*
========================================================================
Speciedex.org
Terminal Tags Module
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Tags";


    function initialize(context) {
        const service = {
            name: "tags",
            async run(parameters = {}) {
                context.events?.emit("tags:run", parameters);
                return parameters;
            }
        };
        context.tags = service;
        context.registerService?.("tags", service);
        return service;
    }

    const commands = [{
        name: "tags",
        category: "data",
        description: "Create and inspect tags for terminal records.",
        usage: "tags [arguments]",
        handler: async ({ args, context, writeJSON }) => {
            const service = context.services?.get("tags");
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

    window.SpeciedexTerminalTags = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
