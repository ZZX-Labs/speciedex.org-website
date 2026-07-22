/*
========================================================================
Speciedex.org
Terminal History Utilities
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "History";


    function initialize(context) {
        const service = {
            export() {
                return [...(context.app?.history || [])];
            },
            clear() {
                context.app.history = [];
                context.app.historyIndex = 0;
                context.app.persistHistory?.();
            }
        };
        context.historyService = service;
        context.registerService?.("history", service);
        return service;
    }

    const commands = [{
        name: "history-clear",
        category: "system",
        description: "Clear terminal command history.",
        handler: ({ context, write }) => {
            context.historyService.clear();
            return write("Command history cleared.", "success");
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

    window.SpeciedexTerminalHistory = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
