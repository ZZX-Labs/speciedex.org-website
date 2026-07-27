/*
========================================================================
Speciedex.org
Terminal Live Species Splash
========================================================================

Coordinates terminal-cmatrix.js, terminal-zmatrix.js, and terminal-wordcloud.js
to create the live species visualization mounted above the interactive terminal
console.

Includes a persistent cmatrix/zmatrix toggle switch. The switch may be supplied
by markup with [data-terminal-splash-matrix-toggle], or it is created
automatically inside the splash controls or splash host.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Splash";
    const VERSION = "2.3.0";

    const VISUALIZATION_SYMBOL =
        Symbol.for(
            "speciedex.terminal.splash.visualization"
        );

    const CONTROLLER_SYMBOL =
        Symbol.for(
            "speciedex.terminal.splash.controller"
        );

    const VISIBILITY_SYMBOL =
        Symbol.for(
            "speciedex.terminal.splash.visibility"
        );
    const DEFAULT_CAPACITY = 256;
    const DEFAULT_VISIBLE = 12;
    const DEFAULT_INTERVAL = 140;
    const DEFAULT_BATCH = 1;
    const DEFAULT_STORAGE_PREFIX = "speciedex-terminal:splash";
    const MATRIX_MODES = Object.freeze(["cmatrix", "zmatrix"]);
    const EMPTY_MESSAGE =
        "Awaiting live species records from providers, scans, search, imports, and archive reconciliation.";

    const DOCUMENT_EVENTS = Object.freeze([
        "speciedex:species-detected",
        "speciedex:scan-record",
        "speciedex:provider-record",
        "speciedex:terminal-search-results",
        "speciedex:terminal-species-results",
        "speciedex:archive-record",
        "speciedex:api-record",
        "speciedex:import-record",
        "speciedex:stream-record",
        "speciedex:index-record",
        "speciedex:terminal-command-complete"
    ]);

    const BUS_EVENTS = Object.freeze([
        "species:detected",
        "scan:record",
        "provider:record",
        "search:results",
        "archive:record",
        "api:record",
        "import:record",
        "stream:record",
        "index:record",
        "terminal:command:complete"
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

    function clone(
        value,
        seen =
            new WeakMap(),
        depth =
            0
    ) {
        if (
            value === undefined ||
            value === null ||
            typeof value !==
                "object"
        ) {
            return value;
        }

        if (
            depth >
            40
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

    function parseBoolean(value, fallback = false) {
        if (typeof value === "boolean") {
            return value;
        }

        if (value === undefined || value === null || value === "") {
            return fallback;
        }

        const normalized = String(value).trim().toLowerCase();

        if (["1", "true", "yes", "on", "enabled"].includes(normalized)) {
            return true;
        }

        if (["0", "false", "no", "off", "disabled"].includes(normalized)) {
            return false;
        }

        return fallback;
    }

    function parseNumber(value, fallback, minimum = -Infinity, maximum = Infinity) {
        const parsed = Number(value);

        if (!Number.isFinite(parsed)) {
            return fallback;
        }

        return Math.min(maximum, Math.max(minimum, parsed));
    }

    function normalizeText(value, fallback = "") {
        if (value === undefined || value === null) {
            return fallback;
        }

        return String(value).trim() || fallback;
    }

    function normalizeMatrixMode(value, fallback = "zmatrix") {
        const normalized = normalizeText(value).toLowerCase();

        return MATRIX_MODES.includes(normalized)
            ? normalized
            : fallback;
    }

    function first(record, keys, fallback = "") {
        for (const key of keys) {
            const value = record?.[key];

            if (value !== undefined && value !== null && value !== "") {
                return value;
            }
        }

        return fallback;
    }

    function safeDispatch(target, name, detail) {
        if (!target || typeof target.dispatchEvent !== "function") {
            return false;
        }

        try {
            return target.dispatchEvent(new CustomEvent(name, { detail }));
        } catch (_error) {
            return false;
        }
    }

    function createElement(tagName, className, content) {
        const element = document.createElement(tagName);

        if (className) {
            element.className = className;
        }

        if (content !== undefined) {
            element.textContent = content;
        }

        return element;
    }

    function outputJSON(writeJSON, value) {
        return typeof writeJSON === "function"
            ? writeJSON(value)
            : value;
    }

    function outputText(write, value, type = "data") {
        return typeof write === "function"
            ? write(value, type)
            : value;
    }

    function normalizeRecord(record, source = "runtime") {
        if (!isObject(record)) {
            return null;
        }

        const scientificName = normalizeText(
            first(record, [
                "scientific_name", "scientificName", "canonical_name",
                "canonicalName", "accepted_name", "acceptedName",
                "taxon_name", "taxonName", "name"
            ]),
            "Unknown taxon"
        );

        const commonName = normalizeText(
            first(record, [
                "common_name", "commonName", "vernacular_name",
                "vernacularName", "preferred_common_name",
                "preferredCommonName", "english_name", "englishName"
            ]),
            "No common name"
        );

        const speciedexId = normalizeText(
            first(record, [
                "speciedex_id", "speciedexId", "speciedex_key",
                "speciedexKey", "canonical_id", "canonicalId",
                "taxon_id", "taxonId", "id", "key"
            ]),
            "pending"
        );

        const rank = normalizeText(first(record, [
            "rank", "taxon_rank", "taxonRank",
            "taxonomic_rank", "taxonomicRank"
        ]));

        const provider = normalizeText(
            first(record, [
                "provider", "source", "provider_id", "providerId",
                "dataset", "dataset_name", "datasetName"
            ]),
            source
        );

        const status = normalizeText(first(record, [
            "status", "taxonomic_status", "taxonomicStatus",
            "accepted_status", "acceptedStatus"
        ]));

        const timestamp = first(record, [
            "detectedAt", "detected_at", "timestamp", "createdAt",
            "created_at", "updatedAt", "updated_at"
        ]);

        return {
            scientificName,
            commonName,
            speciedexId,
            rank,
            provider,
            status,
            source,
            detectedAt: Number.isFinite(Date.parse(timestamp))
                ? new Date(timestamp).toISOString()
                : iso(),
            raw: clone(record)
        };
    }

    function collect(
        payload,
        seen =
            new WeakSet(),
        depth =
            0
    ) {
        if (
            payload ===
                undefined ||
            payload ===
                null ||
            depth >
                24
        ) {
            return [];
        }

        if (
            typeof CustomEvent !==
                "undefined" &&
            payload instanceof
                CustomEvent
        ) {
            return collect(
                payload.detail,
                seen,
                depth +
                    1
            );
        }

        if (
            Array.isArray(
                payload
            )
        ) {
            const records =
                [];

            for (
                const item of
                payload
            ) {
                records.push(
                    ...collect(
                        item,
                        seen,
                        depth +
                            1
                    )
                );
            }

            return records;
        }

        if (
            !isObject(
                payload
            )
        ) {
            return [];
        }

        if (
            seen.has(
                payload
            )
        ) {
            return [];
        }

        seen.add(
            payload
        );

        const candidates = [
            payload.records,
            payload.results,
            payload.items,
            payload.species,
            payload.taxa,
            payload.data,
            payload.record,
            payload.result,
            payload.payload,
            payload.detail
        ];

        for (
            const candidate of
            candidates
        ) {
            if (
                candidate ===
                    undefined ||
                candidate ===
                    null
            ) {
                continue;
            }

            const collected =
                collect(
                    candidate,
                    seen,
                    depth +
                        1
                );

            if (
                collected.length
            ) {
                return collected;
            }
        }

        return [
            payload
        ];
    }

    function recordKey(record) {
        return [
            record.speciedexId,
            record.scientificName.toLowerCase(),
            record.commonName.toLowerCase(),
            record.provider.toLowerCase()
        ].join("|");
    }

    class TerminalRegionVisibility extends EventTarget {
        constructor(context, options = {}) {
            super();

            if (!context?.root) {
                throw new TypeError("Terminal visibility requires context.root.");
            }

            this.context = context;
            this.root = context.root;
            this.storage =
                context.storage ||
                context.services?.get?.("storage") ||
                null;
            this.instance =
                this.root.dataset?.terminalInstance ||
                options.instance ||
                "default";
            this.storageKey =
                options.storageKey ||
                `${DEFAULT_STORAGE_PREFIX}:visibility:${this.instance}`;
            this.destroyed =
                false;

            this.watchers =
                new Set();

            this.lastError =
                null;

            this.emitting =
                false;

            this.abortController =
                new AbortController();

            this.regions = {
                terminal:
                    this.root.querySelector("[data-terminal-regions]") ||
                    this.root,
                splash:
                    this.root.querySelector("[data-terminal-splash]"),
                console:
                    this.root.querySelector("[data-terminal-console-region]")
            };

            this.buttons = {
                terminal:
                    this.root.querySelector("[data-terminal-toggle-terminal]"),
                splash:
                    this.root.querySelector("[data-terminal-toggle-splash]"),
                console:
                    this.root.querySelector("[data-terminal-toggle-console]")
            };

            this.state = {
                terminal: true,
                splash: true,
                console: true,
                ...this.restore()
            };

            this._listeners = [];
            this.bind();
            this.applyAll();
            this._syncState();
        }

        _emit(
            type,
            detail =
                {}
        ) {
            const event = {
                type,
                timestamp:
                    iso(),
                state:
                    clone(
                        this.state
                    ),
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
                safeDispatch(
                    this,
                    type,
                    event
                );

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
                        this.lastError =
                            error;
                    }
                }

                try {
                    this.context.events?.
                        emit?.(
                            `terminal:visibility:${type}`,
                            event
                        );
                } catch (error) {
                    this.lastError =
                        error;
                }

                return event;
            } finally {
                this.emitting =
                    false;
            }
        }

        _syncState() {
            const state = this.context.state || this.context.stateStore;

            try {
                state?.set?.("terminal.visibility", {
                    ...clone(this.state),
                    updatedAt: iso()
                });
            } catch (_error) {
                /* Advisory synchronization only. */
            }
        }

        restore() {
            try {
                if (this.storage?.get) {
                    const value = this.storage.get(this.storageKey, {});
                    return isObject(value) ? value : {};
                }

                const raw = window.localStorage?.getItem?.(this.storageKey);
                const value = raw ? JSON.parse(raw) : {};
                return isObject(value) ? value : {};
            } catch (error) {
                this.lastError = error;
                return {};
            }
        }

        persist() {
            try {
                if (this.storage?.set) {
                    this.storage.set(this.storageKey, clone(this.state));
                } else {
                    window.localStorage?.setItem?.(
                        this.storageKey,
                        JSON.stringify(this.state)
                    );
                }

                return true;
            } catch (error) {
                this.lastError = error;
                return false;
            }
        }

        bind() {
            for (const [name, button] of Object.entries(this.buttons)) {
                if (!button) {
                    continue;
                }

                const handler = (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    this.toggle(name);
                };

                button.addEventListener(
                    "click",
                    handler,
                    {
                        signal:
                            this.abortController.signal
                    }
                );
            }
        }

        toggle(name) {
            return this.set(name, !this.state[name]);
        }

        set(name, visible, options = {}) {
            if (!(name in this.state)) {
                throw new Error(`Unknown terminal region: ${name}`);
            }

            this.state[name] = Boolean(visible);
            this.apply(name);

            if (options.persist !== false) {
                this.persist();
            }

            this._syncState();
            this._emit("change", {
                name,
                visible: this.state[name]
            });

            return this.state[name];
        }

        apply(name) {
            const region = this.regions[name];
            const button = this.buttons[name];
            const visible = Boolean(this.state[name]);

            if (region) {
                region.hidden = !visible;
                region.dataset.collapsed = visible ? "false" : "true";
                region.setAttribute("aria-hidden", visible ? "false" : "true");
            }

            if (button) {
                button.setAttribute("aria-expanded", String(visible));
                button.setAttribute("aria-pressed", String(visible));
                button.classList.toggle("is-collapsed", !visible);
            }

            this.root.classList.toggle(
                `terminal-${name}-collapsed`,
                !visible
            );
        }

        applyAll() {
            for (const name of Object.keys(this.state)) {
                this.apply(name);
            }
        }

        showAll() {
            for (const name of Object.keys(this.state)) {
                this.state[name] = true;
            }

            this.applyAll();
            this.persist();
            this._syncState();
            this._emit("showAll", {});
            return clone(this.state);
        }

        collapseAll(options = {}) {
            this.state.terminal = false;

            if (options.includeSplash === true) {
                this.state.splash = false;
            }

            if (options.includeConsole === true) {
                this.state.console = false;
            }

            this.applyAll();
            this.persist();
            this._syncState();
            this._emit("collapseAll", {});
            return clone(this.state);
        }

        reset() {
            this.state = {
                terminal: true,
                splash: true,
                console: true
            };

            this.applyAll();
            this.persist();
            this._syncState();
            this._emit("reset", {});
            return clone(this.state);
        }

        watch(callback, options = {}) {
            if (typeof callback !== "function") {
                throw new TypeError("Visibility watcher must be a function.");
            }

            this.watchers.add(callback);

            if (options.immediate === true) {
                callback({
                    type: "initial",
                    timestamp: iso(),
                    state: clone(this.state)
                }, this);
            }

            return () => this.watchers.delete(callback);
        }

        status() {
            return {
                name: "terminal-visibility",
                instance: this.instance,
                storageKey: this.storageKey,
                state: clone(this.state),
                available: Object.fromEntries(
                    Object.entries(this.regions).map(([name, region]) => [
                        name,
                        Boolean(region)
                    ])
                ),
                destroyed: this.destroyed,
                lastError: this.lastError
                    ? {
                        name: this.lastError.name,
                        message: this.lastError.message
                    }
                    : null
            };
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            for (const remove of this._listeners) {
                try {
                    remove();
                } catch (_error) {
                    /* Ignore cleanup failures. */
                }
            }

            this.abortController.abort();

            this._listeners =
                [];

            this._emit(
                "destroy",
                {}
            );

            this.watchers.clear();

            this.destroyed =
                true;

            return true;
        }
    }

    class TerminalSplashController extends EventTarget {
        constructor(context, options = {}) {
            super();

            if (!context?.root) {
                throw new TypeError("Terminal splash requires context.root.");
            }

            this.context = context;
            this.root = context.root;
            this.instance =
                this.root.dataset?.terminalInstance ||
                options.instance ||
                "default";
            this.matrixStorageKey =
                options.matrixStorageKey ||
                `${DEFAULT_STORAGE_PREFIX}:matrix:${this.instance}`;

            const configuredMode = normalizeMatrixMode(
                options.matrixMode,
                options.preferZMatrix !== false ? "zmatrix" : "cmatrix"
            );

            this.options = {
                capacity: Math.floor(parseNumber(
                    options.capacity,
                    DEFAULT_CAPACITY,
                    1,
                    100000
                )),
                visible: Math.floor(parseNumber(
                    options.visible,
                    DEFAULT_VISIBLE,
                    1,
                    1000
                )),
                interval: parseNumber(
                    options.interval,
                    DEFAULT_INTERVAL,
                    16,
                    60000
                ),
                batch: Math.floor(parseNumber(
                    options.batch,
                    DEFAULT_BATCH,
                    1,
                    1000
                )),
                matrixMode: this.restoreMatrixMode(configuredMode),
                preferZMatrix: configuredMode === "zmatrix",
                autoplay: options.autoplay !== false,
                pauseWhenHidden: options.pauseWhenHidden !== false,
                deduplicate: options.deduplicate !== false,
                announce: options.announce !== false,
                preserveRecords: options.preserveRecords === true,
                matrixOptions: isObject(options.matrixOptions)
                    ? clone(options.matrixOptions)
                    : {}
            };

            this.records = [];
            this.seen = new Set();
            this.cursor = 0;
            this.timer = 0;
            this.destroyed = false;
            this.running = false;
            this.paused = false;
            this.autoPaused = false;
            this.unsubscribers = [];
            this.listeners = [];
            this.watchers =
                new Set();

            this.lastError =
                null;

            this.lastSource =
                null;

            this.emitting =
                false;

            this.renderFrame =
                0;

            this.pendingRender =
                false;

            this.pendingWordCloudRefresh =
                false;

            this.abortController =
                new AbortController();

            this.moduleCache =
                null;

            this.snapshotLimit =
                10000;
            this.lastIngestAt = null;
            this.startedAt = iso();
            this.matrixController = null;
            this.wordCloudController = null;
            this.visibilityObserver = null;
            this.reducedMotion = Boolean(
                window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
            );
            this.metrics = {
                received: 0,
                accepted: 0,
                duplicates: 0,
                rejected: 0,
                evicted: 0,
                renders: 0,
                rotations: 0,
                clears: 0,
                matrixSwitches:
                    0,
                scheduledRenders:
                    0,
                coalescedRenders:
                    0,
                wordCloudRefreshes:
                    0,
                errors:
                    0,
                watcherErrors:
                    0
            };

            this.elements =
                this.captureElements();

            this.root[
                CONTROLLER_SYMBOL
            ] =
                this;

            this.elements.host[
                CONTROLLER_SYMBOL
            ] =
                this;
            this.mountPromise =
                this.mountVisualizations()
                    .catch(error => {
                        this._recordError(error);
                        return null;
                    });
            this.bindEvents();
            this.observeVisibility();
            this.render();

            if (this.options.autoplay) {
                this.start();

                if (
                    this.options.pauseWhenHidden &&
                    document.visibilityState === "hidden"
                ) {
                    this.autoPaused = true;
                    this.pause({ automatic: true });
                }
            }

            this._syncState();
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
                    iso(),
                records:
                    this.records.length,
                matrixMode:
                    this.options.matrixMode,
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
                safeDispatch(
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

                try {
                    this.context.events?.
                        emit?.(
                            `splash:${type}`,
                            event
                        );
                } catch (error) {
                    this._recordError(
                        error,
                        false
                    );
                }

                return event;
            } finally {
                this.emitting =
                    false;
            }
        }

        _recordError(error, notifyWatchers = true) {
            this.lastError = error instanceof Error
                ? error
                : new Error(String(error));
            this.metrics.errors +=
                1;

            if (
                this.emitting
            ) {
                window.console?.
                    error?.(
                        "[SpeciedexTerminalSplash]",
                        this.lastError
                    );

                return;
            }

            this._emit(
                "error",
                {
                error: {
                    name: this.lastError.name,
                    message: this.lastError.message,
                    stack: this.lastError.stack || ""
                }
                },
                notifyWatchers
            );
        }

        _syncState() {
            const state = this.context.state || this.context.stateStore;

            try {
                state?.set?.("visualization.splash", {
                    running: this.running,
                    paused: this.paused,
                    hidden: this.elements.host.hidden,
                    records: this.records.length,
                    capacity: this.options.capacity,
                    visible: this.options.visible,
                    interval: this.options.interval,
                    cursor: this.cursor,
                    matrixMode: this.options.matrixMode,
                    matrixAvailable: this.matrixAvailability(),
                    lastSource: this.lastSource,
                    lastIngestAt: this.lastIngestAt,
                    metrics: { ...this.metrics },
                    updatedAt: iso()
                });
            } catch (_error) {
                /* Advisory synchronization only. */
            }
        }

        restoreMatrixMode(fallback = "zmatrix") {
            try {
                const stored = window.localStorage?.getItem?.(
                    this.matrixStorageKey
                );

                return normalizeMatrixMode(stored, fallback);
            } catch (_error) {
                return fallback;
            }
        }

        persistMatrixMode() {
            try {
                window.localStorage?.setItem?.(
                    this.matrixStorageKey,
                    this.options.matrixMode
                );
                return true;
            } catch (error) {
                this.lastError = error;
                return false;
            }
        }

        captureElements() {
            const host = this.root.querySelector("[data-terminal-splash]");

            if (!host) {
                throw new Error(
                    "terminal.html must provide [data-terminal-splash]."
                );
            }

            const list = host.querySelector("[data-terminal-splash-list]");
            const canvas = host.querySelector("[data-terminal-splash-canvas]");
            const wordcloud = host.querySelector(
                "[data-terminal-splash-wordcloud]"
            );

            if (!list || !canvas || !wordcloud) {
                throw new Error("Terminal splash markup is incomplete.");
            }

            host.setAttribute("role", "region");
            host.setAttribute(
                "aria-label",
                host.getAttribute("aria-label") ||
                "Live species visualization"
            );

            list.setAttribute("role", "feed");
            list.setAttribute("aria-live", "off");

            const controls =
                host.querySelector("[data-terminal-splash-controls]") ||
                host.querySelector(".terminal-splash-controls") ||
                host;

            let matrixToggle = host.querySelector(
                "[data-terminal-splash-matrix-toggle]"
            );

            if (!matrixToggle) {
                matrixToggle = createElement(
                    "button",
                    "terminal-splash-matrix-toggle"
                );
                matrixToggle.type = "button";
                matrixToggle.dataset.terminalSplashMatrixToggle = "";
                matrixToggle.dataset.generated = "true";
                controls.appendChild(matrixToggle);
            }

            matrixToggle.setAttribute("role", "switch");
            matrixToggle.setAttribute(
                "aria-label",
                "Toggle cmatrix or zmatrix visualization"
            );

            return {
                host,
                list,
                canvas,
                wordcloud,
                controls,
                matrixToggle,
                count: host.querySelector("[data-terminal-splash-count]"),
                status: host.querySelector("[data-terminal-splash-status]"),
                source: host.querySelector("[data-terminal-splash-source]"),
                pause: host.querySelector("[data-terminal-splash-pause]"),
                next: host.querySelector("[data-terminal-splash-next]"),
                previous: host.querySelector("[data-terminal-splash-previous]"),
                clear: host.querySelector("[data-terminal-splash-clear]")
            };
        }

        matrixModules(options = {}) {
            if (
                this.moduleCache &&
                options.refresh !== true
            ) {
                return this.moduleCache;
            }

            const visualizations =
                this.context.visualizations;

            const modules =
                window.SpeciedexTerminalModules ||
                {};

            this.moduleCache = {
                cmatrix:
                    visualizations?.get?.("cmatrix") ||
                    visualizations?.get?.("CMatrix") ||
                    modules.cmatrix ||
                    modules.CMatrix ||
                    window.SpeciedexTerminalCmatrix ||
                    window.SpeciedexTerminalCMatrix ||
                    null,

                zmatrix:
                    visualizations?.get?.("zmatrix") ||
                    visualizations?.get?.("ZMatrix") ||
                    modules.zmatrix ||
                    modules.ZMatrix ||
                    window.SpeciedexTerminalZmatrix ||
                    window.SpeciedexTerminalZMatrix ||
                    null
            };

            return this.moduleCache;
        }

        matrixAvailability() {
            const modules = this.matrixModules();

            return {
                cmatrix: Boolean(modules.cmatrix?.mount),
                zmatrix: Boolean(modules.zmatrix?.mount)
            };
        }

        resolveMatrixMode(requested = this.options.matrixMode) {
            const normalized = normalizeMatrixMode(
                requested,
                this.options.matrixMode
            );
            const available = this.matrixAvailability();

            if (available[normalized]) {
                return normalized;
            }

            const alternative =
                normalized === "zmatrix"
                    ? "cmatrix"
                    : "zmatrix";

            if (available[alternative]) {
                return alternative;
            }

            return normalized;
        }

        matrixOptions(mode) {
            const shared = this.options.matrixOptions?.shared || {};
            const specific = this.options.matrixOptions?.[mode] || {};

            if (mode === "zmatrix") {
                return {
                    baseSpeed: 0.82,
                    pulseSpeed: 0.022,
                    opacity: 0.30,
                    ...shared,
                    ...specific
                };
            }

            return {
                speed: 0.82,
                density: 0.86,
                trail: 0.10,
                opacity: 0.24,
                ...shared,
                ...specific
            };
        }

        updateMatrixToggle() {
            const toggle = this.elements.matrixToggle;

            if (!toggle) {
                return;
            }

            const mode = this.options.matrixMode;
            const available = this.matrixAvailability();
            const bothAvailable = available.cmatrix && available.zmatrix;

            toggle.dataset.matrixMode = mode;
            toggle.setAttribute(
                "aria-checked",
                String(mode === "zmatrix")
            );
            toggle.setAttribute(
                "aria-pressed",
                String(mode === "zmatrix")
            );
            toggle.setAttribute(
                "title",
                bothAvailable
                    ? `Switch to ${mode === "zmatrix" ? "cmatrix" : "zmatrix"}`
                    : `${mode === "zmatrix" ? "zmatrix" : "cmatrix"} active`
            );
            toggle.disabled = !bothAvailable;
            toggle.classList.toggle("is-zmatrix", mode === "zmatrix");
            toggle.classList.toggle("is-cmatrix", mode === "cmatrix");

            toggle.replaceChildren();

            const track = createElement(
                "span",
                "terminal-splash-matrix-toggle-track"
            );
            track.setAttribute("aria-hidden", "true");

            const thumb = createElement(
                "span",
                "terminal-splash-matrix-toggle-thumb"
            );
            track.appendChild(thumb);

            const label = createElement(
                "span",
                "terminal-splash-matrix-toggle-label",
                mode === "zmatrix" ? "zmatrix" : "cmatrix"
            );

            toggle.append(track, label);
        }

        _destroyMatrixController() {
            if (!this.matrixController) {
                return;
            }

            try {
                this.matrixController.stop?.();
                this.matrixController.destroy?.();
            } catch (error) {
                this._recordError(error);
            } finally {
                this.matrixController = null;
            }
        }

        async _mountMatrix(mode) {
            const resolvedMode =
                this.resolveMatrixMode(mode);

            const module =
                this.matrixModules({
                    refresh: true
                })[resolvedMode];

            this._destroyMatrixController();

            this.options.matrixMode =
                resolvedMode;

            this.options.preferZMatrix =
                resolvedMode === "zmatrix";

            this.elements.canvas.dataset.matrixMode =
                resolvedMode;

            this.elements.host.dataset.matrixMode =
                resolvedMode;

            this.elements.canvas.hidden =
                false;

            this.elements.canvas.style.display =
                "";

            this.elements.canvas.setAttribute(
                "aria-hidden",
                "true"
            );

            if (
                !module ||
                typeof module.mount !== "function"
            ) {
                this.updateMatrixToggle();

                throw new Error(
                    `${resolvedMode} visualization module is unavailable.`
                );
            }

            try {
                const mounted =
                    module.mount(
                        this.elements.canvas,
                        this.matrixOptions(resolvedMode)
                    );

                this.matrixController =
                    mounted &&
                    typeof mounted.then === "function"
                        ? await mounted
                        : mounted;

                if (!this.matrixController) {
                    throw new Error(
                        `${resolvedMode} returned no visualization controller.`
                    );
                }

                for (const record of this.records) {
                    this.matrixController.inject?.(
                        record.raw ||
                        record
                    );
                }

                if (this.paused || !this.running) {
                    this.matrixController.pause?.();
                } else {
                    this.matrixController.resume?.();
                }

                this._emit(
                    "matrixMounted",
                    {
                        mode:
                            resolvedMode,
                        controller:
                            this.matrixController?.constructor?.name ||
                            "mounted"
                    }
                );
            } catch (error) {
                this.matrixController =
                    null;

                this._recordError(error);
                throw error;
            } finally {
                this.updateMatrixToggle();
            }

            return this.matrixController;
        }

        async setMatrixMode(mode, options = {}) {
            if (this.destroyed) {
                throw new Error("Terminal splash has been destroyed.");
            }

            const requested =
                normalizeMatrixMode(
                    mode,
                    this.options.matrixMode
                );

            this.moduleCache =
                null;

            const resolved =
                this.resolveMatrixMode(requested);

            const changed =
                resolved !== this.options.matrixMode ||
                !this.matrixController;

            if (
                changed ||
                options.remount === true
            ) {
                await this._mountMatrix(resolved);
                this.metrics.matrixSwitches += 1;
            } else {
                this.updateMatrixToggle();
            }

            if (options.persist !== false) {
                this.persistMatrixMode();
            }

            this._syncState();

            if (options.emit !== false) {
                this._emit("matrixChange", {
                    requested,
                    mode: this.options.matrixMode,
                    available: this.matrixAvailability()
                });
            }

            return this.options.matrixMode;
        }

        async toggleMatrix(options = {}) {
            return this.setMatrixMode(
                this.options.matrixMode === "zmatrix"
                    ? "cmatrix"
                    : "zmatrix",
                options
            );
        }

        async mountVisualizations() {
            await this._mountMatrix(this.options.matrixMode);

            const visualizations = this.context.visualizations;
            const wordcloud =
                visualizations?.get?.("wordcloud") ||
                window.SpeciedexTerminalWordCloud;

            try {
                if (wordcloud?.mount) {
                    this.wordCloudController = wordcloud.mount(
                        this.elements.wordcloud,
                        {
                            source: () => this.wordCloudTerms(),
                            maxWords: 28,
                            refresh: 720,
                            minFont: 10,
                            maxFont: 24,
                            opacity: 0.24
                        }
                    );
                }
            } catch (error) {
                this._recordError(error);
            }
        }

        wordCloudTerms() {
            return this.records.flatMap((record) => [
                record.scientificName,
                record.commonName,
                record.rank,
                record.provider,
                record.status
            ].filter(Boolean));
        }

        bindEvents() {
            const signal =
                this.abortController.signal;

            for (
                const eventName of
                DOCUMENT_EVENTS
            ) {
                const handler =
                    event => {
                        const payload =
                            eventName ===
                                "speciedex:terminal-command-complete"
                                ? event.detail?.
                                    result
                                : event.detail;

                        this.ingest(
                            payload,
                            eventName
                        );
                    };

                document.addEventListener(
                    eventName,
                    handler,
                    {
                        signal
                    }
                );
            }

            const eventBus =
                this.context.events;

            if (
                eventBus?.
                    on
            ) {
                for (
                    const eventName of
                    BUS_EVENTS
                ) {
                    try {
                        const unsubscribe =
                            eventBus.on(
                                eventName,
                                event =>
                                    this.ingest(
                                        event?.
                                            detail ??
                                        event,
                                        eventName
                                    )
                            );

                        if (
                            typeof unsubscribe ===
                                "function"
                        ) {
                            this.unsubscribers.push(
                                unsubscribe
                            );
                        }
                    } catch (error) {
                        this._recordError(
                            error
                        );
                    }
                }
            }

            const bindButton =
                (
                    element,
                    handler
                ) => {
                    if (
                        !element
                    ) {
                        return;
                    }

                    element.addEventListener(
                        "click",
                        handler,
                        {
                            signal
                        }
                    );
                };

            bindButton(
                this.elements.pause,
                () => {
                    this.paused
                        ? this.resume()
                        : this.pause();
                }
            );

            bindButton(
                this.elements.next,
                () =>
                    this.next()
            );

            bindButton(
                this.elements.previous,
                () =>
                    this.previous()
            );

            bindButton(
                this.elements.clear,
                () =>
                    this.clear()
            );

            bindButton(
                this.elements.matrixToggle,
                async event => {
                    event.preventDefault();
                    event.stopPropagation();

                    try {
                        await this.toggleMatrix();
                    } catch (error) {
                        this._recordError(error);
                    }
                }
            );

            document.addEventListener(
                "visibilitychange",
                () => {
                    if (
                        !this.options.pauseWhenHidden
                    ) {
                        return;
                    }

                    if (
                        document.visibilityState ===
                            "hidden"
                    ) {
                        if (
                            this.running &&
                            !this.paused
                        ) {
                            this.autoPaused =
                                true;

                            this.pause({
                                automatic:
                                    true
                            });
                        }
                    } else if (
                        document.visibilityState ===
                            "visible" &&
                        this.running &&
                        this.paused &&
                        this.autoPaused
                    ) {
                        this.autoPaused =
                            false;

                        this.resume({
                            automatic:
                                true
                        });
                    }
                },
                {
                    signal
                }
            );
        }

        observeVisibility() {
            if (
                !this.options.pauseWhenHidden ||
                typeof IntersectionObserver !== "function"
            ) {
                return;
            }

            this.visibilityObserver = new IntersectionObserver(
                (entries) => {
                    const visible = entries.some(
                        (entry) => entry.isIntersecting
                    );

                    if (!visible) {
                        if (this.running && !this.paused) {
                            this.autoPaused = true;
                            this.pause({ automatic: true });
                        }
                    } else if (
                        this.options.autoplay &&
                        document.visibilityState !== "hidden" &&
                        this.paused &&
                        this.autoPaused
                    ) {
                        this.autoPaused = false;
                        this.resume({ automatic: true });
                    }
                },
                { threshold: 0.01 }
            );

            this.visibilityObserver.observe(this.elements.host);
        }

        scheduleRender(
            options =
                {}
        ) {
            if (
                this.destroyed
            ) {
                return false;
            }

            this.pendingRender =
                true;

            if (
                options.wordCloud ===
                    true
            ) {
                this.pendingWordCloudRefresh =
                    true;
            }

            if (
                this.renderFrame
            ) {
                this.metrics.coalescedRenders +=
                    1;

                return false;
            }

            this.metrics.scheduledRenders +=
                1;

            this.renderFrame =
                window.requestAnimationFrame(
                    () => {
                        this.renderFrame =
                            0;

                        if (
                            this.destroyed ||
                            !this.pendingRender
                        ) {
                            return;
                        }

                        this.pendingRender =
                            false;

                        if (
                            this.pendingWordCloudRefresh
                        ) {
                            this.pendingWordCloudRefresh =
                                false;

                            try {
                                this.wordCloudController?.
                                    refresh?.();

                                this.metrics.wordCloudRefreshes +=
                                    1;
                            } catch (error) {
                                this._recordError(
                                    error
                                );
                            }
                        }

                        this.render();
                    }
                );

            return true;
        }

        ingest(payload, source = "runtime") {
            if (this.destroyed) {
                return {
                    received: 0,
                    added: 0,
                    duplicates: 0,
                    rejected: 0
                };
            }

            const incoming = collect(payload);
            let added = 0;
            let duplicates = 0;
            let rejected = 0;

            this.metrics.received += incoming.length;

            for (const raw of incoming) {
                const record = normalizeRecord(raw, source);

                if (!record) {
                    rejected += 1;
                    this.metrics.rejected += 1;
                    continue;
                }

                const key = recordKey(record);

                if (this.options.deduplicate && this.seen.has(key)) {
                    duplicates += 1;
                    this.metrics.duplicates += 1;
                    continue;
                }

                this.seen.add(key);
                this.records.push(record);
                this.metrics.accepted += 1;
                added += 1;

                try {
                    this.matrixController?.inject?.(raw);
                } catch (error) {
                    this._recordError(error);
                }

                while (this.records.length > this.options.capacity) {
                    const removed = this.records.shift();

                    if (removed) {
                        this.seen.delete(recordKey(removed));
                        this.metrics.evicted += 1;
                    }
                }
            }

            if (!added) {
                return {
                    received: incoming.length,
                    added,
                    duplicates,
                    rejected
                };
            }

            this.lastSource = source;
            this.lastIngestAt = iso();
            this.updateIndicators({ added, source });

            this.scheduleRender({
                wordCloud:
                    true
            });

            this._syncState();
            this._emit("ingest", {
                source,
                received: incoming.length,
                added,
                duplicates,
                rejected
            });

            return {
                received: incoming.length,
                added,
                duplicates,
                rejected
            };
        }

        updateIndicators({ added = 0, source = this.lastSource } = {}) {
            if (this.elements.count) {
                this.elements.count.textContent = String(this.records.length);
            }

            if (this.elements.status) {
                this.elements.status.textContent = added
                    ? `Streaming ${added} newly observed record${added === 1 ? "" : "s"}`
                    : this.running && !this.paused
                        ? "Live species stream active"
                        : this.paused
                            ? "Species stream paused"
                            : "Species stream stopped";
            }

            if (this.elements.source) {
                this.elements.source.textContent = source
                    ? `Source: ${source}`
                    : "Source: awaiting data";
            }

            if (this.elements.pause) {
                this.elements.pause.textContent = this.paused
                    ? "Resume"
                    : "Pause";
                this.elements.pause.setAttribute(
                    "aria-pressed",
                    this.paused ? "true" : "false"
                );
            }

            this.updateMatrixToggle();
        }

        start() {
            if (this.destroyed) {
                throw new Error("Terminal splash has been destroyed.");
            }

            this.stop({ silent: true });
            this.running = true;
            this.paused = false;
            this.autoPaused = false;
            this.updateIndicators();

            if (!this.reducedMotion) {
                this.timer = window.setInterval(() => {
                    if (
                        this.paused ||
                        !this.records.length ||
                        this.elements.host.hidden
                    ) {
                        return;
                    }

                    this.rotate(this.options.batch);
                }, this.options.interval);
            }

            try {
                this.matrixController?.resume?.();
                this.wordCloudController?.resume?.();
            } catch (error) {
                this._recordError(error);
            }

            this._syncState();
            this._emit("start", {
                interval: this.options.interval
            });

            return true;
        }

        stop(options = {}) {
            if (this.timer) {
                window.clearInterval(this.timer);
                this.timer = 0;
            }

            const wasRunning = this.running;
            this.running = false;
            this.paused = false;
            this.autoPaused = false;
            this.updateIndicators();

            try {
                this.matrixController?.pause?.();
                this.wordCloudController?.pause?.();
            } catch (error) {
                this._recordError(error);
            }

            if (options.silent !== true && wasRunning) {
                this._syncState();
                this._emit("stop", {});
            }

            return wasRunning;
        }

        pause(options = {}) {
            if (!this.running || this.paused) {
                return false;
            }

            this.paused = true;

            if (options.automatic !== true) {
                this.autoPaused = false;
            }

            this.updateIndicators();
            this._syncState();

            if (options.automatic !== true) {
                this._emit("pause", {});
            }

            try {
                this.matrixController?.pause?.();
                this.wordCloudController?.pause?.();
            } catch (error) {
                this._recordError(error);
            }

            return true;
        }

        resume(options = {}) {
            if (!this.running) {
                return this.start();
            }

            if (!this.paused) {
                return false;
            }

            this.paused = false;
            this.autoPaused = false;
            this.updateIndicators();
            this._syncState();

            if (options.automatic !== true) {
                this._emit("resume", {});
            }

            try {
                this.matrixController?.resume?.();
                this.wordCloudController?.resume?.();
            } catch (error) {
                this._recordError(error);
            }

            return true;
        }

        rotate(amount = 1) {
            if (!this.records.length) {
                return 0;
            }

            const step = Math.trunc(parseNumber(
                amount,
                1,
                -this.records.length,
                this.records.length
            ));

            this.cursor =
                (this.cursor + step + this.records.length) %
                this.records.length;
            this.metrics.rotations +=
                1;

            this.scheduleRender();

            this._syncState();

            return this.cursor;
        }

        next() {
            return this.rotate(this.options.batch);
        }

        previous() {
            return this.rotate(-this.options.batch);
        }

        render() {
            if (
                this.destroyed
            ) {
                return false;
            }

            const list =
                this.elements.list;

            if (!this.records.length) {
                const empty = createElement(
                    "div",
                    "terminal-splash-empty",
                    EMPTY_MESSAGE
                );
                list.replaceChildren(empty);
                this.updateIndicators();
                this.metrics.renders += 1;
                return;
            }

            const fragment = document.createDocumentFragment();
            const visible = Math.min(
                this.options.visible,
                this.records.length
            );

            for (let offset = 0; offset < visible; offset += 1) {
                const index =
                    (this.cursor + offset) %
                    this.records.length;
                const record = this.records[index];

                const row = createElement(
                    "article",
                    "terminal-splash-row"
                );
                row.dataset.speciedexId = record.speciedexId;
                row.dataset.rank = record.rank;
                row.dataset.provider = record.provider;
                row.dataset.status = record.status;
                row.style.setProperty(
                    "--terminal-splash-row-index",
                    String(offset)
                );
                row.setAttribute("role", "article");
                row.setAttribute(
                    "aria-label",
                    `${record.scientificName}, ${record.commonName}`
                );

                const scientific = createElement(
                    "span",
                    "terminal-splash-scientific",
                    record.scientificName
                );
                const common = createElement(
                    "span",
                    "terminal-splash-common",
                    record.commonName
                );
                const identifier = createElement(
                    "code",
                    "terminal-splash-id",
                    record.speciedexId
                );
                const metadata = createElement(
                    "span",
                    "terminal-splash-meta"
                );

                if (record.rank) {
                    metadata.appendChild(
                        createElement(
                            "span",
                            "terminal-splash-rank",
                            record.rank
                        )
                    );
                }

                if (record.provider) {
                    metadata.appendChild(
                        createElement(
                            "span",
                            "terminal-splash-provider",
                            record.provider
                        )
                    );
                }

                if (record.status) {
                    metadata.appendChild(
                        createElement(
                            "span",
                            "terminal-splash-record-status",
                            record.status
                        )
                    );
                }

                row.append(scientific, common, identifier);

                if (metadata.childNodes.length) {
                    row.appendChild(metadata);
                }

                fragment.appendChild(row);
            }

            list.replaceChildren(fragment);
            this.updateIndicators();
            this.metrics.renders += 1;

            if (this.options.announce) {
                list.setAttribute("aria-live", "polite");
                window.setTimeout(() => {
                    if (!this.destroyed) {
                        list.setAttribute("aria-live", "off");
                    }
                }, 250);
            }

            this._emit(
                "render",
                {
                    visible,
                    cursor:
                        this.cursor
                }
            );

            return true;
        }

        clear(options = {}) {
            const count = this.records.length;
            this.records = [];
            this.seen.clear();
            this.cursor = 0;
            this.metrics.clears += 1;

            if (this.elements.count) {
                this.elements.count.textContent = "0";
            }

            if (this.elements.status) {
                this.elements.status.textContent = "Species stream cleared";
            }

            try {
                this.matrixController?.clear?.();
                this.wordCloudController?.clear?.();
            } catch (error) {
                this._recordError(error);
            }

            this.scheduleRender({
                wordCloud:
                    true
            });

            this._syncState();

            if (options.silent !== true) {
                this._emit("clear", {
                    removed: count
                });
            }

            return count;
        }

        show() {
            this.elements.host.hidden = false;
            this.elements.host.setAttribute("aria-hidden", "false");
            this.root.classList.remove("terminal-splash-hidden");
            this._syncState();
            this._emit("show", {});
            return true;
        }

        hide() {
            this.elements.host.hidden = true;
            this.elements.host.setAttribute("aria-hidden", "true");
            this.root.classList.add("terminal-splash-hidden");
            this._syncState();
            this._emit("hide", {});
            return true;
        }

        setVisible(value) {
            this.options.visible = Math.floor(parseNumber(
                value,
                this.options.visible,
                1,
                1000
            ));
            this.scheduleRender();
            this._syncState();
            return this.options.visible;
        }

        setCapacity(value) {
            this.options.capacity = Math.floor(parseNumber(
                value,
                this.options.capacity,
                1,
                100000
            ));

            while (this.records.length > this.options.capacity) {
                const removed = this.records.shift();

                if (removed) {
                    this.seen.delete(recordKey(removed));
                    this.metrics.evicted += 1;
                }
            }

            this.cursor = this.records.length
                ? this.cursor % this.records.length
                : 0;
            this.scheduleRender({
                wordCloud:
                    true
            });

            this._syncState();

            return this.options.capacity;
        }

        setInterval(value) {
            this.options.interval = parseNumber(
                value,
                this.options.interval,
                16,
                60000
            );

            if (
                this.running
            ) {
                const wasPaused =
                    this.paused;

                const wasAutoPaused =
                    this.autoPaused;

                this.start();

                if (
                    wasPaused
                ) {
                    this.pause({
                        automatic:
                            wasAutoPaused
                    });

                    this.autoPaused =
                        wasAutoPaused;
                }
            }

            return this.options.interval;
        }

        snapshot(options = {}) {
            const limit =
                Math.floor(
                    parseNumber(
                        options.limit,
                        Math.min(
                            this.records.length,
                            this.snapshotLimit
                        ),
                        0,
                        Math.min(
                            this.records.length,
                            this.snapshotLimit
                        )
                    )
                );

            return {
                status: this.status(),
                records: limit
                    ? this.records.slice(-limit).map(clone)
                    : []
            };
        }

        watch(callback, options = {}) {
            if (typeof callback !== "function") {
                throw new TypeError("Splash watcher must be a function.");
            }

            this.watchers.add(callback);

            if (options.immediate === true) {
                try {
                    callback({
                        type: "initial",
                        timestamp: iso(),
                        status: this.status()
                    }, this);
                } catch (error) {
                    this._recordError(error, false);
                }
            }

            return () => this.watchers.delete(callback);
        }

        status() {
            return {
                name: "terminal-splash",
                module: MODULE_NAME,
                version: VERSION,
                running: this.running,
                paused: this.paused,
                autoPaused: this.autoPaused,
                hidden: this.elements.host.hidden,
                records: this.records.length,
                cursor: this.cursor,
                options: {
                    ...this.options
                },
                lastSource: this.lastSource,
                lastIngestAt: this.lastIngestAt,
                startedAt: this.startedAt,
                reducedMotion: this.reducedMotion,
                matrixMode: this.options.matrixMode,
                matrixAvailable: this.matrixAvailability(),
                matrix:
                    this.matrixController?.constructor?.name ||
                    (this.matrixController ? "mounted" : null),
                wordcloud: Boolean(this.wordCloudController),
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
            if (
                this.destroyed
            ) {
                return false;
            }

            this.stop({
                silent:
                    true
            });

            if (
                this.renderFrame
            ) {
                window.cancelAnimationFrame(
                    this.renderFrame
                );

                this.renderFrame =
                    0;
            }

            this.pendingRender =
                false;

            this.pendingWordCloudRefresh =
                false;

            this.visibilityObserver?.
                disconnect();

            this.visibilityObserver =
                null;

            this.abortController.abort();

            for (
                const unsubscribe of
                this.unsubscribers
            ) {
                try {
                    unsubscribe();
                } catch (_error) {
                    /* Ignore event-bus cleanup failures. */
                }
            }

            this.listeners =
                [];

            this.unsubscribers =
                [];

            this._destroyMatrixController();

            try {
                this.wordCloudController?.
                    destroy?.();
            } catch (error) {
                this._recordError(
                    error,
                    false
                );
            }

            this.wordCloudController =
                null;

            if (
                !this.options.preserveRecords
            ) {
                this.records =
                    [];

                this.seen.clear();
            }

            if (
                this.elements.matrixToggle?.
                    dataset.generated ===
                    "true"
            ) {
                this.elements.matrixToggle.remove();
            }

            this._emit(
                "destroy",
                {},
                false
            );

            this.watchers.clear();

            if (
                this.root[
                    CONTROLLER_SYMBOL
                ] ===
                    this
            ) {
                delete this.root[
                    CONTROLLER_SYMBOL
                ];
            }

            if (
                this.elements.host[
                    CONTROLLER_SYMBOL
                ] ===
                    this
            ) {
                delete this.elements.host[
                    CONTROLLER_SYMBOL
                ];
            }

            this.destroyed =
                true;

            return true;
        }

    }

    function initialize(
        context =
            {}
    ) {
        if (
            !context?.
                root
        ) {
            throw new TypeError(
                "Terminal splash initialization requires context.root."
            );
        }

        const root =
            context.root;

        const dataset =
            root.dataset ||
            {};

        const config =
            context.config?.
                splash ||
            {};

        const existing =
            context.terminalSplash ||
            context.services?.
                get?.(
                    "terminal-splash"
                ) ||
            root[
                CONTROLLER_SYMBOL
            ];

        if (
            existing instanceof
                TerminalSplashController &&
            !existing.destroyed
        ) {
            context.terminalSplash =
                existing;

            context.registerVisualization?.(
                "splash",
                existing
            );

            context.registerService?.(
                "terminal-splash",
                existing
            );

            return existing;
        }

        let visibility =
            context.terminalVisibility ||
            context.services?.
                get?.(
                    "terminal-visibility"
                ) ||
            root[
                VISIBILITY_SYMBOL
            ];

        if (
            !(
                visibility instanceof
                    TerminalRegionVisibility
            ) ||
            visibility.destroyed
        ) {
            visibility =
                new TerminalRegionVisibility(
                    context,
                    {
                        instance:
                            dataset.terminalInstance,
                        storageKey:
                            dataset.
                                terminalVisibilityStorageKey ||
                            config.
                                visibilityStorageKey
                    }
                );

            root[
                VISIBILITY_SYMBOL
            ] =
                visibility;
        }

        context.terminalVisibility =
            visibility;

        context.registerService?.(
            "terminal-visibility",
            visibility
        );

        const legacyPreferred =
            parseBoolean(
                dataset.
                    terminalSplashPreferZMatrix,
                config.preferZMatrix !==
                    false
            );

        const controller =
            new TerminalSplashController(
                context,
                {
                    instance:
                        dataset.terminalInstance,

                    matrixStorageKey:
                        dataset.
                            terminalSplashMatrixStorageKey ||
                        config.
                            matrixStorageKey,

                    matrixMode:
                        dataset.
                            terminalSplashMatrixMode ||
                        config.matrixMode ||
                        (
                            legacyPreferred
                                ? "zmatrix"
                                : "cmatrix"
                        ),

                    matrixOptions:
                        config.matrixOptions,

                    capacity:
                        dataset.
                            terminalSplashCapacity ||
                        config.capacity ||
                        DEFAULT_CAPACITY,

                    visible:
                        dataset.
                            terminalSplashVisible ||
                        config.visible ||
                        DEFAULT_VISIBLE,

                    interval:
                        dataset.
                            terminalSplashInterval ||
                        config.interval ||
                        DEFAULT_INTERVAL,

                    batch:
                        dataset.
                            terminalSplashBatch ||
                        config.batch ||
                        DEFAULT_BATCH,

                    preferZMatrix:
                        legacyPreferred,

                    autoplay:
                        parseBoolean(
                            dataset.
                                terminalSplashAutoplay,
                            config.autoplay !==
                                false
                        ),

                    pauseWhenHidden:
                        parseBoolean(
                            dataset.
                                terminalSplashPauseWhenHidden,
                            config.
                                pauseWhenHidden !==
                                false
                        ),

                    deduplicate:
                        parseBoolean(
                            dataset.
                                terminalSplashDeduplicate,
                            config.deduplicate !==
                                false
                        ),

                    announce:
                        parseBoolean(
                            dataset.
                                terminalSplashAnnounce,
                            config.announce !==
                                false
                        ),

                    preserveRecords:
                        parseBoolean(
                            dataset.
                                terminalSplashPreserveRecords,
                            config.
                                preserveRecords ===
                                true
                        )
                }
            );

        root[
            CONTROLLER_SYMBOL
        ] =
            controller;

        root[
            VISUALIZATION_SYMBOL
        ] =
            api;

        context.terminalSplash =
            controller;

        context.registerVisualization?.(
            "splash",
            controller
        );

        context.registerService?.(
            "terminal-splash",
            controller
        );

        safeDispatch(
            document,
            "speciedex:terminal-splash-ready",
            {
                controller,
                visibility,
                status:
                    controller.status()
            }
        );

        return controller;
    }

    const commands = [{
        name: "splash",
        category: "visualization",
        description:
            "Inspect and control the live species splash and its matrix renderer.",
        usage:
            "splash [status|show|hide|start|stop|pause|resume|next|previous|" +
            "clear|snapshot|visible|capacity|interval|matrix]",
        handler: async ({
            args = [],
            context,
            writeJSON,
            write,
            writeError
        }) => {
            const controller =
                context.terminalSplash ||
                context.services?.get?.("terminal-splash");

            if (!controller) {
                throw new Error("Terminal splash is unavailable.");
            }

            const action = String(args[0] || "status").toLowerCase();
            const value = args[1];

            try {
                switch (action) {
                    case "status":
                    case "show-status":
                    case "info":
                        return outputJSON(writeJSON, controller.status());

                    case "show":
                        controller.show();
                        return outputText(
                            write,
                            "Terminal splash shown.",
                            "success"
                        );

                    case "hide":
                        controller.hide();
                        return outputText(
                            write,
                            "Terminal splash hidden.",
                            "success"
                        );

                    case "start":
                        controller.start();
                        return outputText(
                            write,
                            "Terminal splash started.",
                            "success"
                        );

                    case "stop":
                        controller.stop();
                        return outputText(
                            write,
                            "Terminal splash stopped.",
                            "success"
                        );

                    case "pause":
                        controller.pause();
                        return outputText(
                            write,
                            "Terminal splash paused.",
                            "success"
                        );

                    case "resume":
                        controller.resume();
                        return outputText(
                            write,
                            "Terminal splash resumed.",
                            "success"
                        );

                    case "next":
                        return outputJSON(writeJSON, {
                            cursor: controller.next()
                        });

                    case "previous":
                    case "prev":
                        return outputJSON(writeJSON, {
                            cursor: controller.previous()
                        });

                    case "clear":
                        return outputJSON(writeJSON, {
                            cleared: controller.clear()
                        });

                    case "snapshot":
                        return outputJSON(
                            writeJSON,
                            controller.snapshot({ limit: value })
                        );

                    case "visible":
                        return outputJSON(writeJSON, {
                            visible:
                                value === undefined
                                    ? controller.options.visible
                                    : controller.setVisible(value)
                        });

                    case "capacity":
                        return outputJSON(writeJSON, {
                            capacity:
                                value === undefined
                                    ? controller.options.capacity
                                    : controller.setCapacity(value)
                        });

                    case "interval":
                        return outputJSON(writeJSON, {
                            interval:
                                value === undefined
                                    ? controller.options.interval
                                    : controller.setInterval(value)
                        });

                    case "matrix":
                    case "matrix-mode": {
                        const operation = String(value || "status").toLowerCase();

                        if (
                            operation === "status" ||
                            operation === "show"
                        ) {
                            return outputJSON(writeJSON, {
                                mode: controller.options.matrixMode,
                                available: controller.matrixAvailability()
                            });
                        }

                        const mode =
                            operation === "toggle"
                                ? await controller.toggleMatrix()
                                : await controller.setMatrixMode(operation);

                        return outputJSON(writeJSON, {
                            mode,
                            available: controller.matrixAvailability()
                        });
                    }

                    case "cmatrix":
                    case "zmatrix":
                        return outputJSON(writeJSON, {
                            mode: await controller.setMatrixMode(action),
                            available: controller.matrixAvailability()
                        });

                    default:
                        throw new Error(
                            `Unknown splash action "${action}". Use status, show, hide, ` +
                            "start, stop, pause, resume, next, previous, clear, snapshot, " +
                            "visible, capacity, interval, matrix, cmatrix, or zmatrix."
                        );
                }
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
        VISIBILITY_SYMBOL,
        matrixModes:
            MATRIX_MODES,
        TerminalSplashController,
        TerminalRegionVisibility,
        normalizeRecord,
        normalizeMatrixMode,
        collect,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalSplash = api;
    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules.splash = api;
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    safeDispatch(
        document,
        "speciedex:terminal-module-available",
        {
            name: MODULE_NAME,
            module: api
        }
    );
})(window, document);