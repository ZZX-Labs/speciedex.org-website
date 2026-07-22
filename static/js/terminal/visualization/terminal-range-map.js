/*
========================================================================
Speciedex.org
Terminal RangeMap Visualization
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "RangeMap";


    function render(data = [], options = {}) {
        const container = document.createElement("section");
        container.className = "terminal-visualization terminal-visualization-range-map";
        container.dataset.visualization = "range-map";
        container.setAttribute("role", "img");
        container.setAttribute(
            "aria-label",
            options.label || "RangeMap visualization"
        );

        const canvas = document.createElement("canvas");
        canvas.width = Number(options.width) || 960;
        canvas.height = Number(options.height) || 540;
        container.appendChild(canvas);

        const context2d = canvas.getContext("2d");
        context2d.clearRect(0, 0, canvas.width, canvas.height);
        context2d.font = "16px monospace";
        context2d.fillText("RangeMap", 24, 32);
        context2d.font = "12px monospace";
        const records = Array.isArray(data) ? data : [data];
        context2d.fillText(`Records: ${records.length}`, 24, 54);

        container.data = records;
        container.canvas = canvas;
        return container;
    }

    function initialize(context) {
        const visualization = { render };
        context.registerVisualization?.("range-map", visualization);
        context.registerRenderer?.("range-map", visualization);
        return visualization;
    }

    const commands = [{
        name: "range-map",
        category: "visualization",
        description: "Render the RangeMap visualization.",
        usage: "range-map [collection]",
        handler: ({ args, context }) => {
            const collection = args[0] || "records";
            const data = context.library?.get(collection) || [];
            return render(data, { label: "RangeMap for " + collection });
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

    window.SpeciedexTerminalRangeMap = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
