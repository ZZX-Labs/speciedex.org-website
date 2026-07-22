/*
========================================================================
Speciedex.org
Terminal Export Module
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Export";


    function download(filename, content, type) {
        const blob = new Blob([content], { type });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function initialize(context) {
        const service = {
            json(data, filename = "speciedex-export.json") {
                download(filename, JSON.stringify(data, null, 2), "application/json");
            },
            csv(rows, filename = "speciedex-export.csv") {
                const values = Array.isArray(rows) ? rows : [];
                const headers = [...new Set(values.flatMap(row => Object.keys(row || {})))];
                const escape = value => `"${String(value ?? "").replace(/"/g, '""')}"`;
                const csv = [
                    headers.map(escape).join(","),
                    ...values.map(row => headers.map(key => escape(row?.[key])).join(","))
                ].join("\n");
                download(filename, csv, "text/csv");
            },
            text(text, filename = "speciedex-export.txt") {
                download(filename, String(text), "text/plain");
            }
        };
        context.exporter = service;
        context.registerService?.("export", service);
        return service;
    }

    const commands = [{
        name: "export",
        category: "data",
        description: "Export a library collection as JSON or CSV.",
        usage: "export <collection> [json|csv] [filename]",
        handler: ({ args, context, write }) => {
            const collection = args[0] || "records";
            const format = args[1] || "json";
            const data = context.library?.get(collection) || [];
            const filename = args[2] || `speciedex-${collection}.${format}`;
            if (format === "csv") context.exporter.csv(data, filename);
            else context.exporter.json(data, filename);
            return write(`Exported ${data.length} records to ${filename}.`, "success");
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

    window.SpeciedexTerminalExport = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
