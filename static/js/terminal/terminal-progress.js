/*
========================================================================
Speciedex.org
Terminal Progress Renderer
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Progress";


    function createProgress(label = "Progress", value = 0) {
        const wrapper = document.createElement("div");
        wrapper.className = "terminal-progress";
        wrapper.setAttribute("role", "progressbar");
        wrapper.setAttribute("aria-valuemin", "0");
        wrapper.setAttribute("aria-valuemax", "100");

        const bar = document.createElement("span");
        bar.className = "terminal-progress-bar";
        const text = document.createElement("span");
        text.className = "terminal-progress-label";
        wrapper.append(bar, text);

        wrapper.update = next => {
            const normalized = Math.max(0, Math.min(100, Number(next) || 0));
            wrapper.setAttribute("aria-valuenow", String(normalized));
            bar.style.width = `${normalized}%`;
            text.textContent = `${label}: ${normalized}%`;
        };
        wrapper.update(value);
        return wrapper;
    }

    function initialize(context) {
        context.createProgress = createProgress;
        context.registerRenderer?.("progress", createProgress);
        return { createProgress };
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

    window.SpeciedexTerminalProgress = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
