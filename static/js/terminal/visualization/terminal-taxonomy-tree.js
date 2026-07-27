/*
========================================================================
Speciedex.org
Terminal TaxonomyTree Visualization
========================================================================

Interactive taxonomic hierarchy renderer for Speciedex records. Supports
explicit parent/child taxonomies, lineage inference from canonical rank fields,
rectangular, indented, radial, and icicle layouts, collapse/expand controls,
search, rank filtering, selection, zoom, pan, responsive high-DPI rendering,
JSON, CSV, Newick, and PNG export, diagnostics, and lifecycle control.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "taxonomy-tree";
    const VERSION = "3.0.0";

    const VISUALIZATION_SYMBOL =
        Symbol.for("speciedex.terminal.taxonomy-tree.visualization");

    const CONTROLLER_SYMBOL =
        Symbol.for("speciedex.terminal.taxonomy-tree.controller");
    const DEFAULT_WIDTH = 960;
    const DEFAULT_HEIGHT = 540;
    const DEFAULT_BACKGROUND = "#020a05";
    const DEFAULT_FOREGROUND = "#c0d674";
    const DEFAULT_HIGHLIGHT = "#eef7c8";
    const DEFAULT_BRANCH = "#35503a";
    const DEFAULT_LABEL = "#d8e6db";
    const DEFAULT_NODE_RADIUS = 4;
    const DEFAULT_PADDING = 42;
    const DEFAULT_INDENT = 24;
    const DEFAULT_ROW_HEIGHT = 24;
    const DEFAULT_MAX_NODES = 25000;
    const DEFAULT_ASYNC_BATCH = 4096;
    const DEFAULT_QUERY_LIMIT = 5000;
    const DEFAULT_FIT_PADDING = 28;

    const RANKS = Object.freeze([
        "domain",
        "superkingdom",
        "kingdom",
        "subkingdom",
        "infrakingdom",
        "superphylum",
        "phylum",
        "subphylum",
        "infraphylum",
        "superclass",
        "class",
        "subclass",
        "infraclass",
        "cohort",
        "superorder",
        "order",
        "suborder",
        "infraorder",
        "parvorder",
        "superfamily",
        "family",
        "subfamily",
        "tribe",
        "subtribe",
        "genus",
        "subgenus",
        "section",
        "subsection",
        "series",
        "species",
        "subspecies",
        "variety",
        "subvariety",
        "form",
        "subform",
        "strain",
        "cultivar",
        "unranked"
    ]);

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
        message = "TaxonomyTree operation aborted."
    ) {
        const error = new Error(message);
        error.name = "AbortError";
        error.code = "TAXONOMY_TREE_ABORTED";
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
            value === undefined ||
            value === null ||
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
            "TaxonomyTree requires a canvas or container element."
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
            return data.slice(0, DEFAULT_MAX_NODES);
        }

        if (isObject(data)) {
            for (const key of [
                "records",
                "results",
                "items",
                "taxa",
                "nodes",
                "data"
            ]) {
                if (Array.isArray(data[key])) {
                    return data[key].slice(0, DEFAULT_MAX_NODES);
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

    function normalizeRank(value) {
        const rank = String(value || "unranked")
            .trim()
            .toLowerCase()
            .replace(/[\s-]+/g, "_");

        const aliases = {
            division: "phylum",
            sub_division: "subphylum",
            forma: "form",
            varietas: "variety",
            no_rank: "unranked",
            clade: "unranked"
        };

        return aliases[rank] || rank;
    }

    function rankIndex(rank) {
        const index = RANKS.indexOf(normalizeRank(rank));
        return index === -1 ? RANKS.length : index;
    }

    function idForRecord(record, index) {
        if (!isObject(record)) {
            return `taxon-${index + 1}`;
        }

        return String(firstValue(record, [
            "speciedex_id",
            "speciedexId",
            "taxon_id",
            "taxonId",
            "canonical_id",
            "canonicalId",
            "accepted_id",
            "acceptedId",
            "id",
            "key",
            "uuid"
        ], `taxon-${index + 1}`));
    }

    function labelForRecord(record, index) {
        if (!isObject(record)) {
            return String(record ?? `Taxon ${index + 1}`);
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
        ], `Taxon ${index + 1}`));
    }

    function rankForRecord(record) {
        if (!isObject(record)) {
            return "unranked";
        }

        return normalizeRank(firstValue(record, [
            "rank",
            "taxon_rank",
            "taxonRank",
            "taxonomic_rank",
            "taxonomicRank"
        ], "unranked"));
    }

    function parentIdForRecord(record) {
        if (!isObject(record)) {
            return null;
        }

        const value = firstValue(record, [
            "parent_id",
            "parentId",
            "parent_taxon_id",
            "parentTaxonId",
            "accepted_parent_id",
            "acceptedParentId"
        ], null);

        return value === null ? null : String(value);
    }

    function statusForRecord(record) {
        if (!isObject(record)) {
            return "unknown";
        }

        return String(firstValue(record, [
            "status",
            "taxonomic_status",
            "taxonomicStatus",
            "accepted_status",
            "acceptedStatus"
        ], "unknown"));
    }

    function authorityForRecord(record) {
        if (!isObject(record)) {
            return "";
        }

        return String(firstValue(record, [
            "authority",
            "scientific_name_authorship",
            "scientificNameAuthorship",
            "authorship"
        ], ""));
    }

    function weightForRecord(record) {
        if (!isObject(record)) {
            return 1;
        }

        for (const key of [
            "weight",
            "count",
            "value",
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

    function inferParent(node, labelMap) {
        if (!isObject(node.raw)) {
            return null;
        }

        const currentIndex = rankIndex(node.rank);

        for (
            let index = currentIndex - 1;
            index >= 0;
            index -= 1
        ) {
            const rank = RANKS[index];
            const candidates = [
                rank,
                `${rank}_name`,
                `${rank}Name`
            ];

            for (const key of candidates) {
                const value = node.raw[key];

                if (
                    value !== undefined &&
                    value !== null &&
                    value !== ""
                ) {
                    const match =
                        labelMap.get(
                            String(value)
                        );

                    if (match && match !== node.id) {
                        return match;
                    }
                }
            }
        }

        return null;
    }

    function buildTaxonomy(data, options = {}) {
        const records = normalizeRecords(data).slice(
            0,
            parseNumber(
                options.maxNodes,
                DEFAULT_MAX_NODES,
                1,
                100000
            )
        );
        const nodes = [];
        const byId = new Map();
        const labelMap = new Map();

        records.forEach((record, index) => {
            const id = idForRecord(record, index);

            if (byId.has(id)) {
                return;
            }

            const node = {
                id,
                label: labelForRecord(record, index),
                rank: rankForRecord(record),
                status: statusForRecord(record),
                authority: authorityForRecord(record),
                parentId: parentIdForRecord(record),
                parent: null,
                children: [],
                depth: 0,
                leafCount: 1,
                descendantCount: 0,
                weight: weightForRecord(record),
                collapsed: false,
                visible: true,
                matched: true,
                x: 0,
                y: 0,
                angle: 0,
                radialDistance: 0,
                raw: clone(record)
            };

            nodes.push(node);
            byId.set(id, node);
            labelMap.set(node.label, id);
        });

        if (options.inferLineage !== false) {
            for (const node of nodes) {
                if (node.parentId && byId.has(node.parentId)) {
                    continue;
                }

                const inferred = inferParent(node, labelMap);

                if (inferred) {
                    node.parentId = inferred;
                }
            }
        }

        for (const node of nodes) {
            if (!node.parentId || !byId.has(node.parentId)) {
                continue;
            }

            const parent = byId.get(node.parentId);

            if (parent === node) {
                continue;
            }

            node.parent = parent;
            parent.children.push(node);
        }

        let roots = nodes.filter((node) => !node.parent);

        const visit = (node, depth, stack = new Set()) => {
            if (stack.has(node.id)) {
                node.parent = null;
                node.parentId = null;
                return {
                    leaves: 1,
                    descendants: 0
                };
            }

            const nextStack = new Set(stack);
            nextStack.add(node.id);
            node.depth = depth;

            node.children.sort((left, right) =>
                rankIndex(left.rank) - rankIndex(right.rank) ||
                left.label.localeCompare(right.label)
            );

            if (!node.children.length) {
                node.leafCount = 1;
                node.descendantCount = 0;

                return {
                    leaves: 1,
                    descendants: 0
                };
            }

            let leaves = 0;
            let descendants = node.children.length;

            for (const child of node.children) {
                const result = visit(
                    child,
                    depth + 1,
                    nextStack
                );

                leaves += result.leaves;
                descendants += result.descendants;
            }

            node.leafCount = Math.max(1, leaves);
            node.descendantCount = descendants;

            return {
                leaves: node.leafCount,
                descendants
            };
        };

        roots.forEach((root) =>
            visit(root, 0)
        );

        roots = nodes.filter((node) => !node.parent);
        roots.sort((left, right) =>
            rankIndex(left.rank) - rankIndex(right.rank) ||
            left.label.localeCompare(right.label)
        );

        return {
            nodes,
            roots,
            byId
        };
    }

    class TaxonomyTreeController extends EventTarget {
        constructor(target, data = [], options = {}) {
            super();

            this.canvas = resolveCanvas(target);
            this.context = this.canvas.getContext("2d", {
                alpha: true,
                desynchronized: true
            });

            if (!this.context) {
                throw new Error(
                    "Unable to acquire TaxonomyTree 2D canvas context."
                );
            }

            this.options = {
                layout: [
                    "rectangular",
                    "indented",
                    "radial",
                    "icicle"
                ].includes(options.layout)
                    ? options.layout
                    : "rectangular",
                orientation:
                    options.orientation === "vertical"
                        ? "vertical"
                        : "horizontal",
                background:
                    options.background ||
                    DEFAULT_BACKGROUND,
                foreground:
                    options.foreground ||
                    DEFAULT_FOREGROUND,
                highlight:
                    options.highlight ||
                    DEFAULT_HIGHLIGHT,
                branchColor:
                    options.branchColor ||
                    DEFAULT_BRANCH,
                labelColor:
                    options.labelColor ||
                    DEFAULT_LABEL,
                nodeRadius: parseNumber(
                    options.nodeRadius,
                    DEFAULT_NODE_RADIUS,
                    1,
                    24
                ),
                padding: parseNumber(
                    options.padding,
                    DEFAULT_PADDING,
                    8,
                    240
                ),
                indent: parseNumber(
                    options.indent,
                    DEFAULT_INDENT,
                    8,
                    120
                ),
                rowHeight: parseNumber(
                    options.rowHeight,
                    DEFAULT_ROW_HEIGHT,
                    12,
                    80
                ),
                showLabels:
                    options.showLabels !== false,
                showRanks:
                    options.showRanks !== false,
                showAuthority:
                    options.showAuthority === true,
                showStatus:
                    options.showStatus === true,
                showCounts:
                    options.showCounts === true,
                showInternalNodes:
                    options.showInternalNodes !== false,
                showLeaves:
                    options.showLeaves !== false,
                showGrid:
                    options.showGrid === true,
                inferLineage:
                    options.inferLineage !== false,
                maxNodes: parseNumber(
                    options.maxNodes,
                    DEFAULT_MAX_NODES,
                    1,
                    100000
                ),
                interactive:
                    options.interactive !== false,
                zoomable:
                    options.zoomable !== false,
                pannable:
                    options.pannable !== false,
                label:
                    options.label ||
                    "TaxonomyTree visualization"
            };

            this.taxonomy = {
                nodes: [],
                roots: [],
                byId: new Map()
            };
            this.visibleNodes = [];
            this.visibleEdges = [];
            this.bounds = {
                width: 1,
                height: 1
            };
            this.transform = {
                zoom: 1,
                x: 0,
                y: 0
            };
            this.query = "";
            this.rankFilter = null;
            this.statusFilter = null;
            this.hovered = null;
            this.selected = null;
            this.drag = null;
            this.destroyed = false;
            this.lastError = null;
            this.emitting = false;
            this.pointerMoved = false;
            this.lastWidth = 0;
            this.lastHeight = 0;
            this.abortController = new AbortController();
            this.metrics = {
                inputRecords: 0,
                nodes: 0,
                roots: 0,
                visibleNodes: 0,
                visibleEdges: 0,
                collapsedNodes: 0,
                maximumDepth: 0,
                leaves: 0,
                draws: 0,
                layouts: 0,
                resizes: 0,
                zooms: 0,
                pans: 0,
                selections: 0,
                errors: 0,
                hitTests: 0,
                skippedResizes: 0,
                asyncLoads: 0,
                asyncYields: 0,
                asyncRecords: 0,
                fits: 0,
                focuses: 0,
                lineageQueries: 0,
                ancestorQueries: 0,
                descendantQueries: 0,
                cladeQueries: 0,
                rankQueries: 0
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
            this._boundDoubleClick =
                this._handleDoubleClick.bind(this);
            this._boundKeydown =
                this._handleKeydown.bind(this);

            this.canvas[CONTROLLER_SYMBOL] = this;
            this.canvas.taxonomyTreeController = this;

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
                    "dblclick",
                    this._boundDoubleClick,
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
                        `taxonomy-tree:${type}`,
                        event
                    );
                } catch (observerError) {
                    window.console?.warn?.(
                        "[SpeciedexTerminalTaxonomyTree] Event observer failed:",
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
                this.taxonomy = buildTaxonomy(
                    data,
                    this.options
                );
                this.metrics.inputRecords =
                    normalizeRecords(data).length;
                this.metrics.nodes =
                    this.taxonomy.nodes.length;
                this.metrics.roots =
                    this.taxonomy.roots.length;
                this.metrics.maximumDepth =
                    Math.max(
                        ...this.taxonomy.nodes.map(
                            (node) => node.depth
                        ),
                        0
                    );
                this.metrics.leaves =
                    this.taxonomy.nodes.filter(
                        (node) =>
                            !node.children.length
                    ).length;
                this.selected = null;
                this.hovered = null;
                this._applyFilters();
                this.layout();
                this.draw();

                this._emit("data", {
                    nodes:
                        this.taxonomy.nodes.length,
                    roots:
                        this.taxonomy.roots.length
                });
            } catch (error) {
                this._recordError(error);
            }

            return this;
        }

        async setDataAsync(data, options = {}) {
            if (this.destroyed) {
                throw new Error(
                    "TaxonomyTree controller has been destroyed."
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

                this.taxonomy = buildTaxonomy(
                    staged,
                    this.options
                );

                this.metrics.inputRecords =
                    staged.length;
                this.metrics.nodes =
                    this.taxonomy.nodes.length;
                this.metrics.roots =
                    this.taxonomy.roots.length;
                this.metrics.maximumDepth =
                    Math.max(
                        ...this.taxonomy.nodes.map(
                            node => node.depth
                        ),
                        0
                    );
                this.metrics.leaves =
                    this.taxonomy.nodes.filter(
                        node => !node.children.length
                    ).length;
                this.metrics.asyncLoads += 1;

                this.selected = null;
                this.hovered = null;
                this.drag = null;
                this.pointerMoved = false;

                this._applyFilters();
                this.layout();
                this.draw();

                const result = {
                    records: staged.length,
                    nodes: this.taxonomy.nodes.length,
                    roots: this.taxonomy.roots.length,
                    leaves: this.metrics.leaves,
                    maximumDepth:
                        this.metrics.maximumDepth,
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

            let minimumX = Infinity;
            let maximumX = -Infinity;
            let minimumY = Infinity;
            let maximumY = -Infinity;

            for (const node of this.visibleNodes) {
                if (
                    this.options.layout === "icicle"
                ) {
                    minimumX = Math.min(
                        minimumX,
                        node.x
                    );
                    maximumX = Math.max(
                        maximumX,
                        node.x +
                        (node.icicleWidth || 0)
                    );
                    minimumY = Math.min(
                        minimumY,
                        node.y
                    );
                    maximumY = Math.max(
                        maximumY,
                        node.y +
                        (node.icicleHeight || 0)
                    );
                } else {
                    minimumX = Math.min(
                        minimumX,
                        node.x
                    );
                    maximumX = Math.max(
                        maximumX,
                        node.x
                    );
                    minimumY = Math.min(
                        minimumY,
                        node.y
                    );
                    maximumY = Math.max(
                        maximumY,
                        node.y
                    );
                }
            }

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
                0.2,
                Math.min(
                    16,
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
                visibleNodes:
                    this.visibleNodes.length,
                padding
            });

            return clone(this.transform);
        }

        focusNode(id, options = {}) {
            const node = this.taxonomy.byId.get(
                String(id)
            );

            if (!node) {
                return null;
            }

            let current = node.parent;

            while (current) {
                current.collapsed = false;
                current = current.parent;
            }

            this._applyFilters();
            this.layout();

            const zoom = parseNumber(
                options.zoom,
                Math.max(
                    this.transform.zoom,
                    1.5
                ),
                0.2,
                16
            );

            const centerX =
                this.options.layout === "icicle"
                    ? node.x +
                      (node.icicleWidth || 0) / 2
                    : node.x;

            const centerY =
                this.options.layout === "icicle"
                    ? node.y +
                      (node.icicleHeight || 0) / 2
                    : node.y;

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
                this.describeNode(node);

            this._emit("focus", {
                node: description,
                transform: clone(this.transform)
            });

            return description;
        }

        ancestors(id, limit = 1000) {
            const node = this.taxonomy.byId.get(
                String(id)
            );

            if (!node) {
                return [];
            }

            const maximum = Math.floor(
                parseNumber(
                    limit,
                    1000,
                    1,
                    DEFAULT_MAX_NODES
                )
            );

            const result = [];
            let current = node.parent;

            while (
                current &&
                result.length < maximum
            ) {
                result.push(
                    this.describeNode(current)
                );
                current = current.parent;
            }

            this.metrics.ancestorQueries += 1;
            return result;
        }

        descendants(
            id,
            depth = Infinity,
            limit = DEFAULT_QUERY_LIMIT
        ) {
            const node = this.taxonomy.byId.get(
                String(id)
            );

            if (!node) {
                return [];
            }

            const maximumDepth =
                Number.isFinite(Number(depth))
                    ? Math.floor(
                        parseNumber(
                            depth,
                            1,
                            0,
                            100000
                        )
                    )
                    : Infinity;

            const maximum = Math.floor(
                parseNumber(
                    limit,
                    DEFAULT_QUERY_LIMIT,
                    1,
                    DEFAULT_MAX_NODES
                )
            );

            const queue = node.children.map(
                child => ({
                    node: child,
                    depth: 1
                })
            );

            const results = [];

            while (
                queue.length &&
                results.length < maximum
            ) {
                const current = queue.shift();

                if (
                    current.depth >
                    maximumDepth
                ) {
                    continue;
                }

                results.push({
                    depth: current.depth,
                    node:
                        this.describeNode(
                            current.node
                        )
                });

                if (
                    current.depth <
                    maximumDepth
                ) {
                    for (
                        const child of
                        current.node.children
                    ) {
                        queue.push({
                            node: child,
                            depth:
                                current.depth + 1
                        });
                    }
                }
            }

            this.metrics.descendantQueries += 1;
            return results;
        }

        cladeStatistics(id) {
            const node = this.taxonomy.byId.get(
                String(id)
            );

            if (!node) {
                return null;
            }

            const descendants =
                this.descendants(
                    node.id,
                    Infinity,
                    DEFAULT_MAX_NODES
                );

            const nodes = [
                node,
                ...descendants.map(
                    entry =>
                        this.taxonomy.byId.get(
                            entry.node.id
                        )
                ).filter(Boolean)
            ];

            const ranks = {};
            const statuses = {};

            for (const item of nodes) {
                ranks[item.rank] =
                    (ranks[item.rank] || 0) + 1;
                statuses[item.status] =
                    (statuses[item.status] || 0) + 1;
            }

            this.metrics.cladeQueries += 1;

            return {
                root: this.describeNode(node),
                nodes: nodes.length,
                descendants:
                    Math.max(0, nodes.length - 1),
                leaves:
                    nodes.filter(
                        item =>
                            !item.children.length
                    ).length,
                maximumDepth:
                    Math.max(
                        ...nodes.map(
                            item =>
                                item.depth -
                                node.depth
                        ),
                        0
                    ),
                totalWeight:
                    nodes.reduce(
                        (sum, item) =>
                            sum + item.weight,
                        0
                    ),
                ranks,
                statuses
            };
        }

        rankSummary(rank = null) {
            const normalized =
                rank
                    ? normalizeRank(rank)
                    : null;

            const nodes = this.taxonomy.nodes.filter(
                node =>
                    !normalized ||
                    node.rank === normalized
            );

            const byRank = {};

            for (const node of nodes) {
                byRank[node.rank] =
                    (byRank[node.rank] || 0) + 1;
            }

            this.metrics.rankQueries += 1;

            return {
                rank: normalized,
                nodes: nodes.length,
                leaves:
                    nodes.filter(
                        node =>
                            !node.children.length
                    ).length,
                collapsed:
                    nodes.filter(
                        node => node.collapsed
                    ).length,
                byRank
            };
        }

        append(data) {
            const combined = [
                ...this.taxonomy.nodes.map(
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

            for (const node of this.taxonomy.nodes) {
                node.matched =
                    (
                        !query ||
                        node.label
                            .toLowerCase()
                            .includes(query) ||
                        node.id
                            .toLowerCase()
                            .includes(query) ||
                        node.rank
                            .toLowerCase()
                            .includes(query) ||
                        node.authority
                            .toLowerCase()
                            .includes(query)
                    ) &&
                    (
                        !this.rankFilter ||
                        node.rank ===
                        this.rankFilter
                    ) &&
                    (
                        !this.statusFilter ||
                        node.status ===
                        this.statusFilter
                    );
            }

            const propagate = (node) => {
                const childMatch =
                    node.children.some(
                        propagate
                    );

                node.visible =
                    node.matched ||
                    childMatch;

                return node.visible;
            };

            this.taxonomy.roots.forEach(
                propagate
            );
        }

        _collectVisible() {
            const nodes = [];
            const edges = [];

            const visit = (node) => {
                if (!node.visible) {
                    return;
                }

                nodes.push(node);

                if (node.collapsed) {
                    return;
                }

                for (const child of node.children) {
                    if (!child.visible) {
                        continue;
                    }

                    edges.push({
                        source: node,
                        target: child
                    });
                    visit(child);
                }
            };

            this.taxonomy.roots.forEach(
                visit
            );

            this.visibleNodes = nodes;
            this.visibleEdges = edges;
            this.metrics.visibleNodes =
                nodes.length;
            this.metrics.visibleEdges =
                edges.length;
            this.metrics.collapsedNodes =
                this.taxonomy.nodes.filter(
                    (node) =>
                        node.collapsed
                ).length;
        }

        layout() {
            this._collectVisible();

            switch (this.options.layout) {
                case "indented":
                    this._layoutIndented();
                    break;

                case "radial":
                    this._layoutRadial();
                    break;

                case "icicle":
                    this._layoutIcicle();
                    break;

                case "rectangular":
                default:
                    this._layoutRectangular();
                    break;
            }

            this.metrics.layouts += 1;
        }

        _layoutRectangular() {
            if (!this.visibleNodes.length) {
                return;
            }

            const padding =
                this.options.padding;
            const width =
                Math.max(
                    1,
                    this.bounds.width -
                    padding * 2
                );
            const height =
                Math.max(
                    1,
                    this.bounds.height -
                    padding * 2
                );
            const leaves =
                this.visibleNodes.filter(
                    (node) =>
                        node.collapsed ||
                        !node.children.some(
                            (child) =>
                                child.visible
                        )
                );
            const maximumDepth =
                Math.max(
                    ...this.visibleNodes.map(
                        (node) => node.depth
                    ),
                    1
                );

            leaves.forEach((leaf, index) => {
                leaf.y =
                    padding +
                    (
                        leaves.length === 1
                            ? 0.5
                            : index /
                              (
                                  leaves.length -
                                  1
                              )
                    ) *
                    height;
            });

            const place = (node) => {
                const children =
                    node.collapsed
                        ? []
                        : node.children.filter(
                            (child) =>
                                child.visible
                        );

                children.forEach(place);

                if (children.length) {
                    node.y =
                        children.reduce(
                            (sum, child) =>
                                sum + child.y,
                            0
                        ) /
                        children.length;
                }

                node.x =
                    padding +
                    node.depth /
                    maximumDepth *
                    width;
            };

            this.taxonomy.roots
                .filter(
                    (root) =>
                        root.visible
                )
                .forEach(place);

            if (
                this.options.orientation ===
                "vertical"
            ) {
                for (const node of this.visibleNodes) {
                    const x = node.x;
                    node.x = node.y;
                    node.y = x;
                }
            }
        }

        _layoutIndented() {
            let row = 0;
            const padding =
                this.options.padding;

            const visit = (node) => {
                if (!node.visible) {
                    return;
                }

                node.x =
                    padding +
                    node.depth *
                    this.options.indent;
                node.y =
                    padding +
                    row *
                    this.options.rowHeight;
                row += 1;

                if (node.collapsed) {
                    return;
                }

                node.children
                    .filter(
                        (child) =>
                            child.visible
                    )
                    .forEach(visit);
            };

            this.taxonomy.roots.forEach(
                visit
            );
        }

        _layoutRadial() {
            if (!this.visibleNodes.length) {
                return;
            }

            const centerX =
                this.bounds.width / 2;
            const centerY =
                this.bounds.height / 2;
            const radius =
                Math.max(
                    1,
                    Math.min(
                        this.bounds.width,
                        this.bounds.height
                    ) /
                    2 -
                    this.options.padding
                );
            const leaves =
                this.visibleNodes.filter(
                    (node) =>
                        node.collapsed ||
                        !node.children.some(
                            (child) =>
                                child.visible
                        )
                );
            const maximumDepth =
                Math.max(
                    ...this.visibleNodes.map(
                        (node) => node.depth
                    ),
                    1
                );

            leaves.forEach((leaf, index) => {
                leaf.angle =
                    (
                        index /
                        Math.max(
                            1,
                            leaves.length
                        )
                    ) *
                    Math.PI *
                    2 -
                    Math.PI / 2;
            });

            const place = (node) => {
                const children =
                    node.collapsed
                        ? []
                        : node.children.filter(
                            (child) =>
                                child.visible
                        );

                children.forEach(place);

                if (children.length) {
                    const x =
                        children.reduce(
                            (sum, child) =>
                                sum +
                                Math.cos(
                                    child.angle
                                ),
                            0
                        );
                    const y =
                        children.reduce(
                            (sum, child) =>
                                sum +
                                Math.sin(
                                    child.angle
                                ),
                            0
                        );

                    node.angle =
                        Math.atan2(y, x);
                }

                node.radialDistance =
                    node.depth /
                    maximumDepth *
                    radius;
                node.x =
                    centerX +
                    Math.cos(node.angle) *
                    node.radialDistance;
                node.y =
                    centerY +
                    Math.sin(node.angle) *
                    node.radialDistance;
            };

            this.taxonomy.roots
                .filter(
                    (root) =>
                        root.visible
                )
                .forEach(place);
        }

        _layoutIcicle() {
            if (!this.visibleNodes.length) {
                return;
            }

            const padding =
                this.options.padding;
            const width =
                Math.max(
                    1,
                    this.bounds.width -
                    padding * 2
                );
            const height =
                Math.max(
                    1,
                    this.bounds.height -
                    padding * 2
                );
            const maximumDepth =
                Math.max(
                    ...this.visibleNodes.map(
                        (node) => node.depth
                    ),
                    0
                );
            const rowHeight =
                height /
                Math.max(
                    1,
                    maximumDepth + 1
                );
            const totalLeaves =
                this.taxonomy.roots
                    .filter(
                        (root) =>
                            root.visible
                    )
                    .reduce(
                        (sum, root) =>
                            sum +
                            root.leafCount,
                        0
                    ) || 1;
            let offset = 0;

            const assign = (
                node,
                start,
                span
            ) => {
                node.x =
                    padding + start;
                node.y =
                    padding +
                    node.depth *
                    rowHeight;
                node.icicleWidth = span;
                node.icicleHeight =
                    rowHeight;

                if (
                    node.collapsed ||
                    !node.children.length
                ) {
                    return;
                }

                let childOffset =
                    start;
                const total =
                    node.children
                        .filter(
                            (child) =>
                                child.visible
                        )
                        .reduce(
                            (sum, child) =>
                                sum +
                                child.leafCount,
                            0
                        ) || 1;

                for (
                    const child
                    of node.children
                ) {
                    if (!child.visible) {
                        continue;
                    }

                    const childSpan =
                        span *
                        (
                            child.leafCount /
                            total
                        );

                    assign(
                        child,
                        childOffset,
                        childSpan
                    );
                    childOffset += childSpan;
                }
            };

            for (const root of this.taxonomy.roots) {
                if (!root.visible) {
                    continue;
                }

                const span =
                    width *
                    (
                        root.leafCount /
                        totalLeaves
                    );

                assign(
                    root,
                    offset,
                    span
                );
                offset += span;
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

            if (!this.visibleNodes.length) {
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
                    "No taxonomy nodes.",
                    this.bounds.width / 2,
                    this.bounds.height / 2
                );
                this.context.globalAlpha = 1;
                this.metrics.draws += 1;
                return;
            }

            if (this.options.showGrid) {
                this._drawGrid();
            }

            if (
                this.options.layout ===
                "icicle"
            ) {
                this._drawIcicle();
            } else {
                this._drawBranches();
                this._drawNodes();
            }

            if (this.options.showLabels) {
                this._drawLabels();
            }

            this.metrics.draws += 1;
        }

        _drawGrid() {
            this.context.save();
            this.context.strokeStyle =
                this.options.branchColor;
            this.context.globalAlpha =
                0.15;
            this.context.lineWidth = 1;

            const maximumDepth =
                Math.max(
                    ...this.visibleNodes.map(
                        (node) => node.depth
                    ),
                    1
                );

            if (
                this.options.layout ===
                "radial"
            ) {
                const center =
                    this._screenPoint(
                        this.bounds.width / 2,
                        this.bounds.height / 2
                    );
                const radius =
                    Math.min(
                        this.bounds.width,
                        this.bounds.height
                    ) /
                    2 -
                    this.options.padding;

                for (
                    let depth = 1;
                    depth <= maximumDepth;
                    depth += 1
                ) {
                    this.context.beginPath();
                    this.context.arc(
                        center.x,
                        center.y,
                        radius *
                        depth /
                        maximumDepth *
                        this.transform.zoom,
                        0,
                        Math.PI * 2
                    );
                    this.context.stroke();
                }
            } else {
                for (
                    let depth = 0;
                    depth <= maximumDepth;
                    depth += 1
                ) {
                    const x =
                        this.options.padding +
                        depth /
                        maximumDepth *
                        (
                            this.bounds.width -
                            this.options.padding *
                            2
                        );
                    const screen =
                        this._screenPoint(
                            x,
                            0
                        );

                    this.context.beginPath();
                    this.context.moveTo(
                        screen.x,
                        0
                    );
                    this.context.lineTo(
                        screen.x,
                        this.bounds.height
                    );
                    this.context.stroke();
                }
            }

            this.context.restore();
        }

        _drawBranches() {
            this.context.save();
            this.context.strokeStyle =
                this.options.branchColor;
            this.context.globalAlpha =
                0.78;
            this.context.lineWidth = 1.2;

            for (const edge of this.visibleEdges) {
                const source =
                    this._screenPoint(
                        edge.source.x,
                        edge.source.y
                    );
                const target =
                    this._screenPoint(
                        edge.target.x,
                        edge.target.y
                    );

                this.context.beginPath();

                if (
                    this.options.layout ===
                    "rectangular"
                ) {
                    if (
                        this.options.orientation ===
                        "horizontal"
                    ) {
                        this.context.moveTo(
                            source.x,
                            source.y
                        );
                        this.context.lineTo(
                            target.x,
                            source.y
                        );
                        this.context.lineTo(
                            target.x,
                            target.y
                        );
                    } else {
                        this.context.moveTo(
                            source.x,
                            source.y
                        );
                        this.context.lineTo(
                            source.x,
                            target.y
                        );
                        this.context.lineTo(
                            target.x,
                            target.y
                        );
                    }
                } else {
                    this.context.moveTo(
                        source.x,
                        source.y
                    );
                    this.context.lineTo(
                        target.x,
                        target.y
                    );
                }

                this.context.stroke();
            }

            this.context.restore();
        }

        _drawNodes() {
            this.context.save();

            for (const node of this.visibleNodes) {
                const isLeaf =
                    node.collapsed ||
                    !node.children.some(
                        (child) =>
                            child.visible
                    );

                if (
                    (isLeaf &&
                        !this.options.showLeaves) ||
                    (!isLeaf &&
                        !this.options.showInternalNodes)
                ) {
                    continue;
                }

                const point =
                    this._screenPoint(
                        node.x,
                        node.y
                    );
                const emphasized =
                    node === this.hovered ||
                    node === this.selected;
                const radius =
                    this.options.nodeRadius *
                    (
                        0.8 +
                        Math.min(
                            2,
                            Math.sqrt(
                                node.weight
                            ) *
                            0.12
                        )
                    ) *
                    Math.sqrt(
                        this.transform.zoom
                    );

                this.context.beginPath();

                if (node.collapsed) {
                    this.context.moveTo(
                        point.x - radius,
                        point.y - radius
                    );
                    this.context.lineTo(
                        point.x + radius,
                        point.y
                    );
                    this.context.lineTo(
                        point.x - radius,
                        point.y + radius
                    );
                    this.context.closePath();
                } else {
                    this.context.arc(
                        point.x,
                        point.y,
                        radius,
                        0,
                        Math.PI * 2
                    );
                }

                this.context.fillStyle =
                    emphasized
                        ? this.options.highlight
                        : colorHash(node.rank);
                this.context.globalAlpha =
                    emphasized ? 1 : 0.9;

                if (emphasized) {
                    this.context.shadowColor =
                        this.options.highlight;
                    this.context.shadowBlur = 12;
                } else {
                    this.context.shadowBlur = 0;
                }

                this.context.fill();

                node.screenX = point.x;
                node.screenY = point.y;
                node.screenRadius = radius;
            }

            this.context.restore();
        }

        _drawIcicle() {
            this.context.save();

            for (const node of this.visibleNodes) {
                const point =
                    this._screenPoint(
                        node.x,
                        node.y
                    );
                const width =
                    node.icicleWidth *
                    this.transform.zoom;
                const height =
                    node.icicleHeight *
                    this.transform.zoom;
                const emphasized =
                    node === this.hovered ||
                    node === this.selected;

                this.context.fillStyle =
                    emphasized
                        ? this.options.highlight
                        : colorHash(node.rank);
                this.context.globalAlpha =
                    emphasized ? 1 : 0.84;
                this.context.fillRect(
                    point.x,
                    point.y,
                    width,
                    height
                );

                this.context.strokeStyle =
                    this.options.background;
                this.context.globalAlpha =
                    0.82;
                this.context.lineWidth = 1;
                this.context.strokeRect(
                    point.x,
                    point.y,
                    width,
                    height
                );

                node.screenX = point.x;
                node.screenY = point.y;
                node.screenWidth = width;
                node.screenHeight = height;
                node.screenRadius = 0;
            }

            this.context.restore();
        }

        _drawLabels() {
            this.context.save();
            this.context.font =
                '11px "IBM Plex Mono", monospace';
            this.context.textBaseline =
                "middle";

            for (const node of this.visibleNodes) {
                const emphasized =
                    node === this.hovered ||
                    node === this.selected;
                const isLeaf =
                    node.collapsed ||
                    !node.children.some(
                        (child) =>
                            child.visible
                    );

                if (
                    !isLeaf &&
                    !emphasized &&
                    this.options.layout !==
                    "indented"
                ) {
                    continue;
                }

                let label =
                    node.label;

                if (this.options.showRanks) {
                    label +=
                        ` [${node.rank}]`;
                }

                if (
                    this.options.showAuthority &&
                    node.authority
                ) {
                    label +=
                        ` ${node.authority}`;
                }

                if (this.options.showStatus) {
                    label +=
                        ` {${node.status}}`;
                }

                if (this.options.showCounts) {
                    label +=
                        ` (${node.descendantCount})`;
                }

                this.context.fillStyle =
                    emphasized
                        ? this.options.highlight
                        : this.options.labelColor;
                this.context.globalAlpha =
                    emphasized ? 1 : 0.8;

                if (
                    this.options.layout ===
                    "icicle"
                ) {
                    if (
                        node.screenWidth < 28 ||
                        node.screenHeight < 12
                    ) {
                        continue;
                    }

                    this.context.textAlign =
                        "left";
                    this.context.save();
                    this.context.beginPath();
                    this.context.rect(
                        node.screenX,
                        node.screenY,
                        node.screenWidth,
                        node.screenHeight
                    );
                    this.context.clip();
                    this.context.fillText(
                        label,
                        node.screenX + 4,
                        node.screenY +
                        node.screenHeight /
                        2
                    );
                    this.context.restore();
                } else if (
                    this.options.layout ===
                    "radial"
                ) {
                    const rightSide =
                        Math.cos(
                            node.angle
                        ) >= 0;

                    this.context.textAlign =
                        rightSide
                            ? "left"
                            : "right";
                    this.context.fillText(
                        label,
                        node.screenX +
                        (
                            rightSide
                                ? 1
                                : -1
                        ) *
                        (
                            node.screenRadius +
                            5
                        ),
                        node.screenY
                    );
                } else {
                    this.context.textAlign =
                        "left";
                    this.context.fillText(
                        label,
                        node.screenX +
                        node.screenRadius +
                        5,
                        node.screenY
                    );
                }
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
            this.metrics.hitTests += 1;
            for (
                let index =
                    this.visibleNodes.length - 1;
                index >= 0;
                index -= 1
            ) {
                const node =
                    this.visibleNodes[index];

                if (
                    this.options.layout ===
                    "icicle"
                ) {
                    if (
                        x >= node.screenX &&
                        x <=
                        node.screenX +
                        node.screenWidth &&
                        y >= node.screenY &&
                        y <=
                        node.screenY +
                        node.screenHeight
                    ) {
                        return node;
                    }

                    continue;
                }

                const dx =
                    x - node.screenX;
                const dy =
                    y - node.screenY;
                const radius =
                    node.screenRadius + 5;

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

            if (this.drag) {
                const deltaX = point.x - this.drag.startX;
                const deltaY = point.y - this.drag.startY;

                if (
                    Math.abs(deltaX) > 2 ||
                    Math.abs(deltaY) > 2
                ) {
                    this.pointerMoved = true;
                }

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
                    node:
                        hovered
                            ? this.describeNode(
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
                    node: null
                });
            }
        }

        _handlePointerDown(event) {
            if (
                !this.options.pannable ||
                event.button !== 0
            ) {
                return;
            }

            this.pointerMoved = false;

            const point =
                this._pointFromEvent(event);

            this.drag = {
                startX:
                    point.x,
                startY:
                    point.y,
                originX:
                    this.transform.x,
                originY:
                    this.transform.y
            };

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
                    0.2,
                    Math.min(
                        16,
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
            const node =
                this.hitTest(
                    point.x,
                    point.y
                );

            this.selected =
                node?.id ===
                this.selected?.id
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

        _handleDoubleClick(event) {
            const point =
                this._pointFromEvent(event);
            const node =
                this.hitTest(
                    point.x,
                    point.y
                );

            if (
                node &&
                node.children.length
            ) {
                this.toggleNode(node.id);
            }
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
            } else if (
                event.key === "-"
            ) {
                event.preventDefault();
                this.setZoom(
                    this.transform.zoom /
                    1.2
                );
            } else if (
                event.key === "0"
            ) {
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
            } else if (
                event.key === "Enter" &&
                this.selected?.children.length
            ) {
                event.preventDefault();
                this.toggleNode(
                    this.selected.id
                );
            }
        }

        setZoom(value) {
            this.transform.zoom =
                Math.max(
                    0.2,
                    Math.min(
                        16,
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
            this.draw();

            this._emit("resetView", {
                transform: clone(this.transform)
            });

            return clone(
                this.transform
            );
        }

        setLayout(layout) {
            if (
                ![
                    "rectangular",
                    "indented",
                    "radial",
                    "icicle"
                ].includes(layout)
            ) {
                throw new Error(
                    `Unknown taxonomy-tree layout: ${layout}`
                );
            }

            this.options.layout = layout;
            this.layout();
            this.draw();

            return layout;
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
                    this.visibleNodes.length
            });

            return this.query;
        }

        setRank(rank = null) {
            this.rankFilter =
                rank
                    ? normalizeRank(rank)
                    : null;
            this._applyFilters();
            this.layout();
            this.draw();

            return this.rankFilter;
        }

        setStatus(status = null) {
            this.statusFilter =
                status
                    ? String(status)
                    : null;
            this._applyFilters();
            this.layout();
            this.draw();

            return this.statusFilter;
        }

        toggleNode(id) {
            const node =
                this.taxonomy.byId.get(
                    String(id)
                );

            if (
                !node ||
                !node.children.length
            ) {
                return null;
            }

            node.collapsed =
                !node.collapsed;
            this.layout();
            this.draw();

            this._emit("toggle", {
                node:
                    this.describeNode(node)
            });

            return node.collapsed;
        }

        collapseAll() {
            for (
                const node
                of this.taxonomy.nodes
            ) {
                if (node.children.length) {
                    node.collapsed = true;
                }
            }

            this.layout();
            this.draw();

            return this.metrics.collapsedNodes;
        }

        expandAll() {
            for (
                const node
                of this.taxonomy.nodes
            ) {
                node.collapsed = false;
            }

            this.layout();
            this.draw();

            return 0;
        }

        collapseRank(rank) {
            const normalized =
                normalizeRank(rank);
            let count = 0;

            for (
                const node
                of this.taxonomy.nodes
            ) {
                if (
                    node.rank === normalized &&
                    node.children.length
                ) {
                    node.collapsed = true;
                    count += 1;
                }
            }

            this.layout();
            this.draw();

            return count;
        }

        selectNode(id) {
            const node =
                this.taxonomy.byId.get(
                    String(id)
                );

            if (!node) {
                return null;
            }

            this.selected = node;
            this.draw();

            return this.describeNode(node);
        }

        lineage(id) {
            const node =
                this.taxonomy.byId.get(
                    String(id)
                );

            if (!node) {
                return [];
            }

            const lineage = [];
            let current = node;

            while (current) {
                lineage.unshift({
                    id:
                        current.id,
                    label:
                        current.label,
                    rank:
                        current.rank
                });
                current =
                    current.parent;
            }

            this.metrics.lineageQueries += 1;
            return lineage;
        }

        describeNode(node) {
            if (!node) {
                return null;
            }

            return {
                id:
                    node.id,
                label:
                    node.label,
                rank:
                    node.rank,
                status:
                    node.status,
                authority:
                    node.authority,
                parentId:
                    node.parent?.id ||
                    null,
                depth:
                    node.depth,
                leafCount:
                    node.leafCount,
                descendantCount:
                    node.descendantCount,
                weight:
                    node.weight,
                collapsed:
                    node.collapsed,
                visible:
                    node.visible,
                lineage:
                    this.lineage(node.id),
                children:
                    node.children.map(
                        (child) => ({
                            id:
                                child.id,
                            label:
                                child.label,
                            rank:
                                child.rank
                        })
                    ),
                raw:
                    clone(node.raw)
            };
        }

        update(options = {}) {
            if (!isObject(options)) {
                throw new TypeError(
                    "TaxonomyTree options must be an object."
                );
            }

            const rebuildRequired = [
                "inferLineage",
                "maxNodes"
            ].some(
                (key) =>
                    options[key] !== undefined
            );

            Object.assign(
                this.options,
                {
                    layout:
                        options.layout ||
                        this.options.layout,
                    orientation:
                        options.orientation ||
                        this.options.orientation,
                    background:
                        options.background ||
                        this.options.background,
                    foreground:
                        options.foreground ||
                        this.options.foreground,
                    highlight:
                        options.highlight ||
                        this.options.highlight,
                    branchColor:
                        options.branchColor ||
                        this.options.branchColor,
                    labelColor:
                        options.labelColor ||
                        this.options.labelColor,
                    nodeRadius:
                        options.nodeRadius !== undefined
                            ? parseNumber(
                                options.nodeRadius,
                                this.options.nodeRadius,
                                1,
                                24
                            )
                            : this.options.nodeRadius,
                    padding:
                        options.padding !== undefined
                            ? parseNumber(
                                options.padding,
                                this.options.padding,
                                8,
                                240
                            )
                            : this.options.padding,
                    indent:
                        options.indent !== undefined
                            ? parseNumber(
                                options.indent,
                                this.options.indent,
                                8,
                                120
                            )
                            : this.options.indent,
                    rowHeight:
                        options.rowHeight !== undefined
                            ? parseNumber(
                                options.rowHeight,
                                this.options.rowHeight,
                                12,
                                80
                            )
                            : this.options.rowHeight,
                    showLabels:
                        options.showLabels !== undefined
                            ? parseBoolean(
                                options.showLabels,
                                this.options.showLabels
                            )
                            : this.options.showLabels,
                    showRanks:
                        options.showRanks !== undefined
                            ? parseBoolean(
                                options.showRanks,
                                this.options.showRanks
                            )
                            : this.options.showRanks,
                    showAuthority:
                        options.showAuthority !== undefined
                            ? parseBoolean(
                                options.showAuthority,
                                this.options.showAuthority
                            )
                            : this.options.showAuthority,
                    showStatus:
                        options.showStatus !== undefined
                            ? parseBoolean(
                                options.showStatus,
                                this.options.showStatus
                            )
                            : this.options.showStatus,
                    showCounts:
                        options.showCounts !== undefined
                            ? parseBoolean(
                                options.showCounts,
                                this.options.showCounts
                            )
                            : this.options.showCounts,
                    showInternalNodes:
                        options.showInternalNodes !== undefined
                            ? parseBoolean(
                                options.showInternalNodes,
                                this.options.showInternalNodes
                            )
                            : this.options.showInternalNodes,
                    showLeaves:
                        options.showLeaves !== undefined
                            ? parseBoolean(
                                options.showLeaves,
                                this.options.showLeaves
                            )
                            : this.options.showLeaves,
                    showGrid:
                        options.showGrid !== undefined
                            ? parseBoolean(
                                options.showGrid,
                                this.options.showGrid
                            )
                            : this.options.showGrid,
                    inferLineage:
                        options.inferLineage !== undefined
                            ? parseBoolean(
                                options.inferLineage,
                                this.options.inferLineage
                            )
                            : this.options.inferLineage,
                    maxNodes:
                        options.maxNodes !== undefined
                            ? parseNumber(
                                options.maxNodes,
                                this.options.maxNodes,
                                1,
                                100000
                            )
                            : this.options.maxNodes
                }
            );

            if (rebuildRequired) {
                this.setData(
                    this.taxonomy.nodes.map(
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

            if (normalized === "newick") {
                const serialize = (node) => {
                    const children =
                        node.collapsed
                            ? []
                            : node.children;

                    const prefix =
                        children.length
                            ? `(${children.map(serialize).join(",")})`
                            : "";
                    const label =
                        node.label.replace(
                            /[\s,:;()]/g,
                            "_"
                        );

                    return prefix + label;
                };

                return (
                    this.taxonomy.roots
                        .map(serialize)
                        .join(",") +
                    ";"
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
                        roots:
                            this.taxonomy.roots.map(
                                (root) => root.id
                            ),
                        nodes:
                            this.taxonomy.nodes.map(
                                (node) =>
                                    this.describeNode(
                                        node
                                    )
                            )
                    },
                    null,
                    2
                );
            }

            if (normalized === "csv") {
                const rows = [[
                    "id",
                    "label",
                    "rank",
                    "status",
                    "authority",
                    "parentId",
                    "depth",
                    "leafCount",
                    "descendantCount",
                    "weight",
                    "collapsed",
                    "visible"
                ]];

                for (
                    const node
                    of this.taxonomy.nodes
                ) {
                    rows.push([
                        node.id,
                        node.label,
                        node.rank,
                        node.status,
                        node.authority,
                        node.parent?.id || "",
                        node.depth,
                        node.leafCount,
                        node.descendantCount,
                        node.weight,
                        node.collapsed,
                        node.visible
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
                `Unsupported TaxonomyTree export format: ${format}`
            );
        }

        status() {
            return {
                name:
                    "taxonomy-tree",
                module:
                    MODULE_NAME,
                nodes:
                    this.taxonomy.nodes.length,
                roots:
                    this.taxonomy.roots.length,
                visibleNodes:
                    this.visibleNodes.length,
                visibleEdges:
                    this.visibleEdges.length,
                collapsedNodes:
                    this.taxonomy.nodes.filter(
                        (node) =>
                            node.collapsed
                    ).length,
                maximumDepth:
                    this.metrics.maximumDepth,
                leaves:
                    this.metrics.leaves,
                query:
                    this.query,
                rankFilter:
                    this.rankFilter,
                statusFilter:
                    this.statusFilter,
                layout:
                    this.options.layout,
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

            this._cleanupResize?.();
            this.abortController.abort();

            this.drag = null;
            this.hovered = null;
            this.selected = null;

            this._emit("destroy", {});

            if (this.canvas[CONTROLLER_SYMBOL] === this) {
                delete this.canvas[CONTROLLER_SYMBOL];
            }

            if (this.canvas.taxonomyTreeController === this) {
                delete this.canvas.taxonomyTreeController;
            }

            this.taxonomy.byId.clear();
            this.taxonomy = {
                nodes: [],
                roots: [],
                byId: new Map()
            };
            this.visibleNodes = [];
            this.visibleEdges = [];

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
            canvas.taxonomyTreeController;

        if (
            existing instanceof TaxonomyTreeController &&
            !existing.destroyed
        ) {
            existing.update(options);
            existing.setData(data);
            return existing;
        }

        return new TaxonomyTreeController(
            canvas,
            data,
            options
        );
    }

    function render(data = [], options = {}) {
        const container = createElement(
            "section",
            "terminal-visualization terminal-visualization-taxonomy-tree"
        );
        container.dataset.visualization =
            "taxonomy-tree";
        container.setAttribute(
            "role",
            "region"
        );
        container.setAttribute(
            "aria-label",
            options.label ||
            "TaxonomyTree visualization"
        );

        const canvas =
            document.createElement("canvas");
        canvas.className =
            "terminal-taxonomy-tree-canvas";
        canvas.width =
            Number(options.width) ||
            DEFAULT_WIDTH;
        canvas.height =
            Number(options.height) ||
            DEFAULT_HEIGHT;
        canvas.setAttribute(
            "aria-label",
            options.label ||
            "TaxonomyTree visualization"
        );

        const status = createElement(
            "div",
            "terminal-taxonomy-tree-status"
        );
        status.setAttribute(
            "aria-live",
            "polite"
        );

        const tooltip = createElement(
            "div",
            "terminal-taxonomy-tree-tooltip"
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
                `${snapshot.visibleNodes} of ${snapshot.nodes} taxon` +
                `${snapshot.nodes === 1 ? "" : "a"} · ` +
                `${snapshot.roots} root` +
                `${snapshot.roots === 1 ? "" : "s"} · ` +
                `${snapshot.collapsedNodes} collapsed · ` +
                `${snapshot.layout}`;
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
                    `${node.label} · ${node.rank} · ${node.status} · ` +
                    `${node.descendantCount} descendant` +
                    `${node.descendantCount === 1 ? "" : "s"}`;
            }
        );

        for (const eventName of [
            "data",
            "append",
            "resize",
            "zoom",
            "filter",
            "toggle",
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
            controller.taxonomy.nodes;
        container[CONTROLLER_SYMBOL] =
            controller;
        container.taxonomyTreeController =
            controller;
        container.status = () =>
            controller.status();
        container.update = (
            nextData = data,
            nextOptions = {}
        ) => {
            controller.update(nextOptions);
            controller.setData(nextData);
            container.data =
                controller.taxonomy.nodes;
            return container;
        };
        container.destroy = () => {
            const destroyed =
                controller.destroy();
            delete container[CONTROLLER_SYMBOL];
            return destroyed;
        };

        return container;
    }

    function initialize(context = {}) {
        const root = context.root || document;

        const existing =
            context.taxonomyTree ||
            context["taxonomy-tree"] ||
            root?.[VISUALIZATION_SYMBOL];

        if (
            existing &&
            existing.Controller === TaxonomyTreeController
        ) {
            context.taxonomyTree = existing;

            context.registerVisualization?.(
                "taxonomy-tree",
                existing
            );

            context.registerRenderer?.(
                "taxonomy-tree",
                existing
            );

            return existing;
        }

        const dataset =
            context.root?.dataset || {};

        const config =
            context.config?.taxonomyTree ||
            context.config?.["taxonomy-tree"] ||
            {};

        const defaults = {
            context,
            layout:
                dataset.terminalTaxonomyTreeLayout ||
                config.layout ||
                "rectangular",

            orientation:
                dataset.terminalTaxonomyTreeOrientation ||
                config.orientation ||
                "horizontal",

            background:
                dataset.terminalTaxonomyTreeBackground ||
                config.background ||
                DEFAULT_BACKGROUND,

            foreground:
                dataset.terminalTaxonomyTreeForeground ||
                config.foreground ||
                DEFAULT_FOREGROUND,

            highlight:
                dataset.terminalTaxonomyTreeHighlight ||
                config.highlight ||
                DEFAULT_HIGHLIGHT,

            branchColor:
                dataset.terminalTaxonomyTreeBranchColor ||
                config.branchColor ||
                DEFAULT_BRANCH,

            labelColor:
                dataset.terminalTaxonomyTreeLabelColor ||
                config.labelColor ||
                DEFAULT_LABEL,

            nodeRadius:
                dataset.terminalTaxonomyTreeNodeRadius ||
                config.nodeRadius ||
                DEFAULT_NODE_RADIUS,

            showLabels: parseBoolean(
                dataset.terminalTaxonomyTreeShowLabels,
                config.showLabels !== false
            ),

            showRanks: parseBoolean(
                dataset.terminalTaxonomyTreeShowRanks,
                config.showRanks !== false
            ),

            showAuthority: parseBoolean(
                dataset.terminalTaxonomyTreeShowAuthority,
                config.showAuthority === true
            ),

            showStatus: parseBoolean(
                dataset.terminalTaxonomyTreeShowStatus,
                config.showStatus === true
            ),

            showCounts: parseBoolean(
                dataset.terminalTaxonomyTreeShowCounts,
                config.showCounts === true
            ),

            inferLineage: parseBoolean(
                dataset.terminalTaxonomyTreeInferLineage,
                config.inferLineage !== false
            ),

            interactive: parseBoolean(
                dataset.terminalTaxonomyTreeInteractive,
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
                context.taxonomyTreeController =
                    controller;

                controller.addEventListener(
                    "destroy",
                    () => {
                        controllers.delete(controller);

                        if (
                            context.taxonomyTreeController ===
                            controller
                        ) {
                            delete context.taxonomyTreeController;
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
                    context.taxonomyTreeController =
                        element.controller;

                    element.controller.addEventListener(
                        "destroy",
                        () => {
                            controllers.delete(
                                element.controller
                            );

                            if (
                                context.taxonomyTreeController ===
                                element.controller
                            ) {
                                delete context.taxonomyTreeController;
                            }
                        },
                        { once: true }
                    );
                }

                return element;
            },

            activeController() {
                return (
                    context.taxonomyTreeController ||
                    context.terminalTaxonomyTreeController ||
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

                if (
                    context.taxonomyTree ===
                    visualization
                ) {
                    delete context.taxonomyTree;
                }

                if (context.taxonomyTreeController) {
                    delete context.taxonomyTreeController;
                }

                return true;
            },

            Controller: TaxonomyTreeController,
            buildTaxonomy,
            normalizeRecords,
            normalizeRank,
            rankIndex,
            inferParent
        };

        root[VISUALIZATION_SYMBOL] = visualization;

        context.registerVisualization?.(
            "taxonomy-tree",
            visualization
        );

        context.registerRenderer?.(
            "taxonomy-tree",
            visualization
        );

        context.taxonomyTree = visualization;

        safeDispatch(
            document,
            "speciedex:terminal-taxonomy-tree-ready",
            {
                visualization,
                version: VERSION
            }
        );

        return visualization;
    }

    const commands = [{
        name: "taxonomy-tree",
        category: "visualization",
        description:
            "Render and control an interactive taxonomic hierarchy.",
        usage:
            "taxonomy-tree [collection|status|layout|filter|rank|state|" +
            "collapse|expand|toggle|lineage|ancestors|descendants|clade|" +
            "rank-summary|fit|focus|select|orientation|labels|ranks|" +
            "authority|status-labels|counts|grid|zoom|pan|reset|export] [arguments]",
        handler: async ({
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
                context.taxonomyTree ||
                initialize(context);

            const controller =
                context.taxonomyTreeController ||
                context.terminalTaxonomyTreeController ||
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

                        case "layout":
                            if (!args[1]) {
                                return outputJSON({
                                    layout:
                                        controller.options.layout
                                });
                            }

                            return outputJSON({
                                layout:
                                    controller.setLayout(
                                        args[1]
                                    )
                            });

                        case "filter":
                            return outputJSON({
                                query:
                                    controller.setFilter(
                                        args.slice(1).join(" ")
                                    ),
                                status:
                                    controller.status()
                            });

                        case "rank":
                            return outputJSON({
                                rank:
                                    controller.setRank(
                                        args.slice(1).join(" ") ||
                                        null
                                    ),
                                status:
                                    controller.status()
                            });

                        case "state":
                            return outputJSON({
                                status:
                                    controller.setStatus(
                                        args.slice(1).join(" ") ||
                                        null
                                    ),
                                tree:
                                    controller.status()
                            });

                        case "collapse":
                            if (args[1]) {
                                return outputJSON({
                                    collapsed:
                                        controller.collapseRank(
                                            args[1]
                                        ),
                                    status:
                                        controller.status()
                                });
                            }

                            return outputJSON({
                                collapsed:
                                    controller.collapseAll(),
                                status:
                                    controller.status()
                            });

                        case "expand":
                            controller.expandAll();
                            return outputJSON(
                                controller.status()
                            );

                        case "toggle":
                            return outputJSON({
                                collapsed:
                                    controller.toggleNode(
                                        args[1]
                                    ),
                                status:
                                    controller.status()
                            });

                        case "lineage":
                            return outputJSON({
                                lineage:
                                    controller.lineage(
                                        args[1]
                                    )
                            });

                        case "ancestors":
                            if (!args[1]) {
                                throw new Error(
                                    "A node ID is required."
                                );
                            }

                            return outputJSON({
                                node: args[1],
                                ancestors:
                                    controller.ancestors(
                                        args[1],
                                        args[2]
                                    )
                            });

                        case "descendants":
                            if (!args[1]) {
                                throw new Error(
                                    "A node ID is required."
                                );
                            }

                            return outputJSON({
                                node: args[1],
                                descendants:
                                    controller.descendants(
                                        args[1],
                                        args[2],
                                        args[3]
                                    )
                            });

                        case "clade":
                            if (!args[1]) {
                                throw new Error(
                                    "A node ID is required."
                                );
                            }

                            return outputJSON(
                                controller.cladeStatistics(
                                    args[1]
                                )
                            );

                        case "rank-summary":
                        case "ranksummary":
                            return outputJSON(
                                controller.rankSummary(
                                    args[1] || null
                                )
                            );

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

                        case "orientation":
                            if (!args[1]) {
                                return outputJSON({
                                    orientation:
                                        controller.options.orientation
                                });
                            }

                            controller.update({
                                orientation: args[1]
                            });

                            return outputJSON({
                                orientation:
                                    controller.options.orientation
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

                        case "ranks":
                            controller.update({
                                showRanks:
                                    args[1] === undefined
                                        ? !controller.options.showRanks
                                        : parseBoolean(
                                            args[1],
                                            controller.options.showRanks
                                        )
                            });

                            return outputJSON({
                                showRanks:
                                    controller.options.showRanks
                            });

                        case "authority":
                            controller.update({
                                showAuthority:
                                    args[1] === undefined
                                        ? !controller.options.showAuthority
                                        : parseBoolean(
                                            args[1],
                                            controller.options.showAuthority
                                        )
                            });

                            return outputJSON({
                                showAuthority:
                                    controller.options.showAuthority
                            });

                        case "status-labels":
                        case "statuslabels":
                            controller.update({
                                showStatus:
                                    args[1] === undefined
                                        ? !controller.options.showStatus
                                        : parseBoolean(
                                            args[1],
                                            controller.options.showStatus
                                        )
                            });

                            return outputJSON({
                                showStatus:
                                    controller.options.showStatus
                            });

                        case "counts":
                            controller.update({
                                showCounts:
                                    args[1] === undefined
                                        ? !controller.options.showCounts
                                        : parseBoolean(
                                            args[1],
                                            controller.options.showCounts
                                        )
                            });

                            return outputJSON({
                                showCounts:
                                    controller.options.showCounts
                            });

                        case "grid":
                            controller.update({
                                showGrid:
                                    args[1] === undefined
                                        ? !controller.options.showGrid
                                        : parseBoolean(
                                            args[1],
                                            controller.options.showGrid
                                        )
                            });

                            return outputJSON({
                                showGrid:
                                    controller.options.showGrid
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
                        ...context.config?.taxonomyTree,
                        ...context.config?.["taxonomy-tree"],
                        label:
                            `TaxonomyTree for ${collection}`
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
        TaxonomyTreeController,
        buildTaxonomy,
        normalizeRecords,
        normalizeRank,
        rankIndex,
        inferParent,
        createAbortError,
        mount,
        render,
        initialize,
        init: initialize,
        setup: initialize,
        unmount(context = {}) {
            const visualization =
                context.taxonomyTree;

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

    window.SpeciedexTerminalTaxonomyTree =
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
