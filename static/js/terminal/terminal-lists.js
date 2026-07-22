/*
========================================================================
Speciedex.org
Terminal Lists Renderer
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Lists";


    function render(data, options = {}) {
        const container = document.createElement("div");
        container.className = "terminal-renderer terminal-renderer-list";
        container.dataset.renderer = "list";
        if (options.title) {
            const heading = document.createElement("h3");
            heading.textContent = options.title;
            container.appendChild(heading);
        }
        const pre = document.createElement("pre");
        pre.textContent = typeof data === "string"
            ? data
            : JSON.stringify(data, null, 2);
        container.appendChild(pre);
        return container;
    }

    function initialize(context) {
        const renderer = { render };
        context.registerRenderer?.("list", renderer);
        context.listRenderer = renderer;
        return renderer;
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

    window.SpeciedexTerminalLists = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
