/*
========================================================================
Speciedex.org
Terminal Word Cloud Visualization
========================================================================

Canvas-based, continuously updating, collision-aware word cloud.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/
(function (window, document) {
    "use strict";

    const MODULE_NAME = "WordCloud";
    const VERSION = "2.2.0";

    const VISUALIZATION_SYMBOL =
        Symbol.for(
            "speciedex.terminal.wordcloud.visualization"
        );

    const CONTROLLER_SYMBOL =
        Symbol.for(
            "speciedex.terminal.wordcloud.controller"
        );
    const DEFAULT_FIELDS = Object.freeze([
        "scientific_name", "scientificName", "canonical_name", "canonicalName",
        "accepted_name", "acceptedName", "common_name", "commonName",
        "vernacular_name", "vernacularName", "rank", "taxon_rank", "taxonRank",
        "habitat", "biome", "ecosystem", "country", "region", "locality",
        "continent", "provider", "source", "dataset", "status",
        "taxonomic_status", "taxonomicStatus", "speciedex_id", "speciedexId"
    ]);
    const STOP_WORDS = new Set([
        "a", "an", "and", "are", "as", "at", "be", "by", "for", "from",
        "has", "have", "in", "is", "it", "of", "on", "or", "that", "the",
        "this", "to", "was", "were", "will", "with", "unknown", "none",
        "null", "undefined", "record", "records", "data"
    ]);
    const DEFAULTS = Object.freeze({
        maxWords: 64,
        minFont: 10,
        maxFont: 42,
        refresh: 1200,
        opacity: 0.46,
        rotation: 0.10,
        rotationProbability: 0.12,
        padding: 3,
        attempts: 1800,
        foreground: "#c0d674",
        highlight: "#eef7c8",
        background: "transparent",
        fontFamily: '"IBM Plex Mono", "Noto Sans Mono", "Noto Sans CJK JP", "Noto Sans Devanagari", "Noto Sans Tibetan", monospace',
        fontWeight: 500,
        animationDuration: 420,
        maxPixelRatio: 2
    });

    function text(value) {
        return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
    }

    function number(value, fallback, min = -Infinity, max = Infinity) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
    }

    function bool(value, fallback = false) {
        if (typeof value === "boolean") return value;
        if (value === undefined || value === null || value === "") return fallback;
        const normalized = String(value).trim().toLowerCase();
        if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
        if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
        return fallback;
    }

    function clone(
        value,
        seen =
            new WeakMap(),
        depth =
            0
    ) {
        if (
            value ===
                null ||
            value ===
                undefined ||
            typeof value !==
                "object"
        ) {
            return value;
        }

        if (
            depth >
            32
        ) {
            return "[Truncated]";
        }

        if (
            typeof structuredClone ===
                "function"
        ) {
            try {
                return structuredClone(
                    value
                );
            } catch (_error) {
                /* Continue with deterministic fallback. */
            }
        }

        if (
            seen.has(
                value
            )
        ) {
            return "[Circular]";
        }

        seen.set(
            value,
            true
        );

        if (
            value instanceof
                Date
        ) {
            return Number.isNaN(
                value.getTime()
            )
                ? "Invalid Date"
                : value.toISOString();
        }

        if (
            value instanceof
                Error
        ) {
            return {
                name:
                    value.name,
                message:
                    value.message,
                stack:
                    value.stack ||
                    ""
            };
        }

        if (
            Array.isArray(
                value
            )
        ) {
            return value.map(
                item =>
                    clone(
                        item,
                        seen,
                        depth +
                            1
                    )
            );
        }

        if (
            value instanceof
                Map
        ) {
            const output =
                {};

            for (
                const [
                    key,
                    item
                ] of value
            ) {
                output[
                    String(
                        key
                    )
                ] =
                    clone(
                        item,
                        seen,
                        depth +
                            1
                    );
            }

            return output;
        }

        if (
            value instanceof
                Set
        ) {
            return [
                ...value
            ].map(
                item =>
                    clone(
                        item,
                        seen,
                        depth +
                            1
                    )
            );
        }

        const output =
            {};

        for (
            const [
                key,
                item
            ] of Object.entries(
                value
            )
        ) {
            if (
                [
                    "__proto__",
                    "prototype",
                    "constructor"
                ].includes(
                    key
                )
            ) {
                continue;
            }

            output[
                key
            ] =
                clone(
                    item,
                    seen,
                    depth +
                        1
                );
        }

        return output;
    }

    function dispatch(target, name, detail) {
        if (!target || typeof target.dispatchEvent !== "function") return false;
        try { return target.dispatchEvent(new CustomEvent(name, { detail })); }
        catch (_error) { return false; }
    }

    function isObject(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    function extractText(value) {
        if (typeof value === "string" || typeof value === "number") return text(value);
        if (!isObject(value)) return "";
        return text(
            value.text ?? value.label ?? value.name ?? value.scientific_name ??
            value.scientificName ?? value.canonical_name ?? value.canonicalName ??
            value.common_name ?? value.commonName ?? value.value ?? ""
        );
    }

    function splitTokens(value, options = {}) {
        const normalized = extractText(value);
        if (!normalized) return [];
        if (options.preservePhrases === true) return [normalized];
        return normalized.split(/[\s,;|/\\]+/).map(text).filter(Boolean);
    }

    function normalizeStopWords(value) {
        if (value instanceof Set) return Array.from(value);
        if (Array.isArray(value)) return value;
        if (value === undefined || value === null || value === "") return [];
        return String(value).split(/[\s,;|]+/);
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

    function addWord(counts, value, weight = 1, metadata = {}) {
        const wordText = extractText(value);
        if (!wordText) return;
        const lookup = wordText.toLocaleLowerCase();
        const current = counts.get(lookup) || {
            text: wordText,
            weight: 0,
            count: 0,
            metadata: { fields: new Set(), sources: new Set() }
        };
        current.weight += number(weight, 1, 0, Number.MAX_SAFE_INTEGER);
        current.count += 1;
        if (metadata.field) current.metadata.fields.add(String(metadata.field));
        if (metadata.source) current.metadata.sources.add(String(metadata.source));
        if (wordText.length > current.text.length) current.text = wordText;
        counts.set(lookup, current);
    }

    function normalizeWords(input, options = {}) {
        const values = typeof input === "function" ? input() : input;
        const fields = Array.isArray(options.fields) && options.fields.length ? options.fields : DEFAULT_FIELDS;
        const counts = new Map();
        const iterable = values instanceof Map
            ? Array.from(values.entries()).map(([wordText, weight]) => ({ text: wordText, weight }))
            : Array.isArray(values) ? values : values == null ? [] : [values];

        for (const item of iterable) {
            if (item == null) continue;
            if (typeof item === "string" || typeof item === "number") {
                splitTokens(item, options).forEach((token) => addWord(counts, token, 1, { source: "value" }));
                continue;
            }
            if (!isObject(item)) continue;

            /* Fixed: plain {text: "..."} records no longer require a weight field. */
            if (item.text !== undefined) {
                addWord(counts, item.text, item.weight ?? item.value ?? item.count ?? 1, {
                    field: item.field,
                    source: item.source
                });
                continue;
            }

            for (const field of fields) {
                const value = item[field];
                if (value === undefined || value === null || value === "") continue;
                const fieldWeight = options.fieldWeights?.[field] ?? 1;
                const entries = Array.isArray(value) ? value : [value];
                for (const entry of entries) {
                    const entryWeight = isObject(entry)
                        ? entry.weight ?? entry.count ?? fieldWeight
                        : fieldWeight;
                    splitTokens(entry, options).forEach((token) => addWord(counts, token, entryWeight, {
                        field,
                        source: item.provider ?? item.source ?? (isObject(entry) ? entry.source : "")
                    }));
                }
            }
        }

        const minimumLength = number(options.minimumLength, 2, 1, 100);
        const maximumLength = number(options.maximumLength, 80, minimumLength, 1000);
        const stopWords = new Set([
            ...STOP_WORDS,
            ...normalizeStopWords(options.stopWords).map((word) => text(word).toLocaleLowerCase())
        ]);

        return Array.from(counts.values())
            .filter((word) => {
                const length = Array.from(word.text).length;
                return length >= minimumLength && length <= maximumLength &&
                    !stopWords.has(word.text.toLocaleLowerCase());
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
            .sort((a, b) => b.weight - a.weight || b.count - a.count || a.text.localeCompare(b.text));
    }

    function intersects(a, b, padding = 0) {
        return !(a.x + a.width + padding <= b.x || b.x + b.width + padding <= a.x ||
            a.y + a.height + padding <= b.y || b.y + b.height + padding <= a.y);
    }

    class SpatialIndex {
        constructor(width, height, cellSize = 32) {
            this.width = width;
            this.height = height;
            this.cellSize = Math.max(8, cellSize);
            this.cells = new Map();
        }
        _keys(rect) {
            const epsilon = 1e-9;
            const sx = Math.floor(rect.x / this.cellSize);
            const ex = Math.floor((rect.x + Math.max(0, rect.width - epsilon)) / this.cellSize);
            const sy = Math.floor(rect.y / this.cellSize);
            const ey = Math.floor((rect.y + Math.max(0, rect.height - epsilon)) / this.cellSize);
            const keys = [];
            for (let x = sx; x <= ex; x += 1) for (let y = sy; y <= ey; y += 1) keys.push(`${x}:${y}`);
            return keys;
        }
        insert(rect) {
            for (const lookup of this._keys(rect)) {
                if (!this.cells.has(lookup)) this.cells.set(lookup, []);
                this.cells.get(lookup).push(rect);
            }
        }
        query(rect) {
            const matches = new Set();
            for (const lookup of this._keys(rect)) {
                for (const item of this.cells.get(lookup) || []) matches.add(item);
            }
            return Array.from(matches);
        }
    }

    function resolveCanvas(target) {
        if (typeof HTMLCanvasElement !== "undefined" && target instanceof HTMLCanvasElement) return target;
        if (typeof Element !== "undefined" && target instanceof Element) {
            const existing = target.querySelector("canvas");
            if (existing) return existing;
            const canvas = document.createElement("canvas");
            target.appendChild(canvas);
            return canvas;
        }
        throw new TypeError("WordCloud requires a canvas or container element.");
    }

    function observeResize(
        canvas,
        callback
    ) {
        const observed =
            canvas.parentElement &&
            canvas.parentElement !==
                document.body
                ? canvas.parentElement
                : canvas;

        let frame =
            0;

        let lastWidth =
            -1;

        let lastHeight =
            -1;

        const schedule =
            () => {
                if (frame) {
                    return;
                }

                frame =
                    window.requestAnimationFrame(
                        () => {
                            frame =
                                0;

                            const rect =
                                observed.getBoundingClientRect();

                            const width =
                                Math.round(
                                    rect.width *
                                    100
                                ) /
                                100;

                            const height =
                                Math.round(
                                    rect.height *
                                    100
                                ) /
                                100;

                            if (
                                width ===
                                    lastWidth &&
                                height ===
                                    lastHeight
                            ) {
                                return;
                            }

                            lastWidth =
                                width;

                            lastHeight =
                                height;

                            callback();
                        }
                    );
            };

        if (
            typeof ResizeObserver ===
                "function"
        ) {
            const observer =
                new ResizeObserver(
                    schedule
                );

            observer.observe(
                observed
            );

            return () => {
                observer.disconnect();

                if (frame) {
                    window.cancelAnimationFrame(
                        frame
                    );

                    frame =
                        0;
                }
            };
        }

        window.addEventListener(
            "resize",
            schedule
        );

        return () => {
            window.removeEventListener(
                "resize",
                schedule
            );

            if (frame) {
                window.cancelAnimationFrame(
                    frame
                );
            }
        };
    }

    class WordCloudController extends EventTarget {
        constructor(target, options = {}) {
            super();
            this.canvas = resolveCanvas(target);
            this.context = this.canvas.getContext("2d", { alpha: true, desynchronized: true });
            if (!this.context) throw new Error("Unable to acquire WordCloud 2D canvas context.");

            this.options = {
                source: options.source ?? [],
                fields: options.fields || DEFAULT_FIELDS,
                fieldWeights: {
                    scientific_name: 2.2, scientificName: 2.2,
                    canonical_name: 2.0, canonicalName: 2.0,
                    common_name: 1.8, commonName: 1.8,
                    rank: 1.25, habitat: 1.15, biome: 1.15,
                    provider: 0.9, source: 0.9, country: 1, region: 1,
                    ...(options.fieldWeights || {})
                },
                maxWords: Math.floor(number(options.maxWords, DEFAULTS.maxWords, 1, 1000)),
                minFont: number(options.minFont, DEFAULTS.minFont, 6, 200),
                maxFont: number(options.maxFont, DEFAULTS.maxFont, 8, 300),
                refresh: number(options.refresh, DEFAULTS.refresh, 50, 3600000),
                opacity: number(options.opacity, DEFAULTS.opacity, 0.01, 1),
                rotation: number(options.rotation, DEFAULTS.rotation, 0, Math.PI),
                rotationProbability: number(options.rotationProbability, DEFAULTS.rotationProbability, 0, 1),
                padding: number(options.padding, DEFAULTS.padding, 0, 100),
                attempts: Math.floor(number(options.attempts, DEFAULTS.attempts, 10, 100000)),
                foreground: options.foreground || DEFAULTS.foreground,
                highlight: options.highlight || DEFAULTS.highlight,
                background: options.background ?? DEFAULTS.background,
                fontFamily: options.fontFamily || DEFAULTS.fontFamily,
                fontWeight: options.fontWeight ?? DEFAULTS.fontWeight,
                spiral: options.spiral === "rectangular" ? "rectangular" : "archimedean",
                preservePhrases: options.preservePhrases !== false,
                minimumLength: options.minimumLength ?? 2,
                maximumLength: options.maximumLength ?? 80,
                stopWords: options.stopWords || [],
                seed: options.seed || "speciedex-wordcloud",
                autoStart: options.autoStart !== false,
                pauseWhenHidden: options.pauseWhenHidden !== false,
                interactive: options.interactive !== false,
                animation: options.animation !== false,
                animationDuration: number(options.animationDuration, DEFAULTS.animationDuration, 0, 10000),
                maxPixelRatio: number(options.maxPixelRatio, DEFAULTS.maxPixelRatio, 1, 4)
            };
            if (this.options.maxFont < this.options.minFont) this.options.maxFont = this.options.minFont;

            this.words = [];
            this.layout = [];
            this.previousLayout = [];
            this.running = false;
            this.paused = false;
            this.autoPaused = false;
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
            this.watchers =
                new Set();

            this.emitting =
                false;

            this.refreshing =
                false;

            this.pendingRefresh =
                false;

            this.resizeFrame =
                0;

            this.lastWidth =
                0;

            this.lastHeight =
                0;

            this.abortController =
                new AbortController();

            this.metrics = {
                refreshes:
                    0,
                layouts:
                    0,
                placed:
                    0,
                rejected:
                    0,
                draws:
                    0,
                clicks:
                    0,
                hovers:
                    0,
                resizes:
                    0,
                errors:
                    0,
                watcherErrors:
                    0,
                skippedResizes:
                    0,
                coalescedRefreshes:
                    0
            };

            this._move = this._handlePointerMove.bind(this);
            this._leave = this._handlePointerLeave.bind(this);
            this._click = this._handleClick.bind(this);
            this._keydown = this._handleKeydown.bind(this);
            this._visibility = () => {
                if (!this.options.pauseWhenHidden) return;
                if (document.visibilityState === "hidden") {
                    if (this.running && !this.paused) {
                        this.autoPaused = true;
                        this.pause({ automatic: true });
                    }
                } else if (this.running && this.paused && this.autoPaused) {
                    this.resume({ automatic: true });
                }
            };

            this.canvas[
                CONTROLLER_SYMBOL
            ] =
                this;

            this.canvas.wordCloudController =
                this;

            this._cleanupResize =
                observeResize(
                    this.canvas,
                    () =>
                        this.resize()
                );

            const signal =
                this.abortController.signal;

            document.addEventListener(
                "visibilitychange",
                this._visibility,
                {
                    signal
                }
            );

            if (this.options.interactive) {
                this.canvas.tabIndex = this.canvas.tabIndex >= 0 ? this.canvas.tabIndex : 0;
                this.canvas.setAttribute("aria-label", "Interactive Speciedex word cloud");
                this.canvas.addEventListener(
                    "pointermove",
                    this._move,
                    {
                        signal,
                        passive:
                            true
                    }
                );

                this.canvas.addEventListener(
                    "pointerleave",
                    this._leave,
                    {
                        signal,
                        passive:
                            true
                    }
                );

                this.canvas.addEventListener(
                    "click",
                    this._click,
                    {
                        signal
                    }
                );

                this.canvas.addEventListener(
                    "keydown",
                    this._keydown,
                    {
                        signal
                    }
                );
            }

            this.resize();
            this.refresh();
            if (this.options.autoStart) {
                this.start();
                if (this.options.pauseWhenHidden && document.visibilityState === "hidden") {
                    this.autoPaused = true;
                    this.pause({ automatic: true });
                }
            }
        }

        _emit(
            type,
            detail =
                {},
            notifyWatchers =
                true
        ) {
            const event = {
                type,
                timestamp:
                    new Date().toISOString(),
                ...detail
            };

            if (
                this.emitting
            ) {
                return event;
            }

            this.emitting =
                true;

            try {
                dispatch(
                    this,
                    type,
                    event
                );

                if (
                    notifyWatchers
                ) {
                    for (
                        const watcher of
                        Array.from(
                            this.watchers
                        )
                    ) {
                        try {
                            watcher(
                                event,
                                this
                            );
                        } catch (error) {
                            this.metrics.watcherErrors +=
                                1;

                            this._recordError(
                                error,
                                false
                            );
                        }
                    }
                }

                return event;
            } finally {
                this.emitting =
                    false;
            }
        }

        _recordError(error, notifyWatchers = true) {
            this.lastError = error instanceof Error ? error : new Error(String(error));
            this.metrics.errors +=
                1;

            if (
                this.emitting
            ) {
                window.console?.
                    error?.(
                        "[SpeciedexTerminalWordCloud]",
                        this.lastError
                    );

                return;
            }

            this._emit(
                "error",
                {
                error: { name: this.lastError.name, message: this.lastError.message, stack: this.lastError.stack || "" }
                },
                notifyWatchers
            );
        }

        _cancelAnimation() {
            if (this.animationFrame) {
                window.cancelAnimationFrame(this.animationFrame);
                this.animationFrame = 0;
            }
        }

        _size() {
            const rect = this.canvas.getBoundingClientRect();
            return {
                width: Math.max(0, rect.width || this.canvas.clientWidth || this.canvas.parentElement?.clientWidth || 0),
                height: Math.max(0, rect.height || this.canvas.clientHeight || this.canvas.parentElement?.clientHeight || 0)
            };
        }

        resize() {
            if (
                this.destroyed
            ) {
                return false;
            }

            const size =
                this._size();

            if (
                !size.width ||
                !size.height
            ) {
                this.metrics.skippedResizes +=
                    1;

                return false;
            }

            if (
                Math.abs(
                    size.width -
                    this.lastWidth
                ) <
                    0.5 &&
                Math.abs(
                    size.height -
                    this.lastHeight
                ) <
                    0.5
            ) {
                this.metrics.skippedResizes +=
                    1;

                return false;
            }

            this.lastWidth =
                size.width;

            this.lastHeight =
                size.height;

            const ratio =
                Math.min(
                    window.devicePixelRatio ||
                    1,
                    this.options.maxPixelRatio
                );

            const pixelWidth =
                Math.max(
                    1,
                    Math.round(
                        size.width *
                        ratio
                    )
                );

            const pixelHeight =
                Math.max(
                    1,
                    Math.round(
                        size.height *
                        ratio
                    )
                );

            if (
                this.canvas.width !==
                    pixelWidth ||
                this.canvas.height !==
                    pixelHeight
            ) {
                this.canvas.width =
                    pixelWidth;

                this.canvas.height =
                    pixelHeight;
            }

            this.context.setTransform(
                ratio,
                0,
                0,
                ratio,
                0,
                0
            );

            this.metrics.resizes +=
                1;

            this.layoutWords();
            this.draw();

            this._emit(
                "resize",
                size
            );

            return true;
        }

        refresh() {
            if (
                this.destroyed
            ) {
                return [];
            }

            if (
                this.refreshing
            ) {
                this.pendingRefresh =
                    true;

                this.metrics.coalescedRefreshes +=
                    1;

                return this.layout.map(
                    clone
                );
            }

            this.refreshing =
                true;

            try {
                const source =
                    typeof this.options.source ===
                        "function"
                        ? this.options.source()
                        : this.options.source;

                if (
                    source &&
                    typeof source.then ===
                        "function"
                ) {
                    throw new TypeError(
                        "WordCloud sources must resolve before refresh."
                    );
                }

                const words =
                    normalizeWords(
                        source,
                        this.options
                    ).slice(
                        0,
                        this.options.maxWords
                    );

                const query =
                    this.query.toLocaleLowerCase();

                this.words =
                    query
                        ? words.filter(
                            word =>
                                word.text
                                    .toLocaleLowerCase()
                                    .includes(
                                        query
                                    )
                        )
                        : words;

                this.previousLayout =
                    this.layout.map(
                        clone
                    );

                this.layoutWords();

                this.lastRefreshAt =
                    new Date().toISOString();

                this.metrics.refreshes +=
                    1;

                this._cancelAnimation();

                if (
                    this.options.animation &&
                    this.options.animationDuration >
                        0 &&
                    this.previousLayout.length &&
                    this.layout.length
                ) {
                    this.animationStartedAt =
                        performance.now();

                    this.animate(
                        this.animationStartedAt
                    );
                } else {
                    this.draw();
                }

                this._emit(
                    "refresh",
                    {
                        words:
                            this.words.length,
                        placed:
                            this.layout.length,
                        rejected:
                            Math.max(
                                0,
                                this.words.length -
                                this.layout.length
                            )
                    }
                );

                return this.layout.map(
                    clone
                );
            } catch (error) {
                this._recordError(
                    error
                );

                return [];
            } finally {
                this.refreshing =
                    false;

                if (
                    this.pendingRefresh &&
                    !this.destroyed
                ) {
                    this.pendingRefresh =
                        false;

                    window.queueMicrotask(
                        () =>
                            this.refresh()
                    );
                }
            }
        }

        _measure(wordText, fontSize, rotation) {
            this.context.font = `${this.options.fontWeight} ${fontSize}px ${this.options.fontFamily}`;
            const metrics = this.context.measureText(wordText);
            const rawWidth = Math.ceil((metrics.actualBoundingBoxLeft || 0) + (metrics.actualBoundingBoxRight || 0) || metrics.width || fontSize);
            const rawHeight = Math.ceil((metrics.actualBoundingBoxAscent || 0) + (metrics.actualBoundingBoxDescent || 0) || fontSize * 1.2);
            const cosine = Math.abs(Math.cos(rotation));
            const sine = Math.abs(Math.sin(rotation));
            return { width: rawWidth * cosine + rawHeight * sine, height: rawWidth * sine + rawHeight * cosine, rawWidth, rawHeight };
        }

        _spiral(step, width, height) {
            if (this.options.spiral === "rectangular") {
                const layer = Math.ceil((Math.sqrt(step + 1) - 1) / 2);
                const side = Math.max(1, layer * 2);
                const perimeter = side * 4;
                const offset = ((step - Math.pow(side - 1, 2)) % perimeter + perimeter) % perimeter;
                const spacing = 4;
                if (offset < side) return { x: (offset - layer) * spacing, y: -layer * spacing };
                if (offset < side * 2) return { x: layer * spacing, y: (offset - side - layer) * spacing };
                if (offset < side * 3) return { x: (layer - (offset - side * 2)) * spacing, y: layer * spacing };
                return { x: -layer * spacing, y: (layer - (offset - side * 3)) * spacing };
            }
            const angle = step * 0.34;
            const radius = 1.8 * Math.sqrt(step);
            return { x: Math.cos(angle) * radius * (width / Math.max(height, 1)), y: Math.sin(angle) * radius };
        }

        layoutWords() {
            const { width, height } = this._size();
            if (!width || !height || !this.words.length) {
                this.layout = [];
                return [];
            }
            const weights = this.words.map((word) => word.weight);
            const minWeight = Math.min(...weights, 1);
            const maxWeight = Math.max(...weights, 1);
            const random = seededRandom(`${this.options.seed}:${width}:${height}:${this.words.map((word) => `${word.text}:${word.weight}`).join("|")}`);
            const index = new SpatialIndex(width, height, Math.max(24, this.options.maxFont));
            const placed = [];
            let rejected = 0;

            this.words.forEach((word, wordIndex) => {
                const range = Math.max(1e-9, maxWeight - minWeight);
                const normalized = (word.weight - minWeight) / range;
                const fontSize = this.options.minFont + Math.pow(Math.max(0, normalized), 0.58) * (this.options.maxFont - this.options.minFont);
                const rotation = random() > this.options.rotationProbability ? 0 : this.options.rotation * (wordIndex % 2 === 0 ? 1 : -1);
                const measured = this._measure(word.text, fontSize, rotation);
                let placement = null;

                for (let attempt = 0; attempt < this.options.attempts; attempt += 1) {
                    const point = this._spiral(attempt + wordIndex * 7, width, height);
                    const rect = {
                        x: width / 2 + point.x + (random() - 0.5) * Math.min(14, fontSize * 0.35) - measured.width / 2,
                        y: height / 2 + point.y + (random() - 0.5) * Math.min(14, fontSize * 0.35) - measured.height / 2,
                        width: measured.width,
                        height: measured.height
                    };
                    if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > width || rect.y + rect.height > height) continue;
                    if (index.query(rect).some((other) => intersects(rect, other, this.options.padding))) continue;
                    placement = {
                        ...rect,
                        text: word.text,
                        weight: word.weight,
                        count: word.count,
                        metadata: clone(word.metadata),
                        fontSize,
                        rotation,
                        centerX: rect.x + rect.width / 2,
                        centerY: rect.y + rect.height / 2,
                        rawWidth: measured.rawWidth,
                        rawHeight: measured.rawHeight,
                        index: wordIndex,
                        alpha: Math.min(1, this.options.opacity + (fontSize / Math.max(this.options.maxFont, 1)) * 0.36)
                    };
                    index.insert(placement);
                    placed.push(placement);
                    break;
                }
                if (!placement) rejected += 1;
            });

            this.layout = placed;
            this.metrics.layouts += 1;
            this.metrics.placed += placed.length;
            this.metrics.rejected += rejected;
            return placed.map(clone);
        }

        draw(progress = 1) {
            if (this.destroyed) return;
            const { width, height } = this._size();
            this.context.clearRect(0, 0, width, height);
            if (this.options.background && this.options.background !== "transparent") {
                this.context.fillStyle = this.options.background;
                this.context.fillRect(0, 0, width, height);
            }
            for (const item of this.layout) {
                const active = this.hovered?.text === item.text || this.selected?.text === item.text;
                this.context.save();
                this.context.translate(item.centerX, item.centerY);
                this.context.rotate(item.rotation);
                this.context.font = `${active ? 700 : this.options.fontWeight} ${item.fontSize * Math.max(0.001, progress)}px ${this.options.fontFamily}`;
                this.context.textAlign = "center";
                this.context.textBaseline = "middle";
                this.context.globalAlpha = item.alpha * (active ? 1 : 0.88) * progress;
                this.context.fillStyle = active ? this.options.highlight : this.options.foreground;
                if (active) {
                    this.context.shadowColor = this.options.foreground;
                    this.context.shadowBlur = 8;
                }
                this.context.fillText(item.text, 0, 0);
                this.context.restore();
            }
            this.metrics.draws += 1;
        }

        animate(timestamp = performance.now()) {
            if (this.destroyed || !this.options.animation) return;
            const progress = Math.min(1, (timestamp - this.animationStartedAt) / Math.max(1, this.options.animationDuration));
            this.draw(1 - Math.pow(1 - progress, 3));
            if (progress < 1) this.animationFrame = window.requestAnimationFrame((next) => this.animate(next));
            else this.animationFrame = 0;
        }

        hitTest(
            x,
            y
        ) {
            for (
                let index =
                    this.layout.length -
                    1;
                index >=
                    0;
                index -=
                    1
            ) {
                const item =
                    this.layout[
                        index
                    ];

                const dx =
                    x -
                    item.centerX;

                const dy =
                    y -
                    item.centerY;

                const cosine =
                    Math.cos(
                        -item.rotation
                    );

                const sine =
                    Math.sin(
                        -item.rotation
                    );

                const localX =
                    dx *
                    cosine -
                    dy *
                    sine;

                const localY =
                    dx *
                    sine +
                    dy *
                    cosine;

                if (
                    Math.abs(
                        localX
                    ) <=
                        item.rawWidth /
                        2 &&
                    Math.abs(
                        localY
                    ) <=
                        item.rawHeight /
                        2
                ) {
                    return item;
                }
            }

            return null;
        }

        _point(event) {
            const rect = this.canvas.getBoundingClientRect();
            return { x: event.clientX - rect.left, y: event.clientY - rect.top };
        }

        _handlePointerMove(event) {
            const point = this._point(event);
            const hovered = this.hitTest(point.x, point.y);
            if (hovered?.text === this.hovered?.text) return;
            this.hovered = hovered;
            this.metrics.hovers += 1;
            this.canvas.style.cursor = hovered ? "pointer" : "default";
            this.draw();
            this._emit("hover", { word: hovered ? clone(hovered) : null });
        }

        _handlePointerLeave() {
            if (!this.hovered) return;
            this.hovered = null;
            this.canvas.style.cursor = "default";
            this.draw();
            this._emit("hover", { word: null });
        }

        _handleClick(event) {
            const point = this._point(event);
            const selected = this.hitTest(point.x, point.y);
            this.selected = selected?.text === this.selected?.text ? null : selected;
            this.metrics.clicks += 1;
            this.draw();
            this._emit("select", { word: this.selected ? clone(this.selected) : null });
        }

        _handleKeydown(event) {
            if (!this.layout.length) return;
            const current = this.selected ? this.layout.findIndex((item) => item.text === this.selected.text) : -1;
            if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                event.preventDefault();
                this.selected = this.layout[(current + 1) % this.layout.length];
                this.draw();
            } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                event.preventDefault();
                this.selected = this.layout[(current - 1 + this.layout.length) % this.layout.length];
                this.draw();
            } else if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                if (this.selected) this._emit("select", { word: clone(this.selected) });
            } else if (event.key === "Escape") {
                this.selected = null;
                this.draw();
            }
        }

        push(value, weight = 1) {
            const current = Array.isArray(this.options.source) ? [...this.options.source] : [];
            current.push(isObject(value) && value.text !== undefined
                ? { ...value, weight: value.weight ?? value.value ?? value.count ?? weight }
                : { text: value, weight });
            this.options.source = current;
            return this.refresh();
        }

        pushMany(values = []) {
            if (!Array.isArray(values)) throw new TypeError("WordCloud pushMany requires an array.");
            this.options.source = [...(Array.isArray(this.options.source) ? this.options.source : []), ...values];
            return this.refresh();
        }

        setSource(source) {
            this.options.source = source ?? [];
            return this.refresh();
        }

        setFilter(query = "") {
            this.query = text(query);
            this.refresh();
            return this.query;
        }

        clear(options = {}) {
            this._cancelAnimation();
            this.words = [];
            this.layout = [];
            this.previousLayout = [];
            this.hovered = null;
            this.selected = null;
            if (options.source !== false) this.options.source = [];
            this.draw();
            this._emit("clear", {});
            return true;
        }

        start() {
            if (this.destroyed) throw new Error("WordCloud controller has been destroyed.");
            if (this.running && !this.paused) return this;
            this.stop({ silent: true });
            this.running = true;
            this.paused = false;
            this.autoPaused = false;
            this.startedAt = this.startedAt || new Date().toISOString();
            this.timer = window.setInterval(() => { if (!this.paused) this.refresh(); }, this.options.refresh);
            this._emit("start", { refresh: this.options.refresh });
            return this;
        }

        stop(options = {}) {
            const wasRunning = this.running || this.paused;
            this.running = false;
            this.paused = false;
            this.autoPaused = false;
            if (this.timer) {
                window.clearInterval(this.timer);
                this.timer = 0;
            }
            this._cancelAnimation();
            if (wasRunning && options.silent !== true) this._emit("stop", {});
            return this;
        }

        pause(options = {}) {
            if (!this.running || this.paused) return false;
            this.paused = true;
            if (options.automatic !== true) {
                this.autoPaused = false;
                this._emit("pause", {});
            }
            return true;
        }

        resume(options = {}) {
            if (!this.running) {
                this.start();
                return true;
            }
            if (!this.paused) return false;
            this.paused = false;
            this.autoPaused = false;
            if (options.automatic !== true) this._emit("resume", {});
            return true;
        }

        update(options = {}) {
            if (!isObject(options)) throw new TypeError("WordCloud options must be an object.");
            const wasRunning =
                this.running;

            const wasPaused =
                this.paused;

            const restartTimer =
                wasRunning &&
                options.refresh !==
                    undefined &&
                number(
                    options.refresh,
                    this.options.refresh,
                    50,
                    3600000
                ) !==
                    this.options.refresh;
            this.options = {
                ...this.options,
                ...options,
                fieldWeights: { ...this.options.fieldWeights, ...(options.fieldWeights || {}) },
                maxWords: options.maxWords !== undefined ? Math.floor(number(options.maxWords, this.options.maxWords, 1, 1000)) : this.options.maxWords,
                minFont: options.minFont !== undefined ? number(options.minFont, this.options.minFont, 6, 200) : this.options.minFont,
                maxFont: options.maxFont !== undefined ? number(options.maxFont, this.options.maxFont, 8, 300) : this.options.maxFont,
                refresh: options.refresh !== undefined ? number(options.refresh, this.options.refresh, 50, 3600000) : this.options.refresh,
                opacity: options.opacity !== undefined ? number(options.opacity, this.options.opacity, 0.01, 1) : this.options.opacity,
                rotation: options.rotation !== undefined ? number(options.rotation, this.options.rotation, 0, Math.PI) : this.options.rotation,
                rotationProbability: options.rotationProbability !== undefined ? number(options.rotationProbability, this.options.rotationProbability, 0, 1) : this.options.rotationProbability,
                padding: options.padding !== undefined ? number(options.padding, this.options.padding, 0, 100) : this.options.padding,
                attempts: options.attempts !== undefined ? Math.floor(number(options.attempts, this.options.attempts, 10, 100000)) : this.options.attempts,
                animationDuration: options.animationDuration !== undefined ? number(options.animationDuration, this.options.animationDuration, 0, 10000) : this.options.animationDuration,
                maxPixelRatio: options.maxPixelRatio !== undefined ? number(options.maxPixelRatio, this.options.maxPixelRatio, 1, 4) : this.options.maxPixelRatio
            };
            this.options.spiral = this.options.spiral === "rectangular" ? "rectangular" : "archimedean";
            if (this.options.maxFont < this.options.minFont) this.options.maxFont = this.options.minFont;
            if (
                restartTimer
            ) {
                this.stop({
                    silent:
                        true
                });

                this.start();

                if (
                    wasPaused
                ) {
                    this.pause({
                        automatic:
                            false
                    });
                }
            }
            this.resize();
            this.refresh();
            this._emit("update", { options: clone(this.options) });
            return this;
        }

        export(format = "json") {
            const normalized = String(format).toLowerCase();
            if (normalized === "json") return JSON.stringify({ generatedAt: new Date().toISOString(), words: this.words, layout: this.layout }, null, 2);
            if (normalized === "png") return this.canvas.toDataURL("image/png");
            if (normalized === "csv") {
                const rows = [["text", "weight", "count", "x", "y", "fontSize", "rotation"]];
                this.layout.forEach((item) => rows.push([item.text, item.weight, item.count, item.x, item.y, item.fontSize, item.rotation]));
                return rows.map((row) => row.map((value) => {
                    let output =
                        String(
                            value ??
                            ""
                        );

                    if (
                        /^[=+\-@\t\r]/.test(
                            output
                        )
                    ) {
                        output =
                            `'${output}`;
                    }

                    return /[",\n\r]/.test(
                        output
                    )
                        ? `"${output.replace(/"/g, '""')}"`
                        : output;
                }).join(",")).join("\r\n");
            }
            throw new Error(`Unsupported WordCloud export format: ${format}`);
        }

        watch(callback, options = {}) {
            if (typeof callback !== "function") throw new TypeError("WordCloud watcher must be a function.");
            this.watchers.add(callback);
            if (options.immediate === true) {
                try { callback({ type: "initial", timestamp: new Date().toISOString(), status: this.status() }, this); }
                catch (error) { this._recordError(error, false); }
            }
            return () => this.watchers.delete(callback);
        }

        status() {
            return {
                name: "wordcloud",
                module: MODULE_NAME,
                version: VERSION,
                running: this.running,
                paused: this.paused,
                autoPaused: this.autoPaused,
                startedAt: this.startedAt,
                lastRefreshAt: this.lastRefreshAt,
                words: this.words.length,
                placed: this.layout.length,
                selected: this.selected ? clone(this.selected) : null,
                hovered: this.hovered ? clone(this.hovered) : null,
                query: this.query,
                options: clone(this.options),
                metrics: { ...this.metrics },
                lastError: this.lastError ? { name: this.lastError.name, message: this.lastError.message } : null,
                destroyed: this.destroyed
            };
        }

        destroy() {
            if (
                this.destroyed
            ) {
                return false;
            }

            this.stop({
                silent:
                    true
            });

            this._cleanupResize?.();

            this.abortController.abort();

            this._cancelAnimation();

            if (
                this.resizeFrame
            ) {
                window.cancelAnimationFrame(
                    this.resizeFrame
                );

                this.resizeFrame =
                    0;
            }

            this._emit(
                "destroy",
                {}
            );

            this.watchers.clear();

            this.words =
                [];

            this.layout =
                [];

            this.previousLayout =
                [];

            this.hovered =
                null;

            this.selected =
                null;

            if (
                this.canvas[
                    CONTROLLER_SYMBOL
                ] ===
                    this
            ) {
                delete this.canvas[
                    CONTROLLER_SYMBOL
                ];
            }

            if (
                this.canvas.wordCloudController ===
                    this
            ) {
                delete this.canvas.wordCloudController;
            }

            this.destroyed =
                true;

            return true;
        }

    }

    function mount(
        target,
        options =
            {}
    ) {
        const canvas =
            resolveCanvas(
                target
            );

        const existing =
            canvas[
                CONTROLLER_SYMBOL
            ] ||
            canvas.wordCloudController;

        if (
            existing instanceof
                WordCloudController &&
            !existing.destroyed
        ) {
            existing.update(
                options
            );

            return existing;
        }

        return new WordCloudController(
            canvas,
            options
        );
    }

    function render(data = [], options = {}) {
        const container = document.createElement("section");
        container.className = "terminal-visualization terminal-visualization-wordcloud";
        container.dataset.visualization = "wordcloud";
        container.setAttribute("role", "region");
        container.setAttribute("aria-label", options.label || "Speciedex word cloud");

        const canvas = document.createElement("canvas");
        canvas.className = "terminal-wordcloud-canvas";
        canvas.setAttribute("aria-label", options.label || "Speciedex word cloud");
        canvas.style.width = canvas.style.width || "100%";
        canvas.style.height = canvas.style.height || `${number(options.height, 320, 1)}px`;

        const status = document.createElement("div");
        status.className = "terminal-wordcloud-status";
        status.setAttribute("aria-live", "polite");
        container.append(canvas, status);

        const controller = mount(canvas, { source: data, ...options });
        const updateStatus = () => {
            const snapshot = controller.status();
            status.textContent = `${snapshot.placed} of ${snapshot.words} terms placed` +
                (snapshot.query ? ` · filter: ${snapshot.query}` : "");
        };
        ["refresh", "resize", "update", "select", "clear"].forEach((eventName) => controller.addEventListener(eventName, updateStatus));
        updateStatus();
        Object.defineProperty(
            container,
            "controller",
            {
                value:
                    controller,
                configurable:
                    true
            }
        );

        container[
            CONTROLLER_SYMBOL
        ] =
            controller;

        container.wordCloudController =
            controller;

        container.update =
            (
                nextData =
                    data,
                nextOptions =
                    {}
            ) => {
                controller.update({
                    ...nextOptions,
                    source:
                        nextData
                });

                return container;
            };

        container.status =
            () =>
                controller.status();

        container.destroy =
            () => {
                const destroyed =
                    controller.destroy();

                delete container[
                    CONTROLLER_SYMBOL
                ];

                return destroyed;
            };

        return container;
    }

    function initialize(
        context =
            {}
    ) {
        const root =
            context.root ||
            document;

        const existing =
            context.wordcloud ||
            root?.[
                VISUALIZATION_SYMBOL
            ];

        if (
            existing &&
            existing.Controller ===
                WordCloudController
        ) {
            context.wordcloud =
                existing;

            context.registerVisualization?.(
                "wordcloud",
                existing
            );

            context.registerRenderer?.(
                "wordcloud",
                existing
            );

            return existing;
        }

        const dataset =
            context.root?.
                dataset ||
            {};

        const config =
            context.config?.
                wordcloud ||
            {};

        const defaults = {
            maxWords:
                dataset.terminalWordcloudMaxWords ??
                config.maxWords ??
                DEFAULTS.maxWords,

            minFont:
                dataset.terminalWordcloudMinFont ??
                config.minFont ??
                DEFAULTS.minFont,

            maxFont:
                dataset.terminalWordcloudMaxFont ??
                config.maxFont ??
                DEFAULTS.maxFont,

            refresh:
                dataset.terminalWordcloudRefresh ??
                config.refresh ??
                DEFAULTS.refresh,

            opacity:
                dataset.terminalWordcloudOpacity ??
                config.opacity ??
                DEFAULTS.opacity,

            rotation:
                dataset.terminalWordcloudRotation ??
                config.rotation ??
                DEFAULTS.rotation,

            foreground:
                dataset.terminalWordcloudForeground ??
                config.foreground ??
                DEFAULTS.foreground,

            highlight:
                dataset.terminalWordcloudHighlight ??
                config.highlight ??
                DEFAULTS.highlight,

            background:
                dataset.terminalWordcloudBackground ??
                config.background ??
                DEFAULTS.background,

            fontFamily:
                dataset.terminalWordcloudFontFamily ??
                config.fontFamily ??
                DEFAULTS.fontFamily,

            preservePhrases:
                bool(
                    dataset.terminalWordcloudPreservePhrases,
                    config.preservePhrases !==
                        false
                ),

            interactive:
                bool(
                    dataset.terminalWordcloudInteractive,
                    config.interactive !==
                        false
                ),

            animation:
                bool(
                    dataset.terminalWordcloudAnimation,
                    config.animation !==
                        false
                ),

            pauseWhenHidden:
                bool(
                    dataset.terminalWordcloudPauseWhenHidden,
                    config.pauseWhenHidden !==
                        false
                ),

            fields:
                config.fields ||
                DEFAULT_FIELDS,

            fieldWeights:
                config.fieldWeights ||
                {}
        };

        const controllers =
            new Set();

        const visualization = {
            version:
                VERSION,

            mount(
                target,
                options =
                    {}
            ) {
                const controller =
                    mount(
                        target,
                        {
                            ...defaults,
                            ...options,
                            fieldWeights: {
                                ...defaults.fieldWeights,
                                ...(
                                    options.fieldWeights ||
                                    {}
                                )
                            }
                        }
                    );

                controllers.add(
                    controller
                );

                controller.addEventListener(
                    "destroy",
                    () =>
                        controllers.delete(
                            controller
                        ),
                    {
                        once:
                            true
                    }
                );

                context.wordcloudController =
                    controller;

                return controller;
            },

            render(
                data,
                options =
                    {}
            ) {
                const element =
                    render(
                        data,
                        {
                            ...defaults,
                            ...options,
                            fieldWeights: {
                                ...defaults.fieldWeights,
                                ...(
                                    options.fieldWeights ||
                                    {}
                                )
                            }
                        }
                    );

                if (
                    element.controller
                ) {
                    controllers.add(
                        element.controller
                    );

                    element.controller.addEventListener(
                        "destroy",
                        () =>
                            controllers.delete(
                                element.controller
                            ),
                        {
                            once:
                                true
                        }
                    );

                    context.wordcloudController =
                        element.controller;
                }

                return element;
            },

            activeController() {
                return (
                    context.terminalSplash?.
                        wordCloudController ||
                    context.wordcloudController ||
                    Array.from(
                        controllers
                    ).at(
                        -1
                    ) ||
                    null
                );
            },

            status() {
                return {
                    version:
                        VERSION,
                    controllers:
                        controllers.size,
                    active:
                        this.activeController?.
                            ()?.
                            status?.() ||
                        null
                };
            },

            destroy() {
                for (
                    const controller of
                    Array.from(
                        controllers
                    )
                ) {
                    controller.destroy();
                }

                controllers.clear();

                if (
                    root[
                        VISUALIZATION_SYMBOL
                    ] ===
                        visualization
                ) {
                    delete root[
                        VISUALIZATION_SYMBOL
                    ];
                }

                if (
                    context.wordcloud ===
                        visualization
                ) {
                    delete context.wordcloud;
                }

                if (
                    context.wordcloudController
                ) {
                    delete context.wordcloudController;
                }

                return true;
            },

            Controller:
                WordCloudController,

            normalizeWords,

            SpatialIndex
        };

        root[
            VISUALIZATION_SYMBOL
        ] =
            visualization;

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

        dispatch(
            document,
            "speciedex:terminal-wordcloud-ready",
            {
                visualization,
                version:
                    VERSION
            }
        );

        return visualization;
    }

    function outJSON(writeJSON, value) {
        return typeof writeJSON === "function" ? writeJSON(value) : value;
    }

    function outText(write, value, type = "data") {
        return typeof write === "function" ? write(value, type) : value;
    }

    const commands = [{
        name: "wordcloud",
        category: "visualization",
        description: "Render and control collision-aware word clouds from terminal collections.",
        usage: "wordcloud [collection|status|start|stop|pause|resume|refresh|clear|filter|export]",
        handler:
            async ({
                args = [],
                context,
                writeJSON,
                write,
                writeError
            }) => {
            const action = String(args[0] || "records");
            const command = action.toLowerCase();
            const visualization =
                context.wordcloud ||
                initialize(
                    context
                );

            const controller =
                context.terminalSplash?.
                    wordCloudController ||
                context.wordcloudController ||
                visualization.
                    activeController?.();
            try {
                if (controller) {
                    switch (command) {
                        case "status": return outJSON(writeJSON, controller.status());
                        case "start": controller.start(); return outText(write, "Word cloud started.", "success");
                        case "stop": controller.stop(); return outText(write, "Word cloud stopped.", "success");
                        case "pause": controller.pause(); return outText(write, "Word cloud paused.", "success");
                        case "resume": controller.resume(); return outText(write, "Word cloud resumed.", "success");
                        case "refresh": controller.refresh(); return outJSON(writeJSON, controller.status());
                        case "clear": controller.clear(); return outText(write, "Word cloud cleared.", "success");
                        case "filter": {
                            const query = controller.setFilter(args.slice(1).join(" "));
                            return outJSON(writeJSON, { query, status: controller.status() });
                        }
                        case "export": return outText(write, controller.export(args[1] || "json"), "data");
                        default: break;
                    }
                }
                const libraryValue =
                    context.library?.
                        get?.(
                            action
                        );

                const resolvedLibrary =
                    libraryValue &&
                    typeof libraryValue.then ===
                        "function"
                        ? await libraryValue
                        : libraryValue;

                const stateValue =
                    context.state?.
                        get?.(
                            `library.${action}`,
                            []
                        );

                const resolvedState =
                    stateValue &&
                    typeof stateValue.then ===
                        "function"
                        ? await stateValue
                        : stateValue;

                const data =
                    resolvedLibrary !==
                        undefined &&
                    resolvedLibrary !==
                        null
                        ? resolvedLibrary
                        : resolvedState ??
                          [];

                return visualization.render(
                    data,
                    {
                        ...context.config?.
                            wordcloud,
                        label:
                            `Word cloud for ${action}`
                    }
                );
            } catch (error) {
                if (typeof writeError === "function") {
                    writeError(error.message);
                    return null;
                }
                throw error;
            }
        }
    }];

    const api = Object.freeze({
        name: MODULE_NAME,
        version:
            VERSION,
        VISUALIZATION_SYMBOL,
        CONTROLLER_SYMBOL,
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

    window.SpeciedexTerminalWordCloud = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;
    dispatch(document, "speciedex:terminal-module-available", { name: MODULE_NAME, module: api });
})(window, document);
