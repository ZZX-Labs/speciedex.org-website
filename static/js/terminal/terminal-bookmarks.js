/*
========================================================================
Speciedex.org
Terminal Bookmarks
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Bookmarks";


    class Bookmarks {
        constructor(context) {
            this.context = context;
            this.items = context.storage?.get("bookmarks", []) || [];
        }

        save() {
            this.context.storage?.set("bookmarks", this.items);
        }

        add(label, value) {
            this.items.push({
                id: crypto.randomUUID?.() || String(Date.now()),
                label,
                value,
                createdAt: new Date().toISOString()
            });
            this.save();
        }

        remove(id) {
            this.items = this.items.filter(item => item.id !== id);
            this.save();
        }
    }

    function initialize(context) {
        const bookmarks = new Bookmarks(context);
        context.bookmarks = bookmarks;
        context.registerService?.("bookmarks", bookmarks);
        return bookmarks;
    }

    const commands = [{
        name: "bookmark",
        category: "data",
        description: "Add, list, or remove terminal bookmarks.",
        usage: "bookmark [add <label> <value>|list|remove <id>]",
        handler: ({ args, context, writeJSON, write }) => {
            const action = args.shift() || "list";
            if (action === "add") {
                const label = args.shift();
                const value = args.join(" ");
                if (!label || !value) throw new Error("A label and value are required.");
                context.bookmarks.add(label, value);
                return write("Bookmark added.", "success");
            }
            if (action === "remove") {
                context.bookmarks.remove(args[0]);
                return write("Bookmark removed.", "success");
            }
            return writeJSON(context.bookmarks.items);
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

    window.SpeciedexTerminalBookmarks = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
