/*
========================================================================
Speciedex.org
Terminal TimeSlider Visualization
========================================================================

Interactive temporal range controller for Speciedex records. Supports automatic
timestamp inference, single-point and range selection, playback, stepping,
looping, speed control, brushing, snapping, histogram density, keyboard
controls, responsive high-DPI rendering, JSON, CSV, and PNG export,
diagnostics, runtime updates, and lifecycle control.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "time-slider";
    const VERSION = "3.0.0";

    const VISUALIZATION_SYMBOL =
        Symbol.for("speciedex.terminal.time-slider.visualization");

    const CONTROLLER_SYMBOL =
        Symbol.for("speciedex.terminal.time-slider.controller");
    const DEFAULT_WIDTH = 960;
    const DEFAULT_HEIGHT = 220;
    const DEFAULT_BACKGROUND = "#020a05";
    const DEFAULT_FOREGROUND = "#c0d674";
    const DEFAULT_HIGHLIGHT = "#eef7c8";
    const DEFAULT_GRID = "#1f3a27";
    const DEFAULT_AXIS = "#35503a";
    const DEFAULT_TRACK = "#173322";
    const DEFAULT_SELECTION = "#c0d674";
    const DEFAULT_PADDING = Object.freeze({
        top: 28,
        right: 28,
        bottom: 46,
        left: 62
    });
    const DEFAULT_HANDLE_RADIUS = 7;
    const DEFAULT_MAX_RECORDS = 250000;
    const DEFAULT_BUCKETS = 120;
    const DEFAULT_ASYNC_BATCH = 4096;
    const DEFAULT_QUERY_LIMIT = 5000;
    const DEFAULT_FIT_PADDING = 0;

    const TIME_FIELDS = Object.freeze([
        "timestamp",
        "time",
        "date",
        "datetime",
        "observed_at",
        "observedAt",
        "event_date",
        "eventDate",
        "created_at",
        "createdAt",
        "updated_at",
        "updatedAt",
        "year",
        "month"
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
        message = "TimeSlider operation aborted."
    ) {
        const error = new Error(message);
        error.name = "AbortError";
        error.code = "TIME_SLIDER_ABORTED";
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
            "TimeSlider requires a canvas or container element."
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
            return data.slice(0, DEFAULT_MAX_RECORDS);
        }

        if (isObject(data)) {
            for (const key of [
                "records",
                "results",
                "items",
                "events",
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
            return parseTime(
                record[options.timeKey],
                index
            );
        }

        if (!isObject(record)) {
            return parseTime(record, index);
        }

        return parseTime(
            firstValue(
                record,
                TIME_FIELDS,
                index
            ),
            index
        );
    }

    function labelForRecord(record, index) {
        if (!isObject(record)) {
            return String(record ?? `Event ${index + 1}`);
        }

        return String(firstValue(record, [
            "scientific_name",
            "scientificName",
            "canonical_name",
            "canonicalName",
            "name",
            "label",
            "title",
            "id"
        ], `Event ${index + 1}`));
    }

    function weightForRecord(record) {
        if (!isObject(record)) {
            return 1;
        }

        for (const key of [
            "weight",
            "value",
            "count",
            "score",
            "abundance"
        ]) {
            const value = Number(record[key]);

            if (Number.isFinite(value)) {
                return Math.max(0.01, value);
            }
        }

        return 1;
    }

    function formatTime(value, mode = "auto") {
        if (!Number.isFinite(value)) {
            return "";
        }

        if (mode === "raw") {
            return String(value);
        }

        if (mode === "year") {
            return new Date(value).getUTCFullYear().toString();
        }

        if (value >= 1e11) {
            return new Date(value).toISOString();
        }

        return String(value);
    }

    function escapeCsv(value) {
        let text = String(value ?? "");

        if (/^[=+\-@\t\r]/.test(text)) {
            text = `'${text}`;
        }

        return /[",\n\r]/.test(text)
            ? `"${text.replace(/"/g, '""')}"`
            : text;
    }

    class TimeSliderController extends EventTarget {
        constructor(target, data = [], options = {}) {
            super();

            this.canvas = resolveCanvas(target);
            this.context = this.canvas.getContext("2d", {
                alpha: true,
                desynchronized: true
            });

            if (!this.context) {
                throw new Error(
                    "Unable to acquire TimeSlider 2D canvas context."
                );
            }

            this.options = {
                timeKey:
                    options.timeKey || null,
                timeAccessor:
                    options.timeAccessor,
                mode:
                    options.mode === "point"
                        ? "point"
                        : "range",
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
                trackColor:
                    options.trackColor ||
                    DEFAULT_TRACK,
                selectionColor:
                    options.selectionColor ||
                    DEFAULT_SELECTION,
                padding: {
                    ...DEFAULT_PADDING,
                    ...(isObject(options.padding)
                        ? options.padding
                        : {})
                },
                handleRadius: parseNumber(
                    options.handleRadius,
                    DEFAULT_HANDLE_RADIUS,
                    3,
                    24
                ),
                buckets: Math.floor(parseNumber(
                    options.buckets,
                    DEFAULT_BUCKETS,
                    8,
                    1000
                )),
                showHistogram:
                    options.showHistogram !== false,
                showGrid:
                    options.showGrid !== false,
                showAxis:
                    options.showAxis !== false,
                showLabels:
                    options.showLabels !== false,
                showSelection:
                    options.showSelection !== false,
                showCurrent:
                    options.showCurrent !== false,
                snap:
                    options.snap !== false,
                loop:
                    options.loop !== false,
                autoplay:
                    options.autoplay === true,
                direction:
                    options.direction === "reverse"
                        ? "reverse"
                        : "forward",
                speed: parseNumber(
                    options.speed,
                    1,
                    0.01,
                    1024
                ),
                step: parseNumber(
                    options.step,
                    1,
                    0.000001,
                    1e15
                ),
                interval: parseNumber(
                    options.interval,
                    1000,
                    16,
                    60000
                ),
                format:
                    options.format || "auto",
                interactive:
                    options.interactive !== false,
                zoomable:
                    options.zoomable !== false,
                pannable:
                    options.pannable !== false,
                label:
                    options.label ||
                    "TimeSlider visualization"
            };

            this.records = [];
            this.events = [];
            this.times = [];
            this.histogram = [];
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
                minimum: 0,
                maximum: 1
            };
            this.view = {
                minimum: 0,
                maximum: 1
            };
            this.selection = {
                start: 0,
                end: 1
            };
            this.current = 0;
            this.playing = false;
            this.paused = false;
            this.animationFrame = 0;
            this.lastFrameAt = 0;
            this.drag = null;
            this.hovered = null;
            this.destroyed = false;
            this.lastError = null;
            this.emitting = false;
            this.pointerMoved = false;
            this.lastWidth = 0;
            this.lastHeight = 0;
            this.abortController = new AbortController();
            this.metrics = {
                inputRecords: 0,
                acceptedRecords: 0,
                rejectedRecords: 0,
                events: 0,
                uniqueTimes: 0,
                buckets: 0,
                draws: 0,
                frames: 0,
                plays: 0,
                pauses: 0,
                seeks: 0,
                steps: 0,
                ranges: 0,
                zooms: 0,
                pans: 0,
                resizes: 0,
                skippedResizes: 0,
                snapSearches: 0,
                errors: 0,
                asyncLoads: 0,
                asyncYields: 0,
                asyncRecords: 0,
                hitTests: 0,
                fits: 0,
                eventQueries: 0,
                bucketQueries: 0,
                nearestQueries: 0,
                summaryQueries: 0
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
            this.canvas.timeSliderController = this;

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

            if (this.options.autoplay) {
                this.play();
            }
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
                        `time-slider:${type}`,
                        event
                    );
                } catch (observerError) {
                    window.console?.warn?.(
                        "[SpeciedexTerminalTimeSlider] Event observer failed:",
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

            this.plot.x = this.options.padding.left;
            this.plot.y = this.options.padding.top;
            this.plot.width = Math.max(
                1,
                this.bounds.width -
                this.options.padding.left -
                this.options.padding.right
            );
            this.plot.height = Math.max(
                1,
                this.bounds.height -
                this.options.padding.top -
                this.options.padding.bottom
            );

            this.metrics.resizes += 1;
            this.draw();

            this._emit("resize", clone(this.bounds));
            return true;
        }

        setData(data) {
            try {
                this.records = normalizeRecords(data);

                if (!this.options.timeAccessor) {
                    const timeKeyStillValid =
                        this.options.timeKey &&
                        this.records.some(
                            record =>
                                isObject(record) &&
                                record[this.options.timeKey] !== undefined
                        );

                    if (!timeKeyStillValid) {
                        this.options.timeKey =
                            inferField(
                                this.records,
                                TIME_FIELDS
                            );
                    }
                }

                this.events = [];
                let accepted = 0;
                let rejected = 0;

                this.records.forEach((record, index) => {
                    const time =
                        timeForRecord(
                            record,
                            index,
                            this.options
                        );

                    if (!Number.isFinite(time)) {
                        rejected += 1;
                        return;
                    }

                    this.events.push({
                        id:
                            String(
                                firstValue(
                                    record,
                                    [
                                        "id",
                                        "key",
                                        "uuid",
                                        "taxon_id",
                                        "taxonId"
                                    ],
                                    `event-${index + 1}`
                                )
                            ),
                        label:
                            labelForRecord(
                                record,
                                index
                            ),
                        time,
                        weight:
                            weightForRecord(record),
                        raw:
                            clone(record)
                    });

                    accepted += 1;
                });

                this.events.sort(
                    (left, right) =>
                        left.time -
                        right.time
                );
                this.times =
                    Array.from(
                        new Set(
                            this.events.map(
                                (event) =>
                                    event.time
                            )
                        )
                    );

                const minimum =
                    this.times.length
                        ? this.times[0]
                        : 0;
                const maximum =
                    this.times.length
                        ? this.times[
                            this.times.length - 1
                        ]
                        : 1;

                this.domain.minimum =
                    minimum;
                this.domain.maximum =
                    maximum === minimum
                        ? minimum + 1
                        : maximum;
                this.view = {
                    minimum:
                        this.domain.minimum,
                    maximum:
                        this.domain.maximum
                };
                this.selection = {
                    start:
                        this.domain.minimum,
                    end:
                        this.domain.maximum
                };
                this.current =
                    this.options.direction === "reverse"
                        ? this.domain.maximum
                        : this.domain.minimum;

                this._buildHistogram();

                this.metrics.inputRecords =
                    this.records.length;
                this.metrics.acceptedRecords =
                    accepted;
                this.metrics.rejectedRecords =
                    rejected;
                this.metrics.events =
                    this.events.length;
                this.metrics.uniqueTimes =
                    this.times.length;
                this.metrics.buckets =
                    this.histogram.length;

                this.draw();

                this._emit("data", {
                    records:
                        this.records.length,
                    events:
                        this.events.length,
                    minimum:
                        this.domain.minimum,
                    maximum:
                        this.domain.maximum
                });
            } catch (error) {
                this._recordError(error);
            }

            return this;
        }

        async setDataAsync(data, options = {}) {
            if (this.destroyed) {
                throw new Error(
                    "TimeSlider controller has been destroyed."
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

                this.records = staged;

                if (!this.options.timeAccessor) {
                    const validTimeKey =
                        this.options.timeKey &&
                        this.records.some(
                            record =>
                                isObject(record) &&
                                record[this.options.timeKey] !== undefined
                        );

                    if (!validTimeKey) {
                        this.options.timeKey =
                            inferField(
                                this.records,
                                TIME_FIELDS
                            );
                    }
                }

                this.events = [];
                let accepted = 0;
                let rejected = 0;

                for (
                    let index = 0;
                    index < this.records.length;
                    index += 1
                ) {
                    throwIfAborted(signal);

                    const record = this.records[index];
                    const time = timeForRecord(
                        record,
                        index,
                        this.options
                    );

                    if (!Number.isFinite(time)) {
                        rejected += 1;
                        continue;
                    }

                    this.events.push({
                        id: String(
                            firstValue(
                                record,
                                [
                                    "id",
                                    "key",
                                    "uuid",
                                    "taxon_id",
                                    "taxonId"
                                ],
                                `event-${index + 1}`
                            )
                        ),
                        label:
                            labelForRecord(
                                record,
                                index
                            ),
                        time,
                        weight:
                            weightForRecord(record),
                        raw:
                            clone(record)
                    });

                    accepted += 1;

                    if (
                        index > 0 &&
                        index % batchSize === 0
                    ) {
                        this.metrics.asyncYields += 1;
                        await nextFrame(signal);
                    }
                }

                this.events.sort(
                    (left, right) =>
                        left.time - right.time
                );

                this.times = Array.from(
                    new Set(
                        this.events.map(
                            event => event.time
                        )
                    )
                );

                const minimum =
                    this.times.length
                        ? this.times[0]
                        : 0;

                const maximum =
                    this.times.length
                        ? this.times[
                            this.times.length - 1
                        ]
                        : 1;

                this.domain.minimum = minimum;
                this.domain.maximum =
                    maximum === minimum
                        ? minimum + 1
                        : maximum;

                this.view = {
                    minimum: this.domain.minimum,
                    maximum: this.domain.maximum
                };

                this.selection = {
                    start: this.domain.minimum,
                    end: this.domain.maximum
                };

                this.current =
                    this.options.direction === "reverse"
                        ? this.domain.maximum
                        : this.domain.minimum;

                this._buildHistogram();

                this.metrics.inputRecords =
                    this.records.length;
                this.metrics.acceptedRecords =
                    accepted;
                this.metrics.rejectedRecords =
                    rejected;
                this.metrics.events =
                    this.events.length;
                this.metrics.uniqueTimes =
                    this.times.length;
                this.metrics.buckets =
                    this.histogram.length;
                this.metrics.asyncLoads += 1;

                this.draw();

                const result = {
                    records: this.records.length,
                    events: this.events.length,
                    accepted,
                    rejected,
                    minimum: this.domain.minimum,
                    maximum: this.domain.maximum,
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
            const padding = parseNumber(
                options.padding,
                DEFAULT_FIT_PADDING,
                0,
                Math.max(0, this.plot.width / 2)
            );

            const span =
                this.domain.maximum -
                this.domain.minimum;

            const ratio =
                this.plot.width > 0
                    ? padding / this.plot.width
                    : 0;

            this.view = {
                minimum:
                    this.domain.minimum -
                    span * ratio,
                maximum:
                    this.domain.maximum +
                    span * ratio
            };

            this.metrics.fits += 1;
            this.draw();

            this._emit("fit", {
                view: clone(this.view),
                padding
            });

            return clone(this.view);
        }

        eventsInRange(
            start = this.selection.start,
            end = this.selection.end,
            options = {}
        ) {
            const minimum = Math.min(
                parseTime(start),
                parseTime(end)
            );

            const maximum = Math.max(
                parseTime(start),
                parseTime(end)
            );

            if (
                !Number.isFinite(minimum) ||
                !Number.isFinite(maximum)
            ) {
                throw new TypeError(
                    "TimeSlider range query requires valid times."
                );
            }

            const limit = Math.floor(
                parseNumber(
                    options.limit,
                    DEFAULT_QUERY_LIMIT,
                    1,
                    DEFAULT_MAX_RECORDS
                )
            );

            const matches = this.events.filter(
                event =>
                    event.time >= minimum &&
                    event.time <= maximum
            );

            this.metrics.eventQueries += 1;

            return {
                start: minimum,
                end: maximum,
                formattedStart:
                    formatTime(
                        minimum,
                        this.options.format
                    ),
                formattedEnd:
                    formatTime(
                        maximum,
                        this.options.format
                    ),
                total: matches.length,
                returned: Math.min(
                    matches.length,
                    limit
                ),
                truncated:
                    matches.length > limit,
                events:
                    matches
                        .slice(0, limit)
                        .map(event => ({
                            id: event.id,
                            label: event.label,
                            time: event.time,
                            formatted:
                                formatTime(
                                    event.time,
                                    this.options.format
                                ),
                            weight: event.weight,
                            raw: clone(event.raw)
                        }))
            };
        }

        nearestEvents(time, limit = 10) {
            const value = parseTime(time);

            if (!Number.isFinite(value)) {
                throw new TypeError(
                    "TimeSlider nearest query requires a valid time."
                );
            }

            const maximum = Math.floor(
                parseNumber(
                    limit,
                    10,
                    1,
                    DEFAULT_QUERY_LIMIT
                )
            );

            this.metrics.nearestQueries += 1;

            return this.events
                .map(event => ({
                    distance:
                        Math.abs(event.time - value),
                    event: {
                        id: event.id,
                        label: event.label,
                        time: event.time,
                        formatted:
                            formatTime(
                                event.time,
                                this.options.format
                            ),
                        weight: event.weight,
                        raw: clone(event.raw)
                    }
                }))
                .sort(
                    (left, right) =>
                        left.distance - right.distance
                )
                .slice(0, maximum);
        }

        bucketSummary(index = null) {
            if (index !== null && index !== undefined) {
                const bucket = this.histogram[
                    Math.floor(
                        parseNumber(
                            index,
                            -1,
                            0,
                            Math.max(
                                0,
                                this.histogram.length - 1
                            )
                        )
                    )
                ];

                if (!bucket) {
                    return null;
                }

                this.metrics.bucketQueries += 1;

                return {
                    index: bucket.index,
                    start: bucket.start,
                    end: bucket.end,
                    formattedStart:
                        formatTime(
                            bucket.start,
                            this.options.format
                        ),
                    formattedEnd:
                        formatTime(
                            bucket.end,
                            this.options.format
                        ),
                    count: bucket.count,
                    weight: bucket.weight,
                    normalized:
                        bucket.normalized,
                    events:
                        bucket.events.map(event => ({
                            id: event.id,
                            label: event.label,
                            time: event.time,
                            weight: event.weight
                        }))
                };
            }

            this.metrics.bucketQueries += 1;

            return this.histogram.map(bucket => ({
                index: bucket.index,
                start: bucket.start,
                end: bucket.end,
                count: bucket.count,
                weight: bucket.weight,
                normalized: bucket.normalized
            }));
        }

        summary() {
            const selected = this.events.filter(
                event =>
                    event.time >=
                        this.selection.start &&
                    event.time <=
                        this.selection.end
            );

            const totalWeight = selected.reduce(
                (sum, event) =>
                    sum + event.weight,
                0
            );

            this.metrics.summaryQueries += 1;

            return {
                records: this.records.length,
                events: this.events.length,
                uniqueTimes: this.times.length,
                domain: clone(this.domain),
                view: clone(this.view),
                selection: clone(this.selection),
                selectedEvents: selected.length,
                selectedWeight: totalWeight,
                current: this.current,
                formattedCurrent:
                    formatTime(
                        this.current,
                        this.options.format
                    ),
                nearest:
                    this.nearestEvents(
                        this.current,
                        Math.min(
                            10,
                            this.events.length || 1
                        )
                    ),
                playing:
                    this.playing &&
                    !this.paused,
                paused: this.paused,
                speed: this.options.speed,
                direction:
                    this.options.direction,
                mode: this.options.mode
            };
        }

        append(data) {
            const records = normalizeRecords(data);

            this.records.push(...records);

            if (
                this.records.length >
                DEFAULT_MAX_RECORDS
            ) {
                this.records.splice(
                    0,
                    this.records.length -
                    DEFAULT_MAX_RECORDS
                );
            }

            this.setData(this.records);

            this._emit("append", {
                added: records.length
            });

            return records.length;
        }

        _buildHistogram() {
            const count =
                this.options.buckets;
            const span =
                this.domain.maximum -
                this.domain.minimum;
            const buckets =
                Array.from(
                    { length: count },
                    (_, index) => ({
                        index,
                        start:
                            this.domain.minimum +
                            span *
                            index /
                            count,
                        end:
                            this.domain.minimum +
                            span *
                            (
                                index + 1
                            ) /
                            count,
                        count: 0,
                        weight: 0,
                        events: []
                    })
                );

            for (const event of this.events) {
                const ratio =
                    span
                        ? (
                            event.time -
                            this.domain.minimum
                        ) /
                        span
                        : 0;
                const index =
                    Math.max(
                        0,
                        Math.min(
                            count - 1,
                            Math.floor(
                                ratio *
                                count
                            )
                        )
                    );
                const bucket =
                    buckets[index];

                bucket.count += 1;
                bucket.weight +=
                    event.weight;

                if (
                    bucket.events.length <
                    100
                ) {
                    bucket.events.push(
                        event
                    );
                }
            }

            const maximum =
                buckets.reduce(
                    (largest, bucket) =>
                        Math.max(
                            largest,
                            bucket.weight
                        ),
                    1
                );

            this.histogram =
                buckets.map((bucket) => ({
                    ...bucket,
                    normalized:
                        bucket.weight /
                        maximum
                }));
        }

        _xForTime(time) {
            const ratio =
                (
                    time -
                    this.view.minimum
                ) /
                Math.max(
                    Number.EPSILON,
                    this.view.maximum -
                    this.view.minimum
                );

            return (
                this.plot.x +
                ratio *
                this.plot.width
            );
        }

        _timeForX(x) {
            const ratio =
                (
                    x -
                    this.plot.x
                ) /
                Math.max(
                    1,
                    this.plot.width
                );

            return (
                this.view.minimum +
                ratio *
                (
                    this.view.maximum -
                    this.view.minimum
                )
            );
        }

        _snapTime(time) {
            const value =
                Math.max(
                    this.domain.minimum,
                    Math.min(
                        this.domain.maximum,
                        time
                    )
                );

            if (
                !this.options.snap ||
                !this.times.length
            ) {
                return value;
            }

            this.metrics.snapSearches += 1;

            let low = 0;
            let high = this.times.length - 1;

            while (low < high) {
                const middle =
                    Math.floor((low + high) / 2);

                if (this.times[middle] < value) {
                    low = middle + 1;
                } else {
                    high = middle;
                }
            }

            const left = Math.max(0, low - 1);

            return Math.abs(this.times[low] - value) <
                Math.abs(this.times[left] - value)
                ? this.times[low]
                : this.times[left];
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

            if (!this.events.length) {
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
                    "No temporal data.",
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

            if (this.options.showHistogram) {
                this._drawHistogram();
            }

            this._drawTrack();

            if (this.options.showSelection) {
                this._drawSelection();
            }

            if (this.options.showCurrent) {
                this._drawCurrent();
            }

            if (this.options.showAxis) {
                this._drawAxis();
            }

            if (this.options.showLabels) {
                this._drawLabels();
            }

            this.metrics.draws += 1;
        }

        _drawGrid() {
            this.context.save();
            this.context.strokeStyle =
                this.options.gridColor;
            this.context.globalAlpha =
                0.3;
            this.context.lineWidth = 1;

            const ticks = 10;

            for (
                let index = 0;
                index <= ticks;
                index += 1
            ) {
                const x =
                    this.plot.x +
                    this.plot.width *
                    index /
                    ticks;

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

            this.context.restore();
        }

        _drawHistogram() {
            const maximumHeight =
                this.plot.height *
                0.55;
            const visible =
                this.histogram.filter(
                    (bucket) =>
                        bucket.end >=
                        this.view.minimum &&
                        bucket.start <=
                        this.view.maximum
                );

            this.context.save();

            for (const bucket of visible) {
                const x0 =
                    this._xForTime(
                        Math.max(
                            bucket.start,
                            this.view.minimum
                        )
                    );
                const x1 =
                    this._xForTime(
                        Math.min(
                            bucket.end,
                            this.view.maximum
                        )
                    );
                const height =
                    bucket.normalized *
                    maximumHeight;

                this.context.fillStyle =
                    this.options.foreground;
                this.context.globalAlpha =
                    0.12 +
                    bucket.normalized *
                    0.48;
                this.context.fillRect(
                    x0,
                    this.plot.y +
                    this.plot.height -
                    height,
                    Math.max(
                        1,
                        x1 - x0
                    ),
                    height
                );
            }

            this.context.restore();
        }

        _drawTrack() {
            const y =
                this.plot.y +
                this.plot.height *
                0.78;

            this.context.save();
            this.context.strokeStyle =
                this.options.trackColor;
            this.context.globalAlpha =
                0.9;
            this.context.lineWidth = 6;
            this.context.lineCap =
                "round";
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
            this.context.restore();

            this.trackY = y;
        }

        _drawSelection() {
            const startX =
                this._xForTime(
                    this.selection.start
                );
            const endX =
                this._xForTime(
                    this.selection.end
                );
            const left =
                Math.min(
                    startX,
                    endX
                );
            const right =
                Math.max(
                    startX,
                    endX
                );

            this.context.save();
            this.context.strokeStyle =
                this.options.selectionColor;
            this.context.globalAlpha =
                0.95;
            this.context.lineWidth = 6;
            this.context.lineCap =
                "round";
            this.context.beginPath();
            this.context.moveTo(
                left,
                this.trackY
            );
            this.context.lineTo(
                right,
                this.trackY
            );
            this.context.stroke();

            for (const [name, x] of [
                ["start", startX],
                ["end", endX]
            ]) {
                this.context.beginPath();
                this.context.arc(
                    x,
                    this.trackY,
                    this.options.handleRadius,
                    0,
                    Math.PI * 2
                );
                this.context.fillStyle =
                    this.drag?.handle === name
                        ? this.options.highlight
                        : this.options.selectionColor;
                this.context.globalAlpha = 1;
                this.context.fill();

                this.context.strokeStyle =
                    this.options.background;
                this.context.lineWidth = 1;
                this.context.stroke();
            }

            this.context.restore();

            this.startHandleX =
                startX;
            this.endHandleX =
                endX;
        }

        _drawCurrent() {
            const x =
                this._xForTime(
                    this.current
                );

            this.context.save();
            this.context.strokeStyle =
                this.options.highlight;
            this.context.globalAlpha =
                0.9;
            this.context.lineWidth = 2;
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

            this.context.beginPath();
            this.context.arc(
                x,
                this.trackY,
                this.options.handleRadius *
                0.72,
                0,
                Math.PI * 2
            );
            this.context.fillStyle =
                this.options.highlight;
            this.context.fill();
            this.context.restore();

            this.currentHandleX = x;
        }

        _drawAxis() {
            this.context.save();
            this.context.strokeStyle =
                this.options.axisColor;
            this.context.globalAlpha =
                0.8;
            this.context.lineWidth = 1;
            this.context.beginPath();
            this.context.moveTo(
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

            const ticks = 6;

            this.context.fillStyle =
                this.options.foreground;
            this.context.font =
                '10px "IBM Plex Mono", monospace';
            this.context.textBaseline =
                "top";

            for (
                let index = 0;
                index <= ticks;
                index += 1
            ) {
                const ratio =
                    index / ticks;
                const time =
                    this.view.minimum +
                    ratio *
                    (
                        this.view.maximum -
                        this.view.minimum
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
                    formatTime(
                        time,
                        this.options.format
                    ).slice(0, 19),
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
            this.context.fillStyle =
                this.options.foreground;
            this.context.font =
                '11px "IBM Plex Mono", monospace';
            this.context.textBaseline =
                "middle";
            this.context.globalAlpha =
                0.86;

            this.context.textAlign =
                "left";
            this.context.fillText(
                `Start: ${formatTime(
                    this.selection.start,
                    this.options.format
                )}`,
                this.plot.x,
                14
            );

            this.context.textAlign =
                "center";
            this.context.fillStyle =
                this.options.highlight;
            this.context.fillText(
                `Current: ${formatTime(
                    this.current,
                    this.options.format
                )}`,
                this.plot.x +
                this.plot.width / 2,
                14
            );

            this.context.textAlign =
                "right";
            this.context.fillStyle =
                this.options.foreground;
            this.context.fillText(
                `End: ${formatTime(
                    this.selection.end,
                    this.options.format
                )}`,
                this.plot.x +
                this.plot.width,
                14
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

        _nearestHandle(point) {
            this.metrics.hitTests += 1;

            const candidates = [
                {
                    name: "start",
                    x:
                        this.startHandleX
                },
                {
                    name: "end",
                    x:
                        this.endHandleX
                },
                {
                    name: "current",
                    x:
                        this.currentHandleX
                }
            ];

            let nearest = null;
            let distance = Infinity;

            for (const candidate of candidates) {
                const candidateDistance =
                    Math.hypot(
                        point.x -
                        candidate.x,
                        point.y -
                        this.trackY
                    );

                if (
                    candidateDistance <
                    distance &&
                    candidateDistance <=
                    this.options.handleRadius +
                    8
                ) {
                    nearest =
                        candidate.name;
                    distance =
                        candidateDistance;
                }
            }

            return nearest;
        }

        _handlePointerMove(event) {
            const point =
                this._pointFromEvent(event);

            if (this.drag?.handle) {
                this.pointerMoved = true;
                const time =
                    this._snapTime(
                        this._timeForX(
                            Math.max(
                                this.plot.x,
                                Math.min(
                                    this.plot.x +
                                    this.plot.width,
                                    point.x
                                )
                            )
                        )
                    );

                if (
                    this.drag.handle ===
                    "start"
                ) {
                    this.setRange(
                        time,
                        this.selection.end
                    );
                } else if (
                    this.drag.handle ===
                    "end"
                ) {
                    this.setRange(
                        this.selection.start,
                        time
                    );
                } else {
                    this.seek(time);
                }

                return;
            }

            if (this.drag?.pan) {
                this.pointerMoved = true;
                const delta =
                    point.x -
                    this.drag.startX;
                const span =
                    this.drag.viewMaximum -
                    this.drag.viewMinimum;
                const shift =
                    -delta /
                    this.plot.width *
                    span;

                this._setView(
                    this.drag.viewMinimum +
                    shift,
                    this.drag.viewMaximum +
                    shift
                );
                this.metrics.pans += 1;
                this.draw();

                this._emit("pan", {
                    view: clone(this.view)
                });
                return;
            }

            const handle =
                this._nearestHandle(
                    point
                );
            const time =
                this._snapTime(
                    this._timeForX(
                        Math.max(
                            this.plot.x,
                            Math.min(
                                this.plot.x +
                                this.plot.width,
                                point.x
                            )
                        )
                    )
                );

            this.hovered = {
                handle,
                time
            };
            this.canvas.style.cursor =
                handle
                    ? "ew-resize"
                    : this.options.pannable
                        ? "grab"
                        : "pointer";

            this._emit("hover", {
                handle,
                time,
                formatted:
                    formatTime(
                        time,
                        this.options.format
                    )
            });
        }

        _handlePointerLeave() {
            this.drag = null;
            this.hovered = null;
        }

        _handlePointerDown(event) {
            if (event.button !== 0) {
                return;
            }

            this.pointerMoved = false;

            const point =
                this._pointFromEvent(event);
            const handle =
                this._nearestHandle(point);

            if (handle) {
                this.drag = {
                    handle
                };
            } else if (
                this.options.pannable &&
                event.shiftKey
            ) {
                this.drag = {
                    pan: true,
                    startX:
                        point.x,
                    viewMinimum:
                        this.view.minimum,
                    viewMaximum:
                        this.view.maximum
                };
            } else {
                const time =
                    this._snapTime(
                        this._timeForX(
                            point.x
                        )
                    );

                if (
                    this.options.mode ===
                    "point"
                ) {
                    this.seek(time);
                    this.drag = {
                        handle: "current"
                    };
                } else {
                    const startDistance =
                        Math.abs(
                            time -
                            this.selection.start
                        );
                    const endDistance =
                        Math.abs(
                            time -
                            this.selection.end
                        );

                    this.drag = {
                        handle:
                            startDistance <
                            endDistance
                                ? "start"
                                : "end"
                    };
                }
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
            const anchor =
                this._timeForX(point.x);
            const span =
                this.view.maximum -
                this.view.minimum;
            const factor =
                event.deltaY < 0
                    ? 0.82
                    : 1 / 0.82;
            const minimumSpan =
                Math.max(
                    this.options.step,
                    (
                        this.domain.maximum -
                        this.domain.minimum
                    ) /
                    100000
                );
            const maximumSpan =
                this.domain.maximum -
                this.domain.minimum;
            const nextSpan =
                Math.max(
                    minimumSpan,
                    Math.min(
                        maximumSpan,
                        span *
                        factor
                    )
                );
            const ratio =
                (
                    anchor -
                    this.view.minimum
                ) /
                span;
            const minimum =
                anchor -
                nextSpan *
                ratio;
            const maximum =
                minimum +
                nextSpan;

            this._setView(
                minimum,
                maximum
            );
            this.metrics.zooms += 1;
            this.draw();

            this._emit("zoom", {
                view:
                    clone(this.view)
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
            const time =
                this._snapTime(
                    this._timeForX(
                        point.x
                    )
                );

            this.seek(time);
        }

        _handleKeydown(event) {
            if (
                event.key === " " ||
                event.key === "k"
            ) {
                event.preventDefault();

                if (this.playing && !this.paused) {
                    this.pause();
                } else {
                    this.play();
                }
            } else if (
                event.key === "ArrowLeft"
            ) {
                event.preventDefault();
                this.stepBackward();
            } else if (
                event.key === "ArrowRight"
            ) {
                event.preventDefault();
                this.stepForward();
            } else if (
                event.key === "Home"
            ) {
                event.preventDefault();
                this.seek(
                    this.selection.start
                );
            } else if (
                event.key === "End"
            ) {
                event.preventDefault();
                this.seek(
                    this.selection.end
                );
            } else if (
                event.key === "+" ||
                event.key === "="
            ) {
                event.preventDefault();
                this.setSpeed(
                    this.options.speed *
                    2
                );
            } else if (
                event.key === "-"
            ) {
                event.preventDefault();
                this.setSpeed(
                    this.options.speed /
                    2
                );
            } else if (
                event.key === "0"
            ) {
                event.preventDefault();
                this.resetView();
            }
        }

        _setView(minimum, maximum) {
            const domainSpan =
                this.domain.maximum -
                this.domain.minimum;
            let span =
                maximum - minimum;

            if (span >= domainSpan) {
                this.view.minimum =
                    this.domain.minimum;
                this.view.maximum =
                    this.domain.maximum;
                return;
            }

            if (minimum < this.domain.minimum) {
                maximum +=
                    this.domain.minimum -
                    minimum;
                minimum =
                    this.domain.minimum;
            }

            if (maximum > this.domain.maximum) {
                minimum -=
                    maximum -
                    this.domain.maximum;
                maximum =
                    this.domain.maximum;
            }

            span =
                maximum - minimum;

            if (span <= 0) {
                return;
            }

            this.view.minimum =
                Math.max(
                    this.domain.minimum,
                    minimum
                );
            this.view.maximum =
                Math.min(
                    this.domain.maximum,
                    maximum
                );
        }

        play() {
            if (this.destroyed) {
                throw new Error(
                    "TimeSlider controller has been destroyed."
                );
            }

            if (
                this.playing &&
                !this.paused
            ) {
                return false;
            }

            if (this.animationFrame) {
                window.cancelAnimationFrame(
                    this.animationFrame
                );
                this.animationFrame = 0;
            }

            this.playing = true;
            this.paused = false;
            this.lastFrameAt = 0;
            this.metrics.plays += 1;

            this.animationFrame =
                window.requestAnimationFrame(
                    (timestamp) =>
                        this._frame(timestamp)
                );

            this._emit("play", {
                current:
                    this.current,
                speed:
                    this.options.speed,
                direction:
                    this.options.direction
            });

            return true;
        }

        pause() {
            if (
                !this.playing ||
                this.paused
            ) {
                return false;
            }

            this.paused = true;
            this.metrics.pauses += 1;

            if (this.animationFrame) {
                window.cancelAnimationFrame(
                    this.animationFrame
                );
                this.animationFrame = 0;
            }

            this._emit("pause", {
                current:
                    this.current
            });

            return true;
        }

        resume() {
            if (!this.playing) {
                return this.play();
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

            this._emit("resume", {
                current:
                    this.current
            });

            return true;
        }

        stop() {
            const active =
                this.playing ||
                this.paused;

            this.playing = false;
            this.paused = false;

            if (this.animationFrame) {
                window.cancelAnimationFrame(
                    this.animationFrame
                );
                this.animationFrame = 0;
            }

            if (active) {
                this._emit("stop", {
                    current:
                        this.current
                });
            }

            return active;
        }

        _frame(timestamp) {
            if (
                !this.playing ||
                this.paused ||
                this.destroyed
            ) {
                return;
            }

            const delta =
                this.lastFrameAt
                    ? Math.min(
                        100,
                        timestamp -
                        this.lastFrameAt
                    )
                    : 16.667;

            this.lastFrameAt =
                timestamp;

            const direction =
                this.options.direction ===
                "reverse"
                    ? -1
                    : 1;
            const amount =
                direction *
                this.options.step *
                this.options.speed *
                delta /
                this.options.interval;
            let next =
                this.current +
                amount;

            if (
                direction > 0 &&
                next >
                this.selection.end
            ) {
                if (this.options.loop) {
                    next =
                        this.selection.start;
                    this._emit("loop", {
                        direction:
                            "forward"
                    });
                } else {
                    next =
                        this.selection.end;
                    this.seek(next);
                    this.stop();
                    return;
                }
            } else if (
                direction < 0 &&
                next <
                this.selection.start
            ) {
                if (this.options.loop) {
                    next =
                        this.selection.end;
                    this._emit("loop", {
                        direction:
                            "reverse"
                    });
                } else {
                    next =
                        this.selection.start;
                    this.seek(next);
                    this.stop();
                    return;
                }
            }

            this.current =
                this.options.snap
                    ? this._snapTime(next)
                    : next;
            this.metrics.frames += 1;
            this.draw();

            this._emit("change", {
                current:
                    this.current,
                formatted:
                    formatTime(
                        this.current,
                        this.options.format
                    ),
                selection:
                    clone(this.selection),
                playing:
                    true
            });

            if (
                this.playing &&
                !this.paused &&
                !this.destroyed
            ) {
                this.animationFrame =
                    window.requestAnimationFrame(
                        (nextTimestamp) =>
                            this._frame(
                                nextTimestamp
                            )
                    );
            }
        }

        seek(time) {
            const next =
                this._snapTime(
                    parseNumber(
                        time,
                        this.current
                    )
                );

            this.current =
                Math.max(
                    this.selection.start,
                    Math.min(
                        this.selection.end,
                        next
                    )
                );
            this.metrics.seeks += 1;
            this.draw();

            this._emit("change", {
                current:
                    this.current,
                formatted:
                    formatTime(
                        this.current,
                        this.options.format
                    ),
                selection:
                    clone(this.selection),
                playing:
                    this.playing &&
                    !this.paused
            });

            return this.current;
        }

        setRange(start, end) {
            let minimum =
                this._snapTime(
                    parseNumber(
                        start,
                        this.selection.start
                    )
                );
            let maximum =
                this._snapTime(
                    parseNumber(
                        end,
                        this.selection.end
                    )
                );

            if (minimum > maximum) {
                [
                    minimum,
                    maximum
                ] = [
                    maximum,
                    minimum
                ];
            }

            this.selection.start =
                Math.max(
                    this.domain.minimum,
                    minimum
                );
            this.selection.end =
                Math.min(
                    this.domain.maximum,
                    maximum
                );

            if (
                this.current <
                this.selection.start
            ) {
                this.current =
                    this.selection.start;
            }

            if (
                this.current >
                this.selection.end
            ) {
                this.current =
                    this.selection.end;
            }

            this.metrics.ranges += 1;
            this.draw();

            this._emit("range", {
                start:
                    this.selection.start,
                end:
                    this.selection.end,
                formattedStart:
                    formatTime(
                        this.selection.start,
                        this.options.format
                    ),
                formattedEnd:
                    formatTime(
                        this.selection.end,
                        this.options.format
                    )
            });

            return clone(
                this.selection
            );
        }

        setSpeed(value) {
            this.options.speed =
                parseNumber(
                    value,
                    this.options.speed,
                    0.01,
                    1024
                );

            this._emit("speed", {
                speed:
                    this.options.speed
            });

            return this.options.speed;
        }

        setDirection(direction) {
            if (
                ![
                    "forward",
                    "reverse"
                ].includes(direction)
            ) {
                throw new Error(
                    `Unknown TimeSlider direction: ${direction}`
                );
            }

            this.options.direction =
                direction;

            this._emit("direction", {
                direction
            });

            return direction;
        }

        stepForward(amount = this.options.step) {
            this.metrics.steps += 1;

            return this.seek(
                this.current +
                Math.abs(
                    parseNumber(
                        amount,
                        this.options.step
                    )
                )
            );
        }

        stepBackward(amount = this.options.step) {
            this.metrics.steps += 1;

            return this.seek(
                this.current -
                Math.abs(
                    parseNumber(
                        amount,
                        this.options.step
                    )
                )
            );
        }

        setMode(mode) {
            if (
                ![
                    "point",
                    "range"
                ].includes(mode)
            ) {
                throw new Error(
                    `Unknown TimeSlider mode: ${mode}`
                );
            }

            this.options.mode =
                mode;
            this.draw();

            return mode;
        }

        resetView() {
            this.view = {
                minimum:
                    this.domain.minimum,
                maximum:
                    this.domain.maximum
            };
            this.draw();

            this._emit("resetView", {
                view: clone(this.view)
            });

            return clone(
                this.view
            );
        }

        recordsInRange(
            start = this.selection.start,
            end = this.selection.end
        ) {
            return this.eventsInRange(
                start,
                end,
                {
                    limit: 100000
                }
            ).events;
        }

        update(options = {}) {
            if (!isObject(options)) {
                throw new TypeError(
                    "TimeSlider options must be an object."
                );
            }

            const rebuildRequired = [
                "timeKey",
                "timeAccessor",
                "buckets"
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
                    mode:
                        [
                            "point",
                            "range"
                        ].includes(options.mode)
                            ? options.mode
                            : this.options.mode,
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
                    trackColor:
                        options.trackColor ||
                        this.options.trackColor,
                    selectionColor:
                        options.selectionColor ||
                        this.options.selectionColor,
                    handleRadius:
                        options.handleRadius !== undefined
                            ? parseNumber(
                                options.handleRadius,
                                this.options.handleRadius,
                                3,
                                24
                            )
                            : this.options.handleRadius,
                    buckets:
                        options.buckets !== undefined
                            ? Math.floor(parseNumber(
                                options.buckets,
                                this.options.buckets,
                                8,
                                1000
                            ))
                            : this.options.buckets,
                    showHistogram:
                        options.showHistogram !== undefined
                            ? parseBoolean(
                                options.showHistogram,
                                this.options.showHistogram
                            )
                            : this.options.showHistogram,
                    showGrid:
                        options.showGrid !== undefined
                            ? parseBoolean(
                                options.showGrid,
                                this.options.showGrid
                            )
                            : this.options.showGrid,
                    showAxis:
                        options.showAxis !== undefined
                            ? parseBoolean(
                                options.showAxis,
                                this.options.showAxis
                            )
                            : this.options.showAxis,
                    showLabels:
                        options.showLabels !== undefined
                            ? parseBoolean(
                                options.showLabels,
                                this.options.showLabels
                            )
                            : this.options.showLabels,
                    showSelection:
                        options.showSelection !== undefined
                            ? parseBoolean(
                                options.showSelection,
                                this.options.showSelection
                            )
                            : this.options.showSelection,
                    showCurrent:
                        options.showCurrent !== undefined
                            ? parseBoolean(
                                options.showCurrent,
                                this.options.showCurrent
                            )
                            : this.options.showCurrent,
                    snap:
                        options.snap !== undefined
                            ? parseBoolean(
                                options.snap,
                                this.options.snap
                            )
                            : this.options.snap,
                    loop:
                        options.loop !== undefined
                            ? parseBoolean(
                                options.loop,
                                this.options.loop
                            )
                            : this.options.loop,
                    direction:
                        [
                            "forward",
                            "reverse"
                        ].includes(options.direction)
                            ? options.direction
                            : this.options.direction,
                    speed:
                        options.speed !== undefined
                            ? parseNumber(
                                options.speed,
                                this.options.speed,
                                0.01,
                                1024
                            )
                            : this.options.speed,
                    step:
                        options.step !== undefined
                            ? parseNumber(
                                options.step,
                                this.options.step,
                                0.000001,
                                1e15
                            )
                            : this.options.step,
                    interval:
                        options.interval !== undefined
                            ? parseNumber(
                                options.interval,
                                this.options.interval,
                                16,
                                60000
                            )
                            : this.options.interval,
                    format:
                        options.format ||
                        this.options.format
                }
            );

            if (rebuildRequired) {
                this.setData(
                    this.records
                );
            } else {
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
                        domain:
                            this.domain,
                        view:
                            this.view,
                        selection:
                            this.selection,
                        current:
                            this.current,
                        playing:
                            this.playing &&
                            !this.paused,
                        events:
                            this.events.map(
                                (event) => ({
                                    id:
                                        event.id,
                                    label:
                                        event.label,
                                    time:
                                        event.time,
                                    formatted:
                                        formatTime(
                                            event.time,
                                            this.options.format
                                        ),
                                    weight:
                                        event.weight,
                                    raw:
                                        clone(
                                            event.raw
                                        )
                                })
                            ),
                        histogram:
                            this.histogram.map(
                                clone
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
                    "time",
                    "formatted",
                    "weight",
                    "inSelection"
                ]];

                for (const event of this.events) {
                    rows.push([
                        event.id,
                        event.label,
                        event.time,
                        formatTime(
                            event.time,
                            this.options.format
                        ),
                        event.weight,
                        event.time >=
                            this.selection.start &&
                        event.time <=
                            this.selection.end
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
                `Unsupported TimeSlider export format: ${format}`
            );
        }

        status() {
            return {
                name:
                    "time-slider",
                module:
                    MODULE_NAME,
                records:
                    this.records.length,
                events:
                    this.events.length,
                uniqueTimes:
                    this.times.length,
                domain:
                    clone(this.domain),
                view:
                    clone(this.view),
                selection:
                    clone(this.selection),
                current:
                    this.current,
                formattedCurrent:
                    formatTime(
                        this.current,
                        this.options.format
                    ),
                playing:
                    this.playing,
                paused:
                    this.paused,
                speed:
                    this.options.speed,
                direction:
                    this.options.direction,
                mode:
                    this.options.mode,
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
            this.abortController.abort();

            this.drag = null;
            this.hovered = null;

            this._emit("destroy", {});

            if (this.canvas[CONTROLLER_SYMBOL] === this) {
                delete this.canvas[CONTROLLER_SYMBOL];
            }

            if (this.canvas.timeSliderController === this) {
                delete this.canvas.timeSliderController;
            }

            this.records = [];
            this.events = [];
            this.times = [];
            this.histogram = [];
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
            canvas.timeSliderController;

        if (
            existing instanceof TimeSliderController &&
            !existing.destroyed
        ) {
            existing.update(options);
            existing.setData(data);
            return existing;
        }

        return new TimeSliderController(
            canvas,
            data,
            options
        );
    }

    function render(data = [], options = {}) {
        const container = createElement(
            "section",
            "terminal-visualization terminal-visualization-time-slider"
        );
        container.dataset.visualization =
            "time-slider";
        container.setAttribute(
            "role",
            "region"
        );
        container.setAttribute(
            "aria-label",
            options.label ||
            "TimeSlider visualization"
        );

        const canvas =
            document.createElement("canvas");
        canvas.className =
            "terminal-time-slider-canvas";
        canvas.width =
            Number(options.width) ||
            DEFAULT_WIDTH;
        canvas.height =
            Number(options.height) ||
            DEFAULT_HEIGHT;
        canvas.setAttribute(
            "aria-label",
            options.label ||
            "TimeSlider visualization"
        );

        const status = createElement(
            "div",
            "terminal-time-slider-status"
        );
        status.setAttribute(
            "aria-live",
            "polite"
        );

        container.append(
            canvas,
            status
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
                `${snapshot.events} event` +
                `${snapshot.events === 1 ? "" : "s"} · ` +
                `${snapshot.formattedCurrent} · ` +
                `${snapshot.speed}× · ` +
                `${snapshot.direction} · ` +
                (
                    snapshot.playing &&
                    !snapshot.paused
                        ? "playing"
                        : snapshot.paused
                            ? "paused"
                            : "stopped"
                );
        };

        for (const eventName of [
            "data",
            "append",
            "resize",
            "change",
            "range",
            "play",
            "pause",
            "resume",
            "stop",
            "speed",
            "direction",
            "zoom",
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
        container.data = controller.events;
        container[CONTROLLER_SYMBOL] = controller;
        container.timeSliderController = controller;

        container.update = (
            nextData = data,
            nextOptions = {}
        ) => {
            controller.update(nextOptions);
            controller.setData(nextData);
            container.data = controller.events;
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
            context.timeSlider ||
            context["time-slider"] ||
            root?.[VISUALIZATION_SYMBOL];

        if (
            existing &&
            existing.Controller === TimeSliderController
        ) {
            context.timeSlider = existing;

            context.registerVisualization?.(
                "time-slider",
                existing
            );

            context.registerRenderer?.(
                "time-slider",
                existing
            );

            return existing;
        }

        const dataset =
            context.root?.dataset || {};

        const config =
            context.config?.timeSlider ||
            context.config?.["time-slider"] ||
            {};

        const defaults = {
            context,
            timeKey:
                dataset.terminalTimeSliderTimeKey ||
                config.timeKey ||
                null,

            mode:
                dataset.terminalTimeSliderMode ||
                config.mode ||
                "range",

            background:
                dataset.terminalTimeSliderBackground ||
                config.background ||
                DEFAULT_BACKGROUND,

            foreground:
                dataset.terminalTimeSliderForeground ||
                config.foreground ||
                DEFAULT_FOREGROUND,

            highlight:
                dataset.terminalTimeSliderHighlight ||
                config.highlight ||
                DEFAULT_HIGHLIGHT,

            gridColor:
                dataset.terminalTimeSliderGrid ||
                config.gridColor ||
                DEFAULT_GRID,

            axisColor:
                dataset.terminalTimeSliderAxis ||
                config.axisColor ||
                DEFAULT_AXIS,

            trackColor:
                dataset.terminalTimeSliderTrack ||
                config.trackColor ||
                DEFAULT_TRACK,

            selectionColor:
                dataset.terminalTimeSliderSelection ||
                config.selectionColor ||
                DEFAULT_SELECTION,

            handleRadius:
                dataset.terminalTimeSliderHandleRadius ||
                config.handleRadius ||
                DEFAULT_HANDLE_RADIUS,

            buckets:
                dataset.terminalTimeSliderBuckets ||
                config.buckets ||
                DEFAULT_BUCKETS,

            speed:
                dataset.terminalTimeSliderSpeed ||
                config.speed ||
                1,

            step:
                dataset.terminalTimeSliderStep ||
                config.step ||
                1,

            interval:
                dataset.terminalTimeSliderInterval ||
                config.interval ||
                1000,

            direction:
                dataset.terminalTimeSliderDirection ||
                config.direction ||
                "forward",

            format:
                dataset.terminalTimeSliderFormat ||
                config.format ||
                "auto",

            showHistogram: parseBoolean(
                dataset.terminalTimeSliderShowHistogram,
                config.showHistogram !== false
            ),

            showGrid: parseBoolean(
                dataset.terminalTimeSliderShowGrid,
                config.showGrid !== false
            ),

            showAxis: parseBoolean(
                dataset.terminalTimeSliderShowAxis,
                config.showAxis !== false
            ),

            showLabels: parseBoolean(
                dataset.terminalTimeSliderShowLabels,
                config.showLabels !== false
            ),

            snap: parseBoolean(
                dataset.terminalTimeSliderSnap,
                config.snap !== false
            ),

            loop: parseBoolean(
                dataset.terminalTimeSliderLoop,
                config.loop !== false
            ),

            autoplay: parseBoolean(
                dataset.terminalTimeSliderAutoplay,
                config.autoplay === true
            ),

            interactive: parseBoolean(
                dataset.terminalTimeSliderInteractive,
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
                context.timeSliderController =
                    controller;

                controller.addEventListener(
                    "destroy",
                    () => {
                        controllers.delete(controller);

                        if (
                            context.timeSliderController ===
                            controller
                        ) {
                            delete context.timeSliderController;
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
                    context.timeSliderController =
                        element.controller;

                    element.controller.addEventListener(
                        "destroy",
                        () => {
                            controllers.delete(
                                element.controller
                            );

                            if (
                                context.timeSliderController ===
                                element.controller
                            ) {
                                delete context.timeSliderController;
                            }
                        },
                        { once: true }
                    );
                }

                return element;
            },

            activeController() {
                return (
                    context.timeSliderController ||
                    context.terminalTimeSliderController ||
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
                    context.timeSlider ===
                    visualization
                ) {
                    delete context.timeSlider;
                }

                if (context.timeSliderController) {
                    delete context.timeSliderController;
                }

                return true;
            },

            Controller: TimeSliderController,
            normalizeRecords,
            inferField,
            parseTime,
            timeForRecord,
            formatTime
        };

        root[VISUALIZATION_SYMBOL] = visualization;

        context.registerVisualization?.(
            "time-slider",
            visualization
        );

        context.registerRenderer?.(
            "time-slider",
            visualization
        );

        context.timeSlider = visualization;

        safeDispatch(
            document,
            "speciedex:terminal-time-slider-ready",
            {
                visualization,
                version: VERSION
            }
        );

        return visualization;
    }

    const commands = [{
        name: "time-slider",
        category: "visualization",
        description:
            "Render and control an interactive temporal point or range slider.",
        usage:
            "time-slider [collection|status|play|pause|resume|stop|seek|" +
            "range|events|nearest|buckets|summary|forward|back|speed|direction|" +
            "mode|fit|histogram|grid|axis|labels|selection|current|" +
            "snap|loop|reset|export] [arguments]",
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
                context.timeSlider ||
                initialize(context);

            const controller =
                context.timeSliderController ||
                context.terminalTimeSliderController ||
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

                        case "play":
                            controller.play();
                            return outputText(
                                "Time slider playback started.",
                                "success"
                            );

                        case "pause":
                            controller.pause();
                            return outputText(
                                "Time slider playback paused.",
                                "success"
                            );

                        case "resume":
                            controller.resume();
                            return outputText(
                                "Time slider playback resumed.",
                                "success"
                            );

                        case "stop":
                            controller.stop();
                            return outputText(
                                "Time slider playback stopped.",
                                "success"
                            );

                        case "seek":
                            return outputJSON({
                                current:
                                    controller.seek(
                                        args[1]
                                    ),
                                status:
                                    controller.status()
                            });

                        case "range":
                            return outputJSON({
                                selection:
                                    controller.setRange(
                                        args[1],
                                        args[2]
                                    ),
                                status:
                                    controller.status()
                            });

                        case "events":
                            return outputJSON(
                                controller.eventsInRange(
                                    args[1] ??
                                        controller.selection.start,
                                    args[2] ??
                                        controller.selection.end,
                                    {
                                        limit: args[3]
                                    }
                                )
                            );

                        case "nearest":
                            if (args[1] === undefined) {
                                throw new Error(
                                    "A time value is required."
                                );
                            }

                            return outputJSON({
                                events:
                                    controller.nearestEvents(
                                        args[1],
                                        args[2]
                                    )
                            });

                        case "buckets":
                        case "histogram-summary":
                            return outputJSON({
                                buckets:
                                    controller.bucketSummary(
                                        args[1] ??
                                        null
                                    )
                            });

                        case "summary":
                            return outputJSON(
                                controller.summary()
                            );

                        case "forward":
                        case "next":
                            return outputJSON({
                                current:
                                    controller.stepForward(
                                        args[1]
                                    )
                            });

                        case "back":
                        case "previous":
                        case "prev":
                            return outputJSON({
                                current:
                                    controller.stepBackward(
                                        args[1]
                                    )
                            });

                        case "speed":
                            if (
                                args[1] ===
                                undefined
                            ) {
                                return outputJSON({
                                    speed:
                                        controller.options.speed
                                });
                            }

                            return outputJSON({
                                speed:
                                    controller.setSpeed(
                                        args[1]
                                    )
                            });

                        case "direction":
                            if (!args[1]) {
                                return outputJSON({
                                    direction:
                                        controller.options.direction
                                });
                            }

                            return outputJSON({
                                direction:
                                    controller.setDirection(
                                        args[1]
                                    )
                            });

                        case "mode":
                            if (!args[1]) {
                                return outputJSON({
                                    mode:
                                        controller.options.mode
                                });
                            }

                            return outputJSON({
                                mode:
                                    controller.setMode(
                                        args[1]
                                    )
                            });

                        case "fit":
                            return outputJSON({
                                view:
                                    controller.fitView({
                                        padding: args[1]
                                    })
                            });

                        case "histogram":
                            controller.update({
                                showHistogram:
                                    args[1] === undefined
                                        ? !controller.options.showHistogram
                                        : parseBoolean(
                                            args[1],
                                            controller.options.showHistogram
                                        )
                            });

                            return outputJSON({
                                showHistogram:
                                    controller.options.showHistogram
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

                        case "axis":
                            controller.update({
                                showAxis:
                                    args[1] === undefined
                                        ? !controller.options.showAxis
                                        : parseBoolean(
                                            args[1],
                                            controller.options.showAxis
                                        )
                            });

                            return outputJSON({
                                showAxis:
                                    controller.options.showAxis
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

                        case "selection":
                            controller.update({
                                showSelection:
                                    args[1] === undefined
                                        ? !controller.options.showSelection
                                        : parseBoolean(
                                            args[1],
                                            controller.options.showSelection
                                        )
                            });

                            return outputJSON({
                                showSelection:
                                    controller.options.showSelection
                            });

                        case "current":
                            controller.update({
                                showCurrent:
                                    args[1] === undefined
                                        ? !controller.options.showCurrent
                                        : parseBoolean(
                                            args[1],
                                            controller.options.showCurrent
                                        )
                            });

                            return outputJSON({
                                showCurrent:
                                    controller.options.showCurrent
                            });

                        case "snap":
                            controller.update({
                                snap:
                                    args[1] === undefined
                                        ? !controller.options.snap
                                        : parseBoolean(
                                            args[1],
                                            controller.options.snap
                                        )
                            });

                            return outputJSON({
                                snap:
                                    controller.options.snap
                            });

                        case "loop":
                            controller.update({
                                loop:
                                    args[1] === undefined
                                        ? !controller.options.loop
                                        : parseBoolean(
                                            args[1],
                                            controller.options.loop
                                        )
                            });

                            return outputJSON({
                                loop:
                                    controller.options.loop
                            });

                        case "reset":
                            return outputJSON({
                                view:
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
                        ...context.config?.timeSlider,
                        ...context.config?.["time-slider"],
                        label:
                            `TimeSlider for ${collection}`
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
        TimeSliderController,
        normalizeRecords,
        inferField,
        parseTime,
        timeForRecord,
        formatTime,
        createAbortError,
        mount,
        render,
        initialize,
        init: initialize,
        setup: initialize,
        unmount(context = {}) {
            const visualization =
                context.timeSlider;

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

    window.SpeciedexTerminalTimeSlider =
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
