/*
========================================================================
Speciedex.org
Terminal Context Menu
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Contextmenu";


    class ContextMenu {
        constructor(context) {
            this.context = context;
            this.menu = context.root.querySelector("[data-terminal-context-menu]");
            this.bound = event => this.open(event);
            context.root.addEventListener("contextmenu", this.bound);
            document.addEventListener("click", () => this.close());
        }

        open(event) {
            if (!this.menu) return;
            event.preventDefault();
            this.menu.replaceChildren();
            const actions = [
                ["Copy output", () => navigator.clipboard?.writeText(this.context.elements.output.innerText)],
                ["Clear output", () => this.context.clear()],
                ["Focus input", () => this.context.focus()]
            ];
            for (const [label, action] of actions) {
                const button = document.createElement("button");
                button.type = "button";
                button.role = "menuitem";
                button.textContent = label;
                button.addEventListener("click", () => {
                    action();
                    this.close();
                });
                this.menu.appendChild(button);
            }
            this.menu.style.left = `${event.clientX}px`;
            this.menu.style.top = `${event.clientY}px`;
            this.menu.hidden = false;
        }

        close() {
            if (this.menu) this.menu.hidden = true;
        }

        destroy() {
            this.context.root.removeEventListener("contextmenu", this.bound);
        }
    }

    function initialize(context) {
        const menu = new ContextMenu(context);
        context.contextMenu = menu;
        return menu;
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

    window.SpeciedexTerminalContextmenu = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
