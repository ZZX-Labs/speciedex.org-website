/*
========================================================================
Speciedex.org
Terminal Settings Manager
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Settings";


    const DEFAULTS = Object.freeze({
        pageSize: 50,
        animation: true,
        reducedMotion: false,
        compactTables: false,
        autoScroll: true
    });

    class Settings {
        constructor(context) {
            this.context = context;
            this.values = {
                ...DEFAULTS,
                ...(context.storage?.get("settings", {}) || {})
            };
        }

        get(name) {
            return this.values[name];
        }

        set(name, value) {
            this.values[name] = value;
            this.context.storage?.set("settings", this.values);
            this.context.events?.emit("settings:change", { name, value });
            return value;
        }

        snapshot() {
            return { ...this.values };
        }
    }

    function parseValue(value) {
        if (value === "true") return true;
        if (value === "false") return false;
        if (value !== "" && Number.isFinite(Number(value))) return Number(value);
        return value;
    }

    function initialize(context) {
        const settings = new Settings(context);
        context.settings = settings;
        context.registerService?.("settings", settings);
        return settings;
    }

    const commands = [{
        name: "settings",
        category: "interface",
        description: "Inspect or change terminal settings.",
        usage: "settings [name] [value]",
        handler: ({ args, context, writeJSON, write }) => {
            if (!args.length) return writeJSON(context.settings.snapshot());
            if (args.length === 1) {
                return writeJSON({ [args[0]]: context.settings.get(args[0]) });
            }
            const value = parseValue(args.slice(1).join(" "));
            context.settings.set(args[0], value);
            return write(`Setting updated: ${args[0]}`, "success");
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

    window.SpeciedexTerminalSettings = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
