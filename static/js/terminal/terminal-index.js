/*
========================================================================
Speciedex.org
Terminal Search Index
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Index";


    class SearchIndex {
        constructor() {
            this.documents = [];
            this.fields = [];
        }

        build(records, fields = []) {
            this.documents = Array.isArray(records) ? records : [];
            this.fields = fields.length
                ? fields
                : [...new Set(this.documents.flatMap(record =>
                    Object.keys(record || {})
                ))];
            return this.documents.length;
        }

        search(query, limit = 50) {
            const needle = String(query || "").toLowerCase();
            if (!needle) return this.documents.slice(0, limit);
            return this.documents.filter(record =>
                this.fields.some(field =>
                    String(record?.[field] ?? "").toLowerCase().includes(needle)
                )
            ).slice(0, limit);
        }
    }

    function initialize(context) {
        const index = new SearchIndex();
        context.index = index;
        context.registerService?.("index", index);
        return index;
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

    window.SpeciedexTerminalIndex = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
