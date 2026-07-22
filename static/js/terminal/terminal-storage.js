/*
========================================================================
Speciedex.org
Terminal Storage Service
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Storage";


    class StorageService {
        constructor(namespace = "speciedex-terminal") {
            this.namespace = namespace;
            this.memory = new Map();
        }

        key(key) {
            return `${this.namespace}:${key}`;
        }

        get(key, fallback = null) {
            try {
                const raw = localStorage.getItem(this.key(key));
                return raw === null ? fallback : JSON.parse(raw);
            } catch (error) {
                return this.memory.has(key) ? this.memory.get(key) : fallback;
            }
        }

        set(key, value) {
            this.memory.set(key, value);
            try {
                localStorage.setItem(this.key(key), JSON.stringify(value));
            } catch (error) {}
            return value;
        }

        delete(key) {
            this.memory.delete(key);
            try {
                localStorage.removeItem(this.key(key));
            } catch (error) {}
        }

        clear() {
            this.memory.clear();
            try {
                for (const key of Object.keys(localStorage)) {
                    if (key.startsWith(`${this.namespace}:`)) {
                        localStorage.removeItem(key);
                    }
                }
            } catch (error) {}
        }
    }

    function initialize(context) {
        const service = new StorageService(
            context.root?.dataset.terminalStorageNamespace || "speciedex-terminal"
        );
        context.storage = service;
        context.registerService?.("storage", service);
        return service;
    }

    const commands = [{
        name: "storage",
        category: "system",
        description: "Inspect or clear terminal-local storage.",
        usage: "storage [show|clear]",
        handler: ({ args, context, writeJSON, write }) => {
            const storage = context.storage;
            if (!storage) {
                throw new Error("Storage service is unavailable.");
            }
            if (args[0] === "clear") {
                storage.clear();
                return write("Terminal storage cleared.", "success");
            }
            return writeJSON({
                namespace: storage.namespace,
                memoryEntries: storage.memory.size
            });
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

    window.SpeciedexTerminalStorage = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
