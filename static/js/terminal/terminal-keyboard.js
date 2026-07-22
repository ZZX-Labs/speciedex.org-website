/*
========================================================================
Speciedex.org
Terminal Keyboard Shortcuts
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Keyboard";


    class KeyboardManager {
        constructor(context) {
            this.context = context;
            this.shortcuts = new Map();
            this.onKeydown = this.onKeydown.bind(this);
            document.addEventListener("keydown", this.onKeydown);
        }

        register(combo, handler) {
            this.shortcuts.set(combo.toLowerCase(), handler);
        }

        onKeydown(event) {
            const parts = [];
            if (event.ctrlKey) parts.push("ctrl");
            if (event.altKey) parts.push("alt");
            if (event.shiftKey) parts.push("shift");
            parts.push(event.key.toLowerCase());
            const handler = this.shortcuts.get(parts.join("+"));
            if (handler) {
                event.preventDefault();
                handler(event);
            }
        }

        destroy() {
            document.removeEventListener("keydown", this.onKeydown);
        }
    }

    function initialize(context) {
        const manager = new KeyboardManager(context);
        manager.register("ctrl+shift+k", () => context.clear());
        manager.register("ctrl+shift+f", () => context.elements.input?.focus());
        context.keyboard = manager;
        context.registerService?.("keyboard", manager);
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

    window.SpeciedexTerminalKeyboard = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
