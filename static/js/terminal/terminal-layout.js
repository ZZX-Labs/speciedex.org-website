/*
========================================================================
Speciedex.org
Terminal Layout Controller
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Layout";


    class LayoutController {
        constructor(context) {
            this.context = context;
            this.mode = "standard";
        }

        setMode(mode) {
            const allowed = ["standard", "compact", "wide", "fullscreen"];
            if (!allowed.includes(mode)) {
                throw new Error(`Unsupported layout mode: ${mode}`);
            }
            this.mode = mode;
            this.context.root.dataset.terminalLayout = mode;
            return mode;
        }
    }

    function initialize(context) {
        const controller = new LayoutController(context);
        context.layout = controller;
        context.registerService?.("layout", controller);
        return controller;
    }

    const commands = [{
        name: "layout",
        category: "interface",
        description: "Set the terminal layout mode.",
        usage: "layout [standard|compact|wide|fullscreen]",
        handler: ({ args, context, write }) => {
            const mode = args[0] || "standard";
            context.layout.setMode(mode);
            return write(`Layout: ${mode}`, "success");
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

    window.SpeciedexTerminalLayout = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
