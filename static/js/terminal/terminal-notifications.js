/*
========================================================================
Speciedex.org
Terminal Notifications
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Notifications";


    class NotificationCenter {
        constructor(context) {
            this.context = context;
            this.items = [];
        }

        notify(message, type = "info", timeout = 4000) {
            const item = { id: crypto.randomUUID?.() || String(Date.now()), message, type };
            this.items.push(item);
            const node = document.createElement("div");
            node.className = `terminal-notification terminal-notification-${type}`;
            node.textContent = String(message);
            node.setAttribute("role", type === "error" ? "alert" : "status");
            this.context.root.appendChild(node);
            window.setTimeout(() => node.remove(), timeout);
            return item;
        }
    }

    function initialize(context) {
        const center = new NotificationCenter(context);
        context.notifications = center;
        context.registerService?.("notifications", center);
        return center;
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

    window.SpeciedexTerminalNotifications = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
