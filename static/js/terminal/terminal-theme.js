/*
========================================================================
Speciedex.org
Terminal Theme Manager
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Theme";


    const THEMES = Object.freeze({
        speciedex: {
            background: "#07100a",
            foreground: "#d8e6db",
            accent: "#c0d674"
        },
        dark: {
            background: "#111111",
            foreground: "#eeeeee",
            accent: "#8ab4f8"
        },
        light: {
            background: "#f6f8f6",
            foreground: "#111611",
            accent: "#4c6b22"
        }
    });

    class ThemeManager {
        constructor(context) {
            this.context = context;
            this.current = "speciedex";
        }

        apply(name) {
            if (!THEMES[name]) {
                throw new Error(`Unknown terminal theme: ${name}`);
            }
            this.current = name;
            const theme = THEMES[name];
            const root = this.context.root;
            root.dataset.terminalTheme = name;
            root.style.setProperty("--terminal-background", theme.background);
            root.style.setProperty("--terminal-foreground", theme.foreground);
            root.style.setProperty("--terminal-accent", theme.accent);
            return theme;
        }
    }

    function initialize(context) {
        const manager = new ThemeManager(context);
        context.theme = manager;
        context.registerService?.("theme", manager);
        manager.apply(context.root?.dataset.terminalTheme || "speciedex");
        return manager;
    }

    const commands = [{
        name: "theme",
        category: "interface",
        description: "List or apply terminal themes.",
        usage: "theme [speciedex|dark|light]",
        handler: ({ args, context, writeJSON, write }) => {
            if (!args.length) {
                return writeJSON({
                    current: context.theme.current,
                    available: Object.keys(THEMES)
                });
            }
            context.theme.apply(args[0]);
            return write(`Theme applied: ${args[0]}`, "success");
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

    window.SpeciedexTerminalTheme = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
