/*
========================================================================
Speciedex.org
Terminal Import Module
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Import";


    async function readFile(file) {
        const text = await file.text();
        if (/\.json$/i.test(file.name)) {
            const value = JSON.parse(text);
            return Array.isArray(value) ? value : [value];
        }
        if (/\.jsonl$|\.ndjson$/i.test(file.name)) {
            return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
        }
        const [headerLine, ...lines] = text.split(/\r?\n/).filter(Boolean);
        const headers = headerLine.split(",").map(value => value.trim());
        return lines.map(line => {
            const values = line.split(",");
            return Object.fromEntries(headers.map((header, index) => [
                header, values[index]?.trim() || ""
            ]));
        });
    }

    function initialize(context) {
        const service = { readFile };
        context.importer = service;
        context.registerService?.("import", service);
        return service;
    }

    const commands = [{
        name: "import",
        category: "data",
        description: "Open a local file picker and import JSON, JSONL, NDJSON, or CSV.",
        usage: "import [collection]",
        handler: ({ args, context, write }) => new Promise(resolve => {
            const input = document.createElement("input");
            input.type = "file";
            input.accept = ".json,.jsonl,.ndjson,.csv";
            input.addEventListener("change", async () => {
                const file = input.files?.[0];
                if (!file) return resolve();
                const records = await readFile(file);
                context.library?.set(args[0] || "records", records);
                resolve(write(`Imported ${records.length} records.`, "success"));
            }, { once: true });
            input.click();
        })
    }];


    const api = Object.freeze({
        name: MODULE_NAME,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands: typeof commands === "undefined" ? [] : commands
    });

    window.SpeciedexTerminalImport = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
