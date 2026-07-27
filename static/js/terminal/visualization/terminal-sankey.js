/*
========================================================================
Speciedex.org
Terminal Sankey Visualization
========================================================================

Interactive Sankey flow renderer for Speciedex records. Supports explicit and
inferred nodes and links, weighted bands, cycle detection, layered layout,
node alignment, filtering, dragging, selection, zoom, pan, responsive high-DPI
rendering, JSON, CSV, and PNG export, diagnostics, and lifecycle control.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "sankey";
    const VERSION = "3.0.0";

    const VISUALIZATION_SYMBOL =
        Symbol.for("speciedex.terminal.sankey.visualization");

    const CONTROLLER_SYMBOL =
        Symbol.for("speciedex.terminal.sankey.controller");
    const DEFAULT_WIDTH = 960;
    const DEFAULT_HEIGHT = 540;
    const DEFAULT_BACKGROUND = "#020a05";
    const DEFAULT_FOREGROUND = "#c0d674";
    const DEFAULT_HIGHLIGHT = "#eef7c8";
    const DEFAULT_LINK = "#35503a";
    const DEFAULT_NODE_WIDTH = 18;
    const DEFAULT_NODE_GAP = 14;
    const DEFAULT_PADDING = 36;
    const DEFAULT_CURVATURE = 0.5;
    const DEFAULT_MAX_NODES = 2500;
    const DEFAULT_MAX_LINKS = 15000;
    const MAX_LABELS = 220;
    const DEFAULT_ASYNC_BATCH = 4096;
    const DEFAULT_LAYOUT_BATCH = 4;
    const DEFAULT_QUERY_LIMIT = 5000;
    const DEFAULT_FIT_PADDING = 32;

    function now() {
        return (
            window.performance &&
            typeof window.performance.now === "function"
        )
            ? window.performance.now()
            : Date.now();
    }

    function iso() {
        return new Date().toISOString();
    }

    function createAbortError(
        message = "Sankey operation aborted."
    ) {
        const error = new Error(message);
        error.name = "AbortError";
        error.code = "SANKEY_ABORTED";
        return error;
    }

    function throwIfAborted(signal) {
        if (signal?.aborted) {
            throw signal.reason instanceof Error
                ? signal.reason
                : createAbortError();
        }
    }

    function nextFrame(signal) {
        throwIfAborted(signal);

        return new Promise((resolve, reject) => {
            let frame = 0;

            const onAbort = () => {
                if (frame) {
                    window.cancelAnimationFrame(frame);
                }

                reject(
                    signal.reason instanceof Error
                        ? signal.reason
                        : createAbortError()
                );
            };

            signal?.addEventListener(
                "abort",
                onAbort,
                { once: true }
            );

            frame = window.requestAnimationFrame(() => {
                signal?.removeEventListener(
                    "abort",
                    onAbort
                );
                resolve();
            });
        });
    }

    function isObject(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    function clone(
        value,
        seen = new WeakMap(),
        depth = 0
    ) {
        if (
            value === null ||
            value === undefined ||
            typeof value !== "object"
        ) {
            return value;
        }

        if (depth > 40) {
            return "[Truncated]";
        }

        if (typeof structuredClone === "function") {
            try {
                return structuredClone(value);
            } catch (_error) {
                /* Continue with deterministic fallback. */
            }
        }

        if (seen.has(value)) {
            return "[Circular]";
        }

        seen.set(value, true);

        if (value instanceof Date) {
            return Number.isNaN(value.getTime())
                ? "Invalid Date"
                : value.toISOString();
        }

        if (value instanceof Error) {
            return {
                name: value.name,
                message: value.message,
                stack: value.stack || ""
            };
        }

        if (Array.isArray(value)) {
            return value.map(
                item => clone(item, seen, depth + 1)
            );
        }

        if (value instanceof Map) {
            const output = {};

            for (const [key, item] of value) {
                output[String(key)] =
                    clone(item, seen, depth + 1);
            }

            return output;
        }

        if (value instanceof Set) {
            return [...value].map(
                item => clone(item, seen, depth + 1)
            );
        }

        const output = {};

        for (const [key, item] of Object.entries(value)) {
            if (
                key === "__proto__" ||
                key === "prototype" ||
                key === "constructor"
            ) {
                continue;
            }

            output[key] =
                clone(item, seen, depth + 1);
        }

        return output;
    }

    function parseBoolean(value, fallback = false) {
        if (typeof value === "boolean") {
            return value;
        }

        if (value === undefined || value === null || value === "") {
            return fallback;
        }

        return ["1", "true", "yes", "on", "enabled"].includes(
            String(value).trim().toLowerCase()
        );
    }

    function parseNumber(value, fallback, minimum = -Infinity, maximum = Infinity) {
        const number = Number(value);

        if (!Number.isFinite(number)) {
            return fallback;
        }

        return Math.min(maximum, Math.max(minimum, number));
    }

    function safeDispatch(target, name, detail) {
        try {
            target.dispatchEvent(new CustomEvent(name, { detail }));
        } catch (error) {
            /* Visualization events must never interrupt rendering. */
        }
    }

    function createElement(tagName, className, text) {
        const element = document.createElement(tagName);

        if (className) {
            element.className = className;
        }

        if (text !== undefined) {
            element.textContent = text;
        }

        return element;
    }

    function resolveCanvas(target) {
        if (target instanceof HTMLCanvasElement) {
            return target;
        }

        if (target instanceof Element) {
            const canvas =
                target.querySelector("canvas") ||
                document.createElement("canvas");

            if (!canvas.isConnected) {
                target.appendChild(canvas);
            }

            return canvas;
        }

        throw new TypeError(
            "Sankey visualization requires a canvas or container element."
        );
    }

    function createResizeObserver(
        element,
        callback
    ) {
        let frame = 0;
        let lastWidth = -1;
        let lastHeight = -1;

        const schedule = () => {
            if (frame) {
                return;
            }

            frame = window.requestAnimationFrame(() => {
                frame = 0;

                const rectangle =
                    element.getBoundingClientRect();

                const width =
                    Math.round(rectangle.width * 100) / 100;

                const height =
                    Math.round(rectangle.height * 100) / 100;

                if (
                    width === lastWidth &&
                    height === lastHeight
                ) {
                    return;
                }

                lastWidth = width;
                lastHeight = height;
                callback();
            });
        };

        if (typeof ResizeObserver === "function") {
            const observer =
                new ResizeObserver(schedule);

            observer.observe(element);

            return () => {
                observer.disconnect();

                if (frame) {
                    window.cancelAnimationFrame(frame);
                    frame = 0;
                }
            };
        }

        window.addEventListener("resize", schedule);

        return () => {
            window.removeEventListener("resize", schedule);

            if (frame) {
                window.cancelAnimationFrame(frame);
            }
        };
    }

    function normalizeRecords(data) {
        if (data === null || data === undefined) {
            return [];
        }

        if (Array.isArray(data)) {
            return data;
        }

        if (isObject(data)) {
            for (const key of ["records", "results", "items", "nodes", "data"]) {
                if (Array.isArray(data[key])) {
                    return data[key];
                }
            }

            return [data];
        }

        return [data];
    }

    function firstValue(record, keys, fallback = null) {
        for (const key of keys) {
            const value = record?.[key];

            if (value !== undefined && value !== null && value !== "") {
                return value;
            }
        }

        return fallback;
    }

    function nodeId(record, index) {
        if (!isObject(record)) {
            return `node-${index + 1}`;
        }

        return String(firstValue(record, [
            "speciedex_id",
            "speciedexId",
            "taxon_id",
            "taxonId",
            "canonical_id",
            "canonicalId",
            "id",
            "key",
            "uuid"
        ], `node-${index + 1}`));
    }

    function nodeLabel(record, index) {
        if (!isObject(record)) {
            return String(record ?? `Node ${index + 1}`);
        }

        return String(firstValue(record, [
            "scientific_name",
            "scientificName",
            "canonical_name",
            "canonicalName",
            "accepted_name",
            "acceptedName",
            "common_name",
            "commonName",
            "provider",
            "name",
            "label"
        ], `Node ${index + 1}`));
    }

    function nodeGroup(record, groupKey) {
        if (!isObject(record)) {
            return "ungrouped";
        }

        if (groupKey && record[groupKey] !== undefined) {
            return String(record[groupKey]);
        }

        return String(firstValue(record, [
            "kingdom",
            "phylum",
            "class",
            "order",
            "family",
            "genus",
            "rank",
            "provider",
            "source",
            "status"
        ], "ungrouped"));
    }

    function nodeWeight(record) {
        if (!isObject(record)) {
            return 1;
        }

        for (const key of [
            "weight",
            "value",
            "count",
            "score",
            "abundance",
            "occurrenceCount",
            "occurrence_count"
        ]) {
            const value = Number(record[key]);

            if (Number.isFinite(value)) {
                return Math.max(0, value);
            }
        }

        return 0;
    }

    function colorHash(value) {
        let hash = 0;

        for (const character of String(value || "")) {
            hash = ((hash << 5) - hash) + character.charCodeAt(0);
            hash |= 0;
        }

        return `hsl(${Math.abs(hash) % 360} 55% 60%)`;
    }

    function extractExplicitLinks(data) {
        if (!isObject(data)) {
            return [];
        }

        for (const key of ["links", "edges", "flows", "relationships"]) {
            if (Array.isArray(data[key])) {
                return data[key];
            }
        }

        return [];
    }

    function extractReferences(record, options = {}) {
        if (!isObject(record)) {
            return [];
        }

        const keys = Array.isArray(options.linkKeys) && options.linkKeys.length
            ? options.linkKeys
            : [
                "parent_id",
                "parentId",
                "accepted_id",
                "acceptedId",
                "source_id",
                "sourceId",
                "target_id",
                "targetId",
                "related_ids",
                "relatedIds",
                "links",
                "flows",
                "relationships"
            ];
        const references = [];

        const append = (item, type) => {
            if (isObject(item)) {
                const target = firstValue(item, [
                    "target",
                    "targetId",
                    "to",
                    "id",
                    "key",
                    "taxonId"
                ], "");

                if (target !== "") {
                    references.push({
                        target: String(target),
                        type: String(firstValue(item, [
                            "type",
                            "relationship",
                            "kind"
                        ], type)),
                        value: parseNumber(
                            item.value ??
                            item.weight ??
                            item.count,
                            1,
                            0.000001,
                            1e15
                        )
                    });
                }
            } else if (item !== "") {
                references.push({
                    target: String(item),
                    type,
                    value: 1
                });
            }
        };

        for (const key of keys) {
            const value = record[key];

            if (value === undefined || value === null) {
                continue;
            }

            if (Array.isArray(value)) {
                value.forEach((item) => append(item, key));
            } else {
                append(value, key);
            }
        }

        return references;
    }

    function normalizeGraph(data, options = {}) {
        const maxNodes = Math.floor(parseNumber(
            options.maxNodes,
            DEFAULT_MAX_NODES,
            1,
            100000
        ));
        const maxLinks = Math.floor(parseNumber(
            options.maxLinks,
            DEFAULT_MAX_LINKS,
            0,
            1000000
        ));
        const records = normalizeRecords(data).slice(0, maxNodes);
        const nodes = [];
        const byId = new Map();

        records.forEach((record, index) => {
            const id = nodeId(record, index);

            if (byId.has(id)) {
                return;
            }

            const node = {
                id,
                label: nodeLabel(record, index),
                group: nodeGroup(record, options.groupKey),
                weight: nodeWeight(record),
                incoming: [],
                outgoing: [],
                depth: 0,
                height: 0,
                value: 0,
                x0: 0,
                x1: 0,
                y0: 0,
                y1: 0,
                visible: true,
                fixedY: null,
                raw: clone(record)
            };

            nodes.push(node);
            byId.set(id, node);
        });

        const links = [];
        const seen = new Map();

        const addLink = (
            source,
            target,
            value = 1,
            type = "flow"
        ) => {
            if (links.length >= maxLinks) {
                return false;
            }

            source = String(source);
            target = String(target);

            if (
                source === target ||
                !byId.has(source) ||
                !byId.has(target)
            ) {
                return false;
            }

            const key = `${source}|${target}|${type}`;

            if (seen.has(key)) {
                const existing = seen.get(key);

                existing.value += parseNumber(
                    value,
                    1,
                    0.000001,
                    1e15
                );

                return false;
            }

            const link = {
                id: key,
                source,
                target,
                value: parseNumber(
                    value,
                    1,
                    0.000001,
                    1e15
                ),
                type: String(type),
                visible: true,
                width: 0,
                sy: 0,
                ty: 0,
                cyclic: false
            };

            links.push(link);
            seen.set(key, link);
            return true;
        };

        for (const link of extractExplicitLinks(data)) {
            if (!isObject(link)) {
                continue;
            }

            addLink(
                firstValue(link, ["source", "sourceId", "from"], ""),
                firstValue(link, ["target", "targetId", "to"], ""),
                link.value ?? link.weight ?? link.count ?? 1,
                firstValue(link, ["type", "relationship", "kind"], "flow")
            );
        }

        for (const node of nodes) {
            for (const reference of extractReferences(node.raw, options)) {
                addLink(
                    node.id,
                    reference.target,
                    reference.value,
                    reference.type
                );
            }
        }

        if (options.inferHierarchy !== false && links.length < maxLinks) {
            const labelMap = new Map(
                nodes.map((node) => [node.label, node.id])
            );
            const rankPairs = [
                ["species", "genus"],
                ["genus", "family"],
                ["family", "order"],
                ["order", "class"],
                ["class", "phylum"],
                ["phylum", "kingdom"]
            ];

            for (const node of nodes) {
                if (!isObject(node.raw)) {
                    continue;
                }

                for (const [childRank, parentRank] of rankPairs) {
                    const child = firstValue(node.raw, [
                        childRank,
                        `${childRank}_name`,
                        `${childRank}Name`
                    ]);
                    const parent = firstValue(node.raw, [
                        parentRank,
                        `${parentRank}_name`,
                        `${parentRank}Name`
                    ]);

                    if (!child || !parent) {
                        continue;
                    }

                    const parentId =
                        labelMap.get(String(parent)) ||
                        (byId.has(String(parent)) ? String(parent) : null);

                    if (parentId) {
                        addLink(
                            parentId,
                            node.id,
                            Math.max(1, node.weight || 1),
                            "taxonomy"
                        );
                    }

                    if (links.length >= maxLinks) {
                        break;
                    }
                }

                if (links.length >= maxLinks) {
                    break;
                }
            }
        }

        for (const link of links) {
            byId.get(link.source).outgoing.push(link);
            byId.get(link.target).incoming.push(link);
        }

        return {
            nodes,
            links,
            byId
        };
    }

    function detectCycles(graph) {
        const state = new Map();
        let cycles = 0;

        for (const root of graph.nodes) {
            if (state.get(root.id) === 2) {
                continue;
            }

            const stack = [{
                node: root,
                index: 0
            }];

            while (stack.length) {
                const frame = stack[stack.length - 1];
                const node = frame.node;

                if (!state.has(node.id)) {
                    state.set(node.id, 1);
                }

                if (frame.index >= node.outgoing.length) {
                    state.set(node.id, 2);
                    stack.pop();
                    continue;
                }

                const link =
                    node.outgoing[frame.index++];

                const target =
                    graph.byId.get(link.target);

                if (!target) {
                    continue;
                }

                const targetState =
                    state.get(target.id) || 0;

                if (targetState === 1) {
                    if (!link.cyclic) {
                        link.cyclic = true;
                        cycles += 1;
                    }

                    continue;
                }

                if (targetState === 0) {
                    stack.push({
                        node: target,
                        index: 0
                    });
                }
            }
        }

        return cycles;
    }

    class SankeyController extends EventTarget {
        constructor(target, data = [], options = {}) {
            super();

            this.canvas = resolveCanvas(target);
            this.context = this.canvas.getContext("2d", {
                alpha: true,
                desynchronized: true
            });

            if (!this.context) {
                throw new Error(
                    "Unable to acquire Sankey 2D canvas context."
                );
            }

            this.options = {
                background:
                    options.background ||
                    DEFAULT_BACKGROUND,
                foreground:
                    options.foreground ||
                    DEFAULT_FOREGROUND,
                highlight:
                    options.highlight ||
                    DEFAULT_HIGHLIGHT,
                linkColor:
                    options.linkColor ||
                    DEFAULT_LINK,
                nodeWidth: parseNumber(
                    options.nodeWidth,
                    DEFAULT_NODE_WIDTH,
                    4,
                    80
                ),
                nodeGap: parseNumber(
                    options.nodeGap,
                    DEFAULT_NODE_GAP,
                    0,
                    200
                ),
                padding: parseNumber(
                    options.padding,
                    DEFAULT_PADDING,
                    0,
                    240
                ),
                curvature: parseNumber(
                    options.curvature,
                    DEFAULT_CURVATURE,
                    0,
                    1
                ),
                alignment: [
                    "justify",
                    "left",
                    "right",
                    "center"
                ].includes(options.alignment)
                    ? options.alignment
                    : "justify",
                iterations: parseNumber(
                    options.iterations,
                    24,
                    1,
                    200
                ),
                showLabels:
                    options.showLabels !== false,
                showValues:
                    options.showValues === true,
                showLinks:
                    options.showLinks !== false,
                showGroups:
                    options.showGroups !== false,
                showCycles:
                    options.showCycles !== false,
                linkOpacity: parseNumber(
                    options.linkOpacity,
                    0.34,
                    0,
                    1
                ),
                groupKey:
                    options.groupKey || null,
                inferHierarchy:
                    options.inferHierarchy !== false,
                maxNodes: parseNumber(
                    options.maxNodes,
                    DEFAULT_MAX_NODES,
                    1,
                    100000
                ),
                maxLinks: parseNumber(
                    options.maxLinks,
                    DEFAULT_MAX_LINKS,
                    0,
                    1000000
                ),
                interactive:
                    options.interactive !== false,
                draggable:
                    options.draggable !== false,
                zoomable:
                    options.zoomable !== false,
                pannable:
                    options.pannable !== false,
                label:
                    options.label ||
                    "Sankey visualization"
            };

            this.graph = {
                nodes: [],
                links: [],
                byId: new Map()
            };
            this.layers = [];
            this.bounds = {
                width: 1,
                height: 1
            };
            this.transform = {
                zoom: 1,
                x: 0,
                y: 0
            };
            this.hovered = null;
            this.selected = null;
            this.drag = null;
            this.query = "";
            this.groupFilter = null;
            this.destroyed = false;
            this.lastError = null;
            this.emitting = false;
            this.pointerMoved = false;
            this.lastWidth = 0;
            this.lastHeight = 0;
            this.abortController = new AbortController();
            this.visibleNodes = [];
            this.visibleLinks = [];
            this.metrics = {
                inputRecords: 0,
                nodes: 0,
                links: 0,
                visibleNodes: 0,
                visibleLinks: 0,
                layers: 0,
                cycles: 0,
                totalFlow: 0,
                draws: 0,
                layouts: 0,
                resizes: 0,
                zooms: 0,
                pans: 0,
                selections: 0,
                hitTests: 0,
                skippedResizes: 0,
                errors: 0,
                asyncLoads: 0,
                asyncLayouts: 0,
                asyncYields: 0,
                asyncRecords: 0,
                fits: 0,
                focuses: 0,
                pathQueries: 0,
                upstreamQueries: 0,
                downstreamQueries: 0,
                componentQueries: 0,
                flowQueries: 0
            };

            this._boundPointerMove =
                this._handlePointerMove.bind(this);
            this._boundPointerLeave =
                this._handlePointerLeave.bind(this);
            this._boundPointerDown =
                this._handlePointerDown.bind(this);
            this._boundPointerUp =
                this._handlePointerUp.bind(this);
            this._boundWheel =
                this._handleWheel.bind(this);
            this._boundClick =
                this._handleClick.bind(this);
            this._boundKeydown =
                this._handleKeydown.bind(this);

            this.canvas[CONTROLLER_SYMBOL] = this;
            this.canvas.sankeyController = this;

            this._cleanupResize = createResizeObserver(
                this.canvas,
                () => this.resize()
            );

            const signal = this.abortController.signal;

            if (this.options.interactive) {
                this.canvas.tabIndex =
                    this.canvas.tabIndex >= 0
                        ? this.canvas.tabIndex
                        : 0;
                this.canvas.setAttribute(
                    "aria-label",
                    this.options.label
                );
                this.canvas.addEventListener(
                    "pointermove",
                    this._boundPointerMove,
                    { signal, passive: true }
                );
                this.canvas.addEventListener(
                    "pointerleave",
                    this._boundPointerLeave,
                    { signal, passive: true }
                );
                this.canvas.addEventListener(
                    "pointerdown",
                    this._boundPointerDown,
                    { signal }
                );
                this.canvas.addEventListener(
                    "pointerup",
                    this._boundPointerUp,
                    { signal }
                );
                this.canvas.addEventListener(
                    "pointercancel",
                    this._boundPointerUp,
                    { signal }
                );
                this.canvas.addEventListener(
                    "wheel",
                    this._boundWheel,
                    { passive: false, signal }
                );
                this.canvas.addEventListener(
                    "click",
                    this._boundClick,
                    { signal }
                );
                this.canvas.addEventListener(
                    "keydown",
                    this._boundKeydown,
                    { signal }
                );
            }

            this.resize();
            this.setData(data);
        }

        _emit(type, detail = {}) {
            const event = {
                type,
                timestamp: iso(),
                ...detail
            };

            if (this.emitting) {
                return event;
            }

            this.emitting = true;

            try {
                safeDispatch(this, type, event);

                try {
                    this.options.context?.events?.emit?.(
                        `sankey:${type}`,
                        event
                    );
                } catch (observerError) {
                    window.console?.warn?.(
                        "[SpeciedexTerminalSankey] Event observer failed:",
                        observerError
                    );
                }

                return event;
            } finally {
                this.emitting = false;
            }
        }

        _recordError(error) {
            this.lastError = error instanceof Error
                ? error
                : new Error(String(error));
            this.metrics.errors += 1;

            this._emit("error", {
                error: {
                    name: this.lastError.name,
                    message: this.lastError.message,
                    stack: this.lastError.stack || ""
                }
            });
        }

        resize() {
            if (this.destroyed) {
                return false;
            }

            const rectangle =
                this.canvas.getBoundingClientRect();

            const logicalWidth =
                rectangle.width ||
                this.canvas.clientWidth ||
                this.canvas.parentElement?.clientWidth ||
                DEFAULT_WIDTH;

            const logicalHeight =
                rectangle.height ||
                this.canvas.clientHeight ||
                this.canvas.parentElement?.clientHeight ||
                DEFAULT_HEIGHT;

            if (
                logicalWidth <= 0 ||
                logicalHeight <= 0
            ) {
                this.metrics.skippedResizes += 1;
                return false;
            }

            if (
                Math.abs(logicalWidth - this.lastWidth) < 0.5 &&
                Math.abs(logicalHeight - this.lastHeight) < 0.5
            ) {
                this.metrics.skippedResizes += 1;
                return false;
            }

            this.lastWidth = logicalWidth;
            this.lastHeight = logicalHeight;

            const ratio =
                Math.min(window.devicePixelRatio || 1, 2);

            const width =
                Math.max(1, Math.round(logicalWidth * ratio));

            const height =
                Math.max(1, Math.round(logicalHeight * ratio));

            if (
                this.canvas.width !== width ||
                this.canvas.height !== height
            ) {
                this.canvas.width = width;
                this.canvas.height = height;
            }

            this.context.setTransform(
                ratio,
                0,
                0,
                ratio,
                0,
                0
            );

            this.bounds.width = logicalWidth;
            this.bounds.height = logicalHeight;
            this.metrics.resizes += 1;

            this.layout();
            this.draw();

            this._emit("resize", clone(this.bounds));
            return true;
        }

        setData(data) {
            try {
                this.graph = normalizeGraph(
                    data,
                    this.options
                );
                this.metrics.inputRecords =
                    normalizeRecords(data).length;
                this.metrics.nodes =
                    this.graph.nodes.length;
                this.metrics.links =
                    this.graph.links.length;
                this.metrics.cycles =
                    detectCycles(this.graph);
                this.metrics.totalFlow =
                    this.graph.links.reduce(
                        (total, link) =>
                            total + link.value,
                        0
                    );

                this.hovered = null;
                this.selected = null;
                this._applyFilters();
                this.layout();
                this.draw();

                this._emit("data", {
                    nodes:
                        this.graph.nodes.length,
                    links:
                        this.graph.links.length,
                    cycles:
                        this.metrics.cycles
                });
            } catch (error) {
                this._recordError(error);
            }

            return this;
        }

        async setDataAsync(data, options = {}) {
            if (this.destroyed) {
                throw new Error(
                    "Sankey controller has been destroyed."
                );
            }

            const signal = options.signal;
            const batchSize = Math.floor(
                parseNumber(
                    options.batchSize ??
                    options.batch_size,
                    DEFAULT_ASYNC_BATCH,
                    1,
                    100000
                )
            );

            const records = normalizeRecords(data);
            const staged = [];
            const startedAt = now();
            let completed = 0;

            throwIfAborted(signal);

            this._emit("load-start", {
                records: records.length,
                batchSize
            });

            try {
                while (completed < records.length) {
                    throwIfAborted(signal);

                    const end = Math.min(
                        records.length,
                        completed + batchSize
                    );

                    staged.push(
                        ...records.slice(completed, end)
                    );

                    this.metrics.asyncRecords +=
                        end - completed;

                    completed = end;

                    this._emit("load-progress", {
                        completed,
                        total: records.length,
                        progress:
                            records.length
                                ? completed / records.length
                                : 1
                    });

                    if (completed < records.length) {
                        this.metrics.asyncYields += 1;
                        await nextFrame(signal);
                    }
                }

                throwIfAborted(signal);

                this.graph = normalizeGraph(
                    staged,
                    this.options
                );

                this.metrics.inputRecords =
                    staged.length;
                this.metrics.nodes =
                    this.graph.nodes.length;
                this.metrics.links =
                    this.graph.links.length;
                this.metrics.cycles =
                    detectCycles(this.graph);
                this.metrics.totalFlow =
                    this.graph.links.reduce(
                        (total, link) =>
                            total + link.value,
                        0
                    );

                this.hovered = null;
                this.selected = null;
                this.drag = null;
                this.pointerMoved = false;

                this._applyFilters();

                await this.layoutAsync({
                    signal,
                    batchSize:
                        options.layoutBatchSize ??
                        options.layout_batch_size
                });

                this.draw();
                this.metrics.asyncLoads += 1;

                const result = {
                    records: staged.length,
                    nodes: this.graph.nodes.length,
                    links: this.graph.links.length,
                    cycles: this.metrics.cycles,
                    duration: now() - startedAt
                };

                this._emit("load-complete", result);
                this._emit("data", result);

                return result;
            } catch (error) {
                this._emit("load-error", {
                    completed,
                    total: records.length,
                    duration: now() - startedAt,
                    error: {
                        name: error.name,
                        message: error.message,
                        code: error.code || ""
                    }
                });

                throw error;
            }
        }

        async layoutAsync(options = {}) {
            const signal = options.signal;
            const batchSize = Math.floor(
                parseNumber(
                    options.batchSize ??
                    options.batch_size,
                    DEFAULT_LAYOUT_BATCH,
                    1,
                    100
                )
            );

            const nodes = this.visibleNodes;
            const links = this.visibleLinks;
            const startedAt = now();

            throwIfAborted(signal);

            if (!nodes.length) {
                this.layers = [];
                return {
                    iterations: 0,
                    duration: now() - startedAt
                };
            }

            this._assignDepths(nodes, links);
            this._assignHeights(nodes, links);
            this._buildLayers(nodes);
            this._assignHorizontalPositions();
            this._assignValues(nodes);
            this._assignVerticalPositions();

            const iterations = Math.floor(
                parseNumber(
                    this.options.iterations,
                    24,
                    1,
                    200
                )
            );

            this._emit("layout-start", {
                iterations,
                nodes: nodes.length,
                links: links.length
            });

            let completed = 0;

            while (completed < iterations) {
                throwIfAborted(signal);

                const end = Math.min(
                    iterations,
                    completed + batchSize
                );

                for (
                    let iteration = completed;
                    iteration < end;
                    iteration += 1
                ) {
                    this._relaxIteration(
                        iteration,
                        iterations
                    );
                }

                completed = end;

                this._emit("layout-progress", {
                    completed,
                    total: iterations,
                    progress: completed / iterations
                });

                if (completed < iterations) {
                    this.metrics.asyncYields += 1;
                    await nextFrame(signal);
                }
            }

            this._assignLinkOffsets();
            this.metrics.layers =
                this.layers.length;
            this.metrics.layouts += 1;
            this.metrics.asyncLayouts += 1;

            const result = {
                iterations,
                duration: now() - startedAt,
                layers: this.layers.length
            };

            this._emit("layout-complete", result);
            return result;
        }

        _relaxIteration(iteration, iterations) {
            const alpha =
                1 -
                iteration /
                Math.max(1, iterations);

            for (
                let depth = 1;
                depth < this.layers.length;
                depth += 1
            ) {
                for (
                    const node of
                    this.layers[depth]
                ) {
                    if (node.fixedY !== null) {
                        continue;
                    }

                    let weighted = 0;
                    let total = 0;

                    for (const link of node.incoming) {
                        if (!link.visible || link.cyclic) {
                            continue;
                        }

                        const source =
                            this.graph.byId.get(
                                link.source
                            );

                        if (!source) {
                            continue;
                        }

                        weighted +=
                            (
                                source.y0 +
                                source.y1
                            ) /
                            2 *
                            link.value;

                        total += link.value;
                    }

                    if (total > 0) {
                        const target =
                            weighted / total;

                        const center =
                            (
                                node.y0 +
                                node.y1
                            ) /
                            2;

                        const offset =
                            (
                                target -
                                center
                            ) *
                            alpha *
                            0.5;

                        node.y0 += offset;
                        node.y1 += offset;
                    }
                }

                this._resolveLayerCollisions(
                    this.layers[depth]
                );
            }

            for (
                let depth =
                    this.layers.length - 2;
                depth >= 0;
                depth -= 1
            ) {
                for (
                    const node of
                    this.layers[depth]
                ) {
                    if (node.fixedY !== null) {
                        continue;
                    }

                    let weighted = 0;
                    let total = 0;

                    for (const link of node.outgoing) {
                        if (!link.visible || link.cyclic) {
                            continue;
                        }

                        const target =
                            this.graph.byId.get(
                                link.target
                            );

                        if (!target) {
                            continue;
                        }

                        weighted +=
                            (
                                target.y0 +
                                target.y1
                            ) /
                            2 *
                            link.value;

                        total += link.value;
                    }

                    if (total > 0) {
                        const target =
                            weighted / total;

                        const center =
                            (
                                node.y0 +
                                node.y1
                            ) /
                            2;

                        const offset =
                            (
                                target -
                                center
                            ) *
                            alpha *
                            0.5;

                        node.y0 += offset;
                        node.y1 += offset;
                    }
                }

                this._resolveLayerCollisions(
                    this.layers[depth]
                );
            }
        }

        fitView(options = {}) {
            if (!this.visibleNodes.length) {
                return this.resetView();
            }

            const padding = parseNumber(
                options.padding,
                DEFAULT_FIT_PADDING,
                0,
                Math.min(
                    this.bounds.width,
                    this.bounds.height
                ) / 2
            );

            const minimumX = Math.min(
                ...this.visibleNodes.map(
                    node => node.x0
                )
            );

            const maximumX = Math.max(
                ...this.visibleNodes.map(
                    node => node.x1
                )
            );

            const minimumY = Math.min(
                ...this.visibleNodes.map(
                    node => node.y0
                )
            );

            const maximumY = Math.max(
                ...this.visibleNodes.map(
                    node => node.y1
                )
            );

            const contentWidth = Math.max(
                1,
                maximumX - minimumX
            );

            const contentHeight = Math.max(
                1,
                maximumY - minimumY
            );

            const availableWidth = Math.max(
                1,
                this.bounds.width - padding * 2
            );

            const availableHeight = Math.max(
                1,
                this.bounds.height - padding * 2
            );

            const zoom = Math.max(
                0.3,
                Math.min(
                    10,
                    Math.min(
                        availableWidth / contentWidth,
                        availableHeight / contentHeight
                    )
                )
            );

            const centerX =
                (minimumX + maximumX) / 2;

            const centerY =
                (minimumY + maximumY) / 2;

            this.transform.zoom = zoom;
            this.transform.x =
                (
                    this.bounds.width / 2 -
                    centerX
                ) * zoom;

            this.transform.y =
                (
                    this.bounds.height / 2 -
                    centerY
                ) * zoom;

            this.metrics.fits += 1;
            this.draw();

            this._emit("fit", {
                transform: clone(this.transform),
                nodes: this.visibleNodes.length,
                padding
            });

            return clone(this.transform);
        }

        focusNode(id, options = {}) {
            const node = this.graph.byId.get(
                String(id)
            );

            if (!node) {
                return null;
            }

            const zoom = parseNumber(
                options.zoom,
                Math.max(
                    this.transform.zoom,
                    1.5
                ),
                0.3,
                10
            );

            const centerX =
                (
                    node.x0 +
                    node.x1
                ) / 2;

            const centerY =
                (
                    node.y0 +
                    node.y1
                ) / 2;

            this.transform.zoom = zoom;
            this.transform.x =
                (
                    this.bounds.width / 2 -
                    centerX
                ) * zoom;

            this.transform.y =
                (
                    this.bounds.height / 2 -
                    centerY
                ) * zoom;

            this.selected = node;
            this.metrics.focuses += 1;
            this.draw();

            const description =
                this.describeItem(node);

            this._emit("focus", {
                node: description,
                transform: clone(this.transform)
            });

            return description;
        }

        shortestPath(
            sourceId,
            targetId,
            options = {}
        ) {
            const source = String(sourceId);
            const target = String(targetId);

            if (
                !this.graph.byId.has(source) ||
                !this.graph.byId.has(target)
            ) {
                return null;
            }

            const directed =
                options.directed !== false;

            const weighted =
                options.weighted === true;

            const distances = new Map(
                this.graph.nodes.map(
                    node => [node.id, Infinity]
                )
            );

            const previous = new Map();
            const previousLink = new Map();
            const queue = new Set(
                this.visibleNodes.map(node => node.id)
            );

            distances.set(source, 0);

            while (queue.size) {
                let current = null;
                let best = Infinity;

                for (const id of queue) {
                    const distance =
                        distances.get(id);

                    if (distance < best) {
                        best = distance;
                        current = id;
                    }
                }

                if (
                    current === null ||
                    best === Infinity
                ) {
                    break;
                }

                queue.delete(current);

                if (current === target) {
                    break;
                }

                const node =
                    this.graph.byId.get(current);

                const links = directed
                    ? node.outgoing
                    : [
                        ...node.outgoing,
                        ...node.incoming
                    ];

                for (const link of links) {
                    if (!link.visible) {
                        continue;
                    }

                    const neighbor =
                        link.source === current
                            ? link.target
                            : link.source;

                    if (!queue.has(neighbor)) {
                        continue;
                    }

                    const cost = weighted
                        ? 1 / Math.max(
                            Number.EPSILON,
                            link.value
                        )
                        : 1;

                    const alternative =
                        best + cost;

                    if (
                        alternative <
                        distances.get(neighbor)
                    ) {
                        distances.set(
                            neighbor,
                            alternative
                        );

                        previous.set(
                            neighbor,
                            current
                        );

                        previousLink.set(
                            neighbor,
                            link
                        );
                    }
                }
            }

            if (
                source !== target &&
                !previous.has(target)
            ) {
                return null;
            }

            const nodeIds = [];
            const links = [];
            let current = target;

            while (current !== undefined) {
                nodeIds.unshift(current);

                const link =
                    previousLink.get(current);

                if (link) {
                    links.unshift(
                        this.describeItem(link)
                    );
                }

                if (current === source) {
                    break;
                }

                current = previous.get(current);
            }

            this.metrics.pathQueries += 1;

            return {
                source,
                target,
                directed,
                weighted,
                cost: distances.get(target),
                hops: Math.max(
                    0,
                    nodeIds.length - 1
                ),
                nodes: nodeIds.map(id =>
                    this.describeItem(
                        this.graph.byId.get(id)
                    )
                ),
                links
            };
        }

        traverse(
            id,
            direction = "downstream",
            depth = 1,
            limit = DEFAULT_QUERY_LIMIT
        ) {
            const start = String(id);

            if (!this.graph.byId.has(start)) {
                return [];
            }

            const maximumDepth = Math.floor(
                parseNumber(
                    depth,
                    1,
                    1,
                    64
                )
            );

            const maximum = Math.floor(
                parseNumber(
                    limit,
                    DEFAULT_QUERY_LIMIT,
                    1,
                    100000
                )
            );

            const visited = new Set([start]);
            let frontier = new Set([start]);
            const results = [];

            for (
                let level = 1;
                level <= maximumDepth;
                level += 1
            ) {
                const next = new Set();

                for (const current of frontier) {
                    const node =
                        this.graph.byId.get(current);

                    const links =
                        direction === "upstream"
                            ? node.incoming
                            : node.outgoing;

                    for (const link of links) {
                        if (!link.visible) {
                            continue;
                        }

                        const neighbor =
                            direction === "upstream"
                                ? link.source
                                : link.target;

                        if (visited.has(neighbor)) {
                            continue;
                        }

                        visited.add(neighbor);
                        next.add(neighbor);

                        results.push({
                            depth: level,
                            via:
                                this.describeItem(link),
                            node:
                                this.describeItem(
                                    this.graph.byId.get(
                                        neighbor
                                    )
                                )
                        });

                        if (
                            results.length >=
                            maximum
                        ) {
                            break;
                        }
                    }

                    if (
                        results.length >=
                        maximum
                    ) {
                        break;
                    }
                }

                frontier = next;

                if (
                    !frontier.size ||
                    results.length >= maximum
                ) {
                    break;
                }
            }

            if (direction === "upstream") {
                this.metrics.upstreamQueries += 1;
            } else {
                this.metrics.downstreamQueries += 1;
            }

            return results;
        }

        connectedComponents(options = {}) {
            const visibleOnly =
                options.visibleOnly ??
                options.visible_only ??
                true;

            const nodes = this.graph.nodes.filter(
                node =>
                    !visibleOnly ||
                    node.visible
            );

            const allowed = new Set(
                nodes.map(node => node.id)
            );

            const visited = new Set();
            const components = [];

            for (const node of nodes) {
                if (visited.has(node.id)) {
                    continue;
                }

                const queue = [node.id];
                const component = [];
                visited.add(node.id);

                while (queue.length) {
                    const current = queue.shift();
                    component.push(current);

                    const currentNode =
                        this.graph.byId.get(current);

                    const links = [
                        ...currentNode.incoming,
                        ...currentNode.outgoing
                    ];

                    for (const link of links) {
                        if (
                            visibleOnly &&
                            !link.visible
                        ) {
                            continue;
                        }

                        const neighbor =
                            link.source === current
                                ? link.target
                                : link.source;

                        if (
                            allowed.has(neighbor) &&
                            !visited.has(neighbor)
                        ) {
                            visited.add(neighbor);
                            queue.push(neighbor);
                        }
                    }
                }

                components.push(
                    component.map(id =>
                        this.describeItem(
                            this.graph.byId.get(id)
                        )
                    )
                );
            }

            this.metrics.componentQueries += 1;

            return components.sort(
                (left, right) =>
                    right.length - left.length
            );
        }

        flowSummary(id) {
            const node = this.graph.byId.get(
                String(id)
            );

            if (!node) {
                return null;
            }

            const incoming = node.incoming.filter(
                link => link.visible
            );

            const outgoing = node.outgoing.filter(
                link => link.visible
            );

            this.metrics.flowQueries += 1;

            return {
                node: this.describeItem(node),
                incomingFlow: incoming.reduce(
                    (sum, link) =>
                        sum + link.value,
                    0
                ),
                outgoingFlow: outgoing.reduce(
                    (sum, link) =>
                        sum + link.value,
                    0
                ),
                netFlow:
                    outgoing.reduce(
                        (sum, link) =>
                            sum + link.value,
                        0
                    ) -
                    incoming.reduce(
                        (sum, link) =>
                            sum + link.value,
                        0
                    ),
                incoming:
                    incoming
                        .slice(0, DEFAULT_QUERY_LIMIT)
                        .map(link =>
                            this.describeItem(link)
                        ),
                outgoing:
                    outgoing
                        .slice(0, DEFAULT_QUERY_LIMIT)
                        .map(link =>
                            this.describeItem(link)
                        ),
                truncated:
                    incoming.length >
                        DEFAULT_QUERY_LIMIT ||
                    outgoing.length >
                        DEFAULT_QUERY_LIMIT
            };
        }

        append(data) {
            const combined = [
                ...this.graph.nodes.map(
                    (node) => node.raw
                ),
                ...normalizeRecords(data)
            ];

            this.setData(combined);

            this._emit("append", {
                added:
                    normalizeRecords(data).length
            });

            return this;
        }

        _applyFilters() {
            const query =
                this.query.toLowerCase();

            for (const node of this.graph.nodes) {
                node.visible =
                    (
                        !query ||
                        node.id
                            .toLowerCase()
                            .includes(query) ||
                        node.label
                            .toLowerCase()
                            .includes(query) ||
                        node.group
                            .toLowerCase()
                            .includes(query)
                    ) &&
                    (
                        !this.groupFilter ||
                        node.group ===
                        this.groupFilter
                    );
            }

            for (const link of this.graph.links) {
                link.visible = Boolean(
                    this.graph.byId.get(
                        link.source
                    )?.visible &&
                    this.graph.byId.get(
                        link.target
                    )?.visible
                );
            }

            this.visibleNodes =
                this.graph.nodes.filter(
                    node => node.visible
                );

            this.visibleLinks =
                this.graph.links.filter(
                    link => link.visible
                );

            this.metrics.visibleNodes =
                this.visibleNodes.length;

            this.metrics.visibleLinks =
                this.visibleLinks.length;
        }

        layout() {
            const nodes = this.visibleNodes;
            const links = this.visibleLinks;

            if (!nodes.length) {
                this.layers = [];
                return;
            }

            this._assignDepths(nodes, links);
            this._assignHeights(nodes, links);
            this._buildLayers(nodes);
            this._assignHorizontalPositions();
            this._assignValues(nodes);
            this._assignVerticalPositions();
            this._relaxLayout();
            this._assignLinkOffsets();

            this.metrics.layers =
                this.layers.length;
            this.metrics.layouts += 1;
        }

        _assignDepths(nodes, links) {
            const queue = nodes
                .filter((node) =>
                    !node.incoming.some(
                        (link) =>
                            link.visible &&
                            !link.cyclic
                    )
                );

            nodes.forEach((node) => {
                node.depth = 0;
            });

            const pending =
                queue.length
                    ? queue.slice()
                    : nodes.slice(0, 1);
            const visited = new Set();

            while (pending.length) {
                const node = pending.shift();

                if (!node || visited.has(node.id)) {
                    continue;
                }

                visited.add(node.id);

                for (const link of node.outgoing) {
                    if (!link.visible || link.cyclic) {
                        continue;
                    }

                    const target =
                        this.graph.byId.get(
                            link.target
                        );

                    if (!target || !target.visible) {
                        continue;
                    }

                    target.depth = Math.max(
                        target.depth,
                        node.depth + 1
                    );
                    pending.push(target);
                }
            }

            const maximum =
                Math.max(
                    ...nodes.map(
                        (node) => node.depth
                    ),
                    0
                );

            if (
                this.options.alignment === "right"
            ) {
                nodes.forEach((node) => {
                    node.depth =
                        maximum -
                        node.depth;
                });
            } else if (
                this.options.alignment === "center"
            ) {
                nodes.forEach((node) => {
                    const incomingDepth =
                        node.incoming
                            .filter(
                                (link) =>
                                    link.visible &&
                                    !link.cyclic
                            )
                            .reduce(
                                (total, link) =>
                                    total +
                                    (
                                        this.graph.byId.get(
                                            link.source
                                        )?.depth ||
                                        0
                                    ),
                                0
                            );
                    const incomingCount =
                        node.incoming.filter(
                            (link) =>
                                link.visible &&
                                !link.cyclic
                        ).length;

                    if (incomingCount) {
                        node.depth =
                            Math.round(
                                (
                                    node.depth +
                                    incomingDepth /
                                    incomingCount
                                ) /
                                2
                            );
                    }
                });
            } else if (
                this.options.alignment === "justify"
            ) {
                nodes.forEach((node) => {
                    const hasOutgoing =
                        node.outgoing.some(
                            (link) =>
                                link.visible &&
                                !link.cyclic
                        );

                    if (!hasOutgoing) {
                        node.depth = maximum;
                    }
                });
            }
        }

        _assignHeights(nodes) {
            nodes.forEach((node) => {
                node.height = 0;
            });

            const ordered =
                nodes
                    .slice()
                    .sort(
                        (left, right) =>
                            right.depth -
                            left.depth
                    );

            for (const node of ordered) {
                for (const link of node.outgoing) {
                    if (!link.visible || link.cyclic) {
                        continue;
                    }

                    const target =
                        this.graph.byId.get(
                            link.target
                        );

                    if (target) {
                        node.height = Math.max(
                            node.height,
                            target.height + 1
                        );
                    }
                }
            }
        }

        _buildLayers(nodes) {
            const maximumDepth =
                Math.max(
                    ...nodes.map(
                        (node) => node.depth
                    ),
                    0
                );

            this.layers =
                Array.from(
                    {
                        length:
                            maximumDepth + 1
                    },
                    () => []
                );

            for (const node of nodes) {
                this.layers[node.depth].push(node);
            }

            for (const layer of this.layers) {
                layer.sort((left, right) =>
                    left.group.localeCompare(
                        right.group
                    ) ||
                    left.label.localeCompare(
                        right.label
                    )
                );
            }
        }

        _assignHorizontalPositions() {
            const padding =
                this.options.padding;
            const width =
                Math.max(
                    1,
                    this.bounds.width -
                    padding * 2 -
                    this.options.nodeWidth
                );
            const denominator =
                Math.max(
                    1,
                    this.layers.length - 1
                );

            this.layers.forEach(
                (layer, depth) => {
                    const x0 =
                        padding +
                        depth /
                        denominator *
                        width;

                    for (const node of layer) {
                        node.x0 = x0;
                        node.x1 =
                            x0 +
                            this.options.nodeWidth;
                    }
                }
            );
        }

        _assignValues(nodes) {
            for (const node of nodes) {
                const incoming =
                    node.incoming
                        .filter(
                            (link) => link.visible
                        )
                        .reduce(
                            (total, link) =>
                                total + link.value,
                            0
                        );
                const outgoing =
                    node.outgoing
                        .filter(
                            (link) => link.visible
                        )
                        .reduce(
                            (total, link) =>
                                total + link.value,
                            0
                        );

                node.value = Math.max(
                    node.weight,
                    incoming,
                    outgoing,
                    0.000001
                );
            }
        }

        _assignVerticalPositions() {
            const padding =
                this.options.padding;
            const availableHeight =
                Math.max(
                    1,
                    this.bounds.height -
                    padding * 2
                );

            let scale = Infinity;

            for (const layer of this.layers) {
                if (!layer.length) {
                    continue;
                }

                const total =
                    layer.reduce(
                        (sum, node) =>
                            sum + node.value,
                        0
                    );
                const gaps =
                    Math.max(
                        0,
                        layer.length - 1
                    ) *
                    this.options.nodeGap;
                const candidate =
                    (
                        availableHeight -
                        gaps
                    ) /
                    Math.max(
                        total,
                        0.000001
                    );

                scale = Math.min(
                    scale,
                    candidate
                );
            }

            if (!Number.isFinite(scale) || scale <= 0) {
                scale = 1;
            }

            for (const layer of this.layers) {
                let y = padding;

                for (const node of layer) {
                    const height = Math.max(
                        2,
                        node.value * scale
                    );

                    node.y0 =
                        node.fixedY === null
                            ? y
                            : Math.max(
                                padding,
                                Math.min(
                                    this.bounds.height -
                                    padding -
                                    height,
                                    node.fixedY
                                )
                            );
                    node.y1 =
                        node.y0 + height;
                    y =
                        node.y1 +
                        this.options.nodeGap;
                }
            }

            for (const link of this.graph.links) {
                link.width =
                    Math.max(
                        1,
                        link.value * scale
                    );
            }
        }

        _relaxLayout() {
            const iterations =
                this.options.iterations;

            for (
                let iteration = 0;
                iteration < iterations;
                iteration += 1
            ) {
                this._relaxIteration(
                    iteration,
                    iterations
                );
            }
        }

        _resolveLayerCollisions(layer) {
            const padding =
                this.options.padding;
            const bottom =
                this.bounds.height -
                padding;

            layer.sort(
                (left, right) =>
                    left.y0 - right.y0
            );

            let y = padding;

            for (const node of layer) {
                if (node.y0 < y) {
                    const offset =
                        y - node.y0;

                    node.y0 += offset;
                    node.y1 += offset;
                }

                y =
                    node.y1 +
                    this.options.nodeGap;
            }

            if (layer.length) {
                const last =
                    layer[layer.length - 1];
                const overflow =
                    last.y1 - bottom;

                if (overflow > 0) {
                    last.y0 -= overflow;
                    last.y1 -= overflow;
                    y =
                        last.y0 -
                        this.options.nodeGap;

                    for (
                        let index =
                            layer.length - 2;
                        index >= 0;
                        index -= 1
                    ) {
                        const node =
                            layer[index];
                        const overlap =
                            node.y1 - y;

                        if (overlap > 0) {
                            node.y0 -= overlap;
                            node.y1 -= overlap;
                        }

                        y =
                            node.y0 -
                            this.options.nodeGap;
                    }
                }
            }
        }

        _assignLinkOffsets() {
            for (const node of this.graph.nodes) {
                let sourceOffset = 0;
                let targetOffset = 0;

                const outgoing =
                    node.outgoing
                        .filter(
                            (link) => link.visible
                        )
                        .sort((left, right) => {
                            const leftTarget =
                                this.graph.byId.get(
                                    left.target
                                );
                            const rightTarget =
                                this.graph.byId.get(
                                    right.target
                                );

                            return (
                                (leftTarget?.y0 || 0) -
                                (rightTarget?.y0 || 0)
                            );
                        });

                const incoming =
                    node.incoming
                        .filter(
                            (link) => link.visible
                        )
                        .sort((left, right) => {
                            const leftSource =
                                this.graph.byId.get(
                                    left.source
                                );
                            const rightSource =
                                this.graph.byId.get(
                                    right.source
                                );

                            return (
                                (leftSource?.y0 || 0) -
                                (rightSource?.y0 || 0)
                            );
                        });

                for (const link of outgoing) {
                    link.sy =
                        node.y0 +
                        sourceOffset +
                        link.width / 2;
                    sourceOffset += link.width;
                }

                for (const link of incoming) {
                    link.ty =
                        node.y0 +
                        targetOffset +
                        link.width / 2;
                    targetOffset += link.width;
                }
            }
        }

        _screenPoint(x, y) {
            const centerX =
                this.bounds.width / 2;
            const centerY =
                this.bounds.height / 2;

            return {
                x:
                    centerX +
                    (
                        x - centerX
                    ) *
                    this.transform.zoom +
                    this.transform.x,
                y:
                    centerY +
                    (
                        y - centerY
                    ) *
                    this.transform.zoom +
                    this.transform.y
            };
        }

        _inverseScreenPoint(x, y) {
            const centerX =
                this.bounds.width / 2;
            const centerY =
                this.bounds.height / 2;

            return {
                x:
                    centerX +
                    (
                        x -
                        centerX -
                        this.transform.x
                    ) /
                    this.transform.zoom,
                y:
                    centerY +
                    (
                        y -
                        centerY -
                        this.transform.y
                    ) /
                    this.transform.zoom
            };
        }

        draw() {
            if (this.destroyed) {
                return;
            }

            this.context.clearRect(
                0,
                0,
                this.bounds.width,
                this.bounds.height
            );
            this.context.fillStyle =
                this.options.background;
            this.context.fillRect(
                0,
                0,
                this.bounds.width,
                this.bounds.height
            );

            if (!this.metrics.visibleNodes) {
                this.context.fillStyle =
                    this.options.foreground;
                this.context.globalAlpha =
                    0.72;
                this.context.font =
                    '14px "IBM Plex Mono", monospace';
                this.context.textAlign =
                    "center";
                this.context.textBaseline =
                    "middle";
                this.context.fillText(
                    "No Sankey flow data.",
                    this.bounds.width / 2,
                    this.bounds.height / 2
                );
                this.context.globalAlpha = 1;
                this.metrics.draws += 1;
                return;
            }

            if (this.options.showLinks) {
                this._drawLinks();
            }

            this._drawNodes();

            if (this.options.showLabels) {
                this._drawLabels();
            }

            this.metrics.draws += 1;
        }

        _drawLinks() {
            this.context.save();
            this.context.lineCap = "butt";

            for (const link of this.graph.links) {
                if (
                    !link.visible ||
                    (
                        link.cyclic &&
                        !this.options.showCycles
                    )
                ) {
                    continue;
                }

                const source =
                    this.graph.byId.get(
                        link.source
                    );
                const target =
                    this.graph.byId.get(
                        link.target
                    );

                if (!source || !target) {
                    continue;
                }

                const start =
                    this._screenPoint(
                        source.x1,
                        link.sy
                    );
                const end =
                    this._screenPoint(
                        target.x0,
                        link.ty
                    );
                const emphasized =
                    link === this.hovered ||
                    link === this.selected ||
                    source === this.selected ||
                    target === this.selected;
                const width =
                    Math.max(
                        1,
                        link.width *
                        this.transform.zoom
                    );

                this.context.beginPath();

                if (link.cyclic) {
                    const loopHeight =
                        Math.max(
                            24,
                            Math.abs(
                                end.x -
                                start.x
                            ) *
                            0.22
                        );

                    this.context.moveTo(
                        start.x,
                        start.y
                    );
                    this.context.bezierCurveTo(
                        start.x +
                        loopHeight,
                        start.y -
                        loopHeight,
                        end.x -
                        loopHeight,
                        end.y -
                        loopHeight,
                        end.x,
                        end.y
                    );
                } else {
                    const controlX =
                        start.x +
                        (
                            end.x -
                            start.x
                        ) *
                        this.options.curvature;

                    this.context.moveTo(
                        start.x,
                        start.y
                    );
                    this.context.bezierCurveTo(
                        controlX,
                        start.y,
                        end.x -
                        (
                            end.x -
                            start.x
                        ) *
                        (
                            1 -
                            this.options.curvature
                        ),
                        end.y,
                        end.x,
                        end.y
                    );
                }

                this.context.strokeStyle =
                    emphasized
                        ? this.options.highlight
                        : this.options.showGroups
                            ? colorHash(
                                source.group
                            )
                            : this.options.linkColor;
                this.context.globalAlpha =
                    emphasized
                        ? 0.92
                        : this.options.linkOpacity;
                this.context.lineWidth =
                    emphasized
                        ? width + 1.5
                        : width;
                this.context.stroke();

                link.screenPath = {
                    start,
                    end,
                    width
                };
            }

            this.context.restore();
        }

        _drawNodes() {
            this.context.save();

            for (const node of this.graph.nodes) {
                if (!node.visible) {
                    continue;
                }

                const topLeft =
                    this._screenPoint(
                        node.x0,
                        node.y0
                    );
                const bottomRight =
                    this._screenPoint(
                        node.x1,
                        node.y1
                    );
                const width =
                    bottomRight.x -
                    topLeft.x;
                const height =
                    bottomRight.y -
                    topLeft.y;
                const emphasized =
                    node === this.hovered ||
                    node === this.selected;

                this.context.fillStyle =
                    emphasized
                        ? this.options.highlight
                        : this.options.showGroups
                            ? colorHash(
                                node.group
                            )
                            : this.options.foreground;
                this.context.globalAlpha =
                    emphasized ? 1 : 0.9;

                if (emphasized) {
                    this.context.shadowColor =
                        this.options.highlight;
                    this.context.shadowBlur = 12;
                } else {
                    this.context.shadowBlur = 0;
                }

                this.context.fillRect(
                    topLeft.x,
                    topLeft.y,
                    width,
                    height
                );

                this.context.strokeStyle =
                    this.options.background;
                this.context.globalAlpha =
                    0.82;
                this.context.lineWidth = 1;
                this.context.strokeRect(
                    topLeft.x,
                    topLeft.y,
                    width,
                    height
                );

                node.screenX0 = topLeft.x;
                node.screenY0 = topLeft.y;
                node.screenX1 = bottomRight.x;
                node.screenY1 = bottomRight.y;
            }

            this.context.restore();
        }

        _drawLabels() {
            const visible =
                this.graph.nodes
                    .filter(
                        (node) =>
                            node.visible
                    )
                    .sort(
                        (left, right) =>
                            right.value -
                            left.value
                    )
                    .slice(
                        0,
                        MAX_LABELS
                    );

            this.context.save();
            this.context.font =
                '11px "IBM Plex Mono", monospace';
            this.context.textBaseline =
                "middle";

            for (const node of visible) {
                const emphasized =
                    node === this.hovered ||
                    node === this.selected;
                const onRight =
                    node.depth <
                    this.layers.length - 1;
                const text =
                    this.options.showValues
                        ? `${node.label} (${Number(
                            node.value.toPrecision(5)
                        )})`
                        : node.label;
                const x =
                    onRight
                        ? node.screenX1 + 5
                        : node.screenX0 - 5;
                const y =
                    (
                        node.screenY0 +
                        node.screenY1
                    ) /
                    2;

                this.context.fillStyle =
                    emphasized
                        ? this.options.highlight
                        : this.options.foreground;
                this.context.globalAlpha =
                    emphasized ? 1 : 0.76;
                this.context.textAlign =
                    onRight
                        ? "left"
                        : "right";
                this.context.fillText(
                    text,
                    x,
                    y
                );
            }

            this.context.restore();
        }

        _pointFromEvent(event) {
            const rectangle =
                this.canvas.getBoundingClientRect();

            return {
                x:
                    event.clientX -
                    rectangle.left,
                y:
                    event.clientY -
                    rectangle.top
            };
        }

        _distanceToBezier(point, start, end) {
            const samples = 24;
            let minimum = Infinity;

            for (
                let index = 0;
                index <= samples;
                index += 1
            ) {
                const amount =
                    index / samples;
                const inverse =
                    1 - amount;
                const controlX1 =
                    start.x +
                    (
                        end.x -
                        start.x
                    ) *
                    this.options.curvature;
                const controlX2 =
                    end.x -
                    (
                        end.x -
                        start.x
                    ) *
                    (
                        1 -
                        this.options.curvature
                    );
                const x =
                    inverse *
                    inverse *
                    inverse *
                    start.x +
                    3 *
                    inverse *
                    inverse *
                    amount *
                    controlX1 +
                    3 *
                    inverse *
                    amount *
                    amount *
                    controlX2 +
                    amount *
                    amount *
                    amount *
                    end.x;
                const y =
                    inverse *
                    inverse *
                    inverse *
                    start.y +
                    3 *
                    inverse *
                    inverse *
                    amount *
                    start.y +
                    3 *
                    inverse *
                    amount *
                    amount *
                    end.y +
                    amount *
                    amount *
                    amount *
                    end.y;
                const distance =
                    Math.hypot(
                        point.x - x,
                        point.y - y
                    );

                minimum =
                    Math.min(
                        minimum,
                        distance
                    );
            }

            return minimum;
        }

        hitTest(x, y) {
            this.metrics.hitTests += 1;

            for (
                let index =
                    this.visibleNodes.length - 1;
                index >= 0;
                index -= 1
            ) {
                const node =
                    this.visibleNodes[index];

                if (!node.visible) {
                    continue;
                }

                if (
                    x >= node.screenX0 &&
                    x <= node.screenX1 &&
                    y >= node.screenY0 &&
                    y <= node.screenY1
                ) {
                    return node;
                }
            }

            const point = { x, y };

            for (
                let index =
                    this.visibleLinks.length - 1;
                index >= 0;
                index -= 1
            ) {
                const link =
                    this.visibleLinks[index];

                if (
                    !link.visible ||
                    !link.screenPath
                ) {
                    continue;
                }

                const distance =
                    this._distanceToBezier(
                        point,
                        link.screenPath.start,
                        link.screenPath.end
                    );

                if (
                    distance <=
                    Math.max(
                        5,
                        link.screenPath.width /
                        2 +
                        2
                    )
                ) {
                    return link;
                }
            }

            return null;
        }

        _handlePointerMove(event) {
            const point =
                this._pointFromEvent(event);

            if (this.drag?.node) {
                this.pointerMoved = true;
                const world =
                    this._inverseScreenPoint(
                        point.x,
                        point.y
                    );
                const node =
                    this.drag.node;
                const height =
                    node.y1 -
                    node.y0;

                node.fixedY =
                    Math.max(
                        this.options.padding,
                        Math.min(
                            this.bounds.height -
                            this.options.padding -
                            height,
                            world.y -
                            this.drag.offsetY
                        )
                    );

                this.layout();
                this.draw();
                return;
            }

            if (this.drag?.pan) {
                this.pointerMoved = true;
                this.transform.x =
                    this.drag.originX +
                    point.x -
                    this.drag.startX;
                this.transform.y =
                    this.drag.originY +
                    point.y -
                    this.drag.startY;
                this.metrics.pans += 1;
                this.draw();
                return;
            }

            const hovered =
                this.hitTest(
                    point.x,
                    point.y
                );
            const changed =
                hovered?.id !==
                this.hovered?.id;

            this.hovered = hovered;
            this.canvas.style.cursor =
                hovered
                    ? "pointer"
                    : this.options.pannable
                        ? "grab"
                        : "default";

            if (changed) {
                this.draw();

                this._emit("hover", {
                    item:
                        hovered
                            ? this.describeItem(
                                hovered
                            )
                            : null
                });
            }
        }

        _handlePointerLeave() {
            this.drag = null;

            if (this.hovered) {
                this.hovered = null;
                this.draw();
                this._emit("hover", {
                    item: null
                });
            }
        }

        _handlePointerDown(event) {
            if (event.button !== 0) {
                return;
            }

            this.pointerMoved = false;

            const point =
                this._pointFromEvent(event);
            const item =
                this.hitTest(
                    point.x,
                    point.y
                );

            if (
                item &&
                item.label &&
                this.options.draggable
            ) {
                const world =
                    this._inverseScreenPoint(
                        point.x,
                        point.y
                    );

                this.drag = {
                    node: item,
                    offsetY:
                        world.y -
                        item.y0
                };
            } else if (this.options.pannable) {
                this.drag = {
                    pan: true,
                    startX:
                        point.x,
                    startY:
                        point.y,
                    originX:
                        this.transform.x,
                    originY:
                        this.transform.y
                };
            }

            this.canvas.setPointerCapture?.(
                event.pointerId
            );
        }

        _handlePointerUp(event) {
            if (!this.drag) {
                return;
            }

            this.canvas.releasePointerCapture?.(
                event.pointerId
            );
            this.drag = null;
        }

        _handleWheel(event) {
            if (!this.options.zoomable) {
                return;
            }

            event.preventDefault();

            const point =
                this._pointFromEvent(event);
            const before =
                this._inverseScreenPoint(
                    point.x,
                    point.y
                );
            const factor =
                event.deltaY < 0
                    ? 1.12
                    : 1 / 1.12;
            const zoom =
                Math.max(
                    0.3,
                    Math.min(
                        10,
                        this.transform.zoom *
                        factor
                    )
                );
            const centerX =
                this.bounds.width / 2;
            const centerY =
                this.bounds.height / 2;

            this.transform.zoom = zoom;
            this.transform.x =
                point.x -
                centerX -
                (
                    before.x -
                    centerX
                ) *
                zoom;
            this.transform.y =
                point.y -
                centerY -
                (
                    before.y -
                    centerY
                ) *
                zoom;
            this.metrics.zooms += 1;
            this.draw();

            this._emit("zoom", {
                zoom,
                transform:
                    clone(this.transform)
            });
        }

        _handleClick(event) {
            if (
                this.drag ||
                this.pointerMoved
            ) {
                this.pointerMoved = false;
                return;
            }

            const point =
                this._pointFromEvent(event);
            const item =
                this.hitTest(
                    point.x,
                    point.y
                );

            this.selected =
                item?.id ===
                this.selected?.id
                    ? null
                    : item;
            this.metrics.selections += 1;
            this.draw();

            this._emit("select", {
                item:
                    this.selected
                        ? this.describeItem(
                            this.selected
                        )
                        : null
            });
        }

        _handleKeydown(event) {
            if (
                event.key === "+" ||
                event.key === "="
            ) {
                event.preventDefault();
                this.setZoom(
                    this.transform.zoom *
                    1.2
                );
            } else if (event.key === "-") {
                event.preventDefault();
                this.setZoom(
                    this.transform.zoom /
                    1.2
                );
            } else if (event.key === "0") {
                event.preventDefault();
                this.resetView();
            } else if (
                event.key === "Escape"
            ) {
                this.selected = null;
                this.draw();
            } else if (
                event.key === "ArrowLeft"
            ) {
                event.preventDefault();
                this.panBy(24, 0);
            } else if (
                event.key === "ArrowRight"
            ) {
                event.preventDefault();
                this.panBy(-24, 0);
            } else if (
                event.key === "ArrowUp"
            ) {
                event.preventDefault();
                this.panBy(0, 24);
            } else if (
                event.key === "ArrowDown"
            ) {
                event.preventDefault();
                this.panBy(0, -24);
            }
        }

        setZoom(value) {
            this.transform.zoom =
                Math.max(
                    0.3,
                    Math.min(
                        10,
                        parseNumber(
                            value,
                            this.transform.zoom
                        )
                    )
                );
            this.metrics.zooms += 1;
            this.draw();

            this._emit("zoom", {
                zoom: this.transform.zoom,
                transform: clone(this.transform)
            });

            return this.transform.zoom;
        }

        panBy(x, y) {
            this.transform.x +=
                Number(x) || 0;
            this.transform.y +=
                Number(y) || 0;
            this.metrics.pans += 1;
            this.draw();

            this._emit("pan", {
                transform: clone(this.transform)
            });

            return clone(
                this.transform
            );
        }

        resetView() {
            this.transform = {
                zoom: 1,
                x: 0,
                y: 0
            };
            this.selected = null;

            for (const node of this.graph.nodes) {
                node.fixedY = null;
            }

            this.layout();
            this.draw();

            this._emit("resetView", {
                transform: clone(this.transform)
            });

            return clone(
                this.transform
            );
        }

        setFilter(query = "") {
            this.query =
                String(query || "");
            this._applyFilters();
            this.layout();
            this.draw();

            this._emit("filter", {
                query:
                    this.query,
                visibleNodes:
                    this.metrics.visibleNodes,
                visibleLinks:
                    this.metrics.visibleLinks
            });

            return this.query;
        }

        setGroup(group = null) {
            this.groupFilter =
                group
                    ? String(group)
                    : null;
            this._applyFilters();
            this.layout();
            this.draw();

            return this.groupFilter;
        }

        describeItem(item) {
            if (!item) {
                return null;
            }

            if (
                item.source !== undefined &&
                item.target !== undefined
            ) {
                return {
                    kind:
                        "link",
                    id:
                        item.id,
                    source:
                        item.source,
                    sourceLabel:
                        this.graph.byId.get(
                            item.source
                        )?.label ||
                        item.source,
                    target:
                        item.target,
                    targetLabel:
                        this.graph.byId.get(
                            item.target
                        )?.label ||
                        item.target,
                    value:
                        item.value,
                    type:
                        item.type,
                    cyclic:
                        item.cyclic,
                    visible:
                        item.visible
                };
            }

            return {
                kind:
                    "node",
                id:
                    item.id,
                label:
                    item.label,
                group:
                    item.group,
                weight:
                    item.weight,
                value:
                    item.value,
                depth:
                    item.depth,
                height:
                    item.height,
                incoming:
                    item.incoming
                        .slice(0, 1000)
                        .map(link => link.id),
                incomingTruncated:
                    item.incoming.length > 1000,
                outgoing:
                    item.outgoing
                        .slice(0, 1000)
                        .map(link => link.id),
                outgoingTruncated:
                    item.outgoing.length > 1000,
                visible:
                    item.visible,
                raw:
                    clone(item.raw)
            };
        }

        update(options = {}) {
            if (!isObject(options)) {
                throw new TypeError(
                    "Sankey options must be an object."
                );
            }

            const rebuildRequired = [
                "groupKey",
                "inferHierarchy",
                "linkKeys",
                "maxNodes",
                "maxLinks"
            ].some(
                (key) =>
                    options[key] !== undefined
            );

            Object.assign(
                this.options,
                {
                    background:
                        options.background ||
                        this.options.background,
                    foreground:
                        options.foreground ||
                        this.options.foreground,
                    highlight:
                        options.highlight ||
                        this.options.highlight,
                    linkColor:
                        options.linkColor ||
                        this.options.linkColor,
                    nodeWidth:
                        options.nodeWidth !== undefined
                            ? parseNumber(
                                options.nodeWidth,
                                this.options.nodeWidth,
                                4,
                                80
                            )
                            : this.options.nodeWidth,
                    nodeGap:
                        options.nodeGap !== undefined
                            ? parseNumber(
                                options.nodeGap,
                                this.options.nodeGap,
                                0,
                                200
                            )
                            : this.options.nodeGap,
                    padding:
                        options.padding !== undefined
                            ? parseNumber(
                                options.padding,
                                this.options.padding,
                                0,
                                240
                            )
                            : this.options.padding,
                    curvature:
                        options.curvature !== undefined
                            ? parseNumber(
                                options.curvature,
                                this.options.curvature,
                                0,
                                1
                            )
                            : this.options.curvature,
                    alignment:
                        [
                            "justify",
                            "left",
                            "right",
                            "center"
                        ].includes(options.alignment)
                            ? options.alignment
                            : this.options.alignment,
                    iterations:
                        options.iterations !== undefined
                            ? parseNumber(
                                options.iterations,
                                this.options.iterations,
                                1,
                                200
                            )
                            : this.options.iterations,
                    showLabels:
                        options.showLabels !== undefined
                            ? parseBoolean(
                                options.showLabels,
                                this.options.showLabels
                            )
                            : this.options.showLabels,
                    showValues:
                        options.showValues !== undefined
                            ? parseBoolean(
                                options.showValues,
                                this.options.showValues
                            )
                            : this.options.showValues,
                    showLinks:
                        options.showLinks !== undefined
                            ? parseBoolean(
                                options.showLinks,
                                this.options.showLinks
                            )
                            : this.options.showLinks,
                    showGroups:
                        options.showGroups !== undefined
                            ? parseBoolean(
                                options.showGroups,
                                this.options.showGroups
                            )
                            : this.options.showGroups,
                    showCycles:
                        options.showCycles !== undefined
                            ? parseBoolean(
                                options.showCycles,
                                this.options.showCycles
                            )
                            : this.options.showCycles,
                    linkOpacity:
                        options.linkOpacity !== undefined
                            ? parseNumber(
                                options.linkOpacity,
                                this.options.linkOpacity,
                                0,
                                1
                            )
                            : this.options.linkOpacity,
                    groupKey:
                        options.groupKey !== undefined
                            ? options.groupKey
                            : this.options.groupKey,
                    inferHierarchy:
                        options.inferHierarchy !== undefined
                            ? parseBoolean(
                                options.inferHierarchy,
                                this.options.inferHierarchy
                            )
                            : this.options.inferHierarchy,
                    maxNodes:
                        options.maxNodes !== undefined
                            ? parseNumber(
                                options.maxNodes,
                                this.options.maxNodes,
                                1,
                                100000
                            )
                            : this.options.maxNodes,
                    maxLinks:
                        options.maxLinks !== undefined
                            ? parseNumber(
                                options.maxLinks,
                                this.options.maxLinks,
                                0,
                                1000000
                            )
                            : this.options.maxLinks
                }
            );

            if (rebuildRequired) {
                this.setData(
                    this.graph.nodes.map(
                        (node) => node.raw
                    )
                );
            } else {
                this.layout();
                this.draw();
            }

            this._emit("update", {
                options:
                    clone(this.options)
            });

            return this;
        }

        export(format = "json") {
            const normalized =
                String(format).toLowerCase();

            if (normalized === "png") {
                return this.canvas.toDataURL(
                    "image/png"
                );
            }

            if (normalized === "json") {
                return JSON.stringify(
                    {
                        generatedAt:
                            iso(),
                        options:
                            this.options,
                        transform:
                            this.transform,
                        nodes:
                            this.graph.nodes.map(
                                (node) =>
                                    this.describeItem(
                                        node
                                    )
                            ),
                        links:
                            this.graph.links.map(
                                (link) =>
                                    this.describeItem(
                                        link
                                    )
                            )
                    },
                    null,
                    2
                );
            }

            if (normalized === "csv") {
                const rows = [[
                    "source",
                    "sourceLabel",
                    "target",
                    "targetLabel",
                    "value",
                    "type",
                    "cyclic",
                    "visible"
                ]];

                for (const link of this.graph.links) {
                    rows.push([
                        link.source,
                        this.graph.byId.get(
                            link.source
                        )?.label ||
                        link.source,
                        link.target,
                        this.graph.byId.get(
                            link.target
                        )?.label ||
                        link.target,
                        link.value,
                        link.type,
                        link.cyclic,
                        link.visible
                    ]);
                }

                return rows
                    .map(
                        (row) =>
                            row
                                .map((value) => {
                                    let output =
                                        String(value ?? "");

                                    if (/^[=+\-@\t\r]/.test(output)) {
                                        output = `'${output}`;
                                    }

                                    return /[",\n\r]/.test(output)
                                        ? `"${output.replace(
                                            /"/g,
                                            '""'
                                        )}"`
                                        : output;
                                })
                                .join(",")
                    )
                    .join("\r\n");
            }

            throw new Error(
                `Unsupported Sankey export format: ${format}`
            );
        }

        status() {
            return {
                name:
                    "sankey",
                module:
                    MODULE_NAME,
                nodes:
                    this.graph.nodes.length,
                visibleNodes:
                    this.metrics.visibleNodes,
                links:
                    this.graph.links.length,
                visibleLinks:
                    this.metrics.visibleLinks,
                layers:
                    this.layers.length,
                cycles:
                    this.metrics.cycles,
                totalFlow:
                    this.metrics.totalFlow,
                query:
                    this.query,
                groupFilter:
                    this.groupFilter,
                transform:
                    clone(this.transform),
                selected:
                    this.selected
                        ? this.describeItem(
                            this.selected
                        )
                        : null,
                hovered:
                    this.hovered
                        ? this.describeItem(
                            this.hovered
                        )
                        : null,
                options:
                    clone(this.options),
                metrics:
                    { ...this.metrics },
                lastError:
                    this.lastError
                        ? {
                            name:
                                this.lastError.name,
                            message:
                                this.lastError.message
                        }
                        : null,
                destroyed:
                    this.destroyed
            };
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            this._cleanupResize?.();
            this.abortController.abort();

            this.drag = null;
            this.hovered = null;
            this.selected = null;

            this._emit("destroy", {});

            if (this.canvas[CONTROLLER_SYMBOL] === this) {
                delete this.canvas[CONTROLLER_SYMBOL];
            }

            if (this.canvas.sankeyController === this) {
                delete this.canvas.sankeyController;
            }

            this.graph = {
                nodes: [],
                links: [],
                byId: new Map()
            };

            this.visibleNodes = [];
            this.visibleLinks = [];
            this.layers = [];
            this.destroyed = true;

            return true;
        }

    }

    function mount(
        target,
        data = [],
        options = {}
    ) {
        const canvas = resolveCanvas(target);

        const existing =
            canvas[CONTROLLER_SYMBOL] ||
            canvas.sankeyController;

        if (
            existing instanceof SankeyController &&
            !existing.destroyed
        ) {
            existing.update(options);
            existing.setData(data);
            return existing;
        }

        return new SankeyController(
            canvas,
            data,
            options
        );
    }

    function render(data = [], options = {}) {
        const container = createElement(
            "section",
            "terminal-visualization terminal-visualization-sankey"
        );
        container.dataset.visualization =
            "sankey";
        container.setAttribute(
            "role",
            "region"
        );
        container.setAttribute(
            "aria-label",
            options.label ||
            "Sankey visualization"
        );

        const canvas =
            document.createElement("canvas");
        canvas.className =
            "terminal-sankey-canvas";
        canvas.width =
            Number(options.width) ||
            DEFAULT_WIDTH;
        canvas.height =
            Number(options.height) ||
            DEFAULT_HEIGHT;
        canvas.setAttribute(
            "aria-label",
            options.label ||
            "Sankey visualization"
        );

        const status = createElement(
            "div",
            "terminal-sankey-status"
        );
        status.setAttribute(
            "aria-live",
            "polite"
        );

        const tooltip = createElement(
            "div",
            "terminal-sankey-tooltip"
        );
        tooltip.hidden = true;

        container.append(
            canvas,
            status,
            tooltip
        );

        const controller =
            mount(
                canvas,
                data,
                options
            );

        const updateStatus = () => {
            const snapshot =
                controller.status();

            status.textContent =
                `${snapshot.visibleNodes} of ${snapshot.nodes} node` +
                `${snapshot.nodes === 1 ? "" : "s"} · ` +
                `${snapshot.visibleLinks} flow` +
                `${snapshot.visibleLinks === 1 ? "" : "s"} · ` +
                `${snapshot.layers} layer` +
                `${snapshot.layers === 1 ? "" : "s"} · ` +
                `${snapshot.totalFlow} total`;
        };

        controller.addEventListener(
            "hover",
            (event) => {
                const item =
                    event.detail?.item;

                if (!item) {
                    tooltip.hidden = true;
                    return;
                }

                tooltip.hidden = false;
                tooltip.textContent =
                    item.kind === "link"
                        ? (
                            `${item.sourceLabel} → ${item.targetLabel} · ` +
                            `${item.value} · ${item.type}`
                        )
                        : (
                            `${item.label} · ${item.group} · ` +
                            `${item.value}`
                        );
            }
        );

        for (const eventName of [
            "data",
            "append",
            "resize",
            "zoom",
            "filter",
            "select",
            "update"
        ]) {
            controller.addEventListener(
                eventName,
                updateStatus
            );
        }

        updateStatus();

        container.controller = controller;
        container.canvas = canvas;
        container.data = controller.graph;
        container[CONTROLLER_SYMBOL] = controller;
        container.sankeyController = controller;

        container.update = (
            nextData = data,
            nextOptions = {}
        ) => {
            controller.update(nextOptions);
            controller.setData(nextData);
            container.data = controller.graph;
            return container;
        };

        container.status = () => controller.status();

        container.destroy = () => {
            const destroyed = controller.destroy();
            delete container[CONTROLLER_SYMBOL];
            return destroyed;
        };

        return container;
    }

    function initialize(context = {}) {
        const root = context.root || document;

        const existing =
            context.sankey ||
            root?.[VISUALIZATION_SYMBOL];

        if (
            existing &&
            existing.Controller === SankeyController
        ) {
            context.sankey = existing;

            context.registerVisualization?.(
                "sankey",
                existing
            );

            context.registerRenderer?.(
                "sankey",
                existing
            );

            return existing;
        }

        const dataset =
            context.root?.dataset || {};

        const config =
            context.config?.sankey || {};

        const defaults = {
            context,
            background:
                dataset.terminalSankeyBackground ||
                config.background ||
                DEFAULT_BACKGROUND,

            foreground:
                dataset.terminalSankeyForeground ||
                config.foreground ||
                DEFAULT_FOREGROUND,

            highlight:
                dataset.terminalSankeyHighlight ||
                config.highlight ||
                DEFAULT_HIGHLIGHT,

            linkColor:
                dataset.terminalSankeyLinkColor ||
                config.linkColor ||
                DEFAULT_LINK,

            nodeWidth:
                dataset.terminalSankeyNodeWidth ||
                config.nodeWidth ||
                DEFAULT_NODE_WIDTH,

            nodeGap:
                dataset.terminalSankeyNodeGap ||
                config.nodeGap ||
                DEFAULT_NODE_GAP,

            alignment:
                dataset.terminalSankeyAlignment ||
                config.alignment ||
                "justify",

            curvature:
                dataset.terminalSankeyCurvature ||
                config.curvature ||
                DEFAULT_CURVATURE,

            groupKey:
                dataset.terminalSankeyGroupKey ||
                config.groupKey ||
                null,

            showLabels: parseBoolean(
                dataset.terminalSankeyShowLabels,
                config.showLabels !== false
            ),

            showValues: parseBoolean(
                dataset.terminalSankeyShowValues,
                config.showValues === true
            ),

            showGroups: parseBoolean(
                dataset.terminalSankeyShowGroups,
                config.showGroups !== false
            ),

            showCycles: parseBoolean(
                dataset.terminalSankeyShowCycles,
                config.showCycles !== false
            ),

            inferHierarchy: parseBoolean(
                dataset.terminalSankeyInferHierarchy,
                config.inferHierarchy !== false
            ),

            interactive: parseBoolean(
                dataset.terminalSankeyInteractive,
                config.interactive !== false
            )
        };

        const controllers = new Set();

        const visualization = {
            version: VERSION,

            mount(target, data = [], options = {}) {
                const controller = mount(
                    target,
                    data,
                    {
                        ...defaults,
                        ...options,
                        context
                    }
                );

                controllers.add(controller);
                context.sankeyController = controller;

                controller.addEventListener(
                    "destroy",
                    () => {
                        controllers.delete(controller);

                        if (
                            context.sankeyController ===
                            controller
                        ) {
                            delete context.sankeyController;
                        }
                    },
                    { once: true }
                );

                return controller;
            },

            render(data = [], options = {}) {
                const element = render(
                    data,
                    {
                        ...defaults,
                        ...options,
                        context
                    }
                );

                if (element.controller) {
                    controllers.add(element.controller);
                    context.sankeyController =
                        element.controller;

                    element.controller.addEventListener(
                        "destroy",
                        () => {
                            controllers.delete(
                                element.controller
                            );

                            if (
                                context.sankeyController ===
                                element.controller
                            ) {
                                delete context.sankeyController;
                            }
                        },
                        { once: true }
                    );
                }

                return element;
            },

            activeController() {
                return (
                    context.sankeyController ||
                    context.terminalSankeyController ||
                    Array.from(controllers).at(-1) ||
                    null
                );
            },

            status() {
                return {
                    version: VERSION,
                    controllers: controllers.size,
                    active:
                        this.activeController?.()?.status?.() ||
                        null
                };
            },

            destroy() {
                for (
                    const controller of
                    Array.from(controllers)
                ) {
                    controller.destroy();
                }

                controllers.clear();

                if (
                    root[VISUALIZATION_SYMBOL] ===
                    visualization
                ) {
                    delete root[VISUALIZATION_SYMBOL];
                }

                if (context.sankey === visualization) {
                    delete context.sankey;
                }

                if (context.sankeyController) {
                    delete context.sankeyController;
                }

                return true;
            },

            Controller: SankeyController,
            normalizeGraph,
            normalizeRecords,
            detectCycles,
            extractReferences
        };

        root[VISUALIZATION_SYMBOL] = visualization;

        context.registerVisualization?.(
            "sankey",
            visualization
        );

        context.registerRenderer?.(
            "sankey",
            visualization
        );

        context.sankey = visualization;

        safeDispatch(
            document,
            "speciedex:terminal-sankey-ready",
            {
                visualization,
                version: VERSION
            }
        );

        return visualization;
    }

    const commands = [{
        name: "sankey",
        category: "visualization",
        description:
            "Render and control an interactive weighted Sankey flow diagram.",
        usage:
            "sankey [collection|status|filter|group|alignment|zoom|pan|" +
            "fit|focus|select|path|upstream|downstream|components|flow|" +
            "links|labels|values|groups|cycles|curvature|iterations|" +
            "reset|export] [arguments]",
        handler:
            async ({
                args = [],
                context,
                writeJSON,
                write,
                writeError
            }) => {
            const action =
                String(
                    args[0] ||
                    "records"
                );
            const lower =
                action.toLowerCase();
            const visualization =
                context.sankey ||
                initialize(context);

            const controller =
                context.sankeyController ||
                context.terminalSankeyController ||
                visualization.activeController?.();

            const outputJSON = value =>
                typeof writeJSON === "function"
                    ? writeJSON(value)
                    : value;

            const outputText = (
                value,
                type = "data"
            ) =>
                typeof write === "function"
                    ? write(value, type)
                    : value;

            try {
                if (controller) {
                    switch (lower) {
                        case "status":
                        case "show":
                        case "info":
                            return outputJSON(
                                controller.status()
                            );

                        case "filter":
                            return outputJSON({
                                query:
                                    controller.setFilter(
                                        args.slice(1).join(" ")
                                    ),
                                status:
                                    controller.status()
                            });

                        case "group":
                            return outputJSON({
                                group:
                                    controller.setGroup(
                                        args.slice(1).join(" ") ||
                                        null
                                    ),
                                status:
                                    controller.status()
                            });

                        case "alignment":
                            if (!args[1]) {
                                return outputJSON({
                                    alignment:
                                        controller.options.alignment
                                });
                            }

                            controller.update({
                                alignment:
                                    args[1]
                            });

                            return outputJSON({
                                alignment:
                                    controller.options.alignment
                            });

                        case "zoom":
                            if (
                                args[1] ===
                                undefined
                            ) {
                                return outputJSON({
                                    zoom:
                                        controller.transform.zoom
                                });
                            }

                            return outputJSON({
                                zoom:
                                    controller.setZoom(
                                        args[1]
                                    )
                            });

                        case "pan":
                            return outputJSON({
                                transform:
                                    controller.panBy(
                                        args[1],
                                        args[2]
                                    )
                            });

                        case "fit":
                            return outputJSON({
                                transform:
                                    controller.fitView({
                                        padding: args[1]
                                    })
                            });

                        case "focus":
                        case "select":
                            if (!args[1]) {
                                throw new Error(
                                    "A node ID is required."
                                );
                            }

                            return outputJSON({
                                node:
                                    controller.focusNode(
                                        args[1],
                                        {
                                            zoom: args[2]
                                        }
                                    )
                            });

                        case "path":
                            if (
                                !args[1] ||
                                !args[2]
                            ) {
                                throw new Error(
                                    "Path requires source and target node IDs."
                                );
                            }

                            return outputJSON({
                                path:
                                    controller.shortestPath(
                                        args[1],
                                        args[2],
                                        {
                                            directed:
                                                args[3] !== "undirected",
                                            weighted:
                                                args[4] === "weighted"
                                        }
                                    )
                            });

                        case "upstream":
                            if (!args[1]) {
                                throw new Error(
                                    "A node ID is required."
                                );
                            }

                            return outputJSON({
                                node: args[1],
                                upstream:
                                    controller.traverse(
                                        args[1],
                                        "upstream",
                                        args[2],
                                        args[3]
                                    )
                            });

                        case "downstream":
                            if (!args[1]) {
                                throw new Error(
                                    "A node ID is required."
                                );
                            }

                            return outputJSON({
                                node: args[1],
                                downstream:
                                    controller.traverse(
                                        args[1],
                                        "downstream",
                                        args[2],
                                        args[3]
                                    )
                            });

                        case "components":
                            return outputJSON({
                                components:
                                    controller.connectedComponents({
                                        visibleOnly:
                                            args[1] !== "all"
                                    })
                            });

                        case "flow":
                            if (!args[1]) {
                                throw new Error(
                                    "A node ID is required."
                                );
                            }

                            return outputJSON(
                                controller.flowSummary(
                                    args[1]
                                )
                            );

                        case "links":
                            controller.update({
                                showLinks:
                                    args[1] === undefined
                                        ? !controller.options.showLinks
                                        : parseBoolean(
                                            args[1],
                                            controller.options.showLinks
                                        )
                            });

                            return outputJSON({
                                showLinks:
                                    controller.options.showLinks
                            });

                        case "labels":
                            controller.update({
                                showLabels:
                                    args[1] === undefined
                                        ? !controller.options.showLabels
                                        : parseBoolean(
                                            args[1],
                                            controller.options.showLabels
                                        )
                            });

                            return outputJSON({
                                showLabels:
                                    controller.options.showLabels
                            });

                        case "values":
                            controller.update({
                                showValues:
                                    args[1] === undefined
                                        ? !controller.options.showValues
                                        : parseBoolean(
                                            args[1],
                                            controller.options.showValues
                                        )
                            });

                            return outputJSON({
                                showValues:
                                    controller.options.showValues
                            });

                        case "groups":
                            controller.update({
                                showGroups:
                                    args[1] === undefined
                                        ? !controller.options.showGroups
                                        : parseBoolean(
                                            args[1],
                                            controller.options.showGroups
                                        )
                            });

                            return outputJSON({
                                showGroups:
                                    controller.options.showGroups
                            });

                        case "cycles":
                            controller.update({
                                showCycles:
                                    args[1] === undefined
                                        ? !controller.options.showCycles
                                        : parseBoolean(
                                            args[1],
                                            controller.options.showCycles
                                        )
                            });

                            return outputJSON({
                                showCycles:
                                    controller.options.showCycles
                            });

                        case "curvature":
                            if (args[1] === undefined) {
                                return outputJSON({
                                    curvature:
                                        controller.options.curvature
                                });
                            }

                            controller.update({
                                curvature: args[1]
                            });

                            return outputJSON({
                                curvature:
                                    controller.options.curvature
                            });

                        case "iterations":
                            if (args[1] === undefined) {
                                return outputJSON({
                                    iterations:
                                        controller.options.iterations
                                });
                            }

                            controller.update({
                                iterations: args[1]
                            });

                            return outputJSON({
                                iterations:
                                    controller.options.iterations
                            });

                        case "reset":
                            return outputJSON({
                                transform:
                                    controller.resetView()
                            });

                        case "export":
                            return outputText(
                                controller.export(
                                    args[1] ||
                                    "json"
                                ),
                                "data"
                            );

                        default:
                            break;
                    }
                }

                const collection = action;

                const libraryValue =
                    context.library?.get?.(collection);

                const resolvedLibrary =
                    libraryValue &&
                    typeof libraryValue.then === "function"
                        ? await libraryValue
                        : libraryValue;

                const stateValue =
                    context.state?.get?.(
                        `library.${collection}`,
                        []
                    );

                const resolvedState =
                    stateValue &&
                    typeof stateValue.then === "function"
                        ? await stateValue
                        : stateValue;

                const data =
                    resolvedLibrary !== undefined &&
                    resolvedLibrary !== null
                        ? resolvedLibrary
                        : resolvedState ?? [];

                return visualization.render(
                    data,
                    {
                        ...context.config?.sankey,
                        label:
                            `Sankey for ${collection}`
                    }
                );
            } catch (error) {
                if (
                    typeof writeError ===
                    "function"
                ) {
                    writeError(
                        error.message
                    );
                    return null;
                }

                throw error;
            }
        }
    }];

    const api = Object.freeze({
        name: MODULE_NAME,
        version: VERSION,
        VISUALIZATION_SYMBOL,
        CONTROLLER_SYMBOL,
        SankeyController,
        normalizeGraph,
        normalizeRecords,
        detectCycles,
        extractReferences,
        createAbortError,
        mount,
        render,
        initialize,
        init: initialize,
        setup: initialize,
        unmount(context = {}) {
            const visualization =
                context.sankey;

            if (
                visualization &&
                typeof visualization.destroy === "function"
            ) {
                return visualization.destroy();
            }

            return false;
        },
        commands
    });

    window.SpeciedexTerminalSankey =
        api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules || {};

    window.SpeciedexTerminalModules[
        MODULE_NAME
    ] = api;

    document.dispatchEvent(
        new CustomEvent(
            "speciedex:terminal-module-available",
            {
                detail: {
                    name: MODULE_NAME,
                    module: api
                }
            }
        )
    );
})(window, document);
