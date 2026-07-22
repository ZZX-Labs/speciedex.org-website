/*
========================================================================
Speciedex.org
Terminal Recent Activity
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Recent";


    class RecentActivity {
        constructor(context) {
            this.context = context;
            this.items = [];
            context.root.addEventListener("speciedex:terminal-command-complete", event => {
                this.items.push({
                    command: event.detail?.parsed?.raw || "",
                    timestamp: new Date().toISOString()
                });
                this.items = this.items.slice(-100);
            });
        }
    }

    function initialize(context) {
        const recent = new RecentActivity(context);
        context.recent = recent;
        return recent;
    }

    const commands = [{
        name: "recent",
        category: "system",
        description: "Display recent completed commands.",
        handler: ({ context, writeJSON }) => writeJSON(context.recent.items)
    }];


    const api = Object.freeze({
        name: MODULE_NAME,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands: typeof commands === "undefined" ? [] : commands
    });

    window.SpeciedexTerminalRecent = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
