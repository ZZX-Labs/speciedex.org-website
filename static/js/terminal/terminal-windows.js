/*
========================================================================
Speciedex.org
Terminal Window Manager
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Windows";


    class WindowManager {
        constructor(context) {
            this.context = context;
            this.windows = new Map();
        }

        open(id, options = {}) {
            const panel = document.createElement("section");
            panel.className = "terminal-window";
            panel.dataset.terminalWindow = id;
            panel.innerHTML = `
                <header class="terminal-window-header">
                    <h3></h3>
                    <button type="button" data-terminal-window-close>Close</button>
                </header>
                <div class="terminal-window-body"></div>
            `;
            panel.querySelector("h3").textContent = options.title || id;
            panel.querySelector(".terminal-window-body").append(
                options.content instanceof Node
                    ? options.content
                    : document.createTextNode(String(options.content || ""))
            );
            panel.querySelector("[data-terminal-window-close]")
                .addEventListener("click", () => this.close(id));
            this.context.root.appendChild(panel);
            this.windows.set(id, panel);
            return panel;
        }

        close(id) {
            const panel = this.windows.get(id);
            panel?.remove();
            return this.windows.delete(id);
        }
    }

    function initialize(context) {
        const manager = new WindowManager(context);
        context.windows = manager;
        context.registerService?.("windows", manager);
        return manager;
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

    window.SpeciedexTerminalWindows = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
