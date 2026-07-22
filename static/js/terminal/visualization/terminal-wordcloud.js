/*
========================================================================
Speciedex.org
Terminal Word Cloud Visualization
========================================================================

Canvas-based, continuously updating, collision-aware word cloud for scientific
names, common names, taxonomic ranks, habitats, providers, geographic terms,
identifiers, statuses, and arbitrary weighted terminal data.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "WordCloud";
    const DEFAULT_MAX_WORDS = 64;
    const DEFAULT_MIN_FONT = 10;
    const DEFAULT_MAX_FONT = 42;
    const DEFAULT_REFRESH = 1200;
    const DEFAULT_OPACITY = 0.46;
    const DEFAULT_ROTATION = 0.10;
    const DEFAULT_PADDING = 3;
    const DEFAULT_ATTEMPTS = 1800;
    const DEFAULT_FOREGROUND = "#c0d674";
    const DEFAULT_HIGHLIGHT = "#eef7c8";
    const DEFAULT_BACKGROUND = "transparent";
    const DEFAULT_FONT_FAMILY =
        '"IBM Plex Mono", "Noto Sans Mono", "Noto Sans CJK JP", ' +
        '"Noto Sans Devanagari", "Noto Sans Tibetan", monospace';

    const DEFAULT_FIELDS = Object.freeze([
        "scientific_name",
        "scientificName",
        "canonical_name",
        "canonicalName",
        "accepted_name",
        "acceptedName",
        "common_name",
        "commonName",
        "vernacular_name",
        "vernacularName",
        "rank",
        "taxon_rank",
        "taxonRank",
        "habitat",
        "biome",
        "ecosystem",
        "country",
        "region",
        "locality",
        "continent",
        "provider",
        "source",
        "dataset",
        "status",
        "taxonomic_status",
        "taxonomicStatus",
        "speciedex_id",
        "speciedexId"
    ]);

    const STOP_WORDS = new Set([
        "a", "an", "and", "are", "as", "at", "be", "by", "for", "from",
        "has", "have", "in", "is", "it", "of", "on", "or", "that", "the",
        "this", "to", "was", "were", "will", "with", "unknown", "none",
        "null", "undefined", "record", "records", "data"
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
            /* Visualization events must never interrupt rendering. */
        }
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
            "WordCloud requires a canvas or container element."
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

    function normalizeText(value) {
        return String(value ?? "")
            .normalize("NFKC")
            .replace(/\s+/g, " ")
            .trim();
    }

    function splitTokens(value, options = {}) {
        const text = normalizeText(value);

        if (!text) {
            return [];
        }

        if (options.preservePhrases === true) {
            return [text];
        }

        return text
            .split(/[\s,;|/\\]+/)
            .map((token) => token.trim())
            .filter(Boolean);
    }

    function seededRandom(seed) {
        let value = 2166136261;

        for (const character of String(seed || "speciedex")) {
            value ^= character.charCodeAt(0);
            value = Math.imul(value, 16777619);
        }

        return function random() {
            value += 0x6D2B79F5;
            let result = value;
            result = Math.imul(result ^ (result >>> 15), result | 1);
            result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
            return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
        };
    }

    function addWord(counts, text, weight = 1, metadata = {}) {
        text = normalizeText(text);

        if (!text) {
            return;
        }

        const normalizedKey = text.toLocaleLowerCase();
        const existing = counts.get(normalizedKey) || {
            text,
            weight: 0,
            count: 0,
            metadata: {
                fields: new Set(),
                sources: new Set()
            }
        };

        existing.weight += parseNumber(weight, 1, 0, Number.MAX_SAFE_INTEGER);
        existing.count += 1;

        if (metadata.field) {
            existing.metadata.fields.add(String(metadata.field));
        }

        if (metadata.source) {
            existing.metadata.sources.add(String(metadata.source));
        }

        if (text.length > existing.text.length) {
            existing.text = text;
        }

        counts.set(normalizedKey, existing);
    }

    function normalizeWords(input, options = {}) {
        const values = typeof input === "function"
            ? input()
            : input;
        const fields = Array.isArray(options.fields) && options.fields.length
            ? options.fields
            : DEFAULT_FIELDS;
        const counts = new Map();
        const iterable = values instanceof Map
            ? Array.from(values.entries()).map(([text, weight]) => ({
                text,
                weight
            }))
            : Array.isArray(values)
                ? values
                : values === undefined || values === null
                    ? []
                    : [values];

        for (const item of iterable) {
            if (item === null || item === undefined) {
                continue;
            }

            if (typeof item === "string" || typeof item === "number") {
                for (const token of splitTokens(item, options)) {
                    addWord(counts, token, 1, {
                        source: "value"
                    });
                }
                continue;
            }

            if (!isObject(item)) {
                continue;
            }

            if (
                item.text !== undefined &&
                (
                    item.weight !== undefined ||
                    item.value !== undefined ||
                    item.count !== undefined
                )
            ) {
                addWord(
                    counts,
                    item.text,
                    item.weight ?? item.value ?? item.count ?? 1,
                    {
                        field: item.field,
                        source: item.source
                    }
                );
                continue;
            }

            for (const field of fields) {
                const value = item[field];

                if (
                    value === undefined ||
                    value === null ||
                    value === ""
                ) {
                    continue;
                }

                const fieldWeight =
                    options.fieldWeights?.[field] ?? 1;

                if (Array.isArray(value)) {
                    for (const entry of value) {
                        for (const token of splitTokens(entry, options)) {
                            addWord(counts, token, fieldWeight, {
                                field,
                                source: item.provider || item.source
                            });
                        }
                    }
                } else {
                    for (const token of splitTokens(value, options)) {
                        addWord(counts, token, fieldWeight, {
                            field,
                            source: item.provider || item.source
                        });
                    }
                }
            }
        }

        const minimumLength = parseNumber(
            options.minimumLength,
            2,
            1,
            100
        );
        const maximumLength = parseNumber(
            options.maximumLength,
            80,
            minimumLength,
            1000
        );
        const stopWords = new Set([
            ...STOP_WORDS,
            ...(options.stopWords || []).map((word) =>
                normalizeText(word).toLocaleLowerCase()
            )
        ]);

        return Array.from(counts.values())
            .filter((word) => {
                const length = Array.from(word.text).length;
                const lower = word.text.toLocaleLowerCase();

                return (
                    length >= minimumLength &&
                    length <= maximumLength &&
                    !stopWords.has(lower)
                );
            })
            .map((word) => ({
                text: word.text,
                weight: word.weight,
                count: word.count,
                metadata: {
                    fields: Array.from(word.metadata.fields),
                    sources: Array.from(word.metadata.sources)
                }
            }))
            .sort((left, right) => {
                return (
                    right.weight - left.weight ||
                    right.count - left.count ||
                    left.text.localeCompare(right.text)
                );
            });
    }

    function rectanglesIntersect(left, right, padding = 0) {
        return !(
            left.x + left.width + padding <= right.x ||
            right.x + right.width + padding <= left.x ||
            left.y + left.height + padding <= right.y ||
            right.y + right.height + padding <= left.y
        );
    }

    class SpatialIndex {
        constructor(width, height, cellSize = 32) {
            this.width = width;
            this.height = height;
            this.cellSize = Math.max(8, cellSize);
            this.cells = new Map();
        }

        _keys(rectangle) {
            const startX = Math.floor(rectangle.x / this.cellSize);
            const endX = Math.floor(
                (rectangle.x + rectangle.width) / this.cellSize
            );
            const startY = Math.floor(rectangle.y / this.cellSize);
            const endY = Math.floor(
                (rectangle.y + rectangle.height) / this.cellSize
            );
            const keys = [];

            for (let x = startX; x <= endX; x += 1) {
                for (let y = startY; y <= endY; y += 1) {
                    keys.push(`${x}:${y}`);
                }
            }

            return keys;
        }

        insert(rectangle) {
            for (const key of this._keys(rectangle)) {
                if (!this.cells.has(key)) {
                    this.cells.set(key, []);
                }

                this.cells.get(key).push(rectangle);
            }
        }

        query(rectangle) {
            const matches = new Set();

            for (const key of this._keys(rectangle)) {
                for (const item of this.cells.get(key) || []) {
                    matches.add(item);
                }
            }

            return Array.from(matches);
        }
    }

    class WordCloudController extends EventTarget {
        constructor(target, options = {}) {
            super();

            this.canvas = resolveCanvas(target);
            this.context = this.canvas.getContext("2d", {
                alpha: true,
                desynchronized: true
            });

            if (!this.context) {
                throw new Error("Unable to acquire WordCloud 2D canvas context.");
            }

            this.options = {
                source: options.source || [],
                fields: options.fields || DEFAULT_FIELDS,
                fieldWeights: {
                    scientific_name: 2.2,
                    scientificName: 2.2,
                    canonical_name: 2.0,
                    canonicalName: 2.0,
                    common_name: 1.8,
                    commonName: 1.8,
                    rank: 1.25,
                    habitat: 1.15,
                    biome: 1.15,
                    provider: 0.9,
                    source: 0.9,
                    country: 1,
                    region: 1,
                    ...(options.fieldWeights || {})
                },
                maxWords: parseNumber(
                    options.maxWords,
                    DEFAULT_MAX_WORDS,
                    1,
                    1000
                ),
                minFont: parseNumber(
                    options.minFont,
                    DEFAULT_MIN_FONT,
                    6,
                    200
                ),
                maxFont: parseNumber(
                    options.maxFont,
                    DEFAULT_MAX_FONT,
                    8,
                    300
                ),
                refresh: parseNumber(
                    options.refresh,
                    DEFAULT_REFRESH,
                    50,
                    3600000
                ),
                opacity: parseNumber(
                    options.opacity,
                    DEFAULT_OPACITY,
                    0.01,
                    1
                ),
                rotation: parseNumber(
                    options.rotation,
                    DEFAULT_ROTATION,
                    0,
                    Math.PI
                ),
                rotationProbability: parseNumber(
                    options.rotationProbability,
                    0.12,
                    0,
                    1
                ),
                padding: parseNumber(
                    options.padding,
                    DEFAULT_PADDING,
                    0,
                    100
                ),
                attempts: parseNumber(
                    options.attempts,
                    DEFAULT_ATTEMPTS,
                    10,
                    100000
                ),
                foreground:
                    options.foreground ||
                    DEFAULT_FOREGROUND,
                highlight:
                    options.highlight ||
                    DEFAULT_HIGHLIGHT,
                background:
                    options.background ||
                    DEFAULT_BACKGROUND,
                fontFamily:
                    options.fontFamily ||
                    DEFAULT_FONT_FAMILY,
                fontWeight:
                    options.fontWeight ||
                    500,
                spiral:
                    options.spiral === "rectangular"
                        ? "rectangular"
                        : "archimedean",
                preservePhrases:
                    options.preservePhrases !== false,
                minimumLength:
                    options.minimumLength ?? 2,
                maximumLength:
                    options.maximumLength ?? 80,
                stopWords:
                    options.stopWords || [],
                seed:
                    options.seed ||
                    "speciedex-wordcloud",
                autoStart:
                    options.autoStart !== false,
                pauseWhenHidden:
                    options.pauseWhenHidden !== false,
                interactive:
                    options.interactive !== false,
                animation:
                    options.animation !== false,
                animationDuration: parseNumber(
                    options.animationDuration,
                    420,
                    0,
                    10000
                )
            };

            if (this.options.maxFont < this.options.minFont) {
                this.options.maxFont = this.options.minFont;
            }

            this.words = [];
            this.layout = [];
            this.previousLayout = [];
            this.running = false;
            this.paused = false;
            this.destroyed = false;
            this.timer = 0;
            this.animationFrame = 0;
            this.animationStartedAt = 0;
            this.hovered = null;
            this.selected = null;
            this.query = "";
            this.lastError = null;
            this.lastRefreshAt = null;
            this.startedAt = null;
            this.watchers = new Set();
            this.metrics = {
                refreshes: 0,
                layouts: 0,
                placed: 0,
                rejected: 0,
                draws: 0,
                clicks: 0,
                hovers: 0,
                resizes: 0,
                errors: 0
            };

            this._boundPointerMove = this._handlePointerMove.bind(this);
            this._boundPointerLeave = this._handlePointerLeave.bind(this);
            this._boundClick = this._handleClick.bind(this);
            this._boundKeydown = this._handleKeydown.bind(this);
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

            this._cleanupResize = createResizeObserver(
                this.canvas,
                () => this.resize()
            );

            document.addEventListener(
                "visibilitychange",
                this._visibilityHandler
            );

            if (this.options.interactive) {
                this.canvas.tabIndex = this.canvas.tabIndex >= 0
                    ? this.canvas.tabIndex
                    : 0;
                this.canvas.setAttribute(
                    "aria-label",
                    "Interactive Speciedex word cloud"
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
                    "click",
                    this._boundClick
                );
                this.canvas.addEventListener(
                    "keydown",
                    this._boundKeydown
                );
            }

            this.resize();
            this.refresh();

            if (this.options.autoStart) {
                this.start();
            }
        }

        _emit(type, detail = {}) {
            const event = {
                type,
                timestamp: iso(),
                ...detail
            };

            safeDispatch(this, type, event);

            for (const watcher of Array.from(this.watchers)) {
                try {
                    watcher(event, this);
                } catch (error) {
                    this._recordError(error);
                }
            }

            return event;
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

            this.metrics.resizes += 1;
            this.layoutWords();
            this.draw();
            this._emit("resize", {
                width: rectangle.width,
                height: rectangle.height
            });
        }

        refresh() {
            if (this.destroyed) {
                return [];
            }

            try {
                const words = normalizeWords(
                    this.options.source,
                    this.options
                ).slice(0, this.options.maxWords);

                this.words = this.query
                    ? words.filter((word) =>
                        word.text
                            .toLocaleLowerCase()
                            .includes(this.query.toLocaleLowerCase())
                    )
                    : words;

                this.previousLayout = this.layout.map(clone);
                this.layoutWords();
                this.lastRefreshAt = iso();
                this.metrics.refreshes += 1;

                if (
                    this.options.animation &&
                    this.options.animationDuration > 0 &&
                    this.previousLayout.length &&
                    this.layout.length
                ) {
                    this.animationStartedAt = performance.now();
                    this.animate();
                } else {
                    this.draw();
                }

                this._emit("refresh", {
                    words: this.words.length,
                    placed: this.layout.length,
                    rejected: Math.max(
                        0,
                        this.words.length - this.layout.length
                    )
                });

                return this.layout.map(clone);
            } catch (error) {
                this._recordError(error);
                return [];
            }
        }

        _fontSize(word, minimum, maximum) {
            const weights = this.words.map((item) => item.weight);
            const minWeight = Math.min(...weights, 1);
            const maxWeight = Math.max(...weights, 1);
            const range = Math.max(1e-9, maxWeight - minWeight);
            const normalized = (word.weight - minWeight) / range;
            const curved = Math.pow(normalized, 0.58);

            return minimum + curved * (maximum - minimum);
        }

        _rotation(index, random) {
            if (random() > this.options.rotationProbability) {
                return 0;
            }

            const direction = index % 2 === 0 ? 1 : -1;
            return this.options.rotation * direction;
        }

        _measure(text, fontSize, rotation) {
            this.context.font =
                `${this.options.fontWeight} ${fontSize}px ${this.options.fontFamily}`;

            const metrics = this.context.measureText(text);
            const width = Math.ceil(
                metrics.actualBoundingBoxLeft +
                metrics.actualBoundingBoxRight ||
                metrics.width
            );
            const height = Math.ceil(
                metrics.actualBoundingBoxAscent +
                metrics.actualBoundingBoxDescent ||
                fontSize * 1.2
            );
            const cosine = Math.abs(Math.cos(rotation));
            const sine = Math.abs(Math.sin(rotation));

            return {
                width: width * cosine + height * sine,
                height: width * sine + height * cosine,
                rawWidth: width,
                rawHeight: height
            };
        }

        _spiralPoint(step, width, height) {
            if (this.options.spiral === "rectangular") {
                const side = Math.ceil(Math.sqrt(step));
                const leg = Math.max(1, side);
                const perimeter = Math.max(1, leg * 4);
                const position = step % perimeter;
                const distance = leg * 4;

                if (position < leg) {
                    return {
                        x: position * 4,
                        y: -distance
                    };
                }

                if (position < leg * 2) {
                    return {
                        x: distance,
                        y: (position - leg) * 4
                    };
                }

                if (position < leg * 3) {
                    return {
                        x: distance - (position - leg * 2) * 4,
                        y: distance
                    };
                }

                return {
                    x: -distance,
                    y: distance - (position - leg * 3) * 4
                };
            }

            const angle = step * 0.34;
            const radius = 1.8 * Math.sqrt(step);

            return {
                x: Math.cos(angle) * radius * (width / Math.max(height, 1)),
                y: Math.sin(angle) * radius
            };
        }

        layoutWords() {
            const width = this.canvas.clientWidth;
            const height = this.canvas.clientHeight;

            if (
                !width ||
                !height ||
                !this.words.length
            ) {
                this.layout = [];
                return [];
            }

            const random = seededRandom(
                `${this.options.seed}:${width}:${height}:${this.words
                    .map((word) => `${word.text}:${word.weight}`)
                    .join("|")}`
            );
            const spatialIndex = new SpatialIndex(
                width,
                height,
                Math.max(24, this.options.maxFont)
            );
            const placed = [];
            const centerX = width / 2;
            const centerY = height / 2;

            this.words.forEach((word, index) => {
                const fontSize = this._fontSize(
                    word,
                    this.options.minFont,
                    this.options.maxFont
                );
                const rotation = this._rotation(index, random);
                const measurement = this._measure(
                    word.text,
                    fontSize,
                    rotation
                );
                let placement = null;

                for (
                    let attempt = 0;
                    attempt < this.options.attempts;
                    attempt += 1
                ) {
                    const point = this._spiralPoint(
                        attempt + index * 7,
                        width,
                        height
                    );
                    const jitterX =
                        (random() - 0.5) *
                        Math.min(14, fontSize * 0.35);
                    const jitterY =
                        (random() - 0.5) *
                        Math.min(14, fontSize * 0.35);
                    const rectangle = {
                        x:
                            centerX +
                            point.x +
                            jitterX -
                            measurement.width / 2,
                        y:
                            centerY +
                            point.y +
                            jitterY -
                            measurement.height / 2,
                        width: measurement.width,
                        height: measurement.height
                    };

                    if (
                        rectangle.x < 0 ||
                        rectangle.y < 0 ||
                        rectangle.x + rectangle.width > width ||
                        rectangle.y + rectangle.height > height
                    ) {
                        continue;
                    }

                    const collisions = spatialIndex.query(rectangle);

                    if (
                        collisions.some((existing) =>
                            rectanglesIntersect(
                                rectangle,
                                existing,
                                this.options.padding
                            )
                        )
                    ) {
                        continue;
                    }

                    placement = {
                        ...rectangle,
                        text: word.text,
                        weight: word.weight,
                        count: word.count,
                        metadata: clone(word.metadata),
                        fontSize,
                        rotation,
                        centerX:
                            rectangle.x +
                            rectangle.width / 2,
                        centerY:
                            rectangle.y +
                            rectangle.height / 2,
                        rawWidth: measurement.rawWidth,
                        rawHeight: measurement.rawHeight,
                        index,
                        alpha: Math.min(
                            1,
                            this.options.opacity +
                            (fontSize / this.options.maxFont) * 0.36
                        )
                    };

                    spatialIndex.insert(placement);
                    placed.push(placement);
                    break;
                }

                if (!placement) {
                    this.metrics.rejected += 1;
                }
            });

            this.layout = placed;
            this.metrics.layouts += 1;
            this.metrics.placed += placed.length;

            return placed.map(clone);
        }

        _drawBackground() {
            const width = this.canvas.clientWidth;
            const height = this.canvas.clientHeight;

            this.context.clearRect(0, 0, width, height);

            if (
                this.options.background &&
                this.options.background !== "transparent"
            ) {
                this.context.fillStyle = this.options.background;
                this.context.fillRect(0, 0, width, height);
            }
        }

        _drawPlacement(placement, progress = 1) {
            const hovered =
                this.hovered?.text === placement.text;
            const selected =
                this.selected?.text === placement.text;
            const alpha = placement.alpha *
                (hovered || selected ? 1 : 0.88) *
                progress;

            this.context.save();
            this.context.translate(
                placement.centerX,
                placement.centerY
            );
            this.context.rotate(placement.rotation);
            this.context.font =
                `${hovered || selected ? 700 : this.options.fontWeight} ` +
                `${placement.fontSize * progress}px ${this.options.fontFamily}`;
            this.context.textAlign = "center";
            this.context.textBaseline = "middle";
            this.context.globalAlpha = alpha;
            this.context.fillStyle =
                hovered || selected
                    ? this.options.highlight
                    : this.options.foreground;

            if (hovered || selected) {
                this.context.shadowColor = this.options.foreground;
                this.context.shadowBlur = 8;
            }

            this.context.fillText(
                placement.text,
                0,
                0
            );
            this.context.restore();
        }

        draw(progress = 1) {
            if (this.destroyed) {
                return;
            }

            this._drawBackground();

            for (const placement of this.layout) {
                this._drawPlacement(
                    placement,
                    progress
                );
            }

            this.metrics.draws += 1;
        }

        animate(timestamp = performance.now()) {
            if (
                this.destroyed ||
                !this.options.animation
            ) {
                return;
            }

            const elapsed =
                timestamp - this.animationStartedAt;
            const progress = Math.min(
                1,
                elapsed /
                Math.max(
                    1,
                    this.options.animationDuration
                )
            );
            const eased =
                1 - Math.pow(1 - progress, 3);

            this.draw(eased);

            if (progress < 1) {
                this.animationFrame =
                    window.requestAnimationFrame(
                        (nextTimestamp) =>
                            this.animate(nextTimestamp)
                    );
            } else {
                this.animationFrame = 0;
            }
        }

        _pointFromEvent(event) {
            const rectangle =
                this.canvas.getBoundingClientRect();

            return {
                x: event.clientX - rectangle.left,
                y: event.clientY - rectangle.top
            };
        }

        hitTest(x, y) {
            for (
                let index = this.layout.length - 1;
                index >= 0;
                index -= 1
            ) {
                const placement = this.layout[index];

                if (
                    x >= placement.x &&
                    x <= placement.x + placement.width &&
                    y >= placement.y &&
                    y <= placement.y + placement.height
                ) {
                    return placement;
                }
            }

            return null;
        }

        _handlePointerMove(event) {
            const point = this._pointFromEvent(event);
            const hovered = this.hitTest(point.x, point.y);
            const changed =
                hovered?.text !== this.hovered?.text;

            this.hovered = hovered;

            if (changed) {
                this.metrics.hovers += 1;
                this.canvas.style.cursor =
                    hovered ? "pointer" : "default";
                this.draw();

                this._emit("hover", {
                    word: hovered
                        ? clone(hovered)
                        : null
                });
            }
        }

        _handlePointerLeave() {
            if (!this.hovered) {
                return;
            }

            this.hovered = null;
            this.canvas.style.cursor = "default";
            this.draw();
            this._emit("hover", {
                word: null
            });
        }

        _handleClick(event) {
            const point = this._pointFromEvent(event);
            const selected = this.hitTest(point.x, point.y);

            this.selected =
                selected?.text === this.selected?.text
                    ? null
                    : selected;
            this.metrics.clicks += 1;
            this.draw();

            this._emit("select", {
                word: this.selected
                    ? clone(this.selected)
                    : null
            });
        }

        _handleKeydown(event) {
            if (!this.layout.length) {
                return;
            }

            const currentIndex = this.selected
                ? this.layout.findIndex(
                    (item) => item.text === this.selected.text
                )
                : -1;

            if (
                event.key === "ArrowRight" ||
                event.key === "ArrowDown"
            ) {
                event.preventDefault();
                const next =
                    (currentIndex + 1) %
                    this.layout.length;
                this.selected = this.layout[next];
                this.draw();
            } else if (
                event.key === "ArrowLeft" ||
                event.key === "ArrowUp"
            ) {
                event.preventDefault();
                const previous =
                    (currentIndex - 1 + this.layout.length) %
                    this.layout.length;
                this.selected = this.layout[previous];
                this.draw();
            } else if (
                event.key === "Enter" ||
                event.key === " "
            ) {
                event.preventDefault();

                if (this.selected) {
                    this._emit("select", {
                        word: clone(this.selected)
                    });
                }
            } else if (event.key === "Escape") {
                this.selected = null;
                this.draw();
            }
        }

        push(value, weight = 1) {
            const current = typeof this.options.source === "function"
                ? normalizeWords(
                    this.options.source,
                    this.options
                ).map((item) => ({
                    text: item.text,
                    weight: item.weight
                }))
                : Array.isArray(this.options.source)
                    ? [...this.options.source]
                    : [];

            if (isObject(value) && value.text !== undefined) {
                current.push({
                    ...value,
                    weight:
                        value.weight ??
                        value.value ??
                        value.count ??
                        weight
                });
            } else {
                current.push({
                    text: value,
                    weight
                });
            }

            this.options.source = current;
            return this.refresh();
        }

        pushMany(values = []) {
            const current = Array.isArray(this.options.source)
                ? [...this.options.source]
                : [];

            current.push(...values);
            this.options.source = current;
            return this.refresh();
        }

        setSource(source) {
            this.options.source = source || [];
            return this.refresh();
        }

        setFilter(query = "") {
            this.query = normalizeText(query);
            return this.refresh();
        }

        clear(options = {}) {
            this.words = [];
            this.layout = [];
            this.previousLayout = [];
            this.hovered = null;
            this.selected = null;

            if (options.source !== false) {
                this.options.source = [];
            }

            this.draw();
            this._emit("clear", {});
            return true;
        }

        start() {
            if (this.destroyed) {
                throw new Error(
                    "WordCloud controller has been destroyed."
                );
            }

            if (this.running && !this.paused) {
                return this;
            }

            this.stop({
                silent: true
            });

            this.running = true;
            this.paused = false;
            this.startedAt =
                this.startedAt || iso();

            this.timer = window.setInterval(
                () => {
                    if (!this.paused) {
                        this.refresh();
                    }
                },
                this.options.refresh
            );

            this._emit("start", {
                refresh: this.options.refresh
            });

            return this;
        }

        stop(options = {}) {
            const wasRunning =
                this.running || this.paused;

            this.running = false;
            this.paused = false;

            if (this.timer) {
                window.clearInterval(this.timer);
                this.timer = 0;
            }

            if (this.animationFrame) {
                window.cancelAnimationFrame(
                    this.animationFrame
                );
                this.animationFrame = 0;
            }

            if (
                wasRunning &&
                options.silent !== true
            ) {
                this._emit("stop", {});
            }

            return this;
        }

        pause(options = {}) {
            if (!this.running || this.paused) {
                return false;
            }

            this.paused = true;

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

            if (options.automatic !== true) {
                this._emit("resume", {});
            }

            return true;
        }

        update(options = {}) {
            if (!isObject(options)) {
                throw new TypeError(
                    "WordCloud options must be an object."
                );
            }

            const restart =
                options.refresh !== undefined &&
                this.running;

            Object.assign(this.options, {
                source:
                    options.source !== undefined
                        ? options.source
                        : this.options.source,
                fields:
                    options.fields ||
                    this.options.fields,
                fieldWeights: {
                    ...this.options.fieldWeights,
                    ...(options.fieldWeights || {})
                },
                maxWords:
                    options.maxWords !== undefined
                        ? parseNumber(
                            options.maxWords,
                            this.options.maxWords,
                            1,
                            1000
                        )
                        : this.options.maxWords,
                minFont:
                    options.minFont !== undefined
                        ? parseNumber(
                            options.minFont,
                            this.options.minFont,
                            6,
                            200
                        )
                        : this.options.minFont,
                maxFont:
                    options.maxFont !== undefined
                        ? parseNumber(
                            options.maxFont,
                            this.options.maxFont,
                            8,
                            300
                        )
                        : this.options.maxFont,
                refresh:
                    options.refresh !== undefined
                        ? parseNumber(
                            options.refresh,
                            this.options.refresh,
                            50,
                            3600000
                        )
                        : this.options.refresh,
                opacity:
                    options.opacity !== undefined
                        ? parseNumber(
                            options.opacity,
                            this.options.opacity,
                            0.01,
                            1
                        )
                        : this.options.opacity,
                rotation:
                    options.rotation !== undefined
                        ? parseNumber(
                            options.rotation,
                            this.options.rotation,
                            0,
                            Math.PI
                        )
                        : this.options.rotation,
                rotationProbability:
                    options.rotationProbability !== undefined
                        ? parseNumber(
                            options.rotationProbability,
                            this.options.rotationProbability,
                            0,
                            1
                        )
                        : this.options.rotationProbability,
                padding:
                    options.padding !== undefined
                        ? parseNumber(
                            options.padding,
                            this.options.padding,
                            0,
                            100
                        )
                        : this.options.padding,
                attempts:
                    options.attempts !== undefined
                        ? parseNumber(
                            options.attempts,
                            this.options.attempts,
                            10,
                            100000
                        )
                        : this.options.attempts,
                foreground:
                    options.foreground ||
                    this.options.foreground,
                highlight:
                    options.highlight ||
                    this.options.highlight,
                background:
                    options.background ||
                    this.options.background,
                fontFamily:
                    options.fontFamily ||
                    this.options.fontFamily,
                fontWeight:
                    options.fontWeight ||
                    this.options.fontWeight,
                spiral:
                    options.spiral ||
                    this.options.spiral,
                preservePhrases:
                    options.preservePhrases !== undefined
                        ? Boolean(options.preservePhrases)
                        : this.options.preservePhrases,
                stopWords:
                    options.stopWords ||
                    this.options.stopWords,
                seed:
                    options.seed ||
                    this.options.seed,
                animation:
                    options.animation !== undefined
                        ? Boolean(options.animation)
                        : this.options.animation,
                animationDuration:
                    options.animationDuration !== undefined
                        ? parseNumber(
                            options.animationDuration,
                            this.options.animationDuration,
                            0,
                            10000
                        )
                        : this.options.animationDuration
            });

            if (this.options.maxFont < this.options.minFont) {
                this.options.maxFont = this.options.minFont;
            }

            if (restart) {
                this.start();
            }

            this.refresh();

            this._emit("update", {
                options: clone(this.options)
            });

            return this;
        }

        export(format = "json") {
            const normalized = String(format).toLowerCase();

            if (normalized === "json") {
                return JSON.stringify(
                    {
                        generatedAt: iso(),
                        words: this.words,
                        layout: this.layout
                    },
                    null,
                    2
                );
            }

            if (normalized === "csv") {
                const rows = [
                    ["text", "weight", "count", "x", "y", "fontSize", "rotation"]
                ];

                for (const item of this.layout) {
                    rows.push([
                        item.text,
                        item.weight,
                        item.count,
                        item.x,
                        item.y,
                        item.fontSize,
                        item.rotation
                    ]);
                }

                return rows
                    .map((row) =>
                        row.map((value) => {
                            const text = String(value ?? "");

                            return /[",\n\r]/.test(text)
                                ? `"${text.replace(/"/g, '""')}"`
                                : text;
                        }).join(",")
                    )
                    .join("\r\n");
            }

            if (normalized === "png") {
                return this.canvas.toDataURL("image/png");
            }

            throw new Error(
                `Unsupported WordCloud export format: ${format}`
            );
        }

        watch(callback, options = {}) {
            if (typeof callback !== "function") {
                throw new TypeError(
                    "WordCloud watcher must be a function."
                );
            }

            this.watchers.add(callback);

            if (options.immediate === true) {
                callback({
                    type: "initial",
                    timestamp: iso(),
                    status: this.status()
                }, this);
            }

            return () => this.watchers.delete(callback);
        }

        status() {
            return {
                name: "wordcloud",
                module: MODULE_NAME,
                running: this.running,
                paused: this.paused,
                startedAt: this.startedAt,
                lastRefreshAt: this.lastRefreshAt,
                words: this.words.length,
                placed: this.layout.length,
                selected: this.selected
                    ? clone(this.selected)
                    : null,
                hovered: this.hovered
                    ? clone(this.hovered)
                    : null,
                query: this.query,
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

            this.stop({
                silent: true
            });
            document.removeEventListener(
                "visibilitychange",
                this._visibilityHandler
            );
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
                    "click",
                    this._boundClick
                );
                this.canvas.removeEventListener(
                    "keydown",
                    this._boundKeydown
                );
            }

            this.watchers.clear();
            this.words = [];
            this.layout = [];
            this.destroyed = true;
            this._emit("destroy", {});
            return true;
        }
    }

    function mount(target, options = {}) {
        return new WordCloudController(
            target,
            options
        );
    }

    function render(data = [], options = {}) {
        const container =
            document.createElement("section");

        container.className =
            "terminal-visualization terminal-visualization-wordcloud";
        container.dataset.visualization =
            "wordcloud";
        container.setAttribute(
            "role",
            "region"
        );
        container.setAttribute(
            "aria-label",
            options.label ||
            "Speciedex word cloud"
        );

        const canvas =
            document.createElement("canvas");
        canvas.className =
            "terminal-wordcloud-canvas";
        canvas.setAttribute(
            "aria-label",
            options.label ||
            "Speciedex word cloud"
        );

        const status =
            document.createElement("div");
        status.className =
            "terminal-wordcloud-status";
        status.setAttribute(
            "aria-live",
            "polite"
        );

        container.append(
            canvas,
            status
        );

        const controller = mount(
            canvas,
            {
                source: data,
                ...options
            }
        );

        const updateStatus = () => {
            const snapshot =
                controller.status();

            status.textContent =
                `${snapshot.placed} of ${snapshot.words} terms placed` +
                (snapshot.query
                    ? ` · filter: ${snapshot.query}`
                    : "");
        };

        for (const eventName of [
            "refresh",
            "resize",
            "update",
            "select",
            "clear"
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
            context.config?.wordcloud || {};

        const defaults = {
            maxWords:
                dataset.terminalWordcloudMaxWords ||
                config.maxWords ||
                DEFAULT_MAX_WORDS,

            minFont:
                dataset.terminalWordcloudMinFont ||
                config.minFont ||
                DEFAULT_MIN_FONT,

            maxFont:
                dataset.terminalWordcloudMaxFont ||
                config.maxFont ||
                DEFAULT_MAX_FONT,

            refresh:
                dataset.terminalWordcloudRefresh ||
                config.refresh ||
                DEFAULT_REFRESH,

            opacity:
                dataset.terminalWordcloudOpacity ||
                config.opacity ||
                DEFAULT_OPACITY,

            rotation:
                dataset.terminalWordcloudRotation ||
                config.rotation ||
                DEFAULT_ROTATION,

            foreground:
                dataset.terminalWordcloudForeground ||
                config.foreground ||
                DEFAULT_FOREGROUND,

            highlight:
                dataset.terminalWordcloudHighlight ||
                config.highlight ||
                DEFAULT_HIGHLIGHT,

            background:
                dataset.terminalWordcloudBackground ||
                config.background ||
                DEFAULT_BACKGROUND,

            fontFamily:
                dataset.terminalWordcloudFontFamily ||
                config.fontFamily ||
                DEFAULT_FONT_FAMILY,

            preservePhrases: parseBoolean(
                dataset.terminalWordcloudPreservePhrases,
                config.preservePhrases !== false
            ),

            interactive: parseBoolean(
                dataset.terminalWordcloudInteractive,
                config.interactive !== false
            ),

            animation: parseBoolean(
                dataset.terminalWordcloudAnimation,
                config.animation !== false
            ),

            pauseWhenHidden: parseBoolean(
                dataset.terminalWordcloudPauseWhenHidden,
                config.pauseWhenHidden !== false
            ),

            fields:
                config.fields ||
                DEFAULT_FIELDS,

            fieldWeights:
                config.fieldWeights || {}
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
                WordCloudController,

            normalizeWords,

            SpatialIndex
        };

        context.registerVisualization?.(
            "wordcloud",
            visualization
        );

        context.registerRenderer?.(
            "wordcloud",
            visualization
        );

        context.wordcloud =
            visualization;

        safeDispatch(
            document,
            "speciedex:terminal-wordcloud-ready",
            {
                visualization
            }
        );

        return visualization;
    }

    const commands = [{
        name: "wordcloud",
        category: "visualization",
        description:
            "Render and control collision-aware word clouds from terminal collections.",
        usage:
            "wordcloud [collection|status|start|stop|pause|resume|refresh|" +
            "clear|filter|export]",
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
            const lowerAction =
                action.toLowerCase();
            const controller =
                context.terminalSplash?.
                    wordCloudController ||
                context.wordcloudController;

            try {
                if (controller) {
                    switch (lowerAction) {
                        case "status":
                            return writeJSON(
                                controller.status()
                            );

                        case "start":
                            controller.start();
                            return write(
                                "Word cloud started.",
                                "success"
                            );

                        case "stop":
                            controller.stop();
                            return write(
                                "Word cloud stopped.",
                                "success"
                            );

                        case "pause":
                            controller.pause();
                            return write(
                                "Word cloud paused.",
                                "success"
                            );

                        case "resume":
                            controller.resume();
                            return write(
                                "Word cloud resumed.",
                                "success"
                            );

                        case "refresh":
                            controller.refresh();
                            return writeJSON(
                                controller.status()
                            );

                        case "clear":
                            controller.clear();
                            return write(
                                "Word cloud cleared.",
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

                const collection = action;
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
                        ...context.config?.wordcloud,
                        label:
                            `Word cloud for ${collection}`
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
        WordCloudController,
        SpatialIndex,
        normalizeWords,
        mount,
        render,
        initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalWordCloud =
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
