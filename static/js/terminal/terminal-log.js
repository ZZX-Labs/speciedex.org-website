/*
========================================================================
Speciedex.org
Terminal Logging Service
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Log";


    class TerminalLogger {
        constructor(context) {
            this.context = context;
            this.entries = [];
            this.limit = 1000;
        }

        push(level, message, metadata = {}) {
            const entry = {
                timestamp: new Date().toISOString(),
                level,
                message: String(message),
                metadata
            };
            this.entries.push(entry);
            this.entries = this.entries.slice(-this.limit);
            this.context.events?.emit("log", entry);
            return entry;
        }

        debug(message, metadata) { return this.push("debug", message, metadata); }
        info(message, metadata) { return this.push("info", message, metadata); }
        warn(message, metadata) { return this.push("warning", message, metadata); }
        error(message, metadata) { return this.push("error", message, metadata); }
    }

    function initialize(context) {
        const logger = new TerminalLogger(context);
        context.log = logger;
        context.registerService?.("log", logger);
        return logger;
    }

    const commands = [{
        name: "log",
        category: "system",
        description: "Display recent terminal log entries.",
        usage: "log [count]",
        handler: ({ args, context, writeJSON }) => {
            const count = Math.max(1, Math.min(200, Number(args[0]) || 25));
            return writeJSON((context.log?.entries || []).slice(-count));
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

    window.SpeciedexTerminalLog = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
