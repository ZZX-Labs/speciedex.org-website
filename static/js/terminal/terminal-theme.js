/*
========================================================================
Speciedex.org
Terminal Theme Manager
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Theme";
    const VERSION = "2.2.0";

    const THEME_SYMBOL =
        Symbol.for("speciedex.terminal.theme.manager");

    const STORAGE_KEY = "theme:preferences";
    const DEFAULT_THEME = "speciedex";
    const DEFAULT_FONT_SIZE = 14;
    const DEFAULT_LINE_HEIGHT = 1.5;
    const DEFAULT_FONT_FAMILY =
        '"IBM Plex Mono", "Cascadia Mono", "SFMono-Regular", Consolas, monospace';

    const MIN_FONT_SIZE = 8;
    const MAX_FONT_SIZE = 32;
    const MIN_LINE_HEIGHT = 1;
    const MAX_LINE_HEIGHT = 2.5;
    const DEFAULT_HISTORY_LIMIT = 100;
    const DEFAULT_IMPORT_LIMIT = 500;
    const MAX_THEME_DEPTH = 32;

    const THEME_SCHEMA = "speciedex-terminal-theme";
    const THEME_SCHEMA_VERSION = 1;

    const COLOR_KEYS = Object.freeze([
        "background",
        "backgroundAlt",
        "foreground",
        "foregroundMuted",
        "accent",
        "accentAlt",
        "border",
        "selection",
        "cursor",
        "success",
        "warning",
        "error",
        "info",
        "link",
        "linkHover",
        "shadow",
        "overlay",
        "ansiBlack",
        "ansiRed",
        "ansiGreen",
        "ansiYellow",
        "ansiBlue",
        "ansiMagenta",
        "ansiCyan",
        "ansiWhite",
        "ansiBrightBlack",
        "ansiBrightRed",
        "ansiBrightGreen",
        "ansiBrightYellow",
        "ansiBrightBlue",
        "ansiBrightMagenta",
        "ansiBrightCyan",
        "ansiBrightWhite"
    ]);

    const STYLE_KEYS = Object.freeze([
        "fontFamily",
        "fontSize",
        "fontWeight",
        "lineHeight",
        "letterSpacing",
        "borderRadius",
        "borderWidth",
        "shadow",
        "opacity",
        "cursorShape",
        "cursorBlink",
        "scanlines",
        "glow",
        "backgroundImage",
        "backgroundSize",
        "backgroundPosition"
    ]);

    const CSS_VARIABLES = Object.freeze({
        background: "--terminal-background",
        backgroundAlt: "--terminal-background-alt",
        foreground: "--terminal-foreground",
        foregroundMuted: "--terminal-foreground-muted",
        accent: "--terminal-accent",
        accentAlt: "--terminal-accent-alt",
        border: "--terminal-border",
        selection: "--terminal-selection",
        cursor: "--terminal-cursor",
        success: "--terminal-success",
        warning: "--terminal-warning",
        error: "--terminal-error",
        info: "--terminal-info",
        link: "--terminal-link",
        linkHover: "--terminal-link-hover",
        shadow: "--terminal-shadow",
        overlay: "--terminal-overlay",
        ansiBlack: "--terminal-ansi-black",
        ansiRed: "--terminal-ansi-red",
        ansiGreen: "--terminal-ansi-green",
        ansiYellow: "--terminal-ansi-yellow",
        ansiBlue: "--terminal-ansi-blue",
        ansiMagenta: "--terminal-ansi-magenta",
        ansiCyan: "--terminal-ansi-cyan",
        ansiWhite: "--terminal-ansi-white",
        ansiBrightBlack: "--terminal-ansi-bright-black",
        ansiBrightRed: "--terminal-ansi-bright-red",
        ansiBrightGreen: "--terminal-ansi-bright-green",
        ansiBrightYellow: "--terminal-ansi-bright-yellow",
        ansiBrightBlue: "--terminal-ansi-bright-blue",
        ansiBrightMagenta: "--terminal-ansi-bright-magenta",
        ansiBrightCyan: "--terminal-ansi-bright-cyan",
        ansiBrightWhite: "--terminal-ansi-bright-white",
        fontFamily: "--terminal-font-family",
        fontSize: "--terminal-font-size",
        fontWeight: "--terminal-font-weight",
        lineHeight: "--terminal-line-height",
        letterSpacing: "--terminal-letter-spacing",
        borderRadius: "--terminal-border-radius",
        borderWidth: "--terminal-border-width",
        shadowStyle: "--terminal-shadow-style",
        opacity: "--terminal-opacity",
        cursorShape: "--terminal-cursor-shape",
        cursorBlink: "--terminal-cursor-blink",
        scanlines: "--terminal-scanlines",
        glow: "--terminal-glow",
        backgroundImage: "--terminal-background-image",
        backgroundSize: "--terminal-background-size",
        backgroundPosition: "--terminal-background-position"
    });

    const BUILTIN_THEMES = Object.freeze({
        speciedex: {
            id: "speciedex",
            name: "Speciedex",
            description: "Canonical Speciedex terminal palette.",
            mode: "dark",
            colors: {
                background: "#07100a",
                backgroundAlt: "#0d1710",
                foreground: "#d8e6db",
                foregroundMuted: "#93a497",
                accent: "#c0d674",
                accentAlt: "#e6a42b",
                border: "#314a37",
                selection: "#314a37",
                cursor: "#c0d674",
                success: "#8bcf7a",
                warning: "#e6a42b",
                error: "#ef6b73",
                info: "#7db7d8",
                link: "#c0d674",
                linkHover: "#e6a42b",
                shadow: "rgba(0, 0, 0, 0.55)",
                overlay: "rgba(7, 16, 10, 0.88)",
                ansiBlack: "#07100a",
                ansiRed: "#ef6b73",
                ansiGreen: "#8bcf7a",
                ansiYellow: "#e6a42b",
                ansiBlue: "#7db7d8",
                ansiMagenta: "#b48ad6",
                ansiCyan: "#73c7c9",
                ansiWhite: "#d8e6db",
                ansiBrightBlack: "#526258",
                ansiBrightRed: "#ff8990",
                ansiBrightGreen: "#a9e69b",
                ansiBrightYellow: "#f2bd5e",
                ansiBrightBlue: "#9dcde5",
                ansiBrightMagenta: "#cab1e6",
                ansiBrightCyan: "#9ce1e3",
                ansiBrightWhite: "#ffffff"
            },
            style: {
                fontFamily: DEFAULT_FONT_FAMILY,
                fontSize: DEFAULT_FONT_SIZE,
                fontWeight: 400,
                lineHeight: DEFAULT_LINE_HEIGHT,
                letterSpacing: "0",
                borderRadius: "0.35rem",
                borderWidth: "1px",
                shadow: "0 0.75rem 2.5rem rgba(0, 0, 0, 0.45)",
                opacity: 1,
                cursorShape: "block",
                cursorBlink: true,
                scanlines: false,
                glow: false,
                backgroundImage: "none",
                backgroundSize: "cover",
                backgroundPosition: "center"
            }
        },

        dark: {
            id: "dark",
            name: "Dark",
            description: "Neutral modern dark terminal.",
            mode: "dark",
            extends: "speciedex",
            colors: {
                background: "#111111",
                backgroundAlt: "#181818",
                foreground: "#eeeeee",
                foregroundMuted: "#a8a8a8",
                accent: "#8ab4f8",
                accentAlt: "#c58af9",
                border: "#333333",
                selection: "#29466d",
                cursor: "#eeeeee",
                success: "#81c995",
                warning: "#fdd663",
                error: "#f28b82",
                info: "#8ab4f8",
                link: "#8ab4f8",
                linkHover: "#aecbfa",
                overlay: "rgba(17, 17, 17, 0.9)"
            }
        },

        light: {
            id: "light",
            name: "Light",
            description: "High-legibility light terminal.",
            mode: "light",
            extends: "speciedex",
            colors: {
                background: "#f6f8f6",
                backgroundAlt: "#ffffff",
                foreground: "#111611",
                foregroundMuted: "#5f6b61",
                accent: "#4c6b22",
                accentAlt: "#9a5f00",
                border: "#cad3cb",
                selection: "#d8e6bf",
                cursor: "#111611",
                success: "#2f7d32",
                warning: "#8a5a00",
                error: "#b3261e",
                info: "#145a86",
                link: "#365f00",
                linkHover: "#254300",
                shadow: "rgba(0, 0, 0, 0.18)",
                overlay: "rgba(246, 248, 246, 0.92)"
            }
        },

        matrix: {
            id: "matrix",
            name: "Matrix",
            description: "Green phosphor display inspired palette.",
            mode: "dark",
            extends: "speciedex",
            colors: {
                background: "#000000",
                backgroundAlt: "#031003",
                foreground: "#80ff80",
                foregroundMuted: "#3ea83e",
                accent: "#00ff41",
                accentAlt: "#b6ff00",
                border: "#0c4f1d",
                selection: "#103b1d",
                cursor: "#00ff41",
                success: "#00ff41",
                warning: "#b6ff00",
                error: "#ff4d4d",
                info: "#66ffcc",
                link: "#00ff41",
                linkHover: "#b6ff00",
                shadow: "rgba(0, 255, 65, 0.18)",
                overlay: "rgba(0, 0, 0, 0.9)"
            },
            style: {
                glow: true,
                scanlines: true
            }
        },

        amber: {
            id: "amber",
            name: "Amber",
            description: "Amber monochrome CRT terminal.",
            mode: "dark",
            extends: "speciedex",
            colors: {
                background: "#140d00",
                backgroundAlt: "#211500",
                foreground: "#ffd782",
                foregroundMuted: "#c59343",
                accent: "#ffb000",
                accentAlt: "#ffd782",
                border: "#6b4500",
                selection: "#503600",
                cursor: "#ffb000",
                success: "#ffd782",
                warning: "#ffb000",
                error: "#ff6f4a",
                info: "#ffd782",
                link: "#ffbf33",
                linkHover: "#ffe2a3",
                shadow: "rgba(255, 176, 0, 0.18)",
                overlay: "rgba(20, 13, 0, 0.92)"
            },
            style: {
                glow: true,
                scanlines: true
            }
        },

        highContrast: {
            id: "highContrast",
            name: "High Contrast",
            description: "Maximum contrast accessibility palette.",
            mode: "dark",
            extends: "speciedex",
            colors: {
                background: "#000000",
                backgroundAlt: "#000000",
                foreground: "#ffffff",
                foregroundMuted: "#d0d0d0",
                accent: "#ffff00",
                accentAlt: "#00ffff",
                border: "#ffffff",
                selection: "#0044aa",
                cursor: "#ffffff",
                success: "#00ff00",
                warning: "#ffff00",
                error: "#ff3333",
                info: "#00ffff",
                link: "#00ffff",
                linkHover: "#ffffff",
                shadow: "rgba(255, 255, 255, 0.12)",
                overlay: "rgba(0, 0, 0, 0.96)"
            },
            style: {
                fontWeight: 600,
                glow: false,
                scanlines: false
            }
        },

        print: {
            id: "print",
            name: "Print",
            description: "Printer-friendly monochrome theme.",
            mode: "light",
            extends: "light",
            colors: {
                background: "#ffffff",
                backgroundAlt: "#ffffff",
                foreground: "#000000",
                foregroundMuted: "#444444",
                accent: "#000000",
                accentAlt: "#333333",
                border: "#777777",
                selection: "#dddddd",
                cursor: "#000000",
                success: "#000000",
                warning: "#000000",
                error: "#000000",
                info: "#000000",
                link: "#000000",
                linkHover: "#000000",
                shadow: "rgba(0, 0, 0, 0)",
                overlay: "rgba(255, 255, 255, 1)"
            },
            style: {
                shadow: "none",
                backgroundImage: "none",
                glow: false,
                scanlines: false
            }
        }
    });

    function now() {
        return Date.now();
    }

    function iso(timestamp = now()) {
        const date = new Date(timestamp);

        return Number.isFinite(date.getTime())
            ? date.toISOString()
            : new Date().toISOString();
    }

    function isObject(value) {
        return (
            value !== null &&
            typeof value === "object" &&
            !Array.isArray(value)
        );
    }

    function isElement(value) {
        return Boolean(
            value &&
            value.nodeType === 1 &&
            value.style &&
            value.dataset
        );
    }

    function clone(value, seen = new WeakMap()) {
        if (
            value === null ||
            value === undefined ||
            typeof value !== "object"
        ) {
            return value;
        }

        if (typeof structuredClone === "function") {
            try {
                return structuredClone(value);
            } catch (_error) {
                /* Continue with fallback. */
            }
        }

        if (seen.has(value)) {
            return seen.get(value);
        }

        if (value instanceof Date) {
            return new Date(value.getTime());
        }

        if (value instanceof RegExp) {
            return new RegExp(value.source, value.flags);
        }

        if (value instanceof Map) {
            const output = new Map();
            seen.set(value, output);

            for (const [key, item] of value.entries()) {
                output.set(
                    clone(key, seen),
                    clone(item, seen)
                );
            }

            return output;
        }

        if (value instanceof Set) {
            const output = new Set();
            seen.set(value, output);

            for (const item of value.values()) {
                output.add(clone(item, seen));
            }

            return output;
        }

        if (Array.isArray(value)) {
            const output = [];
            seen.set(value, output);

            for (const item of value) {
                output.push(clone(item, seen));
            }

            return output;
        }

        const output = {};
        seen.set(value, output);

        for (const [key, item] of Object.entries(value)) {
            if (
                key === "__proto__" ||
                key === "prototype" ||
                key === "constructor"
            ) {
                continue;
            }

            output[key] = clone(item, seen);
        }

        return output;
    }

    function parseBoolean(value, fallback = false) {
        if (typeof value === "boolean") {
            return value;
        }

        if (
            value === undefined ||
            value === null ||
            value === ""
        ) {
            return fallback;
        }

        const normalized =
            String(value).trim().toLowerCase();

        if (
            ["1", "true", "yes", "on", "enabled"].includes(normalized)
        ) {
            return true;
        }

        if (
            ["0", "false", "no", "off", "disabled"].includes(normalized)
        ) {
            return false;
        }

        return fallback;
    }

    function parseNumber(
        value,
        fallback,
        minimum = -Infinity,
        maximum = Infinity
    ) {
        const number = Number(value);

        if (!Number.isFinite(number)) {
            return fallback;
        }

        return Math.min(maximum, Math.max(minimum, number));
    }

    function normalizeId(value) {
        const id = String(value ?? "")
            .trim()
            .replace(/\s+/g, "-")
            .replace(/[^a-zA-Z0-9._-]/g, "-")
            .replace(/-+/g, "-")
            .replace(/^[-.]+|[-.]+$/g, "");

        if (!id) {
            throw new TypeError(
                "Theme identifier must be non-empty."
            );
        }

        if (
            id === "__proto__" ||
            id === "prototype" ||
            id === "constructor"
        ) {
            throw new TypeError(
                "Reserved theme identifier is not allowed."
            );
        }

        return id;
    }

    function normalizeColor(value, fallback = null) {
        if (
            value === undefined ||
            value === null ||
            value === ""
        ) {
            return fallback;
        }

        const color = String(value).trim();

        if (
            /^#[0-9a-f]{3,8}$/i.test(color) ||
            /^rgba?\(/i.test(color) ||
            /^hsla?\(/i.test(color) ||
            /^var\(--[a-z0-9-_]+\)$/i.test(color) ||
            /^[a-z]+$/i.test(color)
        ) {
            return color;
        }

        throw new TypeError(
            `Invalid CSS color value: ${value}`
        );
    }

    function safeDispatch(target, name, detail) {
        if (
            !target ||
            typeof target.dispatchEvent !== "function"
        ) {
            return false;
        }

        try {
            return target.dispatchEvent(
                new CustomEvent(name, { detail })
            );
        } catch (_error) {
            return false;
        }
    }

    function safeStringify(value, compact = false) {
        const seen = new WeakSet();

        return JSON.stringify(
            value,
            (_key, item) => {
                if (
                    item &&
                    typeof item === "object"
                ) {
                    if (seen.has(item)) {
                        return "[Circular]";
                    }

                    seen.add(item);
                }

                if (typeof item === "bigint") {
                    return String(item);
                }

                return item;
            },
            compact ? 0 : 2
        );
    }

    function mergeTheme(base, override) {
        return {
            ...clone(base || {}),
            ...clone(override || {}),
            colors: {
                ...(base?.colors || {}),
                ...(override?.colors || {})
            },
            style: {
                ...(base?.style || {}),
                ...(override?.style || {})
            }
        };
    }

    function colorToRgb(color) {
        if (!color) {
            return null;
        }

        const value = String(color).trim();

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
            r: Math.min(255, Math.max(0, Number(match[1]))),
            g: Math.min(255, Math.max(0, Number(match[2]))),
            b: Math.min(255, Math.max(0, Number(match[3])))
        };
    }

    function relativeLuminance(color) {
        const rgb = colorToRgb(color);

        if (!rgb) {
            return null;
        }

        const channels = [rgb.r, rgb.g, rgb.b]
            .map(value => {
                const normalized = value / 255;

                return normalized <= 0.03928
                    ? normalized / 12.92
                    : Math.pow(
                        (normalized + 0.055) / 1.055,
                        2.4
                    );
            });

        return (
            0.2126 * channels[0] +
            0.7152 * channels[1] +
            0.0722 * channels[2]
        );
    }

    function contrastRatio(foreground, background) {
        const foregroundLuminance =
            relativeLuminance(foreground);

        const backgroundLuminance =
            relativeLuminance(background);

        if (
            foregroundLuminance === null ||
            backgroundLuminance === null
        ) {
            return null;
        }

        const light =
            Math.max(
                foregroundLuminance,
                backgroundLuminance
            );

        const dark =
            Math.min(
                foregroundLuminance,
                backgroundLuminance
            );

        return Number(
            ((light + 0.05) / (dark + 0.05))
                .toFixed(2)
        );
    }

    function parseArguments(args = []) {
        const parsed = {
            action: "status",
            positional: [],
            options: {}
        };

        for (const argument of args) {
            const value = String(argument);

            if (value.startsWith("--")) {
                const [key, ...rest] =
                    value.slice(2).split("=");

                parsed.options[key] =
                    rest.length
                        ? rest.join("=")
                        : true;
            } else {
                parsed.positional.push(value);
            }
        }

        if (parsed.positional.length) {
            parsed.action =
                parsed.positional.shift().toLowerCase();
        }

        return parsed;
    }

    async function readJSONSource(source, options = {}) {
        if (isObject(source)) {
            return clone(source);
        }

        if (source instanceof Blob) {
            return JSON.parse(await source.text());
        }

        const input = String(source || "").trim();

        if (!input) {
            throw new TypeError(
                "Theme JSON source must not be empty."
            );
        }

        if (
            input.startsWith("{") ||
            input.startsWith("[")
        ) {
            return JSON.parse(input);
        }

        const response = await fetch(input, {
            credentials:
                options.credentials || "same-origin",
            cache:
                options.cache || "no-cache",
            signal:
                options.signal
        });

        if (!response.ok) {
            throw new Error(
                `Unable to load theme JSON (${response.status} ${response.statusText}): ${input}`
            );
        }

        return response.json();
    }

    class ThemeManager extends EventTarget {
        constructor(context = {}, options = {}) {
            super();

            this.context =
                isObject(context)
                    ? context
                    : {};

            this.root =
                isElement(options.root)
                    ? options.root
                    : isElement(this.context.root)
                        ? this.context.root
                        : document.documentElement;

            this.storage =
                options.storage ||
                this.context.storage ||
                this.context.services?.get?.("storage") ||
                null;

            this.storageKey =
                options.storageKey ||
                STORAGE_KEY;

            this.registry = new Map();
            this.current = null;
            this.previous = null;
            this.previewing = null;
            this.history = [];
            this.watchers = new Set();
            this.destroyed = false;
            this.lastError = null;
            this.mediaDark = null;
            this.mediaContrast = null;
            this.mediaMotion = null;
            this.scheduleTimer = 0;
            this.mediaBindings = [];
            this.applying = false;
            this.emitting = false;
            this.syncingState = false;
            this.ready = false;

            this.maxHistory =
                parseNumber(
                    options.maxHistory,
                    DEFAULT_HISTORY_LIMIT,
                    1,
                    5000
                );

            this.maxImport =
                parseNumber(
                    options.maxImport,
                    DEFAULT_IMPORT_LIMIT,
                    1,
                    10000
                );

            this.preferences = {
                theme:
                    options.defaultTheme ||
                    DEFAULT_THEME,
                followSystem:
                    options.followSystem === true,
                fontSize:
                    parseNumber(
                        options.fontSize,
                        DEFAULT_FONT_SIZE,
                        MIN_FONT_SIZE,
                        MAX_FONT_SIZE
                    ),
                lineHeight:
                    parseNumber(
                        options.lineHeight,
                        DEFAULT_LINE_HEIGHT,
                        MIN_LINE_HEIGHT,
                        MAX_LINE_HEIGHT
                    ),
                fontFamily:
                    options.fontFamily ||
                    DEFAULT_FONT_FAMILY,
                reducedMotion:
                    options.reducedMotion === true,
                highContrast:
                    options.highContrast === true,
                schedule: null
            };

            this.metrics = {
                registrations: 0,
                applications: 0,
                previews: 0,
                preferenceChanges: 0,
                imports: 0,
                exports: 0,
                jsonLoads: 0,
                persistenceWrites: 0,
                persistenceReads: 0,
                errors: 0,
                systemChanges: 0,
                scheduledChanges: 0
            };

            this._boundSystemChange =
                this._handleSystemChange.bind(this);

            for (
                const [id, theme]
                of Object.entries(BUILTIN_THEMES)
            ) {
                this.register(id, theme, {
                    builtin: true,
                    persist: false,
                    silent: true,
                    replace: true
                });
            }

            this._installMediaQueries();
        }

        async initialize(options = {}) {
            this._assertActive();

            await this.loadPreferences();

            const sources = [];

            if (options.themeFiles) {
                sources.push(
                    ...(
                        Array.isArray(options.themeFiles)
                            ? options.themeFiles
                            : [options.themeFiles]
                    )
                );
            }

            const datasetFiles =
                this.root.dataset.terminalThemeFiles ||
                this.root.dataset.terminalThemes ||
                "";

            if (datasetFiles) {
                sources.push(
                    ...datasetFiles
                        .split(",")
                        .map(value => value.trim())
                        .filter(Boolean)
                );
            }

            for (const source of sources) {
                try {
                    await this.loadJSON(source, {
                        replace: true,
                        persist: false,
                        strict: false
                    });
                } catch (error) {
                    this._recordError(error);
                }
            }

            const startup =
                this._resolveStartupTheme(
                    options.initialTheme
                );

            this.apply(startup, {
                persist: false,
                recordHistory: false,
                source: "initialize"
            });

            this._applyPreferences();
            this._syncState();
            this._scheduleNextTransition();

            this.ready = true;

            this._emit("ready", {
                current: this.current
            });

            return this;
        }

        _assertActive() {
            if (this.destroyed) {
                throw new Error(
                    "Theme manager has been destroyed."
                );
            }
        }

        _recordError(error) {
            this.lastError =
                error instanceof Error
                    ? error
                    : new Error(String(error));

            this.metrics.errors += 1;

            if (!this.destroyed) {
                this._emit("error", {
                    error: {
                        name:
                            this.lastError.name,
                        message:
                            this.lastError.message,
                        stack:
                            this.lastError.stack || ""
                    }
                });
            }

            return this.lastError;
        }

        _emit(type, detail = {}) {
            if (
                this.destroyed &&
                type !== "destroy"
            ) {
                return null;
            }

            const event = {
                type,
                timestamp: iso(),
                current: this.current,
                ...detail
            };

            if (this.emitting) {
                return event;
            }

            this.emitting = true;

            try {
                safeDispatch(this, type, event);
                safeDispatch(this, "change", event);

                for (const watcher of Array.from(
                    this.watchers
                )) {
                    try {
                        watcher(event, this);
                    } catch (error) {
                        this._recordError(error);
                    }
                }

                try {
                    this.context.events?.emit?.(
                        `theme:${type}`,
                        event
                    );
                } catch (error) {
                    this._recordError(error);
                }

                safeDispatch(
                    document,
                    `speciedex:terminal-theme-${type}`,
                    event
                );

                return event;
            } finally {
                this.emitting = false;
            }
        }

        _installMediaQueries() {
            if (
                typeof window.matchMedia !== "function"
            ) {
                return false;
            }

            this.mediaDark =
                window.matchMedia(
                    "(prefers-color-scheme: dark)"
                );

            this.mediaContrast =
                window.matchMedia(
                    "(prefers-contrast: more)"
                );

            this.mediaMotion =
                window.matchMedia(
                    "(prefers-reduced-motion: reduce)"
                );

            for (const media of [
                this.mediaDark,
                this.mediaContrast,
                this.mediaMotion
            ]) {
                if (
                    typeof media?.addEventListener ===
                    "function"
                ) {
                    media.addEventListener(
                        "change",
                        this._boundSystemChange
                    );
                } else {
                    media?.addListener?.(
                        this._boundSystemChange
                    );
                }

                if (media) {
                    this.mediaBindings.push(media);
                }
            }

            return true;
        }

        _handleSystemChange() {
            if (this.destroyed) {
                return;
            }

            this.metrics.systemChanges += 1;
            this._applyPreferences();

            if (this.preferences.followSystem) {
                const theme =
                    this.mediaContrast?.matches
                        ? "highContrast"
                        : this.mediaDark?.matches
                            ? "dark"
                            : "light";

                if (this.registry.has(theme)) {
                    this.apply(theme, {
                        source: "system"
                    });
                }
            }

            this._emit("systemChange", {
                dark:
                    Boolean(this.mediaDark?.matches),
                contrast:
                    Boolean(this.mediaContrast?.matches),
                reducedMotion:
                    Boolean(this.mediaMotion?.matches)
            });
        }

        _resolveStartupTheme(initialTheme) {
            const requested =
                initialTheme ||
                this.root.dataset.terminalTheme ||
                this.preferences.theme ||
                DEFAULT_THEME;

            if (this.preferences.followSystem) {
                if (
                    this.mediaContrast?.matches &&
                    this.registry.has("highContrast")
                ) {
                    return "highContrast";
                }

                return this.mediaDark?.matches
                    ? "dark"
                    : "light";
            }

            return this.registry.has(requested)
                ? requested
                : DEFAULT_THEME;
        }

        _resolveTheme(name, stack = []) {
            if (stack.length > MAX_THEME_DEPTH) {
                throw new Error(
                    `Theme inheritance depth exceeded: ${MAX_THEME_DEPTH}`
                );
            }

            const id = normalizeId(name);
            const theme = this.registry.get(id);

            if (!theme) {
                throw new Error(
                    `Unknown terminal theme: ${id}`
                );
            }

            if (stack.includes(id)) {
                throw new Error(
                    `Circular theme inheritance detected: ${[...stack, id].join(" -> ")}`
                );
            }

            if (!theme.extends) {
                return clone(theme);
            }

            const parent =
                this._resolveTheme(
                    theme.extends,
                    [...stack, id]
                );

            return mergeTheme(parent, theme);
        }

        _validateTheme(theme) {
            if (!isObject(theme)) {
                throw new TypeError(
                    "Theme definition must be an object."
                );
            }

            const id =
                normalizeId(theme.id || theme.name);

            if (!isObject(theme.colors)) {
                throw new TypeError(
                    `Theme "${id}" must include a colors object.`
                );
            }

            const colors = {};

            for (
                const [key, value]
                of Object.entries(theme.colors)
            ) {
                if (!COLOR_KEYS.includes(key)) {
                    continue;
                }

                colors[key] =
                    normalizeColor(value);
            }

            const style = {};

            for (
                const [key, value]
                of Object.entries(theme.style || {})
            ) {
                if (!STYLE_KEYS.includes(key)) {
                    continue;
                }

                style[key] = value;
            }

            if (style.fontSize !== undefined) {
                style.fontSize = parseNumber(
                    style.fontSize,
                    DEFAULT_FONT_SIZE,
                    MIN_FONT_SIZE,
                    MAX_FONT_SIZE
                );
            }

            if (style.lineHeight !== undefined) {
                style.lineHeight = parseNumber(
                    style.lineHeight,
                    DEFAULT_LINE_HEIGHT,
                    MIN_LINE_HEIGHT,
                    MAX_LINE_HEIGHT
                );
            }

            if (style.opacity !== undefined) {
                style.opacity = parseNumber(
                    style.opacity,
                    1,
                    0,
                    1
                );
            }

            for (const key of [
                "cursorBlink",
                "scanlines",
                "glow"
            ]) {
                if (style[key] !== undefined) {
                    style[key] =
                        parseBoolean(
                            style[key],
                            false
                        );
                }
            }

            return {
                id,
                name:
                    String(theme.name || id),
                description:
                    String(theme.description || ""),
                mode:
                    theme.mode === "light"
                        ? "light"
                        : "dark",
                extends:
                    theme.extends
                        ? normalizeId(theme.extends)
                        : null,
                builtin:
                    theme.builtin === true,
                createdAt:
                    theme.createdAt || iso(),
                updatedAt: iso(),
                colors,
                style
            };
        }

        _applyThemeVariables(theme) {
            const style = this.root.style;

            for (
                const [key, value]
                of Object.entries(theme.colors || {})
            ) {
                const variable = CSS_VARIABLES[key];

                if (
                    variable &&
                    value !== undefined &&
                    value !== null
                ) {
                    style.setProperty(
                        variable,
                        String(value)
                    );
                }
            }

            for (
                const [key, value]
                of Object.entries(theme.style || {})
            ) {
                const variable =
                    key === "shadow"
                        ? CSS_VARIABLES.shadowStyle
                        : CSS_VARIABLES[key];

                if (
                    !variable ||
                    value === undefined ||
                    value === null
                ) {
                    continue;
                }

                let formatted = value;

                if (
                    key === "fontSize" &&
                    typeof value === "number"
                ) {
                    formatted = `${value}px`;
                } else if (
                    ["cursorBlink", "scanlines", "glow"]
                        .includes(key)
                ) {
                    formatted = value ? "1" : "0";
                } else if (key === "backgroundImage") {
                    const text = String(value);

                    formatted =
                        text === "none" ||
                        text.startsWith("url(") ||
                        text.startsWith("linear-gradient(") ||
                        text.startsWith("radial-gradient(")
                            ? text
                            : `url("${text.replace(/"/g, '\\"')}")`;
                }

                style.setProperty(
                    variable,
                    String(formatted)
                );
            }

            this.root.dataset.terminalTheme =
                theme.id;

            this.root.dataset.terminalThemeMode =
                theme.mode;

            this.root.dataset.terminalCursor =
                theme.style?.cursorShape ||
                "block";

            this.root.dataset.terminalCursorBlink =
                theme.style?.cursorBlink === false
                    ? "false"
                    : "true";

            this.root.dataset.terminalScanlines =
                theme.style?.scanlines === true
                    ? "true"
                    : "false";

            this.root.dataset.terminalGlow =
                theme.style?.glow === true
                    ? "true"
                    : "false";

            this.root.classList.toggle(
                "terminal-theme-light",
                theme.mode === "light"
            );

            this.root.classList.toggle(
                "terminal-theme-dark",
                theme.mode !== "light"
            );
        }

        _applyPreferences() {
            const style = this.root.style;

            style.setProperty(
                CSS_VARIABLES.fontSize,
                `${this.preferences.fontSize}px`
            );

            style.setProperty(
                CSS_VARIABLES.lineHeight,
                String(this.preferences.lineHeight)
            );

            style.setProperty(
                CSS_VARIABLES.fontFamily,
                this.preferences.fontFamily
            );

            const reducedMotion =
                this.preferences.reducedMotion ||
                Boolean(this.mediaMotion?.matches);

            this.root.dataset.terminalReducedMotion =
                reducedMotion ? "true" : "false";

            this.root.dataset.terminalHighContrast =
                this.preferences.highContrast
                    ? "true"
                    : "false";

            this.root.classList.toggle(
                "terminal-reduced-motion",
                reducedMotion
            );

            this.root.classList.toggle(
                "terminal-high-contrast",
                this.preferences.highContrast
            );
        }

        _syncState() {
            if (
                this.syncingState ||
                this.destroyed
            ) {
                return false;
            }

            const state =
                this.context.state ||
                this.context.stateStore;

            if (!state?.set) {
                return false;
            }

            this.syncingState = true;

            try {
                state.set(
                    "settings.theme",
                    {
                        current: this.current,
                        previous: this.previous,
                        previewing:
                            this.previewing,
                        followSystem:
                            this.preferences.followSystem,
                        fontSize:
                            this.preferences.fontSize,
                        lineHeight:
                            this.preferences.lineHeight,
                        fontFamily:
                            this.preferences.fontFamily,
                        reducedMotion:
                            this.preferences.reducedMotion,
                        highContrast:
                            this.preferences.highContrast,
                        schedule:
                            clone(
                                this.preferences.schedule
                            ),
                        available:
                            this.list().map(
                                theme => theme.id
                            ),
                        updatedAt: iso()
                    },
                    {
                        source: "theme",
                        undoable: false,
                        persist: false,
                        broadcast: false
                    }
                );

                return true;
            } catch (_error) {
                return false;
            } finally {
                this.syncingState = false;
            }
        }

        register(name, definition, options = {}) {
            this._assertActive();

            const id =
                normalizeId(
                    name ||
                    definition?.id ||
                    definition?.name
                );

            const theme =
                this._validateTheme({
                    ...clone(definition),
                    id,
                    builtin:
                        options.builtin === true
                });

            if (
                this.registry.has(id) &&
                options.replace !== true &&
                options.builtin !== true
            ) {
                throw new Error(
                    `Theme already exists: ${id}`
                );
            }

            this.registry.set(id, theme);
            this.metrics.registrations += 1;

            if (
                options.persist !== false &&
                options.builtin !== true
            ) {
                void this.persistPreferences();
            }

            if (options.silent !== true) {
                this._emit("register", {
                    theme: clone(theme)
                });
            }

            return clone(theme);
        }

        unregister(name, options = {}) {
            this._assertActive();

            const id = normalizeId(name);
            const theme = this.registry.get(id);

            if (!theme) {
                return false;
            }

            if (
                theme.builtin &&
                options.force !== true
            ) {
                throw new Error(
                    `Built-in theme cannot be removed: ${id}`
                );
            }

            if (this.current === id) {
                this.apply(DEFAULT_THEME, {
                    source: "unregister"
                });
            }

            const removed =
                this.registry.delete(id);

            if (
                removed &&
                options.persist !== false
            ) {
                void this.persistPreferences();
            }

            if (removed) {
                this._emit("unregister", { id });
            }

            return removed;
        }

        apply(name, options = {}) {
            this._assertActive();

            if (this.applying) {
                return this.get(name);
            }

            this.applying = true;

            try {
                const id = normalizeId(name);
                const theme =
                    this._resolveTheme(id);

                const prior =
                    this.current;

                if (options.preview === true) {
                    this.previewing = id;
                } else {
                    this.previous = prior;
                    this.current = id;
                    this.previewing = null;
                }

                this._applyThemeVariables(theme);
                this._applyPreferences();

                if (
                    options.preview !== true &&
                    options.recordHistory !== false
                ) {
                    this.history.push({
                        theme: id,
                        previous: prior,
                        appliedAt: iso(),
                        source:
                            options.source ||
                            "manual"
                    });

                    while (
                        this.history.length >
                        this.maxHistory
                    ) {
                        this.history.shift();
                    }
                }

                if (
                    options.preview !== true &&
                    options.persist !== false
                ) {
                    this.preferences.theme = id;
                    void this.persistPreferences();
                }

                this._syncState();

                if (options.preview === true) {
                    this.metrics.previews += 1;
                } else {
                    this.metrics.applications += 1;
                }

                this._emit(
                    options.preview === true
                        ? "preview"
                        : "apply",
                    {
                        id,
                        theme: clone(theme),
                        previous: prior,
                        source:
                            options.source ||
                            "manual"
                    }
                );

                return clone(theme);
            } finally {
                this.applying = false;
            }
        }

        preview(name) {
            return this.apply(name, {
                preview: true,
                persist: false,
                recordHistory: false,
                source: "preview"
            });
        }

        commitPreview() {
            if (!this.previewing) {
                return null;
            }

            const id = this.previewing;
            this.previewing = null;

            return this.apply(id, {
                source: "preview-commit"
            });
        }

        cancelPreview() {
            if (!this.previewing) {
                return null;
            }

            const restore =
                this.current ||
                DEFAULT_THEME;

            this.previewing = null;

            const theme =
                this._resolveTheme(restore);

            this._applyThemeVariables(theme);
            this._applyPreferences();
            this._syncState();

            this._emit("preview-cancel", {
                restored: restore
            });

            return clone(theme);
        }

        get(name = this.current) {
            if (!name) {
                return null;
            }

            return clone(
                this._resolveTheme(name)
            );
        }

        list(options = {}) {
            let themes =
                Array.from(this.registry.values())
                    .map(theme => ({
                        id: theme.id,
                        name: theme.name,
                        description:
                            theme.description,
                        mode: theme.mode,
                        extends: theme.extends,
                        builtin:
                            theme.builtin === true,
                        current:
                            theme.id === this.current,
                        previewing:
                            theme.id === this.previewing
                    }));

            if (options.mode) {
                themes = themes.filter(
                    theme =>
                        theme.mode === options.mode
                );
            }

            if (options.customOnly === true) {
                themes = themes.filter(
                    theme => !theme.builtin
                );
            }

            if (options.builtinOnly === true) {
                themes = themes.filter(
                    theme => theme.builtin
                );
            }

            return themes.sort((left, right) =>
                left.name.localeCompare(
                    right.name
                )
            );
        }

        setPreference(name, value, options = {}) {
            this._assertActive();

            switch (name) {
                case "fontSize":
                    this.preferences.fontSize =
                        parseNumber(
                            value,
                            this.preferences.fontSize,
                            MIN_FONT_SIZE,
                            MAX_FONT_SIZE
                        );
                    break;

                case "lineHeight":
                    this.preferences.lineHeight =
                        parseNumber(
                            value,
                            this.preferences.lineHeight,
                            MIN_LINE_HEIGHT,
                            MAX_LINE_HEIGHT
                        );
                    break;

                case "fontFamily":
                    this.preferences.fontFamily =
                        String(
                            value ||
                            DEFAULT_FONT_FAMILY
                        );
                    break;

                case "followSystem":
                case "reducedMotion":
                case "highContrast":
                    this.preferences[name] =
                        parseBoolean(
                            value,
                            this.preferences[name]
                        );
                    break;

                default:
                    throw new Error(
                        `Unknown theme preference: ${name}`
                    );
            }

            this._applyPreferences();

            if (
                name === "followSystem" &&
                this.preferences.followSystem
            ) {
                this._handleSystemChange();
            }

            if (options.persist !== false) {
                void this.persistPreferences();
            }

            this.metrics.preferenceChanges += 1;
            this._syncState();

            this._emit("preference", {
                name,
                value:
                    clone(this.preferences[name])
            });

            return clone(
                this.preferences[name]
            );
        }

        setFontSize(value, options = {}) {
            return this.setPreference(
                "fontSize",
                value,
                options
            );
        }

        setLineHeight(value, options = {}) {
            return this.setPreference(
                "lineHeight",
                value,
                options
            );
        }

        setFontFamily(value, options = {}) {
            return this.setPreference(
                "fontFamily",
                value,
                options
            );
        }

        resetPreferences(options = {}) {
            this.preferences = {
                theme: DEFAULT_THEME,
                followSystem: false,
                fontSize: DEFAULT_FONT_SIZE,
                lineHeight:
                    DEFAULT_LINE_HEIGHT,
                fontFamily:
                    DEFAULT_FONT_FAMILY,
                reducedMotion: false,
                highContrast: false,
                schedule: null
            };

            this.apply(DEFAULT_THEME, {
                persist: false,
                source: "reset"
            });

            this._applyPreferences();

            if (options.persist !== false) {
                void this.persistPreferences();
            }

            this._scheduleNextTransition();
            this._syncState();
            this._emit("reset", {});

            return this.status();
        }

        setSchedule(schedule, options = {}) {
            this._assertActive();

            if (
                schedule === null ||
                schedule === false
            ) {
                this.preferences.schedule = null;
                window.clearTimeout(
                    this.scheduleTimer
                );
                this.scheduleTimer = 0;

                if (options.persist !== false) {
                    void this.persistPreferences();
                }

                this._emit("schedule", {
                    schedule: null
                });

                return null;
            }

            if (!isObject(schedule)) {
                throw new TypeError(
                    "Theme schedule must be an object."
                );
            }

            const normalized = {
                lightTheme:
                    normalizeId(
                        schedule.lightTheme ||
                        "light"
                    ),
                darkTheme:
                    normalizeId(
                        schedule.darkTheme ||
                        DEFAULT_THEME
                    ),
                lightStart:
                    String(
                        schedule.lightStart ||
                        "07:00"
                    ),
                darkStart:
                    String(
                        schedule.darkStart ||
                        "19:00"
                    ),
                enabled:
                    schedule.enabled !== false
            };

            for (const time of [
                normalized.lightStart,
                normalized.darkStart
            ]) {
                if (!/^\d{2}:\d{2}$/.test(time)) {
                    throw new TypeError(
                        `Invalid schedule time: ${time}`
                    );
                }

                const [hour, minute] =
                    time.split(":").map(Number);

                if (
                    hour < 0 ||
                    hour > 23 ||
                    minute < 0 ||
                    minute > 59
                ) {
                    throw new TypeError(
                        `Invalid schedule time: ${time}`
                    );
                }
            }

            if (
                !this.registry.has(
                    normalized.lightTheme
                )
            ) {
                throw new Error(
                    `Unknown light theme: ${normalized.lightTheme}`
                );
            }

            if (
                !this.registry.has(
                    normalized.darkTheme
                )
            ) {
                throw new Error(
                    `Unknown dark theme: ${normalized.darkTheme}`
                );
            }

            this.preferences.schedule =
                normalized;

            if (options.persist !== false) {
                void this.persistPreferences();
            }

            this._scheduleNextTransition();
            this._applyScheduledTheme();

            this._emit("schedule", {
                schedule: clone(normalized)
            });

            this._syncState();

            return clone(normalized);
        }

        _timeToMinutes(value) {
            const [hour, minute] =
                value.split(":").map(Number);

            return hour * 60 + minute;
        }

        _applyScheduledTheme() {
            if (this.destroyed) {
                return null;
            }

            const schedule =
                this.preferences.schedule;

            if (!schedule?.enabled) {
                return null;
            }

            const date = new Date();
            const current =
                date.getHours() * 60 +
                date.getMinutes();

            const light =
                this._timeToMinutes(
                    schedule.lightStart
                );

            const dark =
                this._timeToMinutes(
                    schedule.darkStart
                );

            const theme =
                light < dark
                    ? (
                        current >= light &&
                        current < dark
                            ? schedule.lightTheme
                            : schedule.darkTheme
                    )
                    : (
                        current >= light ||
                        current < dark
                            ? schedule.lightTheme
                            : schedule.darkTheme
                    );

            if (theme !== this.current) {
                this.metrics.scheduledChanges += 1;

                return this.apply(theme, {
                    source: "schedule"
                });
            }

            return this.get(theme);
        }

        _scheduleNextTransition() {
            window.clearTimeout(
                this.scheduleTimer
            );

            this.scheduleTimer = 0;

            const schedule =
                this.preferences.schedule;

            if (!schedule?.enabled) {
                return;
            }

            const nowDate = new Date();

            const transitions = [
                schedule.lightStart,
                schedule.darkStart
            ]
                .map(time => {
                    const [hour, minute] =
                        time.split(":").map(Number);

                    const next =
                        new Date(nowDate);

                    next.setHours(
                        hour,
                        minute,
                        0,
                        0
                    );

                    if (next <= nowDate) {
                        next.setDate(
                            next.getDate() + 1
                        );
                    }

                    return next;
                })
                .sort((left, right) =>
                    left - right
                );

            const delay = Math.max(
                1000,
                transitions[0] - nowDate
            );

            this.scheduleTimer =
                window.setTimeout(
                    () => {
                        if (this.destroyed) {
                            return;
                        }

                        this._applyScheduledTheme();
                        this._scheduleNextTransition();
                    },
                    Math.min(
                        delay,
                        2147483647
                    )
                );
        }

        audit(name = this.current) {
            const theme = this.get(name);

            if (!theme) {
                throw new Error(
                    `Unknown terminal theme: ${name}`
                );
            }

            const pairs = [
                ["foreground", "background"],
                ["foregroundMuted", "background"],
                ["accent", "background"],
                ["success", "background"],
                ["warning", "background"],
                ["error", "background"],
                ["info", "background"],
                ["link", "background"]
            ];

            const results =
                pairs.map(
                    ([foregroundKey, backgroundKey]) => {
                        const foreground =
                            theme.colors[
                                foregroundKey
                            ];

                        const background =
                            theme.colors[
                                backgroundKey
                            ];

                        const ratio =
                            contrastRatio(
                                foreground,
                                background
                            );

                        return {
                            foreground:
                                foregroundKey,
                            background:
                                backgroundKey,
                            foregroundColor:
                                foreground,
                            backgroundColor:
                                background,
                            ratio,
                            aaNormal:
                                ratio !== null
                                    ? ratio >= 4.5
                                    : null,
                            aaLarge:
                                ratio !== null
                                    ? ratio >= 3
                                    : null,
                            aaaNormal:
                                ratio !== null
                                    ? ratio >= 7
                                    : null,
                            aaaLarge:
                                ratio !== null
                                    ? ratio >= 4.5
                                    : null
                        };
                    }
                );

            return {
                theme: theme.id,
                mode: theme.mode,
                results,
                passingAA:
                    results.filter(
                        result => result.aaNormal
                    ).length,
                testable:
                    results.filter(
                        result => result.ratio !== null
                    ).length
            };
        }

        export(name = null, options = {}) {
            const themes = {};

            if (name) {
                const id = normalizeId(name);
                const theme =
                    this.registry.get(id);

                if (!theme) {
                    throw new Error(
                        `Unknown terminal theme: ${id}`
                    );
                }

                themes[id] = clone(theme);
            } else {
                for (
                    const [id, theme]
                    of this.registry
                ) {
                    if (
                        options.includeBuiltin === true ||
                        !theme.builtin
                    ) {
                        themes[id] = clone(theme);
                    }
                }
            }

            const payload = {
                schema: THEME_SCHEMA,
                schemaVersion:
                    THEME_SCHEMA_VERSION,
                exportedAt: iso(),
                current: this.current,
                preferences:
                    clone(this.preferences),
                themes
            };

            this.metrics.exports += 1;

            this._emit("export", {
                themes:
                    Object.keys(themes)
            });

            return options.stringify === false
                ? payload
                : safeStringify(
                    payload,
                    options.compact === true
                );
        }

        import(input, options = {}) {
            const payload =
                typeof input === "string"
                    ? JSON.parse(input)
                    : clone(input);

            if (!isObject(payload)) {
                throw new TypeError(
                    "Theme import must be an object or JSON string."
                );
            }

            const themes =
                isObject(payload.themes)
                    ? payload.themes
                    : payload.id
                        ? {
                            [payload.id]: payload
                        }
                        : payload;

            const entries =
                Object.entries(themes);

            if (
                entries.length >
                this.maxImport
            ) {
                throw new RangeError(
                    `Theme import exceeds limit: ${this.maxImport}`
                );
            }

            const imported = [];
            const skipped = [];

            for (const [id, definition] of entries) {
                try {
                    const registered =
                        this.register(
                            id,
                            definition,
                            {
                                replace:
                                    options.replace === true,
                                persist: false
                            }
                        );

                    imported.push(
                        registered.id
                    );
                } catch (error) {
                    skipped.push({
                        id,
                        error:
                            error.message
                    });

                    if (options.strict === true) {
                        throw error;
                    }
                }
            }

            if (
                payload.preferences &&
                options.preferences !== false
            ) {
                const preferences =
                    payload.preferences;

                if (
                    preferences.fontSize !== undefined
                ) {
                    this.setFontSize(
                        preferences.fontSize,
                        { persist: false }
                    );
                }

                if (
                    preferences.lineHeight !== undefined
                ) {
                    this.setLineHeight(
                        preferences.lineHeight,
                        { persist: false }
                    );
                }

                if (
                    preferences.fontFamily !== undefined
                ) {
                    this.setFontFamily(
                        preferences.fontFamily,
                        { persist: false }
                    );
                }

                this.preferences.followSystem =
                    preferences.followSystem === true;

                this.preferences.reducedMotion =
                    preferences.reducedMotion === true;

                this.preferences.highContrast =
                    preferences.highContrast === true;

                if (preferences.schedule) {
                    this.setSchedule(
                        preferences.schedule,
                        { persist: false }
                    );
                }
            }

            if (
                options.apply === true &&
                payload.current &&
                this.registry.has(payload.current)
            ) {
                this.apply(payload.current, {
                    persist: false,
                    source: "import"
                });
            }

            void this.persistPreferences();
            this._syncState();

            this.metrics.imports +=
                imported.length;

            this._emit("import", {
                imported,
                skipped
            });

            return {
                imported,
                skipped
            };
        }

        async loadJSON(source, options = {}) {
            this._assertActive();

            const payload =
                await readJSONSource(
                    source,
                    options
                );

            const result =
                this.import(payload, {
                    replace:
                        options.replace !== false,
                    strict:
                        options.strict === true,
                    apply:
                        options.apply === true,
                    preferences:
                        options.preferences !== false
                });

            this.metrics.jsonLoads += 1;

            this._emit("json-load", {
                source:
                    typeof source === "string"
                        ? source
                        : "object",
                imported:
                    result.imported,
                skipped:
                    result.skipped
            });

            return result;
        }

        async loadJSONFiles(sources, options = {}) {
            const list =
                Array.isArray(sources)
                    ? sources
                    : [sources];

            const loaded = [];
            const failed = [];

            for (const source of list) {
                try {
                    loaded.push({
                        source,
                        result:
                            await this.loadJSON(
                                source,
                                options
                            )
                    });
                } catch (error) {
                    failed.push({
                        source,
                        error:
                            error.message
                    });

                    if (options.strict === true) {
                        throw error;
                    }
                }
            }

            return {
                loaded,
                failed
            };
        }

        async persistPreferences() {
            const customThemes = {};

            for (
                const [id, theme]
                of this.registry
            ) {
                if (!theme.builtin) {
                    customThemes[id] = clone(theme);
                }
            }

            const payload = {
                schema: THEME_SCHEMA,
                schemaVersion:
                    THEME_SCHEMA_VERSION,
                savedAt: iso(),
                preferences:
                    clone(this.preferences),
                customThemes
            };

            try {
                if (this.storage?.set) {
                    await this.storage.set(
                        this.storageKey,
                        payload
                    );
                } else {
                    window.localStorage?.setItem?.(
                        this.storageKey,
                        safeStringify(payload, true)
                    );
                }

                this.metrics.persistenceWrites += 1;
                return true;
            } catch (error) {
                this._recordError(error);
                return false;
            }
        }

        async loadPreferences() {
            let payload = null;

            try {
                if (this.storage?.get) {
                    payload =
                        await this.storage.get(
                            this.storageKey,
                            null
                        );
                } else {
                    const raw =
                        window.localStorage
                            ?.getItem?.(
                                this.storageKey
                            );

                    payload =
                        raw
                            ? JSON.parse(raw)
                            : null;
                }
            } catch (error) {
                this._recordError(error);
                return false;
            }

            if (!isObject(payload)) {
                return false;
            }

            this.metrics.persistenceReads += 1;

            const preferences =
                payload.preferences || {};

            this.preferences.theme =
                preferences.theme ||
                this.preferences.theme;

            this.preferences.followSystem =
                preferences.followSystem === true;

            this.preferences.fontSize =
                parseNumber(
                    preferences.fontSize,
                    this.preferences.fontSize,
                    MIN_FONT_SIZE,
                    MAX_FONT_SIZE
                );

            this.preferences.lineHeight =
                parseNumber(
                    preferences.lineHeight,
                    this.preferences.lineHeight,
                    MIN_LINE_HEIGHT,
                    MAX_LINE_HEIGHT
                );

            this.preferences.fontFamily =
                preferences.fontFamily ||
                this.preferences.fontFamily;

            this.preferences.reducedMotion =
                preferences.reducedMotion === true;

            this.preferences.highContrast =
                preferences.highContrast === true;

            this.preferences.schedule =
                isObject(preferences.schedule)
                    ? clone(preferences.schedule)
                    : null;

            for (
                const [id, theme]
                of Object.entries(
                    payload.customThemes || {}
                )
            ) {
                try {
                    this.register(
                        id,
                        theme,
                        {
                            replace: true,
                            persist: false,
                            silent: true
                        }
                    );
                } catch (error) {
                    this._recordError(error);
                }
            }

            return true;
        }

        watch(callback, options = {}) {
            this._assertActive();

            if (typeof callback !== "function") {
                throw new TypeError(
                    "Theme watcher must be a function."
                );
            }

            this.watchers.add(callback);

            if (options.immediate === true) {
                callback(
                    {
                        type: "initial",
                        timestamp: iso(),
                        current: this.current,
                        status: this.status()
                    },
                    this
                );
            }

            return () =>
                this.watchers.delete(callback);
        }

        status() {
            return {
                name: "theme",
                module: MODULE_NAME,
                version: VERSION,
                ready: this.ready,
                current: this.current,
                previous: this.previous,
                previewing:
                    this.previewing,
                mode:
                    this.current
                        ? this.get(this.current)?.mode
                        : null,
                available: this.list(),
                preferences:
                    clone(this.preferences),
                system: {
                    dark:
                        Boolean(
                            this.mediaDark?.matches
                        ),
                    highContrast:
                        Boolean(
                            this.mediaContrast?.matches
                        ),
                    reducedMotion:
                        Boolean(
                            this.mediaMotion?.matches
                        )
                },
                history:
                    clone(this.history),
                storageKey:
                    this.storageKey,
                lastError:
                    this.lastError
                        ? {
                            name:
                                this.lastError.name,
                            message:
                                this.lastError.message
                        }
                        : null,
                metrics: {
                    ...this.metrics
                },
                limits: {
                    history:
                        this.maxHistory,
                    import:
                        this.maxImport
                },
                destroyed:
                    this.destroyed
            };
        }

        async run(parameters = {}) {
            const args =
                Array.isArray(parameters.args)
                    ? parameters.args
                    : [];

            const parsed =
                parseArguments(args);

            const action =
                parsed.action;

            const positional =
                parsed.positional;

            const options =
                parsed.options;

            if (this.registry.has(action)) {
                return {
                    applied: action,
                    theme:
                        this.apply(action)
                };
            }

            switch (action) {
                case "status":
                case "show":
                case "info":
                    return this.status();

                case "list":
                case "themes":
                    return {
                        current: this.current,
                        themes:
                            this.list({
                                mode:
                                    options.mode,
                                customOnly:
                                    options.custom === true,
                                builtinOnly:
                                    options.builtin === true
                            })
                    };

                case "apply":
                case "set":
                    if (!positional[0]) {
                        throw new Error(
                            "Usage: theme apply <name>"
                        );
                    }

                    return {
                        applied: positional[0],
                        theme:
                            this.apply(
                                positional[0]
                            )
                    };

                case "preview":
                    if (!positional[0]) {
                        throw new Error(
                            "Usage: theme preview <name>"
                        );
                    }

                    return {
                        previewing:
                            positional[0],
                        theme:
                            this.preview(
                                positional[0]
                            )
                    };

                case "commit":
                    return {
                        committed:
                            this.previewing,
                        theme:
                            this.commitPreview()
                    };

                case "cancel":
                    return {
                        restored:
                            this.current,
                        theme:
                            this.cancelPreview()
                    };

                case "get":
                    return this.get(
                        positional[0] ||
                        this.current
                    );

                case "font-size":
                case "fontsize":
                    if (!positional[0]) {
                        return {
                            fontSize:
                                this.preferences.fontSize
                        };
                    }

                    return {
                        fontSize:
                            this.setFontSize(
                                positional[0]
                            )
                    };

                case "line-height":
                case "lineheight":
                    if (!positional[0]) {
                        return {
                            lineHeight:
                                this.preferences.lineHeight
                        };
                    }

                    return {
                        lineHeight:
                            this.setLineHeight(
                                positional[0]
                            )
                    };

                case "font":
                    if (!positional.length) {
                        return {
                            fontFamily:
                                this.preferences.fontFamily
                        };
                    }

                    return {
                        fontFamily:
                            this.setFontFamily(
                                positional.join(" ")
                            )
                    };

                case "system":
                    this.setPreference(
                        "followSystem",
                        positional[0] === undefined
                            ? true
                            : parseBoolean(
                                positional[0],
                                true
                            )
                    );

                    return this.status();

                case "contrast":
                    return this.audit(
                        positional[0] ||
                        this.current
                    );

                case "schedule":
                    if (
                        !positional.length &&
                        !Object.keys(options).length
                    ) {
                        return clone(
                            this.preferences.schedule
                        );
                    }

                    if (positional[0] === "off") {
                        this.setSchedule(null);

                        return {
                            schedule: null
                        };
                    }

                    return {
                        schedule:
                            this.setSchedule({
                                lightTheme:
                                    options.light ||
                                    positional[0] ||
                                    "light",
                                darkTheme:
                                    options.dark ||
                                    positional[1] ||
                                    DEFAULT_THEME,
                                lightStart:
                                    options["light-start"] ||
                                    "07:00",
                                darkStart:
                                    options["dark-start"] ||
                                    "19:00",
                                enabled: true
                            })
                    };

                case "register": {
                    const id =
                        positional.shift();

                    if (
                        !id ||
                        !positional.length
                    ) {
                        throw new Error(
                            "Usage: theme register <id> <JSON-definition>"
                        );
                    }

                    return this.register(
                        id,
                        JSON.parse(
                            positional.join(" ")
                        ),
                        {
                            replace:
                                options.replace === true
                        }
                    );
                }

                case "load":
                case "load-json":
                case "json":
                    if (!positional.length) {
                        throw new Error(
                            "Usage: theme load-json <URL-or-JSON>"
                        );
                    }

                    return this.loadJSON(
                        positional.join(" "),
                        {
                            replace:
                                options.replace !== false,
                            strict:
                                options.strict === true,
                            apply:
                                options.apply === true
                        }
                    );

                case "remove":
                case "unregister":
                    if (!positional[0]) {
                        throw new Error(
                            "Usage: theme remove <name>"
                        );
                    }

                    return {
                        removed:
                            this.unregister(
                                positional[0],
                                {
                                    force:
                                        options.force === true
                                }
                            )
                    };

                case "export":
                    return this.export(
                        positional[0] || null,
                        {
                            stringify:
                                options.json !== true,
                            includeBuiltin:
                                options.builtin === true,
                            compact:
                                options.compact === true
                        }
                    );

                case "import":
                    if (!positional.length) {
                        throw new Error(
                            "Usage: theme import <JSON>"
                        );
                    }

                    return this.import(
                        positional.join(" "),
                        {
                            replace:
                                options.replace === true,
                            strict:
                                options.strict === true,
                            apply:
                                options.apply === true
                        }
                    );

                case "reset":
                    return this.resetPreferences();

                default:
                    throw new Error(
                        `Unknown theme action "${action}".`
                    );
            }
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            void this.persistPreferences();

            window.clearTimeout(
                this.scheduleTimer
            );

            this.scheduleTimer = 0;

            for (
                const media
                of this.mediaBindings
            ) {
                if (
                    typeof media?.removeEventListener ===
                    "function"
                ) {
                    media.removeEventListener(
                        "change",
                        this._boundSystemChange
                    );
                } else {
                    media?.removeListener?.(
                        this._boundSystemChange
                    );
                }
            }

            this.mediaBindings = [];

            this._emit("destroy", {
                version: VERSION
            });

            this.watchers.clear();

            if (
                this.context.root?.[
                    THEME_SYMBOL
                ] === this
            ) {
                delete this.context.root[
                    THEME_SYMBOL
                ];
            }

            if (
                this.root?.[THEME_SYMBOL] === this
            ) {
                delete this.root[THEME_SYMBOL];
            }

            this.destroyed = true;

            return true;
        }
    }

    function getService(context) {
        return (
            context?.theme ||
            context?.services?.get?.("theme") ||
            context?.services?.theme ||
            null
        );
    }

    async function initialize(context = {}) {
        const safeContext =
            isObject(context)
                ? context
                : {};

        const root =
            isElement(safeContext.root)
                ? safeContext.root
                : document.documentElement;

        const existing =
            safeContext.theme instanceof
                ThemeManager
                ? safeContext.theme
                : safeContext.services?.get?.(
                    "theme"
                ) ||
                root?.[THEME_SYMBOL];

        if (
            existing instanceof ThemeManager &&
            !existing.destroyed
        ) {
            safeContext.theme = existing;

            safeContext.registerService?.(
                "theme",
                existing
            );

            return existing;
        }

        const dataset =
            root.dataset || {};

        const config =
            safeContext.config?.theme || {};

        const manager =
            new ThemeManager(
                safeContext,
                {
                    root,
                    storage:
                        safeContext.storage ||
                        safeContext.services?.get?.(
                            "storage"
                        ) ||
                        null,
                    storageKey:
                        dataset.terminalThemeStorageKey ||
                        config.storageKey ||
                        STORAGE_KEY,
                    defaultTheme:
                        dataset.terminalThemeDefault ||
                        config.defaultTheme ||
                        DEFAULT_THEME,
                    followSystem:
                        parseBoolean(
                            dataset.terminalThemeFollowSystem,
                            config.followSystem === true
                        ),
                    fontSize:
                        dataset.terminalFontSize ||
                        config.fontSize ||
                        DEFAULT_FONT_SIZE,
                    lineHeight:
                        dataset.terminalLineHeight ||
                        config.lineHeight ||
                        DEFAULT_LINE_HEIGHT,
                    fontFamily:
                        dataset.terminalFontFamily ||
                        config.fontFamily ||
                        DEFAULT_FONT_FAMILY,
                    reducedMotion:
                        parseBoolean(
                            dataset.terminalReducedMotion,
                            config.reducedMotion === true
                        ),
                    highContrast:
                        parseBoolean(
                            dataset.terminalHighContrast,
                            config.highContrast === true
                        ),
                    maxHistory:
                        dataset.terminalThemeHistory ||
                        config.maxHistory ||
                        DEFAULT_HISTORY_LIMIT,
                    maxImport:
                        dataset.terminalThemeImportLimit ||
                        config.maxImport ||
                        DEFAULT_IMPORT_LIMIT
                }
            );

        root[THEME_SYMBOL] = manager;
        safeContext.theme = manager;

        safeContext.registerService?.(
            "theme",
            manager
        );

        await manager.initialize({
            initialTheme:
                dataset.terminalTheme ||
                config.initialTheme ||
                null,
            themeFiles:
                config.files ||
                config.themeFiles ||
                null
        });

        safeDispatch(
            document,
            "speciedex:terminal-theme-ready",
            {
                manager,
                status:
                    manager.status(),
                version: VERSION
            }
        );

        return manager;
    }

    function resolveCommandContext(payload = {}) {
        return (
            payload.context ||
            payload.terminal?.context ||
            payload.app?.context ||
            payload
        );
    }

    const commands = [{
        name: "theme",
        aliases: ["themes"],
        category: "interface",
        description:
            "List, apply, customize, audit, load JSON, import, and export terminal themes.",
        usage:
            "theme [status|list|apply|preview|commit|cancel|get|font-size|" +
            "line-height|font|system|contrast|schedule|register|load-json|" +
            "remove|export|import|reset] [arguments]",

        handler: async payload => {
            const context =
                resolveCommandContext(payload);

            const manager =
                getService(context);

            if (!manager) {
                throw new Error(
                    "Theme service is unavailable."
                );
            }

            try {
                const result =
                    await manager.run({
                        args:
                            Array.isArray(payload.args)
                                ? payload.args
                                : []
                    });

                if (
                    typeof result === "string" &&
                    typeof payload.write === "function"
                ) {
                    return payload.write(
                        result,
                        "data"
                    );
                }

                if (
                    typeof payload.writeJSON ===
                    "function"
                ) {
                    return payload.writeJSON(result);
                }

                if (
                    typeof payload.write === "function"
                ) {
                    return payload.write(
                        safeStringify(result),
                        "data"
                    );
                }

                return result;
            } catch (error) {
                if (
                    typeof payload.writeError ===
                    "function"
                ) {
                    payload.writeError(
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
        THEME_SYMBOL,
        ThemeManager,
        THEMES: BUILTIN_THEMES,
        COLOR_KEYS,
        STYLE_KEYS,
        CSS_VARIABLES,
        contrastRatio,
        colorToRgb,
        readJSONSource,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalTheme = api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules || {};

    window.SpeciedexTerminalModules[MODULE_NAME] =
        api;

    safeDispatch(
        document,
        "speciedex:terminal-module-available",
        {
            name: MODULE_NAME,
            module: api
        }
    );
})(window, document);
