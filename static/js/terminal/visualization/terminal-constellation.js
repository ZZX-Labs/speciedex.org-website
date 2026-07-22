/*
========================================================================
Speciedex.org
Terminal Constellation Visualization
========================================================================

Interactive force-directed graph renderer for Speciedex records. Supports
taxonomic clustering, relationship extraction, weighted links, deterministic
layout, zoom, pan, selection, hover inspection, filtering, animation, exports,
responsive rendering, accessibility, and runtime updates.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Constellation";
    const DEFAULT_WIDTH = 960;
    const DEFAULT_HEIGHT = 540;
    const DEFAULT_BACKGROUND = "#020a05";
    const DEFAULT_FOREGROUND = "#c0d674";
    const DEFAULT_HIGHLIGHT = "#eef7c8";
    const DEFAULT_EDGE = "#35503a";
    const DEFAULT_NODE_RADIUS = 5;
    const DEFAULT_MAX_NODES = 2000;
    const DEFAULT_MAX_EDGES = 10000;
    const DEFAULT_CHARGE = 120;
    const DEFAULT_LINK_DISTANCE = 82;
    const DEFAULT_DAMPING = 0.88;
    const DEFAULT_TIMESTEP = 0.016;
    const DEFAULT_ALPHA_DECAY = 0.018;
    const DEFAULT_MIN_ALPHA = 0.002;
    const MAX_LABELS = 150;

    function now() {
        return performance.now();
    }

    function iso() {
        return new Date().toISOString();
    }

    function isObject(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    function clone(value) {
        if (typeof structuredClone === "function") {
            try {
                return structuredClone(value);
            } catch (error) {
                /* Fall through. */
            }
        }

        if (value === undefined || value === null || typeof value !== "object") {
            return value;
        }

        try {
            return JSON.parse(JSON.stringify(value));
        } catch (error) {
            return value;
        }
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
            const existing = target.querySelector("canvas");

            if (existing) {
                return existing;
            }

            const canvas = document.createElement("canvas");
            target.appendChild(canvas);
            return canvas;
        }

        throw new TypeError(
            "Constellation requires a canvas or container element."
        );
    }

    function createResizeObserver(element, callback) {
        if (typeof ResizeObserver === "function") {
            const observer = new ResizeObserver(callback);
            observer.observe(element);
            return () => observer.disconnect();
        }

        window.addEventListener("resize", callback);
        return () => window.removeEventListener("resize", callback);
    }

    function normalizeRecords(data) {
        if (data === null || data === undefined) {
            return [];
        }

        if (Array.isArray(data)) {
            return data;
        }

        if (isObject(data)) {
            for (const key of [
                "records",
                "results",
                "items",
                "nodes",
                "data"
            ]) {
                if (Array.isArray(data[key])) {
                    return data[key];
                }
            }

            return [data];
        }

        return [data];
    }

    function seededRandom(seed) {
        let value = 2166136261;

        for (const character of String(seed || "speciedex")) {
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

        return String(
            firstValue(record, [
                "speciedex_id",
                "speciedexId",
                "canonical_id",
                "canonicalId",
                "taxon_id",
                "taxonId",
                "id",
                "key",
                "uuid"
            ], `node-${index + 1}`)
        );
    }

    function nodeLabel(record, index) {
        if (!isObject(record)) {
            return String(record ?? `Node ${index + 1}`);
        }

        return String(
            firstValue(record, [
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
            ], `Node ${index + 1}`)
        );
    }

    function nodeGroup(record) {
        if (!isObject(record)) {
            return "ungrouped";
        }

        return String(
            firstValue(record, [
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
            ], "ungrouped")
        );
    }

    function nodeWeight(record) {
        if (!isObject(record)) {
            return 1;
        }

        for (const key of [
            "weight",
            "value",
            "count",
            "abundance",
            "occurrenceCount",
            "occurrence_count",
            "score"
        ]) {
            const value = Number(record[key]);

            if (Number.isFinite(value)) {
                return Math.max(0.01, value);
            }
        }

        return 1;
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

            if (Array.isArray(value)) {
                for (const item of value) {
                    if (isObject(item)) {
                        references.push({
                            target: String(
                                firstValue(item, [
                                    "target",
                                    "targetId",
                                    "id",
                                    "key",
                                    "taxonId"
                                ], "")
                            ),
                            type: String(
                                firstValue(item, [
                                    "type",
                                    "relationship",
                                    "kind"
                                ], key)
                            ),
                            weight: parseNumber(
                                item.weight,
                                1,
                                0.01,
                                1000000
                            )
                        });
                    } else {
                        references.push({
                            target: String(item),
                            type: key,
                            weight: 1
                        });
                    }
                }
            } else if (isObject(value)) {
                references.push({
                    target: String(
                        firstValue(value, [
                            "target",
                            "targetId",
                            "id",
                            "key",
                            "taxonId"
                        ], "")
                    ),
                    type: String(
                        firstValue(value, [
                            "type",
                            "relationship",
                            "kind"
                        ], key)
                    ),
                    weight: parseNumber(
                        value.weight,
                        1,
                        0.01,
                        1000000
                    )
                });
            } else {
                references.push({
                    target: String(value),
                    type: key,
                    weight: 1
                });
            }
        }

        return references.filter((reference) => reference.target);
    }

    function normalizeGraph(data, options = {}) {
        const records = normalizeRecords(data)
            .slice(0, parseNumber(
                options.maxNodes,
                DEFAULT_MAX_NODES,
                1,
                100000
            ));
        const nodes = [];
        const byId = new Map();
        const random = seededRandom(options.seed || "speciedex-constellation");

        records.forEach((record, index) => {
            const id = nodeId(record, index);

            if (byId.has(id)) {
                return;
            }

            const node = {
                id,
                label: nodeLabel(record, index),
                group: nodeGroup(record),
                weight: nodeWeight(record),
                radius: 0,
                x: random(),
                y: random(),
                vx: 0,
                vy: 0,
                fx: null,
                fy: null,
                degree: 0,
                visible: true,
                selected: false,
                hovered: false,
                index,
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

        for (const node of nodes) {
            const references = extractReferences(
                node.raw,
                options
            );

            for (const reference of references) {
                if (edges.length >= maxEdges) {
                    break;
                }

                if (
                    !byId.has(reference.target) ||
                    reference.target === node.id
                ) {
                    continue;
                }

                const key =
                    `${node.id}|${reference.target}|${reference.type}`;

                if (edgeKeys.has(key)) {
                    continue;
                }

                edgeKeys.add(key);
                const edge = {
                    id: key,
                    source: node.id,
                    target: reference.target,
                    type: reference.type,
                    weight: reference.weight,
                    visible: true
                };

                edges.push(edge);
            }
        }

        if (
            options.inferTaxonomy !== false &&
            edges.length < maxEdges
        ) {
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

                    const parentNode = nodes.find((candidate) =>
                        candidate.label === String(parent) ||
                        candidate.id === String(parent)
                    );

                    if (!parentNode || parentNode.id === node.id) {
                        continue;
                    }

                    const key =
                        `${node.id}|${parentNode.id}|taxonomy`;

                    if (edgeKeys.has(key)) {
                        continue;
                    }

                    edgeKeys.add(key);
                    edges.push({
                        id: key,
                        source: node.id,
                        target: parentNode.id,
                        type: "taxonomy",
                        weight: 1,
                        visible: true
                    });

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
            const source = byId.get(edge.source);
            const target = byId.get(edge.target);

            if (source) source.degree += 1;
            if (target) target.degree += 1;
        }

        return {
            nodes,
            edges,
            byId
        };
    }

    function colorHash(value) {
        let hash = 0;

        for (const character of String(value || "")) {
            hash = ((hash << 5) - hash) + character.charCodeAt(0);
            hash |= 0;
        }

        const hue = Math.abs(hash) % 360;
        return `hsl(${hue} 52% 58%)`;
    }

    class ConstellationController extends EventTarget {
        constructor(target, data = [], options = {}) {
            super();

            this.canvas = resolveCanvas(target);
            this.context = this.canvas.getContext("2d", {
                alpha: true,
                desynchronized: true
            });

            if (!this.context) {
                throw new Error(
                    "Unable to acquire Constellation 2D canvas context."
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
                edgeColor:
                    options.edgeColor ||
                    DEFAULT_EDGE,
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
                    0.08,
                    0,
                    2
                ),
                centering: parseNumber(
                    options.centering,
                    0.012,
                    0,
                    1
                ),
                collisionPadding: parseNumber(
                    options.collisionPadding,
                    2,
                    0,
                    100
                ),
                damping: parseNumber(
                    options.damping,
                    DEFAULT_DAMPING,
                    0,
                    0.999
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
                showLabels:
                    options.showLabels !== false,
                showEdges:
                    options.showEdges !== false,
                showGroups:
                    options.showGroups !== false,
                interactive:
                    options.interactive !== false,
                zoomable:
                    options.zoomable !== false,
                pannable:
                    options.pannable !== false,
                animated:
                    options.animated !== false,
                inferTaxonomy:
                    options.inferTaxonomy !== false,
                seed:
                    options.seed ||
                    "speciedex-constellation",
                label:
                    options.label ||
                    "Constellation visualization"
            };

            this.graph = {
                nodes: [],
                edges: [],
                byId: new Map()
            };
            this.transform = {
                zoom: 1,
                x: 0,
                y: 0
            };
            this.bounds = {
                width: 1,
                height: 1
            };
            this.alpha = 1;
            this.running = false;
            this.paused = false;
            this.destroyed = false;
            this.animationFrame = 0;
            this.lastFrameAt = 0;
            this.hovered = null;
            this.selected = null;
            this.drag = null;
            this.query = "";
            this.groupFilter = null;
            this.lastError = null;
            this.startedAt = null;
            this.metrics = {
                inputRecords: 0,
                nodes: 0,
                edges: 0,
                frames: 0,
                simulations: 0,
                selections: 0,
                zooms: 0,
                pans: 0,
                resizes: 0,
                errors: 0
            };

            this._boundPointerMove = this._handlePointerMove.bind(this);
            this._boundPointerLeave = this._handlePointerLeave.bind(this);
            this._boundPointerDown = this._handlePointerDown.bind(this);
            this._boundPointerUp = this._handlePointerUp.bind(this);
            this._boundWheel = this._handleWheel.bind(this);
            this._boundClick = this._handleClick.bind(this);
            this._boundKeydown = this._handleKeydown.bind(this);

            this._cleanupResize = createResizeObserver(
                this.canvas,
                () => this.resize()
            );

            if (this.options.interactive) {
                this.canvas.tabIndex = this.canvas.tabIndex >= 0
                    ? this.canvas.tabIndex
                    : 0;
                this.canvas.setAttribute(
                    "aria-label",
                    this.options.label
                );
                this.canvas.addEventListener(
                    "pointermove",
                    this._boundPointerMove
                );
                this.canvas.addEventListener(
                    "pointerleave",
                    this._boundPointerLeave
                );
                this.canvas.addEventListener(
                    "pointerdown",
                    this._boundPointerDown
                );
                this.canvas.addEventListener(
                    "pointerup",
                    this._boundPointerUp
                );
                this.canvas.addEventListener(
                    "click",
                    this._boundClick
                );
                this.canvas.addEventListener(
                    "keydown",
                    this._boundKeydown
                );
                this.canvas.addEventListener(
                    "wheel",
                    this._boundWheel,
                    { passive: false }
                );
            }

            this.resize();
            this.setData(data);

            if (this.options.animated) {
                this.start();
            } else {
                this.simulate(120);
                this.draw();
            }
        }

        _emit(type, detail = {}) {
            safeDispatch(this, type, {
                type,
                timestamp: iso(),
                ...detail
            });
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
                return;
            }

            const rectangle = this.canvas.getBoundingClientRect();
            const ratio = Math.min(
                window.devicePixelRatio || 1,
                2
            );
            const width = Math.max(
                1,
                Math.floor(rectangle.width * ratio)
            );
            const height = Math.max(
                1,
                Math.floor(rectangle.height * ratio)
            );

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

            this.bounds.width =
                rectangle.width || DEFAULT_WIDTH;
            this.bounds.height =
                rectangle.height || DEFAULT_HEIGHT;
            this.metrics.resizes += 1;

            this._rescaleInitialPositions();
            this.alpha = Math.max(this.alpha, 0.25);
            this.draw();

            this._emit("resize", {
                width: this.bounds.width,
                height: this.bounds.height
            });
        }

        _rescaleInitialPositions() {
            for (const node of this.graph.nodes) {
                if (node.x >= 0 && node.x <= 1) {
                    node.x *= this.bounds.width;
                }

                if (node.y >= 0 && node.y <= 1) {
                    node.y *= this.bounds.height;
                }

                node.x = Math.max(
                    0,
                    Math.min(this.bounds.width, node.x)
                );
                node.y = Math.max(
                    0,
                    Math.min(this.bounds.height, node.y)
                );
            }
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
                this.metrics.edges =
                    this.graph.edges.length;
                this.alpha = 1;
                this.hovered = null;
                this.selected = null;
                this._rescaleInitialPositions();
                this._updateNodeRadii();
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

        _updateNodeRadii() {
            const weights = this.graph.nodes.map(
                (node) => node.weight + node.degree
            );
            const minimum = Math.min(...weights, 1);
            const maximum = Math.max(...weights, 1);
            const range = Math.max(1e-9, maximum - minimum);

            for (const node of this.graph.nodes) {
                const ratio =
                    (
                        node.weight +
                        node.degree -
                        minimum
                    ) /
                    range;
                node.radius =
                    this.options.nodeRadius *
                    (0.75 + Math.sqrt(ratio) * 1.85);
            }
        }

        _applyFilters() {
            const query = this.query.toLowerCase();

            for (const node of this.graph.nodes) {
                node.visible =
                    (
                        !query ||
                        node.label.toLowerCase().includes(query) ||
                        node.id.toLowerCase().includes(query) ||
                        node.group.toLowerCase().includes(query)
                    ) &&
                    (
                        !this.groupFilter ||
                        node.group === this.groupFilter
                    );
            }

            for (const edge of this.graph.edges) {
                const source =
                    this.graph.byId.get(edge.source);
                const target =
                    this.graph.byId.get(edge.target);

                edge.visible =
                    Boolean(
                        source?.visible &&
                        target?.visible
                    );
            }
        }

        start() {
            if (this.destroyed) {
                throw new Error(
                    "Constellation controller has been destroyed."
                );
            }

            if (this.running && !this.paused) {
                return this;
            }

            this.running = true;
            this.paused = false;
            this.startedAt =
                this.startedAt || iso();
            this.lastFrameAt = 0;

            this.animationFrame =
                window.requestAnimationFrame(
                    (timestamp) => this._frame(timestamp)
                );

            this._emit("start", {});
            return this;
        }

        stop() {
            const wasRunning =
                this.running || this.paused;

            this.running = false;
            this.paused = false;

            if (this.animationFrame) {
                window.cancelAnimationFrame(
                    this.animationFrame
                );
                this.animationFrame = 0;
            }

            if (wasRunning) {
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
                window.cancelAnimationFrame(
                    this.animationFrame
                );
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
            this.animationFrame =
                window.requestAnimationFrame(
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
                ? Math.min(50, timestamp - this.lastFrameAt)
                : 16.667;
            this.lastFrameAt = timestamp;

            if (this.alpha > this.options.minAlpha) {
                this._simulateStep(
                    delta / 1000
                );
            }

            this.draw();
            this.metrics.frames += 1;

            this.animationFrame =
                window.requestAnimationFrame(
                    (nextTimestamp) =>
                        this._frame(nextTimestamp)
                );
        }

        simulate(iterations = 1) {
            const count = parseNumber(
                iterations,
                1,
                1,
                100000
            );

            for (let index = 0; index < count; index += 1) {
                this._simulateStep(
                    DEFAULT_TIMESTEP
                );
            }

            this.draw();
            return this;
        }

        _simulateStep(delta) {
            const nodes = this.graph.nodes.filter(
                (node) => node.visible
            );
            const edges = this.graph.edges.filter(
                (edge) => edge.visible
            );

            if (!nodes.length) {
                return;
            }

            const centerX = this.bounds.width / 2;
            const centerY = this.bounds.height / 2;

            for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
                const left = nodes[leftIndex];

                for (
                    let rightIndex = leftIndex + 1;
                    rightIndex < nodes.length;
                    rightIndex += 1
                ) {
                    const right = nodes[rightIndex];
                    let dx = right.x - left.x;
                    let dy = right.y - left.y;
                    let distanceSquared =
                        dx * dx + dy * dy;

                    if (distanceSquared < 0.01) {
                        dx = 0.1;
                        dy = 0.1;
                        distanceSquared = 0.02;
                    }

                    const distance = Math.sqrt(distanceSquared);
                    const force =
                        (
                            this.options.charge *
                            this.alpha
                        ) /
                        distanceSquared;
                    const fx =
                        force * dx / distance;
                    const fy =
                        force * dy / distance;

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
                        const overlap =
                            minimumDistance - distance;
                        const push =
                            overlap * 0.12;

                        if (left.fx === null) {
                            left.vx -=
                                push * dx / distance;
                            left.vy -=
                                push * dy / distance;
                        }

                        if (right.fx === null) {
                            right.vx +=
                                push * dx / distance;
                            right.vy +=
                                push * dy / distance;
                        }
                    }
                }
            }

            for (const edge of edges) {
                const source =
                    this.graph.byId.get(edge.source);
                const target =
                    this.graph.byId.get(edge.target);

                if (!source || !target) {
                    continue;
                }

                let dx = target.x - source.x;
                let dy = target.y - source.y;
                let distance =
                    Math.sqrt(dx * dx + dy * dy);

                if (distance < 0.01) {
                    distance = 0.01;
                }

                const desired =
                    this.options.linkDistance /
                    Math.max(
                        0.4,
                        Math.sqrt(edge.weight)
                    );
                const difference =
                    distance - desired;
                const force =
                    difference *
                    this.options.linkStrength *
                    this.alpha;
                const fx =
                    force * dx / distance;
                const fy =
                    force * dy / distance;

                if (source.fx === null) {
                    source.vx += fx;
                    source.vy += fy;
                }

                if (target.fx === null) {
                    target.vx -= fx;
                    target.vy -= fy;
                }
            }

            const groupCenters = new Map();
            const groups = Array.from(
                new Set(nodes.map((node) => node.group))
            );

            groups.forEach((group, index) => {
                const angle =
                    (
                        index /
                        Math.max(1, groups.length)
                    ) *
                    Math.PI *
                    2;
                const radius =
                    Math.min(
                        this.bounds.width,
                        this.bounds.height
                    ) *
                    0.22;

                groupCenters.set(group, {
                    x: centerX + Math.cos(angle) * radius,
                    y: centerY + Math.sin(angle) * radius
                });
            });

            for (const node of nodes) {
                const groupCenter =
                    groupCenters.get(node.group) || {
                        x: centerX,
                        y: centerY
                    };

                if (node.fx === null) {
                    node.vx +=
                        (
                            groupCenter.x - node.x
                        ) *
                        this.options.centering *
                        this.alpha;
                    node.vy +=
                        (
                            groupCenter.y - node.y
                        ) *
                        this.options.centering *
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
                    Math.min(
                        this.bounds.width - margin,
                        node.x
                    )
                );
                node.y = Math.max(
                    margin,
                    Math.min(
                        this.bounds.height - margin,
                        node.y
                    )
                );
            }

            this.alpha *=
                1 - this.options.alphaDecay;
            this.metrics.simulations += 1;
        }

        _screenPoint(x, y) {
            const centerX =
                this.bounds.width / 2;
            const centerY =
                this.bounds.height / 2;

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

            if (!this.graph.nodes.length) {
                this.context.fillStyle =
                    this.options.foreground;
                this.context.globalAlpha = 0.7;
                this.context.font =
                    '14px "IBM Plex Mono", monospace';
                this.context.textAlign = "center";
                this.context.textBaseline = "middle";
                this.context.fillText(
                    "No constellation nodes.",
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
            this.context.lineWidth = 1;

            for (const edge of this.graph.edges) {
                if (!edge.visible) {
                    continue;
                }

                const source =
                    this.graph.byId.get(edge.source);
                const target =
                    this.graph.byId.get(edge.target);

                if (!source || !target) {
                    continue;
                }

                const start =
                    this._screenPoint(
                        source.x,
                        source.y
                    );
                const end =
                    this._screenPoint(
                        target.x,
                        target.y
                    );
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
                    emphasized
                        ? 0.85
                        : 0.28;
                this.context.lineWidth =
                    emphasized
                        ? 1.8
                        : Math.min(
                            2,
                            0.5 +
                            Math.sqrt(edge.weight) * 0.3
                        );
                this.context.beginPath();
                this.context.moveTo(
                    start.x,
                    start.y
                );
                this.context.lineTo(
                    end.x,
                    end.y
                );
                this.context.stroke();
            }

            this.context.restore();
        }

        _drawNodes() {
            this.context.save();

            for (const node of this.graph.nodes) {
                if (!node.visible) {
                    continue;
                }

                const point =
                    this._screenPoint(
                        node.x,
                        node.y
                    );
                const radius =
                    node.radius *
                    Math.sqrt(
                        this.transform.zoom
                    );
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
                    emphasized
                        ? 1
                        : 0.82;

                if (emphasized) {
                    this.context.shadowColor =
                        this.options.highlight;
                    this.context.shadowBlur = 12;
                } else {
                    this.context.shadowBlur = 0;
                }

                this.context.fill();

                this.context.strokeStyle =
                    this.options.background;
                this.context.globalAlpha = 0.75;
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
            this.context.textBaseline = "middle";
            this.context.textAlign = "left";

            for (const node of visible) {
                if (
                    this.transform.zoom < 0.8 &&
                    node !== this.selected &&
                    node !== this.hovered
                ) {
                    continue;
                }

                const point =
                    this._screenPoint(
                        node.x,
                        node.y
                    );
                this.context.fillStyle =
                    node.id === this.selected?.id ||
                    node.id === this.hovered?.id
                        ? this.options.highlight
                        : this.options.foreground;
                this.context.globalAlpha =
                    node.id === this.selected?.id ||
                    node.id === this.hovered?.id
                        ? 1
                        : 0.68;
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

                const point =
                    this._screenPoint(
                        node.x,
                        node.y
                    );
                const radius =
                    node.radius *
                    Math.sqrt(this.transform.zoom) +
                    4;
                const dx = x - point.x;
                const dy = y - point.y;

                if (
                    dx * dx + dy * dy <=
                    radius * radius
                ) {
                    return node;
                }
            }

            return null;
        }

        _handlePointerMove(event) {
            const point =
                this._pointFromEvent(event);

            if (this.drag?.node) {
                const world =
                    this._inverseScreenPoint(
                        point.x,
                        point.y
                    );
                this.drag.node.fx = world.x;
                this.drag.node.fy = world.y;
                this.drag.node.x = world.x;
                this.drag.node.y = world.y;
                this.alpha = Math.max(
                    this.alpha,
                    0.12
                );
                this.draw();
                return;
            }

            if (this.drag?.pan) {
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
                hovered?.id !== this.hovered?.id;

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
                    node:
                        hovered
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
                this._emit("hover", {
                    node: null
                });
            }
        }

        _handlePointerDown(event) {
            if (event.button !== 0) {
                return;
            }

            const point =
                this._pointFromEvent(event);
            const node =
                this.hitTest(
                    point.x,
                    point.y
                );

            if (node) {
                this.drag = {
                    node
                };
                const world =
                    this._inverseScreenPoint(
                        point.x,
                        point.y
                    );
                node.fx = world.x;
                node.fy = world.y;
            } else if (this.options.pannable) {
                this.drag = {
                    pan: true,
                    startX: point.x,
                    startY: point.y,
                    originX: this.transform.x,
                    originY: this.transform.y
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

            if (this.drag.node) {
                this.drag.node.fx = null;
                this.drag.node.fy = null;
                this.alpha = Math.max(
                    this.alpha,
                    0.18
                );
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
            const zoom = Math.max(
                0.2,
                Math.min(
                    12,
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
            if (this.drag) {
                return;
            }

            const point =
                this._pointFromEvent(event);
            const node =
                this.hitTest(
                    point.x,
                    point.y
                );

            this.selected =
                node?.id === this.selected?.id
                    ? null
                    : node;
            this.metrics.selections += 1;
            this.draw();

            this._emit("select", {
                node:
                    this.selected
                        ? this.describeNode(
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
                    this.transform.zoom * 1.2
                );
            } else if (event.key === "-") {
                event.preventDefault();
                this.setZoom(
                    this.transform.zoom / 1.2
                );
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
                    parseNumber(
                        value,
                        this.transform.zoom
                    )
                )
            );
            this.draw();

            this._emit("zoom", {
                zoom:
                    this.transform.zoom,
                transform:
                    clone(this.transform)
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
            this.alpha = Math.max(
                this.alpha,
                0.2
            );
            this.draw();

            this._emit("filter", {
                query: this.query,
                visible:
                    this.graph.nodes.filter(
                        (node) => node.visible
                    ).length
            });

            return this.query;
        }

        setGroup(group = null) {
            this.groupFilter =
                group ? String(group) : null;
            this._applyFilters();
            this.alpha = Math.max(
                this.alpha,
                0.2
            );
            this.draw();

            return this.groupFilter;
        }

        selectNode(id) {
            const node =
                this.graph.byId.get(String(id));

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

            const connections =
                this.graph.edges
                    .filter((edge) =>
                        edge.source === node.id ||
                        edge.target === node.id
                    )
                    .map((edge) => ({
                        ...edge,
                        sourceLabel:
                            this.graph.byId.get(
                                edge.source
                            )?.label || edge.source,
                        targetLabel:
                            this.graph.byId.get(
                                edge.target
                            )?.label || edge.target
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
                connections,
                raw: clone(node.raw)
            };
        }

        update(options = {}) {
            if (!isObject(options)) {
                throw new TypeError(
                    "Constellation options must be an object."
                );
            }

            const rebuildRequired = [
                "maxNodes",
                "maxEdges",
                "inferTaxonomy",
                "edgeKeys",
                "seed"
            ].some((key) =>
                options[key] !== undefined
            );

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
                    options.showLabels !== undefined
                        ? Boolean(options.showLabels)
                        : this.options.showLabels,
                showEdges:
                    options.showEdges !== undefined
                        ? Boolean(options.showEdges)
                        : this.options.showEdges,
                showGroups:
                    options.showGroups !== undefined
                        ? Boolean(options.showGroups)
                        : this.options.showGroups,
                inferTaxonomy:
                    options.inferTaxonomy !== undefined
                        ? Boolean(options.inferTaxonomy)
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
                    this.graph.nodes.map(
                        (node) => node.raw
                    )
                );
            } else {
                this._updateNodeRadii();
                this.alpha = Math.max(
                    this.alpha,
                    0.2
                );
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
                        generatedAt: iso(),
                        options:
                            this.options,
                        transform:
                            this.transform,
                        nodes:
                            this.graph.nodes.map(
                                (node) =>
                                    this.describeNode(node)
                            ),
                        edges:
                            this.graph.edges.map(clone)
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
                            const text =
                                String(value ?? "");

                            return /[",\n\r]/.test(text)
                                ? `"${text.replace(/"/g, '""')}"`
                                : text;
                        }).join(",")
                    )
                    .join("\r\n");
            }

            throw new Error(
                `Unsupported Constellation export format: ${format}`
            );
        }

        status() {
            return {
                name: "constellation",
                module: MODULE_NAME,
                running: this.running,
                paused: this.paused,
                nodes: this.graph.nodes.length,
                visibleNodes:
                    this.graph.nodes.filter(
                        (node) => node.visible
                    ).length,
                edges: this.graph.edges.length,
                visibleEdges:
                    this.graph.edges.filter(
                        (edge) => edge.visible
                    ).length,
                alpha: this.alpha,
                query: this.query,
                groupFilter: this.groupFilter,
                transform:
                    clone(this.transform),
                selected:
                    this.selected
                        ? this.describeNode(
                            this.selected
                        )
                        : null,
                hovered:
                    this.hovered
                        ? this.describeNode(
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

            this.stop();
            this._cleanupResize?.();

            if (this.options.interactive) {
                this.canvas.removeEventListener(
                    "pointermove",
                    this._boundPointerMove
                );
                this.canvas.removeEventListener(
                    "pointerleave",
                    this._boundPointerLeave
                );
                this.canvas.removeEventListener(
                    "pointerdown",
                    this._boundPointerDown
                );
                this.canvas.removeEventListener(
                    "pointerup",
                    this._boundPointerUp
                );
                this.canvas.removeEventListener(
                    "click",
                    this._boundClick
                );
                this.canvas.removeEventListener(
                    "keydown",
                    this._boundKeydown
                );
                this.canvas.removeEventListener(
                    "wheel",
                    this._boundWheel
                );
            }

            this.graph = {
                nodes: [],
                edges: [],
                byId: new Map()
            };
            this.destroyed = true;
            this._emit("destroy", {});
            return true;
        }
    }

    function mount(target, data = [], options = {}) {
        return new ConstellationController(
            target,
            data,
            options
        );
    }

    function render(data = [], options = {}) {
        const container = createElement(
            "section",
            "terminal-visualization terminal-visualization-constellation"
        );
        container.dataset.visualization = "constellation";
        container.setAttribute("role", "region");
        container.setAttribute(
            "aria-label",
            options.label ||
            "Constellation visualization"
        );

        const canvas = document.createElement("canvas");
        canvas.className =
            "terminal-constellation-canvas";
        canvas.width =
            Number(options.width) ||
            DEFAULT_WIDTH;
        canvas.height =
            Number(options.height) ||
            DEFAULT_HEIGHT;
        canvas.setAttribute(
            "aria-label",
            options.label ||
            "Constellation visualization"
        );

        const status = createElement(
            "div",
            "terminal-constellation-status"
        );
        status.setAttribute(
            "aria-live",
            "polite"
        );

        const tooltip = createElement(
            "div",
            "terminal-constellation-tooltip"
        );
        tooltip.hidden = true;

        container.append(
            canvas,
            status,
            tooltip
        );

        const controller = new ConstellationController(
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
                `${snapshot.visibleEdges} edge` +
                `${snapshot.visibleEdges === 1 ? "" : "s"} · ` +
                `${snapshot.transform.zoom.toFixed(2)}×`;
        };

        controller.addEventListener(
            "hover",
            (event) => {
                const node =
                    event.detail?.node;

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

        container.controller = controller;
        container.canvas = canvas;
        container.data = controller.graph.nodes;
        container.destroy = () =>
            controller.destroy();

        return container;
    }

    function initialize(context = {}) {
        const dataset =
            context.root?.dataset || {};
        const config =
            context.config?.constellation || {};

        const defaults = {
            background:
                dataset.terminalConstellationBackground ||
                config.background ||
                DEFAULT_BACKGROUND,

            foreground:
                dataset.terminalConstellationForeground ||
                config.foreground ||
                DEFAULT_FOREGROUND,

            highlight:
                dataset.terminalConstellationHighlight ||
                config.highlight ||
                DEFAULT_HIGHLIGHT,

            edgeColor:
                dataset.terminalConstellationEdgeColor ||
                config.edgeColor ||
                DEFAULT_EDGE,

            nodeRadius:
                dataset.terminalConstellationNodeRadius ||
                config.nodeRadius ||
                DEFAULT_NODE_RADIUS,

            charge:
                dataset.terminalConstellationCharge ||
                config.charge ||
                DEFAULT_CHARGE,

            linkDistance:
                dataset.terminalConstellationLinkDistance ||
                config.linkDistance ||
                DEFAULT_LINK_DISTANCE,

            showLabels: parseBoolean(
                dataset.terminalConstellationShowLabels,
                config.showLabels !== false
            ),

            showEdges: parseBoolean(
                dataset.terminalConstellationShowEdges,
                config.showEdges !== false
            ),

            showGroups: parseBoolean(
                dataset.terminalConstellationShowGroups,
                config.showGroups !== false
            ),

            animated: parseBoolean(
                dataset.terminalConstellationAnimated,
                config.animated !== false
            ),

            inferTaxonomy: parseBoolean(
                dataset.terminalConstellationInferTaxonomy,
                config.inferTaxonomy !== false
            ),

            interactive: parseBoolean(
                dataset.terminalConstellationInteractive,
                config.interactive !== false
            )
        };

        const visualization = {
            mount(target, data = [], options = {}) {
                return new ConstellationController(
                    target,
                    data,
                    {
                        ...defaults,
                        ...options
                    }
                );
            },

            render(data = [], options = {}) {
                return render(
                    data,
                    {
                        ...defaults,
                        ...options
                    }
                );
            },

            Controller:
                ConstellationController,

            normalizeGraph,

            normalizeRecords
        };

        context.registerVisualization?.(
            "constellation",
            visualization
        );
        context.registerRenderer?.(
            "constellation",
            visualization
        );
        context.constellation =
            visualization;

        safeDispatch(
            document,
            "speciedex:terminal-constellation-ready",
            {
                visualization
            }
        );

        return visualization;
    }

    const commands = [{
        name: "constellation",
        category: "visualization",
        description:
            "Render and control an interactive force-directed relationship constellation.",
        usage:
            "constellation [collection|status|start|stop|pause|resume|simulate|" +
            "filter|group|zoom|pan|reset|export] [arguments]",
        handler: ({
            args = [],
            context,
            writeJSON,
            write,
            writeError
        }) => {
            const action =
                String(
                    args[0] || "records"
                );
            const lower =
                action.toLowerCase();
            const controller =
                context.constellationController ||
                context.terminalConstellationController;

            try {
                if (controller) {
                    switch (lower) {
                        case "status":
                        case "show":
                        case "info":
                            return writeJSON(
                                controller.status()
                            );

                        case "start":
                            controller.start();
                            return write(
                                "Constellation started.",
                                "success"
                            );

                        case "stop":
                            controller.stop();
                            return write(
                                "Constellation stopped.",
                                "success"
                            );

                        case "pause":
                            controller.pause();
                            return write(
                                "Constellation paused.",
                                "success"
                            );

                        case "resume":
                            controller.resume();
                            return write(
                                "Constellation resumed.",
                                "success"
                            );

                        case "simulate":
                            controller.simulate(
                                args[1] || 120
                            );
                            return writeJSON(
                                controller.status()
                            );

                        case "filter":
                            return writeJSON({
                                query:
                                    controller.setFilter(
                                        args.slice(1).join(" ")
                                    ),
                                status:
                                    controller.status()
                            });

                        case "group":
                            return writeJSON({
                                group:
                                    controller.setGroup(
                                        args.slice(1).join(" ") || null
                                    ),
                                status:
                                    controller.status()
                            });

                        case "zoom":
                            if (args[1] === undefined) {
                                return writeJSON({
                                    zoom:
                                        controller.transform.zoom
                                });
                            }

                            return writeJSON({
                                zoom:
                                    controller.setZoom(
                                        args[1]
                                    )
                            });

                        case "pan":
                            return writeJSON({
                                transform:
                                    controller.panBy(
                                        args[1],
                                        args[2]
                                    )
                            });

                        case "reset":
                            return writeJSON({
                                transform:
                                    controller.resetView()
                            });

                        case "export":
                            return write(
                                controller.export(
                                    args[1] || "json"
                                ),
                                "data"
                            );

                        default:
                            break;
                    }
                }

                const collection = action;
                const data =
                    context.library?.get?.(
                        collection
                    ) ||
                    context.state?.get?.(
                        `library.${collection}`,
                        []
                    ) ||
                    [];

                return render(
                    data,
                    {
                        ...context.config?.constellation,
                        label:
                            `Constellation for ${collection}`
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
        ConstellationController,
        normalizeGraph,
        normalizeRecords,
        extractReferences,
        mount,
        render,
        initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalConstellation =
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
