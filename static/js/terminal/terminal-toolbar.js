/*
========================================================================
Speciedex.org
Terminal Toolbar Controller
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Toolbar";


    class ToolbarController {
        constructor(context) {
            this.context = context;
            this.element = context.root.querySelector("[data-terminal-header] .terminal-actions");
        }

        addAction(name, label, handler) {
            if (!this.element) return null;
            const button = document.createElement("button");
            button.type = "button";
            button.className = "terminal-action";
            button.dataset.terminalAction = name;
            button.textContent = label;
            button.addEventListener("click", handler);
            this.element.appendChild(button);
            return button;
        }
    }

    function initialize(context) {
        const controller = new ToolbarController(context);
        context.toolbar = controller;
        context.registerService?.("toolbar", controller);
        return controller;
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

    window.SpeciedexTerminalToolbar = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
