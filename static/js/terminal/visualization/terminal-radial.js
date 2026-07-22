/*
========================================================================
Speciedex.org
Terminal Radial Visualization
========================================================================

Interactive radial visualization engine for Speciedex records. Supports
sunburst, radial-bar, polar-area, ring, and hierarchical radial layouts;
automatic field inference; grouping; weighted aggregation; sorting; filtering;
rotation; zoom; hover inspection; selection; responsive high-DPI rendering;
JSON, CSV, and PNG export; diagnostics; and lifecycle control.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Radial";
    const DEFAULT_WIDTH = 960;
    const DEFAULT_HEIGHT = 540;
    const DEFAULT_BACKGROUND = "#020a05";
    const DEFAULT_FOREGROUND = "#c0d674";
    const DEFAULT_HIGHLIGHT = "#eef7c8";
    const DEFAULT_GRID = "#1f3a27";
    const DEFAULT_AXIS = "#35503a";
    const DEFAULT_LABEL = "#d8e6db";
    const DEFAULT_INNER_RADIUS_RATIO = 0.18;
    const DEFAULT_OUTER_RADIUS_RATIO = 0.44;
    const DEFAULT_GAP = 0.012;
    const DEFAULT_MAX_RECORDS = 250000;
    const DEFAULT_MAX_SEGMENTS = 4096;

    const LABEL_FIELDS = Object.freeze([
        "scientific_name",
        "scientificName",
        "canonical_name",
        "canonicalName",
        "common_name",
        "commonName",
        "name",
        "label",
        "provider",
        "source",
        "rank",
        "status",
        "category",
        "type"
    ]);

    const VALUE_FIELDS = Object.freeze([
        "value",
        "count",
        "weight",
        "score",
        "abundance",
        "coverage",
        "quality",
        "completeness",
        "records",
        "record_count",
        "recordCount",
        "occurrenceCount",
        "occurrence_count"
    ]);

    const GROUP_FIELDS = Object.freeze([
        "kingdom",
        "phylum",
        "class",
        "order",
        "family",
        "genus",
        "rank",
        "provider",
        "source",
        "status",
        "category",
        "type"
    ]);

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
            /* Visualization events must not interrupt rendering. */
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
            "Radial visualization requires a canvas or container element."
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
            return data.slice(0, DEFAULT_MAX_RECORDS);
        }

        if (isObject(data)) {
            for (const key of [
                "records",
                "results",
                "items",
                "segments",
                "nodes",
                "data"
            ]) {
                if (Array.isArray(data[key])) {
                    return data[key].slice(0, DEFAULT_MAX_RECORDS);
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

    function firstFinite(record, keys, fallback = null) {
        for (const key of keys) {
            const value = Number(record?.[key]);

            if (Number.isFinite(value)) {
                return value;
            }
        }

        return fallback;
    }

    function inferField(records, candidates) {
        const scores = new Map(
            candidates.map((field, index) => [
                field,
                {
                    field,
                    count: 0,
                    priority: index
                }
            ])
        );

        for (const record of records.slice(0, 5000)) {
            if (!isObject(record)) {
                continue;
            }

            for (const key of Object.keys(record)) {
                if (!scores.has(key)) {
                    scores.set(key, {
                        field: key,
                        count: 0,
                        priority: 999
                    });
                }

                const value = record[key];

                if (value !== undefined && value !== null && value !== "") {
                    scores.get(key).count += 1;
                }
            }
        }

        return Array.from(scores.values())
            .sort((left, right) =>
                right.count - left.count ||
                left.priority - right.priority ||
                left.field.localeCompare(right.field)
            )
            .find((entry) => entry.count > 0)?.field || null;
    }

    function labelForRecord(record, index, options = {}) {
        if (typeof options.labelAccessor === "function") {
            return String(
                options.labelAccessor(record, index) ??
                `Segment ${index + 1}`
            );
        }

        if (options.labelKey && isObject(record)) {
            return String(
                record[options.labelKey] ??
                `Segment ${index + 1}`
            );
        }

        if (!isObject(record)) {
            return String(record ?? `Segment ${index + 1}`);
        }

        return String(
            firstValue(
                record,
                LABEL_FIELDS,
                `Segment ${index + 1}`
            )
        );
    }

    function valueForRecord(record, index, options = {}) {
        if (typeof options.valueAccessor === "function") {
            const value = Number(
                options.valueAccessor(record, index)
            );
            return Number.isFinite(value) ? value : null;
        }

        if (options.valueKey && isObject(record)) {
            const value = Number(record[options.valueKey]);
            return Number.isFinite(value) ? value : null;
        }

        if (typeof record === "number") {
            return Number.isFinite(record) ? record : null;
        }

        if (!isObject(record)) {
            return 1;
        }

        return firstFinite(record, VALUE_FIELDS, 1);
    }

    function groupForRecord(record, options = {}) {
        if (typeof options.groupAccessor === "function") {
            return String(
                options.groupAccessor(record) ??
                "ungrouped"
            );
        }

        if (options.groupKey && isObject(record)) {
            return String(
                record[options.groupKey] ??
                "ungrouped"
            );
        }

        if (!isObject(record)) {
            return "ungrouped";
        }

        return String(
            firstValue(
                record,
                GROUP_FIELDS,
                "ungrouped"
            )
        );
    }

    function parentForRecord(record, options = {}) {
        if (typeof options.parentAccessor === "function") {
            const value = options.parentAccessor(record);
            return value === null || value === undefined
                ? null
                : String(value);
        }

        if (options.parentKey && isObject(record)) {
            const value = record[options.parentKey];
            return value === null || value === undefined || value === ""
                ? null
                : String(value);
        }

        if (!isObject(record)) {
            return null;
        }

        const value = firstValue(record, [
            "parent_id",
            "parentId",
            "parent",
            "parent_name",
            "parentName"
        ], null);

        return value === null ? null : String(value);
    }

    function idForRecord(record, index) {
        if (!isObject(record)) {
            return `segment-${index + 1}`;
        }

        return String(firstValue(record, [
            "speciedex_id",
            "speciedexId",
            "taxon_id",
            "taxonId",
            "id",
            "key",
            "uuid"
        ], `segment-${index + 1}`));
    }

    function colorHash(value) {
        let hash = 0;

        for (const character of String(value || "")) {
            hash = ((hash << 5) - hash) + character.charCodeAt(0);
            hash |= 0;
        }

        return `hsl(${Math.abs(hash) % 360} 56% 60%)`;
    }

    function escapeCsv(value) {
        const text = String(value ?? "");

        return /[",\n\r]/.test(text)
            ? `"${text.replace(/"/g, '""')}"`
            : text;
    }

    class RadialController extends EventTarget {
        constructor(target, data = [], options = {}) {
            super();

            this.canvas = resolveCanvas(target);
            this.context = this.canvas.getContext("2d", {
                alpha: true,
                desynchronized: true
            });

            if (!this.context) {
                throw new Error(
                    "Unable to acquire Radial 2D canvas context."
                );
            }

            this.options = {
                mode: [
                    "sunburst",
                    "radial-bar",
                    "polar-area",
                    "rings",
                    "donut"
                ].includes(options.mode)
                    ? options.mode
                    : "sunburst",
                labelKey:
                    options.labelKey || null,
                labelAccessor:
                    options.labelAccessor,
                valueKey:
                    options.valueKey || null,
                valueAccessor:
                    options.valueAccessor,
                groupKey:
                    options.groupKey || null,
                groupAccessor:
                    options.groupAccessor,
                parentKey:
                    options.parentKey || null,
                parentAccessor:
                    options.parentAccessor,
                aggregation: [
                    "sum",
                    "average",
                    "min",
                    "max",
                    "count"
                ].includes(options.aggregation)
                    ? options.aggregation
                    : "sum",
                sort: [
                    "label",
                    "value",
                    "group",
                    "none"
                ].includes(options.sort)
                    ? options.sort
                    : "value",
                direction:
                    options.direction === "asc"
                        ? "asc"
                        : "desc",
                innerRadiusRatio: parseNumber(
                    options.innerRadiusRatio,
                    DEFAULT_INNER_RADIUS_RATIO,
                    0,
                    0.9
                ),
                outerRadiusRatio: parseNumber(
                    options.outerRadiusRatio,
                    DEFAULT_OUTER_RADIUS_RATIO,
                    0.1,
                    0.49
                ),
                gap: parseNumber(
                    options.gap,
                    DEFAULT_GAP,
                    0,
                    0.2
                ),
                rotation: parseNumber(
                    options.rotation,
                    -Math.PI / 2,
                    -Math.PI * 8,
                    Math.PI * 8
                ),
                background:
                    options.background ||
                    DEFAULT_BACKGROUND,
                foreground:
                    options.foreground ||
                    DEFAULT_FOREGROUND,
                highlight:
                    options.highlight ||
                    DEFAULT_HIGHLIGHT,
                gridColor:
                    options.gridColor ||
                    DEFAULT_GRID,
                axisColor:
                    options.axisColor ||
                    DEFAULT_AXIS,
                labelColor:
                    options.labelColor ||
                    DEFAULT_LABEL,
                showLabels:
                    options.showLabels !== false,
                showValues:
                    options.showValues === true,
                showLegend:
                    options.showLegend !== false,
                showGrid:
                    options.showGrid !== false,
                showCenterLabel:
                    options.showCenterLabel !== false,
                interactive:
                    options.interactive !== false,
                zoomable:
                    options.zoomable !== false,
                rotatable:
                    options.rotatable !== false,
                animated:
                    options.animated === true,
                autoRotate:
                    options.autoRotate === true,
                rotationSpeed: parseNumber(
                    options.rotationSpeed,
                    0.00012,
                    -0.01,
                    0.01
                ),
                maxSegments: parseNumber(
                    options.maxSegments,
                    DEFAULT_MAX_SEGMENTS,
                    1,
                    100000
                ),
                label:
                    options.label ||
                    "Radial visualization"
            };

            if (
                this.options.innerRadiusRatio >=
                this.options.outerRadiusRatio
            ) {
                this.options.innerRadiusRatio =
                    Math.max(
                        0,
                        this.options.outerRadiusRatio - 0.1
                    );
            }

            this.records = [];
            this.segments = [];
            this.roots = [];
            this.byId = new Map();
            this.visibleSegments = [];
            this.center = {
                x: 0,
                y: 0
            };
            this.radius = {
                inner: 1,
                outer: 1
            };
            this.bounds = {
                width: 1,
                height: 1
            };
            this.transform = {
                zoom: 1,
                rotation: this.options.rotation
            };
            this.hovered = null;
            this.selected = null;
            this.drag = null;
            this.query = "";
            this.groupFilter = null;
            this.running = false;
            this.paused = false;
            this.destroyed = false;
            this.animationFrame = 0;
            this.lastFrameAt = 0;
            this.startedAt = null;
            this.lastError = null;
            this.metrics = {
                inputRecords: 0,
                acceptedRecords: 0,
                rejectedRecords: 0,
                segments: 0,
                visibleSegments: 0,
                roots: 0,
                groups: 0,
                draws: 0,
                frames: 0,
                rotations: 0,
                zooms: 0,
                selections: 0,
                rebuilds: 0,
                resizes: 0,
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

            if (this.options.animated) {
                this.start();
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
            this.center.x =
                this.bounds.width / 2;
            this.center.y =
                this.bounds.height / 2;

            const baseRadius =
                Math.min(
                    this.bounds.width,
                    this.bounds.height
                );

            this.radius.inner =
                baseRadius *
                this.options.innerRadiusRatio *
                this.transform.zoom;
            this.radius.outer =
                baseRadius *
                this.options.outerRadiusRatio *
                this.transform.zoom;

            this.metrics.resizes += 1;
            this.layout();
            this.draw();

            this._emit("resize", {
                width: this.bounds.width,
                height: this.bounds.height,
                innerRadius: this.radius.inner,
                outerRadius: this.radius.outer
            });
        }

        setData(data) {
            try {
                this.records = normalizeRecords(data);

                if (!this.options.labelKey && !this.options.labelAccessor) {
                    this.options.labelKey =
                        inferField(this.records, LABEL_FIELDS);
                }

                if (!this.options.valueKey && !this.options.valueAccessor) {
                    this.options.valueKey =
                        inferField(this.records, VALUE_FIELDS);
                }

                if (!this.options.groupKey && !this.options.groupAccessor) {
                    this.options.groupKey =
                        inferField(this.records, GROUP_FIELDS);
                }

                this.rebuild();
                this.layout();
                this.draw();

                this._emit("data", {
                    records: this.records.length,
                    segments: this.segments.length,
                    roots: this.roots.length
                });
            } catch (error) {
                this._recordError(error);
            }

            return this;
        }

        append(data) {
            const records = normalizeRecords(data);

            this.records.push(...records);

            if (this.records.length > DEFAULT_MAX_RECORDS) {
                this.records.splice(
                    0,
                    this.records.length - DEFAULT_MAX_RECORDS
                );
            }

            this.rebuild();
            this.layout();
            this.draw();

            this._emit("append", {
                added: records.length,
                records: this.records.length
            });

            return records.length;
        }

        rebuild() {
            const buckets = new Map();
            let accepted = 0;
            let rejected = 0;

            this.byId.clear();
            this.segments = [];

            for (let index = 0; index < this.records.length; index += 1) {
                const record = this.records[index];
                const label =
                    labelForRecord(
                        record,
                        index,
                        this.options
                    );
                const value =
                    valueForRecord(
                        record,
                        index,
                        this.options
                    );
                const group =
                    groupForRecord(
                        record,
                        this.options
                    );
                const id =
                    idForRecord(record, index);
                const parentId =
                    parentForRecord(
                        record,
                        this.options
                    );

                if (
                    !label ||
                    value === null ||
                    !Number.isFinite(value)
                ) {
                    rejected += 1;
                    continue;
                }

                const key =
                    this.options.mode === "sunburst"
                        ? id
                        : `${group}\u0000${label}`;

                if (!buckets.has(key)) {
                    if (
                        buckets.size >=
                        this.options.maxSegments
                    ) {
                        rejected += 1;
                        continue;
                    }

                    buckets.set(key, {
                        key,
                        id,
                        label,
                        group,
                        parentId,
                        count: 0,
                        sum: 0,
                        minimum: Infinity,
                        maximum: -Infinity,
                        values: [],
                        records: []
                    });
                }

                const bucket = buckets.get(key);

                bucket.count += 1;
                bucket.sum += value;
                bucket.minimum = Math.min(
                    bucket.minimum,
                    value
                );
                bucket.maximum = Math.max(
                    bucket.maximum,
                    value
                );

                if (bucket.values.length < 10000) {
                    bucket.values.push(value);
                }

                if (bucket.records.length < 100) {
                    bucket.records.push(record);
                }

                accepted += 1;
            }

            for (const bucket of buckets.values()) {
                let value;

                switch (this.options.aggregation) {
                    case "average":
                        value =
                            bucket.count
                                ? bucket.sum / bucket.count
                                : 0;
                        break;

                    case "min":
                        value = bucket.minimum;
                        break;

                    case "max":
                        value = bucket.maximum;
                        break;

                    case "count":
                        value = bucket.count;
                        break;

                    case "sum":
                    default:
                        value = bucket.sum;
                        break;
                }

                const segment = {
                    key: bucket.key,
                    id: bucket.id,
                    label: bucket.label,
                    group: bucket.group,
                    parentId: bucket.parentId,
                    parent: null,
                    children: [],
                    count: bucket.count,
                    sum: bucket.sum,
                    minimum: bucket.minimum,
                    maximum: bucket.maximum,
                    average:
                        bucket.count
                            ? bucket.sum / bucket.count
                            : 0,
                    value,
                    records:
                        bucket.records.map(clone),
                    depth: 0,
                    total: value,
                    collapsed: false,
                    visible: true,
                    matched: true,
                    startAngle: 0,
                    endAngle: 0,
                    innerRadius: 0,
                    outerRadius: 0,
                    screenPath: null
                };

                this.segments.push(segment);
                this.byId.set(segment.id, segment);
            }

            if (this.options.mode === "sunburst") {
                for (const segment of this.segments) {
                    if (
                        segment.parentId &&
                        this.byId.has(segment.parentId)
                    ) {
                        const parent =
                            this.byId.get(segment.parentId);

                        if (parent !== segment) {
                            segment.parent = parent;
                            parent.children.push(segment);
                        }
                    }
                }
            }

            this.roots =
                this.options.mode === "sunburst"
                    ? this.segments.filter(
                        (segment) => !segment.parent
                    )
                    : this.segments;

            const computeTotals = (
                segment,
                depth = 0,
                stack = new Set()
            ) => {
                if (stack.has(segment.id)) {
                    segment.parent = null;
                    segment.parentId = null;
                    return segment.value;
                }

                stack.add(segment.id);
                segment.depth = depth;

                if (!segment.children.length) {
                    segment.total = Math.max(
                        0,
                        segment.value
                    );
                    return segment.total;
                }

                const childTotal =
                    segment.children.reduce(
                        (total, child) =>
                            total +
                            computeTotals(
                                child,
                                depth + 1,
                                new Set(stack)
                            ),
                        0
                    );

                segment.total = Math.max(
                    segment.value,
                    childTotal
                );

                return segment.total;
            };

            this.roots.forEach((root) =>
                computeTotals(root)
            );

            this._sortSegments();
            this._applyFilters();

            this.metrics.inputRecords =
                this.records.length;
            this.metrics.acceptedRecords =
                accepted;
            this.metrics.rejectedRecords =
                rejected;
            this.metrics.segments =
                this.segments.length;
            this.metrics.roots =
                this.roots.length;
            this.metrics.groups =
                new Set(
                    this.segments.map(
                        (segment) => segment.group
                    )
                ).size;
            this.metrics.rebuilds += 1;
        }

        _sortSegments() {
            const multiplier =
                this.options.direction === "asc"
                    ? 1
                    : -1;

            const compare = (left, right) => {
                switch (this.options.sort) {
                    case "label":
                        return (
                            left.label.localeCompare(
                                right.label
                            ) *
                            multiplier
                        );

                    case "group":
                        return (
                            left.group.localeCompare(
                                right.group
                            ) *
                            multiplier ||
                            left.label.localeCompare(
                                right.label
                            )
                        );

                    case "none":
                        return 0;

                    case "value":
                    default:
                        return (
                            (
                                left.value -
                                right.value
                            ) *
                            multiplier ||
                            left.label.localeCompare(
                                right.label
                            )
                        );
                }
            };

            this.roots.sort(compare);

            const visit = (segment) => {
                segment.children.sort(compare);
                segment.children.forEach(visit);
            };

            this.roots.forEach(visit);
        }

        _applyFilters() {
            const query =
                this.query.toLowerCase();

            for (const segment of this.segments) {
                segment.matched =
                    (
                        !query ||
                        segment.label
                            .toLowerCase()
                            .includes(query) ||
                        segment.group
                            .toLowerCase()
                            .includes(query) ||
                        segment.id
                            .toLowerCase()
                            .includes(query)
                    ) &&
                    (
                        !this.groupFilter ||
                        segment.group ===
                        this.groupFilter
                    );
            }

            if (this.options.mode === "sunburst") {
                const propagate = (segment) => {
                    const childMatch =
                        segment.children.some(
                            propagate
                        );

                    segment.visible =
                        segment.matched ||
                        childMatch;

                    return segment.visible;
                };

                this.roots.forEach(propagate);
            } else {
                for (const segment of this.segments) {
                    segment.visible =
                        segment.matched;
                }
            }
        }

        layout() {
            this.visibleSegments = [];

            if (!this.segments.length) {
                return;
            }

            switch (this.options.mode) {
                case "radial-bar":
                    this._layoutRadialBars();
                    break;

                case "polar-area":
                    this._layoutPolarArea();
                    break;

                case "rings":
                    this._layoutRings();
                    break;

                case "donut":
                    this._layoutDonut();
                    break;

                case "sunburst":
                default:
                    this._layoutSunburst();
                    break;
            }

            this.metrics.visibleSegments =
                this.visibleSegments.length;
        }

        _layoutSunburst() {
            const visibleRoots =
                this.roots.filter(
                    (segment) => segment.visible
                );
            const maxDepth = Math.max(
                ...this.segments.map(
                    (segment) => segment.depth
                ),
                0
            );
            const ringWidth =
                (
                    this.radius.outer -
                    this.radius.inner
                ) /
                Math.max(
                    1,
                    maxDepth + 1
                );
            const total =
                visibleRoots.reduce(
                    (sum, segment) =>
                        sum +
                        Math.max(
                            0,
                            segment.total
                        ),
                    0
                ) || 1;

            let angle =
                this.transform.rotation;

            const assign = (
                segment,
                startAngle,
                endAngle
            ) => {
                if (!segment.visible) {
                    return;
                }

                segment.startAngle =
                    startAngle;
                segment.endAngle =
                    endAngle;
                segment.innerRadius =
                    this.radius.inner +
                    segment.depth *
                    ringWidth;
                segment.outerRadius =
                    segment.innerRadius +
                    ringWidth;
                this.visibleSegments.push(
                    segment
                );

                if (
                    segment.collapsed ||
                    !segment.children.length
                ) {
                    return;
                }

                const children =
                    segment.children.filter(
                        (child) => child.visible
                    );
                const childTotal =
                    children.reduce(
                        (sum, child) =>
                            sum +
                            Math.max(
                                0,
                                child.total
                            ),
                        0
                    ) || 1;
                let childAngle =
                    startAngle;

                for (const child of children) {
                    const span =
                        (
                            endAngle -
                            startAngle
                        ) *
                        (
                            Math.max(
                                0,
                                child.total
                            ) /
                            childTotal
                        );
                    assign(
                        child,
                        childAngle,
                        childAngle + span
                    );
                    childAngle += span;
                }
            };

            for (const root of visibleRoots) {
                const span =
                    Math.PI *
                    2 *
                    (
                        Math.max(
                            0,
                            root.total
                        ) /
                        total
                    );

                assign(
                    root,
                    angle,
                    angle + span
                );
                angle += span;
            }
        }

        _layoutRadialBars() {
            const visible =
                this.segments.filter(
                    (segment) => segment.visible
                );
            const maximum = Math.max(
                ...visible.map(
                    (segment) => segment.value
                ),
                1
            );
            const count =
                Math.max(1, visible.length);
            const step =
                Math.PI * 2 / count;

            visible.forEach(
                (segment, index) => {
                    const start =
                        this.transform.rotation +
                        index * step;
                    const ratio =
                        Math.max(
                            0,
                            segment.value
                        ) /
                        maximum;

                    segment.startAngle =
                        start +
                        this.options.gap;
                    segment.endAngle =
                        start +
                        step -
                        this.options.gap;
                    segment.innerRadius =
                        this.radius.inner;
                    segment.outerRadius =
                        this.radius.inner +
                        (
                            this.radius.outer -
                            this.radius.inner
                        ) *
                        ratio;
                    this.visibleSegments.push(
                        segment
                    );
                }
            );
        }

        _layoutPolarArea() {
            const visible =
                this.segments.filter(
                    (segment) => segment.visible
                );
            const maximum = Math.max(
                ...visible.map(
                    (segment) => segment.value
                ),
                1
            );
            const count =
                Math.max(1, visible.length);
            const step =
                Math.PI * 2 / count;

            visible.forEach(
                (segment, index) => {
                    const ratio =
                        Math.sqrt(
                            Math.max(
                                0,
                                segment.value
                            ) /
                            maximum
                        );
                    const start =
                        this.transform.rotation +
                        index * step;

                    segment.startAngle =
                        start +
                        this.options.gap;
                    segment.endAngle =
                        start +
                        step -
                        this.options.gap;
                    segment.innerRadius =
                        this.radius.inner;
                    segment.outerRadius =
                        this.radius.inner +
                        (
                            this.radius.outer -
                            this.radius.inner
                        ) *
                        ratio;
                    this.visibleSegments.push(
                        segment
                    );
                }
            );
        }

        _layoutRings() {
            const visible =
                this.segments.filter(
                    (segment) => segment.visible
                );
            const maximum = Math.max(
                ...visible.map(
                    (segment) => segment.value
                ),
                1
            );
            const ringWidth =
                (
                    this.radius.outer -
                    this.radius.inner
                ) /
                Math.max(
                    1,
                    visible.length
                );

            visible.forEach(
                (segment, index) => {
                    const ratio =
                        Math.max(
                            0,
                            segment.value
                        ) /
                        maximum;

                    segment.startAngle =
                        this.transform.rotation;
                    segment.endAngle =
                        this.transform.rotation +
                        Math.PI *
                        2 *
                        ratio;
                    segment.innerRadius =
                        this.radius.inner +
                        index *
                        ringWidth;
                    segment.outerRadius =
                        segment.innerRadius +
                        ringWidth *
                        0.82;
                    this.visibleSegments.push(
                        segment
                    );
                }
            );
        }

        _layoutDonut() {
            const visible =
                this.segments.filter(
                    (segment) => segment.visible
                );
            const total =
                visible.reduce(
                    (sum, segment) =>
                        sum +
                        Math.max(
                            0,
                            segment.value
                        ),
                    0
                ) || 1;
            let angle =
                this.transform.rotation;

            for (const segment of visible) {
                const span =
                    Math.PI *
                    2 *
                    (
                        Math.max(
                            0,
                            segment.value
                        ) /
                        total
                    );

                segment.startAngle =
                    angle +
                    this.options.gap;
                segment.endAngle =
                    angle +
                    span -
                    this.options.gap;
                segment.innerRadius =
                    this.radius.inner;
                segment.outerRadius =
                    this.radius.outer;
                this.visibleSegments.push(
                    segment
                );
                angle += span;
            }
        }

        start() {
            if (this.destroyed) {
                throw new Error(
                    "Radial controller has been destroyed."
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
                    (timestamp) =>
                        this._frame(timestamp)
                );

            this._emit("start", {});
            return this;
        }

        stop() {
            const active =
                this.running ||
                this.paused;

            this.running = false;
            this.paused = false;

            if (this.animationFrame) {
                window.cancelAnimationFrame(
                    this.animationFrame
                );
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
                    (timestamp) =>
                        this._frame(timestamp)
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
                ? Math.min(
                    50,
                    timestamp - this.lastFrameAt
                )
                : 16.667;

            this.lastFrameAt = timestamp;

            if (
                this.options.autoRotate &&
                !this.drag
            ) {
                this.transform.rotation +=
                    this.options.rotationSpeed *
                    delta;
                this.metrics.rotations += 1;
                this.layout();
            }

            this.draw();
            this.metrics.frames += 1;

            this.animationFrame =
                window.requestAnimationFrame(
                    (nextTimestamp) =>
                        this._frame(nextTimestamp)
                );
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

            if (!this.visibleSegments.length) {
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
                    "No radial data.",
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

            this._drawSegments();

            if (this.options.showLabels) {
                this._drawLabels();
            }

            if (this.options.showCenterLabel) {
                this._drawCenterLabel();
            }

            if (this.options.showLegend) {
                this._drawLegend();
            }

            this.metrics.draws += 1;
        }

        _drawGrid() {
            this.context.save();
            this.context.strokeStyle =
                this.options.gridColor;
            this.context.globalAlpha =
                0.24;
            this.context.lineWidth = 1;

            const rings = 5;

            for (
                let index = 1;
                index <= rings;
                index += 1
            ) {
                const radius =
                    this.radius.inner +
                    (
                        this.radius.outer -
                        this.radius.inner
                    ) *
                    (
                        index / rings
                    );

                this.context.beginPath();
                this.context.arc(
                    this.center.x,
                    this.center.y,
                    radius,
                    0,
                    Math.PI * 2
                );
                this.context.stroke();
            }

            for (
                let index = 0;
                index < 12;
                index += 1
            ) {
                const angle =
                    this.transform.rotation +
                    index *
                    Math.PI *
                    2 /
                    12;

                this.context.beginPath();
                this.context.moveTo(
                    this.center.x +
                    Math.cos(angle) *
                    this.radius.inner,
                    this.center.y +
                    Math.sin(angle) *
                    this.radius.inner
                );
                this.context.lineTo(
                    this.center.x +
                    Math.cos(angle) *
                    this.radius.outer,
                    this.center.y +
                    Math.sin(angle) *
                    this.radius.outer
                );
                this.context.stroke();
            }

            this.context.restore();
        }

        _drawSegments() {
            this.context.save();

            for (
                const segment
                of this.visibleSegments
            ) {
                const emphasized =
                    segment === this.hovered ||
                    segment === this.selected;
                const start =
                    segment.startAngle;
                const end =
                    Math.max(
                        start,
                        segment.endAngle
                    );
                const inner =
                    segment.innerRadius;
                const outer =
                    emphasized
                        ? segment.outerRadius + 4
                        : segment.outerRadius;

                this.context.beginPath();
                this.context.arc(
                    this.center.x,
                    this.center.y,
                    outer,
                    start,
                    end
                );
                this.context.arc(
                    this.center.x,
                    this.center.y,
                    Math.max(0, inner),
                    end,
                    start,
                    true
                );
                this.context.closePath();

                this.context.fillStyle =
                    emphasized
                        ? this.options.highlight
                        : colorHash(
                            segment.group ||
                            segment.label
                        );
                this.context.globalAlpha =
                    emphasized ? 1 : 0.86;

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
                this.context.globalAlpha =
                    0.78;
                this.context.lineWidth = 1;
                this.context.stroke();

                segment.screenPath = {
                    startAngle: start,
                    endAngle: end,
                    innerRadius: inner,
                    outerRadius: outer
                };
            }

            this.context.restore();
        }

        _drawLabels() {
            this.context.save();
            this.context.font =
                '10px "IBM Plex Mono", monospace';
            this.context.textBaseline =
                "middle";

            for (
                const segment
                of this.visibleSegments
            ) {
                const span =
                    segment.endAngle -
                    segment.startAngle;

                if (
                    span < 0.04 &&
                    segment !== this.hovered &&
                    segment !== this.selected
                ) {
                    continue;
                }

                const angle =
                    (
                        segment.startAngle +
                        segment.endAngle
                    ) /
                    2;
                const radius =
                    (
                        segment.innerRadius +
                        segment.outerRadius
                    ) /
                    2;
                const x =
                    this.center.x +
                    Math.cos(angle) *
                    radius;
                const y =
                    this.center.y +
                    Math.sin(angle) *
                    radius;
                const emphasized =
                    segment === this.hovered ||
                    segment === this.selected;
                const text =
                    this.options.showValues
                        ? `${segment.label}: ${Number(
                            segment.value.toPrecision(4)
                        )}`
                        : segment.label;

                this.context.fillStyle =
                    emphasized
                        ? this.options.highlight
                        : this.options.labelColor;
                this.context.globalAlpha =
                    emphasized ? 1 : 0.8;
                this.context.textAlign =
                    Math.cos(angle) >= 0
                        ? "left"
                        : "right";

                if (
                    this.options.mode === "rings"
                ) {
                    this.context.fillText(
                        text,
                        this.center.x +
                        Math.cos(
                            this.transform.rotation
                        ) *
                        (
                            segment.outerRadius +
                            6
                        ),
                        this.center.y +
                        Math.sin(
                            this.transform.rotation
                        ) *
                        (
                            segment.outerRadius +
                            6
                        )
                    );
                } else {
                    this.context.fillText(
                        text,
                        x,
                        y
                    );
                }
            }

            this.context.restore();
        }

        _drawCenterLabel() {
            const selected =
                this.selected ||
                this.hovered;
            const primary =
                selected
                    ? selected.label
                    : this.options.label;
            const secondary =
                selected
                    ? Number(
                        selected.value.toPrecision(6)
                    ).toString()
                    : `${this.visibleSegments.length} segment` +
                      `${this.visibleSegments.length === 1 ? "" : "s"}`;

            this.context.save();
            this.context.textAlign =
                "center";
            this.context.textBaseline =
                "middle";
            this.context.fillStyle =
                selected
                    ? this.options.highlight
                    : this.options.foreground;
            this.context.globalAlpha = 0.92;
            this.context.font =
                '13px "IBM Plex Mono", monospace';
            this.context.fillText(
                primary,
                this.center.x,
                this.center.y - 8
            );
            this.context.globalAlpha = 0.64;
            this.context.font =
                '10px "IBM Plex Mono", monospace';
            this.context.fillText(
                secondary,
                this.center.x,
                this.center.y + 10
            );
            this.context.restore();
        }

        _drawLegend() {
            const groups = Array.from(
                new Set(
                    this.visibleSegments.map(
                        (segment) =>
                            segment.group
                    )
                )
            ).slice(0, 16);

            if (groups.length <= 1) {
                return;
            }

            this.context.save();
            this.context.font =
                '10px "IBM Plex Mono", monospace';
            this.context.textBaseline =
                "middle";

            let x = 16;
            let y =
                this.bounds.height - 16;

            for (const group of groups) {
                this.context.fillStyle =
                    colorHash(group);
                this.context.globalAlpha =
                    0.9;
                this.context.fillRect(
                    x,
                    y - 4,
                    8,
                    8
                );

                x += 12;
                this.context.fillStyle =
                    this.options.labelColor;
                this.context.fillText(
                    group,
                    x,
                    y
                );

                x +=
                    this.context.measureText(
                        group
                    ).width +
                    18;

                if (
                    x >
                    this.bounds.width - 180
                ) {
                    x = 16;
                    y -= 16;
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
            const dx =
                x - this.center.x;
            const dy =
                y - this.center.y;
            const radius =
                Math.hypot(dx, dy);
            let angle =
                Math.atan2(dy, dx);

            while (angle < -Math.PI * 2) {
                angle += Math.PI * 2;
            }

            while (angle > Math.PI * 2) {
                angle -= Math.PI * 2;
            }

            for (
                let index =
                    this.visibleSegments.length -
                    1;
                index >= 0;
                index -= 1
            ) {
                const segment =
                    this.visibleSegments[index];
                const path =
                    segment.screenPath;

                if (!path) {
                    continue;
                }

                let adjusted = angle;
                const start =
                    path.startAngle;
                const end =
                    path.endAngle;

                while (adjusted < start) {
                    adjusted += Math.PI * 2;
                }

                while (adjusted > end) {
                    adjusted -= Math.PI * 2;
                }

                const angleInside =
                    adjusted >= start &&
                    adjusted <= end;
                const radiusInside =
                    radius >= path.innerRadius &&
                    radius <= path.outerRadius;

                if (
                    angleInside &&
                    radiusInside
                ) {
                    return segment;
                }
            }

            return null;
        }

        _handlePointerMove(event) {
            const point =
                this._pointFromEvent(event);

            if (this.drag) {
                const angle =
                    Math.atan2(
                        point.y -
                        this.center.y,
                        point.x -
                        this.center.x
                    );

                this.transform.rotation =
                    this.drag.startRotation +
                    angle -
                    this.drag.startAngle;
                this.metrics.rotations += 1;
                this.layout();
                this.draw();
                return;
            }

            const hovered =
                this.hitTest(
                    point.x,
                    point.y
                );
            const changed =
                hovered?.key !==
                this.hovered?.key;

            this.hovered = hovered;
            this.canvas.style.cursor =
                hovered
                    ? "pointer"
                    : this.options.rotatable
                        ? "grab"
                        : "default";

            if (changed) {
                this.draw();

                this._emit("hover", {
                    segment:
                        hovered
                            ? this.describeSegment(
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
                    segment: null
                });
            }
        }

        _handlePointerDown(event) {
            if (
                !this.options.rotatable ||
                event.button !== 0
            ) {
                return;
            }

            const point =
                this._pointFromEvent(event);

            this.drag = {
                startAngle:
                    Math.atan2(
                        point.y -
                        this.center.y,
                        point.x -
                        this.center.x
                    ),
                startRotation:
                    this.transform.rotation
            };

            this.canvas.setPointerCapture?.(
                event.pointerId
            );
            this.canvas.style.cursor =
                "grabbing";
        }

        _handlePointerUp(event) {
            if (!this.drag) {
                return;
            }

            this.canvas.releasePointerCapture?.(
                event.pointerId
            );
            this.drag = null;
            this.canvas.style.cursor =
                "grab";

            this._emit("rotate", {
                rotation:
                    this.transform.rotation
            });
        }

        _handleWheel(event) {
            if (!this.options.zoomable) {
                return;
            }

            event.preventDefault();

            const factor =
                event.deltaY < 0
                    ? 1.12
                    : 1 / 1.12;

            this.setZoom(
                this.transform.zoom *
                factor
            );
        }

        _handleClick(event) {
            if (this.drag) {
                return;
            }

            const point =
                this._pointFromEvent(event);
            const segment =
                this.hitTest(
                    point.x,
                    point.y
                );

            this.selected =
                segment?.key ===
                this.selected?.key
                    ? null
                    : segment;
            this.metrics.selections += 1;
            this.draw();

            this._emit("select", {
                segment:
                    this.selected
                        ? this.describeSegment(
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
                event.key === "ArrowLeft"
            ) {
                event.preventDefault();
                this.rotateBy(
                    -Math.PI / 24
                );
            } else if (
                event.key === "ArrowRight"
            ) {
                event.preventDefault();
                this.rotateBy(
                    Math.PI / 24
                );
            } else if (
                event.key === "Escape"
            ) {
                this.selected = null;
                this.draw();
            } else if (
                event.key === "Enter" &&
                this.selected?.children.length
            ) {
                event.preventDefault();
                this.toggleSegment(
                    this.selected.id
                );
            }
        }

        setZoom(value) {
            this.transform.zoom =
                Math.max(
                    0.35,
                    Math.min(
                        4,
                        parseNumber(
                            value,
                            this.transform.zoom
                        )
                    )
                );

            const baseRadius =
                Math.min(
                    this.bounds.width,
                    this.bounds.height
                );

            this.radius.inner =
                baseRadius *
                this.options.innerRadiusRatio *
                this.transform.zoom;
            this.radius.outer =
                baseRadius *
                this.options.outerRadiusRatio *
                this.transform.zoom;

            this.metrics.zooms += 1;
            this.layout();
            this.draw();

            this._emit("zoom", {
                zoom:
                    this.transform.zoom
            });

            return this.transform.zoom;
        }

        rotateBy(amount) {
            this.transform.rotation +=
                Number(amount) || 0;
            this.metrics.rotations += 1;
            this.layout();
            this.draw();

            return this.transform.rotation;
        }

        resetView() {
            this.transform = {
                zoom: 1,
                rotation:
                    this.options.rotation
            };
            this.selected = null;

            const baseRadius =
                Math.min(
                    this.bounds.width,
                    this.bounds.height
                );

            this.radius.inner =
                baseRadius *
                this.options.innerRadiusRatio;
            this.radius.outer =
                baseRadius *
                this.options.outerRadiusRatio;

            this.layout();
            this.draw();

            return clone(
                this.transform
            );
        }

        setMode(mode) {
            if (
                ![
                    "sunburst",
                    "radial-bar",
                    "polar-area",
                    "rings",
                    "donut"
                ].includes(mode)
            ) {
                throw new Error(
                    `Unknown radial mode: ${mode}`
                );
            }

            this.options.mode = mode;
            this.rebuild();
            this.layout();
            this.draw();

            return mode;
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
                visibleSegments:
                    this.visibleSegments.length
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

        toggleSegment(id) {
            const segment =
                this.byId.get(
                    String(id)
                );

            if (
                !segment ||
                !segment.children.length
            ) {
                return null;
            }

            segment.collapsed =
                !segment.collapsed;
            this.layout();
            this.draw();

            return segment.collapsed;
        }

        describeSegment(segment) {
            if (!segment) {
                return null;
            }

            return {
                key:
                    segment.key,
                id:
                    segment.id,
                label:
                    segment.label,
                group:
                    segment.group,
                parentId:
                    segment.parent?.id ||
                    null,
                count:
                    segment.count,
                sum:
                    segment.sum,
                minimum:
                    segment.minimum,
                maximum:
                    segment.maximum,
                average:
                    segment.average,
                value:
                    segment.value,
                depth:
                    segment.depth,
                total:
                    segment.total,
                collapsed:
                    segment.collapsed,
                children:
                    segment.children.map(
                        (child) => ({
                            id:
                                child.id,
                            label:
                                child.label,
                            value:
                                child.value
                        })
                    ),
                records:
                    segment.records.map(
                        clone
                    )
            };
        }

        update(options = {}) {
            if (!isObject(options)) {
                throw new TypeError(
                    "Radial options must be an object."
                );
            }

            const rebuildRequired = [
                "mode",
                "labelKey",
                "labelAccessor",
                "valueKey",
                "valueAccessor",
                "groupKey",
                "groupAccessor",
                "parentKey",
                "parentAccessor",
                "aggregation",
                "sort",
                "direction",
                "maxSegments"
            ].some(
                (key) =>
                    options[key] !== undefined
            );

            Object.assign(
                this.options,
                {
                    mode:
                        options.mode ||
                        this.options.mode,
                    labelKey:
                        options.labelKey !== undefined
                            ? options.labelKey
                            : this.options.labelKey,
                    labelAccessor:
                        options.labelAccessor !== undefined
                            ? options.labelAccessor
                            : this.options.labelAccessor,
                    valueKey:
                        options.valueKey !== undefined
                            ? options.valueKey
                            : this.options.valueKey,
                    valueAccessor:
                        options.valueAccessor !== undefined
                            ? options.valueAccessor
                            : this.options.valueAccessor,
                    groupKey:
                        options.groupKey !== undefined
                            ? options.groupKey
                            : this.options.groupKey,
                    groupAccessor:
                        options.groupAccessor !== undefined
                            ? options.groupAccessor
                            : this.options.groupAccessor,
                    parentKey:
                        options.parentKey !== undefined
                            ? options.parentKey
                            : this.options.parentKey,
                    parentAccessor:
                        options.parentAccessor !== undefined
                            ? options.parentAccessor
                            : this.options.parentAccessor,
                    aggregation:
                        options.aggregation ||
                        this.options.aggregation,
                    sort:
                        options.sort ||
                        this.options.sort,
                    direction:
                        options.direction ||
                        this.options.direction,
                    innerRadiusRatio:
                        options.innerRadiusRatio !== undefined
                            ? parseNumber(
                                options.innerRadiusRatio,
                                this.options.innerRadiusRatio,
                                0,
                                0.9
                            )
                            : this.options.innerRadiusRatio,
                    outerRadiusRatio:
                        options.outerRadiusRatio !== undefined
                            ? parseNumber(
                                options.outerRadiusRatio,
                                this.options.outerRadiusRatio,
                                0.1,
                                0.49
                            )
                            : this.options.outerRadiusRatio,
                    gap:
                        options.gap !== undefined
                            ? parseNumber(
                                options.gap,
                                this.options.gap,
                                0,
                                0.2
                            )
                            : this.options.gap,
                    background:
                        options.background ||
                        this.options.background,
                    foreground:
                        options.foreground ||
                        this.options.foreground,
                    highlight:
                        options.highlight ||
                        this.options.highlight,
                    gridColor:
                        options.gridColor ||
                        this.options.gridColor,
                    axisColor:
                        options.axisColor ||
                        this.options.axisColor,
                    labelColor:
                        options.labelColor ||
                        this.options.labelColor,
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
                    showLegend:
                        options.showLegend !== undefined
                            ? Boolean(
                                options.showLegend
                            )
                            : this.options.showLegend,
                    showGrid:
                        options.showGrid !== undefined
                            ? Boolean(
                                options.showGrid
                            )
                            : this.options.showGrid,
                    showCenterLabel:
                        options.showCenterLabel !== undefined
                            ? Boolean(
                                options.showCenterLabel
                            )
                            : this.options.showCenterLabel,
                    autoRotate:
                        options.autoRotate !== undefined
                            ? Boolean(
                                options.autoRotate
                            )
                            : this.options.autoRotate,
                    rotationSpeed:
                        options.rotationSpeed !== undefined
                            ? parseNumber(
                                options.rotationSpeed,
                                this.options.rotationSpeed,
                                -0.01,
                                0.01
                            )
                            : this.options.rotationSpeed,
                    maxSegments:
                        options.maxSegments !== undefined
                            ? parseNumber(
                                options.maxSegments,
                                this.options.maxSegments,
                                1,
                                100000
                            )
                            : this.options.maxSegments
                }
            );

            if (
                this.options.innerRadiusRatio >=
                this.options.outerRadiusRatio
            ) {
                this.options.innerRadiusRatio =
                    Math.max(
                        0,
                        this.options.outerRadiusRatio - 0.1
                    );
            }

            const baseRadius =
                Math.min(
                    this.bounds.width,
                    this.bounds.height
                );

            this.radius.inner =
                baseRadius *
                this.options.innerRadiusRatio *
                this.transform.zoom;
            this.radius.outer =
                baseRadius *
                this.options.outerRadiusRatio *
                this.transform.zoom;

            if (rebuildRequired) {
                this.rebuild();
            }

            this.layout();
            this.draw();

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
                        segments:
                            this.segments.map(
                                (segment) =>
                                    this.describeSegment(
                                        segment
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
                    "group",
                    "parentId",
                    "count",
                    "sum",
                    "minimum",
                    "maximum",
                    "average",
                    "value",
                    "depth",
                    "total",
                    "collapsed"
                ]];

                for (const segment of this.segments) {
                    rows.push([
                        segment.id,
                        segment.label,
                        segment.group,
                        segment.parent?.id || "",
                        segment.count,
                        segment.sum,
                        segment.minimum,
                        segment.maximum,
                        segment.average,
                        segment.value,
                        segment.depth,
                        segment.total,
                        segment.collapsed
                    ]);
                }

                return rows
                    .map(
                        (row) =>
                            row
                                .map(escapeCsv)
                                .join(",")
                    )
                    .join("\r\n");
            }

            throw new Error(
                `Unsupported Radial export format: ${format}`
            );
        }

        status() {
            return {
                name:
                    "radial",
                module:
                    MODULE_NAME,
                running:
                    this.running,
                paused:
                    this.paused,
                startedAt:
                    this.startedAt,
                records:
                    this.records.length,
                segments:
                    this.segments.length,
                visibleSegments:
                    this.visibleSegments.length,
                roots:
                    this.roots.length,
                groups:
                    this.metrics.groups,
                query:
                    this.query,
                groupFilter:
                    this.groupFilter,
                mode:
                    this.options.mode,
                transform:
                    clone(this.transform),
                selected:
                    this.selected
                        ? this.describeSegment(
                            this.selected
                        )
                        : null,
                hovered:
                    this.hovered
                        ? this.describeSegment(
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

            this.records = [];
            this.segments = [];
            this.roots = [];
            this.visibleSegments = [];
            this.byId.clear();
            this.destroyed = true;

            this._emit("destroy", {});
            return true;
        }
    }

    function mount(target, data = [], options = {}) {
        return new RadialController(
            target,
            data,
            options
        );
    }

    function render(data = [], options = {}) {
        const container = createElement(
            "section",
            "terminal-visualization terminal-visualization-radial"
        );
        container.dataset.visualization =
            "radial";
        container.setAttribute(
            "role",
            "region"
        );
        container.setAttribute(
            "aria-label",
            options.label ||
            "Radial visualization"
        );

        const canvas =
            document.createElement("canvas");
        canvas.className =
            "terminal-radial-canvas";
        canvas.width =
            Number(options.width) ||
            DEFAULT_WIDTH;
        canvas.height =
            Number(options.height) ||
            DEFAULT_HEIGHT;
        canvas.setAttribute(
            "aria-label",
            options.label ||
            "Radial visualization"
        );

        const status = createElement(
            "div",
            "terminal-radial-status"
        );
        status.setAttribute(
            "aria-live",
            "polite"
        );

        const tooltip = createElement(
            "div",
            "terminal-radial-tooltip"
        );
        tooltip.hidden = true;

        container.append(
            canvas,
            status,
            tooltip
        );

        const controller =
            new RadialController(
                canvas,
                data,
                options
            );

        const updateStatus = () => {
            const snapshot =
                controller.status();

            status.textContent =
                `${snapshot.visibleSegments} of ${snapshot.segments} segment` +
                `${snapshot.segments === 1 ? "" : "s"} · ` +
                `${snapshot.groups} group` +
                `${snapshot.groups === 1 ? "" : "s"} · ` +
                `${snapshot.mode} · ` +
                `${snapshot.transform.zoom.toFixed(2)}×`;
        };

        controller.addEventListener(
            "hover",
            (event) => {
                const segment =
                    event.detail?.segment;

                if (!segment) {
                    tooltip.hidden = true;
                    return;
                }

                tooltip.hidden = false;
                tooltip.textContent =
                    `${segment.label} · ${segment.group} · ` +
                    `${segment.value} · ${segment.count} record` +
                    `${segment.count === 1 ? "" : "s"}`;
            }
        );

        for (const eventName of [
            "data",
            "append",
            "resize",
            "zoom",
            "rotate",
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
            controller.segments;
        container.destroy = () =>
            controller.destroy();

        return container;
    }

    function initialize(context = {}) {
        const dataset =
            context.root?.dataset || {};
        const config =
            context.config?.radial || {};

        const defaults = {
            mode:
                dataset.terminalRadialMode ||
                config.mode ||
                "sunburst",

            labelKey:
                dataset.terminalRadialLabelKey ||
                config.labelKey ||
                null,

            valueKey:
                dataset.terminalRadialValueKey ||
                config.valueKey ||
                null,

            groupKey:
                dataset.terminalRadialGroupKey ||
                config.groupKey ||
                null,

            parentKey:
                dataset.terminalRadialParentKey ||
                config.parentKey ||
                null,

            aggregation:
                dataset.terminalRadialAggregation ||
                config.aggregation ||
                "sum",

            sort:
                dataset.terminalRadialSort ||
                config.sort ||
                "value",

            direction:
                dataset.terminalRadialDirection ||
                config.direction ||
                "desc",

            background:
                dataset.terminalRadialBackground ||
                config.background ||
                DEFAULT_BACKGROUND,

            foreground:
                dataset.terminalRadialForeground ||
                config.foreground ||
                DEFAULT_FOREGROUND,

            highlight:
                dataset.terminalRadialHighlight ||
                config.highlight ||
                DEFAULT_HIGHLIGHT,

            gridColor:
                dataset.terminalRadialGrid ||
                config.gridColor ||
                DEFAULT_GRID,

            labelColor:
                dataset.terminalRadialLabelColor ||
                config.labelColor ||
                DEFAULT_LABEL,

            innerRadiusRatio:
                dataset.terminalRadialInnerRadius ||
                config.innerRadiusRatio ||
                DEFAULT_INNER_RADIUS_RATIO,

            outerRadiusRatio:
                dataset.terminalRadialOuterRadius ||
                config.outerRadiusRatio ||
                DEFAULT_OUTER_RADIUS_RATIO,

            showLabels: parseBoolean(
                dataset.terminalRadialShowLabels,
                config.showLabels !== false
            ),

            showValues: parseBoolean(
                dataset.terminalRadialShowValues,
                config.showValues === true
            ),

            showLegend: parseBoolean(
                dataset.terminalRadialShowLegend,
                config.showLegend !== false
            ),

            showGrid: parseBoolean(
                dataset.terminalRadialShowGrid,
                config.showGrid !== false
            ),

            autoRotate: parseBoolean(
                dataset.terminalRadialAutoRotate,
                config.autoRotate === true
            ),

            animated: parseBoolean(
                dataset.terminalRadialAnimated,
                config.animated === true
            ),

            interactive: parseBoolean(
                dataset.terminalRadialInteractive,
                config.interactive !== false
            )
        };

        const visualization = {
            mount(target, data = [], options = {}) {
                return new RadialController(
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
                RadialController,

            normalizeRecords,

            inferField,

            labelForRecord,

            valueForRecord,

            groupForRecord
        };

        context.registerVisualization?.(
            "radial",
            visualization
        );
        context.registerRenderer?.(
            "radial",
            visualization
        );
        context.radial =
            visualization;

        safeDispatch(
            document,
            "speciedex:terminal-radial-ready",
            {
                visualization
            }
        );

        return visualization;
    }

    const commands = [{
        name: "radial",
        category: "visualization",
        description:
            "Render and control sunburst, radial-bar, polar-area, ring, and donut visualizations.",
        usage:
            "radial [collection|status|mode|start|stop|pause|resume|filter|" +
            "group|rotate|zoom|reset|export] [arguments]",
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
                context.radialController ||
                context.terminalRadialController;

            try {
                if (controller) {
                    switch (lower) {
                        case "status":
                        case "show":
                        case "info":
                            return writeJSON(
                                controller.status()
                            );

                        case "mode":
                            if (!args[1]) {
                                return writeJSON({
                                    mode:
                                        controller.options.mode
                                });
                            }

                            return writeJSON({
                                mode:
                                    controller.setMode(
                                        args[1]
                                    )
                            });

                        case "start":
                            controller.start();
                            return write(
                                "Radial visualization started.",
                                "success"
                            );

                        case "stop":
                            controller.stop();
                            return write(
                                "Radial visualization stopped.",
                                "success"
                            );

                        case "pause":
                            controller.pause();
                            return write(
                                "Radial visualization paused.",
                                "success"
                            );

                        case "resume":
                            controller.resume();
                            return write(
                                "Radial visualization resumed.",
                                "success"
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

                        case "rotate":
                            return writeJSON({
                                rotation:
                                    controller.rotateBy(
                                        args[1]
                                    )
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
                        ...context.config?.radial,
                        label:
                            `Radial for ${collection}`
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
        RadialController,
        normalizeRecords,
        inferField,
        labelForRecord,
        valueForRecord,
        groupForRecord,
        mount,
        render,
        initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalRadial =
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
