/*
========================================================================
Speciedex.org
Terminal Density Visualization
========================================================================

Canvas-based one-dimensional and grouped density renderer for Speciedex data.
Supports numeric field inference, weighted histograms, kernel-density
estimation, cumulative distributions, logarithmic scales, grouping, brushing,
zoom, selection, responsive rendering, exports, metrics, and lifecycle control.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Density";
    const DEFAULT_WIDTH = 960;
    const DEFAULT_HEIGHT = 540;
    const DEFAULT_PADDING = 48;
    const DEFAULT_BINS = 48;
    const DEFAULT_BANDWIDTH = 0;
    const DEFAULT_BACKGROUND = "#020a05";
    const DEFAULT_FOREGROUND = "#c0d674";
    const DEFAULT_HIGHLIGHT = "#eef7c8";
    const DEFAULT_GRID = "#1f3a27";
    const DEFAULT_AXIS = "#6f8a73";
    const DEFAULT_FILL_ALPHA = 0.28;
    const DEFAULT_LINE_WIDTH = 2;
    const MAX_RECORDS = 500000;
    const MAX_GROUPS = 32;

    const NUMERIC_FIELDS = Object.freeze([
        "value",
        "count",
        "weight",
        "score",
        "abundance",
        "frequency",
        "density",
        "latitude",
        "longitude",
        "elevation",
        "depth",
        "year",
        "age",
        "size",
        "length",
        "width",
        "height",
        "mass",
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
            const existing = target.querySelector("canvas");

            if (existing) {
                return existing;
            }

            const canvas = document.createElement("canvas");
            target.appendChild(canvas);
            return canvas;
        }

        throw new TypeError(
            "Density visualization requires a canvas or container element."
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
                "values",
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

    function inferNumericField(records) {
        const scores = new Map();

        for (const field of NUMERIC_FIELDS) {
            scores.set(field, 0);
        }

        for (const record of records.slice(0, 5000)) {
            if (!isObject(record)) {
                continue;
            }

            for (const [key, value] of Object.entries(record)) {
                if (Number.isFinite(Number(value))) {
                    scores.set(key, (scores.get(key) || 0) + 1);
                }
            }
        }

        return Array.from(scores.entries())
            .sort((left, right) => {
                const priorityLeft = NUMERIC_FIELDS.indexOf(left[0]);
                const priorityRight = NUMERIC_FIELDS.indexOf(right[0]);
                const normalizedLeft =
                    priorityLeft === -1 ? 999 : priorityLeft;
                const normalizedRight =
                    priorityRight === -1 ? 999 : priorityRight;

                return (
                    right[1] - left[1] ||
                    normalizedLeft - normalizedRight ||
                    left[0].localeCompare(right[0])
                );
            })
            .find(([, score]) => score > 0)?.[0] || null;
    }

    function extractValue(record, index, options = {}) {
        if (typeof options.accessor === "function") {
            const value = Number(options.accessor(record, index));
            return Number.isFinite(value) ? value : null;
        }

        if (typeof record === "number") {
            return Number.isFinite(record) ? record : null;
        }

        if (typeof record === "string") {
            const value = Number(record);
            return Number.isFinite(value) ? value : null;
        }

        if (!isObject(record)) {
            return null;
        }

        const field = options.field;

        if (field) {
            const value = Number(record[field]);
            return Number.isFinite(value) ? value : null;
        }

        for (const key of NUMERIC_FIELDS) {
            const value = Number(record[key]);

            if (Number.isFinite(value)) {
                return value;
            }
        }

        return null;
    }

    function extractWeight(record, index, options = {}) {
        if (typeof options.weight === "function") {
            const value = Number(options.weight(record, index));
            return Number.isFinite(value) ? value : 1;
        }

        if (isObject(record) && options.weightKey) {
            const value = Number(record[options.weightKey]);

            if (Number.isFinite(value)) {
                return value;
            }
        }

        return 1;
    }

    function extractGroup(record, options = {}) {
        if (typeof options.group === "function") {
            return String(options.group(record) ?? "all");
        }

        if (isObject(record) && options.groupKey) {
            return String(record[options.groupKey] ?? "unclassified");
        }

        return "all";
    }

    function quantile(sortedValues, probability) {
        if (!sortedValues.length) {
            return 0;
        }

        const position =
            (sortedValues.length - 1) *
            Math.max(0, Math.min(1, probability));
        const lower = Math.floor(position);
        const upper = Math.ceil(position);

        if (lower === upper) {
            return sortedValues[lower];
        }

        const fraction = position - lower;

        return (
            sortedValues[lower] *
            (1 - fraction) +
            sortedValues[upper] *
            fraction
        );
    }

    function summaryStatistics(samples) {
        if (!samples.length) {
            return {
                count: 0,
                weight: 0,
                minimum: null,
                maximum: null,
                mean: null,
                median: null,
                variance: null,
                standardDeviation: null,
                q1: null,
                q3: null,
                iqr: null
            };
        }

        const values = samples
            .map((sample) => sample.value)
            .sort((left, right) => left - right);
        const totalWeight = samples.reduce(
            (total, sample) => total + sample.weight,
            0
        );
        const weightedSum = samples.reduce(
            (total, sample) =>
                total + sample.value * sample.weight,
            0
        );
        const mean = totalWeight
            ? weightedSum / totalWeight
            : 0;
        const variance = totalWeight
            ? samples.reduce(
                (total, sample) =>
                    total +
                    sample.weight *
                    Math.pow(sample.value - mean, 2),
                0
            ) / totalWeight
            : 0;
        const q1 = quantile(values, 0.25);
        const q3 = quantile(values, 0.75);

        return {
            count: samples.length,
            weight: totalWeight,
            minimum: values[0],
            maximum: values[values.length - 1],
            mean,
            median: quantile(values, 0.5),
            variance,
            standardDeviation: Math.sqrt(variance),
            q1,
            q3,
            iqr: q3 - q1
        };
    }

    function silvermanBandwidth(samples, statistics) {
        if (samples.length < 2) {
            return 1;
        }

        const sigma =
            statistics.standardDeviation || 0;
        const robust =
            statistics.iqr > 0
                ? statistics.iqr / 1.34
                : sigma;
        const scale = Math.min(
            sigma || robust || 1,
            robust || sigma || 1
        );

        return Math.max(
            1e-9,
            0.9 *
            scale *
            Math.pow(samples.length, -1 / 5)
        );
    }

    function kernelValue(type, distance) {
        const absolute = Math.abs(distance);

        switch (type) {
            case "epanechnikov":
                return absolute <= 1
                    ? 0.75 * (1 - distance * distance)
                    : 0;

            case "triangular":
                return absolute <= 1
                    ? 1 - absolute
                    : 0;

            case "uniform":
                return absolute <= 1 ? 0.5 : 0;

            case "cosine":
                return absolute <= 1
                    ? Math.PI / 4 *
                      Math.cos(Math.PI * distance / 2)
                    : 0;

            case "gaussian":
            default:
                return (
                    Math.exp(-0.5 * distance * distance) /
                    Math.sqrt(2 * Math.PI)
                );
        }
    }

    function colorHash(value) {
        let hash = 0;

        for (const character of String(value || "")) {
            hash = ((hash << 5) - hash) + character.charCodeAt(0);
            hash |= 0;
        }

        return `hsl(${Math.abs(hash) % 360} 55% 60%)`;
    }

    class DensityController extends EventTarget {
        constructor(target, data = [], options = {}) {
            super();

            this.canvas = resolveCanvas(target);
            this.context = this.canvas.getContext("2d", {
                alpha: true,
                desynchronized: true
            });

            if (!this.context) {
                throw new Error(
                    "Unable to acquire Density 2D canvas context."
                );
            }

            this.options = {
                field: options.field || null,
                accessor: options.accessor,
                weightKey: options.weightKey || null,
                weight: options.weight,
                groupKey: options.groupKey || null,
                group: options.group,
                bins: parseNumber(
                    options.bins,
                    DEFAULT_BINS,
                    4,
                    512
                ),
                bandwidth: parseNumber(
                    options.bandwidth,
                    DEFAULT_BANDWIDTH,
                    0,
                    Number.MAX_SAFE_INTEGER
                ),
                kernel: [
                    "gaussian",
                    "epanechnikov",
                    "triangular",
                    "uniform",
                    "cosine"
                ].includes(options.kernel)
                    ? options.kernel
                    : "gaussian",
                mode: [
                    "histogram",
                    "kde",
                    "combined",
                    "cdf"
                ].includes(options.mode)
                    ? options.mode
                    : "combined",
                normalization: [
                    "count",
                    "probability",
                    "density",
                    "percent"
                ].includes(options.normalization)
                    ? options.normalization
                    : "density",
                scale: options.scale === "log"
                    ? "log"
                    : "linear",
                cumulative: options.cumulative === true,
                stacked: options.stacked === true,
                padding: parseNumber(
                    options.padding,
                    DEFAULT_PADDING,
                    16,
                    200
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
                fillAlpha: parseNumber(
                    options.fillAlpha,
                    DEFAULT_FILL_ALPHA,
                    0,
                    1
                ),
                lineWidth: parseNumber(
                    options.lineWidth,
                    DEFAULT_LINE_WIDTH,
                    0.5,
                    12
                ),
                showGrid:
                    options.showGrid !== false,
                showAxes:
                    options.showAxes !== false,
                showLegend:
                    options.showLegend !== false,
                showStatistics:
                    options.showStatistics !== false,
                showRug:
                    options.showRug === true,
                interactive:
                    options.interactive !== false,
                brushable:
                    options.brushable !== false,
                zoomable:
                    options.zoomable !== false,
                label:
                    options.label ||
                    "Density visualization"
            };

            this.records = [];
            this.samples = [];
            this.groups = new Map();
            this.histograms = new Map();
            this.curves = new Map();
            this.statistics = null;
            this.domain = {
                minimum: 0,
                maximum: 1
            };
            this.viewDomain = {
                minimum: 0,
                maximum: 1
            };
            this.yDomain = {
                minimum: 0,
                maximum: 1
            };
            this.layout = {
                width: 1,
                height: 1,
                plotX: 0,
                plotY: 0,
                plotWidth: 1,
                plotHeight: 1
            };
            this.hovered = null;
            this.selection = null;
            this.brush = null;
            this.destroyed = false;
            this.lastError = null;
            this.metrics = {
                inputRecords: 0,
                samples: 0,
                rejected: 0,
                groups: 0,
                rebuilds: 0,
                draws: 0,
                resizes: 0,
                zooms: 0,
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

            this.metrics.resizes += 1;
            this.draw();

            this._emit("resize", {
                width: this.layout.width,
                height: this.layout.height
            });
        }

        setData(data) {
            try {
                this.records =
                    normalizeRecords(data);

                if (
                    !this.options.field &&
                    !this.options.accessor
                ) {
                    this.options.field =
                        inferNumericField(
                            this.records
                        );
                }

                this._extractSamples();
                this.rebuild();
                this.draw();

                this._emit("data", {
                    records:
                        this.records.length,
                    samples:
                        this.samples.length,
                    field:
                        this.options.field
                });
            } catch (error) {
                this._recordError(error);
            }

            return this;
        }

        append(data) {
            const records =
                normalizeRecords(data);

            this.records.push(...records);

            if (
                this.records.length >
                MAX_RECORDS
            ) {
                this.records.splice(
                    0,
                    this.records.length -
                    MAX_RECORDS
                );
            }

            this._extractSamples();
            this.rebuild();
            this.draw();

            this._emit("append", {
                added: records.length,
                records:
                    this.records.length
            });

            return records.length;
        }

        _extractSamples() {
            this.samples = [];
            this.groups.clear();

            let rejected = 0;

            this.records.forEach(
                (record, index) => {
                    const value = extractValue(
                        record,
                        index,
                        this.options
                    );

                    if (value === null) {
                        rejected += 1;
                        return;
                    }

                    const sample = {
                        value,
                        weight:
                            extractWeight(
                                record,
                                index,
                                this.options
                            ),
                        group:
                            extractGroup(
                                record,
                                this.options
                            ),
                        record,
                        index
                    };

                    this.samples.push(sample);

                    if (
                        !this.groups.has(
                            sample.group
                        )
                    ) {
                        if (
                            this.groups.size >=
                            MAX_GROUPS
                        ) {
                            sample.group =
                                "other";
                        }

                        if (
                            !this.groups.has(
                                sample.group
                            )
                        ) {
                            this.groups.set(
                                sample.group,
                                []
                            );
                        }
                    }

                    this.groups
                        .get(sample.group)
                        .push(sample);
                }
            );

            this.statistics =
                summaryStatistics(
                    this.samples
                );
            this.metrics.inputRecords =
                this.records.length;
            this.metrics.samples =
                this.samples.length;
            this.metrics.rejected =
                rejected;
            this.metrics.groups =
                this.groups.size;
        }

        rebuild() {
            if (!this.samples.length) {
                this.histograms.clear();
                this.curves.clear();
                this.domain = {
                    minimum: 0,
                    maximum: 1
                };
                this.viewDomain = {
                    minimum: 0,
                    maximum: 1
                };
                this.yDomain = {
                    minimum: 0,
                    maximum: 1
                };
                return;
            }

            let minimum =
                this.statistics.minimum;
            let maximum =
                this.statistics.maximum;

            if (minimum === maximum) {
                minimum -= 0.5;
                maximum += 0.5;
            }

            const span = maximum - minimum;
            const margin = span * 0.02;

            this.domain = {
                minimum:
                    minimum - margin,
                maximum:
                    maximum + margin
            };

            if (
                !this.viewDomain ||
                !Number.isFinite(
                    this.viewDomain.minimum
                )
            ) {
                this.viewDomain =
                    clone(this.domain);
            } else {
                this.viewDomain.minimum =
                    Math.max(
                        this.domain.minimum,
                        this.viewDomain.minimum
                    );
                this.viewDomain.maximum =
                    Math.min(
                        this.domain.maximum,
                        this.viewDomain.maximum
                    );

                if (
                    this.viewDomain.minimum >=
                    this.viewDomain.maximum
                ) {
                    this.viewDomain =
                        clone(this.domain);
                }
            }

            this._buildHistograms();
            this._buildCurves();
            this._computeYDomain();
            this.metrics.rebuilds += 1;
        }

        _buildHistograms() {
            this.histograms.clear();

            const minimum =
                this.domain.minimum;
            const maximum =
                this.domain.maximum;
            const span =
                maximum - minimum;
            const binWidth =
                span / this.options.bins;

            for (
                const [group, samples]
                of this.groups
            ) {
                const bins =
                    Array.from(
                        {
                            length:
                                this.options.bins
                        },
                        (_, index) => ({
                            index,
                            start:
                                minimum +
                                index *
                                binWidth,
                            end:
                                minimum +
                                (index + 1) *
                                binWidth,
                            center:
                                minimum +
                                (index + 0.5) *
                                binWidth,
                            count: 0,
                            weight: 0,
                            value: 0,
                            samples: []
                        })
                    );

                for (const sample of samples) {
                    const index = Math.max(
                        0,
                        Math.min(
                            bins.length - 1,
                            Math.floor(
                                (
                                    sample.value -
                                    minimum
                                ) /
                                span *
                                bins.length
                            )
                        )
                    );
                    const bin =
                        bins[index];

                    bin.count += 1;
                    bin.weight +=
                        sample.weight;

                    if (
                        bin.samples.length < 100
                    ) {
                        bin.samples.push(
                            sample
                        );
                    }
                }

                const totalWeight =
                    samples.reduce(
                        (
                            total,
                            sample
                        ) =>
                            total +
                            sample.weight,
                        0
                    );

                let cumulative = 0;

                for (const bin of bins) {
                    switch (
                        this.options.normalization
                    ) {
                        case "probability":
                            bin.value =
                                totalWeight
                                    ? bin.weight /
                                      totalWeight
                                    : 0;
                            break;

                        case "percent":
                            bin.value =
                                totalWeight
                                    ? (
                                        bin.weight /
                                        totalWeight
                                      ) *
                                      100
                                    : 0;
                            break;

                        case "density":
                            bin.value =
                                totalWeight &&
                                binWidth
                                    ? bin.weight /
                                      (
                                          totalWeight *
                                          binWidth
                                      )
                                    : 0;
                            break;

                        case "count":
                        default:
                            bin.value =
                                bin.weight;
                            break;
                    }

                    cumulative +=
                        bin.value;

                    if (
                        this.options.cumulative ||
                        this.options.mode ===
                        "cdf"
                    ) {
                        bin.value =
                            cumulative;
                    }
                }

                this.histograms.set(
                    group,
                    {
                        group,
                        bins,
                        binWidth,
                        totalWeight
                    }
                );
            }
        }

        _buildCurves() {
            this.curves.clear();

            const points = Math.max(
                128,
                this.options.bins * 4
            );
            const minimum =
                this.domain.minimum;
            const maximum =
                this.domain.maximum;
            const span =
                maximum - minimum;

            for (
                const [group, samples]
                of this.groups
            ) {
                const statistics =
                    summaryStatistics(
                        samples
                    );
                const bandwidth =
                    this.options.bandwidth > 0
                        ? this.options.bandwidth
                        : silvermanBandwidth(
                            samples,
                            statistics
                        );
                const totalWeight =
                    samples.reduce(
                        (
                            total,
                            sample
                        ) =>
                            total +
                            sample.weight,
                        0
                    );
                const curve = [];

                for (
                    let index = 0;
                    index < points;
                    index += 1
                ) {
                    const x =
                        minimum +
                        (
                            index /
                            (points - 1)
                        ) *
                        span;
                    let density = 0;

                    for (
                        const sample
                        of samples
                    ) {
                        density +=
                            sample.weight *
                            kernelValue(
                                this.options.kernel,
                                (
                                    x -
                                    sample.value
                                ) /
                                bandwidth
                            );
                    }

                    density =
                        totalWeight &&
                        bandwidth
                            ? density /
                              (
                                  totalWeight *
                                  bandwidth
                              )
                            : 0;

                    curve.push({
                        x,
                        y: density
                    });
                }

                if (
                    this.options.mode ===
                    "cdf"
                ) {
                    let cumulative = 0;
                    const step =
                        span /
                        Math.max(
                            1,
                            points - 1
                        );

                    for (
                        const point of curve
                    ) {
                        cumulative +=
                            point.y * step;
                        point.y =
                            cumulative;
                    }
                }

                this.curves.set(
                    group,
                    {
                        group,
                        bandwidth,
                        statistics,
                        points: curve
                    }
                );
            }
        }

        _computeYDomain() {
            let maximum = 0;

            if (
                this.options.mode ===
                "histogram" ||
                this.options.mode ===
                "combined" ||
                this.options.mode ===
                "cdf"
            ) {
                for (
                    const histogram
                    of this.histograms.values()
                ) {
                    for (
                        const bin
                        of histogram.bins
                    ) {
                        maximum = Math.max(
                            maximum,
                            bin.value
                        );
                    }
                }
            }

            if (
                this.options.mode ===
                "kde" ||
                this.options.mode ===
                "combined" ||
                this.options.mode ===
                "cdf"
            ) {
                for (
                    const curve
                    of this.curves.values()
                ) {
                    for (
                        const point
                        of curve.points
                    ) {
                        maximum = Math.max(
                            maximum,
                            point.y
                        );
                    }
                }
            }

            this.yDomain = {
                minimum: 0,
                maximum:
                    maximum > 0
                        ? maximum * 1.08
                        : 1
            };
        }

        _xToPixel(value) {
            const ratio =
                (
                    value -
                    this.viewDomain.minimum
                ) /
                (
                    this.viewDomain.maximum -
                    this.viewDomain.minimum
                );

            return (
                this.layout.plotX +
                ratio *
                this.layout.plotWidth
            );
        }

        _pixelToX(pixel) {
            const ratio =
                (
                    pixel -
                    this.layout.plotX
                ) /
                this.layout.plotWidth;

            return (
                this.viewDomain.minimum +
                ratio *
                (
                    this.viewDomain.maximum -
                    this.viewDomain.minimum
                )
            );
        }

        _yToPixel(value) {
            let normalized =
                value /
                this.yDomain.maximum;

            if (
                this.options.scale ===
                "log"
            ) {
                normalized =
                    Math.log1p(
                        value
                    ) /
                    Math.log1p(
                        this.yDomain.maximum
                    );
            }

            return (
                this.layout.plotY +
                this.layout.plotHeight *
                (1 - normalized)
            );
        }

        draw() {
            if (this.destroyed) {
                return;
            }

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

            if (!this.samples.length) {
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
                    "No numeric density data.",
                    this.layout.width / 2,
                    this.layout.height / 2
                );
                this.context.globalAlpha = 1;
                this.metrics.draws += 1;
                return;
            }

            if (this.options.showGrid) {
                this._drawGrid();
            }

            if (
                this.options.mode ===
                "histogram" ||
                this.options.mode ===
                "combined" ||
                this.options.mode ===
                "cdf"
            ) {
                this._drawHistograms();
            }

            if (
                this.options.mode ===
                "kde" ||
                this.options.mode ===
                "combined" ||
                this.options.mode ===
                "cdf"
            ) {
                this._drawCurves();
            }

            if (this.options.showRug) {
                this._drawRug();
            }

            if (this.options.showAxes) {
                this._drawAxes();
            }

            if (
                this.options.showStatistics
            ) {
                this._drawStatistics();
            }

            if (this.options.showLegend) {
                this._drawLegend();
            }

            if (this.brush) {
                this._drawBrush();
            }

            if (this.hovered) {
                this._drawHover();
            }

            this.metrics.draws += 1;
        }

        _drawGrid() {
            this.context.save();
            this.context.strokeStyle =
                this.options.gridColor;
            this.context.globalAlpha =
                0.25;
            this.context.lineWidth = 1;

            const verticalLines = 10;
            const horizontalLines = 8;

            for (
                let index = 0;
                index <= verticalLines;
                index += 1
            ) {
                const x =
                    this.layout.plotX +
                    (
                        index /
                        verticalLines
                    ) *
                    this.layout.plotWidth;
                this.context.beginPath();
                this.context.moveTo(
                    x,
                    this.layout.plotY
                );
                this.context.lineTo(
                    x,
                    this.layout.plotY +
                    this.layout.plotHeight
                );
                this.context.stroke();
            }

            for (
                let index = 0;
                index <= horizontalLines;
                index += 1
            ) {
                const y =
                    this.layout.plotY +
                    (
                        index /
                        horizontalLines
                    ) *
                    this.layout.plotHeight;
                this.context.beginPath();
                this.context.moveTo(
                    this.layout.plotX,
                    y
                );
                this.context.lineTo(
                    this.layout.plotX +
                    this.layout.plotWidth,
                    y
                );
                this.context.stroke();
            }

            this.context.restore();
        }

        _drawHistograms() {
            const groupCount =
                Math.max(
                    1,
                    this.histograms.size
                );
            let groupIndex = 0;

            for (
                const [group, histogram]
                of this.histograms
            ) {
                const color =
                    group === "all"
                        ? this.options.foreground
                        : colorHash(group);
                const barOffset =
                    this.options.stacked
                        ? 0
                        : groupIndex /
                          groupCount;
                const barWidthRatio =
                    this.options.stacked
                        ? 1
                        : 1 /
                          groupCount;

                for (
                    const bin
                    of histogram.bins
                ) {
                    if (
                        bin.end <
                            this.viewDomain.minimum ||
                        bin.start >
                            this.viewDomain.maximum
                    ) {
                        continue;
                    }

                    const x1 =
                        this._xToPixel(
                            Math.max(
                                bin.start,
                                this.viewDomain.minimum
                            )
                        );
                    const x2 =
                        this._xToPixel(
                            Math.min(
                                bin.end,
                                this.viewDomain.maximum
                            )
                        );
                    const fullWidth =
                        Math.max(
                            1,
                            x2 - x1
                        );
                    const x =
                        x1 +
                        fullWidth *
                        barOffset;
                    const width =
                        fullWidth *
                        barWidthRatio;
                    const y =
                        this._yToPixel(
                            bin.value
                        );
                    const height =
                        this.layout.plotY +
                        this.layout.plotHeight -
                        y;

                    this.context.fillStyle =
                        color;
                    this.context.globalAlpha =
                        this.options.fillAlpha;
                    this.context.fillRect(
                        x + 0.5,
                        y,
                        Math.max(
                            0,
                            width - 1
                        ),
                        height
                    );

                    this.context.strokeStyle =
                        color;
                    this.context.globalAlpha =
                        0.72;
                    this.context.lineWidth =
                        1;
                    this.context.strokeRect(
                        x + 0.5,
                        y,
                        Math.max(
                            0,
                            width - 1
                        ),
                        height
                    );
                }

                groupIndex += 1;
            }

            this.context.globalAlpha = 1;
        }

        _drawCurves() {
            for (
                const [group, curve]
                of this.curves
            ) {
                const color =
                    group === "all"
                        ? this.options.highlight
                        : colorHash(group);

                this.context.save();
                this.context.strokeStyle =
                    color;
                this.context.lineWidth =
                    this.options.lineWidth;
                this.context.globalAlpha =
                    0.95;
                this.context.beginPath();

                let started = false;

                for (
                    const point
                    of curve.points
                ) {
                    if (
                        point.x <
                            this.viewDomain.minimum ||
                        point.x >
                            this.viewDomain.maximum
                    ) {
                        continue;
                    }

                    const x =
                        this._xToPixel(
                            point.x
                        );
                    const y =
                        this._yToPixel(
                            point.y
                        );

                    if (!started) {
                        this.context.moveTo(
                            x,
                            y
                        );
                        started = true;
                    } else {
                        this.context.lineTo(
                            x,
                            y
                        );
                    }
                }

                this.context.stroke();
                this.context.restore();
            }
        }

        _drawRug() {
            this.context.save();

            for (const sample of this.samples) {
                if (
                    sample.value <
                        this.viewDomain.minimum ||
                    sample.value >
                        this.viewDomain.maximum
                ) {
                    continue;
                }

                this.context.strokeStyle =
                    sample.group === "all"
                        ? this.options.foreground
                        : colorHash(
                            sample.group
                        );
                this.context.globalAlpha =
                    0.2;
                const x =
                    this._xToPixel(
                        sample.value
                    );
                const y =
                    this.layout.plotY +
                    this.layout.plotHeight;

                this.context.beginPath();
                this.context.moveTo(
                    x,
                    y
                );
                this.context.lineTo(
                    x,
                    y - 7
                );
                this.context.stroke();
            }

            this.context.restore();
        }

        _drawAxes() {
            const left =
                this.layout.plotX;
            const right =
                this.layout.plotX +
                this.layout.plotWidth;
            const top =
                this.layout.plotY;
            const bottom =
                this.layout.plotY +
                this.layout.plotHeight;

            this.context.save();
            this.context.strokeStyle =
                this.options.axisColor;
            this.context.fillStyle =
                this.options.axisColor;
            this.context.globalAlpha =
                0.92;
            this.context.lineWidth = 1;
            this.context.font =
                '10px "IBM Plex Mono", monospace';
            this.context.textBaseline =
                "top";

            this.context.beginPath();
            this.context.moveTo(
                left,
                top
            );
            this.context.lineTo(
                left,
                bottom
            );
            this.context.lineTo(
                right,
                bottom
            );
            this.context.stroke();

            const ticks = 8;

            for (
                let index = 0;
                index <= ticks;
                index += 1
            ) {
                const ratio =
                    index / ticks;
                const value =
                    this.viewDomain.minimum +
                    ratio *
                    (
                        this.viewDomain.maximum -
                        this.viewDomain.minimum
                    );
                const x =
                    left +
                    ratio *
                    this.layout.plotWidth;

                this.context.beginPath();
                this.context.moveTo(
                    x,
                    bottom
                );
                this.context.lineTo(
                    x,
                    bottom + 4
                );
                this.context.stroke();

                this.context.textAlign =
                    index === 0
                        ? "left"
                        : index === ticks
                            ? "right"
                            : "center";
                this.context.fillText(
                    Number(
                        value.toPrecision(4)
                    ).toString(),
                    x,
                    bottom + 6
                );
            }

            this.context.restore();
        }

        _drawStatistics() {
            const statistics =
                this.statistics;

            if (
                !statistics ||
                statistics.count === 0
            ) {
                return;
            }

            const text = [
                `n=${statistics.count}`,
                `mean=${Number(statistics.mean.toPrecision(5))}`,
                `median=${Number(statistics.median.toPrecision(5))}`,
                `σ=${Number(statistics.standardDeviation.toPrecision(5))}`
            ].join("  ");

            this.context.save();
            this.context.fillStyle =
                this.options.foreground;
            this.context.globalAlpha =
                0.82;
            this.context.font =
                '11px "IBM Plex Mono", monospace';
            this.context.textAlign =
                "left";
            this.context.textBaseline =
                "top";
            this.context.fillText(
                text,
                this.layout.plotX,
                12
            );
            this.context.restore();
        }

        _drawLegend() {
            if (
                this.groups.size <= 1
            ) {
                return;
            }

            this.context.save();
            this.context.font =
                '10px "IBM Plex Mono", monospace';
            this.context.textBaseline =
                "middle";

            let x =
                this.layout.plotX;
            const y =
                this.layout.height - 14;

            for (
                const group
                of this.groups.keys()
            ) {
                const color =
                    group === "all"
                        ? this.options.foreground
                        : colorHash(group);

                this.context.fillStyle =
                    color;
                this.context.globalAlpha =
                    0.9;
                this.context.fillRect(
                    x,
                    y - 4,
                    8,
                    8
                );
                x += 12;
                this.context.fillText(
                    group,
                    x,
                    y
                );
                x +=
                    this.context.measureText(
                        group
                    ).width +
                    16;
            }

            this.context.restore();
        }

        _drawBrush() {
            const start = Math.min(
                this.brush.startX,
                this.brush.currentX
            );
            const end = Math.max(
                this.brush.startX,
                this.brush.currentX
            );

            this.context.save();
            this.context.fillStyle =
                this.options.highlight;
            this.context.globalAlpha =
                0.14;
            this.context.fillRect(
                start,
                this.layout.plotY,
                end - start,
                this.layout.plotHeight
            );
            this.context.strokeStyle =
                this.options.highlight;
            this.context.globalAlpha =
                0.8;
            this.context.strokeRect(
                start,
                this.layout.plotY,
                end - start,
                this.layout.plotHeight
            );
            this.context.restore();
        }

        _drawHover() {
            const x =
                this._xToPixel(
                    this.hovered.value
                );

            this.context.save();
            this.context.strokeStyle =
                this.options.highlight;
            this.context.globalAlpha =
                0.9;
            this.context.setLineDash(
                [4, 4]
            );
            this.context.beginPath();
            this.context.moveTo(
                x,
                this.layout.plotY
            );
            this.context.lineTo(
                x,
                this.layout.plotY +
                this.layout.plotHeight
            );
            this.context.stroke();
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

        _nearestValue(x) {
            if (
                x < this.layout.plotX ||
                x >
                    this.layout.plotX +
                    this.layout.plotWidth
            ) {
                return null;
            }

            const value =
                this._pixelToX(x);
            let nearest = null;
            let distance = Infinity;

            for (
                const sample
                of this.samples
            ) {
                const current =
                    Math.abs(
                        sample.value -
                        value
                    );

                if (current < distance) {
                    distance = current;
                    nearest = sample;
                }
            }

            return nearest
                ? {
                    value:
                        nearest.value,
                    weight:
                        nearest.weight,
                    group:
                        nearest.group,
                    record:
                        clone(nearest.record)
                }
                : null;
        }

        _handlePointerMove(event) {
            const point =
                this._pointFromEvent(event);

            if (this.brush) {
                this.brush.currentX =
                    Math.max(
                        this.layout.plotX,
                        Math.min(
                            this.layout.plotX +
                            this.layout.plotWidth,
                            point.x
                        )
                    );
                this.draw();
                return;
            }

            const hovered =
                this._nearestValue(
                    point.x
                );
            const changed =
                hovered?.value !==
                this.hovered?.value;

            this.hovered = hovered;

            if (changed) {
                this.draw();

                this._emit("hover", {
                    sample:
                        hovered
                            ? clone(hovered)
                            : null
                });
            }
        }

        _handlePointerLeave() {
            if (this.brush) {
                return;
            }

            if (this.hovered) {
                this.hovered = null;
                this.draw();
                this._emit("hover", {
                    sample: null
                });
            }
        }

        _handlePointerDown(event) {
            if (
                !this.options.brushable ||
                event.button !== 0
            ) {
                return;
            }

            const point =
                this._pointFromEvent(event);

            if (
                point.x <
                    this.layout.plotX ||
                point.x >
                    this.layout.plotX +
                    this.layout.plotWidth ||
                point.y <
                    this.layout.plotY ||
                point.y >
                    this.layout.plotY +
                    this.layout.plotHeight
            ) {
                return;
            }

            this.brush = {
                startX:
                    point.x,
                currentX:
                    point.x
            };

            this.canvas.setPointerCapture?.(
                event.pointerId
            );
            this.draw();
        }

        _handlePointerUp(event) {
            if (!this.brush) {
                return;
            }

            this.canvas.releasePointerCapture?.(
                event.pointerId
            );

            const startX = Math.min(
                this.brush.startX,
                this.brush.currentX
            );
            const endX = Math.max(
                this.brush.startX,
                this.brush.currentX
            );
            const start =
                this._pixelToX(startX);
            const end =
                this._pixelToX(endX);

            this.brush = null;

            if (endX - startX >= 4) {
                this.selection = {
                    minimum: start,
                    maximum: end
                };
                this.metrics.selections += 1;

                this._emit("select", {
                    selection:
                        clone(this.selection),
                    samples:
                        this.samples
                            .filter(
                                (sample) =>
                                    sample.value >=
                                        start &&
                                    sample.value <=
                                        end
                            )
                            .map((sample) => ({
                                value:
                                    sample.value,
                                weight:
                                    sample.weight,
                                group:
                                    sample.group,
                                record:
                                    clone(
                                        sample.record
                                    )
                            }))
                });
            }

            this.draw();
        }

        _handleWheel(event) {
            if (!this.options.zoomable) {
                return;
            }

            const point =
                this._pointFromEvent(event);

            if (
                point.x <
                    this.layout.plotX ||
                point.x >
                    this.layout.plotX +
                    this.layout.plotWidth
            ) {
                return;
            }

            event.preventDefault();

            const anchor =
                this._pixelToX(
                    point.x
                );
            const currentSpan =
                this.viewDomain.maximum -
                this.viewDomain.minimum;
            const factor =
                event.deltaY < 0
                    ? 0.82
                    : 1.22;
            const newSpan = Math.max(
                (
                    this.domain.maximum -
                    this.domain.minimum
                ) /
                1000,
                Math.min(
                    this.domain.maximum -
                    this.domain.minimum,
                    currentSpan *
                    factor
                )
            );
            const ratio =
                (
                    anchor -
                    this.viewDomain.minimum
                ) /
                currentSpan;
            let minimum =
                anchor -
                newSpan *
                ratio;
            let maximum =
                minimum +
                newSpan;

            if (
                minimum <
                this.domain.minimum
            ) {
                maximum +=
                    this.domain.minimum -
                    minimum;
                minimum =
                    this.domain.minimum;
            }

            if (
                maximum >
                this.domain.maximum
            ) {
                minimum -=
                    maximum -
                    this.domain.maximum;
                maximum =
                    this.domain.maximum;
            }

            this.viewDomain = {
                minimum,
                maximum
            };
            this.metrics.zooms += 1;
            this.draw();

            this._emit("zoom", {
                domain:
                    clone(this.viewDomain)
            });
        }

        _handleKeydown(event) {
            if (
                event.key === "0" ||
                event.key === "Home"
            ) {
                event.preventDefault();
                this.resetView();
            } else if (
                event.key === "+" ||
                event.key === "="
            ) {
                event.preventDefault();
                this.zoom(0.8);
            } else if (
                event.key === "-"
            ) {
                event.preventDefault();
                this.zoom(1.25);
            } else if (
                event.key === "Escape"
            ) {
                this.selection = null;
                this.draw();
            }
        }

        zoom(factor) {
            const center =
                (
                    this.viewDomain.minimum +
                    this.viewDomain.maximum
                ) /
                2;
            const span = Math.max(
                (
                    this.domain.maximum -
                    this.domain.minimum
                ) /
                1000,
                Math.min(
                    this.domain.maximum -
                    this.domain.minimum,
                    (
                        this.viewDomain.maximum -
                        this.viewDomain.minimum
                    ) *
                    factor
                )
            );

            this.viewDomain = {
                minimum:
                    Math.max(
                        this.domain.minimum,
                        center - span / 2
                    ),
                maximum:
                    Math.min(
                        this.domain.maximum,
                        center + span / 2
                    )
            };
            this.draw();

            return clone(
                this.viewDomain
            );
        }

        resetView() {
            this.viewDomain =
                clone(this.domain);
            this.selection = null;
            this.draw();

            this._emit("resetView", {
                domain:
                    clone(this.viewDomain)
            });

            return clone(
                this.viewDomain
            );
        }

        setMode(mode) {
            if (
                ![
                    "histogram",
                    "kde",
                    "combined",
                    "cdf"
                ].includes(mode)
            ) {
                throw new Error(
                    `Unknown density mode: ${mode}`
                );
            }

            this.options.mode = mode;
            this.rebuild();
            this.draw();

            return mode;
        }

        update(options = {}) {
            if (!isObject(options)) {
                throw new TypeError(
                    "Density options must be an object."
                );
            }

            const rebuildRequired = [
                "field",
                "accessor",
                "weightKey",
                "weight",
                "groupKey",
                "group",
                "bins",
                "bandwidth",
                "kernel",
                "mode",
                "normalization",
                "cumulative"
            ].some(
                (key) =>
                    options[key] !== undefined
            );

            Object.assign(
                this.options,
                {
                    field:
                        options.field !== undefined
                            ? options.field
                            : this.options.field,
                    accessor:
                        options.accessor !== undefined
                            ? options.accessor
                            : this.options.accessor,
                    weightKey:
                        options.weightKey !== undefined
                            ? options.weightKey
                            : this.options.weightKey,
                    weight:
                        options.weight !== undefined
                            ? options.weight
                            : this.options.weight,
                    groupKey:
                        options.groupKey !== undefined
                            ? options.groupKey
                            : this.options.groupKey,
                    group:
                        options.group !== undefined
                            ? options.group
                            : this.options.group,
                    bins:
                        options.bins !== undefined
                            ? parseNumber(
                                options.bins,
                                this.options.bins,
                                4,
                                512
                            )
                            : this.options.bins,
                    bandwidth:
                        options.bandwidth !== undefined
                            ? parseNumber(
                                options.bandwidth,
                                this.options.bandwidth,
                                0,
                                Number.MAX_SAFE_INTEGER
                            )
                            : this.options.bandwidth,
                    kernel:
                        options.kernel ||
                        this.options.kernel,
                    mode:
                        options.mode ||
                        this.options.mode,
                    normalization:
                        options.normalization ||
                        this.options.normalization,
                    scale:
                        options.scale ||
                        this.options.scale,
                    cumulative:
                        options.cumulative !== undefined
                            ? Boolean(
                                options.cumulative
                            )
                            : this.options.cumulative,
                    stacked:
                        options.stacked !== undefined
                            ? Boolean(
                                options.stacked
                            )
                            : this.options.stacked,
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
                    fillAlpha:
                        options.fillAlpha !== undefined
                            ? parseNumber(
                                options.fillAlpha,
                                this.options.fillAlpha,
                                0,
                                1
                            )
                            : this.options.fillAlpha,
                    lineWidth:
                        options.lineWidth !== undefined
                            ? parseNumber(
                                options.lineWidth,
                                this.options.lineWidth,
                                0.5,
                                12
                            )
                            : this.options.lineWidth,
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
                    showLegend:
                        options.showLegend !== undefined
                            ? Boolean(
                                options.showLegend
                            )
                            : this.options.showLegend,
                    showStatistics:
                        options.showStatistics !== undefined
                            ? Boolean(
                                options.showStatistics
                            )
                            : this.options.showStatistics,
                    showRug:
                        options.showRug !== undefined
                            ? Boolean(
                                options.showRug
                            )
                            : this.options.showRug
                }
            );

            if (rebuildRequired) {
                this._extractSamples();
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
                        field:
                            this.options.field,
                        options:
                            this.options,
                        statistics:
                            this.statistics,
                        domain:
                            this.domain,
                        viewDomain:
                            this.viewDomain,
                        histograms:
                            Array.from(
                                this.histograms.values()
                            ),
                        curves:
                            Array.from(
                                this.curves.values()
                            )
                    },
                    null,
                    2
                );
            }

            if (normalized === "csv") {
                const rows = [[
                    "group",
                    "bin",
                    "start",
                    "end",
                    "center",
                    "count",
                    "weight",
                    "value"
                ]];

                for (
                    const [
                        group,
                        histogram
                    ]
                    of this.histograms
                ) {
                    for (
                        const bin
                        of histogram.bins
                    ) {
                        rows.push([
                            group,
                            bin.index,
                            bin.start,
                            bin.end,
                            bin.center,
                            bin.count,
                            bin.weight,
                            bin.value
                        ]);
                    }
                }

                return rows
                    .map(
                        (row) =>
                            row
                                .map(
                                    (value) => {
                                        const text =
                                            String(
                                                value ??
                                                ""
                                            );

                                        return /[",\n\r]/.test(
                                            text
                                        )
                                            ? `"${text.replace(
                                                /"/g,
                                                '""'
                                            )}"`
                                            : text;
                                    }
                                )
                                .join(",")
                    )
                    .join("\r\n");
            }

            throw new Error(
                `Unsupported Density export format: ${format}`
            );
        }

        status() {
            return {
                name: "density",
                module: MODULE_NAME,
                records:
                    this.records.length,
                samples:
                    this.samples.length,
                groups:
                    this.groups.size,
                field:
                    this.options.field,
                mode:
                    this.options.mode,
                domain:
                    clone(this.domain),
                viewDomain:
                    clone(
                        this.viewDomain
                    ),
                yDomain:
                    clone(this.yDomain),
                statistics:
                    clone(
                        this.statistics
                    ),
                selection:
                    clone(
                        this.selection
                    ),
                hovered:
                    clone(this.hovered),
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
                    "keydown",
                    this._boundKeydown
                );
            }

            this.records = [];
            this.samples = [];
            this.groups.clear();
            this.histograms.clear();
            this.curves.clear();
            this.destroyed = true;
            this._emit("destroy", {});
            return true;
        }
    }

    function mount(target, data = [], options = {}) {
        return new DensityController(
            target,
            data,
            options
        );
    }

    function render(data = [], options = {}) {
        const container = createElement(
            "section",
            "terminal-visualization terminal-visualization-density"
        );
        container.dataset.visualization =
            "density";
        container.setAttribute(
            "role",
            "region"
        );
        container.setAttribute(
            "aria-label",
            options.label ||
            "Density visualization"
        );

        const canvas =
            document.createElement("canvas");
        canvas.className =
            "terminal-density-canvas";
        canvas.width =
            Number(options.width) ||
            DEFAULT_WIDTH;
        canvas.height =
            Number(options.height) ||
            DEFAULT_HEIGHT;
        canvas.setAttribute(
            "aria-label",
            options.label ||
            "Density visualization"
        );

        const status = createElement(
            "div",
            "terminal-density-status"
        );
        status.setAttribute(
            "aria-live",
            "polite"
        );

        const tooltip = createElement(
            "div",
            "terminal-density-tooltip"
        );
        tooltip.hidden = true;

        container.append(
            canvas,
            status,
            tooltip
        );

        const controller =
            new DensityController(
                canvas,
                data,
                options
            );

        const updateStatus = () => {
            const snapshot =
                controller.status();

            status.textContent =
                `${snapshot.samples} numeric sample` +
                `${snapshot.samples === 1 ? "" : "s"} · ` +
                `${snapshot.groups} group` +
                `${snapshot.groups === 1 ? "" : "s"} · ` +
                `${snapshot.mode}` +
                (
                    snapshot.field
                        ? ` · ${snapshot.field}`
                        : ""
                );
        };

        controller.addEventListener(
            "hover",
            (event) => {
                const sample =
                    event.detail?.sample;

                if (!sample) {
                    tooltip.hidden = true;
                    return;
                }

                tooltip.hidden = false;
                tooltip.textContent =
                    `${sample.value} · ` +
                    `${sample.group} · ` +
                    `weight ${sample.weight}`;
            }
        );

        for (const eventName of [
            "data",
            "append",
            "resize",
            "zoom",
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
            controller.samples;
        container.destroy = () =>
            controller.destroy();

        return container;
    }

    function initialize(context = {}) {
        const dataset =
            context.root?.dataset || {};
        const config =
            context.config?.density || {};

        const defaults = {
            field:
                dataset.terminalDensityField ||
                config.field ||
                null,

            weightKey:
                dataset.terminalDensityWeightKey ||
                config.weightKey ||
                null,

            groupKey:
                dataset.terminalDensityGroupKey ||
                config.groupKey ||
                null,

            bins:
                dataset.terminalDensityBins ||
                config.bins ||
                DEFAULT_BINS,

            bandwidth:
                dataset.terminalDensityBandwidth ||
                config.bandwidth ||
                DEFAULT_BANDWIDTH,

            kernel:
                dataset.terminalDensityKernel ||
                config.kernel ||
                "gaussian",

            mode:
                dataset.terminalDensityMode ||
                config.mode ||
                "combined",

            normalization:
                dataset.terminalDensityNormalization ||
                config.normalization ||
                "density",

            scale:
                dataset.terminalDensityScale ||
                config.scale ||
                "linear",

            background:
                dataset.terminalDensityBackground ||
                config.background ||
                DEFAULT_BACKGROUND,

            foreground:
                dataset.terminalDensityForeground ||
                config.foreground ||
                DEFAULT_FOREGROUND,

            highlight:
                dataset.terminalDensityHighlight ||
                config.highlight ||
                DEFAULT_HIGHLIGHT,

            gridColor:
                dataset.terminalDensityGrid ||
                config.gridColor ||
                DEFAULT_GRID,

            axisColor:
                dataset.terminalDensityAxis ||
                config.axisColor ||
                DEFAULT_AXIS,

            showGrid: parseBoolean(
                dataset.terminalDensityShowGrid,
                config.showGrid !== false
            ),

            showAxes: parseBoolean(
                dataset.terminalDensityShowAxes,
                config.showAxes !== false
            ),

            showLegend: parseBoolean(
                dataset.terminalDensityShowLegend,
                config.showLegend !== false
            ),

            showStatistics: parseBoolean(
                dataset.terminalDensityShowStatistics,
                config.showStatistics !== false
            ),

            interactive: parseBoolean(
                dataset.terminalDensityInteractive,
                config.interactive !== false
            )
        };

        const visualization = {
            mount(target, data = [], options = {}) {
                return new DensityController(
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
                DensityController,

            normalizeRecords,

            inferNumericField,

            summaryStatistics
        };

        context.registerVisualization?.(
            "density",
            visualization
        );
        context.registerRenderer?.(
            "density",
            visualization
        );
        context.density =
            visualization;

        safeDispatch(
            document,
            "speciedex:terminal-density-ready",
            {
                visualization
            }
        );

        return visualization;
    }

    const commands = [{
        name: "density",
        category: "visualization",
        description:
            "Render and control weighted histograms and kernel-density estimates.",
        usage:
            "density [collection|status|mode|field|bins|bandwidth|zoom|" +
            "reset|export] [arguments]",
        handler: ({
            args = [],
            context,
            writeJSON,
            write,
            writeError
        }) => {
            const action = String(
                args[0] || "records"
            );
            const lower =
                action.toLowerCase();
            const controller =
                context.densityController ||
                context.terminalDensityController;

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

                        case "field":
                            if (!args[1]) {
                                return writeJSON({
                                    field:
                                        controller.options.field
                                });
                            }

                            controller.update({
                                field: args[1]
                            });

                            return writeJSON({
                                field:
                                    controller.options.field
                            });

                        case "bins":
                            if (!args[1]) {
                                return writeJSON({
                                    bins:
                                        controller.options.bins
                                });
                            }

                            controller.update({
                                bins: args[1]
                            });

                            return writeJSON({
                                bins:
                                    controller.options.bins
                            });

                        case "bandwidth":
                            if (!args[1]) {
                                return writeJSON({
                                    bandwidth:
                                        controller.options.bandwidth
                                });
                            }

                            controller.update({
                                bandwidth:
                                    args[1]
                            });

                            return writeJSON({
                                bandwidth:
                                    controller.options.bandwidth
                            });

                        case "zoom":
                            return writeJSON({
                                domain:
                                    controller.zoom(
                                        args[1] ||
                                        0.8
                                    )
                            });

                        case "reset":
                            return writeJSON({
                                domain:
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
                        ...context.config?.density,
                        label:
                            `Density for ${collection}`
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
        DensityController,
        normalizeRecords,
        inferNumericField,
        summaryStatistics,
        kernelValue,
        mount,
        render,
        initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalDensity =
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
