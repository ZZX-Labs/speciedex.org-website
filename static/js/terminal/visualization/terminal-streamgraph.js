/*
========================================================================
Speciedex.org
Terminal StreamGraph Visualization
========================================================================

Interactive streamgraph renderer for Speciedex records. Supports automatic
time/category/value inference, stacked and silhouette baselines, wiggle
offsets, smoothing, aggregation, filtering, hover inspection, selection,
zoom, pan, brushing, responsive high-DPI rendering, JSON, CSV, and PNG export,
diagnostics, runtime updates, and lifecycle control.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "StreamGraph";
    const DEFAULT_WIDTH = 960;
    const DEFAULT_HEIGHT = 540;
    const DEFAULT_BACKGROUND = "#020a05";
    const DEFAULT_FOREGROUND = "#c0d674";
    const DEFAULT_HIGHLIGHT = "#eef7c8";
    const DEFAULT_GRID = "#1f3a27";
    const DEFAULT_AXIS = "#35503a";
    const DEFAULT_LABEL = "#d8e6db";
    const DEFAULT_PADDING = Object.freeze({
        top: 28,
        right: 28,
        bottom: 46,
        left: 62
    });
    const DEFAULT_MAX_RECORDS = 250000;
    const DEFAULT_MAX_SERIES = 512;
    const DEFAULT_MAX_POINTS = 10000;

    const TIME_FIELDS = Object.freeze([
        "timestamp",
        "time",
        "date",
        "datetime",
        "observed_at",
        "observedAt",
        "event_date",
        "eventDate",
        "year",
        "month"
    ]);

    const CATEGORY_FIELDS = Object.freeze([
        "series",
        "category",
        "group",
        "provider",
        "source",
        "kingdom",
        "phylum",
        "class",
        "order",
        "family",
        "genus",
        "rank",
        "status",
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
            "StreamGraph requires a canvas or container element."
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
                "series",
                "points",
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

    function parseTime(value, index = 0) {
        if (value instanceof Date && Number.isFinite(value.getTime())) {
            return value.getTime();
        }

        if (typeof value === "number" && Number.isFinite(value)) {
            if (value > 1e12) {
                return value;
            }

            if (value > 1e9) {
                return value * 1000;
            }

            if (value >= 1000 && value <= 9999) {
                return Date.UTC(value, 0, 1);
            }

            return value;
        }

        const parsed = Date.parse(String(value));

        return Number.isFinite(parsed)
            ? parsed
            : index;
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

    function timeForRecord(record, index, options = {}) {
        if (typeof options.timeAccessor === "function") {
            return parseTime(
                options.timeAccessor(record, index),
                index
            );
        }

        if (options.timeKey && isObject(record)) {
            return parseTime(record[options.timeKey], index);
        }

        if (!isObject(record)) {
            return index;
        }

        return parseTime(
            firstValue(record, TIME_FIELDS, index),
            index
        );
    }

    function categoryForRecord(record, options = {}) {
        if (typeof options.categoryAccessor === "function") {
            return String(
                options.categoryAccessor(record) ??
                "series"
            );
        }

        if (options.categoryKey && isObject(record)) {
            return String(
                record[options.categoryKey] ??
                "series"
            );
        }

        if (!isObject(record)) {
            return "series";
        }

        return String(
            firstValue(
                record,
                CATEGORY_FIELDS,
                "series"
            )
        );
    }

    function valueForRecord(record, options = {}) {
        if (typeof options.valueAccessor === "function") {
            const value = Number(
                options.valueAccessor(record)
            );

            return Number.isFinite(value)
                ? value
                : null;
        }

        if (options.valueKey && isObject(record)) {
            const value = Number(record[options.valueKey]);

            return Number.isFinite(value)
                ? value
                : null;
        }

        if (typeof record === "number") {
            return Number.isFinite(record)
                ? record
                : null;
        }

        if (!isObject(record)) {
            return 1;
        }

        for (const key of VALUE_FIELDS) {
            const value = Number(record[key]);

            if (Number.isFinite(value)) {
                return value;
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

        return `hsl(${Math.abs(hash) % 360} 56% 60%)`;
    }

    function escapeCsv(value) {
        const text = String(value ?? "");

        return /[",\n\r]/.test(text)
            ? `"${text.replace(/"/g, '""')}"`
            : text;
    }

    function formatTime(value) {
        if (!Number.isFinite(value)) {
            return "";
        }

        if (value >= 1e11) {
            return new Date(value).toISOString();
        }

        return String(value);
    }

    class StreamGraphController extends EventTarget {
        constructor(target, data = [], options = {}) {
            super();

            this.canvas = resolveCanvas(target);
            this.context = this.canvas.getContext("2d", {
                alpha: true,
                desynchronized: true
            });

            if (!this.context) {
                throw new Error(
                    "Unable to acquire StreamGraph 2D canvas context."
                );
            }

            this.options = {
                timeKey:
                    options.timeKey || null,
                timeAccessor:
                    options.timeAccessor,
                categoryKey:
                    options.categoryKey || null,
                categoryAccessor:
                    options.categoryAccessor,
                valueKey:
                    options.valueKey || null,
                valueAccessor:
                    options.valueAccessor,
                aggregation: [
                    "sum",
                    "average",
                    "min",
                    "max",
                    "count"
                ].includes(options.aggregation)
                    ? options.aggregation
                    : "sum",
                baseline: [
                    "zero",
                    "silhouette",
                    "wiggle"
                ].includes(options.baseline)
                    ? options.baseline
                    : "wiggle",
                order: [
                    "inside-out",
                    "ascending",
                    "descending",
                    "name",
                    "none"
                ].includes(options.order)
                    ? options.order
                    : "inside-out",
                curve: [
                    "linear",
                    "smooth"
                ].includes(options.curve)
                    ? options.curve
                    : "smooth",
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
                padding: {
                    ...DEFAULT_PADDING,
                    ...(isObject(options.padding)
                        ? options.padding
                        : {})
                },
                showGrid:
                    options.showGrid !== false,
                showAxes:
                    options.showAxes !== false,
                showLabels:
                    options.showLabels !== false,
                showLegend:
                    options.showLegend !== false,
                showValues:
                    options.showValues === true,
                interactive:
                    options.interactive !== false,
                zoomable:
                    options.zoomable !== false,
                pannable:
                    options.pannable !== false,
                brushable:
                    options.brushable !== false,
                maxSeries: parseNumber(
                    options.maxSeries,
                    DEFAULT_MAX_SERIES,
                    1,
                    10000
                ),
                maxPoints: parseNumber(
                    options.maxPoints,
                    DEFAULT_MAX_POINTS,
                    2,
                    100000
                ),
                label:
                    options.label ||
                    "StreamGraph visualization"
            };

            this.records = [];
            this.times = [];
            this.series = [];
            this.seriesMap = new Map();
            this.stack = [];
            this.bounds = {
                width: 1,
                height: 1
            };
            this.plot = {
                x: 0,
                y: 0,
                width: 1,
                height: 1
            };
            this.domain = {
                timeMin: 0,
                timeMax: 1,
                valueMin: 0,
                valueMax: 1
            };
            this.transform = {
                zoom: 1,
                x: 0
            };
            this.hovered = null;
            this.selected = null;
            this.drag = null;
            this.brush = null;
            this.query = "";
            this.hiddenSeries = new Set();
            this.destroyed = false;
            this.lastError = null;
            this.metrics = {
                inputRecords: 0,
                acceptedRecords: 0,
                rejectedRecords: 0,
                series: 0,
                visibleSeries: 0,
                points: 0,
                draws: 0,
                rebuilds: 0,
                resizes: 0,
                zooms: 0,
                pans: 0,
                selections: 0,
                brushes: 0,
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

            this.plot.x =
                this.options.padding.left;
            this.plot.y =
                this.options.padding.top;
            this.plot.width =
                Math.max(
                    1,
                    this.bounds.width -
                    this.options.padding.left -
                    this.options.padding.right
                );
            this.plot.height =
                Math.max(
                    1,
                    this.bounds.height -
                    this.options.padding.top -
                    this.options.padding.bottom
                );

            this.metrics.resizes += 1;
            this.draw();

            this._emit("resize", clone(this.bounds));
        }

        setData(data) {
            try {
                this.records = normalizeRecords(data);

                if (!this.options.timeKey && !this.options.timeAccessor) {
                    this.options.timeKey =
                        inferField(this.records, TIME_FIELDS);
                }

                if (!this.options.categoryKey && !this.options.categoryAccessor) {
                    this.options.categoryKey =
                        inferField(this.records, CATEGORY_FIELDS);
                }

                if (!this.options.valueKey && !this.options.valueAccessor) {
                    this.options.valueKey =
                        inferField(this.records, VALUE_FIELDS);
                }

                this.rebuild();
                this.draw();

                this._emit("data", {
                    records:
                        this.records.length,
                    series:
                        this.series.length,
                    points:
                        this.times.length
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
                    this.records.length -
                    DEFAULT_MAX_RECORDS
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
            const timeSet = new Set();
            const categories = new Map();
            let accepted = 0;
            let rejected = 0;

            for (
                let index = 0;
                index < this.records.length;
                index += 1
            ) {
                const record = this.records[index];
                const time =
                    timeForRecord(
                        record,
                        index,
                        this.options
                    );
                const category =
                    categoryForRecord(
                        record,
                        this.options
                    );
                const value =
                    valueForRecord(
                        record,
                        this.options
                    );

                if (
                    !Number.isFinite(time) ||
                    !category ||
                    value === null ||
                    !Number.isFinite(value)
                ) {
                    rejected += 1;
                    continue;
                }

                if (
                    !categories.has(category) &&
                    categories.size >= this.options.maxSeries
                ) {
                    rejected += 1;
                    continue;
                }

                timeSet.add(time);

                if (!categories.has(category)) {
                    categories.set(category, new Map());
                }

                const timeBuckets =
                    categories.get(category);

                if (!timeBuckets.has(time)) {
                    timeBuckets.set(time, {
                        count: 0,
                        sum: 0,
                        minimum: Infinity,
                        maximum: -Infinity,
                        records: []
                    });
                }

                const bucket =
                    timeBuckets.get(time);

                bucket.count += 1;
                bucket.sum += value;
                bucket.minimum =
                    Math.min(
                        bucket.minimum,
                        value
                    );
                bucket.maximum =
                    Math.max(
                        bucket.maximum,
                        value
                    );

                if (bucket.records.length < 100) {
                    bucket.records.push(record);
                }

                accepted += 1;
            }

            this.times =
                Array.from(timeSet)
                    .sort((left, right) =>
                        left - right
                    )
                    .slice(
                        -this.options.maxPoints
                    );

            this.series = [];
            this.seriesMap.clear();

            for (
                const [name, buckets]
                of categories
            ) {
                const values =
                    this.times.map((time) => {
                        const bucket =
                            buckets.get(time);

                        if (!bucket) {
                            return {
                                time,
                                value: 0,
                                count: 0,
                                minimum: null,
                                maximum: null,
                                average: null,
                                records: []
                            };
                        }

                        let value;

                        switch (this.options.aggregation) {
                            case "average":
                                value =
                                    bucket.count
                                        ? bucket.sum /
                                          bucket.count
                                        : 0;
                                break;

                            case "min":
                                value =
                                    bucket.minimum;
                                break;

                            case "max":
                                value =
                                    bucket.maximum;
                                break;

                            case "count":
                                value =
                                    bucket.count;
                                break;

                            case "sum":
                            default:
                                value =
                                    bucket.sum;
                                break;
                        }

                        return {
                            time,
                            value:
                                Math.max(0, value),
                            count:
                                bucket.count,
                            minimum:
                                bucket.minimum,
                            maximum:
                                bucket.maximum,
                            average:
                                bucket.count
                                    ? bucket.sum /
                                      bucket.count
                                    : 0,
                            records:
                                bucket.records.map(
                                    clone
                                )
                        };
                    });

                const total =
                    values.reduce(
                        (sum, point) =>
                            sum + point.value,
                        0
                    );

                const series = {
                    name,
                    values,
                    total,
                    maximum:
                        Math.max(
                            ...values.map(
                                (point) =>
                                    point.value
                            ),
                            0
                        ),
                    visible:
                        !this.hiddenSeries.has(name),
                    color:
                        colorHash(name),
                    paths: []
                };

                this.series.push(series);
                this.seriesMap.set(name, series);
            }

            this._sortSeries();
            this._applyFilter();
            this._buildStack();
            this._updateDomain();

            this.metrics.inputRecords =
                this.records.length;
            this.metrics.acceptedRecords =
                accepted;
            this.metrics.rejectedRecords =
                rejected;
            this.metrics.series =
                this.series.length;
            this.metrics.visibleSeries =
                this.series.filter(
                    (series) => series.visible
                ).length;
            this.metrics.points =
                this.times.length;
            this.metrics.rebuilds += 1;
        }

        _sortSeries() {
            if (this.options.order === "none") {
                return;
            }

            if (this.options.order === "name") {
                this.series.sort(
                    (left, right) =>
                        left.name.localeCompare(
                            right.name
                        )
                );
                return;
            }

            if (this.options.order === "ascending") {
                this.series.sort(
                    (left, right) =>
                        left.total -
                        right.total
                );
                return;
            }

            if (this.options.order === "descending") {
                this.series.sort(
                    (left, right) =>
                        right.total -
                        left.total
                );
                return;
            }

            const ascending =
                this.series
                    .slice()
                    .sort(
                        (left, right) =>
                            left.total -
                            right.total
                    );
            const top = [];
            const bottom = [];
            let topTotal = 0;
            let bottomTotal = 0;

            for (const series of ascending) {
                if (topTotal < bottomTotal) {
                    top.push(series);
                    topTotal += series.total;
                } else {
                    bottom.push(series);
                    bottomTotal += series.total;
                }
            }

            this.series = [
                ...bottom.reverse(),
                ...top
            ];
        }

        _applyFilter() {
            const query =
                this.query.toLowerCase();

            for (const series of this.series) {
                series.visible =
                    !this.hiddenSeries.has(
                        series.name
                    ) &&
                    (
                        !query ||
                        series.name
                            .toLowerCase()
                            .includes(query)
                    );
            }
        }

        _buildStack() {
            const visible =
                this.series.filter(
                    (series) => series.visible
                );
            const pointCount =
                this.times.length;

            this.stack =
                visible.map((series) => ({
                    series,
                    lower:
                        new Array(pointCount)
                            .fill(0),
                    upper:
                        new Array(pointCount)
                            .fill(0)
                }));

            if (!pointCount || !visible.length) {
                return;
            }

            const totals =
                new Array(pointCount)
                    .fill(0);

            for (
                let index = 0;
                index < pointCount;
                index += 1
            ) {
                totals[index] =
                    visible.reduce(
                        (sum, series) =>
                            sum +
                            series.values[index].value,
                        0
                    );
            }

            const baseline =
                new Array(pointCount)
                    .fill(0);

            if (
                this.options.baseline ===
                "silhouette"
            ) {
                for (
                    let index = 0;
                    index < pointCount;
                    index += 1
                ) {
                    baseline[index] =
                        -totals[index] / 2;
                }
            } else if (
                this.options.baseline ===
                "wiggle"
            ) {
                baseline[0] =
                    -totals[0] / 2;

                for (
                    let index = 1;
                    index < pointCount;
                    index += 1
                ) {
                    let weightedSlope = 0;
                    let cumulative = 0;

                    for (const series of visible) {
                        const previous =
                            series.values[index - 1].value;
                        const current =
                            series.values[index].value;
                        const slope =
                            current - previous;

                        weightedSlope +=
                            (
                                cumulative +
                                current / 2
                            ) *
                            slope;
                        cumulative += current;
                    }

                    baseline[index] =
                        baseline[index - 1] -
                        (
                            totals[index]
                                ? weightedSlope /
                                  totals[index]
                                : 0
                        );
                }

                const minimum =
                    Math.min(...baseline);
                const maximumTop =
                    Math.max(
                        ...baseline.map(
                            (value, index) =>
                                value + totals[index]
                        )
                    );
                const offset =
                    (
                        minimum +
                        maximumTop
                    ) /
                    2;

                for (
                    let index = 0;
                    index < baseline.length;
                    index += 1
                ) {
                    baseline[index] -= offset;
                }
            }

            for (
                let pointIndex = 0;
                pointIndex < pointCount;
                pointIndex += 1
            ) {
                let offset =
                    baseline[pointIndex];

                for (
                    let seriesIndex = 0;
                    seriesIndex < visible.length;
                    seriesIndex += 1
                ) {
                    const value =
                        visible[seriesIndex]
                            .values[pointIndex]
                            .value;
                    const layer =
                        this.stack[seriesIndex];

                    layer.lower[pointIndex] =
                        offset;
                    layer.upper[pointIndex] =
                        offset + value;
                    offset += value;
                }
            }
        }

        _updateDomain() {
            if (!this.times.length || !this.stack.length) {
                this.domain = {
                    timeMin: 0,
                    timeMax: 1,
                    valueMin: 0,
                    valueMax: 1
                };
                return;
            }

            this.domain.timeMin =
                Math.min(...this.times);
            this.domain.timeMax =
                Math.max(...this.times);

            if (
                this.domain.timeMax ===
                this.domain.timeMin
            ) {
                this.domain.timeMax =
                    this.domain.timeMin + 1;
            }

            this.domain.valueMin =
                Math.min(
                    ...this.stack.flatMap(
                        (layer) => layer.lower
                    )
                );
            this.domain.valueMax =
                Math.max(
                    ...this.stack.flatMap(
                        (layer) => layer.upper
                    )
                );

            if (
                this.domain.valueMax ===
                this.domain.valueMin
            ) {
                this.domain.valueMax =
                    this.domain.valueMin + 1;
            }
        }

        _xForTime(time) {
            const ratio =
                (
                    time -
                    this.domain.timeMin
                ) /
                (
                    this.domain.timeMax -
                    this.domain.timeMin
                );

            return (
                this.plot.x +
                ratio *
                this.plot.width *
                this.transform.zoom +
                this.transform.x
            );
        }

        _yForValue(value) {
            const ratio =
                (
                    value -
                    this.domain.valueMin
                ) /
                (
                    this.domain.valueMax -
                    this.domain.valueMin
                );

            return (
                this.plot.y +
                this.plot.height -
                ratio *
                this.plot.height
            );
        }

        _timeForX(x) {
            const ratio =
                (
                    x -
                    this.plot.x -
                    this.transform.x
                ) /
                (
                    this.plot.width *
                    this.transform.zoom
                );

            return (
                this.domain.timeMin +
                ratio *
                (
                    this.domain.timeMax -
                    this.domain.timeMin
                )
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

            if (!this.stack.length || !this.times.length) {
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
                    "No streamgraph data.",
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

            this._drawLayers();

            if (this.options.showAxes) {
                this._drawAxes();
            }

            if (this.options.showLabels) {
                this._drawLabels();
            }

            if (this.options.showLegend) {
                this._drawLegend();
            }

            if (this.brush) {
                this._drawBrush();
            }

            this.metrics.draws += 1;
        }

        _drawGrid() {
            this.context.save();
            this.context.strokeStyle =
                this.options.gridColor;
            this.context.globalAlpha =
                0.35;
            this.context.lineWidth = 1;

            const vertical = 8;
            const horizontal = 6;

            for (
                let index = 0;
                index <= vertical;
                index += 1
            ) {
                const x =
                    this.plot.x +
                    this.plot.width *
                    index /
                    vertical;

                this.context.beginPath();
                this.context.moveTo(
                    x,
                    this.plot.y
                );
                this.context.lineTo(
                    x,
                    this.plot.y +
                    this.plot.height
                );
                this.context.stroke();
            }

            for (
                let index = 0;
                index <= horizontal;
                index += 1
            ) {
                const y =
                    this.plot.y +
                    this.plot.height *
                    index /
                    horizontal;

                this.context.beginPath();
                this.context.moveTo(
                    this.plot.x,
                    y
                );
                this.context.lineTo(
                    this.plot.x +
                    this.plot.width,
                    y
                );
                this.context.stroke();
            }

            this.context.restore();
        }

        _buildLayerPath(layer) {
            const top = [];
            const bottom = [];

            for (
                let index = 0;
                index < this.times.length;
                index += 1
            ) {
                top.push({
                    x:
                        this._xForTime(
                            this.times[index]
                        ),
                    y:
                        this._yForValue(
                            layer.upper[index]
                        )
                });

                bottom.push({
                    x:
                        this._xForTime(
                            this.times[index]
                        ),
                    y:
                        this._yForValue(
                            layer.lower[index]
                        )
                });
            }

            return {
                top,
                bottom
            };
        }

        _traceCurve(points, reverse = false) {
            const values =
                reverse
                    ? points.slice().reverse()
                    : points;

            if (!values.length) {
                return;
            }

            this.context.moveTo(
                values[0].x,
                values[0].y
            );

            if (
                this.options.curve === "linear" ||
                values.length < 3
            ) {
                for (
                    let index = 1;
                    index < values.length;
                    index += 1
                ) {
                    this.context.lineTo(
                        values[index].x,
                        values[index].y
                    );
                }

                return;
            }

            for (
                let index = 1;
                index < values.length;
                index += 1
            ) {
                const previous =
                    values[index - 1];
                const current =
                    values[index];
                const middleX =
                    (
                        previous.x +
                        current.x
                    ) /
                    2;

                this.context.bezierCurveTo(
                    middleX,
                    previous.y,
                    middleX,
                    current.y,
                    current.x,
                    current.y
                );
            }
        }

        _drawLayers() {
            this.context.save();

            for (
                let index = 0;
                index < this.stack.length;
                index += 1
            ) {
                const layer =
                    this.stack[index];
                const series =
                    layer.series;
                const path =
                    this._buildLayerPath(layer);
                const emphasized =
                    series === this.hovered ||
                    series === this.selected;

                this.context.beginPath();
                this._traceCurve(path.top);
                this._traceCurve(
                    path.bottom,
                    true
                );
                this.context.closePath();

                this.context.fillStyle =
                    emphasized
                        ? this.options.highlight
                        : series.color;
                this.context.globalAlpha =
                    emphasized ? 1 : 0.82;

                if (emphasized) {
                    this.context.shadowColor =
                        this.options.highlight;
                    this.context.shadowBlur = 10;
                } else {
                    this.context.shadowBlur = 0;
                }

                this.context.fill();

                this.context.strokeStyle =
                    this.options.background;
                this.context.globalAlpha =
                    0.65;
                this.context.lineWidth = 1;
                this.context.stroke();

                series.paths = [path];
            }

            this.context.restore();
        }

        _drawAxes() {
            this.context.save();
            this.context.strokeStyle =
                this.options.axisColor;
            this.context.globalAlpha =
                0.8;
            this.context.lineWidth = 1.2;
            this.context.beginPath();
            this.context.moveTo(
                this.plot.x,
                this.plot.y
            );
            this.context.lineTo(
                this.plot.x,
                this.plot.y +
                this.plot.height
            );
            this.context.lineTo(
                this.plot.x +
                this.plot.width,
                this.plot.y +
                this.plot.height
            );
            this.context.stroke();

            this.context.fillStyle =
                this.options.foreground;
            this.context.font =
                '10px "IBM Plex Mono", monospace';
            this.context.globalAlpha =
                0.72;
            this.context.textBaseline =
                "top";

            const ticks = 6;

            for (
                let index = 0;
                index <= ticks;
                index += 1
            ) {
                const ratio =
                    index / ticks;
                const time =
                    this.domain.timeMin +
                    ratio *
                    (
                        this.domain.timeMax -
                        this.domain.timeMin
                    );
                const x =
                    this.plot.x +
                    ratio *
                    this.plot.width;

                this.context.textAlign =
                    index === 0
                        ? "left"
                        : index === ticks
                            ? "right"
                            : "center";
                this.context.fillText(
                    formatTime(time).slice(0, 10),
                    x,
                    this.plot.y +
                    this.plot.height +
                    8
                );
            }

            this.context.restore();
        }

        _drawLabels() {
            this.context.save();
            this.context.font =
                '11px "IBM Plex Mono", monospace';
            this.context.textBaseline =
                "middle";

            for (const layer of this.stack) {
                const series =
                    layer.series;
                const midpoint =
                    Math.floor(
                        this.times.length / 2
                    );
                const x =
                    this._xForTime(
                        this.times[midpoint]
                    );
                const y =
                    this._yForValue(
                        (
                            layer.lower[midpoint] +
                            layer.upper[midpoint]
                        ) /
                        2
                    );
                const height =
                    Math.abs(
                        this._yForValue(
                            layer.lower[midpoint]
                        ) -
                        this._yForValue(
                            layer.upper[midpoint]
                        )
                    );

                if (
                    height < 12 &&
                    series !== this.hovered &&
                    series !== this.selected
                ) {
                    continue;
                }

                this.context.fillStyle =
                    series === this.hovered ||
                    series === this.selected
                        ? this.options.highlight
                        : this.options.labelColor;
                this.context.globalAlpha =
                    0.86;
                this.context.textAlign =
                    "center";
                this.context.fillText(
                    this.options.showValues
                        ? `${series.name}: ${Number(
                            series.total.toPrecision(5)
                        )}`
                        : series.name,
                    x,
                    y
                );
            }

            this.context.restore();
        }

        _drawLegend() {
            const visible =
                this.series
                    .filter(
                        (series) =>
                            series.visible
                    )
                    .slice(0, 18);

            this.context.save();
            this.context.font =
                '10px "IBM Plex Mono", monospace';
            this.context.textBaseline =
                "middle";

            let x = this.plot.x;
            let y = 12;

            for (const series of visible) {
                this.context.fillStyle =
                    series.color;
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
                    series.name,
                    x,
                    y
                );

                x +=
                    this.context.measureText(
                        series.name
                    ).width +
                    18;

                if (
                    x >
                    this.bounds.width - 180
                ) {
                    x = this.plot.x;
                    y += 14;
                }
            }

            this.context.restore();
        }

        _drawBrush() {
            const x0 =
                Math.min(
                    this.brush.startX,
                    this.brush.endX
                );
            const x1 =
                Math.max(
                    this.brush.startX,
                    this.brush.endX
                );

            this.context.save();
            this.context.fillStyle =
                this.options.highlight;
            this.context.globalAlpha =
                0.12;
            this.context.fillRect(
                x0,
                this.plot.y,
                x1 - x0,
                this.plot.height
            );
            this.context.strokeStyle =
                this.options.highlight;
            this.context.globalAlpha =
                0.7;
            this.context.lineWidth = 1;
            this.context.strokeRect(
                x0,
                this.plot.y,
                x1 - x0,
                this.plot.height
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

        _seriesAt(x, y) {
            const time =
                this._timeForX(x);
            let nearestIndex = 0;
            let nearestDistance =
                Infinity;

            for (
                let index = 0;
                index < this.times.length;
                index += 1
            ) {
                const distance =
                    Math.abs(
                        this.times[index] -
                        time
                    );

                if (distance < nearestDistance) {
                    nearestDistance =
                        distance;
                    nearestIndex =
                        index;
                }
            }

            const value =
                this.domain.valueMax -
                (
                    y - this.plot.y
                ) /
                this.plot.height *
                (
                    this.domain.valueMax -
                    this.domain.valueMin
                );

            for (
                let index =
                    this.stack.length - 1;
                index >= 0;
                index -= 1
            ) {
                const layer =
                    this.stack[index];

                if (
                    value >= layer.lower[nearestIndex] &&
                    value <= layer.upper[nearestIndex]
                ) {
                    return {
                        series:
                            layer.series,
                        point:
                            layer.series.values[
                                nearestIndex
                            ],
                        index:
                            nearestIndex
                    };
                }
            }

            return null;
        }

        _handlePointerMove(event) {
            const point =
                this._pointFromEvent(event);

            if (this.drag?.pan) {
                this.transform.x =
                    this.drag.originX +
                    point.x -
                    this.drag.startX;
                this.metrics.pans += 1;
                this.draw();
                return;
            }

            if (this.brush) {
                this.brush.endX =
                    Math.max(
                        this.plot.x,
                        Math.min(
                            this.plot.x +
                            this.plot.width,
                            point.x
                        )
                    );
                this.draw();
                return;
            }

            const hit =
                this._seriesAt(
                    point.x,
                    point.y
                );
            const changed =
                hit?.series?.name !==
                this.hovered?.name;

            this.hovered =
                hit?.series || null;
            this.hoverPoint =
                hit?.point || null;
            this.canvas.style.cursor =
                this.hovered
                    ? "pointer"
                    : this.options.pannable
                        ? "grab"
                        : "default";

            if (changed) {
                this.draw();

                this._emit("hover", {
                    series:
                        this.hovered
                            ? this.describeSeries(
                                this.hovered
                            )
                            : null,
                    point:
                        this.hoverPoint
                            ? clone(
                                this.hoverPoint
                            )
                            : null
                });
            }
        }

        _handlePointerLeave() {
            this.drag = null;

            if (!this.brush && this.hovered) {
                this.hovered = null;
                this.hoverPoint = null;
                this.draw();
                this._emit("hover", {
                    series: null,
                    point: null
                });
            }
        }

        _handlePointerDown(event) {
            if (event.button !== 0) {
                return;
            }

            const point =
                this._pointFromEvent(event);

            if (
                this.options.brushable &&
                event.shiftKey &&
                point.x >= this.plot.x &&
                point.x <= this.plot.x +
                    this.plot.width &&
                point.y >= this.plot.y &&
                point.y <= this.plot.y +
                    this.plot.height
            ) {
                this.brush = {
                    startX: point.x,
                    endX: point.x
                };
            } else if (this.options.pannable) {
                this.drag = {
                    pan: true,
                    startX: point.x,
                    originX:
                        this.transform.x
                };
            }

            this.canvas.setPointerCapture?.(
                event.pointerId
            );
        }

        _handlePointerUp(event) {
            if (this.brush) {
                const startTime =
                    this._timeForX(
                        Math.min(
                            this.brush.startX,
                            this.brush.endX
                        )
                    );
                const endTime =
                    this._timeForX(
                        Math.max(
                            this.brush.startX,
                            this.brush.endX
                        )
                    );

                this.metrics.brushes += 1;

                this._emit("brush", {
                    startTime,
                    endTime,
                    start:
                        formatTime(startTime),
                    end:
                        formatTime(endTime)
                });
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
            const zoom =
                Math.max(
                    1,
                    Math.min(
                        32,
                        previousZoom *
                        factor
                    )
                );
            const world =
                (
                    point.x -
                    this.plot.x -
                    this.transform.x
                ) /
                previousZoom;

            this.transform.zoom = zoom;
            this.transform.x =
                point.x -
                this.plot.x -
                world *
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
                this.brush
            ) {
                return;
            }

            const point =
                this._pointFromEvent(event);
            const hit =
                this._seriesAt(
                    point.x,
                    point.y
                );

            this.selected =
                hit?.series?.name ===
                this.selected?.name
                    ? null
                    : hit?.series || null;
            this.metrics.selections += 1;
            this.draw();

            this._emit("select", {
                series:
                    this.selected
                        ? this.describeSeries(
                            this.selected
                        )
                        : null,
                point:
                    hit?.point
                        ? clone(hit.point)
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
                this.brush = null;
                this.draw();
            } else if (event.key === "ArrowLeft") {
                event.preventDefault();
                this.panBy(24);
            } else if (event.key === "ArrowRight") {
                event.preventDefault();
                this.panBy(-24);
            }
        }

        setZoom(value) {
            this.transform.zoom =
                Math.max(
                    1,
                    Math.min(
                        32,
                        parseNumber(
                            value,
                            this.transform.zoom
                        )
                    )
                );
            this.draw();
            return this.transform.zoom;
        }

        panBy(x) {
            this.transform.x +=
                Number(x) || 0;
            this.metrics.pans += 1;
            this.draw();

            return clone(
                this.transform
            );
        }

        resetView() {
            this.transform = {
                zoom: 1,
                x: 0
            };
            this.selected = null;
            this.brush = null;
            this.draw();

            return clone(
                this.transform
            );
        }

        setFilter(query = "") {
            this.query =
                String(query || "");
            this._applyFilter();
            this._buildStack();
            this._updateDomain();
            this.draw();

            this._emit("filter", {
                query:
                    this.query,
                visibleSeries:
                    this.series.filter(
                        (series) =>
                            series.visible
                    ).length
            });

            return this.query;
        }

        toggleSeries(name) {
            const key =
                String(name);
            const series =
                this.seriesMap.get(key);

            if (!series) {
                return null;
            }

            if (this.hiddenSeries.has(key)) {
                this.hiddenSeries.delete(key);
            } else {
                this.hiddenSeries.add(key);
            }

            this._applyFilter();
            this._buildStack();
            this._updateDomain();
            this.draw();

            return !this.hiddenSeries.has(key);
        }

        setBaseline(baseline) {
            if (
                ![
                    "zero",
                    "silhouette",
                    "wiggle"
                ].includes(baseline)
            ) {
                throw new Error(
                    `Unknown streamgraph baseline: ${baseline}`
                );
            }

            this.options.baseline =
                baseline;
            this._buildStack();
            this._updateDomain();
            this.draw();

            return baseline;
        }

        setOrder(order) {
            if (
                ![
                    "inside-out",
                    "ascending",
                    "descending",
                    "name",
                    "none"
                ].includes(order)
            ) {
                throw new Error(
                    `Unknown streamgraph order: ${order}`
                );
            }

            this.options.order =
                order;
            this._sortSeries();
            this._buildStack();
            this._updateDomain();
            this.draw();

            return order;
        }

        describeSeries(series) {
            if (!series) {
                return null;
            }

            return {
                name:
                    series.name,
                total:
                    series.total,
                maximum:
                    series.maximum,
                visible:
                    series.visible,
                color:
                    series.color,
                values:
                    series.values.map(
                        clone
                    )
            };
        }

        update(options = {}) {
            if (!isObject(options)) {
                throw new TypeError(
                    "StreamGraph options must be an object."
                );
            }

            const rebuildRequired = [
                "timeKey",
                "timeAccessor",
                "categoryKey",
                "categoryAccessor",
                "valueKey",
                "valueAccessor",
                "aggregation",
                "maxSeries",
                "maxPoints"
            ].some(
                (key) =>
                    options[key] !== undefined
            );

            Object.assign(
                this.options,
                {
                    timeKey:
                        options.timeKey !== undefined
                            ? options.timeKey
                            : this.options.timeKey,
                    timeAccessor:
                        options.timeAccessor !== undefined
                            ? options.timeAccessor
                            : this.options.timeAccessor,
                    categoryKey:
                        options.categoryKey !== undefined
                            ? options.categoryKey
                            : this.options.categoryKey,
                    categoryAccessor:
                        options.categoryAccessor !== undefined
                            ? options.categoryAccessor
                            : this.options.categoryAccessor,
                    valueKey:
                        options.valueKey !== undefined
                            ? options.valueKey
                            : this.options.valueKey,
                    valueAccessor:
                        options.valueAccessor !== undefined
                            ? options.valueAccessor
                            : this.options.valueAccessor,
                    aggregation:
                        options.aggregation ||
                        this.options.aggregation,
                    baseline:
                        options.baseline ||
                        this.options.baseline,
                    order:
                        options.order ||
                        this.options.order,
                    curve:
                        options.curve ||
                        this.options.curve,
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
                    showGrid:
                        options.showGrid !== undefined
                            ? Boolean(
                                options.showGrid
                            )
                            : this.options.showGrid,
                    showAxes:
                        options.showAxes !== undefined
                            ? Boolean(
                                options.showAxes
                            )
                            : this.options.showAxes,
                    showLabels:
                        options.showLabels !== undefined
                            ? Boolean(
                                options.showLabels
                            )
                            : this.options.showLabels,
                    showLegend:
                        options.showLegend !== undefined
                            ? Boolean(
                                options.showLegend
                            )
                            : this.options.showLegend,
                    showValues:
                        options.showValues !== undefined
                            ? Boolean(
                                options.showValues
                            )
                            : this.options.showValues,
                    maxSeries:
                        options.maxSeries !== undefined
                            ? parseNumber(
                                options.maxSeries,
                                this.options.maxSeries,
                                1,
                                10000
                            )
                            : this.options.maxSeries,
                    maxPoints:
                        options.maxPoints !== undefined
                            ? parseNumber(
                                options.maxPoints,
                                this.options.maxPoints,
                                2,
                                100000
                            )
                            : this.options.maxPoints
                }
            );

            if (rebuildRequired) {
                this.rebuild();
            } else {
                this._sortSeries();
                this._buildStack();
                this._updateDomain();
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
                        generatedAt:
                            iso(),
                        options:
                            this.options,
                        transform:
                            this.transform,
                        domain:
                            this.domain,
                        times:
                            this.times,
                        series:
                            this.series.map(
                                (series) =>
                                    this.describeSeries(
                                        series
                                    )
                            )
                    },
                    null,
                    2
                );
            }

            if (normalized === "csv") {
                const rows = [[
                    "time",
                    ...this.series.map(
                        (series) =>
                            series.name
                    )
                ]];

                for (
                    let index = 0;
                    index < this.times.length;
                    index += 1
                ) {
                    rows.push([
                        formatTime(
                            this.times[index]
                        ),
                        ...this.series.map(
                            (series) =>
                                series.values[index]
                                    ?.value ?? 0
                        )
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
                `Unsupported StreamGraph export format: ${format}`
            );
        }

        status() {
            return {
                name:
                    "streamgraph",
                module:
                    MODULE_NAME,
                records:
                    this.records.length,
                series:
                    this.series.length,
                visibleSeries:
                    this.series.filter(
                        (series) =>
                            series.visible
                    ).length,
                points:
                    this.times.length,
                baseline:
                    this.options.baseline,
                order:
                    this.options.order,
                curve:
                    this.options.curve,
                query:
                    this.query,
                hiddenSeries:
                    Array.from(
                        this.hiddenSeries
                    ),
                transform:
                    clone(
                        this.transform
                    ),
                brush:
                    this.brush
                        ? clone(this.brush)
                        : null,
                selected:
                    this.selected
                        ? this.describeSeries(
                            this.selected
                        )
                        : null,
                hovered:
                    this.hovered
                        ? this.describeSeries(
                            this.hovered
                        )
                        : null,
                options:
                    clone(
                        this.options
                    ),
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

            this.records = [];
            this.times = [];
            this.series = [];
            this.stack = [];
            this.seriesMap.clear();
            this.hiddenSeries.clear();
            this.destroyed = true;

            this._emit("destroy", {});
            return true;
        }
    }

    function mount(target, data = [], options = {}) {
        return new StreamGraphController(
            target,
            data,
            options
        );
    }

    function render(data = [], options = {}) {
        const container = createElement(
            "section",
            "terminal-visualization terminal-visualization-streamgraph"
        );
        container.dataset.visualization =
            "streamgraph";
        container.setAttribute(
            "role",
            "region"
        );
        container.setAttribute(
            "aria-label",
            options.label ||
            "StreamGraph visualization"
        );

        const canvas =
            document.createElement("canvas");
        canvas.className =
            "terminal-streamgraph-canvas";
        canvas.width =
            Number(options.width) ||
            DEFAULT_WIDTH;
        canvas.height =
            Number(options.height) ||
            DEFAULT_HEIGHT;
        canvas.setAttribute(
            "aria-label",
            options.label ||
            "StreamGraph visualization"
        );

        const status = createElement(
            "div",
            "terminal-streamgraph-status"
        );
        status.setAttribute(
            "aria-live",
            "polite"
        );

        const tooltip = createElement(
            "div",
            "terminal-streamgraph-tooltip"
        );
        tooltip.hidden = true;

        container.append(
            canvas,
            status,
            tooltip
        );

        const controller =
            new StreamGraphController(
                canvas,
                data,
                options
            );

        const updateStatus = () => {
            const snapshot =
                controller.status();

            status.textContent =
                `${snapshot.visibleSeries} of ${snapshot.series} series · ` +
                `${snapshot.points} point` +
                `${snapshot.points === 1 ? "" : "s"} · ` +
                `${snapshot.baseline} · ` +
                `${snapshot.transform.zoom.toFixed(2)}×`;
        };

        controller.addEventListener(
            "hover",
            (event) => {
                const series =
                    event.detail?.series;
                const point =
                    event.detail?.point;

                if (!series) {
                    tooltip.hidden = true;
                    return;
                }

                tooltip.hidden = false;
                tooltip.textContent =
                    point
                        ? (
                            `${series.name} · ${formatTime(point.time)} · ` +
                            `${point.value}`
                        )
                        : (
                            `${series.name} · ${series.total}`
                        );
            }
        );

        for (const eventName of [
            "data",
            "append",
            "resize",
            "zoom",
            "filter",
            "brush",
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
            controller.series;
        container.destroy = () =>
            controller.destroy();

        return container;
    }

    function initialize(context = {}) {
        const dataset =
            context.root?.dataset || {};
        const config =
            context.config?.streamgraph || {};

        const defaults = {
            timeKey:
                dataset.terminalStreamgraphTimeKey ||
                config.timeKey ||
                null,

            categoryKey:
                dataset.terminalStreamgraphCategoryKey ||
                config.categoryKey ||
                null,

            valueKey:
                dataset.terminalStreamgraphValueKey ||
                config.valueKey ||
                null,

            aggregation:
                dataset.terminalStreamgraphAggregation ||
                config.aggregation ||
                "sum",

            baseline:
                dataset.terminalStreamgraphBaseline ||
                config.baseline ||
                "wiggle",

            order:
                dataset.terminalStreamgraphOrder ||
                config.order ||
                "inside-out",

            curve:
                dataset.terminalStreamgraphCurve ||
                config.curve ||
                "smooth",

            background:
                dataset.terminalStreamgraphBackground ||
                config.background ||
                DEFAULT_BACKGROUND,

            foreground:
                dataset.terminalStreamgraphForeground ||
                config.foreground ||
                DEFAULT_FOREGROUND,

            highlight:
                dataset.terminalStreamgraphHighlight ||
                config.highlight ||
                DEFAULT_HIGHLIGHT,

            gridColor:
                dataset.terminalStreamgraphGrid ||
                config.gridColor ||
                DEFAULT_GRID,

            axisColor:
                dataset.terminalStreamgraphAxis ||
                config.axisColor ||
                DEFAULT_AXIS,

            labelColor:
                dataset.terminalStreamgraphLabelColor ||
                config.labelColor ||
                DEFAULT_LABEL,

            showGrid: parseBoolean(
                dataset.terminalStreamgraphShowGrid,
                config.showGrid !== false
            ),

            showAxes: parseBoolean(
                dataset.terminalStreamgraphShowAxes,
                config.showAxes !== false
            ),

            showLabels: parseBoolean(
                dataset.terminalStreamgraphShowLabels,
                config.showLabels !== false
            ),

            showLegend: parseBoolean(
                dataset.terminalStreamgraphShowLegend,
                config.showLegend !== false
            ),

            showValues: parseBoolean(
                dataset.terminalStreamgraphShowValues,
                config.showValues === true
            ),

            interactive: parseBoolean(
                dataset.terminalStreamgraphInteractive,
                config.interactive !== false
            )
        };

        const visualization = {
            mount(target, data = [], options = {}) {
                return new StreamGraphController(
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
                StreamGraphController,

            normalizeRecords,

            inferField,

            timeForRecord,

            categoryForRecord,

            valueForRecord
        };

        context.registerVisualization?.(
            "streamgraph",
            visualization
        );
        context.registerRenderer?.(
            "streamgraph",
            visualization
        );
        context.streamgraph =
            visualization;

        safeDispatch(
            document,
            "speciedex:terminal-streamgraph-ready",
            {
                visualization
            }
        );

        return visualization;
    }

    const commands = [{
        name: "streamgraph",
        category: "visualization",
        description:
            "Render and control an interactive stacked temporal streamgraph.",
        usage:
            "streamgraph [collection|status|baseline|order|filter|toggle|" +
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
                context.streamgraphController ||
                context.terminalStreamgraphController;

            try {
                if (controller) {
                    switch (lower) {
                        case "status":
                        case "show":
                        case "info":
                            return writeJSON(
                                controller.status()
                            );

                        case "baseline":
                            if (!args[1]) {
                                return writeJSON({
                                    baseline:
                                        controller.options.baseline
                                });
                            }

                            return writeJSON({
                                baseline:
                                    controller.setBaseline(
                                        args[1]
                                    )
                            });

                        case "order":
                            if (!args[1]) {
                                return writeJSON({
                                    order:
                                        controller.options.order
                                });
                            }

                            return writeJSON({
                                order:
                                    controller.setOrder(
                                        args[1]
                                    )
                            });

                        case "filter":
                            return writeJSON({
                                query:
                                    controller.setFilter(
                                        args.slice(1).join(" ")
                                    ),
                                status:
                                    controller.status()
                            });

                        case "toggle":
                            return writeJSON({
                                visible:
                                    controller.toggleSeries(
                                        args.slice(1).join(" ")
                                    ),
                                status:
                                    controller.status()
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
                        ...context.config?.streamgraph,
                        label:
                            `StreamGraph for ${collection}`
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
        StreamGraphController,
        normalizeRecords,
        inferField,
        timeForRecord,
        categoryForRecord,
        valueForRecord,
        mount,
        render,
        initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalStreamGraph =
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
