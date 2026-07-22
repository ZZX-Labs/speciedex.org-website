/*
========================================================================
Speciedex.org
Terminal Loading Coordinator
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Loading";


    class LoadingCoordinator extends EventTarget {
        constructor(context) {
            super();
            this.context = context;
            this.tasks = new Map();
        }

        begin(id, label = id) {
            this.tasks.set(id, {
                id,
                label,
                startedAt: performance.now()
            });
            this.update();
            return id;
        }

        end(id) {
            const task = this.tasks.get(id);
            this.tasks.delete(id);
            this.update();
            return task;
        }

        update() {
            const busy = this.tasks.size > 0;
            this.context.root?.classList.toggle("terminal-is-loading", busy);
            this.context.setStatus?.(
                busy ? `Loading (${this.tasks.size})` : "Ready",
                busy ? "loading" : "ready"
            );
            this.dispatchEvent(new CustomEvent("change", {
                detail: { busy, tasks: [...this.tasks.values()] }
            }));
        }
    }

    function initialize(context) {
        const loading = new LoadingCoordinator(context);
        context.loading = loading;
        context.registerService?.("loading", loading);
        return loading;
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

    window.SpeciedexTerminalLoading = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
