/*
========================================================================
Speciedex.org
Terminal Console Bridge
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Console";


    class ConsoleBridge {
        constructor(context) {
            this.context = context;
        }

        info(...values) {
            this.context.write(values.map(String).join(" "), "info");
        }

        warn(...values) {
            this.context.write(values.map(String).join(" "), "warning");
        }

        error(...values) {
            this.context.write(values.map(String).join(" "), "error");
        }
    }

    function initialize(context) {
        const bridge = new ConsoleBridge(context);
        context.console = bridge;
        context.registerService?.("console", bridge);
        return bridge;
    }

    const commands = [];


    const api = Object.freeze({
        name: MODULE_NAME,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands: typeof commands === "undefined" ? [] : commands
    });

    window.SpeciedexTerminalConsole = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
