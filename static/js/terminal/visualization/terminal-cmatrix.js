/*
========================================================================
Speciedex.org
Terminal CMatrix Visualization
========================================================================

CMatrix uses the proven native ZMatrix canvas renderer with the printable
character repertoire captured from native CMatrix. It is browser-native and
requires no PTY, WebSocket, ANSI replay server, or external executable.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "cmatrix";
    const DEFAULT_FOREGROUND = "#c0d674";
    const DEFAULT_HIGHLIGHT = "#eef7c8";
    const DEFAULT_BACKGROUND = "#020a05";
    const DEFAULT_FONT_FAMILY =
        '"Noto Sans Mono", "Noto Sans CJK JP", "Noto Sans Devanagari", ' +
        '"Noto Sans Tibetan", "IBM Plex Mono", "Segoe UI Symbol", monospace';
    const DEFAULT_FONT_SIZE = 16;
    const DEFAULT_DENSITY = 0.86;
    const DEFAULT_SPEED = 1;
    const DEFAULT_TRAIL = 0.12;
    const DEFAULT_OPACITY = 0.72;
    const DEFAULT_MAX_RECORDS = 128;
    const DEFAULT_MAX_PULSES = 48;
    const DEFAULT_FPS = 60;
    const MIN_FONT_SIZE = 8;
    const MAX_FONT_SIZE = 48;

    /*
    ========================================================================
    CMatrix glyph repertoire
    ========================================================================

    This is the printable character repertoire observed in the bundled native
    CMatrix capture after ANSI/VT control sequences are removed.  The browser
    CMatrix deliberately uses the same renderer as ZMatrix; only the glyph
    bank differs.  That keeps animation, resize, pause/resume, injection,
    adaptive FPS, and lifecycle behavior identical on static hosting.
    ========================================================================
    */

    const CMATRIX_CHARACTERS =
        "!\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz";

    const GLYPH_BANKS = Object.freeze({
        cmatrix:
            CMATRIX_CHARACTERS
    });

    const DEFAULT_BANK_WEIGHTS = Object.freeze({
        cmatrix: 1
    });

    const PRESETS = Object.freeze({
        cmatrix: {
            banks: ["cmatrix"],
            foreground: DEFAULT_FOREGROUND,
            highlight: DEFAULT_HIGHLIGHT,
            background: DEFAULT_BACKGROUND,
            density: DEFAULT_DENSITY,
            speed: DEFAULT_SPEED,
            trail: DEFAULT_TRAIL,
            glow: 7
        },

        speciedex: {
            banks: ["cmatrix"],
            foreground: DEFAULT_FOREGROUND,
            highlight: DEFAULT_HIGHLIGHT,
            background: DEFAULT_BACKGROUND,
            density: DEFAULT_DENSITY,
            speed: DEFAULT_SPEED,
            trail: DEFAULT_TRAIL,
            glow: 7
        }
    });

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
            /* Visualization events must never interrupt animation. */
        }
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
            "CMatrix requires a canvas or container element."
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

    function splitGraphemes(value) {
        const text = String(value || "");

        if (typeof Intl.Segmenter === "function") {
            const segmenter = new Intl.Segmenter(undefined, {
                granularity: "grapheme"
            });

            return Array.from(
                segmenter.segment(text),
                (entry) => entry.segment
            ).filter((glyph) => glyph.trim() !== "");
        }

        return Array.from(text).filter((glyph) => glyph.trim() !== "");
    }

    function normalizeBanks(value) {
        const names = Array.isArray(value)
            ? value
            : String(value || "")
                .split(",")
                .map((name) => name.trim())
                .filter(Boolean);

        const valid = names.filter((name) =>
            Object.prototype.hasOwnProperty.call(GLYPH_BANKS, name)
        );

        return valid.length
            ? Array.from(new Set(valid))
            : [...PRESETS.cmatrix.banks];
    }

    function normalizeRecord(record) {
        if (!isObject(record)) {
            return null;
        }

        const first = (keys, fallback = "") => {
            for (const key of keys) {
                const value = record[key];

                if (
                    value !== undefined &&
                    value !== null &&
                    value !== ""
                ) {
                    return String(value).trim();
                }
            }

            return fallback;
        };

        const scientificName = first([
                "scientific_name",
                "scientificName",
                "canonical_name",
                "canonicalName",
                "accepted_name",
                "acceptedName",
                "taxon_name",
                "taxonName"
            ], record.rank || record.taxon_rank || record.taxonRank
                ? String(record.name || "").trim() : "");

        if (!scientificName || /^(media|publication|reference|geography)$/i.test(
            first(["rank", "taxon_rank", "taxonRank"])
        )) {
            return null;
        }

        return {
            scientificName,

            commonName: first([
                "common_name",
                "commonName",
                "vernacular_name",
                "vernacularName",
                "preferred_common_name",
                "preferredCommonName"
            ], "No common name"),

            id: first([
                "speciedex_id",
                "speciedexId",
                "canonical_id",
                "canonicalId",
                "taxon_id",
                "taxonId",
                "id",
                "key"
            ], "pending"),

            rank: first([
                "rank",
                "taxon_rank",
                "taxonRank"
            ]),

            provider: first([
                "provider",
                "source",
                "provider_id",
                "providerId"
            ], String(record.initial_source?.provider || "")),

            raw: clone(record),
            injectedAt: iso()
        };
    }

    class WeightedGlyphPool {
        constructor(banks, weights = {}) {
            this.banks = [];
            this.totalWeight = 0;
            this.configure(banks, weights);
        }

        configure(banks, weights = {}) {
            this.banks = [];
            this.totalWeight = 0;

            for (const name of normalizeBanks(banks)) {
                const glyphs = splitGraphemes(GLYPH_BANKS[name]);

                if (!glyphs.length) {
                    continue;
                }

                const weight = parseNumber(
                    weights[name],
                    DEFAULT_BANK_WEIGHTS[name] || 1,
                    0.001,
                    1000
                );

                this.totalWeight += weight;
                this.banks.push({
                    name,
                    glyphs,
                    weight,
                    cumulative: this.totalWeight
                });
            }

            return this;
        }

        random(random = Math.random) {
            if (!this.banks.length) {
                return "0";
            }

            const point = random() * this.totalWeight;
            const bank =
                this.banks.find((entry) => point <= entry.cumulative) ||
                this.banks[this.banks.length - 1];

            return bank.glyphs[
                Math.floor(random() * bank.glyphs.length)
            ] || "0";
        }

        status() {
            return this.banks.map((bank) => ({
                name: bank.name,
                glyphs: bank.glyphs.length,
                weight: bank.weight
            }));
        }
    }

    class CMatrixController extends EventTarget {
        constructor(target, options = {}) {
            super();

            this.canvas = resolveCanvas(target);
            this.context = this.canvas.getContext("2d", {
                alpha: false,
                desynchronized: true
            });

            if (!this.context) {
                throw new Error("Unable to acquire CMatrix 2D canvas context.");
            }

            const presetName = PRESETS[options.preset]
                ? options.preset
                : "cmatrix";
            const preset = PRESETS[presetName];

            this.options = {
                preset: presetName,
                banks: normalizeBanks(options.banks || preset.banks),
                weights: {
                    ...DEFAULT_BANK_WEIGHTS,
                    ...(options.weights || {})
                },
                fontFamily:
                    options.fontFamily ||
                    DEFAULT_FONT_FAMILY,
                fontSize: parseNumber(
                    options.fontSize,
                    DEFAULT_FONT_SIZE,
                    MIN_FONT_SIZE,
                    MAX_FONT_SIZE
                ),
                speed: parseNumber(
                    options.speed ?? options.baseSpeed,
                    preset.speed ?? DEFAULT_SPEED,
                    0.05,
                    20
                ),
                density: parseNumber(
                    options.density,
                    preset.density ?? DEFAULT_DENSITY,
                    0.01,
                    1
                ),
                trail: parseNumber(
                    options.trail,
                    preset.trail ?? DEFAULT_TRAIL,
                    0.005,
                    1
                ),
                opacity: parseNumber(
                    options.opacity,
                    DEFAULT_OPACITY,
                    0.01,
                    1
                ),
                foreground:
                    options.foreground ||
                    preset.foreground ||
                    DEFAULT_FOREGROUND,
                highlight:
                    options.highlight ||
                    preset.highlight ||
                    DEFAULT_HIGHLIGHT,
                background:
                    options.background ||
                    preset.background ||
                    DEFAULT_BACKGROUND,
                glow: parseNumber(
                    options.glow,
                    preset.glow ?? 7,
                    0,
                    40
                ),
                minLength: parseNumber(
                    options.minLength,
                    6,
                    2,
                    100
                ),
                maxLength: parseNumber(
                    options.maxLength,
                    28,
                    2,
                    200
                ),
                layers: parseNumber(
                    options.layers,
                    3,
                    1,
                    8
                ),
                maxInjectedRecords: parseNumber(
                    options.maxInjectedRecords,
                    DEFAULT_MAX_RECORDS,
                    1,
                    10000
                ),
                maxPulses: parseNumber(
                    options.maxPulses,
                    DEFAULT_MAX_PULSES,
                    1,
                    1000
                ),
                pulseSpeed: parseNumber(
                    options.pulseSpeed,
                    0.018,
                    0.001,
                    0.2
                ),
                tokenOpacity: parseNumber(
                    options.tokenOpacity,
                    0.78,
                    0.01,
                    1
                ),
                adaptive: options.adaptive !== false,
                targetFPS: parseNumber(
                    options.targetFPS,
                    DEFAULT_FPS,
                    15,
                    144
                ),
                autoStart: options.autoStart !== false,
                pauseWhenHidden: options.pauseWhenHidden !== false,
                reducedMotion:
                    options.reducedMotion === true ||
                    Boolean(
                        window.matchMedia?.(
                            "(prefers-reduced-motion: reduce)"
                        )?.matches
                    )
            };

            if (this.options.maxLength < this.options.minLength) {
                this.options.maxLength = this.options.minLength;
            }

            this.pool = new WeightedGlyphPool(
                this.options.banks,
                this.options.weights
            );
            this.columns = [];
            this.records = [];
            this.pulses = [];
            this.running = false;
            this.paused = false;
            this.destroyed = false;
            this.frame = 0;
            this.animationFrame = 0;
            this.lastFrameAt = 0;
            this.lastDrawAt = 0;
            this.elapsed = 0;
            this.fpsSamples = [];
            this.scale = 1;
            this.lastError = null;
            this.startedAt = null;
            this.metrics = {
                frames: 0,
                glyphs: 0,
                injected: 0,
                pulses: 0,
                droppedFrames: 0,
                resizes: 0,
                starts: 0,
                stops: 0,
                errors: 0
            };

            this._cleanupResize = createResizeObserver(
                this.canvas,
                () => this.resize()
            );
            this._visibilityHandler = () => {
                if (!this.options.pauseWhenHidden) {
                    return;
                }

                if (document.visibilityState === "hidden") {
                    this.pause({
                        automatic: true
                    });
                } else if (this.running) {
                    this.resume({
                        automatic: true
                    });
                }
            };

            document.addEventListener(
                "visibilitychange",
                this._visibilityHandler
            );

            this.resize();
            this.clear();

            if (this.options.autoStart) {
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

        _createColumn(index, width, height) {
            const fontSize = this.options.fontSize;
            const length = Math.floor(
                this.options.minLength +
                Math.random() *
                (this.options.maxLength - this.options.minLength + 1)
            );
            const layer = Math.floor(
                Math.random() * this.options.layers
            );
            const depth =
                this.options.layers === 1
                    ? 1
                    : 0.45 +
                      (layer / (this.options.layers - 1)) * 0.55;

            return {
                index,
                x: index * fontSize,
                y: -Math.random() * height,
                length,
                speed:
                    (0.25 + Math.random() * 1.45) *
                    this.options.speed *
                    depth,
                phase: Math.random() * Math.PI * 2,
                layer,
                depth,
                active: Math.random() <= this.options.density,
                glyphs: Array.from(
                    { length },
                    () => this.pool.random()
                ),
                mutations: Array.from(
                    { length },
                    () => Math.random()
                ),
                nextMutation: now() + 80 + Math.random() * 900
            };
        }

        _resetColumn(column, height) {
            column.y =
                -this.options.fontSize *
                (2 + Math.random() * column.length);
            column.speed =
                (0.25 + Math.random() * 1.45) *
                this.options.speed *
                column.depth;
            column.length = Math.floor(
                this.options.minLength +
                Math.random() *
                (this.options.maxLength - this.options.minLength + 1)
            );
            column.active =
                Math.random() <= this.options.density;
            column.glyphs = Array.from(
                { length: column.length },
                () => this.pool.random()
            );
            column.mutations = Array.from(
                { length: column.length },
                () => Math.random()
            );
            column.nextMutation = now() + 100 + Math.random() * 1200;
        }

        resize() {
            if (this.destroyed) {
                return;
            }

            const rect = this.canvas.getBoundingClientRect();
            const ratio = Math.min(
                window.devicePixelRatio || 1,
                2
            );
            const width = Math.max(
                1,
                Math.floor(rect.width * ratio)
            );
            const height = Math.max(
                1,
                Math.floor(rect.height * ratio)
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

            const logicalWidth = Math.max(1, rect.width);
            const logicalHeight = Math.max(1, rect.height);
            const count = Math.max(
                1,
                Math.ceil(
                    logicalWidth /
                    (this.options.fontSize * this.scale)
                )
            );
            const previous = this.columns;
            this.columns = Array.from(
                { length: count },
                (_, index) => {
                    const existing = previous[index];

                    if (existing) {
                        existing.index = index;
                        existing.x =
                            index *
                            this.options.fontSize *
                            this.scale;
                        return existing;
                    }

                    return this._createColumn(
                        index,
                        logicalWidth,
                        logicalHeight
                    );
                }
            );

            this.metrics.resizes += 1;
            this._emit("resize", {
                width: logicalWidth,
                height: logicalHeight,
                columns: count,
                scale: this.scale
            });
        }

        _mutateColumn(column, timestamp) {
            if (timestamp < column.nextMutation) {
                return;
            }

            const mutations = Math.max(
                1,
                Math.floor(column.length * 0.12)
            );

            for (let index = 0; index < mutations; index += 1) {
                const position = Math.floor(
                    Math.random() * column.length
                );
                column.glyphs[position] = this.pool.random();
                column.mutations[position] = Math.random();
            }

            column.nextMutation =
                timestamp +
                50 +
                Math.random() * 650;
        }

        _drawColumn(column, delta, width, height, timestamp) {
            if (!column.active) {
                if (Math.random() < 0.0015) {
                    column.active = true;
                } else {
                    return;
                }
            }

            this._mutateColumn(column, timestamp);

            const fontSize =
                this.options.fontSize *
                this.scale *
                column.depth;
            const lineHeight = fontSize * 1.08;
            const x =
                column.index *
                this.options.fontSize *
                this.scale;

            column.y +=
                column.speed *
                delta *
                0.075 *
                this.scale;

            this.context.font =
                `${Math.max(8, fontSize)}px ${this.options.fontFamily}`;
            this.context.textBaseline = "top";
            this.context.textAlign = "left";

            for (
                let position = 0;
                position < column.length;
                position += 1
            ) {
                const y =
                    column.y -
                    position * lineHeight;
                const progress =
                    1 - position / column.length;

                if (
                    y < -lineHeight ||
                    y > height + lineHeight
                ) {
                    continue;
                }

                let alpha =
                    Math.pow(progress, 1.45) *
                    this.options.opacity *
                    column.depth;

                if (position === 0) {
                    alpha = Math.min(
                        1,
                        alpha * 1.75
                    );
                    this.context.fillStyle =
                        this.options.highlight;
                    this.context.shadowColor =
                        this.options.highlight;
                    this.context.shadowBlur =
                        this.options.glow * column.depth;
                } else {
                    this.context.fillStyle =
                        this.options.foreground;
                    this.context.shadowColor =
                        this.options.foreground;
                    this.context.shadowBlur =
                        this.options.glow *
                        0.35 *
                        column.depth;
                }

                this.context.globalAlpha = alpha;
                this.context.fillText(
                    column.glyphs[position],
                    x,
                    y
                );
                this.metrics.glyphs += 1;
            }

            this.context.globalAlpha = 1;
            this.context.shadowBlur = 0;

            if (
                column.y -
                column.length * lineHeight >
                height + lineHeight ||
                Math.random() > 0.9995
            ) {
                this._resetColumn(column, height);
            }
        }

        _drawPulses(width, height, delta) {
            if (!this.pulses.length) {
                return;
            }

            this.context.save();
            this.context.textBaseline = "middle";
            this.context.textAlign = "left";

            for (const pulse of this.pulses) {
                pulse.progress +=
                    this.options.pulseSpeed *
                    delta *
                    0.06;

                const normalized = Math.min(
                    1,
                    pulse.progress
                );
                const x =
                    -pulse.width +
                    (width + pulse.width) * normalized;
                const laneHeight =
                    height /
                    Math.max(1, pulse.lanes);
                const y =
                    laneHeight * pulse.lane +
                    laneHeight * 0.5;
                const alpha =
                    Math.sin(normalized * Math.PI) *
                    this.options.tokenOpacity;

                this.context.globalAlpha = alpha;
                this.context.font =
                    `600 ${pulse.fontSize}px ${this.options.fontFamily}`;
                this.context.fillStyle =
                    this.options.highlight;
                this.context.shadowColor =
                    this.options.foreground;
                this.context.shadowBlur =
                    this.options.glow;
                this.context.fillText(
                    pulse.text,
                    x,
                    y
                );

                this.context.strokeStyle =
                    this.options.foreground;
                this.context.globalAlpha =
                    alpha * 0.35;
                this.context.beginPath();
                this.context.moveTo(
                    Math.max(0, x - 120),
                    y + pulse.fontSize * 0.75
                );
                this.context.lineTo(
                    Math.min(width, x + pulse.width),
                    y + pulse.fontSize * 0.75
                );
                this.context.stroke();
            }

            this.context.restore();

            this.pulses = this.pulses.filter(
                (pulse) => pulse.progress < 1.05
            );
        }

        _drawRecordTokens(width, height) {
            if (
                !this.records.length ||
                this.frame % 36 !== 0
            ) {
                return;
            }

            const record =
                this.records[
                    Math.floor(
                        Math.random() *
                        this.records.length
                    )
                ];
            const labels = [
                "SPECIES",
                "TAXON",
                "GENUS",
                "CLADE",
                "INDEX",
                "HASH",
                "NODE",
                "DNA"
            ];
            const label =
                labels[
                    Math.floor(
                        Math.random() *
                        labels.length
                    )
                ];
            const text =
                `${label}:${record.id}`;

            this.context.save();
            this.context.font =
                `10px ${this.options.fontFamily}`;
            this.context.fillStyle =
                this.options.foreground;
            this.context.globalAlpha = 0.22;
            this.context.shadowColor =
                this.options.foreground;
            this.context.shadowBlur =
                this.options.glow * 0.25;
            this.context.fillText(
                text,
                Math.random() *
                    Math.max(
                        1,
                        width -
                        this.context.measureText(text).width
                    ),
                Math.random() *
                    Math.max(1, height - 12)
            );
            this.context.restore();
        }

        _updatePerformance(delta) {
            if (!this.options.adaptive) {
                return;
            }

            const fps =
                delta > 0
                    ? 1000 / delta
                    : this.options.targetFPS;

            this.fpsSamples.push(fps);

            if (this.fpsSamples.length > 90) {
                this.fpsSamples.shift();
            }

            if (
                this.metrics.frames % 45 !== 0 ||
                this.fpsSamples.length < 30
            ) {
                return;
            }

            const average =
                this.fpsSamples.reduce(
                    (total, value) => total + value,
                    0
                ) /
                this.fpsSamples.length;
            const target = this.options.targetFPS;

            if (
                average < target * 0.72 &&
                this.scale < 1.8
            ) {
                this.scale = Math.min(
                    1.8,
                    this.scale + 0.1
                );
                this.resize();
            } else if (
                average > target * 0.94 &&
                this.scale > 1
            ) {
                this.scale = Math.max(
                    1,
                    this.scale - 0.05
                );
                this.resize();
            }
        }

        draw(timestamp = now()) {
            if (
                !this.running ||
                this.paused ||
                this.destroyed
            ) {
                return;
            }

            const delta = this.lastFrameAt
                ? Math.min(
                    100,
                    timestamp - this.lastFrameAt
                )
                : 16.667;
            this.lastFrameAt = timestamp;
            this.elapsed += delta;

            const targetInterval =
                1000 / this.options.targetFPS;

            if (
                this.elapsed < targetInterval &&
                !this.options.reducedMotion
            ) {
                this.animationFrame =
                    window.requestAnimationFrame(
                        (nextTimestamp) =>
                            this.draw(nextTimestamp)
                    );
                return;
            }

            const drawDelta = this.elapsed;
            this.elapsed = 0;

            const width =
                this.canvas.clientWidth;
            const height =
                this.canvas.clientHeight;

            this.context.globalAlpha = 1;
            this.context.shadowBlur = 0;
            this.context.fillStyle =
                this._trailColor();
            this.context.fillRect(
                0,
                0,
                width,
                height
            );

            for (const column of this.columns) {
                this._drawColumn(
                    column,
                    drawDelta,
                    width,
                    height,
                    timestamp
                );
            }

            this._drawPulses(
                width,
                height,
                drawDelta
            );
            this._drawRecordTokens(
                width,
                height
            );

            this.frame += 1;
            this.metrics.frames += 1;
            this.lastDrawAt = timestamp;
            this._updatePerformance(drawDelta);

            this.animationFrame =
                window.requestAnimationFrame(
                    (nextTimestamp) =>
                        this.draw(nextTimestamp)
                );
        }

        _trailColor() {
            const rgb = this._colorToRgb(
                this.options.background
            );

            if (!rgb) {
                return this.options.background;
            }

            return (
                `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ` +
                `${this.options.trail})`
            );
        }

        _colorToRgb(color) {
            const value = String(color || "").trim();

            if (/^#[0-9a-f]{3}$/i.test(value)) {
                return {
                    r: parseInt(
                        value[1] + value[1],
                        16
                    ),
                    g: parseInt(
                        value[2] + value[2],
                        16
                    ),
                    b: parseInt(
                        value[3] + value[3],
                        16
                    )
                };
            }

            if (/^#[0-9a-f]{6}$/i.test(value)) {
                return {
                    r: parseInt(
                        value.slice(1, 3),
                        16
                    ),
                    g: parseInt(
                        value.slice(3, 5),
                        16
                    ),
                    b: parseInt(
                        value.slice(5, 7),
                        16
                    )
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

        inject(record) {
            const normalized = normalizeRecord(record);

            if (!normalized) {
                return null;
            }

            this.records.push(normalized);

            while (
                this.records.length >
                this.options.maxInjectedRecords
            ) {
                this.records.shift();
            }

            const text = [
                normalized.scientificName,
                normalized.commonName,
                normalized.rank,
                normalized.provider
            ].filter(Boolean).join("  │  ");

            this.context.save();
            this.context.font =
                `600 12px ${this.options.fontFamily}`;
            const width =
                this.context.measureText(text).width;
            this.context.restore();

            this.pulses.push({
                record: normalized,
                text,
                progress: 0,
                lane: Math.floor(
                    Math.random() * 6
                ),
                lanes: 6,
                fontSize:
                    10 +
                    Math.floor(Math.random() * 4),
                width
            });

            while (
                this.pulses.length >
                this.options.maxPulses
            ) {
                this.pulses.shift();
            }

            const terms = [
                normalized.scientificName,
                normalized.commonName,
                normalized.rank,
                normalized.provider
            ].filter(Boolean);

            if (terms.length) {
                const glyphs = splitGraphemes(
                    terms.join("")
                );

                for (
                    let index = 0;
                    index < Math.min(
                        this.columns.length,
                        glyphs.length * 2
                    );
                    index += 1
                ) {
                    const column =
                        this.columns[
                            Math.floor(
                                Math.random() *
                                this.columns.length
                            )
                        ];

                    if (!column) {
                        continue;
                    }

                    const position =
                        Math.floor(
                            Math.random() *
                            column.glyphs.length
                        );
                    column.glyphs[position] =
                        glyphs[
                            Math.floor(
                                Math.random() *
                                glyphs.length
                            )
                        ];
                }
            }

            this.metrics.injected += 1;
            this.metrics.pulses += 1;

            this._emit("inject", {
                record: clone(normalized),
                records: this.records.length,
                pulses: this.pulses.length
            });

            return clone(normalized);
        }

        injectMany(records = []) {
            const added = [];

            for (const record of records) {
                const normalized = this.inject(record);

                if (normalized) {
                    added.push(normalized);
                }
            }

            return added;
        }

        start() {
            if (this.destroyed) {
                throw new Error(
                    "CMatrix controller has been destroyed."
                );
            }

            if (this.running && !this.paused) {
                return this;
            }

            this.running = true;
            this.paused = false;
            this.lastFrameAt = 0;
            this.elapsed = 0;
            this.startedAt =
                this.startedAt || iso();
            this.metrics.starts += 1;

            if (this.options.reducedMotion) {
                this.drawStatic();
            } else {
                this.animationFrame =
                    window.requestAnimationFrame(
                        (timestamp) =>
                            this.draw(timestamp)
                    );
            }

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
                this.metrics.stops += 1;
                this._emit("stop", {});
            }

            return this;
        }

        pause(options = {}) {
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

            if (options.automatic !== true) {
                this._emit("pause", {});
            }

            return true;
        }

        resume(options = {}) {
            if (!this.running) {
                this.start();
                return true;
            }

            if (!this.paused) {
                return false;
            }

            this.paused = false;
            this.lastFrameAt = 0;

            if (!this.options.reducedMotion) {
                this.animationFrame =
                    window.requestAnimationFrame(
                        (timestamp) =>
                            this.draw(timestamp)
                    );
            } else {
                this.drawStatic();
            }

            if (options.automatic !== true) {
                this._emit("resume", {});
            }

            return true;
        }

        drawStatic() {
            const width =
                this.canvas.clientWidth;
            const height =
                this.canvas.clientHeight;

            this.context.fillStyle =
                this.options.background;
            this.context.fillRect(
                0,
                0,
                width,
                height
            );

            for (const column of this.columns) {
                this._drawColumn(
                    column,
                    0,
                    width,
                    height,
                    now()
                );
            }
        }

        clear() {
            this.context.globalAlpha = 1;
            this.context.shadowBlur = 0;
            this.context.fillStyle =
                this.options.background;
            this.context.fillRect(
                0,
                0,
                this.canvas.clientWidth,
                this.canvas.clientHeight
            );
            return this;
        }

        reset() {
            this.records = [];
            this.pulses = [];
            this.frame = 0;
            this.scale = 1;
            this.fpsSamples = [];
            this.resize();

            for (const column of this.columns) {
                this._resetColumn(
                    column,
                    this.canvas.clientHeight
                );
            }

            this.clear();
            this._emit("reset", {});
            return this;
        }

        applyPreset(name) {
            if (!PRESETS[name]) {
                throw new Error(
                    `Unknown CMatrix preset: ${name}`
                );
            }

            const preset = PRESETS[name];

            this.update({
                ...preset,
                preset: name
            });

            return this.status();
        }

        setBanks(banks, weights = this.options.weights) {
            this.options.banks =
                normalizeBanks(banks);
            this.options.weights = {
                ...DEFAULT_BANK_WEIGHTS,
                ...weights
            };
            this.pool.configure(
                this.options.banks,
                this.options.weights
            );

            for (const column of this.columns) {
                column.glyphs = Array.from(
                    { length: column.length },
                    () => this.pool.random()
                );
            }

            this._emit("banks", {
                banks: [...this.options.banks]
            });

            return [...this.options.banks];
        }

        update(options = {}) {
            if (!isObject(options)) {
                throw new TypeError(
                    "CMatrix options must be an object."
                );
            }

            const resizeRequired =
                options.fontSize !== undefined ||
                options.layers !== undefined;

            if (options.preset && PRESETS[options.preset]) {
                const preset = PRESETS[options.preset];
                options = {
                    ...preset,
                    ...options
                };
            }

            if (options.banks !== undefined) {
                this.setBanks(
                    options.banks,
                    options.weights ||
                    this.options.weights
                );
            } else if (options.weights !== undefined) {
                this.setBanks(
                    this.options.banks,
                    options.weights
                );
            }

            const numberFields = {
                fontSize: [
                    MIN_FONT_SIZE,
                    MAX_FONT_SIZE
                ],
                speed: [0.05, 20],
                baseSpeed: [0.05, 20],
                density: [0.01, 1],
                trail: [0.005, 1],
                opacity: [0.01, 1],
                glow: [0, 40],
                minLength: [2, 100],
                maxLength: [2, 200],
                layers: [1, 8],
                maxInjectedRecords: [1, 10000],
                maxPulses: [1, 1000],
                pulseSpeed: [0.001, 0.2],
                tokenOpacity: [0.01, 1],
                targetFPS: [15, 144]
            };

            for (const [
                key,
                [minimum, maximum]
            ] of Object.entries(numberFields)) {
                if (options[key] === undefined) {
                    continue;
                }

                const targetKey =
                    key === "baseSpeed"
                        ? "speed"
                        : key;

                this.options[targetKey] =
                    parseNumber(
                        options[key],
                        this.options[targetKey],
                        minimum,
                        maximum
                    );
            }

            for (const key of [
                "fontFamily",
                "foreground",
                "highlight",
                "background",
                "preset"
            ]) {
                if (options[key] !== undefined) {
                    this.options[key] =
                        String(options[key]);
                }
            }

            for (const key of [
                "adaptive",
                "pauseWhenHidden",
                "reducedMotion"
            ]) {
                if (options[key] !== undefined) {
                    this.options[key] =
                        Boolean(options[key]);
                }
            }

            if (
                this.options.maxLength <
                this.options.minLength
            ) {
                this.options.maxLength =
                    this.options.minLength;
            }

            for (const column of this.columns) {
                column.speed =
                    Math.max(
                        0.05,
                        column.speed
                    );
                column.active =
                    Math.random() <=
                    this.options.density;
            }

            if (resizeRequired) {
                this.resize();
            }

            this._emit("update", {
                options: clone(this.options)
            });

            return this;
        }

        snapshot() {
            return {
                status: this.status(),
                records: this.records.map(clone),
                pulses: this.pulses.map(
                    (pulse) => ({
                        record: clone(pulse.record),
                        progress: pulse.progress,
                        lane: pulse.lane
                    })
                )
            };
        }

        status() {
            const averageFPS =
                this.fpsSamples.length
                    ? this.fpsSamples.reduce(
                        (total, value) =>
                            total + value,
                        0
                    ) /
                      this.fpsSamples.length
                    : 0;

            return {
                name: "cmatrix",
                module: MODULE_NAME,
                running: this.running,
                paused: this.paused,
                startedAt: this.startedAt,
                preset: this.options.preset,
                banks: this.pool.status(),
                records: this.records.length,
                pulses: this.pulses.length,
                columns: this.columns.length,
                scale: this.scale,
                averageFPS:
                    Number(
                        averageFPS.toFixed(2)
                    ),
                options: clone(this.options),
                metrics: { ...this.metrics },
                lastError: this.lastError
                    ? {
                        name: this.lastError.name,
                        message: this.lastError.message
                    }
                    : null,
                destroyed: this.destroyed
            };
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            this.stop();
            document.removeEventListener(
                "visibilitychange",
                this._visibilityHandler
            );
            this._cleanupResize?.();
            this.records = [];
            this.pulses = [];
            this.columns = [];
            this.destroyed = true;
            this._emit("destroy", {});
            return true;
        }
    }

    function mount(target, options = {}) {
        return new CMatrixController(
            target,
            options
        );
    }

    function render(data = [], options = {}) {
        const container =
            document.createElement("section");

        container.className =
            "terminal-visualization terminal-visualization-cmatrix";
        container.dataset.visualization =
            "cmatrix";

        const canvas =
            document.createElement("canvas");
        canvas.className =
            "terminal-cmatrix-canvas";
        canvas.setAttribute(
            "aria-label",
            "Speciedex CMatrix visualization"
        );

        const status =
            document.createElement("div");
        status.className =
            "terminal-cmatrix-status";
        status.setAttribute(
            "aria-live",
            "polite"
        );

        container.append(
            canvas,
            status
        );

        const controller =
            mount(canvas, options);

        const records = Array.isArray(data)
            ? data
            : data
                ? [data]
                : [];

        controller.injectMany(records);

        const updateStatus = () => {
            const snapshot =
                controller.status();

            status.textContent =
                snapshot.running
                    ? (
                        `CMatrix active · ${snapshot.columns} columns · ` +
                        `${snapshot.records} records · ` +
                        `${snapshot.averageFPS} fps`
                    )
                    : "CMatrix stopped";
        };

        for (const eventName of [
            "start",
            "stop",
            "pause",
            "resume",
            "inject",
            "resize",
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
        container.destroy = () =>
            controller.destroy();

        return container;
    }

    function initialize(context = {}) {
        const dataset =
            context.root?.dataset || {};
        const config =
            context.config?.cmatrix || {};

        const defaults = {
            preset:
                dataset.terminalCmatrixPreset ||
                config.preset ||
                "cmatrix",

            banks:
                dataset.terminalCmatrixBanks
                    ? dataset.terminalCmatrixBanks.split(",")
                    : config.banks,

            fontFamily:
                dataset.terminalCmatrixFontFamily ||
                config.fontFamily,

            fontSize:
                dataset.terminalCmatrixFontSize ||
                config.fontSize,

            speed:
                dataset.terminalCmatrixSpeed ||
                config.speed,

            density:
                dataset.terminalCmatrixDensity ||
                config.density,

            trail:
                dataset.terminalCmatrixTrail ||
                config.trail,

            foreground:
                dataset.terminalCmatrixForeground ||
                config.foreground,

            highlight:
                dataset.terminalCmatrixHighlight ||
                config.highlight,

            background:
                dataset.terminalCmatrixBackground ||
                config.background,

            adaptive: parseBoolean(
                dataset.terminalCmatrixAdaptive,
                config.adaptive !== false
            ),

            autoStart: parseBoolean(
                dataset.terminalCmatrixAutostart,
                config.autoStart !== false
            ),

            pauseWhenHidden: parseBoolean(
                dataset.terminalCmatrixPauseWhenHidden,
                config.pauseWhenHidden !== false
            )
        };

        const visualization = {
            mount(target, options = {}) {
                return mount(
                    target,
                    {
                        ...defaults,
                        ...options
                    }
                );
            },

            render(data, options = {}) {
                return render(
                    data,
                    {
                        ...defaults,
                        ...options
                    }
                );
            },

            Controller:
                CMatrixController,

            GlyphPool:
                WeightedGlyphPool,

            glyphBanks:
                GLYPH_BANKS,

            presets:
                PRESETS
        };

        context.registerVisualization?.(
            "cmatrix",
            visualization
        );

        context.registerRenderer?.(
            "cmatrix",
            visualization
        );

        context.cmatrix =
            visualization;

        safeDispatch(
            document,
            "speciedex:terminal-cmatrix-ready",
            {
                visualization,
                presets:
                    Object.keys(PRESETS),
                banks:
                    Object.keys(GLYPH_BANKS)
            }
        );

        return visualization;
    }

    const commands = [{
        name: "cmatrix",
        category: "visualization",
        description:
            "Control CMatrix using the native ZMatrix canvas renderer and CMatrix character set.",
        usage:
            "cmatrix [status|start|stop|restart|pause|resume|clear|reset|preset|" +
            "banks|speed|density|font-size|snapshot|config|args|key]",
        handler: ({
            args = [],
            context,
            write,
            writeJSON,
            writeError
        }) => {
            const controller =
                (
                    context.terminalSplash?.options?.matrixMode === "cmatrix"
                        ? context.terminalSplash?.matrixController
                        : null
                ) ||
                context.cmatrixController;

            if (!controller) {
                throw new Error(
                    "No mounted CMatrix controller is available."
                );
            }

            const action =
                String(
                    args[0] || "status"
                ).toLowerCase();
            const value =
                args[1];

            try {
                switch (action) {
                    case "status":
                    case "show":
                    case "info":
                        return writeJSON(
                            controller.status()
                        );

                    case "start":
                        controller.start();
                        return write(
                            "CMatrix visualization started.",
                            "success"
                        );

                    case "stop":
                        controller.stop();
                        return write(
                            "CMatrix visualization stopped.",
                            "success"
                        );

                    case "pause":
                        controller.pause();
                        return write(
                            "CMatrix visualization paused.",
                            "success"
                        );

                    case "resume":
                        controller.resume();
                        return write(
                            "CMatrix visualization resumed.",
                            "success"
                        );

                    case "restart":
                        controller.reset();
                        controller.start();
                        return write(
                            "CMatrix visualization restarted.",
                            "success"
                        );

                    case "config":
                        return writeJSON(
                            controller.status()
                        );

                    case "args":
                        return writeJSON({
                            mode: "browser-native",
                            args: [],
                            note: "CMatrix now uses the ZMatrix canvas engine; no PTY arguments are required."
                        });

                    case "key":
                        if (!args[1]) {
                            throw new Error(
                                "Usage: cmatrix key <character-or-sequence>"
                            );
                        }

                        controller.inject({
                            scientific_name: args.slice(1).join(" "),
                            provider: "cmatrix-key"
                        });

                        return write(
                            "Input injected into CMatrix.",
                            "success"
                        );

                    case "clear":
                        controller.clear();
                        return write(
                            "CMatrix canvas cleared.",
                            "success"
                        );

                    case "reset":
                        controller.reset();
                        return write(
                            "CMatrix visualization reset.",
                            "success"
                        );

                    case "preset":
                        if (!value) {
                            return writeJSON({
                                current:
                                    controller.options.preset,
                                available:
                                    Object.keys(PRESETS)
                            });
                        }

                        return writeJSON(
                            controller.applyPreset(value)
                        );

                    case "banks":
                        if (!value) {
                            return writeJSON({
                                active:
                                    controller.options.banks,
                                available:
                                    Object.keys(GLYPH_BANKS)
                            });
                        }

                        return writeJSON({
                            banks:
                                controller.setBanks(
                                    args.slice(1).join(",")
                                )
                        });

                    case "speed":
                        if (value === undefined) {
                            return writeJSON({
                                speed:
                                    controller.options.speed
                            });
                        }

                        controller.update({
                            speed: value
                        });

                        return writeJSON({
                            speed:
                                controller.options.speed
                        });

                    case "density":
                        if (value === undefined) {
                            return writeJSON({
                                density:
                                    controller.options.density
                            });
                        }

                        controller.update({
                            density: value
                        });

                        return writeJSON({
                            density:
                                controller.options.density
                        });

                    case "font-size":
                    case "fontsize":
                        if (value === undefined) {
                            return writeJSON({
                                fontSize:
                                    controller.options.fontSize
                            });
                        }

                        controller.update({
                            fontSize: value
                        });

                        return writeJSON({
                            fontSize:
                                controller.options.fontSize
                        });

                    case "snapshot":
                        return writeJSON(
                            controller.snapshot()
                        );

                    default:
                        throw new Error(
                            `Unknown cmatrix action "${action}". Use status, ` +
                            "start, stop, restart, pause, resume, clear, reset, preset, " +
                            "banks, speed, density, font-size, snapshot, config, args, or key."
                        );
                }
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
        engine: "zmatrix-canvas",
        upstream: "https://github.com/abishekvashok/cmatrix",
        characterSet: CMATRIX_CHARACTERS,
        CMatrixController,
        WeightedGlyphPool,
        GLYPH_BANKS,
        PRESETS,
        mount,
        render,
        initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalCmatrix =
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
