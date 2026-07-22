/*
========================================================================
Speciedex.org
Terminal Data Library
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Library";


    class DataLibrary {
        constructor(context) {
            this.context = context;
            this.collections = new Map();
        }

        set(name, records) {
            if (!Array.isArray(records)) {
                throw new TypeError("Library collections must be arrays.");
            }
            this.collections.set(name, records);
            return records;
        }

        get(name) {
            return this.collections.get(name) || [];
        }

        list() {
            return [...this.collections.entries()].map(([name, records]) => ({
                name,
                records: records.length
            }));
        }

        clear(name) {
            return name ? this.collections.delete(name) : this.collections.clear();
        }
    }

    function initialize(context) {
        const library = new DataLibrary(context);
        context.library = library;
        context.registerService?.("library", library);
        return library;
    }

    const commands = [{
        name: "library",
        category: "data",
        description: "Inspect in-memory terminal data collections.",
        usage: "library [list|clear] [name]",
        handler: ({ args, context, writeJSON, write }) => {
            if (args[0] === "clear") {
                context.library.clear(args[1]);
                return write("Library collection cleared.", "success");
            }
            return writeJSON(context.library.list());
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

    window.SpeciedexTerminalLibrary = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
