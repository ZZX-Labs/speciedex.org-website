/*
========================================================================
Speciedex.org
Terminal Status Bar
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Statusbar";


    class StatusBar {
        constructor(context) {
            this.context = context;
        }

        update(values = {}) {
            if (values.provider && this.context.elements.provider) {
                this.context.elements.provider.textContent = values.provider;
            }
            if (values.records && this.context.elements.recordCount) {
                this.context.elements.recordCount.textContent = values.records;
            }
            if (values.network && this.context.elements.networkStatus) {
                this.context.elements.networkStatus.textContent = values.network;
            }
            if (values.version && this.context.elements.version) {
                this.context.elements.version.textContent = values.version;
            }
        }
    }

    function initialize(context) {
        const bar = new StatusBar(context);
        context.statusbar = bar;
        context.registerService?.("statusbar", bar);
        return bar;
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

    window.SpeciedexTerminalStatusbar = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
