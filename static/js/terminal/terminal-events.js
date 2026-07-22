/*
========================================================================
Speciedex.org
Terminal Event Bus
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Events";


    class EventBus extends EventTarget {
        emit(name, detail = {}) {
            this.dispatchEvent(new CustomEvent(name, { detail }));
        }

        on(name, listener, options) {
            this.addEventListener(name, listener, options);
            return () => this.removeEventListener(name, listener, options);
        }

        once(name, listener) {
            this.addEventListener(name, listener, { once: true });
        }
    }

    function initialize(context) {
        const bus = new EventBus();
        context.events = bus;
        context.registerService?.("events", bus);
        return bus;
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

    window.SpeciedexTerminalEvents = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
