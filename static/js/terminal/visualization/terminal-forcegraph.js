/*
========================================================================
Speciedex.org
Terminal ForceGraph Visualization
========================================================================

Interactive force-directed graph renderer for Speciedex records. Supports
explicit graph payloads, taxonomic inference, weighted nodes and links,
clustering, deterministic layout, dragging, zoom, pan, selection, filtering,
runtime updates, exports, responsive rendering, metrics, and lifecycle control.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "forcegraph";
    const VERSION = "3.0.0";

    const VISUALIZATION_SYMBOL =
        Symbol.for(
            "speciedex.terminal.forcegraph.visualization"
        );

    const CONTROLLER_SYMBOL =
        Symbol.for(
            "speciedex.terminal.forcegraph.controller"
        );
    const DEFAULT_WIDTH = 960;
    const DEFAULT_HEIGHT = 540;
    const DEFAULT_BACKGROUND = "#020a05";
    const DEFAULT_FOREGROUND = "#c0d674";
    const DEFAULT_HIGHLIGHT = "#eef7c8";
    const DEFAULT_EDGE = "#35503a";
    const DEFAULT_NODE_RADIUS = 5;
    const DEFAULT_CHARGE = 145;
    const DEFAULT_LINK_DISTANCE = 78;
    const DEFAULT_LINK_STRENGTH = 0.085;
    const DEFAULT_CENTERING = 0.014;
    const DEFAULT_DAMPING = 0.87;
    const DEFAULT_ALPHA_DECAY = 0.02;
    const DEFAULT_MIN_ALPHA = 0.002;
    const DEFAULT_MAX_NODES = 2500;
    const DEFAULT_MAX_EDGES = 15000;
    const MAX_LABELS = 180;
    const DEFAULT_ASYNC_BATCH = 24;
    const DEFAULT_FIT_PADDING = 36;

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
        message = "ForceGraph operation aborted."
    ) {
        const error = new Error(message);
        error.name = "AbortError";
        error.code = "FORCEGRAPH_ABORTED";
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
        seen =
            new WeakMap(),
        depth =
            0
    ) {
        if (
            value ===
                null ||
            value ===
                undefined ||
            typeof value !==
                "object"
        ) {
            return value;
        }

        if (
            depth >
            40
        ) {
            return "[Truncated]";
        }

        if (
            typeof structuredClone ===
                "function"
        ) {
            try {
                return structuredClone(
                    value
                );
            } catch (_error) {
                /* Continue with deterministic fallback. */
            }
        }

        if (
            seen.has(
                value
            )
        ) {
            return "[Circular]";
        }

        seen.set(
            value,
            true
        );

        if (
            value instanceof
                Date
        ) {
            return Number.isNaN(
                value.getTime()
            )
                ? "Invalid Date"
                : value.toISOString();
        }

        if (
            value instanceof
                Error
        ) {
            return {
                name:
                    value.name,
                message:
                    value.message,
                stack:
                    value.stack ||
                    ""
            };
        }

        if (
            Array.isArray(
                value
            )
        ) {
            return value.map(
                item =>
                    clone(
                        item,
                        seen,
                        depth +
                            1
                    )
            );
        }

        if (
            value instanceof
                Map
        ) {
            const output =
                {};

            for (
                const [
                    key,
                    item
                ] of value
            ) {
                output[
                    String(
                        key
                    )
                ] =
                    clone(
                        item,
                        seen,
                        depth +
                            1
                    );
            }

            return output;
        }

        if (
            value instanceof
                Set
        ) {
            return [
                ...value
            ].map(
                item =>
                    clone(
                        item,
                        seen,
                        depth +
                            1
                    )
            );
        }

        const output =
            {};

        for (
            const [
                key,
                item
            ] of Object.entries(
                value
            )
        ) {
            if (
                [
                    "__proto__",
                    "prototype",
                    "constructor"
                ].includes(
                    key
                )
            ) {
                continue;
            }

            output[
                key
            ] =
                clone(
                    item,
                    seen,
                    depth +
                        1
                );
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
            /* Graph events must not interrupt rendering. */
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
            const existing = target.querySelector("canvas");

            if (existing) {
                return existing;
            }

            const canvas = document.createElement("canvas");
            target.appendChild(canvas);
            return canvas;
        }

        throw new TypeError("ForceGraph requires a canvas or container element.");
    }

    function createResizeObserver(
        element,
        callback
    ) {
        let frame =
            0;

        let lastWidth =
            -1;

        let lastHeight =
            -1;

        const schedule =
            () => {
                if (
                    frame
                ) {
                    return;
                }

                frame =
                    window.requestAnimationFrame(
                        () => {
                            frame =
                                0;

                            const rectangle =
                                element.getBoundingClientRect();

                            const width =
                                Math.round(
                                    rectangle.width *
                                    100
                                ) /
                                100;

                            const height =
                                Math.round(
                                    rectangle.height *
                                    100
                                ) /
                                100;

                            if (
                                width ===
                                    lastWidth &&
                                height ===
                                    lastHeight
                            ) {
                                return;
                            }

                            lastWidth =
                                width;

                            lastHeight =
                                height;

                            callback();
                        }
                    );
            };

        if (
            typeof ResizeObserver ===
                "function"
        ) {
            const observer =
                new ResizeObserver(
                    schedule
                );

            observer.observe(
                element
            );

            return () => {
                observer.disconnect();

                if (
                    frame
                ) {
                    window.cancelAnimationFrame(
                        frame
                    );

                    frame =
                        0;
                }
            };
        }

        window.addEventListener(
            "resize",
            schedule
        );

        return () => {
            window.removeEventListener(
                "resize",
                schedule
            );

            if (
                frame
            ) {
                window.cancelAnimationFrame(
                    frame
                );
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
            for (const key of ["records", "results", "items", "data", "nodes"]) {
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

    function seededRandom(seed) {
        let value = 2166136261;

        for (const character of String(seed || "speciedex-forcegraph")) {
            value ^= character.charCodeAt(0);
            value = Math.imul(value, 16777619);
        }

        return function random() {
            value += 0x6D2B79F5;
            let result = value;
            result = Math.imul(result ^ (result >>> 15), result | 1);
            result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
            return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
        };
    }

    function nodeId(record, index) {
        if (!isObject(record)) {
            return `node-${index + 1}`;
        }

        return String(firstValue(record, [
            "speciedex_id",
            "speciedexId",
            "canonical_id",
            "canonicalId",
            "taxon_id",
            "taxonId",
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
            "taxon_rank",
            "taxonRank",
            "provider",
            "source"
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
                return Math.max(0.01, value);
            }
        }

        return 1;
    }

    function colorHash(value) {
        let hash = 0;

        for (const character of String(value || "")) {
            hash = ((hash << 5) - hash) + character.charCodeAt(0);
            hash |= 0;
        }

        return `hsl(${Math.abs(hash) % 360} 55% 60%)`;
    }

    function extractExplicitEdges(data) {
        if (!isObject(data)) {
            return [];
        }

        for (const key of ["edges", "links", "relationships"]) {
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

        const keys = Array.isArray(options.edgeKeys) && options.edgeKeys.length
            ? options.edgeKeys
            : [
                "parent_id",
                "parentId",
                "accepted_id",
                "acceptedId",
                "synonym_of",
                "synonymOf",
                "related_ids",
                "relatedIds",
                "children",
                "parents",
                "links",
                "edges",
                "relationships"
            ];
        const references = [];

        for (const key of keys) {
            const value = record[key];

            if (value === undefined || value === null) {
                continue;
            }

            const append = (item) => {
                if (isObject(item)) {
                    const target = firstValue(item, [
                        "target",
                        "targetId",
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
                            ], key)),
                            weight: parseNumber(item.weight, 1, 0.01, 1000000),
                            directed: item.directed !== false
                        });
                    }
                } else if (item !== "") {
                    references.push({
                        target: String(item),
                        type: key,
                        weight: 1,
                        directed: true
                    });
                }
            };

            if (Array.isArray(value)) {
                value.forEach(append);
            } else {
                append(value);
            }
        }

        return references;
    }

    function normalizeGraph(data, options = {}) {
        const records = normalizeRecords(data).slice(
            0,
            parseNumber(options.maxNodes, DEFAULT_MAX_NODES, 1, 100000)
        );
        const random = seededRandom(options.seed || "speciedex-forcegraph");
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
                degree: 0,
                radius: 0,
                x: random(),
                y: random(),
                vx: 0,
                vy: 0,
                fx: null,
                fy: null,
                visible: true,
                raw: clone(record)
            };

            nodes.push(node);
            byId.set(id, node);
        });

        const edges = [];
        const edgeKeys = new Set();
        const maxEdges = parseNumber(
            options.maxEdges,
            DEFAULT_MAX_EDGES,
            0,
            1000000
        );

        const addEdge = (source, target, type = "related", weight = 1, directed = true) => {
            if (edges.length >= maxEdges) {
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

            if (edgeKeys.has(key)) {
                return false;
            }

            edgeKeys.add(key);
            edges.push({
                id: key,
                source,
                target,
                type: String(type),
                weight: parseNumber(weight, 1, 0.01, 1000000),
                directed: directed !== false,
                visible: true
            });

            return true;
        };

        for (const edge of extractExplicitEdges(data)) {
            if (!isObject(edge)) {
                continue;
            }

            addEdge(
                firstValue(edge, ["source", "sourceId", "from"], ""),
                firstValue(edge, ["target", "targetId", "to"], ""),
                firstValue(edge, ["type", "relationship", "kind"], "related"),
                edge.weight ?? edge.value ?? 1,
                edge.directed !== false
            );
        }

        for (const node of nodes) {
            for (const reference of extractReferences(node.raw, options)) {
                addEdge(
                    node.id,
                    reference.target,
                    reference.type,
                    reference.weight,
                    reference.directed
                );
            }
        }

        if (options.inferTaxonomy !== false && edges.length < maxEdges) {
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
                        addEdge(node.id, parentId, "taxonomy", 1, true);
                    }

                    if (edges.length >= maxEdges) {
                        break;
                    }
                }

                if (edges.length >= maxEdges) {
                    break;
                }
            }
        }

        for (const edge of edges) {
            byId.get(edge.source).degree += 1;
            byId.get(edge.target).degree += 1;
        }

        return {
            nodes,
            edges,
            byId
        };
    }

    class ForceGraphController extends EventTarget {
        constructor(target, data = [], options = {}) {
            super();

            this.canvas = resolveCanvas(target);
            this.context = this.canvas.getContext("2d", {
                alpha: true,
                desynchronized: true
            });

            if (!this.context) {
                throw new Error("Unable to acquire ForceGraph 2D context.");
            }

            this.options = {
                background: options.background || DEFAULT_BACKGROUND,
                foreground: options.foreground || DEFAULT_FOREGROUND,
                highlight: options.highlight || DEFAULT_HIGHLIGHT,
                edgeColor: options.edgeColor || DEFAULT_EDGE,
                nodeRadius: parseNumber(
                    options.nodeRadius,
                    DEFAULT_NODE_RADIUS,
                    1,
                    40
                ),
                charge: parseNumber(
                    options.charge,
                    DEFAULT_CHARGE,
                    0,
                    5000
                ),
                linkDistance: parseNumber(
                    options.linkDistance,
                    DEFAULT_LINK_DISTANCE,
                    5,
                    1000
                ),
                linkStrength: parseNumber(
                    options.linkStrength,
                    DEFAULT_LINK_STRENGTH,
                    0,
                    2
                ),
                centering: parseNumber(
                    options.centering,
                    DEFAULT_CENTERING,
                    0,
                    1
                ),
                clustering: parseNumber(
                    options.clustering,
                    0.018,
                    0,
                    1
                ),
                damping: parseNumber(
                    options.damping,
                    DEFAULT_DAMPING,
                    0,
                    0.999
                ),
                collisionPadding: parseNumber(
                    options.collisionPadding,
                    2,
                    0,
                    100
                ),
                alphaDecay: parseNumber(
                    options.alphaDecay,
                    DEFAULT_ALPHA_DECAY,
                    0.0001,
                    1
                ),
                minAlpha: parseNumber(
                    options.minAlpha,
                    DEFAULT_MIN_ALPHA,
                    0.00001,
                    1
                ),
                maxNodes: parseNumber(
                    options.maxNodes,
                    DEFAULT_MAX_NODES,
                    1,
                    100000
                ),
                maxEdges: parseNumber(
                    options.maxEdges,
                    DEFAULT_MAX_EDGES,
                    0,
                    1000000
                ),
                groupKey: options.groupKey || null,
                inferTaxonomy: options.inferTaxonomy !== false,
                showLabels: options.showLabels !== false,
                showEdges: options.showEdges !== false,
                showGroups: options.showGroups !== false,
                showArrows: options.showArrows === true,
                interactive: options.interactive !== false,
                animated: options.animated !== false,
                zoomable: options.zoomable !== false,
                pannable: options.pannable !== false,
                seed: options.seed || "speciedex-forcegraph",
                label: options.label || "ForceGraph visualization"
            };

            this.graph = {
                nodes: [],
                edges: [],
                byId: new Map()
            };
            this.bounds = {
                width: 1,
                height: 1
            };
            this.transform = {
                zoom: 1,
                x: 0,
                y: 0
            };
            this.alpha = 1;
            this.running = false;
            this.paused = false;
            this.destroyed = false;
            this.animationFrame = 0;
            this.lastFrameAt = 0;
            this.startedAt = null;
            this.hovered = null;
            this.selected = null;
            this.drag = null;
            this.query = "";
            this.groupFilter = null;
            this.lastError =
                null;

            this.emitting =
                false;

            this.pointerMoved =
                false;

            this.lastWidth =
                0;

            this.lastHeight =
                0;

            this.abortController =
                new AbortController();

            this.metrics = {
                inputRecords: 0,
                nodes: 0,
                edges: 0,
                frames: 0,
                simulationSteps: 0,
                zooms: 0,
                pans: 0,
                selections: 0,
                resizes:
                    0,
                skippedResizes:
                    0,
                droppedFrames:
                    0,
                errors:
                    0,
                asyncSimulations:
                    0,
                asyncYields:
                    0,
                fits:
                    0,
                focuses:
                    0,
                neighborQueries:
                    0
            };

            this._boundPointerMove = this._handlePointerMove.bind(this);
            this._boundPointerLeave = this._handlePointerLeave.bind(this);
            this._boundPointerDown = this._handlePointerDown.bind(this);
            this._boundPointerUp = this._handlePointerUp.bind(this);
            this._boundWheel = this._handleWheel.bind(this);
            this._boundClick = this._handleClick.bind(this);
            this._boundKeydown = this._handleKeydown.bind(this);

            this.canvas[
                CONTROLLER_SYMBOL
            ] =
                this;

            this.canvas.forceGraphController =
                this;

            this._cleanupResize =
                createResizeObserver(
                    this.canvas,
                    () =>
                        this.resize()
                );

            const signal =
                this.abortController.signal;

            if (this.options.interactive) {
                this.canvas.tabIndex = this.canvas.tabIndex >= 0
                    ? this.canvas.tabIndex
                    : 0;
                this.canvas.setAttribute("aria-label", this.options.label);
                this.canvas.addEventListener(
                    "pointermove",
                    this._boundPointerMove,
                    {
                        signal,
                        passive:
                            true
                    }
                );

                this.canvas.addEventListener(
                    "pointerleave",
                    this._boundPointerLeave,
                    {
                        signal,
                        passive:
                            true
                    }
                );

                this.canvas.addEventListener(
                    "pointerdown",
                    this._boundPointerDown,
                    {
                        signal
                    }
                );

                this.canvas.addEventListener(
                    "pointerup",
                    this._boundPointerUp,
                    {
                        signal
                    }
                );

                this.canvas.addEventListener(
                    "pointercancel",
                    this._boundPointerUp,
                    {
                        signal
                    }
                );

                this.canvas.addEventListener(
                    "wheel",
                    this._boundWheel,
                    {
                        passive:
                            false,
                        signal
                    }
                );

                this.canvas.addEventListener(
                    "click",
                    this._boundClick,
                    {
                        signal
                    }
                );

                this.canvas.addEventListener(
                    "keydown",
                    this._boundKeydown,
                    {
                        signal
                    }
                );
            }

            this.resize();
            this.setData(data);

            if (this.options.animated) {
                this.start();
            } else {
                this.simulate(160);
                this.draw();
            }
        }

        _emit(
            type,
            detail =
                {}
        ) {
            const event = {
                type,
                timestamp:
                    iso(),
                ...detail
            };

            if (
                this.emitting
            ) {
                return event;
            }

            this.emitting =
                true;

            try {
                safeDispatch(
                    this,
                    type,
                    event
                );

                try {
                    this.options.context?.
                        events?.
                        emit?.(
                            `forcegraph:${type}`,
                            event
                        );
                } catch (observerError) {
                    window.console?.
                        warn?.(
                            "[SpeciedexTerminalForceGraph] Event observer failed:",
                            observerError
                        );
                }

                return event;
            } finally {
                this.emitting =
                    false;
            }
        }

        _recordError(error) {
            this.lastError = error instanceof Error
                ? error
                : new Error(String(error));
            this.metrics.errors +=
                1;

            if (
                this.emitting
            ) {
                window.console?.
                    error?.(
                        "[SpeciedexTerminalForceGraph]",
                        this.lastError
                    );

                return;
            }

            this._emit(
                "error",
                {
                error: {
                    name: this.lastError.name,
                    message: this.lastError.message,
                    stack: this.lastError.stack || ""
                }
            }
            );
        }

        resize() {
            if (
                this.destroyed
            ) {
                return false;
            }

            const rectangle =
                this.canvas.getBoundingClientRect();

            const logicalWidth =
                rectangle.width ||
                this.canvas.clientWidth ||
                this.canvas.parentElement?.
                    clientWidth ||
                DEFAULT_WIDTH;

            const logicalHeight =
                rectangle.height ||
                this.canvas.clientHeight ||
                this.canvas.parentElement?.
                    clientHeight ||
                DEFAULT_HEIGHT;

            if (
                logicalWidth <=
                    0 ||
                logicalHeight <=
                    0
            ) {
                this.metrics.skippedResizes +=
                    1;

                return false;
            }

            if (
                Math.abs(
                    logicalWidth -
                    this.lastWidth
                ) <
                    0.5 &&
                Math.abs(
                    logicalHeight -
                    this.lastHeight
                ) <
                    0.5
            ) {
                this.metrics.skippedResizes +=
                    1;

                return false;
            }

            this.lastWidth =
                logicalWidth;

            this.lastHeight =
                logicalHeight;

            const ratio =
                Math.min(
                    window.devicePixelRatio ||
                    1,
                    2
                );

            const width =
                Math.max(
                    1,
                    Math.round(
                        logicalWidth *
                        ratio
                    )
                );

            const height =
                Math.max(
                    1,
                    Math.round(
                        logicalHeight *
                        ratio
                    )
                );

            if (
                this.canvas.width !==
                    width ||
                this.canvas.height !==
                    height
            ) {
                this.canvas.width =
                    width;

                this.canvas.height =
                    height;
            }

            this.context.setTransform(
                ratio,
                0,
                0,
                ratio,
                0,
                0
            );

            this.bounds.width =
                logicalWidth;

            this.bounds.height =
                logicalHeight;

            this.metrics.resizes +=
                1;

            this._scaleNormalizedPositions();

            this.alpha =
                Math.max(
                    this.alpha,
                    0.25
                );

            this.draw();

            this._emit(
                "resize",
                clone(
                    this.bounds
                )
            );

            return true;
        }

        _scaleNormalizedPositions() {
            for (const node of this.graph.nodes) {
                if (node.x >= 0 && node.x <= 1) {
                    node.x *= this.bounds.width;
                }

                if (node.y >= 0 && node.y <= 1) {
                    node.y *= this.bounds.height;
                }

                node.x = Math.max(0, Math.min(this.bounds.width, node.x));
                node.y = Math.max(0, Math.min(this.bounds.height, node.y));
            }
        }

        setData(data) {
            try {
                this.graph = normalizeGraph(data, this.options);
                this.metrics.inputRecords = normalizeRecords(data).length;
                this.metrics.nodes = this.graph.nodes.length;
                this.metrics.edges = this.graph.edges.length;
                this.alpha = 1;
                this.hovered = null;
                this.selected = null;
                this._scaleNormalizedPositions();
                this._updateRadii();
                this._applyFilters();
                this.draw();

                this._emit("data", {
                    nodes: this.graph.nodes.length,
                    edges: this.graph.edges.length
                });
            } catch (error) {
                this._recordError(error);
            }

            return this;
        }

        append(data) {
            const combined = [
                ...this.graph.nodes.map((node) => node.raw),
                ...normalizeRecords(data)
            ];

            this.setData(combined);

            this._emit("append", {
                added: normalizeRecords(data).length
            });

            return this;
        }

        _updateRadii() {
            const scores = this.graph.nodes.map(
                (node) => node.weight + node.degree
            );
            const minimum = Math.min(...scores, 1);
            const maximum = Math.max(...scores, 1);
            const range = Math.max(1e-9, maximum - minimum);

            for (const node of this.graph.nodes) {
                const ratio =
                    (node.weight + node.degree - minimum) / range;

                node.radius =
                    this.options.nodeRadius *
                    (0.7 + Math.sqrt(ratio) * 1.9);
            }
        }

        _applyFilters() {
            const query = this.query.toLowerCase();

            for (const node of this.graph.nodes) {
                node.visible =
                    (
                        !query ||
                        node.id.toLowerCase().includes(query) ||
                        node.label.toLowerCase().includes(query) ||
                        node.group.toLowerCase().includes(query)
                    ) &&
                    (
                        !this.groupFilter ||
                        node.group === this.groupFilter
                    );
            }

            for (const edge of this.graph.edges) {
                edge.visible = Boolean(
                    this.graph.byId.get(edge.source)?.visible &&
                    this.graph.byId.get(edge.target)?.visible
                );
            }
        }

        start() {
            if (this.destroyed) {
                throw new Error("ForceGraph controller has been destroyed.");
            }

            if (this.running && !this.paused) {
                return this;
            }

            if (
                this.animationFrame
            ) {
                window.cancelAnimationFrame(
                    this.animationFrame
                );

                this.animationFrame =
                    0;
            }

            this.running =
                true;

            this.paused =
                false;
            this.startedAt = this.startedAt || iso();
            this.lastFrameAt = 0;
            this.animationFrame = window.requestAnimationFrame(
                (timestamp) => this._frame(timestamp)
            );
            this._emit("start", {});
            return this;
        }

        stop() {
            const active = this.running || this.paused;
            this.running = false;
            this.paused = false;

            if (this.animationFrame) {
                window.cancelAnimationFrame(this.animationFrame);
                this.animationFrame = 0;
            }

            if (active) {
                this._emit("stop", {});
            }

            return this;
        }

        pause() {
            if (!this.running || this.paused) {
                return false;
            }

            this.paused = true;

            if (this.animationFrame) {
                window.cancelAnimationFrame(this.animationFrame);
                this.animationFrame = 0;
            }

            this._emit("pause", {});
            return true;
        }

        resume() {
            if (!this.running) {
                this.start();
                return true;
            }

            if (!this.paused) {
                return false;
            }

            this.paused = false;
            this.lastFrameAt = 0;
            this.animationFrame = window.requestAnimationFrame(
                (timestamp) => this._frame(timestamp)
            );
            this._emit("resume", {});
            return true;
        }

        _frame(timestamp) {
            if (
                !this.running ||
                this.paused ||
                this.destroyed
            ) {
                return;
            }

            const delta = this.lastFrameAt
                ? Math.min(50, timestamp - this.lastFrameAt) / 1000
                : 0.016667;
            this.lastFrameAt = timestamp;

            if (this.alpha > this.options.minAlpha) {
                this._simulateStep(delta);
            }

            this.draw();
            this.metrics.frames += 1;

            if (
                this.running &&
                !this.paused &&
                !this.destroyed
            ) {
                this.animationFrame =
                    window.requestAnimationFrame(
                        nextTimestamp =>
                            this._frame(
                                nextTimestamp
                            )
                    );
            }
        }

        simulate(iterations = 1) {
            const count = parseNumber(iterations, 1, 1, 100000);

            for (let index = 0; index < count; index += 1) {
                this._simulateStep(0.016667);
            }

            this.draw();
            return this;
        }

        async simulateAsync(
            iterations = 120,
            options = {}
        ) {
            if (this.destroyed) {
                throw new Error(
                    "ForceGraph controller has been destroyed."
                );
            }

            const count = Math.floor(
                parseNumber(
                    iterations,
                    120,
                    1,
                    1000000
                )
            );

            const batchSize = Math.floor(
                parseNumber(
                    options.batchSize ??
                    options.batch_size,
                    DEFAULT_ASYNC_BATCH,
                    1,
                    10000
                )
            );

            const signal = options.signal;
            const startedAt = now();
            let completed = 0;

            throwIfAborted(signal);

            this._emit("simulation-start", {
                iterations: count,
                batchSize
            });

            try {
                while (completed < count) {
                    throwIfAborted(signal);

                    const end = Math.min(
                        count,
                        completed + batchSize
                    );

                    while (completed < end) {
                        this._simulateStep(0.016667);
                        completed += 1;
                    }

                    this.draw();

                    this._emit("simulation-progress", {
                        completed,
                        total: count,
                        progress: completed / count,
                        alpha: this.alpha
                    });

                    if (completed < count) {
                        this.metrics.asyncYields += 1;
                        await nextFrame(signal);
                    }
                }

                this.metrics.asyncSimulations += 1;

                const result = {
                    completed,
                    total: count,
                    duration: now() - startedAt,
                    alpha: this.alpha
                };

                this._emit("simulation-complete", result);
                return result;
            } catch (error) {
                this._emit("simulation-error", {
                    completed,
                    total: count,
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

        fitView(options = {}) {
            const visible = this.graph.nodes.filter(
                node => node.visible
            );

            if (!visible.length) {
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
                ...visible.map(node => node.x - node.radius)
            );

            const maximumX = Math.max(
                ...visible.map(node => node.x + node.radius)
            );

            const minimumY = Math.min(
                ...visible.map(node => node.y - node.radius)
            );

            const maximumY = Math.max(
                ...visible.map(node => node.y + node.radius)
            );

            const graphWidth = Math.max(
                1,
                maximumX - minimumX
            );

            const graphHeight = Math.max(
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
                0.2,
                Math.min(
                    12,
                    Math.min(
                        availableWidth / graphWidth,
                        availableHeight / graphHeight
                    )
                )
            );

            const graphCenterX =
                (minimumX + maximumX) / 2;

            const graphCenterY =
                (minimumY + maximumY) / 2;

            const viewCenterX =
                this.bounds.width / 2;

            const viewCenterY =
                this.bounds.height / 2;

            this.transform.zoom = zoom;
            this.transform.x =
                (viewCenterX - graphCenterX) * zoom;
            this.transform.y =
                (viewCenterY - graphCenterY) * zoom;

            this.metrics.fits += 1;
            this.draw();

            this._emit("fit", {
                transform: clone(this.transform),
                visibleNodes: visible.length,
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
                Math.max(this.transform.zoom, 1.5),
                0.2,
                12
            );

            const centerX = this.bounds.width / 2;
            const centerY = this.bounds.height / 2;

            this.transform.zoom = zoom;
            this.transform.x =
                (centerX - node.x) * zoom;
            this.transform.y =
                (centerY - node.y) * zoom;

            this.selected = node;
            this.metrics.focuses += 1;
            this.draw();

            const description = this.describeNode(node);

            this._emit("focus", {
                node: description,
                transform: clone(this.transform)
            });

            return description;
        }

        neighbors(id, depth = 1) {
            const startId = String(id);

            if (!this.graph.byId.has(startId)) {
                return [];
            }

            const maximumDepth = Math.floor(
                parseNumber(depth, 1, 1, 32)
            );

            const visited = new Set([startId]);
            let frontier = new Set([startId]);
            const results = [];

            for (
                let level = 1;
                level <= maximumDepth;
                level += 1
            ) {
                const next = new Set();

                for (const edge of this.graph.edges) {
                    if (!edge.visible) {
                        continue;
                    }

                    let candidate = null;

                    if (frontier.has(edge.source)) {
                        candidate = edge.target;
                    } else if (frontier.has(edge.target)) {
                        candidate = edge.source;
                    }

                    if (
                        candidate &&
                        !visited.has(candidate)
                    ) {
                        visited.add(candidate);
                        next.add(candidate);

                        const node =
                            this.graph.byId.get(candidate);

                        if (node) {
                            results.push({
                                depth: level,
                                node: this.describeNode(node)
                            });
                        }
                    }
                }

                frontier = next;

                if (!frontier.size) {
                    break;
                }
            }

            this.metrics.neighborQueries += 1;
            return results;
        }

        connectedComponents(options = {}) {
            const visibleOnly =
                options.visibleOnly ??
                options.visible_only ??
                true;

            const nodes = this.graph.nodes.filter(
                node => !visibleOnly || node.visible
            );

            const allowed = new Set(
                nodes.map(node => node.id)
            );

            const adjacency = new Map(
                nodes.map(node => [node.id, new Set()])
            );

            for (const edge of this.graph.edges) {
                if (
                    visibleOnly &&
                    !edge.visible
                ) {
                    continue;
                }

                if (
                    !allowed.has(edge.source) ||
                    !allowed.has(edge.target)
                ) {
                    continue;
                }

                adjacency.get(edge.source)?.add(edge.target);
                adjacency.get(edge.target)?.add(edge.source);
            }

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

                    for (
                        const neighbor of
                        adjacency.get(current) || []
                    ) {
                        if (!visited.has(neighbor)) {
                            visited.add(neighbor);
                            queue.push(neighbor);
                        }
                    }
                }

                components.push(
                    component
                        .map(id =>
                            this.describeNode(
                                this.graph.byId.get(id)
                            )
                        )
                        .filter(Boolean)
                );
            }

            return components.sort(
                (left, right) =>
                    right.length - left.length
            );
        }

        _simulateStep(delta) {
            const nodes = this.graph.nodes.filter((node) => node.visible);
            const edges = this.graph.edges.filter((edge) => edge.visible);

            if (!nodes.length) {
                return;
            }

            const centerX = this.bounds.width / 2;
            const centerY = this.bounds.height / 2;

            const repulsionNodes =
                nodes.length >
                    1800
                    ? nodes.filter(
                        (
                            _node,
                            index
                        ) =>
                            index %
                            Math.ceil(
                                nodes.length /
                                1800
                            ) ===
                            0
                    )
                    : nodes;

            for (
                let leftIndex =
                    0;
                leftIndex <
                    repulsionNodes.length;
                leftIndex +=
                    1
            ) {
                const left =
                    repulsionNodes[
                        leftIndex
                    ];

                for (
                    let rightIndex = leftIndex + 1;
                    rightIndex <
                        repulsionNodes.length;
                    rightIndex += 1
                ) {
                    const right =
                        repulsionNodes[
                            rightIndex
                        ];
                    let dx = right.x - left.x;
                    let dy = right.y - left.y;
                    let distanceSquared = dx * dx + dy * dy;

                    if (distanceSquared < 0.01) {
                        dx = 0.1;
                        dy = 0.1;
                        distanceSquared = 0.02;
                    }

                    const distance = Math.sqrt(distanceSquared);
                    const force =
                        this.options.charge *
                        this.alpha /
                        distanceSquared;
                    const fx = force * dx / distance;
                    const fy = force * dy / distance;

                    if (left.fx === null) {
                        left.vx -= fx;
                        left.vy -= fy;
                    }

                    if (right.fx === null) {
                        right.vx += fx;
                        right.vy += fy;
                    }

                    const minimumDistance =
                        left.radius +
                        right.radius +
                        this.options.collisionPadding;

                    if (distance < minimumDistance) {
                        const overlap = minimumDistance - distance;
                        const correction = overlap * 0.16;

                        if (left.fx === null) {
                            left.vx -= correction * dx / distance;
                            left.vy -= correction * dy / distance;
                        }

                        if (right.fx === null) {
                            right.vx += correction * dx / distance;
                            right.vy += correction * dy / distance;
                        }
                    }
                }
            }

            for (const edge of edges) {
                const source = this.graph.byId.get(edge.source);
                const target = this.graph.byId.get(edge.target);

                if (!source || !target) {
                    continue;
                }

                let dx = target.x - source.x;
                let dy = target.y - source.y;
                let distance = Math.sqrt(dx * dx + dy * dy);

                if (distance < 0.01) {
                    distance = 0.01;
                }

                const desired =
                    this.options.linkDistance /
                    Math.max(0.45, Math.sqrt(edge.weight));
                const force =
                    (distance - desired) *
                    this.options.linkStrength *
                    this.alpha;
                const fx = force * dx / distance;
                const fy = force * dy / distance;

                if (source.fx === null) {
                    source.vx += fx;
                    source.vy += fy;
                }

                if (target.fx === null) {
                    target.vx -= fx;
                    target.vy -= fy;
                }
            }

            const groups = Array.from(
                new Set(nodes.map((node) => node.group))
            );
            const groupCenters = new Map();

            groups.forEach((group, index) => {
                const angle =
                    index / Math.max(1, groups.length) *
                    Math.PI *
                    2;
                const radius =
                    Math.min(this.bounds.width, this.bounds.height) *
                    0.24;

                groupCenters.set(group, {
                    x: centerX + Math.cos(angle) * radius,
                    y: centerY + Math.sin(angle) * radius
                });
            });

            for (const node of nodes) {
                const cluster =
                    groupCenters.get(node.group) ||
                    { x: centerX, y: centerY };

                if (node.fx === null) {
                    node.vx +=
                        (centerX - node.x) *
                        this.options.centering *
                        this.alpha;
                    node.vy +=
                        (centerY - node.y) *
                        this.options.centering *
                        this.alpha;
                    node.vx +=
                        (cluster.x - node.x) *
                        this.options.clustering *
                        this.alpha;
                    node.vy +=
                        (cluster.y - node.y) *
                        this.options.clustering *
                        this.alpha;

                    node.vx *= this.options.damping;
                    node.vy *= this.options.damping;
                    node.x += node.vx * delta * 60;
                    node.y += node.vy * delta * 60;
                } else {
                    node.x = node.fx;
                    node.y = node.fy;
                    node.vx = 0;
                    node.vy = 0;
                }

                const margin = node.radius + 4;
                node.x = Math.max(
                    margin,
                    Math.min(this.bounds.width - margin, node.x)
                );
                node.y = Math.max(
                    margin,
                    Math.min(this.bounds.height - margin, node.y)
                );
            }

            this.alpha *= 1 - this.options.alphaDecay;
            this.metrics.simulationSteps += 1;
        }

        _screenPoint(x, y) {
            const centerX = this.bounds.width / 2;
            const centerY = this.bounds.height / 2;

            return {
                x:
                    centerX +
                    (x - centerX) *
                    this.transform.zoom +
                    this.transform.x,
                y:
                    centerY +
                    (y - centerY) *
                    this.transform.zoom +
                    this.transform.y
            };
        }

        _inverseScreenPoint(x, y) {
            const centerX = this.bounds.width / 2;
            const centerY = this.bounds.height / 2;

            return {
                x:
                    centerX +
                    (x - centerX - this.transform.x) /
                    this.transform.zoom,
                y:
                    centerY +
                    (y - centerY - this.transform.y) /
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
            this.context.fillStyle = this.options.background;
            this.context.fillRect(
                0,
                0,
                this.bounds.width,
                this.bounds.height
            );

            if (!this.graph.nodes.length) {
                this.context.fillStyle = this.options.foreground;
                this.context.globalAlpha = 0.72;
                this.context.font =
                    '14px "IBM Plex Mono", monospace';
                this.context.textAlign = "center";
                this.context.textBaseline = "middle";
                this.context.fillText(
                    "No force-graph nodes.",
                    this.bounds.width / 2,
                    this.bounds.height / 2
                );
                this.context.globalAlpha = 1;
                return;
            }

            if (this.options.showEdges) {
                this._drawEdges();
            }

            this._drawNodes();

            if (this.options.showLabels) {
                this._drawLabels();
            }
        }

        _drawEdges() {
            this.context.save();

            for (const edge of this.graph.edges) {
                if (!edge.visible) {
                    continue;
                }

                const source = this.graph.byId.get(edge.source);
                const target = this.graph.byId.get(edge.target);

                if (!source || !target) {
                    continue;
                }

                const start = this._screenPoint(source.x, source.y);
                const end = this._screenPoint(target.x, target.y);
                const emphasized =
                    this.selected &&
                    (
                        source.id === this.selected.id ||
                        target.id === this.selected.id
                    );

                this.context.strokeStyle =
                    emphasized
                        ? this.options.highlight
                        : this.options.edgeColor;
                this.context.globalAlpha =
                    emphasized ? 0.88 : 0.30;
                this.context.lineWidth =
                    emphasized
                        ? 2
                        : Math.min(
                            2.5,
                            0.6 + Math.sqrt(edge.weight) * 0.32
                        );

                this.context.beginPath();
                this.context.moveTo(start.x, start.y);
                this.context.lineTo(end.x, end.y);
                this.context.stroke();

                if (this.options.showArrows && edge.directed) {
                    this._drawArrowHead(
                        start,
                        end,
                        target.radius *
                        Math.sqrt(this.transform.zoom)
                    );
                }
            }

            this.context.restore();
        }

        _drawArrowHead(start, end, targetRadius) {
            const angle = Math.atan2(end.y - start.y, end.x - start.x);
            const size = 6;
            const x = end.x - Math.cos(angle) * (targetRadius + 2);
            const y = end.y - Math.sin(angle) * (targetRadius + 2);

            this.context.beginPath();
            this.context.moveTo(x, y);
            this.context.lineTo(
                x - Math.cos(angle - Math.PI / 6) * size,
                y - Math.sin(angle - Math.PI / 6) * size
            );
            this.context.lineTo(
                x - Math.cos(angle + Math.PI / 6) * size,
                y - Math.sin(angle + Math.PI / 6) * size
            );
            this.context.closePath();
            this.context.fillStyle = this.context.strokeStyle;
            this.context.fill();
        }

        _drawNodes() {
            this.context.save();

            for (const node of this.graph.nodes) {
                if (!node.visible) {
                    continue;
                }

                const point = this._screenPoint(node.x, node.y);
                const radius =
                    node.radius *
                    Math.sqrt(this.transform.zoom);
                const emphasized =
                    node.id === this.selected?.id ||
                    node.id === this.hovered?.id;

                this.context.beginPath();
                this.context.arc(
                    point.x,
                    point.y,
                    radius,
                    0,
                    Math.PI * 2
                );
                this.context.fillStyle =
                    emphasized
                        ? this.options.highlight
                        : this.options.showGroups
                            ? colorHash(node.group)
                            : this.options.foreground;
                this.context.globalAlpha =
                    emphasized ? 1 : 0.84;

                if (emphasized) {
                    this.context.shadowColor = this.options.highlight;
                    this.context.shadowBlur = 12;
                } else {
                    this.context.shadowBlur = 0;
                }

                this.context.fill();
                this.context.strokeStyle = this.options.background;
                this.context.globalAlpha = 0.8;
                this.context.lineWidth = 1;
                this.context.stroke();

                node.screenX = point.x;
                node.screenY = point.y;
                node.screenRadius = radius;
            }

            this.context.restore();
        }

        _drawLabels() {
            const visible = this.graph.nodes
                .filter((node) => node.visible)
                .sort((left, right) =>
                    (
                        right.degree +
                        right.weight
                    ) -
                    (
                        left.degree +
                        left.weight
                    )
                )
                .slice(0, MAX_LABELS);

            this.context.save();
            this.context.font =
                '11px "IBM Plex Mono", monospace';
            this.context.textAlign = "left";
            this.context.textBaseline = "middle";

            for (const node of visible) {
                if (
                    this.transform.zoom < 0.75 &&
                    node.id !== this.selected?.id &&
                    node.id !== this.hovered?.id
                ) {
                    continue;
                }

                const point = this._screenPoint(node.x, node.y);
                const emphasized =
                    node.id === this.selected?.id ||
                    node.id === this.hovered?.id;

                this.context.fillStyle =
                    emphasized
                        ? this.options.highlight
                        : this.options.foreground;
                this.context.globalAlpha =
                    emphasized ? 1 : 0.68;
                this.context.fillText(
                    node.label,
                    point.x +
                    node.radius *
                    Math.sqrt(this.transform.zoom) +
                    4,
                    point.y
                );
            }

            this.context.restore();
        }

        _pointFromEvent(event) {
            const rectangle = this.canvas.getBoundingClientRect();

            return {
                x: event.clientX - rectangle.left,
                y: event.clientY - rectangle.top
            };
        }

        hitTest(x, y) {
            for (
                let index = this.graph.nodes.length - 1;
                index >= 0;
                index -= 1
            ) {
                const node = this.graph.nodes[index];

                if (!node.visible) {
                    continue;
                }

                const point = this._screenPoint(node.x, node.y);
                const radius =
                    node.radius *
                    Math.sqrt(this.transform.zoom) +
                    4;
                const dx = x - point.x;
                const dy = y - point.y;

                if (dx * dx + dy * dy <= radius * radius) {
                    return node;
                }
            }

            return null;
        }

        _handlePointerMove(event) {
            this.pointerMoved =
                false;

            const point =
                this._pointFromEvent(
                    event
                );

            if (
                this.drag?.
                    node
            ) {
                this.pointerMoved =
                    true;

                const world =
                    this._inverseScreenPoint(
                        point.x,
                        point.y
                    );
                this.drag.node.fx = world.x;
                this.drag.node.fy = world.y;
                this.drag.node.x = world.x;
                this.drag.node.y = world.y;
                this.alpha = Math.max(this.alpha, 0.12);
                this.draw();
                return;
            }

            if (
                this.drag?.
                    pan
            ) {
                this.pointerMoved =
                    true;

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

            const hovered = this.hitTest(point.x, point.y);
            const changed = hovered?.id !== this.hovered?.id;

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
                    node: hovered
                        ? this.describeNode(hovered)
                        : null
                });
            }
        }

        _handlePointerLeave() {
            this.drag = null;

            if (this.hovered) {
                this.hovered = null;
                this.draw();
                this._emit("hover", { node: null });
            }
        }

        _handlePointerDown(
            event
        ) {
            if (
                event.button !==
                0
            ) {
                return;
            }

            const point = this._pointFromEvent(event);
            const node = this.hitTest(point.x, point.y);

            if (node) {
                const world = this._inverseScreenPoint(point.x, point.y);
                node.fx = world.x;
                node.fy = world.y;
                this.drag = { node };
            } else if (this.options.pannable) {
                this.drag = {
                    pan: true,
                    startX: point.x,
                    startY: point.y,
                    originX: this.transform.x,
                    originY: this.transform.y
                };
            }

            this.canvas.setPointerCapture?.(event.pointerId);
        }

        _handlePointerUp(event) {
            if (!this.drag) {
                return;
            }

            if (this.drag.node) {
                this.drag.node.fx = null;
                this.drag.node.fy = null;
                this.alpha = Math.max(this.alpha, 0.18);
            }

            this.canvas.releasePointerCapture?.(event.pointerId);
            this.drag = null;
        }

        _handleWheel(event) {
            if (!this.options.zoomable) {
                return;
            }

            event.preventDefault();

            const point = this._pointFromEvent(event);
            const before = this._inverseScreenPoint(point.x, point.y);
            const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
            const zoom = Math.max(
                0.2,
                Math.min(12, this.transform.zoom * factor)
            );
            const centerX = this.bounds.width / 2;
            const centerY = this.bounds.height / 2;

            this.transform.zoom = zoom;
            this.transform.x =
                point.x -
                centerX -
                (before.x - centerX) *
                zoom;
            this.transform.y =
                point.y -
                centerY -
                (before.y - centerY) *
                zoom;
            this.metrics.zooms += 1;
            this.draw();

            this._emit("zoom", {
                zoom,
                transform: clone(this.transform)
            });
        }

        _handleClick(
            event
        ) {
            if (
                this.drag ||
                this.pointerMoved
            ) {
                this.pointerMoved =
                    false;

                return;
            }

            const point = this._pointFromEvent(event);
            const node = this.hitTest(point.x, point.y);

            this.selected =
                node?.id === this.selected?.id
                    ? null
                    : node;
            this.metrics.selections += 1;
            this.draw();

            this._emit("select", {
                node: this.selected
                    ? this.describeNode(this.selected)
                    : null
            });
        }

        _handleKeydown(event) {
            if (event.key === "+" || event.key === "=") {
                event.preventDefault();
                this.setZoom(this.transform.zoom * 1.2);
            } else if (event.key === "-") {
                event.preventDefault();
                this.setZoom(this.transform.zoom / 1.2);
            } else if (event.key === "0") {
                event.preventDefault();
                this.resetView();
            } else if (event.key === "Escape") {
                this.selected = null;
                this.draw();
            } else if (event.key === "ArrowLeft") {
                event.preventDefault();
                this.panBy(24, 0);
            } else if (event.key === "ArrowRight") {
                event.preventDefault();
                this.panBy(-24, 0);
            } else if (event.key === "ArrowUp") {
                event.preventDefault();
                this.panBy(0, 24);
            } else if (event.key === "ArrowDown") {
                event.preventDefault();
                this.panBy(0, -24);
            }
        }

        setZoom(value) {
            this.transform.zoom = Math.max(
                0.2,
                Math.min(
                    12,
                    parseNumber(value, this.transform.zoom)
                )
            );
            this.draw();

            this._emit("zoom", {
                zoom: this.transform.zoom,
                transform: clone(this.transform)
            });

            return this.transform.zoom;
        }

        panBy(x, y) {
            this.transform.x += Number(x) || 0;
            this.transform.y += Number(y) || 0;
            this.metrics.pans += 1;
            this.draw();
            return clone(this.transform);
        }

        resetView() {
            this.transform = {
                zoom: 1,
                x: 0,
                y: 0
            };
            this.draw();
            return clone(this.transform);
        }

        setFilter(query = "") {
            this.query = String(query || "");
            this._applyFilters();
            this.alpha = Math.max(this.alpha, 0.2);
            this.draw();

            this._emit("filter", {
                query: this.query,
                visible: this.graph.nodes.filter(
                    (node) => node.visible
                ).length
            });

            return this.query;
        }

        setGroup(group = null) {
            this.groupFilter =
                group ? String(group) : null;
            this._applyFilters();
            this.alpha = Math.max(this.alpha, 0.2);
            this.draw();
            return this.groupFilter;
        }

        selectNode(id) {
            const node = this.graph.byId.get(String(id));

            if (!node) {
                return null;
            }

            this.selected = node;
            this.draw();
            return this.describeNode(node);
        }

        describeNode(node) {
            if (!node) {
                return null;
            }

            const edges = this.graph.edges
                .filter((edge) =>
                    edge.source === node.id ||
                    edge.target === node.id
                )
                .map((edge) => ({
                    ...clone(edge),
                    sourceLabel:
                        this.graph.byId.get(edge.source)?.label ||
                        edge.source,
                    targetLabel:
                        this.graph.byId.get(edge.target)?.label ||
                        edge.target
                }));

            return {
                id: node.id,
                label: node.label,
                group: node.group,
                weight: node.weight,
                degree: node.degree,
                x: node.x,
                y: node.y,
                visible: node.visible,
                edges,
                raw: clone(node.raw)
            };
        }

        update(options = {}) {
            if (!isObject(options)) {
                throw new TypeError(
                    "ForceGraph options must be an object."
                );
            }

            const rebuildRequired = [
                "maxNodes",
                "maxEdges",
                "groupKey",
                "inferTaxonomy",
                "edgeKeys",
                "seed"
            ].some((key) => options[key] !== undefined);

            Object.assign(this.options, {
                background:
                    options.background ||
                    this.options.background,
                foreground:
                    options.foreground ||
                    this.options.foreground,
                highlight:
                    options.highlight ||
                    this.options.highlight,
                edgeColor:
                    options.edgeColor ||
                    this.options.edgeColor,
                nodeRadius:
                    options.nodeRadius !== undefined
                        ? parseNumber(
                            options.nodeRadius,
                            this.options.nodeRadius,
                            1,
                            40
                        )
                        : this.options.nodeRadius,
                charge:
                    options.charge !== undefined
                        ? parseNumber(
                            options.charge,
                            this.options.charge,
                            0,
                            5000
                        )
                        : this.options.charge,
                linkDistance:
                    options.linkDistance !== undefined
                        ? parseNumber(
                            options.linkDistance,
                            this.options.linkDistance,
                            5,
                            1000
                        )
                        : this.options.linkDistance,
                linkStrength:
                    options.linkStrength !== undefined
                        ? parseNumber(
                            options.linkStrength,
                            this.options.linkStrength,
                            0,
                            2
                        )
                        : this.options.linkStrength,
                centering:
                    options.centering !== undefined
                        ? parseNumber(
                            options.centering,
                            this.options.centering,
                            0,
                            1
                        )
                        : this.options.centering,
                clustering:
                    options.clustering !== undefined
                        ? parseNumber(
                            options.clustering,
                            this.options.clustering,
                            0,
                            1
                        )
                        : this.options.clustering,
                damping:
                    options.damping !== undefined
                        ? parseNumber(
                            options.damping,
                            this.options.damping,
                            0,
                            0.999
                        )
                        : this.options.damping,
                showLabels:
                    options.showLabels !==
                        undefined
                        ? parseBoolean(
                            options.showLabels,
                            this.options.showLabels
                        )
                        : this.options.showLabels,
                showEdges:
                    options.showEdges !==
                        undefined
                        ? parseBoolean(
                            options.showEdges,
                            this.options.showEdges
                        )
                        : this.options.showEdges,
                showGroups:
                    options.showGroups !==
                        undefined
                        ? parseBoolean(
                            options.showGroups,
                            this.options.showGroups
                        )
                        : this.options.showGroups,
                showArrows:
                    options.showArrows !==
                        undefined
                        ? parseBoolean(
                            options.showArrows,
                            this.options.showArrows
                        )
                        : this.options.showArrows,
                groupKey:
                    options.groupKey !== undefined
                        ? options.groupKey
                        : this.options.groupKey,
                inferTaxonomy:
                    options.inferTaxonomy !==
                        undefined
                        ? parseBoolean(
                            options.inferTaxonomy,
                            this.options.inferTaxonomy
                        )
                        : this.options.inferTaxonomy,
                maxNodes:
                    options.maxNodes !== undefined
                        ? parseNumber(
                            options.maxNodes,
                            this.options.maxNodes,
                            1,
                            100000
                        )
                        : this.options.maxNodes,
                maxEdges:
                    options.maxEdges !== undefined
                        ? parseNumber(
                            options.maxEdges,
                            this.options.maxEdges,
                            0,
                            1000000
                        )
                        : this.options.maxEdges,
                seed:
                    options.seed ||
                    this.options.seed
            });

            if (rebuildRequired) {
                this.setData(
                    this.graph.nodes.map((node) => node.raw)
                );
            } else {
                this._updateRadii();
                this.alpha = Math.max(this.alpha, 0.2);
                this.draw();
            }

            this._emit("update", {
                options: clone(this.options)
            });

            return this;
        }

        export(format = "json") {
            const normalized = String(format).toLowerCase();

            if (normalized === "png") {
                return this.canvas.toDataURL("image/png");
            }

            if (normalized === "json") {
                return JSON.stringify(
                    {
                        generatedAt: iso(),
                        options: this.options,
                        transform: this.transform,
                        nodes: this.graph.nodes.map(
                            (node) => this.describeNode(node)
                        ),
                        edges: this.graph.edges.map(clone)
                    },
                    null,
                    2
                );
            }

            if (normalized === "csv") {
                const rows = [[
                    "id",
                    "label",
                    "group",
                    "weight",
                    "degree",
                    "x",
                    "y",
                    "visible"
                ]];

                for (const node of this.graph.nodes) {
                    rows.push([
                        node.id,
                        node.label,
                        node.group,
                        node.weight,
                        node.degree,
                        node.x,
                        node.y,
                        node.visible
                    ]);
                }

                return rows
                    .map((row) =>
                        row.map((value) => {
                            let output =
                                String(
                                    value ??
                                    ""
                                );

                            if (
                                /^[=+\-@\t\r]/.test(
                                    output
                                )
                            ) {
                                output =
                                    `'${output}`;
                            }

                            return /[",\n\r]/.test(
                                output
                            )
                                ? `"${output.replace(/"/g, '""')}"`
                                : output;
                        }).join(",")
                    )
                    .join("\r\n");
            }

            throw new Error(
                `Unsupported ForceGraph export format: ${format}`
            );
        }

        status() {
            return {
                name: "forcegraph",
                module: MODULE_NAME,
                running: this.running,
                paused: this.paused,
                startedAt: this.startedAt,
                nodes: this.graph.nodes.length,
                visibleNodes: this.graph.nodes.filter(
                    (node) => node.visible
                ).length,
                edges: this.graph.edges.length,
                visibleEdges: this.graph.edges.filter(
                    (edge) => edge.visible
                ).length,
                alpha: this.alpha,
                query: this.query,
                groupFilter: this.groupFilter,
                transform: clone(this.transform),
                selected: this.selected
                    ? this.describeNode(this.selected)
                    : null,
                hovered: this.hovered
                    ? this.describeNode(this.hovered)
                    : null,
                options: clone(this.options),
                metrics: { ...this.metrics },
                lastError: this.lastError
                    ? {
                        name: this.lastError.name,
                        message: this.lastError.message
                    }
                    : null,
                destroyed: this.destroyed
            };
        }

        destroy() {
            if (
                this.destroyed
            ) {
                return false;
            }

            this.stop();

            this._cleanupResize?.();

            this.abortController.abort();

            this.drag =
                null;

            this.hovered =
                null;

            this.selected =
                null;

            this._emit(
                "destroy",
                {}
            );

            if (
                this.canvas[
                    CONTROLLER_SYMBOL
                ] ===
                    this
            ) {
                delete this.canvas[
                    CONTROLLER_SYMBOL
                ];
            }

            if (
                this.canvas.forceGraphController ===
                    this
            ) {
                delete this.canvas.forceGraphController;
            }

            this.graph = {
                nodes:
                    [],
                edges:
                    [],
                byId:
                    new Map()
            };

            this.destroyed =
                true;

            return true;
        }

    }

    function mount(
        target,
        data =
            [],
        options =
            {}
    ) {
        const canvas =
            resolveCanvas(
                target
            );

        const existing =
            canvas[
                CONTROLLER_SYMBOL
            ] ||
            canvas.forceGraphController;

        if (
            existing instanceof
                ForceGraphController &&
            !existing.destroyed
        ) {
            existing.update(
                options
            );

            existing.setData(
                data
            );

            return existing;
        }

        return new ForceGraphController(
            canvas,
            data,
            options
        );
    }

    function render(data = [], options = {}) {
        const container = createElement(
            "section",
            "terminal-visualization terminal-visualization-forcegraph"
        );
        container.dataset.visualization = "forcegraph";
        container.setAttribute("role", "region");
        container.setAttribute(
            "aria-label",
            options.label ||
            "ForceGraph visualization"
        );

        const canvas = document.createElement("canvas");
        canvas.className = "terminal-forcegraph-canvas";
        canvas.width = Number(options.width) || DEFAULT_WIDTH;
        canvas.height = Number(options.height) || DEFAULT_HEIGHT;
        canvas.setAttribute(
            "aria-label",
            options.label ||
            "ForceGraph visualization"
        );

        const status = createElement(
            "div",
            "terminal-forcegraph-status"
        );
        status.setAttribute("aria-live", "polite");

        const tooltip = createElement(
            "div",
            "terminal-forcegraph-tooltip"
        );
        tooltip.hidden = true;

        container.append(canvas, status, tooltip);

        const controller =
            mount(
                canvas,
                data,
                options
            );

        const updateStatus = () => {
            const snapshot = controller.status();

            status.textContent =
                `${snapshot.visibleNodes} of ${snapshot.nodes} node` +
                `${snapshot.nodes === 1 ? "" : "s"} · ` +
                `${snapshot.visibleEdges} edge` +
                `${snapshot.visibleEdges === 1 ? "" : "s"} · ` +
                `${snapshot.transform.zoom.toFixed(2)}×`;
        };

        controller.addEventListener(
            "hover",
            (event) => {
                const node = event.detail?.node;

                if (!node) {
                    tooltip.hidden = true;
                    return;
                }

                tooltip.hidden = false;
                tooltip.textContent =
                    `${node.label} · ${node.group} · ` +
                    `${node.degree} connection` +
                    `${node.degree === 1 ? "" : "s"}`;
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

        container.controller =
            controller;

        container.canvas =
            canvas;

        container.data =
            controller.graph.nodes;

        container[
            CONTROLLER_SYMBOL
        ] =
            controller;

        container.forceGraphController =
            controller;

        container.update =
            (
                nextData =
                    data,
                nextOptions =
                    {}
            ) => {
                controller.update(
                    nextOptions
                );

                controller.setData(
                    nextData
                );

                container.data =
                    controller.graph.nodes;

                return container;
            };

        container.status =
            () =>
                controller.status();

        container.destroy =
            () => {
                const destroyed =
                    controller.destroy();

                delete container[
                    CONTROLLER_SYMBOL
                ];

                return destroyed;
            };

        return container;
    }

    function initialize(
        context =
            {}
    ) {
        const root =
            context.root ||
            document;

        const existing =
            context.forcegraph ||
            root?.[
                VISUALIZATION_SYMBOL
            ];

        if (
            existing &&
            existing.Controller ===
                ForceGraphController
        ) {
            context.forcegraph =
                existing;

            context.registerVisualization?.(
                "forcegraph",
                existing
            );

            context.registerRenderer?.(
                "forcegraph",
                existing
            );

            return existing;
        }

        const dataset =
            context.root?.
                dataset ||
            {};

        const config =
            context.config?.
                forcegraph ||
            {};

        const defaults = {
            context,

            background:
                dataset.terminalForcegraphBackground ||
                config.background ||
                DEFAULT_BACKGROUND,

            foreground:
                dataset.terminalForcegraphForeground ||
                config.foreground ||
                DEFAULT_FOREGROUND,

            highlight:
                dataset.terminalForcegraphHighlight ||
                config.highlight ||
                DEFAULT_HIGHLIGHT,

            edgeColor:
                dataset.terminalForcegraphEdgeColor ||
                config.edgeColor ||
                DEFAULT_EDGE,

            nodeRadius:
                dataset.terminalForcegraphNodeRadius ||
                config.nodeRadius ||
                DEFAULT_NODE_RADIUS,

            charge:
                dataset.terminalForcegraphCharge ||
                config.charge ||
                DEFAULT_CHARGE,

            linkDistance:
                dataset.terminalForcegraphLinkDistance ||
                config.linkDistance ||
                DEFAULT_LINK_DISTANCE,

            groupKey:
                dataset.terminalForcegraphGroupKey ||
                config.groupKey ||
                null,

            showLabels:
                parseBoolean(
                    dataset.terminalForcegraphShowLabels,
                    config.showLabels !==
                        false
                ),

            showEdges:
                parseBoolean(
                    dataset.terminalForcegraphShowEdges,
                    config.showEdges !==
                        false
                ),

            showGroups:
                parseBoolean(
                    dataset.terminalForcegraphShowGroups,
                    config.showGroups !==
                        false
                ),

            showArrows:
                parseBoolean(
                    dataset.terminalForcegraphShowArrows,
                    config.showArrows ===
                        true
                ),

            animated:
                parseBoolean(
                    dataset.terminalForcegraphAnimated,
                    config.animated !==
                        false
                ),

            inferTaxonomy:
                parseBoolean(
                    dataset.terminalForcegraphInferTaxonomy,
                    config.inferTaxonomy !==
                        false
                ),

            interactive:
                parseBoolean(
                    dataset.terminalForcegraphInteractive,
                    config.interactive !==
                        false
                )
        };

        const controllers =
            new Set();

        const visualization = {
            version:
                VERSION,

            mount(
                target,
                data =
                    [],
                options =
                    {}
            ) {
                const controller =
                    mount(
                        target,
                        data,
                        {
                            ...defaults,
                            ...options,
                            context
                        }
                    );

                controllers.add(
                    controller
                );

                context.forcegraphController =
                    controller;

                controller.addEventListener(
                    "destroy",
                    () => {
                        controllers.delete(
                            controller
                        );

                        if (
                            context.forcegraphController ===
                                controller
                        ) {
                            delete context.forcegraphController;
                        }
                    },
                    {
                        once:
                            true
                    }
                );

                return controller;
            },

            render(
                data =
                    [],
                options =
                    {}
            ) {
                const element =
                    render(
                        data,
                        {
                            ...defaults,
                            ...options,
                            context
                        }
                    );

                if (
                    element.controller
                ) {
                    controllers.add(
                        element.controller
                    );

                    context.forcegraphController =
                        element.controller;

                    element.controller.addEventListener(
                        "destroy",
                        () => {
                            controllers.delete(
                                element.controller
                            );

                            if (
                                context.forcegraphController ===
                                    element.controller
                            ) {
                                delete context.forcegraphController;
                            }
                        },
                        {
                            once:
                                true
                        }
                    );
                }

                return element;
            },

            activeController() {
                return (
                    context.forcegraphController ||
                    context.terminalForcegraphController ||
                    Array.from(
                        controllers
                    ).at(
                        -1
                    ) ||
                    null
                );
            },

            status() {
                return {
                    version:
                        VERSION,
                    controllers:
                        controllers.size,
                    active:
                        this.activeController?.
                            ()?.
                            status?.() ||
                        null
                };
            },

            destroy() {
                for (
                    const controller of
                    Array.from(
                        controllers
                    )
                ) {
                    controller.destroy();
                }

                controllers.clear();

                if (
                    root[
                        VISUALIZATION_SYMBOL
                    ] ===
                        visualization
                ) {
                    delete root[
                        VISUALIZATION_SYMBOL
                    ];
                }

                if (
                    context.forcegraph ===
                        visualization
                ) {
                    delete context.forcegraph;
                }

                if (
                    context.forcegraphController
                ) {
                    delete context.forcegraphController;
                }

                return true;
            },

            Controller:
                ForceGraphController,

            normalizeGraph,

            normalizeRecords,

            extractReferences
        };

        root[
            VISUALIZATION_SYMBOL
        ] =
            visualization;

        context.registerVisualization?.(
            "forcegraph",
            visualization
        );

        context.registerRenderer?.(
            "forcegraph",
            visualization
        );

        context.forcegraph =
            visualization;

        safeDispatch(
            document,
            "speciedex:terminal-forcegraph-ready",
            {
                visualization,
                version:
                    VERSION
            }
        );

        return visualization;
    }

    const commands = [{
        name: "forcegraph",
        category: "visualization",
        description:
            "Render and control an interactive force-directed graph.",
        usage:
            "forcegraph [collection|status|start|stop|pause|resume|simulate|" +
            "filter|group|zoom|pan|fit|focus|neighbors|components|reset|export] [arguments]",
        handler:
            async ({
                args = [],
                context,
                writeJSON,
                write,
                writeError
            }) => {
            const action = String(args[0] || "records");
            const lower = action.toLowerCase();
            const visualization =
                context.forcegraph ||
                initialize(
                    context
                );

            const controller =
                context.forcegraphController ||
                context.terminalForcegraphController ||
                visualization.
                    activeController?.();

            const outputJSON =
                value =>
                    typeof writeJSON ===
                        "function"
                        ? writeJSON(
                            value
                        )
                        : value;

            const outputText =
                (
                    value,
                    type =
                        "data"
                ) =>
                    typeof write ===
                        "function"
                        ? write(
                            value,
                            type
                        )
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

                        case "start":
                            controller.start();
                            return outputText(
                                "ForceGraph started.",
                                "success"
                            );

                        case "stop":
                            controller.stop();
                            return outputText(
                                "ForceGraph stopped.",
                                "success"
                            );

                        case "pause":
                            controller.pause();
                            return outputText(
                                "ForceGraph paused.",
                                "success"
                            );

                        case "resume":
                            controller.resume();
                            return outputText(
                                "ForceGraph resumed.",
                                "success"
                            );

                        case "simulate":
                            controller.simulate(
                                args[1] || 120
                            );
                            return outputJSON(
                                controller.status()
                            );

                        case "simulate-async":
                            return outputJSON(
                                await controller.simulateAsync(
                                    args[1] || 120,
                                    {
                                        signal:
                                            context.signal
                                    }
                                )
                            );

                        case "filter":
                            return outputJSON({
                                query: controller.setFilter(
                                    args.slice(1).join(" ")
                                ),
                                status: controller.status()
                            });

                        case "group":
                            return outputJSON({
                                group: controller.setGroup(
                                    args.slice(1).join(" ") || null
                                ),
                                status: controller.status()
                            });

                        case "zoom":
                            if (args[1] === undefined) {
                                return outputJSON({
                                    zoom:
                                        controller.transform.zoom
                                });
                            }

                            return outputJSON({
                                zoom: controller.setZoom(
                                    args[1]
                                )
                            });

                        case "pan":
                            return outputJSON({
                                transform: controller.panBy(
                                    args[1],
                                    args[2]
                                )
                            });

                        case "fit":
                            return outputJSON({
                                transform:
                                    controller.fitView({
                                        padding:
                                            args[1]
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
                                            zoom:
                                                args[2]
                                        }
                                    )
                            });

                        case "neighbors":
                            if (!args[1]) {
                                throw new Error(
                                    "A node ID is required."
                                );
                            }

                            return outputJSON({
                                node:
                                    args[1],
                                depth:
                                    Number(args[2]) || 1,
                                neighbors:
                                    controller.neighbors(
                                        args[1],
                                        args[2]
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

                        case "reset":
                            return outputJSON({
                                transform:
                                    controller.resetView()
                            });

                        case "export":
                            return outputText(
                                controller.export(
                                    args[1] || "json"
                                ),
                                "data"
                            );

                        default:
                            break;
                    }
                }

                const collection =
                    action;

                const libraryValue =
                    context.library?.
                        get?.(
                            collection
                        );

                const resolvedLibrary =
                    libraryValue &&
                    typeof libraryValue.then ===
                        "function"
                        ? await libraryValue
                        : libraryValue;

                const stateValue =
                    context.state?.
                        get?.(
                            `library.${collection}`,
                            []
                        );

                const resolvedState =
                    stateValue &&
                    typeof stateValue.then ===
                        "function"
                        ? await stateValue
                        : stateValue;

                const data =
                    resolvedLibrary !==
                        undefined &&
                    resolvedLibrary !==
                        null
                        ? resolvedLibrary
                        : resolvedState ??
                          [];

                return visualization.render(
                    data,
                    {
                        ...context.config?.
                            forcegraph,
                        label:
                            `ForceGraph for ${collection}`
                    }
                );
            } catch (error) {
                if (typeof writeError === "function") {
                    writeError(error.message);
                    return null;
                }

                throw error;
            }
        }
    }];

    const api = Object.freeze({
        name:
            MODULE_NAME,
        version:
            VERSION,
        VISUALIZATION_SYMBOL,
        CONTROLLER_SYMBOL,
        ForceGraphController,
        normalizeGraph,
        normalizeRecords,
        extractReferences,
        createAbortError,
        mount,
        render,
        initialize,
        init: initialize,
        setup: initialize,
        unmount(context = {}) {
            const visualization =
                context.forcegraph;

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

    window.SpeciedexTerminalForceGraph = api;
    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

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
