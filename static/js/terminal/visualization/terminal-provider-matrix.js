/*
========================================================================
Speciedex.org
Terminal ProviderMatrix Visualization
========================================================================

Interactive provider-comparison matrix for Speciedex records. Supports provider
and metric inference, weighted aggregation, normalization, row/column sorting,
filtering, selection, hover inspection, zoom, pan, legends, responsive high-DPI
rendering, exports, diagnostics, and lifecycle control.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "ProviderMatrix";
    const DEFAULT_WIDTH = 960;
    const DEFAULT_HEIGHT = 540;
    const DEFAULT_BACKGROUND = "#020a05";
    const DEFAULT_FOREGROUND = "#c0d674";
    const DEFAULT_HIGHLIGHT = "#eef7c8";
    const DEFAULT_GRID = "#1f3a27";
    const DEFAULT_EMPTY = "#07100a";
    const DEFAULT_LOW = "#173322";
    const DEFAULT_HIGH = "#c0d674";
    const DEFAULT_LABEL = "#d8e6db";
    const DEFAULT_PADDING = 16;
    const DEFAULT_ROW_HEADER_WIDTH = 180;
    const DEFAULT_COLUMN_HEADER_HEIGHT = 90;
    const DEFAULT_CELL_SIZE = 28;
    const DEFAULT_MAX_RECORDS = 250000;
    const DEFAULT_MAX_PROVIDERS = 512;
    const DEFAULT_MAX_METRICS = 256;

    const PROVIDER_FIELDS = Object.freeze([
        "provider",
        "provider_name",
        "providerName",
        "source",
        "source_name",
        "sourceName",
        "dataset",
        "publisher",
        "organization",
        "institution"
    ]);

    const METRIC_FIELDS = Object.freeze([
        "metric",
        "metric_name",
        "metricName",
        "field",
        "attribute",
        "category",
        "rank",
        "status",
        "type"
    ]);

    const VALUE_FIELDS = Object.freeze([
        "value",
        "count",
        "weight",
        "score",
        "coverage",
        "completeness",
        "quality",
        "records",
        "record_count",
        "recordCount",
        "occurrenceCount",
        "occurrence_count"
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
            "ProviderMatrix requires a canvas or container element."
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
                "providers",
                "matrix",
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
            candidates.map((field, index) => [field, {
                field,
                count: 0,
                priority: index
            }])
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

    function providerForRecord(record, options = {}) {
        if (typeof options.provider === "function") {
            return String(options.provider(record) ?? "unknown");
        }

        if (options.providerKey && isObject(record)) {
            return String(record[options.providerKey] ?? "unknown");
        }

        if (!isObject(record)) {
            return "unknown";
        }

        return String(firstValue(record, PROVIDER_FIELDS, "unknown"));
    }

    function metricForRecord(record, options = {}) {
        if (typeof options.metric === "function") {
            return String(options.metric(record) ?? "value");
        }

        if (options.metricKey && isObject(record)) {
            return String(record[options.metricKey] ?? "value");
        }

        if (!isObject(record)) {
            return "value";
        }

        return String(firstValue(record, METRIC_FIELDS, "value"));
    }

    function valueForRecord(record, options = {}) {
        if (typeof options.value === "function") {
            const value = Number(options.value(record));
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
            return null;
        }

        return firstFinite(record, VALUE_FIELDS, 1);
    }

    function weightForRecord(record, options = {}) {
        if (typeof options.weight === "function") {
            const value = Number(options.weight(record));
            return Number.isFinite(value) ? value : 1;
        }

        if (options.weightKey && isObject(record)) {
            const value = Number(record[options.weightKey]);
            return Number.isFinite(value) ? value : 1;
        }

        return 1;
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

        return null;
    }

    function interpolateColor(start, end, ratio, alpha = 1) {
        const left = colorToRgb(start);
        const right = colorToRgb(end);

        if (!left || !right) {
            return end;
        }

        const amount = Math.max(0, Math.min(1, ratio));
        const r = Math.round(left.r + (right.r - left.r) * amount);
        const g = Math.round(left.g + (right.g - left.g) * amount);
        const b = Math.round(left.b + (right.b - left.b) * amount);

        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    function escapeCsv(value) {
        const text = String(value ?? "");

        return /[",\n\r]/.test(text)
            ? `"${text.replace(/"/g, '""')}"`
            : text;
    }

    class ProviderMatrixController extends EventTarget {
        constructor(target, data = [], options = {}) {
            super();

            this.canvas = resolveCanvas(target);
            this.context = this.canvas.getContext("2d", {
                alpha: true,
                desynchronized: true
            });

            if (!this.context) {
                throw new Error(
                    "Unable to acquire ProviderMatrix 2D canvas context."
                );
            }

            this.options = {
                providerKey:
                    options.providerKey || null,
                provider:
                    options.provider,
                metricKey:
                    options.metricKey || null,
                metric:
                    options.metric,
                valueKey:
                    options.valueKey || null,
                value:
                    options.value,
                weightKey:
                    options.weightKey || null,
                weight:
                    options.weight,
                aggregation:
                    ["sum", "average", "min", "max", "count"].includes(
                        options.aggregation
                    )
                        ? options.aggregation
                        : "sum",
                normalization:
                    ["global", "row", "column", "none", "log"].includes(
                        options.normalization
                    )
                        ? options.normalization
                        : "global",
                rowSort:
                    ["name", "total", "average", "maximum", "minimum"].includes(
                        options.rowSort
                    )
                        ? options.rowSort
                        : "total",
                columnSort:
                    ["name", "total", "average", "maximum", "minimum"].includes(
                        options.columnSort
                    )
                        ? options.columnSort
                        : "total",
                rowDirection:
                    options.rowDirection === "asc" ? "asc" : "desc",
                columnDirection:
                    options.columnDirection === "asc" ? "asc" : "desc",
                background:
                    options.background || DEFAULT_BACKGROUND,
                foreground:
                    options.foreground || DEFAULT_FOREGROUND,
                highlight:
                    options.highlight || DEFAULT_HIGHLIGHT,
                gridColor:
                    options.gridColor || DEFAULT_GRID,
                emptyColor:
                    options.emptyColor || DEFAULT_EMPTY,
                lowColor:
                    options.lowColor || DEFAULT_LOW,
                highColor:
                    options.highColor || DEFAULT_HIGH,
                labelColor:
                    options.labelColor || DEFAULT_LABEL,
                padding: parseNumber(
                    options.padding,
                    DEFAULT_PADDING,
                    0,
                    200
                ),
                rowHeaderWidth: parseNumber(
                    options.rowHeaderWidth,
                    DEFAULT_ROW_HEADER_WIDTH,
                    60,
                    500
                ),
                columnHeaderHeight: parseNumber(
                    options.columnHeaderHeight,
                    DEFAULT_COLUMN_HEADER_HEIGHT,
                    40,
                    300
                ),
                cellSize: parseNumber(
                    options.cellSize,
                    DEFAULT_CELL_SIZE,
                    8,
                    120
                ),
                showValues:
                    options.showValues === true,
                showLegend:
                    options.showLegend !== false,
                showTotals:
                    options.showTotals !== false,
                interactive:
                    options.interactive !== false,
                zoomable:
                    options.zoomable !== false,
                pannable:
                    options.pannable !== false,
                maxProviders: parseNumber(
                    options.maxProviders,
                    DEFAULT_MAX_PROVIDERS,
                    1,
                    10000
                ),
                maxMetrics: parseNumber(
                    options.maxMetrics,
                    DEFAULT_MAX_METRICS,
                    1,
                    10000
                ),
                label:
                    options.label ||
                    "ProviderMatrix visualization"
            };

            this.records = [];
            this.providers = [];
            this.metrics = [];
            this.cells = [];
            this.cellIndex = new Map();
            this.providerStats = new Map();
            this.metricStats = new Map();
            this.valueRange = {
                minimum: 0,
                maximum: 1
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
            this.hovered = null;
            this.selected = null;
            this.drag = null;
            this.providerFilter = "";
            this.metricFilter = "";
            this.destroyed = false;
            this.lastError = null;
            this.metricsState = {
                inputRecords: 0,
                acceptedRecords: 0,
                rejectedRecords: 0,
                providers: 0,
                metrics: 0,
                cells: 0,
                nonEmptyCells: 0,
                draws: 0,
                rebuilds: 0,
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
            this.metricsState.errors += 1;

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
            this.metricsState.resizes += 1;
            this.draw();

            this._emit("resize", clone(this.bounds));
        }

        setData(data) {
            try {
                this.records = normalizeRecords(data);

                if (!this.options.providerKey && !this.options.provider) {
                    this.options.providerKey =
                        inferField(this.records, PROVIDER_FIELDS);
                }

                if (!this.options.metricKey && !this.options.metric) {
                    this.options.metricKey =
                        inferField(this.records, METRIC_FIELDS);
                }

                if (!this.options.valueKey && !this.options.value) {
                    this.options.valueKey =
                        inferField(this.records, VALUE_FIELDS);
                }

                this.rebuild();
                this.draw();

                this._emit("data", {
                    records: this.records.length,
                    providers: this.providers.length,
                    metrics: this.metrics.length,
                    cells: this.cells.length
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
            this.draw();

            this._emit("append", {
                added: records.length,
                records: this.records.length
            });

            return records.length;
        }

        rebuild() {
            const buckets = new Map();
            const providers = new Set();
            const metrics = new Set();
            let accepted = 0;
            let rejected = 0;

            for (const record of this.records) {
                const provider =
                    providerForRecord(record, this.options);
                const metric =
                    metricForRecord(record, this.options);
                const value =
                    valueForRecord(record, this.options);
                const weight =
                    weightForRecord(record, this.options);

                if (
                    !provider ||
                    !metric ||
                    value === null ||
                    !Number.isFinite(value)
                ) {
                    rejected += 1;
                    continue;
                }

                if (
                    !providers.has(provider) &&
                    providers.size >= this.options.maxProviders
                ) {
                    rejected += 1;
                    continue;
                }

                if (
                    !metrics.has(metric) &&
                    metrics.size >= this.options.maxMetrics
                ) {
                    rejected += 1;
                    continue;
                }

                providers.add(provider);
                metrics.add(metric);

                const key = `${provider}\u0000${metric}`;

                if (!buckets.has(key)) {
                    buckets.set(key, {
                        key,
                        provider,
                        metric,
                        count: 0,
                        weight: 0,
                        sum: 0,
                        minimum: Infinity,
                        maximum: -Infinity,
                        values: [],
                        records: []
                    });
                }

                const bucket = buckets.get(key);

                bucket.count += 1;
                bucket.weight += weight;
                bucket.sum += value * weight;
                bucket.minimum = Math.min(bucket.minimum, value);
                bucket.maximum = Math.max(bucket.maximum, value);

                if (bucket.values.length < 10000) {
                    bucket.values.push(value);
                }

                if (bucket.records.length < 100) {
                    bucket.records.push(record);
                }

                accepted += 1;
            }

            const providerFilter =
                this.providerFilter.toLowerCase();
            const metricFilter =
                this.metricFilter.toLowerCase();

            this.providers = Array.from(providers)
                .filter((provider) =>
                    !providerFilter ||
                    provider.toLowerCase().includes(providerFilter)
                );
            this.metrics = Array.from(metrics)
                .filter((metric) =>
                    !metricFilter ||
                    metric.toLowerCase().includes(metricFilter)
                );

            this.cells = [];
            this.cellIndex.clear();

            for (const provider of this.providers) {
                for (const metric of this.metrics) {
                    const key = `${provider}\u0000${metric}`;
                    const bucket = buckets.get(key);
                    const cell = bucket
                        ? this._finalizeBucket(bucket)
                        : {
                            key,
                            provider,
                            metric,
                            count: 0,
                            weight: 0,
                            sum: 0,
                            minimum: null,
                            maximum: null,
                            average: null,
                            value: null,
                            normalized: 0,
                            records: []
                        };

                    this.cells.push(cell);
                    this.cellIndex.set(key, cell);
                }
            }

            this._computeStats();
            this._sortAxes();
            this._normalizeCells();

            this.metricsState.inputRecords = this.records.length;
            this.metricsState.acceptedRecords = accepted;
            this.metricsState.rejectedRecords = rejected;
            this.metricsState.providers = this.providers.length;
            this.metricsState.metrics = this.metrics.length;
            this.metricsState.cells = this.cells.length;
            this.metricsState.nonEmptyCells =
                this.cells.filter((cell) => cell.count > 0).length;
            this.metricsState.rebuilds += 1;
        }

        _finalizeBucket(bucket) {
            const average =
                bucket.weight
                    ? bucket.sum / bucket.weight
                    : 0;
            let value;

            switch (this.options.aggregation) {
                case "average":
                    value = average;
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

            return {
                key: bucket.key,
                provider: bucket.provider,
                metric: bucket.metric,
                count: bucket.count,
                weight: bucket.weight,
                sum: bucket.sum,
                minimum: bucket.minimum,
                maximum: bucket.maximum,
                average,
                value,
                normalized: 0,
                records: bucket.records.map(clone)
            };
        }

        _computeStats() {
            this.providerStats.clear();
            this.metricStats.clear();

            const aggregate = (cells) => {
                const values = cells
                    .filter((cell) =>
                        cell.value !== null &&
                        Number.isFinite(cell.value)
                    )
                    .map((cell) => cell.value);

                if (!values.length) {
                    return {
                        count: 0,
                        total: 0,
                        average: 0,
                        minimum: 0,
                        maximum: 0
                    };
                }

                const total = values.reduce(
                    (sum, value) => sum + value,
                    0
                );

                return {
                    count: values.length,
                    total,
                    average: total / values.length,
                    minimum: Math.min(...values),
                    maximum: Math.max(...values)
                };
            };

            for (const provider of this.providers) {
                this.providerStats.set(
                    provider,
                    aggregate(
                        this.cells.filter(
                            (cell) =>
                                cell.provider === provider
                        )
                    )
                );
            }

            for (const metric of this.metrics) {
                this.metricStats.set(
                    metric,
                    aggregate(
                        this.cells.filter(
                            (cell) =>
                                cell.metric === metric
                        )
                    )
                );
            }
        }

        _sortAxes() {
            const sortValues = (
                values,
                stats,
                mode,
                direction
            ) => {
                const multiplier =
                    direction === "asc" ? 1 : -1;

                values.sort((left, right) => {
                    if (mode === "name") {
                        return (
                            left.localeCompare(right) *
                            multiplier
                        );
                    }

                    const leftStats = stats.get(left);
                    const rightStats = stats.get(right);
                    const key =
                        mode === "average"
                            ? "average"
                            : mode === "maximum"
                                ? "maximum"
                                : mode === "minimum"
                                    ? "minimum"
                                    : "total";

                    return (
                        (
                            leftStats[key] -
                            rightStats[key]
                        ) *
                        multiplier ||
                        left.localeCompare(right)
                    );
                });
            };

            sortValues(
                this.providers,
                this.providerStats,
                this.options.rowSort,
                this.options.rowDirection
            );
            sortValues(
                this.metrics,
                this.metricStats,
                this.options.columnSort,
                this.options.columnDirection
            );
        }

        _normalizeCells() {
            const nonEmpty = this.cells.filter(
                (cell) =>
                    cell.value !== null &&
                    Number.isFinite(cell.value)
            );
            const globalMinimum = nonEmpty.length
                ? Math.min(...nonEmpty.map((cell) => cell.value))
                : 0;
            const globalMaximum = nonEmpty.length
                ? Math.max(...nonEmpty.map((cell) => cell.value))
                : 1;

            this.valueRange = {
                minimum: globalMinimum,
                maximum:
                    globalMaximum === globalMinimum
                        ? globalMinimum + 1
                        : globalMaximum
            };

            const normalize = (value, minimum, maximum) => {
                if (
                    value === null ||
                    !Number.isFinite(value)
                ) {
                    return 0;
                }

                if (maximum === minimum) {
                    return 1;
                }

                let ratio =
                    (value - minimum) /
                    (maximum - minimum);

                if (this.options.normalization === "log") {
                    ratio =
                        Math.log1p(ratio * 9) /
                        Math.log(10);
                }

                return Math.max(0, Math.min(1, ratio));
            };

            for (const cell of this.cells) {
                if (cell.value === null) {
                    cell.normalized = 0;
                    continue;
                }

                if (this.options.normalization === "row") {
                    const stats =
                        this.providerStats.get(cell.provider);
                    cell.normalized =
                        normalize(
                            cell.value,
                            stats.minimum,
                            stats.maximum
                        );
                } else if (
                    this.options.normalization === "column"
                ) {
                    const stats =
                        this.metricStats.get(cell.metric);
                    cell.normalized =
                        normalize(
                            cell.value,
                            stats.minimum,
                            stats.maximum
                        );
                } else if (
                    this.options.normalization === "none"
                ) {
                    cell.normalized =
                        cell.value > 0 ? 1 : 0;
                } else {
                    cell.normalized =
                        normalize(
                            cell.value,
                            globalMinimum,
                            globalMaximum
                        );
                }
            }
        }

        _matrixOrigin() {
            return {
                x:
                    this.options.padding +
                    this.options.rowHeaderWidth,
                y:
                    this.options.padding +
                    this.options.columnHeaderHeight
            };
        }

        _cellSize() {
            return (
                this.options.cellSize *
                this.transform.zoom
            );
        }

        _screenPoint(x, y) {
            return {
                x:
                    x *
                    this.transform.zoom +
                    this.transform.x,
                y:
                    y *
                    this.transform.zoom +
                    this.transform.y
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

            if (
                !this.providers.length ||
                !this.metrics.length
            ) {
                this.context.fillStyle =
                    this.options.foreground;
                this.context.globalAlpha = 0.72;
                this.context.font =
                    '14px "IBM Plex Mono", monospace';
                this.context.textAlign = "center";
                this.context.textBaseline = "middle";
                this.context.fillText(
                    "No provider matrix data.",
                    this.bounds.width / 2,
                    this.bounds.height / 2
                );
                this.context.globalAlpha = 1;
                this.metricsState.draws += 1;
                return;
            }

            this._drawCells();
            this._drawHeaders();

            if (this.options.showLegend) {
                this._drawLegend();
            }

            this.metricsState.draws += 1;
        }

        _drawCells() {
            const origin = this._matrixOrigin();
            const cellSize = this.options.cellSize;

            for (let row = 0; row < this.providers.length; row += 1) {
                const provider = this.providers[row];

                for (
                    let column = 0;
                    column < this.metrics.length;
                    column += 1
                ) {
                    const metric = this.metrics[column];
                    const cell =
                        this.cellIndex.get(
                            `${provider}\u0000${metric}`
                        );
                    const baseX =
                        origin.x +
                        column *
                        cellSize;
                    const baseY =
                        origin.y +
                        row *
                        cellSize;
                    const screen =
                        this._screenPoint(
                            baseX,
                            baseY
                        );
                    const size =
                        cellSize *
                        this.transform.zoom;
                    const emphasized =
                        cell === this.hovered ||
                        cell === this.selected;

                    this.context.fillStyle =
                        cell.count > 0
                            ? interpolateColor(
                                this.options.lowColor,
                                this.options.highColor,
                                cell.normalized,
                                0.94
                            )
                            : this.options.emptyColor;
                    this.context.globalAlpha =
                        emphasized ? 1 : 0.92;
                    this.context.fillRect(
                        screen.x,
                        screen.y,
                        size,
                        size
                    );

                    this.context.strokeStyle =
                        emphasized
                            ? this.options.highlight
                            : this.options.gridColor;
                    this.context.lineWidth =
                        emphasized ? 2 : 1;
                    this.context.globalAlpha =
                        emphasized ? 1 : 0.55;
                    this.context.strokeRect(
                        screen.x,
                        screen.y,
                        size,
                        size
                    );

                    if (
                        this.options.showValues &&
                        size >= 24 &&
                        cell.value !== null
                    ) {
                        this.context.fillStyle =
                            this.options.background;
                        this.context.globalAlpha = 0.9;
                        this.context.font =
                            `${Math.max(
                                8,
                                Math.min(12, size * 0.34)
                            )}px "IBM Plex Mono", monospace`;
                        this.context.textAlign = "center";
                        this.context.textBaseline = "middle";
                        this.context.fillText(
                            Number(
                                cell.value.toPrecision(4)
                            ).toString(),
                            screen.x + size / 2,
                            screen.y + size / 2
                        );
                    }

                    cell.screenX = screen.x;
                    cell.screenY = screen.y;
                    cell.screenSize = size;
                    cell.row = row;
                    cell.column = column;
                }
            }

            this.context.globalAlpha = 1;
        }

        _drawHeaders() {
            const origin = this._matrixOrigin();
            const cellSize = this.options.cellSize;
            const rowHeaderRight =
                origin.x * this.transform.zoom +
                this.transform.x;
            const columnHeaderBottom =
                origin.y * this.transform.zoom +
                this.transform.y;

            this.context.save();
            this.context.font =
                '11px "IBM Plex Mono", monospace';
            this.context.fillStyle =
                this.options.labelColor;
            this.context.globalAlpha = 0.9;

            for (let row = 0; row < this.providers.length; row += 1) {
                const provider = this.providers[row];
                const y =
                    (
                        origin.y +
                        row * cellSize +
                        cellSize / 2
                    ) *
                    this.transform.zoom +
                    this.transform.y;

                this.context.textAlign = "right";
                this.context.textBaseline = "middle";
                this.context.fillText(
                    provider,
                    rowHeaderRight - 8,
                    y
                );

                if (this.options.showTotals) {
                    const stats =
                        this.providerStats.get(provider);
                    this.context.fillStyle =
                        this.options.foreground;
                    this.context.globalAlpha = 0.55;
                    this.context.fillText(
                        Number(
                            stats.total.toPrecision(4)
                        ).toString(),
                        rowHeaderRight -
                        this.options.rowHeaderWidth *
                        this.transform.zoom +
                        8,
                        y
                    );
                    this.context.fillStyle =
                        this.options.labelColor;
                    this.context.globalAlpha = 0.9;
                }
            }

            for (
                let column = 0;
                column < this.metrics.length;
                column += 1
            ) {
                const metric = this.metrics[column];
                const x =
                    (
                        origin.x +
                        column * cellSize +
                        cellSize / 2
                    ) *
                    this.transform.zoom +
                    this.transform.x;

                this.context.save();
                this.context.translate(
                    x,
                    columnHeaderBottom - 8
                );
                this.context.rotate(-Math.PI / 3);
                this.context.textAlign = "left";
                this.context.textBaseline = "middle";
                this.context.fillText(metric, 0, 0);
                this.context.restore();
            }

            this.context.restore();
        }

        _drawLegend() {
            const width = 180;
            const height = 12;
            const x =
                this.bounds.width -
                this.options.padding -
                width;
            const y =
                this.bounds.height -
                this.options.padding -
                28;
            const gradient =
                this.context.createLinearGradient(
                    x,
                    0,
                    x + width,
                    0
                );

            gradient.addColorStop(
                0,
                this.options.lowColor
            );
            gradient.addColorStop(
                1,
                this.options.highColor
            );

            this.context.save();
            this.context.fillStyle = gradient;
            this.context.globalAlpha = 0.94;
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
                Number(
                    this.valueRange.minimum.toPrecision(4)
                ).toString(),
                x,
                y + 16
            );
            this.context.textAlign = "right";
            this.context.fillText(
                Number(
                    this.valueRange.maximum.toPrecision(4)
                ).toString(),
                x + width,
                y + 16
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
            for (
                let index = this.cells.length - 1;
                index >= 0;
                index -= 1
            ) {
                const cell = this.cells[index];

                if (
                    x >= cell.screenX &&
                    y >= cell.screenY &&
                    x <= cell.screenX + cell.screenSize &&
                    y <= cell.screenY + cell.screenSize
                ) {
                    return cell;
                }
            }

            return null;
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
                this.metricsState.pans += 1;
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
                    : this.options.pannable
                        ? "grab"
                        : "default";

            if (changed) {
                this.draw();

                this._emit("hover", {
                    cell:
                        hovered
                            ? this.describeCell(
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
            const previousZoom =
                this.transform.zoom;
            const factor =
                event.deltaY < 0
                    ? 1.12
                    : 1 / 1.12;
            const zoom = Math.max(
                0.3,
                Math.min(
                    8,
                    previousZoom * factor
                )
            );
            const worldX =
                (point.x - this.transform.x) /
                previousZoom;
            const worldY =
                (point.y - this.transform.y) /
                previousZoom;

            this.transform.zoom = zoom;
            this.transform.x =
                point.x -
                worldX * zoom;
            this.transform.y =
                point.y -
                worldY * zoom;
            this.metricsState.zooms += 1;
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
                cell?.key === this.selected?.key
                    ? null
                    : cell;
            this.metricsState.selections += 1;
            this.draw();

            this._emit("select", {
                cell:
                    this.selected
                        ? this.describeCell(
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
                0.3,
                Math.min(
                    8,
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
            this.transform.x += Number(x) || 0;
            this.transform.y += Number(y) || 0;
            this.metricsState.pans += 1;
            this.draw();
            return clone(this.transform);
        }

        resetView() {
            this.transform = {
                zoom: 1,
                x: 0,
                y: 0
            };
            this.selected = null;
            this.draw();
            return clone(this.transform);
        }

        setProviderFilter(query = "") {
            this.providerFilter =
                String(query || "");
            this.rebuild();
            this.draw();

            this._emit("filter", {
                provider:
                    this.providerFilter,
                metric:
                    this.metricFilter
            });

            return this.providerFilter;
        }

        setMetricFilter(query = "") {
            this.metricFilter =
                String(query || "");
            this.rebuild();
            this.draw();

            this._emit("filter", {
                provider:
                    this.providerFilter,
                metric:
                    this.metricFilter
            });

            return this.metricFilter;
        }

        sortRows(mode, direction = this.options.rowDirection) {
            if (
                ![
                    "name",
                    "total",
                    "average",
                    "maximum",
                    "minimum"
                ].includes(mode)
            ) {
                throw new Error(
                    `Unknown row sort mode: ${mode}`
                );
            }

            this.options.rowSort = mode;
            this.options.rowDirection =
                direction === "asc"
                    ? "asc"
                    : "desc";
            this._sortAxes();
            this.draw();

            return {
                mode:
                    this.options.rowSort,
                direction:
                    this.options.rowDirection
            };
        }

        sortColumns(mode, direction = this.options.columnDirection) {
            if (
                ![
                    "name",
                    "total",
                    "average",
                    "maximum",
                    "minimum"
                ].includes(mode)
            ) {
                throw new Error(
                    `Unknown column sort mode: ${mode}`
                );
            }

            this.options.columnSort = mode;
            this.options.columnDirection =
                direction === "asc"
                    ? "asc"
                    : "desc";
            this._sortAxes();
            this.draw();

            return {
                mode:
                    this.options.columnSort,
                direction:
                    this.options.columnDirection
            };
        }

        describeCell(cell) {
            if (!cell) {
                return null;
            }

            return {
                key: cell.key,
                provider: cell.provider,
                metric: cell.metric,
                count: cell.count,
                weight: cell.weight,
                sum: cell.sum,
                minimum: cell.minimum,
                maximum: cell.maximum,
                average: cell.average,
                value: cell.value,
                normalized: cell.normalized,
                records: cell.records.map(clone)
            };
        }

        selectCell(provider, metric) {
            const cell =
                this.cellIndex.get(
                    `${provider}\u0000${metric}`
                );

            if (!cell) {
                return null;
            }

            this.selected = cell;
            this.draw();
            return this.describeCell(cell);
        }

        update(options = {}) {
            if (!isObject(options)) {
                throw new TypeError(
                    "ProviderMatrix options must be an object."
                );
            }

            const rebuildRequired = [
                "providerKey",
                "provider",
                "metricKey",
                "metric",
                "valueKey",
                "value",
                "weightKey",
                "weight",
                "aggregation",
                "normalization",
                "maxProviders",
                "maxMetrics"
            ].some((key) =>
                options[key] !== undefined
            );

            Object.assign(this.options, {
                providerKey:
                    options.providerKey !== undefined
                        ? options.providerKey
                        : this.options.providerKey,
                provider:
                    options.provider !== undefined
                        ? options.provider
                        : this.options.provider,
                metricKey:
                    options.metricKey !== undefined
                        ? options.metricKey
                        : this.options.metricKey,
                metric:
                    options.metric !== undefined
                        ? options.metric
                        : this.options.metric,
                valueKey:
                    options.valueKey !== undefined
                        ? options.valueKey
                        : this.options.valueKey,
                value:
                    options.value !== undefined
                        ? options.value
                        : this.options.value,
                weightKey:
                    options.weightKey !== undefined
                        ? options.weightKey
                        : this.options.weightKey,
                weight:
                    options.weight !== undefined
                        ? options.weight
                        : this.options.weight,
                aggregation:
                    options.aggregation ||
                    this.options.aggregation,
                normalization:
                    options.normalization ||
                    this.options.normalization,
                rowSort:
                    options.rowSort ||
                    this.options.rowSort,
                columnSort:
                    options.columnSort ||
                    this.options.columnSort,
                rowDirection:
                    options.rowDirection ||
                    this.options.rowDirection,
                columnDirection:
                    options.columnDirection ||
                    this.options.columnDirection,
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
                emptyColor:
                    options.emptyColor ||
                    this.options.emptyColor,
                lowColor:
                    options.lowColor ||
                    this.options.lowColor,
                highColor:
                    options.highColor ||
                    this.options.highColor,
                labelColor:
                    options.labelColor ||
                    this.options.labelColor,
                padding:
                    options.padding !== undefined
                        ? parseNumber(
                            options.padding,
                            this.options.padding,
                            0,
                            200
                        )
                        : this.options.padding,
                rowHeaderWidth:
                    options.rowHeaderWidth !== undefined
                        ? parseNumber(
                            options.rowHeaderWidth,
                            this.options.rowHeaderWidth,
                            60,
                            500
                        )
                        : this.options.rowHeaderWidth,
                columnHeaderHeight:
                    options.columnHeaderHeight !== undefined
                        ? parseNumber(
                            options.columnHeaderHeight,
                            this.options.columnHeaderHeight,
                            40,
                            300
                        )
                        : this.options.columnHeaderHeight,
                cellSize:
                    options.cellSize !== undefined
                        ? parseNumber(
                            options.cellSize,
                            this.options.cellSize,
                            8,
                            120
                        )
                        : this.options.cellSize,
                showValues:
                    options.showValues !== undefined
                        ? Boolean(options.showValues)
                        : this.options.showValues,
                showLegend:
                    options.showLegend !== undefined
                        ? Boolean(options.showLegend)
                        : this.options.showLegend,
                showTotals:
                    options.showTotals !== undefined
                        ? Boolean(options.showTotals)
                        : this.options.showTotals,
                maxProviders:
                    options.maxProviders !== undefined
                        ? parseNumber(
                            options.maxProviders,
                            this.options.maxProviders,
                            1,
                            10000
                        )
                        : this.options.maxProviders,
                maxMetrics:
                    options.maxMetrics !== undefined
                        ? parseNumber(
                            options.maxMetrics,
                            this.options.maxMetrics,
                            1,
                            10000
                        )
                        : this.options.maxMetrics
            });

            if (rebuildRequired) {
                this.rebuild();
            } else {
                this._sortAxes();
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
                        providers:
                            this.providers,
                        metrics:
                            this.metrics,
                        valueRange:
                            this.valueRange,
                        cells:
                            this.cells.map(
                                (cell) =>
                                    this.describeCell(cell)
                            )
                    },
                    null,
                    2
                );
            }

            if (normalized === "csv") {
                const rows = [
                    [
                        "provider",
                        ...this.metrics
                    ]
                ];

                for (const provider of this.providers) {
                    rows.push([
                        provider,
                        ...this.metrics.map((metric) => {
                            const cell =
                                this.cellIndex.get(
                                    `${provider}\u0000${metric}`
                                );

                            return cell?.value ?? "";
                        })
                    ]);
                }

                return rows
                    .map((row) =>
                        row.map(escapeCsv).join(",")
                    )
                    .join("\r\n");
            }

            throw new Error(
                `Unsupported ProviderMatrix export format: ${format}`
            );
        }

        status() {
            return {
                name:
                    "provider-matrix",
                module:
                    MODULE_NAME,
                records:
                    this.records.length,
                providers:
                    this.providers.length,
                metrics:
                    this.metrics.length,
                cells:
                    this.cells.length,
                nonEmptyCells:
                    this.metricsState.nonEmptyCells,
                valueRange:
                    clone(this.valueRange),
                providerFilter:
                    this.providerFilter,
                metricFilter:
                    this.metricFilter,
                transform:
                    clone(this.transform),
                selected:
                    this.selected
                        ? this.describeCell(
                            this.selected
                        )
                        : null,
                hovered:
                    this.hovered
                        ? this.describeCell(
                            this.hovered
                        )
                        : null,
                options:
                    clone(this.options),
                metricsState:
                    { ...this.metricsState },
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

            this.records = [];
            this.providers = [];
            this.metrics = [];
            this.cells = [];
            this.cellIndex.clear();
            this.providerStats.clear();
            this.metricStats.clear();
            this.destroyed = true;

            this._emit("destroy", {});
            return true;
        }
    }

    function mount(target, data = [], options = {}) {
        return new ProviderMatrixController(
            target,
            data,
            options
        );
    }

    function render(data = [], options = {}) {
        const container = createElement(
            "section",
            "terminal-visualization terminal-visualization-provider-matrix"
        );
        container.dataset.visualization =
            "provider-matrix";
        container.setAttribute(
            "role",
            "region"
        );
        container.setAttribute(
            "aria-label",
            options.label ||
            "ProviderMatrix visualization"
        );

        const canvas =
            document.createElement("canvas");
        canvas.className =
            "terminal-provider-matrix-canvas";
        canvas.width =
            Number(options.width) ||
            DEFAULT_WIDTH;
        canvas.height =
            Number(options.height) ||
            DEFAULT_HEIGHT;
        canvas.setAttribute(
            "aria-label",
            options.label ||
            "ProviderMatrix visualization"
        );

        const status = createElement(
            "div",
            "terminal-provider-matrix-status"
        );
        status.setAttribute(
            "aria-live",
            "polite"
        );

        const tooltip = createElement(
            "div",
            "terminal-provider-matrix-tooltip"
        );
        tooltip.hidden = true;

        container.append(
            canvas,
            status,
            tooltip
        );

        const controller =
            new ProviderMatrixController(
                canvas,
                data,
                options
            );

        const updateStatus = () => {
            const snapshot =
                controller.status();

            status.textContent =
                `${snapshot.providers} provider` +
                `${snapshot.providers === 1 ? "" : "s"} · ` +
                `${snapshot.metrics} metric` +
                `${snapshot.metrics === 1 ? "" : "s"} · ` +
                `${snapshot.nonEmptyCells} populated cell` +
                `${snapshot.nonEmptyCells === 1 ? "" : "s"} · ` +
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
                    `${cell.provider} × ${cell.metric} · ` +
                    `${cell.value === null ? "no data" : cell.value} · ` +
                    `${cell.count} record` +
                    `${cell.count === 1 ? "" : "s"}`;
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
            controller.cells;
        container.destroy = () =>
            controller.destroy();

        return container;
    }

    function initialize(context = {}) {
        const dataset =
            context.root?.dataset || {};
        const config =
            context.config?.providerMatrix ||
            context.config?.["provider-matrix"] ||
            {};

        const defaults = {
            providerKey:
                dataset.terminalProviderMatrixProviderKey ||
                config.providerKey ||
                null,

            metricKey:
                dataset.terminalProviderMatrixMetricKey ||
                config.metricKey ||
                null,

            valueKey:
                dataset.terminalProviderMatrixValueKey ||
                config.valueKey ||
                null,

            weightKey:
                dataset.terminalProviderMatrixWeightKey ||
                config.weightKey ||
                null,

            aggregation:
                dataset.terminalProviderMatrixAggregation ||
                config.aggregation ||
                "sum",

            normalization:
                dataset.terminalProviderMatrixNormalization ||
                config.normalization ||
                "global",

            background:
                dataset.terminalProviderMatrixBackground ||
                config.background ||
                DEFAULT_BACKGROUND,

            foreground:
                dataset.terminalProviderMatrixForeground ||
                config.foreground ||
                DEFAULT_FOREGROUND,

            highlight:
                dataset.terminalProviderMatrixHighlight ||
                config.highlight ||
                DEFAULT_HIGHLIGHT,

            gridColor:
                dataset.terminalProviderMatrixGrid ||
                config.gridColor ||
                DEFAULT_GRID,

            emptyColor:
                dataset.terminalProviderMatrixEmpty ||
                config.emptyColor ||
                DEFAULT_EMPTY,

            lowColor:
                dataset.terminalProviderMatrixLow ||
                config.lowColor ||
                DEFAULT_LOW,

            highColor:
                dataset.terminalProviderMatrixHigh ||
                config.highColor ||
                DEFAULT_HIGH,

            cellSize:
                dataset.terminalProviderMatrixCellSize ||
                config.cellSize ||
                DEFAULT_CELL_SIZE,

            showValues: parseBoolean(
                dataset.terminalProviderMatrixShowValues,
                config.showValues === true
            ),

            showLegend: parseBoolean(
                dataset.terminalProviderMatrixShowLegend,
                config.showLegend !== false
            ),

            showTotals: parseBoolean(
                dataset.terminalProviderMatrixShowTotals,
                config.showTotals !== false
            ),

            interactive: parseBoolean(
                dataset.terminalProviderMatrixInteractive,
                config.interactive !== false
            )
        };

        const visualization = {
            mount(target, data = [], options = {}) {
                return new ProviderMatrixController(
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
                ProviderMatrixController,

            normalizeRecords,

            inferField,

            providerForRecord,

            metricForRecord,

            valueForRecord
        };

        context.registerVisualization?.(
            "provider-matrix",
            visualization
        );
        context.registerRenderer?.(
            "provider-matrix",
            visualization
        );
        context.providerMatrix =
            visualization;

        safeDispatch(
            document,
            "speciedex:terminal-provider-matrix-ready",
            {
                visualization
            }
        );

        return visualization;
    }

    const commands = [{
        name: "provider-matrix",
        category: "visualization",
        description:
            "Render and control a provider-by-metric comparison matrix.",
        usage:
            "provider-matrix [collection|status|provider|metric|rows|columns|" +
            "zoom|pan|reset|export] [arguments]",
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
                context.providerMatrixController ||
                context.terminalProviderMatrixController;

            try {
                if (controller) {
                    switch (lower) {
                        case "status":
                        case "show":
                        case "info":
                            return writeJSON(
                                controller.status()
                            );

                        case "provider":
                            return writeJSON({
                                filter:
                                    controller.setProviderFilter(
                                        args.slice(1).join(" ")
                                    ),
                                status:
                                    controller.status()
                            });

                        case "metric":
                            return writeJSON({
                                filter:
                                    controller.setMetricFilter(
                                        args.slice(1).join(" ")
                                    ),
                                status:
                                    controller.status()
                            });

                        case "rows":
                            return writeJSON({
                                sort:
                                    controller.sortRows(
                                        args[1] ||
                                        "total",
                                        args[2] ||
                                        "desc"
                                    )
                            });

                        case "columns":
                            return writeJSON({
                                sort:
                                    controller.sortColumns(
                                        args[1] ||
                                        "total",
                                        args[2] ||
                                        "desc"
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
                        ...context.config?.providerMatrix,
                        ...context.config?.["provider-matrix"],
                        label:
                            `ProviderMatrix for ${collection}`
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
        ProviderMatrixController,
        normalizeRecords,
        inferField,
        providerForRecord,
        metricForRecord,
        valueForRecord,
        mount,
        render,
        initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalProviderMatrix =
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
