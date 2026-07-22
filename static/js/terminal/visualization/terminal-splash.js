/*
========================================================================
Speciedex.org
Terminal Live Species Splash
========================================================================

Coordinates terminal-cmatrix.js, terminal-zmatrix.js, and terminal-wordcloud.js
to create the live species visualization mounted above the interactive terminal
console.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Splash";
    const DEFAULT_CAPACITY = 256;
    const DEFAULT_VISIBLE = 12;
    const DEFAULT_INTERVAL = 140;
    const DEFAULT_BATCH = 1;
    const DEFAULT_STORAGE_PREFIX = "speciedex-terminal:splash";
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

    function normalizeText(value, fallback = "") {
        if (value === undefined || value === null) {
            return fallback;
        }

        return String(value).trim() || fallback;
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

    function normalizeRecord(record, source = "runtime") {
        if (!isObject(record)) {
            return null;
        }

        const scientificName = normalizeText(
            first(record, [
                "scientific_name",
                "scientificName",
                "canonical_name",
                "canonicalName",
                "accepted_name",
                "acceptedName",
                "taxon_name",
                "taxonName",
                "name"
            ]),
            "Unknown taxon"
        );

        const commonName = normalizeText(
            first(record, [
                "common_name",
                "commonName",
                "vernacular_name",
                "vernacularName",
                "preferred_common_name",
                "preferredCommonName",
                "english_name",
                "englishName"
            ]),
            "No common name"
        );

        const speciedexId = normalizeText(
            first(record, [
                "speciedex_id",
                "speciedexId",
                "speciedex_key",
                "speciedexKey",
                "canonical_id",
                "canonicalId",
                "taxon_id",
                "taxonId",
                "id",
                "key"
            ]),
            "pending"
        );

        const rank = normalizeText(
            first(record, [
                "rank",
                "taxon_rank",
                "taxonRank",
                "taxonomic_rank",
                "taxonomicRank"
            ])
        );

        const provider = normalizeText(
            first(record, [
                "provider",
                "source",
                "provider_id",
                "providerId",
                "dataset",
                "dataset_name",
                "datasetName"
            ]),
            source
        );

        const status = normalizeText(
            first(record, [
                "status",
                "taxonomic_status",
                "taxonomicStatus",
                "accepted_status",
                "acceptedStatus"
            ])
        );

        const timestamp = first(record, [
            "detectedAt",
            "detected_at",
            "timestamp",
            "createdAt",
            "created_at",
            "updatedAt",
            "updated_at"
        ]);

        const detectedAt = Number.isFinite(Date.parse(timestamp))
            ? new Date(timestamp).toISOString()
            : iso();

        return {
            scientificName,
            commonName,
            speciedexId,
            rank,
            provider,
            status,
            source,
            detectedAt,
            raw: clone(record)
        };
    }

    function collect(payload) {
        if (!payload) {
            return [];
        }

        if (payload instanceof CustomEvent) {
            return collect(payload.detail);
        }

        if (Array.isArray(payload)) {
            return payload.flatMap((item) => collect(item));
        }

        if (!isObject(payload)) {
            return [];
        }

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

        for (const candidate of candidates) {
            if (Array.isArray(candidate)) {
                return candidate;
            }

            if (isObject(candidate)) {
                return [candidate];
            }
        }

        return [payload];
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

            this.context = context;
            this.root = context.root;
            this.storage =
                context.storage ||
                context.services?.get?.("storage") ||
                null;
            this.instance =
                this.root?.dataset?.terminalInstance ||
                options.instance ||
                "default";
            this.storageKey =
                options.storageKey ||
                `${DEFAULT_STORAGE_PREFIX}:visibility:${this.instance}`;
            this.destroyed = false;
            this.watchers = new Set();
            this.lastError = null;

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

        _emit(type, detail = {}) {
            const event = {
                type,
                timestamp: iso(),
                state: clone(this.state),
                ...detail
            };

            safeDispatch(this, type, event);

            for (const watcher of Array.from(this.watchers)) {
                try {
                    watcher(event, this);
                } catch (error) {
                    this.lastError = error;
                }
            }

            try {
                this.context.events?.emit?.(`terminal:visibility:${type}`, event);
            } catch (error) {
                this.lastError = error;
            }

            return event;
        }

        _syncState() {
            const state = this.context.state || this.context.stateStore;

            try {
                state?.set?.("terminal.visibility", {
                    ...clone(this.state),
                    updatedAt: iso()
                });
            } catch (error) {
                /* State synchronization is advisory. */
            }
        }

        restore() {
            try {
                if (this.storage?.get) {
                    const value = this.storage.get(this.storageKey, {});
                    return isObject(value) ? value : {};
                }

                const raw = window.localStorage.getItem(this.storageKey);
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
                    window.localStorage.setItem(
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

                button.addEventListener("click", handler);
                this._listeners.push(() => {
                    button.removeEventListener("click", handler);
                });
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
                } catch (error) {
                    /* Ignore listener cleanup failures. */
                }
            }

            this._listeners = [];
            this.watchers.clear();
            this.destroyed = true;
            this._emit("destroy", {});
            return true;
        }
    }

    class TerminalSplashController extends EventTarget {
        constructor(context, options = {}) {
            super();

            this.context = context;
            this.root = context.root;
            this.options = {
                capacity: parseNumber(
                    options.capacity,
                    DEFAULT_CAPACITY,
                    1,
                    100000
                ),
                visible: parseNumber(
                    options.visible,
                    DEFAULT_VISIBLE,
                    1,
                    1000
                ),
                interval: parseNumber(
                    options.interval,
                    DEFAULT_INTERVAL,
                    16,
                    60000
                ),
                batch: parseNumber(
                    options.batch,
                    DEFAULT_BATCH,
                    1,
                    1000
                ),
                preferZMatrix: options.preferZMatrix !== false,
                autoplay: options.autoplay !== false,
                pauseWhenHidden: options.pauseWhenHidden !== false,
                deduplicate: options.deduplicate !== false,
                announce: options.announce !== false,
                preserveRecords: options.preserveRecords === true
            };

            this.records = [];
            this.seen = new Set();
            this.cursor = 0;
            this.timer = 0;
            this.destroyed = false;
            this.running = false;
            this.paused = false;
            this.unsubscribers = [];
            this.listeners = [];
            this.watchers = new Set();
            this.lastError = null;
            this.lastSource = null;
            this.lastIngestAt = null;
            this.startedAt = iso();
            this.metrics = {
                received: 0,
                accepted: 0,
                duplicates: 0,
                rejected: 0,
                evicted: 0,
                renders: 0,
                rotations: 0,
                clears: 0,
                errors: 0
            };

            this.elements = this.captureElements();
            this.matrixController = null;
            this.wordCloudController = null;
            this.visibilityObserver = null;
            this.reducedMotion = Boolean(
                window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
            );

            this.mountVisualizations();
            this.bindEvents();
            this.observeVisibility();
            this.render();

            if (this.options.autoplay) {
                this.start();
            }

            this._syncState();
        }

        _emit(type, detail = {}) {
            const event = {
                type,
                timestamp: iso(),
                records: this.records.length,
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

            try {
                this.context.events?.emit?.(`splash:${type}`, event);
            } catch (error) {
                this._recordError(error);
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
                    lastSource: this.lastSource,
                    lastIngestAt: this.lastIngestAt,
                    metrics: { ...this.metrics },
                    updatedAt: iso()
                });
            } catch (error) {
                /* State synchronization is advisory. */
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
                host.getAttribute("aria-label") || "Live species visualization"
            );

            list.setAttribute("role", "feed");
            list.setAttribute("aria-live", "off");

            return {
                host,
                list,
                canvas,
                wordcloud,
                count: host.querySelector("[data-terminal-splash-count]"),
                status: host.querySelector("[data-terminal-splash-status]"),
                source: host.querySelector("[data-terminal-splash-source]"),
                pause: host.querySelector("[data-terminal-splash-pause]"),
                next: host.querySelector("[data-terminal-splash-next]"),
                previous: host.querySelector("[data-terminal-splash-previous]"),
                clear: host.querySelector("[data-terminal-splash-clear]")
            };
        }

        mountVisualizations() {
            const visualizations = this.context.visualizations;
            const zmatrix =
                visualizations?.get?.("zmatrix") ||
                window.SpeciedexTerminalZMatrix;
            const cmatrix =
                visualizations?.get?.("cmatrix") ||
                window.SpeciedexTerminalCMatrix;
            const wordcloud =
                visualizations?.get?.("wordcloud") ||
                window.SpeciedexTerminalWordCloud;

            try {
                if (this.options.preferZMatrix && zmatrix?.mount) {
                    this.matrixController = zmatrix.mount(
                        this.elements.canvas,
                        {
                            baseSpeed: 0.82,
                            pulseSpeed: 0.022,
                            opacity: 0.30
                        }
                    );
                } else if (cmatrix?.mount) {
                    this.matrixController = cmatrix.mount(
                        this.elements.canvas,
                        {
                            speed: 0.82,
                            density: 0.86,
                            trail: 0.10,
                            opacity: 0.24
                        }
                    );
                }
            } catch (error) {
                this._recordError(error);
            }

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
            for (const eventName of DOCUMENT_EVENTS) {
                const handler = (event) => {
                    const payload =
                        eventName === "speciedex:terminal-command-complete"
                            ? event.detail?.result
                            : event.detail;

                    this.ingest(payload, eventName);
                };

                document.addEventListener(eventName, handler);
                this.listeners.push(() => {
                    document.removeEventListener(eventName, handler);
                });
            }

            const eventBus = this.context.events;

            if (eventBus?.on) {
                for (const eventName of BUS_EVENTS) {
                    try {
                        const unsubscribe = eventBus.on(
                            eventName,
                            (event) => this.ingest(
                                event?.detail ?? event,
                                eventName
                            )
                        );

                        if (typeof unsubscribe === "function") {
                            this.unsubscribers.push(unsubscribe);
                        }
                    } catch (error) {
                        this._recordError(error);
                    }
                }
            }

            const bindButton = (element, handler) => {
                if (!element) {
                    return;
                }

                element.addEventListener("click", handler);
                this.listeners.push(() => {
                    element.removeEventListener("click", handler);
                });
            };

            bindButton(this.elements.pause, () => {
                this.paused ? this.resume() : this.pause();
            });

            bindButton(this.elements.next, () => {
                this.next();
            });

            bindButton(this.elements.previous, () => {
                this.previous();
            });

            bindButton(this.elements.clear, () => {
                this.clear();
            });

            const visibilityHandler = () => {
                if (
                    this.options.pauseWhenHidden &&
                    document.visibilityState === "hidden"
                ) {
                    this.pause({
                        automatic: true
                    });
                } else if (
                    this.options.pauseWhenHidden &&
                    document.visibilityState === "visible" &&
                    this.options.autoplay
                ) {
                    this.resume({
                        automatic: true
                    });
                }
            };

            document.addEventListener("visibilitychange", visibilityHandler);
            this.listeners.push(() => {
                document.removeEventListener(
                    "visibilitychange",
                    visibilityHandler
                );
            });
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
                        this.pause({
                            automatic: true
                        });
                    } else if (
                        this.options.autoplay &&
                        document.visibilityState !== "hidden"
                    ) {
                        this.resume({
                            automatic: true
                        });
                    }
                },
                {
                    threshold: 0.01
                }
            );

            this.visibilityObserver.observe(this.elements.host);
        }

        ingest(payload, source = "runtime") {
            if (this.destroyed) {
                return {
                    received: 0,
                    added: 0
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

            this.updateIndicators({
                added,
                source
            });

            try {
                this.wordCloudController?.refresh?.();
            } catch (error) {
                this._recordError(error);
            }

            this.render();
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
        }

        start() {
            if (this.destroyed) {
                throw new Error("Terminal splash has been destroyed.");
            }

            this.stop({
                silent: true
            });

            this.running = true;
            this.paused = false;
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
            this.updateIndicators();

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

            const step = parseNumber(
                amount,
                1,
                -this.records.length,
                this.records.length
            );

            this.cursor =
                (this.cursor + step + this.records.length) %
                this.records.length;
            this.metrics.rotations += 1;
            this.render();
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
            const list = this.elements.list;

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

            this._emit("render", {
                visible,
                cursor: this.cursor
            });
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
                this.wordCloudController?.refresh?.();
            } catch (error) {
                this._recordError(error);
            }

            this.render();
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
            this.options.visible = parseNumber(
                value,
                this.options.visible,
                1,
                1000
            );
            this.render();
            this._syncState();
            return this.options.visible;
        }

        setCapacity(value) {
            this.options.capacity = parseNumber(
                value,
                this.options.capacity,
                1,
                100000
            );

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
            this.render();
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

            if (this.running) {
                this.start();
            }

            return this.options.interval;
        }

        snapshot(options = {}) {
            const limit = parseNumber(
                options.limit,
                this.records.length,
                0,
                this.records.length
            );

            return {
                status: this.status(),
                records: this.records.slice(-limit).map(clone)
            };
        }

        watch(callback, options = {}) {
            if (typeof callback !== "function") {
                throw new TypeError("Splash watcher must be a function.");
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
                name: "terminal-splash",
                module: MODULE_NAME,
                running: this.running,
                paused: this.paused,
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
            if (this.destroyed) {
                return false;
            }

            this.stop({
                silent: true
            });
            this.destroyed = true;
            this.visibilityObserver?.disconnect();
            this.visibilityObserver = null;

            for (const remove of this.listeners) {
                try {
                    remove();
                } catch (error) {
                    /* Ignore listener cleanup failures. */
                }
            }

            for (const unsubscribe of this.unsubscribers) {
                try {
                    unsubscribe();
                } catch (error) {
                    /* Ignore event-bus cleanup failures. */
                }
            }

            this.listeners = [];
            this.unsubscribers = [];
            this.watchers.clear();

            try {
                this.matrixController?.destroy?.();
                this.wordCloudController?.destroy?.();
            } catch (error) {
                this._recordError(error);
            }

            this.matrixController = null;
            this.wordCloudController = null;

            if (!this.options.preserveRecords) {
                this.records = [];
                this.seen.clear();
            }

            this._emit("destroy", {});
            return true;
        }
    }

    function initialize(context = {}) {
        const dataset = context.root?.dataset || {};
        const config = context.config?.splash || {};

        const visibility = new TerminalRegionVisibility(context, {
            instance: dataset.terminalInstance,
            storageKey:
                dataset.terminalVisibilityStorageKey ||
                config.visibilityStorageKey
        });

        context.terminalVisibility = visibility;
        context.registerService?.("terminal-visibility", visibility);

        const controller = new TerminalSplashController(context, {
            capacity:
                dataset.terminalSplashCapacity ||
                config.capacity ||
                DEFAULT_CAPACITY,
            visible:
                dataset.terminalSplashVisible ||
                config.visible ||
                DEFAULT_VISIBLE,
            interval:
                dataset.terminalSplashInterval ||
                config.interval ||
                DEFAULT_INTERVAL,
            batch:
                dataset.terminalSplashBatch ||
                config.batch ||
                DEFAULT_BATCH,
            preferZMatrix: parseBoolean(
                dataset.terminalSplashPreferZMatrix,
                config.preferZMatrix !== false
            ),
            autoplay: parseBoolean(
                dataset.terminalSplashAutoplay,
                config.autoplay !== false
            ),
            pauseWhenHidden: parseBoolean(
                dataset.terminalSplashPauseWhenHidden,
                config.pauseWhenHidden !== false
            ),
            deduplicate: parseBoolean(
                dataset.terminalSplashDeduplicate,
                config.deduplicate !== false
            ),
            announce: parseBoolean(
                dataset.terminalSplashAnnounce,
                config.announce !== false
            )
        });

        context.terminalSplash = controller;
        context.registerVisualization?.("splash", controller);
        context.registerService?.("terminal-splash", controller);

        safeDispatch(document, "speciedex:terminal-splash-ready", {
            controller,
            visibility,
            status: controller.status()
        });

        return controller;
    }

    const commands = [{
        name: "splash",
        category: "visualization",
        description: "Inspect and control the live species splash.",
        usage:
            "splash [status|show|hide|start|stop|pause|resume|next|previous|" +
            "clear|snapshot|visible|capacity|interval]",
        handler: ({
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
                        return writeJSON(controller.status());

                    case "show":
                        controller.show();
                        return write("Terminal splash shown.", "success");

                    case "hide":
                        controller.hide();
                        return write("Terminal splash hidden.", "success");

                    case "start":
                        controller.start();
                        return write("Terminal splash started.", "success");

                    case "stop":
                        controller.stop();
                        return write("Terminal splash stopped.", "success");

                    case "pause":
                        controller.pause();
                        return write("Terminal splash paused.", "success");

                    case "resume":
                        controller.resume();
                        return write("Terminal splash resumed.", "success");

                    case "next":
                        return writeJSON({
                            cursor: controller.next()
                        });

                    case "previous":
                    case "prev":
                        return writeJSON({
                            cursor: controller.previous()
                        });

                    case "clear":
                        return writeJSON({
                            cleared: controller.clear()
                        });

                    case "snapshot":
                        return writeJSON(
                            controller.snapshot({
                                limit: value
                            })
                        );

                    case "visible":
                        if (value === undefined) {
                            return writeJSON({
                                visible: controller.options.visible
                            });
                        }
                        return writeJSON({
                            visible: controller.setVisible(value)
                        });

                    case "capacity":
                        if (value === undefined) {
                            return writeJSON({
                                capacity: controller.options.capacity
                            });
                        }
                        return writeJSON({
                            capacity: controller.setCapacity(value)
                        });

                    case "interval":
                        if (value === undefined) {
                            return writeJSON({
                                interval: controller.options.interval
                            });
                        }
                        return writeJSON({
                            interval: controller.setInterval(value)
                        });

                    default:
                        throw new Error(
                            `Unknown splash action "${action}". Use status, show, hide, ` +
                            "start, stop, pause, resume, next, previous, clear, snapshot, " +
                            "visible, capacity, or interval."
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
        TerminalSplashController,
        TerminalRegionVisibility,
        normalizeRecord,
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
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(
        new CustomEvent("speciedex:terminal-module-available", {
            detail: {
                name: MODULE_NAME,
                module: api
            }
        })
    );
})(window, document);
