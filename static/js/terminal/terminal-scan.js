/*
========================================================================
Speciedex.org
Terminal Scan Module
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Scan";


    function initialize(context) {
        const service = {
            name: "scan",
            async run(parameters = {}) {
                context.events?.emit("scan:run", parameters);
                return parameters;
            }
        };
        context.scan = service;
        context.registerService?.("scan", service);
        return service;
    }

    const commands = [{
        name: "scan",
        category: "data",
        description: "Scan datasets or provider results for anomalies.",
        usage: "scan [arguments]",
        handler: async ({ args, context, writeJSON }) => {
            const service = context.services?.get("scan");
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

    window.SpeciedexTerminalScan = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
