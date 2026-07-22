/*
========================================================================
Speciedex.org
Terminal Help System
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Help";


    function initialize(context) {
        const service = {
            topics: new Map(),
            register(topic, content) {
                this.topics.set(topic, content);
            },
            get(topic) {
                return this.topics.get(topic);
            }
        };
        service.register("syntax", [
            "Commands support quoted arguments, short flags, long flags,",
            "and key=value options where implemented."
        ].join("\n"));
        service.register("taxonomy", "Use species, genera, families, ranks, or taxonomy commands.");
        service.register("providers", "Use providers and provider-* commands.");
        service.register("archive", "Use archive, volumes, manifests, releases, and checksums.");
        context.help = service;
        context.registerService?.("help", service);
        return service;
    }

    const commands = [{
        name: "topic",
        category: "help",
        description: "Display a named help topic.",
        usage: "topic <name>",
        handler: ({ args, context, write }) => {
            const topic = args[0];
            if (!topic) return write([...context.help.topics.keys()].join("\n"));
            const content = context.help.get(topic);
            if (!content) throw new Error(`Unknown help topic: ${topic}`);
            return write(content, "output", { preformatted: true });
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

    window.SpeciedexTerminalHelp = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
