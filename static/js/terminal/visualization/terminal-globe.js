/*
========================================================================
Speciedex.org
Terminal Globe Visualization
========================================================================

Interactive orthographic globe renderer for Speciedex records. Supports
latitude/longitude extraction, point density, great-circle arcs, graticules,
rotation, drag navigation, zoom, auto-rotation, hover inspection, selection,
responsive high-DPI rendering, exports, metrics, and lifecycle control.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Globe";
    const DEFAULT_WIDTH = 960;
    const DEFAULT_HEIGHT = 540;
    const DEFAULT_BACKGROUND = "#020a05";
    const DEFAULT_OCEAN = "#07100a";
    const DEFAULT_LAND = "#173322";
    const DEFAULT_GRID = "#35503a";
    const DEFAULT_FOREGROUND = "#c0d674";
    const DEFAULT_HIGHLIGHT = "#eef7c8";
    const DEFAULT_RADIUS_RATIO = 0.42;
    const DEFAULT_POINT_RADIUS = 3;
    const DEFAULT_ROTATION_SPEED = 0.012;
    const DEFAULT_MAX_RECORDS = 100000;
    const DEFAULT_MAX_ARCS = 5000;

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
            "Globe visualization requires a canvas or container element."
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
                "features",
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

    function firstFinite(record, keys) {
        for (const key of keys) {
            const value = Number(record?.[key]);

            if (Number.isFinite(value)) {
                return value;
            }
        }

        return null;
    }

    function extractCoordinates(record) {
        if (!isObject(record)) {
            return null;
        }

        if (
            isObject(record.geometry) &&
            Array.isArray(record.geometry.coordinates) &&
            record.geometry.coordinates.length >= 2
        ) {
            const longitude = Number(record.geometry.coordinates[0]);
            const latitude = Number(record.geometry.coordinates[1]);

            if (Number.isFinite(longitude) && Number.isFinite(latitude)) {
                return {
                    longitude,
                    latitude,
                    source: "geometry"
                };
            }
        }

        const longitude = firstFinite(record, [
            "longitude",
            "lon",
            "lng",
            "decimalLongitude",
            "decimal_longitude"
        ]);
        const latitude = firstFinite(record, [
            "latitude",
            "lat",
            "decimalLatitude",
            "decimal_latitude"
        ]);

        if (longitude === null || latitude === null) {
            return null;
        }

        return {
            longitude,
            latitude,
            source: "record"
        };
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

    function extractWeight(record) {
        if (!isObject(record)) {
            return 1;
        }

        for (const key of [
            "weight",
            "count",
            "value",
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

    function degreesToRadians(value) {
        return value * Math.PI / 180;
    }

    function radiansToDegrees(value) {
        return value * 180 / Math.PI;
    }

    function normalizeLongitude(value) {
        let longitude = value % 360;

        if (longitude > 180) {
            longitude -= 360;
        } else if (longitude < -180) {
            longitude += 360;
        }

        return longitude;
    }

    function clampLatitude(value) {
        return Math.max(-90, Math.min(90, value));
    }

    function cartesian(longitude, latitude) {
        const lambda = degreesToRadians(longitude);
        const phi = degreesToRadians(latitude);
        const cosPhi = Math.cos(phi);

        return {
            x: cosPhi * Math.cos(lambda),
            y: Math.sin(phi),
            z: cosPhi * Math.sin(lambda)
        };
    }

    function spherical(vector) {
        const length = Math.hypot(vector.x, vector.y, vector.z) || 1;
        const x = vector.x / length;
        const y = vector.y / length;
        const z = vector.z / length;

        return {
            longitude: normalizeLongitude(
                radiansToDegrees(Math.atan2(z, x))
            ),
            latitude: clampLatitude(
                radiansToDegrees(Math.asin(y))
            )
        };
    }

    function rotateVector(vector, yaw, pitch) {
        const yawRadians = degreesToRadians(yaw);
        const pitchRadians = degreesToRadians(pitch);

        const cosYaw = Math.cos(yawRadians);
        const sinYaw = Math.sin(yawRadians);
        const cosPitch = Math.cos(pitchRadians);
        const sinPitch = Math.sin(pitchRadians);

        const x1 =
            vector.x * cosYaw -
            vector.z * sinYaw;
        const z1 =
            vector.x * sinYaw +
            vector.z * cosYaw;
        const y1 = vector.y;

        return {
            x: x1,
            y:
                y1 * cosPitch -
                z1 * sinPitch,
            z:
                y1 * sinPitch +
                z1 * cosPitch
        };
    }

    function slerp(start, end, amount) {
        const dot = Math.max(
            -1,
            Math.min(
                1,
                start.x * end.x +
                start.y * end.y +
                start.z * end.z
            )
        );
        const omega = Math.acos(dot);

        if (Math.abs(omega) < 1e-9) {
            return {
                x: start.x,
                y: start.y,
                z: start.z
            };
        }

        const sinOmega = Math.sin(omega);
        const a =
            Math.sin((1 - amount) * omega) /
            sinOmega;
        const b =
            Math.sin(amount * omega) /
            sinOmega;

        return {
            x: start.x * a + end.x * b,
            y: start.y * a + end.y * b,
            z: start.z * a + end.z * b
        };
    }

    class GlobeController extends EventTarget {
        constructor(target, data = [], options = {}) {
            super();

            this.canvas = resolveCanvas(target);
            this.context = this.canvas.getContext("2d", {
                alpha: true,
                desynchronized: true
            });

            if (!this.context) {
                throw new Error(
                    "Unable to acquire Globe 2D canvas context."
                );
            }

            this.options = {
                background:
                    options.background ||
                    DEFAULT_BACKGROUND,
                ocean:
                    options.ocean ||
                    DEFAULT_OCEAN,
                land:
                    options.land ||
                    DEFAULT_LAND,
                gridColor:
                    options.gridColor ||
                    DEFAULT_GRID,
                foreground:
                    options.foreground ||
                    DEFAULT_FOREGROUND,
                highlight:
                    options.highlight ||
                    DEFAULT_HIGHLIGHT,
                radiusRatio: parseNumber(
                    options.radiusRatio,
                    DEFAULT_RADIUS_RATIO,
                    0.1,
                    0.49
                ),
                pointRadius: parseNumber(
                    options.pointRadius,
                    DEFAULT_POINT_RADIUS,
                    1,
                    20
                ),
                yaw: parseNumber(
                    options.yaw,
                    -20,
                    -360,
                    360
                ),
                pitch: parseNumber(
                    options.pitch,
                    18,
                    -89,
                    89
                ),
                zoom: parseNumber(
                    options.zoom,
                    1,
                    0.35,
                    8
                ),
                minZoom: parseNumber(
                    options.minZoom,
                    0.35,
                    0.1,
                    8
                ),
                maxZoom: parseNumber(
                    options.maxZoom,
                    8,
                    0.35,
                    24
                ),
                showGraticule:
                    options.showGraticule !== false,
                showPoints:
                    options.showPoints !== false,
                showArcs:
                    options.showArcs !== false,
                showAtmosphere:
                    options.showAtmosphere !== false,
                autoRotate:
                    options.autoRotate !== false,
                rotationSpeed: parseNumber(
                    options.rotationSpeed,
                    DEFAULT_ROTATION_SPEED,
                    -1,
                    1
                ),
                interactive:
                    options.interactive !== false,
                animated:
                    options.animated !== false,
                label:
                    options.label ||
                    "Globe visualization",
                maxArcs: parseNumber(
                    options.maxArcs,
                    DEFAULT_MAX_ARCS,
                    0,
                    100000
                ),
                arcSteps: parseNumber(
                    options.arcSteps,
                    40,
                    8,
                    256
                )
            };

            this.records = [];
            this.points = [];
            this.arcs = [];
            this.bounds = {
                width: 1,
                height: 1
            };
            this.center = {
                x: 0,
                y: 0
            };
            this.radius = 1;
            this.hovered = null;
            this.selected = null;
            this.drag = null;
            this.running = false;
            this.paused = false;
            this.destroyed = false;
            this.animationFrame = 0;
            this.lastFrameAt = 0;
            this.startedAt = null;
            this.lastError = null;
            this.metrics = {
                inputRecords: 0,
                mappedRecords: 0,
                rejectedRecords: 0,
                arcs: 0,
                frames: 0,
                draws: 0,
                zooms: 0,
                rotations: 0,
                selections: 0,
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
            } else {
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
            this.radius =
                Math.min(
                    this.bounds.width,
                    this.bounds.height
                ) *
                this.options.radiusRatio *
                this.options.zoom;
            this.metrics.resizes += 1;
            this.draw();

            this._emit("resize", {
                width: this.bounds.width,
                height: this.bounds.height,
                radius: this.radius
            });
        }

        setData(data) {
            try {
                this.records = normalizeRecords(data);
                this.points = [];
                this.arcs = [];

                let rejected = 0;

                this.records.forEach((record, index) => {
                    const coordinates =
                        extractCoordinates(record);

                    if (!coordinates) {
                        rejected += 1;
                        return;
                    }

                    this.points.push({
                        id: String(
                            record?.speciedex_id ??
                            record?.speciedexId ??
                            record?.id ??
                            `point-${index + 1}`
                        ),
                        label:
                            labelForRecord(record, index),
                        longitude:
                            normalizeLongitude(
                                coordinates.longitude
                            ),
                        latitude:
                            clampLatitude(
                                coordinates.latitude
                            ),
                        weight:
                            extractWeight(record),
                        record,
                        index
                    });
                });

                this._buildArcs();

                this.metrics.inputRecords =
                    this.records.length;
                this.metrics.mappedRecords =
                    this.points.length;
                this.metrics.rejectedRecords =
                    rejected;
                this.metrics.arcs =
                    this.arcs.length;

                this.draw();

                this._emit("data", {
                    records: this.records.length,
                    points: this.points.length,
                    arcs: this.arcs.length
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
            this.setData(this.records);

            this._emit("append", {
                added: records.length
            });

            return records.length;
        }

        _buildArcs() {
            const byId = new Map(
                this.points.map((point) => [
                    point.id,
                    point
                ])
            );
            const seen = new Set();

            const addArc = (
                source,
                target,
                type = "related",
                weight = 1
            ) => {
                if (
                    !source ||
                    !target ||
                    source.id === target.id ||
                    this.arcs.length >= this.options.maxArcs
                ) {
                    return;
                }

                const key =
                    `${source.id}|${target.id}|${type}`;

                if (seen.has(key)) {
                    return;
                }

                seen.add(key);
                this.arcs.push({
                    id: key,
                    source,
                    target,
                    type,
                    weight:
                        parseNumber(
                            weight,
                            1,
                            0.01,
                            1000000
                        )
                });
            };

            for (const point of this.points) {
                const record = point.record;

                if (!isObject(record)) {
                    continue;
                }

                for (const key of [
                    "parent_id",
                    "parentId",
                    "accepted_id",
                    "acceptedId",
                    "related_ids",
                    "relatedIds",
                    "links"
                ]) {
                    const value = record[key];

                    if (value === undefined || value === null) {
                        continue;
                    }

                    const values =
                        Array.isArray(value)
                            ? value
                            : [value];

                    for (const item of values) {
                        const targetId = isObject(item)
                            ? String(
                                item.target ??
                                item.targetId ??
                                item.id ??
                                ""
                            )
                            : String(item);
                        const target =
                            byId.get(targetId);

                        if (target) {
                            addArc(
                                point,
                                target,
                                isObject(item)
                                    ? (
                                        item.type ??
                                        item.relationship ??
                                        key
                                    )
                                    : key,
                                isObject(item)
                                    ? item.weight
                                    : 1
                            );
                        }
                    }
                }
            }
        }

        _project(longitude, latitude) {
            const vector =
                cartesian(
                    longitude,
                    latitude
                );
            const rotated =
                rotateVector(
                    vector,
                    this.options.yaw,
                    this.options.pitch
                );

            return {
                x:
                    this.center.x +
                    rotated.x *
                    this.radius,
                y:
                    this.center.y -
                    rotated.y *
                    this.radius,
                visible:
                    rotated.z >= 0,
                depth:
                    rotated.z
            };
        }

        start() {
            if (this.destroyed) {
                throw new Error(
                    "Globe controller has been destroyed."
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
                this.options.yaw =
                    normalizeLongitude(
                        this.options.yaw +
                        this.options.rotationSpeed *
                        delta
                    );
                this.metrics.rotations += 1;
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

            this._drawSphere();

            if (this.options.showGraticule) {
                this._drawGraticule();
            }

            if (this.options.showArcs) {
                this._drawArcs();
            }

            if (this.options.showPoints) {
                this._drawPoints();
            }

            this.metrics.draws += 1;
        }

        _drawSphere() {
            const gradient =
                this.context.createRadialGradient(
                    this.center.x -
                    this.radius * 0.28,
                    this.center.y -
                    this.radius * 0.28,
                    this.radius * 0.1,
                    this.center.x,
                    this.center.y,
                    this.radius
                );

            gradient.addColorStop(
                0,
                this.options.land
            );
            gradient.addColorStop(
                0.62,
                this.options.ocean
            );
            gradient.addColorStop(
                1,
                this.options.background
            );

            this.context.save();
            this.context.beginPath();
            this.context.arc(
                this.center.x,
                this.center.y,
                this.radius,
                0,
                Math.PI * 2
            );
            this.context.fillStyle =
                gradient;
            this.context.fill();

            this.context.strokeStyle =
                this.options.foreground;
            this.context.globalAlpha =
                0.62;
            this.context.lineWidth =
                1.25;
            this.context.stroke();

            if (
                this.options.showAtmosphere
            ) {
                this.context.shadowColor =
                    this.options.foreground;
                this.context.shadowBlur = 24;
                this.context.globalAlpha =
                    0.18;
                this.context.strokeStyle =
                    this.options.highlight;
                this.context.lineWidth = 4;
                this.context.stroke();
            }

            this.context.restore();
        }

        _drawGraticule() {
            this.context.save();
            this.context.strokeStyle =
                this.options.gridColor;
            this.context.lineWidth = 1;
            this.context.globalAlpha =
                0.42;

            const drawLine = (points) => {
                let started = false;

                this.context.beginPath();

                for (const point of points) {
                    const projected =
                        this._project(
                            point.longitude,
                            point.latitude
                        );

                    if (!projected.visible) {
                        started = false;
                        continue;
                    }

                    if (!started) {
                        this.context.moveTo(
                            projected.x,
                            projected.y
                        );
                        started = true;
                    } else {
                        this.context.lineTo(
                            projected.x,
                            projected.y
                        );
                    }
                }

                this.context.stroke();
            };

            for (
                let longitude = -180;
                longitude <= 180;
                longitude += 15
            ) {
                const points = [];

                for (
                    let latitude = -90;
                    latitude <= 90;
                    latitude += 2
                ) {
                    points.push({
                        longitude,
                        latitude
                    });
                }

                drawLine(points);
            }

            for (
                let latitude = -75;
                latitude <= 75;
                latitude += 15
            ) {
                const points = [];

                for (
                    let longitude = -180;
                    longitude <= 180;
                    longitude += 2
                ) {
                    points.push({
                        longitude,
                        latitude
                    });
                }

                drawLine(points);
            }

            this.context.restore();
        }

        _drawArcs() {
            this.context.save();

            for (const arc of this.arcs) {
                const startVector =
                    cartesian(
                        arc.source.longitude,
                        arc.source.latitude
                    );
                const endVector =
                    cartesian(
                        arc.target.longitude,
                        arc.target.latitude
                    );
                let started = false;

                this.context.beginPath();

                for (
                    let index = 0;
                    index <= this.options.arcSteps;
                    index += 1
                ) {
                    const amount =
                        index /
                        this.options.arcSteps;
                    const vector =
                        slerp(
                            startVector,
                            endVector,
                            amount
                        );
                    const coordinate =
                        spherical(vector);
                    const projected =
                        this._project(
                            coordinate.longitude,
                            coordinate.latitude
                        );

                    if (!projected.visible) {
                        started = false;
                        continue;
                    }

                    const lift =
                        Math.sin(amount * Math.PI) *
                        this.radius *
                        0.10;
                    const dx =
                        projected.x -
                        this.center.x;
                    const dy =
                        projected.y -
                        this.center.y;
                    const length =
                        Math.hypot(dx, dy) || 1;
                    const x =
                        projected.x +
                        dx / length *
                        lift;
                    const y =
                        projected.y +
                        dy / length *
                        lift;

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

                this.context.strokeStyle =
                    this.options.highlight;
                this.context.globalAlpha =
                    0.28;
                this.context.lineWidth =
                    Math.min(
                        3,
                        0.6 +
                        Math.sqrt(
                            arc.weight
                        ) *
                        0.35
                    );
                this.context.stroke();
            }

            this.context.restore();
        }

        _drawPoints() {
            const projectedPoints = [];

            for (const point of this.points) {
                const projected =
                    this._project(
                        point.longitude,
                        point.latitude
                    );

                if (!projected.visible) {
                    continue;
                }

                projectedPoints.push({
                    point,
                    projected
                });
            }

            projectedPoints.sort(
                (left, right) =>
                    left.projected.depth -
                    right.projected.depth
            );

            this.context.save();

            for (
                const {
                    point,
                    projected
                }
                of projectedPoints
            ) {
                const emphasized =
                    point.id === this.selected?.id ||
                    point.id === this.hovered?.id;
                const radius =
                    this.options.pointRadius *
                    (
                        0.85 +
                        Math.min(
                            2.5,
                            Math.sqrt(
                                point.weight
                            ) *
                            0.18
                        )
                    );

                this.context.beginPath();
                this.context.arc(
                    projected.x,
                    projected.y,
                    emphasized
                        ? radius * 1.55
                        : radius,
                    0,
                    Math.PI * 2
                );
                this.context.fillStyle =
                    emphasized
                        ? this.options.highlight
                        : this.options.foreground;
                this.context.globalAlpha =
                    emphasized
                        ? 1
                        : 0.78;

                if (emphasized) {
                    this.context.shadowColor =
                        this.options.highlight;
                    this.context.shadowBlur =
                        12;
                } else {
                    this.context.shadowBlur =
                        0;
                }

                this.context.fill();

                point.screenX =
                    projected.x;
                point.screenY =
                    projected.y;
                point.screenRadius =
                    emphasized
                        ? radius * 1.55
                        : radius;
                point.depth =
                    projected.depth;
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
            const candidates =
                this.points
                    .filter(
                        (point) =>
                            Number.isFinite(
                                point.screenX
                            ) &&
                            Number.isFinite(
                                point.screenY
                            )
                    )
                    .sort(
                        (left, right) =>
                            right.depth -
                            left.depth
                    );

            for (const point of candidates) {
                const radius =
                    point.screenRadius + 4;
                const dx =
                    x - point.screenX;
                const dy =
                    y - point.screenY;

                if (
                    dx * dx +
                    dy * dy <=
                    radius * radius
                ) {
                    return point;
                }
            }

            return null;
        }

        _handlePointerMove(event) {
            const point =
                this._pointFromEvent(event);

            if (this.drag) {
                const dx =
                    point.x -
                    this.drag.startX;
                const dy =
                    point.y -
                    this.drag.startY;

                this.options.yaw =
                    normalizeLongitude(
                        this.drag.startYaw +
                        dx * 0.35
                    );
                this.options.pitch =
                    clampLatitude(
                        this.drag.startPitch -
                        dy * 0.28
                    );
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

            this.hovered =
                hovered;
            this.canvas.style.cursor =
                hovered
                    ? "pointer"
                    : "grab";

            if (changed) {
                this.draw();

                this._emit("hover", {
                    point:
                        hovered
                            ? this.describePoint(
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

            this.drag = {
                startX: point.x,
                startY: point.y,
                startYaw:
                    this.options.yaw,
                startPitch:
                    this.options.pitch
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
                yaw:
                    this.options.yaw,
                pitch:
                    this.options.pitch
            });
        }

        _handleWheel(event) {
            event.preventDefault();

            const factor =
                event.deltaY < 0
                    ? 1.12
                    : 1 / 1.12;

            this.setZoom(
                this.options.zoom *
                factor
            );
        }

        _handleClick(event) {
            if (this.drag) {
                return;
            }

            const point =
                this._pointFromEvent(event);
            const selected =
                this.hitTest(
                    point.x,
                    point.y
                );

            this.selected =
                selected?.id ===
                this.selected?.id
                    ? null
                    : selected;
            this.metrics.selections += 1;
            this.draw();

            this._emit("select", {
                point:
                    this.selected
                        ? this.describePoint(
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
                    this.options.zoom *
                    1.2
                );
            } else if (event.key === "-") {
                event.preventDefault();
                this.setZoom(
                    this.options.zoom /
                    1.2
                );
            } else if (event.key === "0") {
                event.preventDefault();
                this.resetView();
            } else if (event.key === "ArrowLeft") {
                event.preventDefault();
                this.rotateBy(-8, 0);
            } else if (event.key === "ArrowRight") {
                event.preventDefault();
                this.rotateBy(8, 0);
            } else if (event.key === "ArrowUp") {
                event.preventDefault();
                this.rotateBy(0, 6);
            } else if (event.key === "ArrowDown") {
                event.preventDefault();
                this.rotateBy(0, -6);
            } else if (event.key === "Escape") {
                this.selected = null;
                this.draw();
            }
        }

        rotateBy(yaw, pitch) {
            this.options.yaw =
                normalizeLongitude(
                    this.options.yaw +
                    (Number(yaw) || 0)
                );
            this.options.pitch =
                clampLatitude(
                    this.options.pitch +
                    (Number(pitch) || 0)
                );
            this.draw();

            this._emit("rotate", {
                yaw:
                    this.options.yaw,
                pitch:
                    this.options.pitch
            });

            return {
                yaw:
                    this.options.yaw,
                pitch:
                    this.options.pitch
            };
        }

        setRotation(yaw, pitch) {
            this.options.yaw =
                normalizeLongitude(
                    parseNumber(
                        yaw,
                        this.options.yaw
                    )
                );
            this.options.pitch =
                clampLatitude(
                    parseNumber(
                        pitch,
                        this.options.pitch
                    )
                );
            this.draw();

            return {
                yaw:
                    this.options.yaw,
                pitch:
                    this.options.pitch
            };
        }

        setZoom(value) {
            this.options.zoom =
                Math.max(
                    this.options.minZoom,
                    Math.min(
                        this.options.maxZoom,
                        parseNumber(
                            value,
                            this.options.zoom
                        )
                    )
                );
            this.radius =
                Math.min(
                    this.bounds.width,
                    this.bounds.height
                ) *
                this.options.radiusRatio *
                this.options.zoom;
            this.metrics.zooms += 1;
            this.draw();

            this._emit("zoom", {
                zoom:
                    this.options.zoom
            });

            return this.options.zoom;
        }

        resetView() {
            this.options.yaw = -20;
            this.options.pitch = 18;
            this.options.zoom = 1;
            this.radius =
                Math.min(
                    this.bounds.width,
                    this.bounds.height
                ) *
                this.options.radiusRatio;
            this.selected = null;
            this.draw();

            this._emit("resetView", {
                yaw:
                    this.options.yaw,
                pitch:
                    this.options.pitch,
                zoom:
                    this.options.zoom
            });

            return {
                yaw:
                    this.options.yaw,
                pitch:
                    this.options.pitch,
                zoom:
                    this.options.zoom
            };
        }

        describePoint(point) {
            if (!point) {
                return null;
            }

            return {
                id: point.id,
                label: point.label,
                longitude:
                    point.longitude,
                latitude:
                    point.latitude,
                weight:
                    point.weight,
                record:
                    clone(point.record)
            };
        }

        update(options = {}) {
            if (!isObject(options)) {
                throw new TypeError(
                    "Globe options must be an object."
                );
            }

            Object.assign(this.options, {
                background:
                    options.background ||
                    this.options.background,
                ocean:
                    options.ocean ||
                    this.options.ocean,
                land:
                    options.land ||
                    this.options.land,
                gridColor:
                    options.gridColor ||
                    this.options.gridColor,
                foreground:
                    options.foreground ||
                    this.options.foreground,
                highlight:
                    options.highlight ||
                    this.options.highlight,
                radiusRatio:
                    options.radiusRatio !== undefined
                        ? parseNumber(
                            options.radiusRatio,
                            this.options.radiusRatio,
                            0.1,
                            0.49
                        )
                        : this.options.radiusRatio,
                pointRadius:
                    options.pointRadius !== undefined
                        ? parseNumber(
                            options.pointRadius,
                            this.options.pointRadius,
                            1,
                            20
                        )
                        : this.options.pointRadius,
                yaw:
                    options.yaw !== undefined
                        ? normalizeLongitude(
                            options.yaw
                        )
                        : this.options.yaw,
                pitch:
                    options.pitch !== undefined
                        ? clampLatitude(
                            options.pitch
                        )
                        : this.options.pitch,
                zoom:
                    options.zoom !== undefined
                        ? parseNumber(
                            options.zoom,
                            this.options.zoom,
                            this.options.minZoom,
                            this.options.maxZoom
                        )
                        : this.options.zoom,
                showGraticule:
                    options.showGraticule !== undefined
                        ? Boolean(
                            options.showGraticule
                        )
                        : this.options.showGraticule,
                showPoints:
                    options.showPoints !== undefined
                        ? Boolean(
                            options.showPoints
                        )
                        : this.options.showPoints,
                showArcs:
                    options.showArcs !== undefined
                        ? Boolean(
                            options.showArcs
                        )
                        : this.options.showArcs,
                showAtmosphere:
                    options.showAtmosphere !== undefined
                        ? Boolean(
                            options.showAtmosphere
                        )
                        : this.options.showAtmosphere,
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
                            -1,
                            1
                        )
                        : this.options.rotationSpeed
            });

            this.radius =
                Math.min(
                    this.bounds.width,
                    this.bounds.height
                ) *
                this.options.radiusRatio *
                this.options.zoom;
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
                        points:
                            this.points.map(
                                (point) =>
                                    this.describePoint(
                                        point
                                    )
                            ),
                        arcs:
                            this.arcs.map(
                                (arc) => ({
                                    id: arc.id,
                                    source:
                                        arc.source.id,
                                    target:
                                        arc.target.id,
                                    type:
                                        arc.type,
                                    weight:
                                        arc.weight
                                })
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
                    "longitude",
                    "latitude",
                    "weight"
                ]];

                for (const point of this.points) {
                    rows.push([
                        point.id,
                        point.label,
                        point.longitude,
                        point.latitude,
                        point.weight
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
                `Unsupported Globe export format: ${format}`
            );
        }

        status() {
            return {
                name: "globe",
                module: MODULE_NAME,
                running:
                    this.running,
                paused:
                    this.paused,
                startedAt:
                    this.startedAt,
                records:
                    this.records.length,
                points:
                    this.points.length,
                arcs:
                    this.arcs.length,
                rotation: {
                    yaw:
                        this.options.yaw,
                    pitch:
                        this.options.pitch
                },
                zoom:
                    this.options.zoom,
                selected:
                    this.selected
                        ? this.describePoint(
                            this.selected
                        )
                        : null,
                hovered:
                    this.hovered
                        ? this.describePoint(
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
            this.points = [];
            this.arcs = [];
            this.destroyed = true;
            this._emit("destroy", {});
            return true;
        }
    }

    function mount(target, data = [], options = {}) {
        return new GlobeController(
            target,
            data,
            options
        );
    }

    function render(data = [], options = {}) {
        const container = createElement(
            "section",
            "terminal-visualization terminal-visualization-globe"
        );
        container.dataset.visualization =
            "globe";
        container.setAttribute(
            "role",
            "region"
        );
        container.setAttribute(
            "aria-label",
            options.label ||
            "Globe visualization"
        );

        const canvas =
            document.createElement("canvas");
        canvas.className =
            "terminal-globe-canvas";
        canvas.width =
            Number(options.width) ||
            DEFAULT_WIDTH;
        canvas.height =
            Number(options.height) ||
            DEFAULT_HEIGHT;
        canvas.setAttribute(
            "aria-label",
            options.label ||
            "Globe visualization"
        );

        const status = createElement(
            "div",
            "terminal-globe-status"
        );
        status.setAttribute(
            "aria-live",
            "polite"
        );

        const tooltip = createElement(
            "div",
            "terminal-globe-tooltip"
        );
        tooltip.hidden = true;

        container.append(
            canvas,
            status,
            tooltip
        );

        const controller =
            new GlobeController(
                canvas,
                data,
                options
            );

        const updateStatus = () => {
            const snapshot =
                controller.status();

            status.textContent =
                `${snapshot.points} mapped point` +
                `${snapshot.points === 1 ? "" : "s"} · ` +
                `${snapshot.arcs} arc` +
                `${snapshot.arcs === 1 ? "" : "s"} · ` +
                `${snapshot.zoom.toFixed(2)}×`;
        };

        controller.addEventListener(
            "hover",
            (event) => {
                const point =
                    event.detail?.point;

                if (!point) {
                    tooltip.hidden = true;
                    return;
                }

                tooltip.hidden = false;
                tooltip.textContent =
                    `${point.label} · ` +
                    `${point.latitude.toFixed(4)}, ` +
                    `${point.longitude.toFixed(4)}`;
            }
        );

        for (const eventName of [
            "data",
            "append",
            "resize",
            "zoom",
            "rotate",
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
            controller.points;
        container.destroy = () =>
            controller.destroy();

        return container;
    }

    function initialize(context = {}) {
        const dataset =
            context.root?.dataset || {};
        const config =
            context.config?.globe || {};

        const defaults = {
            background:
                dataset.terminalGlobeBackground ||
                config.background ||
                DEFAULT_BACKGROUND,

            ocean:
                dataset.terminalGlobeOcean ||
                config.ocean ||
                DEFAULT_OCEAN,

            land:
                dataset.terminalGlobeLand ||
                config.land ||
                DEFAULT_LAND,

            gridColor:
                dataset.terminalGlobeGrid ||
                config.gridColor ||
                DEFAULT_GRID,

            foreground:
                dataset.terminalGlobeForeground ||
                config.foreground ||
                DEFAULT_FOREGROUND,

            highlight:
                dataset.terminalGlobeHighlight ||
                config.highlight ||
                DEFAULT_HIGHLIGHT,

            pointRadius:
                dataset.terminalGlobePointRadius ||
                config.pointRadius ||
                DEFAULT_POINT_RADIUS,

            yaw:
                dataset.terminalGlobeYaw ||
                config.yaw ||
                -20,

            pitch:
                dataset.terminalGlobePitch ||
                config.pitch ||
                18,

            zoom:
                dataset.terminalGlobeZoom ||
                config.zoom ||
                1,

            showGraticule: parseBoolean(
                dataset.terminalGlobeShowGraticule,
                config.showGraticule !== false
            ),

            showPoints: parseBoolean(
                dataset.terminalGlobeShowPoints,
                config.showPoints !== false
            ),

            showArcs: parseBoolean(
                dataset.terminalGlobeShowArcs,
                config.showArcs !== false
            ),

            autoRotate: parseBoolean(
                dataset.terminalGlobeAutoRotate,
                config.autoRotate !== false
            ),

            animated: parseBoolean(
                dataset.terminalGlobeAnimated,
                config.animated !== false
            ),

            interactive: parseBoolean(
                dataset.terminalGlobeInteractive,
                config.interactive !== false
            )
        };

        const visualization = {
            mount(target, data = [], options = {}) {
                return new GlobeController(
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
                GlobeController,

            normalizeRecords,

            extractCoordinates,

            cartesian,

            spherical,

            slerp
        };

        context.registerVisualization?.(
            "globe",
            visualization
        );
        context.registerRenderer?.(
            "globe",
            visualization
        );
        context.globe =
            visualization;

        safeDispatch(
            document,
            "speciedex:terminal-globe-ready",
            {
                visualization
            }
        );

        return visualization;
    }

    const commands = [{
        name: "globe",
        category: "visualization",
        description:
            "Render and control an interactive orthographic globe.",
        usage:
            "globe [collection|status|start|stop|pause|resume|rotate|" +
            "zoom|reset|export] [arguments]",
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
                context.globeController ||
                context.terminalGlobeController;

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
                                "Globe started.",
                                "success"
                            );

                        case "stop":
                            controller.stop();
                            return write(
                                "Globe stopped.",
                                "success"
                            );

                        case "pause":
                            controller.pause();
                            return write(
                                "Globe paused.",
                                "success"
                            );

                        case "resume":
                            controller.resume();
                            return write(
                                "Globe resumed.",
                                "success"
                            );

                        case "rotate":
                            return writeJSON({
                                rotation:
                                    controller.rotateBy(
                                        args[1],
                                        args[2]
                                    )
                            });

                        case "zoom":
                            if (
                                args[1] ===
                                undefined
                            ) {
                                return writeJSON({
                                    zoom:
                                        controller.options.zoom
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
                                view:
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
                        ...context.config?.globe,
                        label:
                            `Globe for ${collection}`
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
        GlobeController,
        normalizeRecords,
        extractCoordinates,
        cartesian,
        spherical,
        rotateVector,
        slerp,
        mount,
        render,
        initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalGlobe =
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
