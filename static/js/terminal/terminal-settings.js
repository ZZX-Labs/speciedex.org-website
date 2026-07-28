/*
========================================================================
Speciedex.org
Terminal Settings Manager
========================================================================

Typed settings registry and runtime configuration service for
SpeciedexTerminal.

Provides:

    • typed setting definitions
    • defaults and validation
    • persistent storage
    • cross-tab synchronization
    • settings profiles
    • import and export
    • reset and reset-all operations
    • change subscriptions
    • change history
    • CSS custom-property and data-attribute application
    • reduced-motion integration
    • terminal commands
    • clean teardown

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Settings";
    const VERSION = "2.1.0";
    const STORAGE_PREFIX = "speciedex-terminal:settings:";
    const PROFILE_PREFIX = "speciedex-terminal:settings-profile:";

    const SETTINGS_SYMBOL =
        Symbol.for(
            "speciedex.terminal.settings.instance"
        );

    const RESERVED_KEYS =
        new Set([
            "__proto__",
            "prototype",
            "constructor"
        ]);

    const activeDispatches =
        new WeakMap();

    const DEFAULTS = Object.freeze({
        pageSize: 50,
        animation: true,
        reducedMotion: false,
        compactTables: false,
        autoScroll: true,
        terminalTheme: "speciedex",
        terminalLayout: "standard",
        outputFormat: "table",
        searchFuzzy: true,
        searchLimit: 50,
        scanBatchSize: 100,
        mapBasemap: "osm-dark",
        mapAnimation: true,
        notifications: true,
        notificationTimeout: 4000,
        persistHistory: true,
        recentLimit: 5000,
        splashEnabled: true,
        splashInterval: 140,
        splashVisibleRows: 12,
        loadingOverlay: true,
        loadingMinimumDuration: 250,
        timezone: "UTC",
        locale: "en-US",
        dateFormat: "medium",
        numberFormat: "compact",
        keyboardShortcuts: true,
        confirmDestructiveActions: true,
        telemetry: false,
        debug: false
    });

    const DEFINITIONS = Object.freeze({
        pageSize: {
            type: "integer",
            minimum: 1,
            maximum: 1000,
            category: "data",
            description: "Default table and list page size."
        },
        animation: {
            type: "boolean",
            category: "interface",
            description: "Enable interface animations."
        },
        reducedMotion: {
            type: "boolean",
            category: "accessibility",
            description: "Reduce nonessential motion."
        },
        compactTables: {
            type: "boolean",
            category: "interface",
            description: "Use compact table spacing."
        },
        autoScroll: {
            type: "boolean",
            category: "terminal",
            description: "Automatically scroll terminal output."
        },
        terminalTheme: {
            type: "enum",
            values: ["speciedex", "dark", "high-contrast", "minimal"],
            category: "interface",
            description: "Terminal visual theme."
        },
        terminalLayout: {
            type: "enum",
            values: ["standard", "compact", "wide", "fullscreen"],
            category: "interface",
            description: "Terminal layout mode."
        },
        outputFormat: {
            type: "enum",
            values: ["table", "json", "list", "tree"],
            category: "terminal",
            description: "Default command output format."
        },
        searchFuzzy: {
            type: "boolean",
            category: "search",
            description: "Enable fuzzy search matching."
        },
        searchLimit: {
            type: "integer",
            minimum: 1,
            maximum: 1000,
            category: "search",
            description: "Default search result limit."
        },
        scanBatchSize: {
            type: "integer",
            minimum: 1,
            maximum: 10000,
            category: "scan",
            description: "Default number of records processed per scan batch."
        },
        mapBasemap: {
            type: "enum",
            values: ["osm-dark", "osm-standard", "osm-humanitarian", "none"],
            category: "map",
            description: "Default map basemap."
        },
        mapAnimation: {
            type: "boolean",
            category: "map",
            description: "Enable animated map transitions."
        },
        notifications: {
            type: "boolean",
            category: "notifications",
            description: "Enable terminal notifications."
        },
        notificationTimeout: {
            type: "integer",
            minimum: 0,
            maximum: 600000,
            category: "notifications",
            description: "Default notification timeout in milliseconds."
        },
        persistHistory: {
            type: "boolean",
            category: "storage",
            description: "Persist terminal and search history."
        },
        recentLimit: {
            type: "integer",
            minimum: 10,
            maximum: 100000,
            category: "storage",
            description: "Maximum recent activity entries."
        },
        splashEnabled: {
            type: "boolean",
            category: "splash",
            description: "Enable the live terminal splash."
        },
        splashInterval: {
            type: "integer",
            minimum: 25,
            maximum: 10000,
            category: "splash",
            description: "Splash update interval in milliseconds."
        },
        splashVisibleRows: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            category: "splash",
            description: "Visible species rows in the terminal splash."
        },
        loadingOverlay: {
            type: "boolean",
            category: "loading",
            description: "Display the terminal loading overlay."
        },
        loadingMinimumDuration: {
            type: "integer",
            minimum: 0,
            maximum: 60000,
            category: "loading",
            description: "Minimum loading-overlay display duration."
        },
        timezone: {
            type: "string",
            category: "localization",
            description: "Timezone used for terminal dates."
        },
        locale: {
            type: "string",
            category: "localization",
            description: "Locale used for formatting."
        },
        dateFormat: {
            type: "enum",
            values: ["short", "medium", "long", "full", "iso"],
            category: "localization",
            description: "Default date display style."
        },
        numberFormat: {
            type: "enum",
            values: ["standard", "compact", "scientific"],
            category: "localization",
            description: "Default number display style."
        },
        keyboardShortcuts: {
            type: "boolean",
            category: "accessibility",
            description: "Enable terminal keyboard shortcuts."
        },
        confirmDestructiveActions: {
            type: "boolean",
            category: "safety",
            description: "Require confirmation for destructive commands."
        },
        telemetry: {
            type: "boolean",
            category: "privacy",
            description: "Permit anonymous local telemetry hooks."
        },
        debug: {
            type: "boolean",
            category: "system",
            description: "Enable terminal debugging output."
        }
    });

    function isObject(value) {
        return (
            value !== null &&
            typeof value === "object" &&
            !Array.isArray(value)
        );
    }

    function nowISO(value = Date.now()) {
        const date =
            value instanceof Date
                ? value
                : new Date(value);

        return Number.isFinite(date.getTime())
            ? date.toISOString()
            : new Date().toISOString();
    }

    function dispatchSafe(
        target,
        name,
        detail,
        options = {}
    ) {
        if (
            !target ||
            typeof target.dispatchEvent !== "function" ||
            !name
        ) {
            return false;
        }

        let names =
            activeDispatches.get(target);

        if (!names) {
            names = new Set();
            activeDispatches.set(target, names);
        }

        if (names.has(name)) {
            return false;
        }

        names.add(name);

        try {
            return target.dispatchEvent(
                new CustomEvent(
                    name,
                    {
                        bubbles:
                            options.bubbles === true,
                        cancelable:
                            options.cancelable === true,
                        detail
                    }
                )
            );
        } catch (_error) {
            return false;
        } finally {
            names.delete(name);
        }
    }

    function safeClone(
        value,
        seen = new WeakMap(),
        depth = 0
    ) {
        if (
            value === null ||
            value === undefined ||
            typeof value !== "object"
        ) {
            return typeof value === "bigint"
                ? String(value)
                : value;
        }

        if (depth > 24) {
            return "[Truncated]";
        }

        if (seen.has(value)) {
            return "[Circular]";
        }

        seen.set(value, true);

        if (value instanceof Date) {
            return nowISO(value);
        }

        if (value instanceof Error) {
            return {
                name:
                    value.name,
                message:
                    value.message,
                stack:
                    value.stack ||
                    null
            };
        }

        if (Array.isArray(value)) {
            return value.map(
                item =>
                    safeClone(
                        item,
                        seen,
                        depth + 1
                    )
            );
        }

        const output = {};

        for (
            const [key, item]
            of Object.entries(value)
        ) {
            if (RESERVED_KEYS.has(key)) {
                continue;
            }

            output[key] =
                safeClone(
                    item,
                    seen,
                    depth + 1
                );
        }

        return output;
    }

    function safeStringify(
        value,
        compact = false
    ) {
        return JSON.stringify(
            safeClone(value),
            null,
            compact ? 0 : 2
        );
    }

    function normalizeName(value) {
        const text = String(value ?? "").trim();

        if (!text) {
            throw new Error(
                "A setting name is required."
            );
        }

        if (
            RESERVED_KEYS.has(text)
        ) {
            throw new Error(
                `Invalid setting name: ${text}`
            );
        }

        return text;
    }

    function parseBoolean(value, fallback = false) {
        if (typeof value === "boolean") {
            return value;
        }

        if (value === undefined || value === null || value === "") {
            return fallback;
        }

        const text = String(value).trim().toLowerCase();

        if (["true", "yes", "1", "on", "enable", "enabled"].includes(text)) {
            return true;
        }

        if (["false", "no", "0", "off", "disable", "disabled"].includes(text)) {
            return false;
        }

        return fallback;
    }

    function parseValue(value) {
        if (typeof value !== "string") {
            return value;
        }

        const text = value.trim();

        if (text === "true") return true;
        if (text === "false") return false;
        if (text === "null") return null;

        if (text !== "" && Number.isFinite(Number(text))) {
            return Number(text);
        }

        try {
            if (
                (text.startsWith("{") && text.endsWith("}")) ||
                (text.startsWith("[") && text.endsWith("]"))
            ) {
                return JSON.parse(text);
            }
        } catch (error) {
            // Keep original string.
        }

        return value;
    }

    function safeStorage() {
        try {
            const key = "__speciedex_settings_probe__";
            window.localStorage.setItem(key, key);
            window.localStorage.removeItem(key);
            return window.localStorage;
        } catch (error) {
            return null;
        }
    }

    function clone(value) {
        return safeClone(value);
    }

    function validateValue(name, value, definition) {
        if (!isObject(definition)) {
            throw new TypeError(
                "Setting definition must be an object."
            );
        }

        const result = {
            valid: true,
            value,
            errors: []
        };

        switch (definition.type) {
            case "boolean":
                result.value = parseBoolean(value, Boolean(DEFAULTS[name]));
                break;

            case "integer": {
                const parsed = Number.parseInt(value, 10);

                if (!Number.isFinite(parsed)) {
                    result.valid = false;
                    result.errors.push("Value must be an integer.");
                    break;
                }

                if (
                    definition.minimum !== undefined &&
                    parsed < definition.minimum
                ) {
                    result.valid = false;
                    result.errors.push(
                        `Value must be at least ${definition.minimum}.`
                    );
                }

                if (
                    definition.maximum !== undefined &&
                    parsed > definition.maximum
                ) {
                    result.valid = false;
                    result.errors.push(
                        `Value must not exceed ${definition.maximum}.`
                    );
                }

                result.value = parsed;
                break;
            }

            case "number": {
                const parsed = Number(value);

                if (!Number.isFinite(parsed)) {
                    result.valid = false;
                    result.errors.push("Value must be numeric.");
                } else {
                    result.value = parsed;
                }

                break;
            }

            case "enum": {
                const text = String(value);

                if (!definition.values.includes(text)) {
                    result.valid = false;
                    result.errors.push(
                        `Value must be one of: ${definition.values.join(", ")}.`
                    );
                }

                result.value = text;
                break;
            }

            case "string":
            default:
                result.value = String(value ?? "");
                break;
        }

        if (
            result.valid &&
            typeof definition.validate === "function"
        ) {
            const custom = definition.validate(result.value);

            if (custom !== true) {
                result.valid = false;
                result.errors.push(
                    typeof custom === "string"
                        ? custom
                        : "Custom validation failed."
                );
            }
        }

        return result;
    }

    class Settings extends EventTarget {
        constructor(context = {}, options = {}) {
            super();

            this.context =
                isObject(context)
                    ? context
                    : {};

            this.context.root =
                this.context.root &&
                typeof this.context.root.dispatchEvent ===
                    "function"
                    ? this.context.root
                    : document.documentElement;

            this.options = {
                persist:
                    parseBoolean(
                        options.persist,
                        true
                    ),
                syncTabs:
                    parseBoolean(
                        options.syncTabs,
                        true
                    ),
                historyLimit:
                    Math.max(
                        1,
                        Math.min(
                            100000,
                            Number.parseInt(
                                options.historyLimit,
                                10
                            ) ||
                            500
                        )
                    )
            };

            this.storage = safeStorage();
            this.storageKey =
                `${STORAGE_PREFIX}${
                    this.context.root?.dataset?.terminalInstance ||
                    "default"
                }`;

            this.values = {
                ...DEFAULTS
            };

            this.definitions = new Map(
                Object.entries(DEFINITIONS)
            );

            this.history = [];
            this.subscribers = new Map();
            this.watchers = new Set();
            this.destroyed = false;
            this.emitting = false;

            this.boundStorage = event =>
                this.handleStorage(event);

            this.restore();
            this.applyAll();

            if (this.options.syncTabs) {
                window.addEventListener(
                    "storage",
                    this.boundStorage
                );
            }
        }

        assertActive() {
            if (this.destroyed) {
                throw new Error(
                    "Settings service has been destroyed."
                );
            }
        }

        watch(callback, options = {}) {
            this.assertActive();

            if (typeof callback !== "function") {
                throw new TypeError(
                    "Settings watcher must be a function."
                );
            }

            this.watchers.add(callback);

            if (options.immediate === true) {
                callback(
                    {
                        type:
                            "initial",
                        timestamp:
                            nowISO(),
                        status:
                            this.status()
                    },
                    this
                );
            }

            return () =>
                this.watchers.delete(
                    callback
                );
        }

        define(name, definition, defaultValue) {
            this.assertActive();
            const key = normalizeName(name);

            if (!definition || typeof definition !== "object") {
                throw new TypeError(
                    "Setting definition must be an object."
                );
            }

            this.definitions.set(
                key,
                {
                    ...safeClone(definition),
                    type:
                        definition.type ||
                        "string",
                    category:
                        definition.category ||
                        "custom",
                    description:
                        definition.description ||
                        ""
                }
            );

            if (
                defaultValue !== undefined &&
                this.values[key] === undefined
            ) {
                this.values[key] = defaultValue;
            }

            return this.describe(key);
        }

        has(name) {
            return Object.prototype.hasOwnProperty.call(
                this.values,
                normalizeName(name)
            );
        }

        get(name, fallback = undefined) {
            const key = normalizeName(name);

            return this.values[key] !== undefined
                ? this.values[key]
                : fallback;
        }

        set(name, value, options = {}) {
            this.assertActive();
            const key = normalizeName(name);
            const definition =
                this.definitions.get(key) ||
                {
                    type: "string",
                    category: "custom",
                    description: "Custom runtime setting."
                };

            const validation = validateValue(
                key,
                value,
                definition
            );

            if (!validation.valid) {
                throw new Error(
                    `Invalid value for "${key}": ${validation.errors.join(" ")}`
                );
            }

            const previous = this.values[key];

            if (
                Object.is(previous, validation.value) &&
                options.force !== true
            ) {
                return validation.value;
            }

            this.values[key] = validation.value;

            const entry = {
                timestamp: nowISO(),
                name: key,
                previous: clone(previous),
                value: clone(validation.value),
                source: options.source || "runtime"
            };

            this.history.push(entry);
            this.history = this.history.slice(
                -this.options.historyLimit
            );

            this.apply(key, validation.value);

            if (options.persist !== false) {
                this.persist();
            }

            this.emitChange(key, validation.value, previous, entry);

            return validation.value;
        }

        setMany(values, options = {}) {
            this.assertActive();
            if (!values || typeof values !== "object") {
                throw new TypeError(
                    "Settings update must be an object."
                );
            }

            const result = {
                updated: {},
                errors: {}
            };

            for (
                const [name, value]
                of Object.entries(values)
            ) {
                if (RESERVED_KEYS.has(name)) {
                    result.errors[name] =
                        "Invalid setting name.";
                    continue;
                }
                try {
                    result.updated[name] = this.set(
                        name,
                        value,
                        {
                            ...options,
                            persist: false
                        }
                    );
                } catch (error) {
                    result.errors[name] = error.message;
                }
            }

            if (
                options.persist !== false &&
                Object.keys(result.updated).length
            ) {
                this.persist();
            }

            return result;
        }

        reset(name, options = {}) {
            this.assertActive();
            const key = normalizeName(name);

            if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
                if (options.removeCustom === true) {
                    const previous = this.values[key];
                    delete this.values[key];

                    if (options.persist !== false) {
                        this.persist();
                    }

                    this.emitChange(key, undefined, previous, {
                        timestamp: nowISO(),
                        name: key,
                        previous,
                        value: undefined,
                        source: "reset"
                    });

                    return undefined;
                }

                throw new Error(
                    `No default is defined for setting "${key}".`
                );
            }

            return this.set(
                key,
                DEFAULTS[key],
                {
                    source: "reset",
                    force: true
                }
            );
        }

        resetAll(options = {}) {
            this.assertActive();
            const previous = this.snapshot();
            this.values = {
                ...DEFAULTS
            };

            if (options.removeCustom !== false) {
                for (const key of Object.keys(previous)) {
                    if (
                        !Object.prototype.hasOwnProperty.call(
                            DEFAULTS,
                            key
                        )
                    ) {
                        delete this.values[key];
                    }
                }
            }

            this.applyAll();

            if (options.persist !== false) {
                this.persist();
            }

            this.history.push({
                timestamp: new Date().toISOString(),
                name: "*",
                previous,
                value: this.snapshot(),
                source: "reset-all"
            });

            this.emitChange("*", this.snapshot(), previous, {
                source: "reset-all"
            });

            return this.snapshot();
        }

        snapshot(options = {}) {
            const values = clone(this.values);

            if (options.category) {
                return Object.fromEntries(
                    Object.entries(values).filter(
                        ([name]) =>
                            this.definitions.get(name)?.category ===
                            options.category
                    )
                );
            }

            return values;
        }

        describe(name = null) {
            if (name) {
                const key = normalizeName(name);
                const definition = this.definitions.get(key);

                if (!definition) {
                    return null;
                }

                return {
                    name: key,
                    value: clone(this.values[key]),
                    default: clone(DEFAULTS[key]),
                    ...clone(definition)
                };
            }

            return [...this.definitions.entries()]
                .map(([key, definition]) => ({
                    name: key,
                    value: clone(this.values[key]),
                    default: clone(DEFAULTS[key]),
                    ...clone(definition)
                }))
                .sort((left, right) =>
                    left.category.localeCompare(right.category) ||
                    left.name.localeCompare(right.name)
                );
        }

        categories() {
            return [...new Set(
                [...this.definitions.values()]
                    .map(definition =>
                        definition.category || "other"
                    )
            )].sort();
        }

        subscribe(name, handler) {
            this.assertActive();
            if (typeof handler !== "function") {
                throw new TypeError(
                    "Settings subscriber must be a function."
                );
            }

            const key = name || "*";

            if (!this.subscribers.has(key)) {
                this.subscribers.set(key, new Set());
            }

            this.subscribers.get(key).add(handler);

            return () => {
                this.subscribers.get(key)?.delete(handler);
            };
        }

        emitChange(name, value, previous, entry) {
            if (this.destroyed) {
                return false;
            }

            if (this.emitting) {
                return false;
            }

            const detail = {
                name,
                value:
                    safeClone(value),
                previous:
                    safeClone(previous),
                entry:
                    safeClone(entry)
            };

            this.emitting = true;

            try {
                for (
                    const key
                    of [name, "*"]
                ) {
                    for (
                        const handler
                        of this.subscribers.get(key) ||
                        []
                    ) {
                        try {
                            handler(detail);
                        } catch (_error) {
                            /* Subscriber failures are isolated. */
                        }
                    }
                }

                for (
                    const watcher
                    of Array.from(
                        this.watchers
                    )
                ) {
                    try {
                        watcher(
                            {
                                type:
                                    "change",
                                timestamp:
                                    nowISO(),
                                detail
                            },
                            this
                        );
                    } catch (_error) {
                        /* Watcher failures are isolated. */
                    }
                }

                dispatchSafe(
                    this,
                    "change",
                    detail
                );

                try {
                    this.context.events?.emit?.(
                        "settings:change",
                        detail
                    );
                } catch (_error) {
                    /* External event-bus failures are isolated. */
                }

                dispatchSafe(
                    this.context.root,
                    "speciedex:terminal-settings-change",
                    detail,
                    {
                        bubbles: true
                    }
                );

                dispatchSafe(
                    document,
                    "speciedex:terminal-settings-change",
                    detail
                );

                return true;
            } finally {
                this.emitting = false;
            }
        }

        apply(name, value) {
            const root = this.context.root;

            if (!root) {
                return;
            }

            if (
                /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(
                    name
                )
            ) {
                root.dataset[
                    `setting${name.charAt(0).toUpperCase()}${name.slice(1)}`
                ] = String(value);
            }

            switch (name) {
                case "reducedMotion":
                    root.classList.toggle(
                        "terminal-reduced-motion",
                        Boolean(value)
                    );
                    break;

                case "animation":
                    root.classList.toggle(
                        "terminal-animation-disabled",
                        !value
                    );
                    break;

                case "compactTables":
                    root.classList.toggle(
                        "terminal-compact-tables",
                        Boolean(value)
                    );
                    break;

                case "autoScroll":
                    root.dataset.terminalAutoScroll =
                        String(Boolean(value));
                    break;

                case "terminalTheme":
                    root.dataset.terminalTheme =
                        String(value);
                    (
                        this.context.theme ||
                        this.context.services?.get?.(
                            "theme"
                        )
                    )?.set?.(value);
                    break;

                case "terminalLayout":
                    root.dataset.terminalLayout =
                        String(value);
                    (
                        this.context.layout ||
                        this.context.services?.get?.(
                            "layout"
                        )
                    )?.setMode?.(value);
                    break;

                case "pageSize":
                    root.style.setProperty(
                        "--terminal-page-size",
                        String(value)
                    );
                    break;

                case "splashInterval":
                    root.style.setProperty(
                        "--terminal-splash-interval",
                        `${value}ms`
                    );
                    break;

                case "splashVisibleRows":
                    root.style.setProperty(
                        "--terminal-splash-visible-rows",
                        String(value)
                    );
                    break;

                case "loadingMinimumDuration":
                    root.dataset.terminalLoadingMinimumDuration =
                        String(value);
                    break;

                default:
                    break;
            }
        }

        applyAll() {
            for (const [name, value] of Object.entries(this.values)) {
                this.apply(name, value);
            }
        }

        persist() {
            if (
                !this.options.persist ||
                !this.storage
            ) {
                return false;
            }

            try {
                this.storage.setItem(
                    this.storageKey,
                    safeStringify({
                        version: VERSION,
                        values: this.values,
                        history: this.history
                    })
                );

                return true;
            } catch (error) {
                return false;
            }
        }

        restore() {
            const storageValues =
                this.context.storage?.get?.(
                    "settings",
                    null
                );

            if (isObject(storageValues)) {
                for (
                    const [name, value]
                    of Object.entries(
                        storageValues
                    )
                ) {
                    if (RESERVED_KEYS.has(name)) {
                        continue;
                    }

                    const definition =
                        this.definitions.get(name) ||
                        {
                            type:
                                typeof value === "boolean"
                                    ? "boolean"
                                    : typeof value === "number"
                                        ? "number"
                                        : "string"
                        };

                    const result =
                        validateValue(
                            name,
                            value,
                            definition
                        );

                    if (result.valid) {
                        this.values[name] =
                            result.value;
                    }
                }
            }

            if (!this.storage) {
                return this.snapshot();
            }

            try {
                const payload = JSON.parse(
                    this.storage.getItem(
                        this.storageKey
                    ) || "null"
                );

                if (
                    payload &&
                    payload.values &&
                    typeof payload.values === "object"
                ) {
                    const validated = {};

                    for (
                        const [name, value]
                        of Object.entries(
                            payload.values
                        )
                    ) {
                        if (RESERVED_KEYS.has(name)) {
                            continue;
                        }
                        const definition =
                            this.definitions.get(name) ||
                            {
                                type: typeof value === "boolean"
                                    ? "boolean"
                                    : typeof value === "number"
                                        ? "number"
                                        : "string"
                            };

                        const result = validateValue(
                            name,
                            value,
                            definition
                        );

                        if (result.valid) {
                            validated[name] = result.value;
                        }
                    }

                    this.values = {
                        ...this.values,
                        ...validated
                    };
                }

                this.history = Array.isArray(payload?.history)
                    ? payload.history.slice(
                        -this.options.historyLimit
                    )
                    : [];
            } catch (error) {
                // Ignore malformed persisted state.
            }

            return this.snapshot();
        }

        handleStorage(event) {
            if (
                event.key !== this.storageKey ||
                !event.newValue
            ) {
                return;
            }

            try {
                const payload = JSON.parse(
                    event.newValue
                );

                if (
                    !payload?.values ||
                    typeof payload.values !== "object"
                ) {
                    return;
                }

                this.setMany(
                    payload.values,
                    {
                        persist: false,
                        source: "storage"
                    }
                );
            } catch (error) {
                // Ignore invalid cross-tab payloads.
            }
        }

        saveProfile(name) {
            this.assertActive();
            const profileName = normalizeName(name);
            const key =
                `${PROFILE_PREFIX}${profileName}`;

            if (!this.storage) {
                throw new Error(
                    "Persistent storage is unavailable."
                );
            }

            const profile = {
                version: VERSION,
                name: profileName,
                createdAt: nowISO(),
                values: this.snapshot()
            };

            this.storage.setItem(
                key,
                safeStringify(
                    profile,
                    true
                )
            );

            return profile;
        }

        loadProfile(name) {
            this.assertActive();
            const profileName = normalizeName(name);
            const key =
                `${PROFILE_PREFIX}${profileName}`;

            if (!this.storage) {
                throw new Error(
                    "Persistent storage is unavailable."
                );
            }

            const payload = JSON.parse(
                this.storage.getItem(key) || "null"
            );

            if (!payload?.values) {
                throw new Error(
                    `Unknown settings profile: ${profileName}`
                );
            }

            const result = this.setMany(
                payload.values,
                {
                    source: `profile:${profileName}`
                }
            );

            return {
                profile: payload,
                result
            };
        }

        deleteProfile(name) {
            this.assertActive();
            const profileName = normalizeName(name);

            if (!this.storage) {
                return false;
            }

            const key =
                `${PROFILE_PREFIX}${profileName}`;

            const exists =
                this.storage.getItem(key) !== null;

            this.storage.removeItem(key);

            return exists;
        }

        listProfiles() {
            if (!this.storage) {
                return [];
            }

            const profiles = [];

            for (
                let index = 0;
                index < this.storage.length;
                index += 1
            ) {
                const key = this.storage.key(index);

                if (!key?.startsWith(PROFILE_PREFIX)) {
                    continue;
                }

                try {
                    const payload = JSON.parse(
                        this.storage.getItem(key)
                    );

                    profiles.push({
                        name:
                            payload.name ||
                            key.slice(PROFILE_PREFIX.length),
                        createdAt:
                            payload.createdAt ||
                            null,
                        settings:
                            Object.keys(payload.values || {}).length
                    });
                } catch (error) {
                    // Ignore malformed profiles.
                }
            }

            return profiles.sort((left, right) =>
                left.name.localeCompare(right.name)
            );
        }

        export() {
            return {
                version: VERSION,
                generatedAt: nowISO(),
                values: this.snapshot(),
                definitions: this.describe(),
                history: clone(this.history)
            };
        }

        import(payload, options = {}) {
            this.assertActive();
            let data = payload;

            if (typeof payload === "string") {
                data = JSON.parse(payload);
            }

            const values =
                data?.values &&
                typeof data.values === "object"
                    ? data.values
                    : data;

            if (!values || typeof values !== "object") {
                throw new Error(
                    "Settings import must contain an object of values."
                );
            }

            if (options.replace === true) {
                this.resetAll();
            }

            return this.setMany(
                values,
                {
                    source: "import"
                }
            );
        }

        status() {
            return {
                version: VERSION,
                settings: Object.keys(this.values).length,
                definitions: this.definitions.size,
                profiles: this.listProfiles().length,
                history: this.history.length,
                persistent: Boolean(this.storage),
                syncTabs:
                    this.options.syncTabs,
                subscribers:
                    [...this.subscribers.values()]
                        .reduce(
                            (
                                total,
                                handlers
                            ) =>
                                total +
                                handlers.size,
                            0
                        ),
                watchers:
                    this.watchers.size,
                destroyed:
                    this.destroyed,
                values:
                    this.snapshot()
            };
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            window.removeEventListener(
                "storage",
                this.boundStorage
            );

            dispatchSafe(
                this,
                "destroy",
                {
                    version:
                        VERSION
                }
            );

            this.subscribers.clear();
            this.watchers.clear();

            if (
                this.context.root?.[
                    SETTINGS_SYMBOL
                ] ===
                    this
            ) {
                delete this.context.root[
                    SETTINGS_SYMBOL
                ];
            }

            if (
                this.context.settings ===
                    this
            ) {
                delete this.context.settings;
            }

            this.destroyed = true;

            return true;
        }
    }

    function initialize(
        context = {}
    ) {
        const safeContext =
            isObject(context)
                ? context
                : {};

        const root =
            safeContext.root &&
            typeof safeContext.root.dispatchEvent ===
                "function"
                ? safeContext.root
                : document.documentElement;

        const existing =
            safeContext.settings instanceof
                Settings
                ? safeContext.settings
                : safeContext.services?.get?.(
                    "settings"
                ) ||
                root?.[
                    SETTINGS_SYMBOL
                ];

        if (
            existing instanceof Settings &&
            !existing.destroyed
        ) {
            safeContext.settings =
                existing;

            safeContext.registerService?.(
                "settings",
                existing
            );

            return existing;
        }

        const config =
            safeContext.config?.
                settings ||
            {};

        const settings =
            new Settings(
                {
                    ...safeContext,
                    root
                },
                {
                    persist:
                        parseBoolean(
                            root?.dataset?.
                                terminalSettingsPersist ??
                            config.persist,
                            true
                        ),
                    syncTabs:
                        parseBoolean(
                            root?.dataset?.
                                terminalSettingsSyncTabs ??
                            config.syncTabs,
                            true
                        ),
                    historyLimit:
                        Number.parseInt(
                            root?.dataset?.
                                terminalSettingsHistory ??
                            config.historyLimit,
                            10
                        ) ||
                        500
                }
            );

        root[
            SETTINGS_SYMBOL
        ] =
            settings;

        safeContext.settings =
            settings;

        safeContext.registerService?.(
            "settings",
            settings
        );

        dispatchSafe(
            document,
            "speciedex:terminal-settings-ready",
            {
                context:
                    safeContext,
                settings,
                version:
                    VERSION
            }
        );

        return settings;
    }

    function download(
        content,
        filename,
        mime,
        context = {}
    ) {
        const exporter =
            context.exporter ||
            context.services?.get?.(
                "export"
            ) ||
            context.services?.get?.(
                "exporter"
            );

        if (
            exporter &&
            typeof exporter.download ===
                "function"
        ) {
            exporter.download(
                content,
                filename,
                mime
            );

            return filename;
        }

        if (
            typeof URL?.createObjectURL !==
                "function"
        ) {
            throw new Error(
                "Browser download URLs are unavailable."
            );
        }

        const blob =
            new Blob(
                [content],
                {
                    type:
                        mime
                }
            );

        const url =
            URL.createObjectURL(
                blob
            );

        const anchor =
            document.createElement(
                "a"
            );

        anchor.href =
            url;

        anchor.download =
            filename;

        (
            document.body ||
            document.documentElement
        ).appendChild(
            anchor
        );

        try {
            anchor.click();
        } finally {
            anchor.remove();

            window.setTimeout(
                () =>
                    URL.revokeObjectURL(
                        url
                    ),
                1000
            );
        }

        return filename;
    }

    function resolveCommandContext(payload = {}) {
        return (
            payload.context ||
            payload.terminal?.context ||
            payload.app?.context ||
            payload
        );
    }

    function requireSettings(context = {}) {
        const safeContext =
            isObject(context)
                ? context
                : {};

        const settings =
            safeContext.settings ||
            safeContext.services?.get?.(
                "settings"
            ) ||
            initialize(safeContext);

        if (
            !(settings instanceof Settings) ||
            settings.destroyed
        ) {
            throw new Error(
                "Settings service is unavailable."
            );
        }

        return settings;
    }

    function writeResult(
        payload,
        value,
        type = "data"
    ) {
        if (
            typeof payload.writeJSON ===
                "function" &&
            typeof value !==
                "string"
        ) {
            return payload.writeJSON(
                value
            );
        }

        if (
            typeof payload.write ===
                "function"
        ) {
            return payload.write(
                typeof value ===
                    "string"
                    ? value
                    : safeStringify(
                        value
                    ),
                type
            );
        }

        if (
            typeof payload.writeLine ===
                "function"
        ) {
            return payload.writeLine(
                typeof value ===
                    "string"
                    ? value
                    : safeStringify(
                        value
                    )
            );
        }

        return value;
    }

    const commands = [
        {
            name: "settings",
            category: "interface",
            description: "Inspect or change terminal settings.",
            usage: "settings [name] [value]",
            handler: ({
                args,
                context,
                writeJSON,
                write
            }) => {
                if (!args.length) {
                    return writeJSON(
                        context.settings.snapshot()
                    );
                }

                if (args.length === 1) {
                    const description =
                        context.settings.describe(
                            args[0]
                        );

                    if (!description) {
                        return writeJSON({
                            [args[0]]:
                                context.settings.get(
                                    args[0]
                                )
                        });
                    }

                    return writeJSON(description);
                }

                const value = parseValue(
                    args.slice(1).join(" ")
                );

                context.settings.set(
                    args[0],
                    value
                );

                return write(
                    `Setting updated: ${args[0]}`,
                    "success"
                );
            }
        },
        {
            name: "settings-list",
            category: "interface",
            description: "List setting definitions and values.",
            usage: "settings-list [category]",
            handler: ({
                args,
                context,
                writeJSON
            }) => {
                const category = args[0];

                return writeJSON(
                    category
                        ? context.settings.describe()
                            .filter(
                                item =>
                                    item.category ===
                                    category
                            )
                        : context.settings.describe()
                );
            }
        },
        {
            name: "settings-categories",
            category: "interface",
            description: "List settings categories.",
            usage: "settings-categories",
            handler: ({
                context,
                writeJSON
            }) =>
                writeJSON(
                    context.settings.categories()
                )
        },
        {
            name: "settings-reset",
            category: "interface",
            description: "Reset one setting to its default.",
            usage: "settings-reset <name>",
            handler: ({
                args,
                context,
                writeJSON
            }) => {
                if (!args[0]) {
                    throw new Error(
                        "A setting name is required."
                    );
                }

                return writeJSON({
                    [args[0]]:
                        context.settings.reset(
                            args[0]
                        )
                });
            }
        },
        {
            name: "settings-reset-all",
            category: "interface",
            description: "Reset all settings to defaults.",
            usage: "settings-reset-all",
            handler: ({
                context,
                writeJSON
            }) =>
                writeJSON(
                    context.settings.resetAll()
                )
        },
        {
            name: "settings-profile-save",
            category: "interface",
            description: "Save the current settings as a profile.",
            usage: "settings-profile-save <name>",
            handler: ({
                args,
                context,
                writeJSON
            }) => {
                if (!args[0]) {
                    throw new Error(
                        "A profile name is required."
                    );
                }

                return writeJSON(
                    context.settings.saveProfile(
                        args[0]
                    )
                );
            }
        },
        {
            name: "settings-profile-load",
            category: "interface",
            description: "Load a settings profile.",
            usage: "settings-profile-load <name>",
            handler: ({
                args,
                context,
                writeJSON
            }) => {
                if (!args[0]) {
                    throw new Error(
                        "A profile name is required."
                    );
                }

                return writeJSON(
                    context.settings.loadProfile(
                        args[0]
                    )
                );
            }
        },
        {
            name: "settings-profile-list",
            category: "interface",
            description: "List saved settings profiles.",
            usage: "settings-profile-list",
            handler: ({
                context,
                writeJSON
            }) =>
                writeJSON(
                    context.settings.listProfiles()
                )
        },
        {
            name: "settings-profile-delete",
            category: "interface",
            description: "Delete a saved settings profile.",
            usage: "settings-profile-delete <name>",
            handler: ({
                args,
                context,
                write
            }) => {
                const removed =
                    context.settings.deleteProfile(
                        args[0]
                    );

                return write(
                    removed
                        ? `Settings profile deleted: ${args[0]}`
                        : `Settings profile not found: ${args[0]}`,
                    removed
                        ? "success"
                        : "warning"
                );
            }
        },
        {
            name: "settings-history",
            category: "interface",
            description: "Display recent settings changes.",
            usage: "settings-history [count]",
            handler: ({
                args,
                context,
                writeJSON
            }) => {
                const count = Math.max(
                    1,
                    Math.min(
                        500,
                        Number(args[0]) || 25
                    )
                );

                return writeJSON(
                    context.settings.history
                        .slice(-count)
                        .reverse()
                );
            }
        },
        {
            name: "settings-status",
            category: "interface",
            description: "Display settings-manager status.",
            usage: "settings-status",
            handler: ({
                context,
                writeJSON
            }) =>
                writeJSON(
                    context.settings.status()
                )
        },
        {
            name: "settings-export",
            category: "interface",
            description: "Export settings as JSON.",
            usage: "settings-export [filename]",
            handler: ({
                args,
                context,
                write
            }) => {
                const filename =
                    args[0] ||
                    "speciedex-terminal-settings.json";

                download(
                    safeStringify(
                        context.settings.export()
                    ),
                    filename,
                    "application/json;charset=utf-8",
                    context
                );

                return write(
                    `Settings exported to ${filename}.`,
                    "success"
                );
            }
        },
        {
            name: "settings-import",
            category: "interface",
            description: "Import settings from a terminal library collection.",
            usage: "settings-import [collection]",
            handler: async ({
                args,
                context,
                writeJSON
            }) => {
                const collection =
                    args[0] ||
                    "settings-import";

                const library =
                    context.library ||
                    context.services?.get?.(
                        "library"
                    );

                const result =
                    library?.get?.(
                        collection
                    );

                const records =
                    result &&
                    typeof result.then ===
                        "function"
                        ? await result
                        : result ||
                        [];

                const payload =
                    Array.isArray(records)
                        ? Object.fromEntries(
                            records
                                .filter(
                                    item =>
                                        isObject(item) &&
                                        item.name &&
                                        !RESERVED_KEYS.has(
                                            item.name
                                        )
                                )
                                .map(
                                    item => [
                                        item.name,
                                        item.value
                                    ]
                                )
                        )
                        : records;

                return writeJSON(
                    context.settings.import(
                        payload
                    )
                );
            }
        }
    ];

    for (const command of commands) {
        const handler =
            command.handler;

        command.handler =
            payload => {
                const safePayload =
                    isObject(payload)
                        ? payload
                        : {};

                safePayload.context =
                    resolveCommandContext(
                        safePayload
                    );

                const settings =
                    requireSettings(
                        safePayload.context
                    );

                safePayload.context.settings =
                    settings;

                safePayload.args =
                    Array.isArray(
                        safePayload.args
                    )
                        ? [
                            ...safePayload.args
                        ]
                        : [];

                safePayload.parsed =
                    isObject(
                        safePayload.parsed
                    )
                        ? safePayload.parsed
                        : {
                            flags: {},
                            options: {}
                        };

                safePayload.parsed.flags =
                    isObject(
                        safePayload.parsed.flags
                    )
                        ? safePayload.parsed.flags
                        : {};

                safePayload.parsed.options =
                    isObject(
                        safePayload.parsed.options
                    )
                        ? safePayload.parsed.options
                        : {};

                safePayload.writeJSON =
                    typeof safePayload.writeJSON ===
                        "function"
                        ? safePayload.writeJSON
                        : value =>
                            writeResult(
                                safePayload,
                                value
                            );

                safePayload.write =
                    typeof safePayload.write ===
                        "function"
                        ? safePayload.write
                        : (
                            value,
                            type
                        ) =>
                            writeResult(
                                safePayload,
                                value,
                                type
                            );

                return handler(
                    safePayload
                );
            };
    }

    const api = Object.freeze({
        name: MODULE_NAME,
        version: VERSION,
        STORAGE_PREFIX,
        PROFILE_PREFIX,
        SETTINGS_SYMBOL,
        DEFAULTS,
        DEFINITIONS,
        Settings,
        normalizeName,
        parseBoolean,
        parseValue,
        validateValue,
        safeClone,
        safeStringify,
        dispatchSafe,
        resolveCommandContext,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalSettings = api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules ||
        {};

    window.SpeciedexTerminalModules[
        MODULE_NAME
    ] = api;

    dispatchSafe(
        document,
        "speciedex:terminal-module-available",
        {
            name:
                MODULE_NAME,
            module:
                api
        }
    );
})(window, document);
