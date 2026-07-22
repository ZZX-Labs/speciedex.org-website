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

    const MODULE_NAME = "Sankey";
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

        if (value === null || value === undefined || typeof value !== "object") {
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
        const maxNodes = parseNumber(
            options.maxNodes,
            DEFAULT_MAX_NODES,
            1,
            100000
        );
        const maxLinks = parseNumber(
            options.maxLinks,
            DEFAULT_MAX_LINKS,
            0,
            1000000
        );
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
        const seen = new Set();

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
                const existing = links.find((link) => link.id === key);

                if (existing) {
                    existing.value += parseNumber(
                        value,
                        1,
                        0.000001,
                        1e15
                    );
                }

                return false;
            }

            seen.add(key);

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
        const visiting = new Set();
        const visited = new Set();
        let cycles = 0;

        const visit = (node) => {
            if (visited.has(node.id)) {
                return;
            }

            visiting.add(node.id);

            for (const link of node.outgoing) {
                const target = graph.byId.get(link.target);

                if (!target) {
                    continue;
                }

                if (visiting.has(target.id)) {
                    link.cyclic = true;
                    cycles += 1;
                    continue;
                }

                visit(target);
            }

            visiting.delete(node.id);
            visited.add(node.id);
        };

        graph.nodes.forEach(visit);
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
                errors: 0
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

            this._cleanupResize = createResizeObserver(
                this.canvas,
                () => this.resize()
            );

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
                    "wheel",
                    this._boundWheel,
                    { passive: false }
                );
                this.canvas.addEventListener(
                    "click",
                    this._boundClick
                );
                this.canvas.addEventListener(
                    "keydown",
                    this._boundKeydown
                );
            }

            this.resize();
            this.setData(data);
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

            const rectangle =
                this.canvas.getBoundingClientRect();
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
            this.layout();
            this.draw();

            this._emit("resize", clone(this.bounds));
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

            this.metrics.visibleNodes =
                this.graph.nodes.filter(
                    (node) => node.visible
                ).length;
            this.metrics.visibleLinks =
                this.graph.links.filter(
                    (link) => link.visible
                ).length;
        }

        layout() {
            const nodes =
                this.graph.nodes.filter(
                    (node) => node.visible
                );
            const links =
                this.graph.links.filter(
                    (link) => link.visible
                );

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
                const alpha =
                    1 -
                    iteration /
                    iterations;

                for (
                    let depth = 1;
                    depth < this.layers.length;
                    depth += 1
                ) {
                    for (
                        const node
                        of this.layers[depth]
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
                        const node
                        of this.layers[depth]
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
            for (
                let index =
                    this.graph.nodes.length - 1;
                index >= 0;
                index -= 1
            ) {
                const node =
                    this.graph.nodes[index];

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
                    this.graph.links.length - 1;
                index >= 0;
                index -= 1
            ) {
                const link =
                    this.graph.links[index];

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
            if (this.drag) {
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
            this.draw();
            return this.transform.zoom;
        }

        panBy(x, y) {
            this.transform.x +=
                Number(x) || 0;
            this.transform.y +=
                Number(y) || 0;
            this.metrics.pans += 1;
            this.draw();

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
                    item.incoming.map(
                        (link) => link.id
                    ),
                outgoing:
                    item.outgoing.map(
                        (link) => link.id
                    ),
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
                        options.alignment ||
                        this.options.alignment,
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
                            ? Boolean(
                                options.showLabels
                            )
                            : this.options.showLabels,
                    showValues:
                        options.showValues !== undefined
                            ? Boolean(
                                options.showValues
                            )
                            : this.options.showValues,
                    showLinks:
                        options.showLinks !== undefined
                            ? Boolean(
                                options.showLinks
                            )
                            : this.options.showLinks,
                    showGroups:
                        options.showGroups !== undefined
                            ? Boolean(
                                options.showGroups
                            )
                            : this.options.showGroups,
                    showCycles:
                        options.showCycles !== undefined
                            ? Boolean(
                                options.showCycles
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
                            ? Boolean(
                                options.inferHierarchy
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
                                    const text =
                                        String(
                                            value ?? ""
                                        );

                                    return /[",\n\r]/.test(
                                        text
                                    )
                                        ? `"${text.replace(
                                            /"/g,
                                            '""'
                                        )}"`
                                        : text;
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
                    "wheel",
                    this._boundWheel
                );
                this.canvas.removeEventListener(
                    "click",
                    this._boundClick
                );
                this.canvas.removeEventListener(
                    "keydown",
                    this._boundKeydown
                );
            }

            this.graph = {
                nodes: [],
                links: [],
                byId: new Map()
            };
            this.layers = [];
            this.destroyed = true;

            this._emit("destroy", {});
            return true;
        }
    }

    function mount(target, data = [], options = {}) {
        return new SankeyController(
            target,
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
            new SankeyController(
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

        container.controller =
            controller;
        container.canvas =
            canvas;
        container.data =
            controller.graph;
        container.destroy = () =>
            controller.destroy();

        return container;
    }

    function initialize(context = {}) {
        const dataset =
            context.root?.dataset || {};
        const config =
            context.config?.sankey || {};

        const defaults = {
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

        const visualization = {
            mount(target, data = [], options = {}) {
                return new SankeyController(
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
                SankeyController,

            normalizeGraph,

            normalizeRecords,

            detectCycles,

            extractReferences
        };

        context.registerVisualization?.(
            "sankey",
            visualization
        );
        context.registerRenderer?.(
            "sankey",
            visualization
        );
        context.sankey =
            visualization;

        safeDispatch(
            document,
            "speciedex:terminal-sankey-ready",
            {
                visualization
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
            "reset|export] [arguments]",
        handler: ({
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
            const controller =
                context.sankeyController ||
                context.terminalSankeyController;

            try {
                if (controller) {
                    switch (lower) {
                        case "status":
                        case "show":
                        case "info":
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
                                        args.slice(1).join(" ") ||
                                        null
                                    ),
                                status:
                                    controller.status()
                            });

                        case "alignment":
                            if (!args[1]) {
                                return writeJSON({
                                    alignment:
                                        controller.options.alignment
                                });
                            }

                            controller.update({
                                alignment:
                                    args[1]
                            });

                            return writeJSON({
                                alignment:
                                    controller.options.alignment
                            });

                        case "zoom":
                            if (
                                args[1] ===
                                undefined
                            ) {
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
                                    args[1] ||
                                    "json"
                                ),
                                "data"
                            );

                        default:
                            break;
                    }
                }

                const collection =
                    action;
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
        SankeyController,
        normalizeGraph,
        normalizeRecords,
        detectCycles,
        extractReferences,
        mount,
        render,
        initialize,
        init: initialize,
        setup: initialize,
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
