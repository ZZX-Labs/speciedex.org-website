/*
========================================================================
Speciedex.org
Terminal HeatMesh Visualization
========================================================================

Canvas-based weighted spatial heat-field and mesh renderer for Speciedex
records. Supports geographic and arbitrary x/y data, adaptive grid resolution,
kernel density estimation, bilinear interpolation, contour extraction, point
inspection, zoom, pan, legends, exports, responsive rendering, and runtime
updates.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "HeatMesh";
    const DEFAULT_WIDTH = 960;
    const DEFAULT_HEIGHT = 540;
    const DEFAULT_COLUMNS = 96;
    const DEFAULT_ROWS = 54;
    const DEFAULT_RADIUS = 42;
    const DEFAULT_PADDING = 24;
    const DEFAULT_BACKGROUND = "#020a05";
    const DEFAULT_FOREGROUND = "#c0d674";
    const DEFAULT_GRID = "#1f3a27";
    const DEFAULT_HIGHLIGHT = "#eef7c8";
    const DEFAULT_EMPTY_TEXT = "No heat-mappable records.";
    const MAX_RECORDS = 250000;
    const MAX_CELLS = 262144;

    const DEFAULT_PALETTE = Object.freeze([
        { stop: 0.00, color: "#07100a" },
        { stop: 0.16, color: "#173322" },
        { stop: 0.34, color: "#2f6a3c" },
        { stop: 0.52, color: "#63a84f" },
        { stop: 0.70, color: "#c0d674" },
        { stop: 0.86, color: "#e6a42b" },
        { stop: 1.00, color: "#eef7c8" }
    ]);

    function now() {
        return Date.now();
    }

    function iso(timestamp = now()) {
        return new Date(timestamp).toISOString();
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
            const existing = target.querySelector("canvas");

            if (existing) {
                return existing;
            }

            const canvas = document.createElement("canvas");
            target.appendChild(canvas);
            return canvas;
        }

        throw new TypeError(
            "HeatMesh requires a canvas or container element."
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
            return data.slice(0, MAX_RECORDS);
        }

        if (isObject(data)) {
            for (const key of [
                "records",
                "results",
                "items",
                "features",
                "data"
            ]) {
                if (Array.isArray(data[key])) {
                    return data[key].slice(0, MAX_RECORDS);
                }
            }

            return [data];
        }

        return [data];
    }

    function firstFinite(record, keys) {
        for (const key of keys) {
            const value = Number(record?.[key]);

            if (Number.isFinite(value)) {
                return value;
            }
        }

        return null;
    }

    function extractCoordinates(record, options = {}) {
        if (!isObject(record)) {
            return null;
        }

        if (options.xKey && options.yKey) {
            const x = Number(record[options.xKey]);
            const y = Number(record[options.yKey]);

            if (Number.isFinite(x) && Number.isFinite(y)) {
                return {
                    x,
                    y,
                    source: "explicit"
                };
            }
        }

        if (
            isObject(record.geometry) &&
            Array.isArray(record.geometry.coordinates) &&
            record.geometry.coordinates.length >= 2
        ) {
            const x = Number(record.geometry.coordinates[0]);
            const y = Number(record.geometry.coordinates[1]);

            if (Number.isFinite(x) && Number.isFinite(y)) {
                return {
                    x,
                    y,
                    source: "geometry"
                };
            }
        }

        const longitude = firstFinite(record, [
            "longitude",
            "lon",
            "lng",
            "decimalLongitude",
            "decimal_longitude",
            "x"
        ]);
        const latitude = firstFinite(record, [
            "latitude",
            "lat",
            "decimalLatitude",
            "decimal_latitude",
            "y"
        ]);

        if (longitude !== null && latitude !== null) {
            return {
                x: longitude,
                y: latitude,
                source: "geographic"
            };
        }

        return null;
    }

    function extractWeight(record, options = {}) {
        if (!isObject(record)) {
            return 1;
        }

        if (typeof options.weight === "function") {
            const value = Number(options.weight(record));

            return Number.isFinite(value) ? value : 1;
        }

        if (options.weightKey) {
            const value = Number(record[options.weightKey]);

            if (Number.isFinite(value)) {
                return value;
            }
        }

        for (const key of [
            "weight",
            "count",
            "value",
            "abundance",
            "occurrenceCount",
            "occurrence_count",
            "score",
            "density"
        ]) {
            const value = Number(record[key]);

            if (Number.isFinite(value)) {
                return value;
            }
        }

        return 1;
    }

    function labelForRecord(record, index) {
        if (!isObject(record)) {
            return String(record ?? `Record ${index + 1}`);
        }

        return String(
            record.scientific_name ??
            record.scientificName ??
            record.common_name ??
            record.commonName ??
            record.name ??
            record.label ??
            record.id ??
            `Record ${index + 1}`
        );
    }

    function projectGeographic(longitude, latitude) {
        const clampedLatitude = Math.max(
            -85.05112878,
            Math.min(85.05112878, latitude)
        );
        const x = (longitude + 180) / 360;
        const sinLatitude = Math.sin(
            clampedLatitude * Math.PI / 180
        );
        const y =
            0.5 -
            Math.log(
                (1 + sinLatitude) /
                (1 - sinLatitude)
            ) /
            (4 * Math.PI);

        return { x, y };
    }

    function colorToRgb(color) {
        const value = String(color || "").trim();

        if (/^#[0-9a-f]{3}$/i.test(value)) {
            return {
                r: parseInt(value[1] + value[1], 16),
                g: parseInt(value[2] + value[2], 16),
                b: parseInt(value[3] + value[3], 16)
            };
        }

        if (/^#[0-9a-f]{6}$/i.test(value)) {
            return {
                r: parseInt(value.slice(1, 3), 16),
                g: parseInt(value.slice(3, 5), 16),
                b: parseInt(value.slice(5, 7), 16)
            };
        }

        const match = value.match(
            /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/
        );

        if (!match) {
            return null;
        }

        return {
            r: Number(match[1]),
            g: Number(match[2]),
            b: Number(match[3])
        };
    }

    function normalizePalette(palette) {
        const source = Array.isArray(palette) && palette.length
            ? palette
            : DEFAULT_PALETTE;

        return source
            .map((entry, index) => {
                if (typeof entry === "string") {
                    return {
                        stop:
                            source.length === 1
                                ? 1
                                : index / (source.length - 1),
                        color: entry
                    };
                }

                return {
                    stop: parseNumber(
                        entry.stop,
                        source.length === 1
                            ? 1
                            : index / (source.length - 1),
                        0,
                        1
                    ),
                    color: String(entry.color || DEFAULT_FOREGROUND)
                };
            })
            .sort((left, right) => left.stop - right.stop);
    }

    function samplePalette(palette, ratio, alpha = 1) {
        const value = Math.max(0, Math.min(1, ratio));
        let left = palette[0];
        let right = palette[palette.length - 1];

        for (let index = 0; index < palette.length - 1; index += 1) {
            if (
                value >= palette[index].stop &&
                value <= palette[index + 1].stop
            ) {
                left = palette[index];
                right = palette[index + 1];
                break;
            }
        }

        const leftRgb = colorToRgb(left.color);
        const rightRgb = colorToRgb(right.color);

        if (!leftRgb || !rightRgb) {
            return right.color;
        }

        const span = Math.max(1e-9, right.stop - left.stop);
        const local = (value - left.stop) / span;
        const r = Math.round(
            leftRgb.r + (rightRgb.r - leftRgb.r) * local
        );
        const g = Math.round(
            leftRgb.g + (rightRgb.g - leftRgb.g) * local
        );
        const b = Math.round(
            leftRgb.b + (rightRgb.b - leftRgb.b) * local
        );

        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    function gaussian(distanceSquared, sigmaSquared) {
        return Math.exp(
            -distanceSquared / (2 * sigmaSquared)
        );
    }

    function quartic(distanceSquared, radiusSquared) {
        if (distanceSquared >= radiusSquared) {
            return 0;
        }

        const normalized = 1 - distanceSquared / radiusSquared;
        return normalized * normalized;
    }

    function epanechnikov(distanceSquared, radiusSquared) {
        if (distanceSquared >= radiusSquared) {
            return 0;
        }

        return 1 - distanceSquared / radiusSquared;
    }

    function marchingSquareSegments(values, threshold) {
        const [topLeft, topRight, bottomRight, bottomLeft] = values;
        let state = 0;

        if (topLeft >= threshold) state |= 8;
        if (topRight >= threshold) state |= 4;
        if (bottomRight >= threshold) state |= 2;
        if (bottomLeft >= threshold) state |= 1;

        const segments = {
            0: [],
            1: [["left", "bottom"]],
            2: [["bottom", "right"]],
            3: [["left", "right"]],
            4: [["top", "right"]],
            5: [["top", "left"], ["bottom", "right"]],
            6: [["top", "bottom"]],
            7: [["top", "left"]],
            8: [["top", "left"]],
            9: [["top", "bottom"]],
            10: [["top", "right"], ["left", "bottom"]],
            11: [["top", "right"]],
            12: [["left", "right"]],
            13: [["bottom", "right"]],
            14: [["left", "bottom"]],
            15: []
        };

        return segments[state] || [];
    }

    class HeatMeshController extends EventTarget {
        constructor(target, data = [], options = {}) {
            super();

            this.canvas = resolveCanvas(target);
            this.context = this.canvas.getContext("2d", {
                alpha: true,
                desynchronized: true
            });

            if (!this.context) {
                throw new Error(
                    "Unable to acquire HeatMesh 2D canvas context."
                );
            }

            this.options = {
                xKey: options.xKey || null,
                yKey: options.yKey || null,
                weightKey: options.weightKey || null,
                weight: options.weight,
                geographic: options.geographic !== false,
                columns: parseNumber(
                    options.columns,
                    DEFAULT_COLUMNS,
                    8,
                    512
                ),
                rows: parseNumber(
                    options.rows,
                    DEFAULT_ROWS,
                    8,
                    512
                ),
                adaptiveResolution:
                    options.adaptiveResolution !== false,
                radius: parseNumber(
                    options.radius,
                    DEFAULT_RADIUS,
                    2,
                    500
                ),
                kernel: ["gaussian", "quartic", "epanechnikov"].includes(
                    options.kernel
                )
                    ? options.kernel
                    : "gaussian",
                padding: parseNumber(
                    options.padding,
                    DEFAULT_PADDING,
                    0,
                    500
                ),
                background:
                    options.background ||
                    DEFAULT_BACKGROUND,
                foreground:
                    options.foreground ||
                    DEFAULT_FOREGROUND,
                gridColor:
                    options.gridColor ||
                    DEFAULT_GRID,
                highlight:
                    options.highlight ||
                    DEFAULT_HIGHLIGHT,
                palette: normalizePalette(options.palette),
                opacity: parseNumber(
                    options.opacity,
                    0.92,
                    0,
                    1
                ),
                showMesh:
                    options.showMesh !== false,
                showPoints:
                    options.showPoints === true,
                showContours:
                    options.showContours === true,
                contourLevels: parseNumber(
                    options.contourLevels,
                    7,
                    2,
                    32
                ),
                showLegend:
                    options.showLegend !== false,
                interpolation:
                    options.interpolation === "nearest"
                        ? "nearest"
                        : "bilinear",
                normalization:
                    options.normalization === "log"
                        ? "log"
                        : options.normalization === "sqrt"
                            ? "sqrt"
                            : "linear",
                interactive:
                    options.interactive !== false,
                zoomable:
                    options.zoomable !== false,
                pannable:
                    options.pannable !== false,
                minZoom: parseNumber(
                    options.minZoom,
                    0.5,
                    0.05,
                    100
                ),
                maxZoom: parseNumber(
                    options.maxZoom,
                    12,
                    0.1,
                    100
                ),
                label:
                    options.label ||
                    "HeatMesh visualization"
            };

            if (
                this.options.columns *
                this.options.rows >
                MAX_CELLS
            ) {
                const scale = Math.sqrt(
                    MAX_CELLS /
                    (
                        this.options.columns *
                        this.options.rows
                    )
                );

                this.options.columns = Math.max(
                    8,
                    Math.floor(this.options.columns * scale)
                );
                this.options.rows = Math.max(
                    8,
                    Math.floor(this.options.rows * scale)
                );
            }

            this.records = [];
            this.points = [];
            this.mesh = new Float64Array(0);
            this.normalizedMesh = new Float64Array(0);
            this.contours = [];
            this.bounds = {
                minX: 0,
                maxX: 1,
                minY: 0,
                maxY: 1
            };
            this.valueRange = {
                minimum: 0,
                maximum: 1,
                total: 0
            };
            this.layout = {
                width: 1,
                height: 1,
                plotX: 0,
                plotY: 0,
                plotWidth: 1,
                plotHeight: 1,
                cellWidth: 1,
                cellHeight: 1
            };
            this.transform = {
                zoom: 1,
                x: 0,
                y: 0
            };
            this.hovered = null;
            this.selected = null;
            this.drag = null;
            this.destroyed = false;
            this.lastError = null;
            this.metrics = {
                inputRecords: 0,
                mappedRecords: 0,
                rejectedRecords: 0,
                cells: 0,
                rebuilds: 0,
                draws: 0,
                resizes: 0,
                zooms: 0,
                pans: 0,
                selections: 0,
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

            this.layout.width =
                rectangle.width || DEFAULT_WIDTH;
            this.layout.height =
                rectangle.height || DEFAULT_HEIGHT;
            this.layout.plotX =
                this.options.padding;
            this.layout.plotY =
                this.options.padding;
            this.layout.plotWidth = Math.max(
                1,
                this.layout.width -
                this.options.padding * 2
            );
            this.layout.plotHeight = Math.max(
                1,
                this.layout.height -
                this.options.padding * 2
            );

            if (this.options.adaptiveResolution) {
                const targetCellSize = 10;
                let columns = Math.max(
                    8,
                    Math.round(
                        this.layout.plotWidth /
                        targetCellSize
                    )
                );
                let rows = Math.max(
                    8,
                    Math.round(
                        this.layout.plotHeight /
                        targetCellSize
                    )
                );

                if (columns * rows > MAX_CELLS) {
                    const scale = Math.sqrt(
                        MAX_CELLS /
                        (columns * rows)
                    );
                    columns = Math.floor(
                        columns * scale
                    );
                    rows = Math.floor(
                        rows * scale
                    );
                }

                this.options.columns = Math.max(
                    8,
                    Math.min(512, columns)
                );
                this.options.rows = Math.max(
                    8,
                    Math.min(512, rows)
                );
            }

            this.layout.cellWidth =
                this.layout.plotWidth /
                this.options.columns;
            this.layout.cellHeight =
                this.layout.plotHeight /
                this.options.rows;

            this.metrics.resizes += 1;
            this.rebuild();
            this.draw();

            this._emit("resize", {
                width: this.layout.width,
                height: this.layout.height,
                columns: this.options.columns,
                rows: this.options.rows
            });
        }

        setData(data) {
            this.records = normalizeRecords(data);
            this.metrics.inputRecords = this.records.length;
            this.rebuild();
            this.draw();

            this._emit("data", {
                records: this.records.length,
                points: this.points.length,
                cells: this.mesh.length
            });

            return this;
        }

        append(data) {
            const records = normalizeRecords(data);

            this.records.push(...records);

            if (this.records.length > MAX_RECORDS) {
                this.records.splice(
                    0,
                    this.records.length - MAX_RECORDS
                );
            }

            this.metrics.inputRecords = this.records.length;
            this.rebuild();
            this.draw();

            this._emit("append", {
                added: records.length,
                records: this.records.length
            });

            return records.length;
        }

        rebuild() {
            try {
                this._extractPoints();
                this._buildMesh();
                this._normalizeMesh();

                if (this.options.showContours) {
                    this._buildContours();
                } else {
                    this.contours = [];
                }

                this.metrics.rebuilds += 1;
                this.metrics.cells = this.mesh.length;
            } catch (error) {
                this._recordError(error);
            }
        }

        _extractPoints() {
            this.points = [];

            let minX = Infinity;
            let maxX = -Infinity;
            let minY = Infinity;
            let maxY = -Infinity;
            let rejected = 0;

            this.records.forEach((record, index) => {
                const coordinates =
                    extractCoordinates(record, this.options);

                if (!coordinates) {
                    rejected += 1;
                    return;
                }

                let x = coordinates.x;
                let y = coordinates.y;
                const geographic =
                    coordinates.source === "geographic" ||
                    coordinates.source === "geometry";

                if (
                    this.options.geographic &&
                    geographic
                ) {
                    const projected =
                        projectGeographic(x, y);
                    x = projected.x;
                    y = projected.y;
                }

                const point = {
                    x,
                    y,
                    rawX: coordinates.x,
                    rawY: coordinates.y,
                    weight:
                        extractWeight(record, this.options),
                    label:
                        labelForRecord(record, index),
                    record,
                    index,
                    geographic
                };

                this.points.push(point);
                minX = Math.min(minX, x);
                maxX = Math.max(maxX, x);
                minY = Math.min(minY, y);
                maxY = Math.max(maxY, y);
            });

            if (!this.points.length) {
                this.bounds = {
                    minX: 0,
                    maxX: 1,
                    minY: 0,
                    maxY: 1
                };
            } else {
                if (minX === maxX) {
                    minX -= 0.5;
                    maxX += 0.5;
                }

                if (minY === maxY) {
                    minY -= 0.5;
                    maxY += 0.5;
                }

                this.bounds = {
                    minX,
                    maxX,
                    minY,
                    maxY
                };
            }

            this.metrics.mappedRecords =
                this.points.length;
            this.metrics.rejectedRecords =
                rejected;
        }

        _pointToGrid(point) {
            const normalizedX =
                (point.x - this.bounds.minX) /
                (this.bounds.maxX - this.bounds.minX);
            const normalizedY =
                (point.y - this.bounds.minY) /
                (this.bounds.maxY - this.bounds.minY);

            return {
                column:
                    normalizedX *
                    (this.options.columns - 1),
                row:
                    (1 - normalizedY) *
                    (this.options.rows - 1)
            };
        }

        _kernel(distanceSquared, radiusSquared) {
            switch (this.options.kernel) {
                case "quartic":
                    return quartic(
                        distanceSquared,
                        radiusSquared
                    );

                case "epanechnikov":
                    return epanechnikov(
                        distanceSquared,
                        radiusSquared
                    );

                case "gaussian":
                default:
                    return gaussian(
                        distanceSquared,
                        radiusSquared / 4
                    );
            }
        }

        _buildMesh() {
            const columns = this.options.columns;
            const rows = this.options.rows;
            const mesh = new Float64Array(
                columns * rows
            );
            const radiusX = Math.max(
                1,
                this.options.radius /
                Math.max(1, this.layout.cellWidth)
            );
            const radiusY = Math.max(
                1,
                this.options.radius /
                Math.max(1, this.layout.cellHeight)
            );
            const radiusSquared = 1;

            for (const point of this.points) {
                const grid = this._pointToGrid(point);
                const minColumn = Math.max(
                    0,
                    Math.floor(
                        grid.column - radiusX
                    )
                );
                const maxColumn = Math.min(
                    columns - 1,
                    Math.ceil(
                        grid.column + radiusX
                    )
                );
                const minRow = Math.max(
                    0,
                    Math.floor(
                        grid.row - radiusY
                    )
                );
                const maxRow = Math.min(
                    rows - 1,
                    Math.ceil(
                        grid.row + radiusY
                    )
                );

                for (
                    let row = minRow;
                    row <= maxRow;
                    row += 1
                ) {
                    for (
                        let column = minColumn;
                        column <= maxColumn;
                        column += 1
                    ) {
                        const dx =
                            (column - grid.column) /
                            radiusX;
                        const dy =
                            (row - grid.row) /
                            radiusY;
                        const distanceSquared =
                            dx * dx + dy * dy;
                        const influence =
                            this._kernel(
                                distanceSquared,
                                radiusSquared
                            );

                        if (influence <= 0) {
                            continue;
                        }

                        mesh[
                            row * columns + column
                        ] +=
                            point.weight *
                            influence;
                    }
                }
            }

            this.mesh = mesh;
        }

        _normalizeMesh() {
            const normalized =
                new Float64Array(
                    this.mesh.length
                );
            let minimum = Infinity;
            let maximum = -Infinity;
            let total = 0;

            for (const value of this.mesh) {
                minimum = Math.min(
                    minimum,
                    value
                );
                maximum = Math.max(
                    maximum,
                    value
                );
                total += value;
            }

            if (!this.mesh.length) {
                minimum = 0;
                maximum = 1;
            }

            if (minimum === maximum) {
                maximum = minimum + 1;
            }

            for (
                let index = 0;
                index < this.mesh.length;
                index += 1
            ) {
                let ratio =
                    (this.mesh[index] - minimum) /
                    (maximum - minimum);

                if (
                    this.options.normalization ===
                    "log"
                ) {
                    ratio =
                        Math.log1p(ratio * 9) /
                        Math.log(10);
                } else if (
                    this.options.normalization ===
                    "sqrt"
                ) {
                    ratio = Math.sqrt(ratio);
                }

                normalized[index] =
                    Math.max(
                        0,
                        Math.min(1, ratio)
                    );
            }

            this.normalizedMesh = normalized;
            this.valueRange = {
                minimum,
                maximum,
                total
            };
        }

        _buildContours() {
            const columns = this.options.columns;
            const rows = this.options.rows;
            const levels = [];

            for (
                let index = 1;
                index <= this.options.contourLevels;
                index += 1
            ) {
                levels.push(
                    index /
                    (this.options.contourLevels + 1)
                );
            }

            const contours = [];

            for (const level of levels) {
                const segments = [];

                for (
                    let row = 0;
                    row < rows - 1;
                    row += 1
                ) {
                    for (
                        let column = 0;
                        column < columns - 1;
                        column += 1
                    ) {
                        const topLeft =
                            this.normalizedMesh[
                                row * columns + column
                            ];
                        const topRight =
                            this.normalizedMesh[
                                row * columns +
                                column + 1
                            ];
                        const bottomRight =
                            this.normalizedMesh[
                                (row + 1) * columns +
                                column + 1
                            ];
                        const bottomLeft =
                            this.normalizedMesh[
                                (row + 1) * columns +
                                column
                            ];
                        const cellSegments =
                            marchingSquareSegments(
                                [
                                    topLeft,
                                    topRight,
                                    bottomRight,
                                    bottomLeft
                                ],
                                level
                            );

                        for (const [
                            start,
                            end
                        ] of cellSegments) {
                            segments.push({
                                start:
                                    this._edgePoint(
                                        column,
                                        row,
                                        start
                                    ),
                                end:
                                    this._edgePoint(
                                        column,
                                        row,
                                        end
                                    )
                            });
                        }
                    }
                }

                contours.push({
                    level,
                    segments
                });
            }

            this.contours = contours;
        }

        _edgePoint(column, row, edge) {
            const x =
                this.layout.plotX +
                column * this.layout.cellWidth;
            const y =
                this.layout.plotY +
                row * this.layout.cellHeight;

            switch (edge) {
                case "top":
                    return {
                        x:
                            x +
                            this.layout.cellWidth / 2,
                        y
                    };

                case "right":
                    return {
                        x:
                            x +
                            this.layout.cellWidth,
                        y:
                            y +
                            this.layout.cellHeight / 2
                    };

                case "bottom":
                    return {
                        x:
                            x +
                            this.layout.cellWidth / 2,
                        y:
                            y +
                            this.layout.cellHeight
                    };

                case "left":
                default:
                    return {
                        x,
                        y:
                            y +
                            this.layout.cellHeight / 2
                    };
            }
        }

        _screenPoint(x, y) {
            const centerX =
                this.layout.width / 2;
            const centerY =
                this.layout.height / 2;

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
                this.layout.width / 2;
            const centerY =
                this.layout.height / 2;

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

        _drawBackground() {
            this.context.clearRect(
                0,
                0,
                this.layout.width,
                this.layout.height
            );
            this.context.fillStyle =
                this.options.background;
            this.context.fillRect(
                0,
                0,
                this.layout.width,
                this.layout.height
            );
        }

        draw() {
            if (this.destroyed) {
                return;
            }

            this._drawBackground();

            if (!this.points.length) {
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
                    DEFAULT_EMPTY_TEXT,
                    this.layout.width / 2,
                    this.layout.height / 2
                );
                this.context.globalAlpha = 1;
                this.metrics.draws += 1;
                return;
            }

            this._drawHeatField();

            if (this.options.showContours) {
                this._drawContours();
            }

            if (this.options.showMesh) {
                this._drawMesh();
            }

            if (this.options.showPoints) {
                this._drawPoints();
            }

            if (this.options.showLegend) {
                this._drawLegend();
            }

            if (this.hovered || this.selected) {
                this._drawInspection();
            }

            this.metrics.draws += 1;
        }

        _drawHeatField() {
            const columns = this.options.columns;
            const rows = this.options.rows;
            const zoom = this.transform.zoom;
            const width =
                this.layout.cellWidth * zoom;
            const height =
                this.layout.cellHeight * zoom;

            for (
                let row = 0;
                row < rows;
                row += 1
            ) {
                for (
                    let column = 0;
                    column < columns;
                    column += 1
                ) {
                    const ratio =
                        this.normalizedMesh[
                            row * columns + column
                        ];

                    if (ratio <= 0) {
                        continue;
                    }

                    const baseX =
                        this.layout.plotX +
                        column *
                        this.layout.cellWidth;
                    const baseY =
                        this.layout.plotY +
                        row *
                        this.layout.cellHeight;
                    const screen =
                        this._screenPoint(
                            baseX,
                            baseY
                        );
                    const alpha =
                        this.options.opacity *
                        Math.max(
                            0.04,
                            ratio
                        );

                    this.context.fillStyle =
                        samplePalette(
                            this.options.palette,
                            ratio,
                            alpha
                        );
                    this.context.fillRect(
                        screen.x,
                        screen.y,
                        width + 1,
                        height + 1
                    );
                }
            }
        }

        _drawMesh() {
            const columns = this.options.columns;
            const rows = this.options.rows;
            const start =
                this._screenPoint(
                    this.layout.plotX,
                    this.layout.plotY
                );
            const end =
                this._screenPoint(
                    this.layout.plotX +
                    this.layout.plotWidth,
                    this.layout.plotY +
                    this.layout.plotHeight
                );

            this.context.save();
            this.context.strokeStyle =
                this.options.gridColor;
            this.context.globalAlpha = 0.18;
            this.context.lineWidth = 1;

            for (
                let column = 0;
                column <= columns;
                column += 1
            ) {
                const x =
                    start.x +
                    column *
                    this.layout.cellWidth *
                    this.transform.zoom;
                this.context.beginPath();
                this.context.moveTo(
                    x,
                    start.y
                );
                this.context.lineTo(
                    x,
                    end.y
                );
                this.context.stroke();
            }

            for (
                let row = 0;
                row <= rows;
                row += 1
            ) {
                const y =
                    start.y +
                    row *
                    this.layout.cellHeight *
                    this.transform.zoom;
                this.context.beginPath();
                this.context.moveTo(
                    start.x,
                    y
                );
                this.context.lineTo(
                    end.x,
                    y
                );
                this.context.stroke();
            }

            this.context.restore();
        }

        _drawContours() {
            this.context.save();
            this.context.lineWidth = 1;

            for (const contour of this.contours) {
                this.context.strokeStyle =
                    samplePalette(
                        this.options.palette,
                        contour.level,
                        0.72
                    );

                for (const segment of contour.segments) {
                    const start =
                        this._screenPoint(
                            segment.start.x,
                            segment.start.y
                        );
                    const end =
                        this._screenPoint(
                            segment.end.x,
                            segment.end.y
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
            }

            this.context.restore();
        }

        _drawPoints() {
            this.context.save();

            for (const point of this.points) {
                const grid =
                    this._pointToGrid(point);
                const baseX =
                    this.layout.plotX +
                    grid.column *
                    this.layout.cellWidth;
                const baseY =
                    this.layout.plotY +
                    grid.row *
                    this.layout.cellHeight;
                const screen =
                    this._screenPoint(
                        baseX,
                        baseY
                    );

                this.context.fillStyle =
                    this.options.highlight;
                this.context.globalAlpha = 0.54;
                this.context.beginPath();
                this.context.arc(
                    screen.x,
                    screen.y,
                    Math.max(
                        1.5,
                        2.5 *
                        Math.sqrt(
                            this.transform.zoom
                        )
                    ),
                    0,
                    Math.PI * 2
                );
                this.context.fill();
            }

            this.context.restore();
        }

        _drawLegend() {
            const width = 180;
            const height = 12;
            const x =
                this.layout.width -
                this.options.padding -
                width;
            const y =
                this.layout.height -
                this.options.padding -
                30;
            const gradient =
                this.context.createLinearGradient(
                    x,
                    0,
                    x + width,
                    0
                );

            for (const entry of this.options.palette) {
                gradient.addColorStop(
                    entry.stop,
                    entry.color
                );
            }

            this.context.save();
            this.context.globalAlpha = 0.92;
            this.context.fillStyle = gradient;
            this.context.fillRect(
                x,
                y,
                width,
                height
            );
            this.context.strokeStyle =
                this.options.gridColor;
            this.context.strokeRect(
                x,
                y,
                width,
                height
            );

            this.context.fillStyle =
                this.options.foreground;
            this.context.font =
                '10px "IBM Plex Mono", monospace';
            this.context.textBaseline = "top";
            this.context.textAlign = "left";
            this.context.fillText(
                String(
                    Number(
                        this.valueRange.minimum.toFixed(3)
                    )
                ),
                x,
                y + 16
            );
            this.context.textAlign = "right";
            this.context.fillText(
                String(
                    Number(
                        this.valueRange.maximum.toFixed(3)
                    )
                ),
                x + width,
                y + 16
            );
            this.context.restore();
        }

        _drawInspection() {
            const cell =
                this.selected || this.hovered;

            if (!cell) {
                return;
            }

            const baseX =
                this.layout.plotX +
                cell.column *
                this.layout.cellWidth;
            const baseY =
                this.layout.plotY +
                cell.row *
                this.layout.cellHeight;
            const screen =
                this._screenPoint(
                    baseX,
                    baseY
                );
            const width =
                this.layout.cellWidth *
                this.transform.zoom;
            const height =
                this.layout.cellHeight *
                this.transform.zoom;

            this.context.save();
            this.context.strokeStyle =
                this.options.highlight;
            this.context.lineWidth = 2;
            this.context.globalAlpha = 1;
            this.context.strokeRect(
                screen.x,
                screen.y,
                width,
                height
            );
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
            const base =
                this._inverseScreenPoint(x, y);
            const column = Math.floor(
                (
                    base.x -
                    this.layout.plotX
                ) /
                this.layout.cellWidth
            );
            const row = Math.floor(
                (
                    base.y -
                    this.layout.plotY
                ) /
                this.layout.cellHeight
            );

            if (
                column < 0 ||
                row < 0 ||
                column >= this.options.columns ||
                row >= this.options.rows
            ) {
                return null;
            }

            const index =
                row *
                this.options.columns +
                column;

            return {
                column,
                row,
                index,
                value:
                    this.mesh[index] || 0,
                normalized:
                    this.normalizedMesh[index] || 0,
                nearby:
                    this._nearbyPoints(
                        column,
                        row
                    )
            };
        }

        _nearbyPoints(column, row) {
            const result = [];
            const radius = 1.5;

            for (const point of this.points) {
                const grid =
                    this._pointToGrid(point);
                const dx =
                    grid.column - column;
                const dy =
                    grid.row - row;

                if (
                    dx * dx + dy * dy <=
                    radius * radius
                ) {
                    result.push({
                        label: point.label,
                        weight: point.weight,
                        rawX: point.rawX,
                        rawY: point.rawY,
                        record: clone(point.record)
                    });
                }

                if (result.length >= 20) {
                    break;
                }
            }

            return result;
        }

        _handlePointerMove(event) {
            const point =
                this._pointFromEvent(event);

            if (this.drag) {
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
                hovered?.index !==
                this.hovered?.index;

            this.hovered = hovered;
            this.canvas.style.cursor =
                hovered
                    ? "crosshair"
                    : this.options.pannable
                        ? "grab"
                        : "default";

            if (changed) {
                this.draw();

                this._emit("hover", {
                    cell:
                        hovered
                            ? clone(hovered)
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
                    cell: null
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

            const point =
                this._pointFromEvent(event);

            this.drag = {
                startX: point.x,
                startY: point.y,
                originX: this.transform.x,
                originY: this.transform.y
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
                this.options.pannable
                    ? "grab"
                    : "default";

            this._emit("pan", {
                transform:
                    clone(this.transform)
            });
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
                this.options.minZoom,
                Math.min(
                    this.options.maxZoom,
                    this.transform.zoom *
                    factor
                )
            );
            const centerX =
                this.layout.width / 2;
            const centerY =
                this.layout.height / 2;

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
            const cell =
                this.hitTest(
                    point.x,
                    point.y
                );

            this.selected =
                cell?.index ===
                this.selected?.index
                    ? null
                    : cell;
            this.metrics.selections += 1;
            this.draw();

            this._emit("select", {
                cell:
                    this.selected
                        ? clone(this.selected)
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
                this.options.minZoom,
                Math.min(
                    this.options.maxZoom,
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
            this.transform.x +=
                Number(x) || 0;
            this.transform.y +=
                Number(y) || 0;
            this.metrics.pans += 1;
            this.draw();

            this._emit("pan", {
                transform:
                    clone(this.transform)
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
            this.draw();

            this._emit("resetView", {
                transform:
                    clone(this.transform)
            });

            return clone(
                this.transform
            );
        }

        update(options = {}) {
            if (!isObject(options)) {
                throw new TypeError(
                    "HeatMesh options must be an object."
                );
            }

            const rebuildRequired = [
                "xKey",
                "yKey",
                "weightKey",
                "weight",
                "geographic",
                "columns",
                "rows",
                "radius",
                "kernel",
                "normalization",
                "showContours",
                "contourLevels",
                "adaptiveResolution"
            ].some((key) =>
                options[key] !== undefined
            );

            Object.assign(this.options, {
                xKey:
                    options.xKey !== undefined
                        ? options.xKey
                        : this.options.xKey,
                yKey:
                    options.yKey !== undefined
                        ? options.yKey
                        : this.options.yKey,
                weightKey:
                    options.weightKey !== undefined
                        ? options.weightKey
                        : this.options.weightKey,
                weight:
                    options.weight !== undefined
                        ? options.weight
                        : this.options.weight,
                geographic:
                    options.geographic !== undefined
                        ? Boolean(options.geographic)
                        : this.options.geographic,
                columns:
                    options.columns !== undefined
                        ? parseNumber(
                            options.columns,
                            this.options.columns,
                            8,
                            512
                        )
                        : this.options.columns,
                rows:
                    options.rows !== undefined
                        ? parseNumber(
                            options.rows,
                            this.options.rows,
                            8,
                            512
                        )
                        : this.options.rows,
                adaptiveResolution:
                    options.adaptiveResolution !== undefined
                        ? Boolean(options.adaptiveResolution)
                        : this.options.adaptiveResolution,
                radius:
                    options.radius !== undefined
                        ? parseNumber(
                            options.radius,
                            this.options.radius,
                            2,
                            500
                        )
                        : this.options.radius,
                kernel:
                    options.kernel ||
                    this.options.kernel,
                padding:
                    options.padding !== undefined
                        ? parseNumber(
                            options.padding,
                            this.options.padding,
                            0,
                            500
                        )
                        : this.options.padding,
                background:
                    options.background ||
                    this.options.background,
                foreground:
                    options.foreground ||
                    this.options.foreground,
                gridColor:
                    options.gridColor ||
                    this.options.gridColor,
                highlight:
                    options.highlight ||
                    this.options.highlight,
                palette:
                    options.palette
                        ? normalizePalette(
                            options.palette
                        )
                        : this.options.palette,
                opacity:
                    options.opacity !== undefined
                        ? parseNumber(
                            options.opacity,
                            this.options.opacity,
                            0,
                            1
                        )
                        : this.options.opacity,
                showMesh:
                    options.showMesh !== undefined
                        ? Boolean(options.showMesh)
                        : this.options.showMesh,
                showPoints:
                    options.showPoints !== undefined
                        ? Boolean(options.showPoints)
                        : this.options.showPoints,
                showContours:
                    options.showContours !== undefined
                        ? Boolean(options.showContours)
                        : this.options.showContours,
                contourLevels:
                    options.contourLevels !== undefined
                        ? parseNumber(
                            options.contourLevels,
                            this.options.contourLevels,
                            2,
                            32
                        )
                        : this.options.contourLevels,
                showLegend:
                    options.showLegend !== undefined
                        ? Boolean(options.showLegend)
                        : this.options.showLegend,
                interpolation:
                    options.interpolation ||
                    this.options.interpolation,
                normalization:
                    options.normalization ||
                    this.options.normalization
            });

            this.layout.cellWidth =
                this.layout.plotWidth /
                this.options.columns;
            this.layout.cellHeight =
                this.layout.plotHeight /
                this.options.rows;

            if (rebuildRequired) {
                this.rebuild();
            }

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
                        generatedAt: iso(),
                        options:
                            this.options,
                        bounds:
                            this.bounds,
                        valueRange:
                            this.valueRange,
                        transform:
                            this.transform,
                        columns:
                            this.options.columns,
                        rows:
                            this.options.rows,
                        mesh:
                            Array.from(
                                this.mesh
                            ),
                        normalizedMesh:
                            Array.from(
                                this.normalizedMesh
                            )
                    },
                    null,
                    2
                );
            }

            if (normalized === "csv") {
                const rows = [[
                    "column",
                    "row",
                    "value",
                    "normalized"
                ]];

                for (
                    let row = 0;
                    row < this.options.rows;
                    row += 1
                ) {
                    for (
                        let column = 0;
                        column < this.options.columns;
                        column += 1
                    ) {
                        const index =
                            row *
                            this.options.columns +
                            column;

                        rows.push([
                            column,
                            row,
                            this.mesh[index],
                            this.normalizedMesh[index]
                        ]);
                    }
                }

                return rows
                    .map((row) =>
                        row.join(",")
                    )
                    .join("\r\n");
            }

            throw new Error(
                `Unsupported HeatMesh export format: ${format}`
            );
        }

        status() {
            return {
                name: "heatmesh",
                module: MODULE_NAME,
                records:
                    this.records.length,
                points:
                    this.points.length,
                cells:
                    this.mesh.length,
                columns:
                    this.options.columns,
                rows:
                    this.options.rows,
                bounds:
                    clone(this.bounds),
                valueRange:
                    clone(this.valueRange),
                transform:
                    clone(this.transform),
                selected:
                    this.selected
                        ? clone(this.selected)
                        : null,
                hovered:
                    this.hovered
                        ? clone(this.hovered)
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

            this.records = [];
            this.points = [];
            this.mesh = new Float64Array(0);
            this.normalizedMesh =
                new Float64Array(0);
            this.contours = [];
            this.destroyed = true;

            this._emit("destroy", {});
            return true;
        }
    }

    function mount(target, data = [], options = {}) {
        return new HeatMeshController(
            target,
            data,
            options
        );
    }

    function render(data = [], options = {}) {
        const container =
            createElement(
                "section",
                "terminal-visualization terminal-visualization-heatmesh"
            );

        container.dataset.visualization =
            "heatmesh";
        container.setAttribute(
            "role",
            "region"
        );
        container.setAttribute(
            "aria-label",
            options.label ||
            "HeatMesh visualization"
        );

        const canvas =
            document.createElement("canvas");
        canvas.className =
            "terminal-heatmesh-canvas";
        canvas.width =
            Number(options.width) ||
            DEFAULT_WIDTH;
        canvas.height =
            Number(options.height) ||
            DEFAULT_HEIGHT;
        canvas.setAttribute(
            "aria-label",
            options.label ||
            "HeatMesh visualization"
        );

        const status =
            createElement(
                "div",
                "terminal-heatmesh-status"
            );
        status.setAttribute(
            "aria-live",
            "polite"
        );

        const tooltip =
            createElement(
                "div",
                "terminal-heatmesh-tooltip"
            );
        tooltip.hidden = true;

        container.append(
            canvas,
            status,
            tooltip
        );

        const controller =
            new HeatMeshController(
                canvas,
                data,
                options
            );

        const updateStatus = () => {
            const snapshot =
                controller.status();

            status.textContent =
                `${snapshot.points} mapped record` +
                `${snapshot.points === 1 ? "" : "s"} · ` +
                `${snapshot.columns}×${snapshot.rows} mesh · ` +
                `${snapshot.transform.zoom.toFixed(2)}×`;
        };

        controller.addEventListener(
            "hover",
            (event) => {
                const cell =
                    event.detail?.cell;

                if (!cell) {
                    tooltip.hidden = true;
                    return;
                }

                tooltip.hidden = false;
                tooltip.textContent =
                    `Cell ${cell.column},${cell.row} · ` +
                    `value ${Number(cell.value.toFixed(4))} · ` +
                    `${cell.nearby.length} nearby record` +
                    `${cell.nearby.length === 1 ? "" : "s"}`;
            }
        );

        for (const eventName of [
            "data",
            "append",
            "resize",
            "zoom",
            "pan",
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
            controller.records;
        container.destroy = () =>
            controller.destroy();

        return container;
    }

    function initialize(context = {}) {
        const dataset =
            context.root?.dataset || {};
        const config =
            context.config?.heatmesh || {};

        const defaults = {
            xKey:
                dataset.terminalHeatmeshXKey ||
                config.xKey ||
                null,

            yKey:
                dataset.terminalHeatmeshYKey ||
                config.yKey ||
                null,

            weightKey:
                dataset.terminalHeatmeshWeightKey ||
                config.weightKey ||
                null,

            geographic: parseBoolean(
                dataset.terminalHeatmeshGeographic,
                config.geographic !== false
            ),

            columns:
                dataset.terminalHeatmeshColumns ||
                config.columns ||
                DEFAULT_COLUMNS,

            rows:
                dataset.terminalHeatmeshRows ||
                config.rows ||
                DEFAULT_ROWS,

            radius:
                dataset.terminalHeatmeshRadius ||
                config.radius ||
                DEFAULT_RADIUS,

            kernel:
                dataset.terminalHeatmeshKernel ||
                config.kernel ||
                "gaussian",

            background:
                dataset.terminalHeatmeshBackground ||
                config.background ||
                DEFAULT_BACKGROUND,

            foreground:
                dataset.terminalHeatmeshForeground ||
                config.foreground ||
                DEFAULT_FOREGROUND,

            gridColor:
                dataset.terminalHeatmeshGrid ||
                config.gridColor ||
                DEFAULT_GRID,

            highlight:
                dataset.terminalHeatmeshHighlight ||
                config.highlight ||
                DEFAULT_HIGHLIGHT,

            palette:
                config.palette ||
                DEFAULT_PALETTE,

            showMesh: parseBoolean(
                dataset.terminalHeatmeshShowMesh,
                config.showMesh !== false
            ),

            showPoints: parseBoolean(
                dataset.terminalHeatmeshShowPoints,
                config.showPoints === true
            ),

            showContours: parseBoolean(
                dataset.terminalHeatmeshShowContours,
                config.showContours === true
            ),

            showLegend: parseBoolean(
                dataset.terminalHeatmeshShowLegend,
                config.showLegend !== false
            ),

            interactive: parseBoolean(
                dataset.terminalHeatmeshInteractive,
                config.interactive !== false
            )
        };

        const visualization = {
            mount(target, data = [], options = {}) {
                return new HeatMeshController(
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
                HeatMeshController,

            normalizeRecords,

            extractCoordinates,

            projectGeographic,

            normalizePalette
        };

        context.registerVisualization?.(
            "heatmesh",
            visualization
        );

        context.registerRenderer?.(
            "heatmesh",
            visualization
        );

        context.heatmesh =
            visualization;

        safeDispatch(
            document,
            "speciedex:terminal-heatmesh-ready",
            {
                visualization
            }
        );

        return visualization;
    }

    const commands = [{
        name: "heatmesh",
        category: "visualization",
        description:
            "Render and control a weighted spatial heat-field mesh.",
        usage:
            "heatmesh [collection|status|zoom|pan|reset|export] [arguments]",
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
                context.heatmeshController ||
                context.terminalHeatmeshController;

            try {
                if (controller) {
                    switch (lower) {
                        case "status":
                        case "show":
                        case "info":
                            return writeJSON(
                                controller.status()
                            );

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
                        ...context.config?.heatmesh,
                        label:
                            `HeatMesh for ${collection}`
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
        HeatMeshController,
        normalizeRecords,
        extractCoordinates,
        projectGeographic,
        normalizePalette,
        samplePalette,
        mount,
        render,
        initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalHeatMesh =
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
