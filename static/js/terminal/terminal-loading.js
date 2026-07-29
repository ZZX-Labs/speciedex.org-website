/*
========================================================================
Speciedex.org
Terminal Loading Coordinator
========================================================================

Loading-state coordinator for SpeciedexTerminal.

Visual rendering is delegated exclusively to:

    /static/js/terminal/terminal-animation.js

Required load order:

    terminal-animation.js
    terminal-loading.js

The loading coordinator owns task state, startup readiness, visibility,
status integration, commands, diagnostics, and teardown. It does not create
or position GIF elements directly.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Loading";
    const VERSION = "3.8.0";
    const PRIMARY_COLOR = "#c0d674";
    const DEFAULT_ASSET_ROOT = "/static/images/terminal/loading/";

    const LOADING_SYMBOL = Symbol.for(
        "speciedex.terminal.loading.coordinator"
    );

    const activeDispatches = new WeakMap();
    const RESERVED_KEYS = new Set([
        "__proto__",
        "prototype",
        "constructor"
    ]);

    const DEFAULT_OPTIONS = Object.freeze({
        minimumVisibleTime: 2600,
        showDelay: 80,
        startupTask: true,
        startupHoldAfterReady: 600,
        startupSimulationDuration: 45000,
        bannerLeadTime: 0,
        terminalRevealDelay: 0,
        startupLabel:
            "Loading terminal modules, providers, datasets, and session state",
        revealDelay: 120,
        revealStep: 120,
        message: "Please wait, Loading",
        assetRoot: DEFAULT_ASSET_ROOT,
        ring: "loading-ring.gif",
        ringOutline: "loading-ring-outline.gif",
        useOutlineRing: false,
        animationLayout: "horizontal",
        animationCreatureSet: "runners",
        animationCreatureCount: 4,
        injectStyles: true,
        overlayClass: "terminal-loading-overlay",
        hiddenClass: "terminal-loading-hidden",
        activeClass: "terminal-is-loading",
        reducedMotion: false
    });

    function isObject(value) {
        return value !== null &&
            typeof value === "object" &&
            !Array.isArray(value);
    }

    function safeClone(value, seen = new WeakMap(), depth = 0) {
        if (
            value === null ||
            value === undefined ||
            typeof value !== "object"
        ) {
            return typeof value === "bigint" ? String(value) : value;
        }

        if (depth > 24) {
            return "[Truncated]";
        }

        if (seen.has(value)) {
            return "[Circular]";
        }

        seen.set(value, true);

        if (value instanceof Error) {
            return {
                name: value.name,
                message: value.message,
                stack: value.stack || null
            };
        }

        if (value instanceof Date) {
            return value.toISOString();
        }

        if (Array.isArray(value)) {
            return value.map(item => safeClone(item, seen, depth + 1));
        }

        const output = {};

        for (const [key, item] of Object.entries(value)) {
            if (RESERVED_KEYS.has(key)) {
                continue;
            }

            output[key] = safeClone(item, seen, depth + 1);
        }

        return output;
    }

    function nowISO(value = Date.now()) {
        const date = value instanceof Date ? value : new Date(value);

        return Number.isFinite(date.getTime())
            ? date.toISOString()
            : new Date().toISOString();
    }

    function monotonicNow() {
        return (
            typeof performance !== "undefined" &&
            typeof performance.now === "function"
        )
            ? performance.now()
            : Date.now();
    }

    function dispatch(target, name, detail = {}, options = {}) {
        if (
            !target ||
            typeof target.dispatchEvent !== "function" ||
            !name
        ) {
            return false;
        }

        let names = activeDispatches.get(target);

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
                new CustomEvent(name, {
                    bubbles: options.bubbles === true,
                    cancelable: options.cancelable === true,
                    detail
                })
            );
        } catch (_error) {
            return false;
        } finally {
            names.delete(name);
        }
    }

    function clamp(value, minimum, maximum) {
        return Math.min(maximum, Math.max(minimum, value));
    }

    function finiteNumber(
        value,
        fallback,
        minimum = -Infinity,
        maximum = Infinity
    ) {
        const numeric = Number(value);

        return Number.isFinite(numeric)
            ? clamp(numeric, minimum, maximum)
            : fallback;
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

    function parseProgress(value) {
        if (value === null || value === undefined || value === "") {
            return null;
        }

        const numeric = Number(value);

        return Number.isFinite(numeric)
            ? clamp(numeric, 0, 100)
            : null;
    }

    function normalizeID(value) {
        const id = String(value ?? "").trim();

        if (!id) {
            throw new Error("Loading task ID is required.");
        }

        return id;
    }

    function normalizeLabel(value, fallback) {
        const label = String(value ?? "").trim();
        return label || fallback;
    }

    function wait(milliseconds) {
        return new Promise(resolve => {
            window.setTimeout(resolve, milliseconds);
        });
    }

    function prefersReducedMotion() {
        return Boolean(
            window.matchMedia &&
            window.matchMedia("(prefers-reduced-motion: reduce)").matches
        );
    }

    function joinAsset(root, path) {
        const base = String(root || DEFAULT_ASSET_ROOT);
        const asset = String(path || "");

        try {
            return new URL(
                asset,
                new URL(
                    base,
                    window.location?.origin ||
                    document.baseURI ||
                    "http://localhost/"
                )
            ).href;
        } catch (_error) {
            return `${base.endsWith("/") ? base : `${base}/`}${asset.replace(/^\/+/, "")}`;
        }
    }

    function injectLoadingStyles() {
        if (document.getElementById("speciedex-terminal-loading-styles")) {
            return false;
        }

        const style = document.createElement("style");
        style.id = "speciedex-terminal-loading-styles";
        style.textContent = `
            .terminal-loading-overlay {
                --terminal-loading-color: ${PRIMARY_COLOR};
                position: relative !important;
                inset: auto !important;
                z-index: auto !important;
                display: block !important;
                width: 100%;
                max-width: 100%;
                min-width: 0;
                min-height: 0;
                margin: 0;
                padding: 1rem 0.75rem 1.1rem;
                overflow: hidden;
                color: var(--terminal-loading-color);
                background:
                    radial-gradient(
                        circle at 50% 18%,
                        rgba(192, 214, 116, 0.075),
                        transparent 42%
                    );
                border-top: 1px solid rgba(192, 214, 116, 0.1);
                border-bottom: 1px solid rgba(192, 214, 116, 0.14);
                opacity: 1;
                visibility: visible;
                max-height: 80rem;
                transition:
                    opacity 260ms ease,
                    visibility 260ms ease,
                    max-height 340ms ease,
                    margin 340ms ease,
                    padding 340ms ease,
                    border-width 340ms ease;
                isolation: isolate;
            }

            .terminal-loading-overlay.terminal-loading-hidden {
                max-height: 0 !important;
                min-height: 0 !important;
                margin-top: 0 !important;
                margin-bottom: 0 !important;
                padding-top: 0 !important;
                padding-bottom: 0 !important;
                border-width: 0 !important;
                opacity: 0;
                visibility: hidden;
                overflow: hidden;
                pointer-events: none;
            }

            .terminal-loading-stage {
                position: relative;
                display: grid;
                width: 100%;
                max-width: 72rem;
                min-width: 0;
                margin: 0 auto;
                gap: 0.5rem;
                justify-items: center;
                align-items: center;
                overflow: hidden;
                text-align: center;
                contain: layout paint;
            }

            .terminal-loading-stage > * {
                opacity: 0;
                transform: translateY(0.35rem);
                transition:
                    opacity 220ms ease,
                    transform 260ms ease;
            }

            .terminal-loading-stage > *.is-revealed {
                opacity: 1;
                transform: translateY(0);
            }

            .terminal-loading-animation-host {
                width: 100%;
                min-width: 0;
                overflow: hidden;
            }

            .terminal-loading-task,
            .terminal-loading-progress-text {
                width: 100%;
                min-height: 1.15rem;
                margin: 0;
                text-align: center;
            }

            .terminal-loading-task {
                color: rgba(216, 230, 219, 0.72);
                font-size: 0.74rem;
            }

            .terminal-loading-progress-text {
                color: rgba(192, 214, 116, 0.7);
                font-size: 0.72rem;
            }

            @media (prefers-reduced-motion: reduce) {
                .terminal-loading-overlay,
                .terminal-loading-stage > * {
                    transition-duration: 1ms;
                }
            }
        `;

        (document.head || document.documentElement).appendChild(style);
        return true;
    }

    class LoadingCoordinator extends EventTarget {
        constructor(context = {}, options = {}) {
            super();

            this.context = isObject(context) ? context : {};
            this.context.root =
                this.context.root &&
                typeof this.context.root.querySelector === "function"
                    ? this.context.root
                    : document.documentElement;

            this.options = {
                ...DEFAULT_OPTIONS,
                ...options,
                minimumVisibleTime: finiteNumber(
                    options.minimumVisibleTime,
                    DEFAULT_OPTIONS.minimumVisibleTime,
                    0,
                    60000
                ),
                showDelay: finiteNumber(
                    options.showDelay,
                    DEFAULT_OPTIONS.showDelay,
                    0,
                    60000
                ),
                startupTask: parseBoolean(
                    options.startupTask,
                    DEFAULT_OPTIONS.startupTask
                ),
                startupHoldAfterReady: finiteNumber(
                    options.startupHoldAfterReady,
                    DEFAULT_OPTIONS.startupHoldAfterReady,
                    0,
                    60000
                ),
                startupSimulationDuration: finiteNumber(
                    options.startupSimulationDuration,
                    DEFAULT_OPTIONS.startupSimulationDuration,
                    1000,
                    120000
                ),
                bannerLeadTime: finiteNumber(
                    options.bannerLeadTime,
                    DEFAULT_OPTIONS.bannerLeadTime,
                    0,
                    10000
                ),
                terminalRevealDelay: finiteNumber(
                    options.terminalRevealDelay,
                    DEFAULT_OPTIONS.terminalRevealDelay,
                    0,
                    10000
                ),
                revealDelay: finiteNumber(
                    options.revealDelay,
                    DEFAULT_OPTIONS.revealDelay,
                    0,
                    10000
                ),
                revealStep: finiteNumber(
                    options.revealStep,
                    DEFAULT_OPTIONS.revealStep,
                    0,
                    10000
                ),
                animationCreatureCount: finiteNumber(
                    options.animationCreatureCount,
                    DEFAULT_OPTIONS.animationCreatureCount,
                    1,
                    64
                ),
                injectStyles: parseBoolean(
                    options.injectStyles,
                    DEFAULT_OPTIONS.injectStyles
                ),
                useOutlineRing: parseBoolean(
                    options.useOutlineRing,
                    DEFAULT_OPTIONS.useOutlineRing
                ),
                reducedMotion:
                    parseBoolean(options.reducedMotion, false) ||
                    prefersReducedMotion()
            };

            this.tasks = new Map();
            this.overlay = null;
            this.animation = null;
            this.elements = {};
            this.visible = false;
            this.ready = !this.options.startupTask;
            this.destroyed = false;
            this.updating = false;
            this.syncingState = false;
            this.serviceRegistered = false;
            this.watchers = new Set();
            this.activeEmits = new Set();
            this.showTimer = 0;
            this.hideTimer = 0;
            this.collapseTimer = 0;
            this.startupReadyTimer = 0;
            this.startupSequenceTimer = 0;
            this.bannerTimer = 0;
            this.terminalRevealTimer = 0;
            this.shownAt = 0;
            this.visibilityGeneration = 0;
            this.revealTimers = [];
            this.startupListeners = [];
            this.startupTaskID = "terminal:startup";
            this.startupPhase = "idle";
            this.startupCompleted = false;
            this.startupReadyDetail = null;
            this.lastStatusText = null;
            this.lastStatusKind = null;

            const configuredAssetRoot = String(
                this.options.assetRoot || DEFAULT_ASSET_ROOT
            );

            this.assetRoot = configuredAssetRoot.endsWith("/")
                ? configuredAssetRoot
                : `${configuredAssetRoot}/`;

            if (this.options.injectStyles) {
                injectLoadingStyles();
            }

            this.context.root[LOADING_SYMBOL] = this;
            this.context.loading = this;

            this.mount();
            this.bindStartupLifecycle();
        }

        emit(type, detail = {}) {
            if (this.destroyed && type !== "destroy") {
                return false;
            }

            const eventType = String(type || "").trim();

            if (!eventType || this.activeEmits.has(eventType)) {
                return false;
            }

            const payload = safeClone(detail);
            this.activeEmits.add(eventType);

            try {
                dispatch(this, eventType, payload);

                for (const watcher of [...this.watchers]) {
                    try {
                        watcher({
                            type: eventType,
                            timestamp: nowISO(),
                            detail: safeClone(payload)
                        }, this);
                    } catch (_error) {
                        /* Watcher failures are isolated. */
                    }
                }

                try {
                    this.context.events?.emit?.(
                        `loading:${eventType}`,
                        payload
                    );
                } catch (_error) {
                    /* External event failures are isolated. */
                }

                dispatch(
                    document,
                    `speciedex:terminal-loading-${eventType}`,
                    payload
                );

                return true;
            } finally {
                this.activeEmits.delete(eventType);
            }
        }

        watch(callback, options = {}) {
            if (typeof callback !== "function") {
                throw new TypeError("Loading watcher must be a function.");
            }

            this.watchers.add(callback);

            if (options.immediate === true) {
                callback({
                    type: "initial",
                    timestamp: nowISO(),
                    status: this.status()
                }, this);
            }

            return () => this.watchers.delete(callback);
        }

        findAsciiBanner() {
            const selectors = [
                "[data-terminal-ascii-banner]",
                "[data-ascii-banner]",
                ".terminal-ascii-banner",
                ".terminal-banner-ascii",
                ".terminal-welcome-banner",
                "pre.terminal-banner"
            ];

            for (const selector of selectors) {
                const element = this.context.root?.querySelector?.(selector);

                if (element) {
                    return element;
                }
            }

            return null;
        }

        resolveAnimationAPI() {
            const service =
                this.context.animation ||
                this.context.services?.get?.("animation");

            if (service && typeof service.create === "function") {
                return {
                    mount: (target, options) => service.create(target, options)
                };
            }

            if (service && typeof service.mount === "function") {
                return service;
            }

            return window.SpeciedexTerminalAnimation || null;
        }

        mountAnimation() {
            const target = this.elements.animationHost;
            const api = this.resolveAnimationAPI();

            if (!target || !api || typeof api.mount !== "function") {
                throw new Error(
                    "terminal-animation.js must load before terminal-loading.js."
                );
            }

            this.animation?.destroy?.();

            this.animation = api.mount(target, {
                assetRoot: this.assetRoot,
                ring: this.options.useOutlineRing
                    ? this.options.ringOutline
                    : this.options.ring,
                layout: this.options.animationLayout,
                creatureSet: this.options.animationCreatureSet,
                creatureCount: this.options.animationCreatureCount,
                message: this.options.message,
                showRing: true,
                showDots: true,
                showMessage: true,
                showCreatureLabels: false,
                compact: false,
                reducedMotion: this.options.reducedMotion
            });

            return this.animation;
        }

        mount() {
            for (
                const existing of
                this.context.root?.querySelectorAll?.(
                    "[data-terminal-loading-overlay]"
                ) || []
            ) {
                existing.remove();
            }

            for (
                const orphan of
                this.context.root?.querySelectorAll?.(
                    ".terminal-loading-animal, " +
                    ".terminal-loading-animal-image, " +
                    ".terminal-loading-ring-wrap, " +
                    ".terminal-loading-ring, " +
                    ".terminal-loading-race"
                ) || []
            ) {
                orphan.remove();
            }

            const overlay = document.createElement("div");
            overlay.className =
                `${this.options.overlayClass} terminal-loading-inline ${this.options.hiddenClass}`;
            overlay.hidden = false;
            overlay.dataset.terminalLoadingOverlay = "";
            overlay.dataset.loadingState = "idle";
            overlay.setAttribute("role", "status");
            overlay.setAttribute("aria-live", "polite");
            overlay.setAttribute("aria-atomic", "true");
            overlay.setAttribute("aria-hidden", "true");

            const stage = document.createElement("div");
            stage.className = "terminal-loading-stage";
            stage.dataset.terminalLoadingStage = "";

            const animationHost = document.createElement("div");
            animationHost.className = "terminal-loading-animation-host";
            animationHost.dataset.terminalAnimationHost = "";

            const task = document.createElement("p");
            task.className = "terminal-loading-task";
            task.dataset.terminalLoadingTask = "";

            const progress = document.createElement("p");
            progress.className = "terminal-loading-progress-text";
            progress.dataset.terminalLoadingProgressText = "";

            stage.append(animationHost, task, progress);
            overlay.appendChild(stage);

            const host =
                this.context.elements?.output ||
                this.context.root?.querySelector?.("[data-terminal-output]") ||
                this.context.root;

            if (!host || typeof host.insertBefore !== "function") {
                throw new Error("Terminal loading output host is unavailable.");
            }

            const banner = this.findAsciiBanner();

            if (banner && host.contains(banner)) {
                banner.insertAdjacentElement("afterend", overlay);
            } else {
                host.insertBefore(overlay, host.firstChild || null);
            }

            this.overlay = overlay;
            this.elements = {
                stage,
                animationHost,
                task,
                progressText: progress
            };

            this.mountAnimation();
            return overlay;
        }

        clearRevealTimers() {
            for (const timer of this.revealTimers) {
                window.clearTimeout(timer);
            }

            this.revealTimers = [];
        }

        revealStage() {
            if (!this.overlay || this.destroyed) {
                return false;
            }

            this.clearRevealTimers();

            const children = [...this.elements.stage.children];

            for (const child of children) {
                child.classList.remove("is-revealed");
            }

            children.forEach((child, index) => {
                const timer = window.setTimeout(() => {
                    if (!this.destroyed && this.visible) {
                        child.classList.add("is-revealed");
                    }
                }, this.options.revealDelay + index * this.options.revealStep);

                this.revealTimers.push(timer);
            });

            return true;
        }

        bindStartupLifecycle() {
            if (!this.options.startupTask || this.destroyed) {
                return false;
            }

            if (!this.tasks.has(this.startupTaskID)) {
                this.begin(
                    this.startupTaskID,
                    this.options.startupLabel,
                    {
                        progress: null,
                        metadata: {
                            automatic: true,
                            phase: "startup"
                        }
                    }
                );
            }

            this.beginStartupSequence();

            const readyHandler = event => {
                if (
                    event.target !== this.context.root &&
                    event.target !== document
                ) {
                    return;
                }

                this.completeStartupAfterReady(event.detail || {});
            };

            const errorHandler = event => {
                if (
                    event.target !== this.context.root &&
                    event.target !== document
                ) {
                    return;
                }

                this.completeStartupAfterReady({
                    error:
                        event.detail?.error ||
                        "Terminal initialization completed with an error."
                });
            };

            for (const target of [this.context.root, document]) {
                if (!target?.addEventListener) {
                    continue;
                }

                target.addEventListener(
                    "speciedex:terminal-application-ready",
                    readyHandler
                );

                target.addEventListener(
                    "speciedex:terminal-application-error",
                    errorHandler
                );

                this.startupListeners.push(
                    {
                        target,
                        type: "speciedex:terminal-application-ready",
                        listener: readyHandler
                    },
                    {
                        target,
                        type: "speciedex:terminal-application-error",
                        listener: errorHandler
                    }
                );
            }

            if (this.context.root?.dataset?.terminalReady === "true") {
                this.completeStartupAfterReady({ alreadyReady: true });
            }

            return true;
        }

        beginStartupSequence() {
            if (this.destroyed || !this.options.startupTask) {
                return false;
            }

            this.startupPhase = "loading";
            this.context.root.dataset.terminalLoadingPhase = "loading";

            window.clearTimeout(this.startupSequenceTimer);

            this.startupSequenceTimer = window.setTimeout(() => {
                if (this.destroyed || this.startupCompleted) {
                    return;
                }

                this.completeStartupSequence({
                    timeout: true,
                    fallback: true,
                    warning:
                        "Application readiness event was not received before the startup timeout."
                });
            }, this.options.startupSimulationDuration);

            return true;
        }

        completeStartupAfterReady(detail = {}) {
            if (
                this.destroyed ||
                this.startupCompleted ||
                !this.tasks.has(this.startupTaskID)
            ) {
                return false;
            }

            this.emit("startup-ready", {
                detail: safeClone(detail)
            });

            return this.completeStartupSequence({
                ...safeClone(detail),
                applicationReady: true
            });
        }

        completeStartupSequence(detail = {}) {
            if (
                this.destroyed ||
                this.startupCompleted ||
                !this.tasks.has(this.startupTaskID)
            ) {
                return false;
            }

            this.startupCompleted = true;
            this.ready = true;
            this.startupReadyDetail = safeClone(detail);

            window.clearTimeout(this.startupSequenceTimer);
            window.clearTimeout(this.startupReadyTimer);

            this.setProgress(
                this.startupTaskID,
                100,
                detail.error || detail.warning
                    ? "Terminal ready with initialization warnings"
                    : "Terminal ready"
            );

            this.startupReadyTimer = window.setTimeout(() => {
                if (this.destroyed) {
                    return;
                }

                this.end(this.startupTaskID, {
                    startup: true,
                    ready: true,
                    detail: safeClone(this.startupReadyDetail)
                });

                this.startupPhase = "terminal";
                this.context.root.dataset.terminalLoadingPhase = "terminal";

                window.clearTimeout(this.terminalRevealTimer);
                this.terminalRevealTimer = window.setTimeout(() => {
                    this.emit("terminal-reveal", {
                        phase: this.startupPhase
                    });
                }, this.options.terminalRevealDelay);
            }, this.options.startupHoldAfterReady);

            return true;
        }

        begin(id, label = id, options = {}) {
            if (this.destroyed) {
                throw new Error(
                    "Cannot begin a loading task after the coordinator is destroyed."
                );
            }

            const taskID = normalizeID(id);

            if (this.tasks.has(taskID)) {
                this.end(taskID, { replaced: true });
            }

            const task = {
                id: taskID,
                label: normalizeLabel(label, taskID),
                startedAt: monotonicNow(),
                progress: parseProgress(options.progress),
                metadata: isObject(options.metadata)
                    ? safeClone(options.metadata)
                    : {},
                abortController: options.abortController || null
            };

            this.tasks.set(taskID, task);
            this.emit("task-begin", safeClone(task));
            this.emit("task-start", safeClone(task));
            this.update();
            return taskID;
        }

        setProgress(id, progress, label = null) {
            const taskID = normalizeID(id);
            const task = this.tasks.get(taskID);

            if (!task) {
                throw new Error(`Unknown loading task: ${taskID}`);
            }

            task.progress = parseProgress(progress);

            if (label !== null) {
                task.label = normalizeLabel(label, task.label);
            }

            this.update();
            return safeClone(task);
        }

        end(id, result = null) {
            const taskID = normalizeID(id);
            const task = this.tasks.get(taskID) || null;

            if (!task) {
                return null;
            }

            this.tasks.delete(taskID);

            const endedAt = monotonicNow();
            const completed = {
                ...safeClone(task),
                endedAt,
                elapsed: endedAt - task.startedAt,
                result: safeClone(result)
            };

            this.emit("task-end", completed);
            this.update();
            return completed;
        }

        fail(id, error) {
            const completed = this.end(id, null);

            if (!completed) {
                return null;
            }

            const failed = {
                ...completed,
                error: error instanceof Error
                    ? {
                        name: error.name,
                        message: error.message,
                        stack: error.stack || null
                    }
                    : {
                        name: "Error",
                        message: String(error)
                    }
            };

            this.emit("task-fail", failed);
            return failed;
        }

        cancel(id) {
            const taskID = normalizeID(id);
            const task = this.tasks.get(taskID);

            if (!task) {
                return false;
            }

            try {
                task.abortController?.abort?.();
            } catch (_error) {
                /* Continue cancellation. */
            }

            this.tasks.delete(taskID);
            this.emit("task-cancel", {
                ...safeClone(task),
                cancelledAt: monotonicNow()
            });
            this.update();
            return true;
        }

        clear() {
            const count = this.tasks.size;

            for (const task of this.tasks.values()) {
                try {
                    task.abortController?.abort?.();
                } catch (_error) {
                    /* Continue clearing tasks. */
                }
            }

            this.tasks.clear();
            this.emit("clear", { count });
            this.update();
            return count;
        }

        aggregateProgress() {
            const progress = [...this.tasks.values()]
                .map(task => task.progress)
                .filter(value => value !== null);

            if (!progress.length) {
                return null;
            }

            return progress.reduce((total, value) => total + value, 0) /
                progress.length;
        }

        show() {
            if (this.destroyed || this.visible || !this.overlay) {
                return false;
            }

            this.visibilityGeneration += 1;
            window.clearTimeout(this.hideTimer);
            window.clearTimeout(this.collapseTimer);

            this.visible = true;
            this.shownAt = monotonicNow();
            this.overlay.hidden = false;
            this.overlay.classList.remove(this.options.hiddenClass);
            this.overlay.dataset.loadingState = "active";
            this.overlay.setAttribute("aria-hidden", "false");
            this.animation?.show?.();
            this.revealStage();
            this.emit("show", this.status());
            return true;
        }

        async hide() {
            if (this.destroyed || !this.visible || !this.overlay) {
                return false;
            }

            const generation = ++this.visibilityGeneration;
            const remaining = Math.max(
                0,
                this.options.minimumVisibleTime -
                (monotonicNow() - this.shownAt)
            );

            if (remaining) {
                await wait(remaining);
            }

            if (
                this.destroyed ||
                this.tasks.size ||
                generation !== this.visibilityGeneration
            ) {
                return false;
            }

            this.visible = false;
            this.clearRevealTimers();
            this.animation?.hide?.();
            this.overlay.classList.add(this.options.hiddenClass);
            this.overlay.dataset.loadingState = "idle";
            this.overlay.setAttribute("aria-hidden", "true");

            window.clearTimeout(this.collapseTimer);
            this.collapseTimer = window.setTimeout(() => {
                if (
                    !this.destroyed &&
                    !this.visible &&
                    !this.tasks.size &&
                    this.overlay
                ) {
                    this.overlay.hidden = true;
                }
            }, this.options.reducedMotion ? 0 : 360);

            this.emit("hide", this.status());
            return true;
        }

        update() {
            if (this.destroyed || this.updating) {
                return false;
            }

            this.updating = true;

            try {
                const tasks = [...this.tasks.values()];
                const busy = tasks.length > 0;
                const activeTask = tasks[tasks.length - 1] || null;
                const progress = this.aggregateProgress();

                this.context.root?.classList?.toggle?.(
                    this.options.activeClass,
                    busy
                );

                if (busy) {
                    window.clearTimeout(this.showTimer);
                    this.showTimer = window.setTimeout(
                        () => this.show(),
                        this.visible ? 0 : this.options.showDelay
                    );
                } else {
                    window.clearTimeout(this.showTimer);
                    void this.hide();
                }

                this.animation?.setMessage?.(
                    this.options.message
                );

                this.animation?.setProgress?.(
                    progress
                );

                if (this.elements.task) {
                    this.elements.task.textContent = activeTask
                        ? activeTask.label
                        : "";
                }

                if (this.elements.progressText) {
                    this.elements.progressText.textContent =
                        progress === null
                            ? busy
                                ? `${tasks.length} active task${tasks.length === 1 ? "" : "s"}`
                                : ""
                            : `${Math.round(progress)}% complete`;
                }

                const nextStatusText = busy
                    ? `Loading (${tasks.length})`
                    : "Ready";

                const nextStatusKind = busy
                    ? "loading"
                    : "ready";

                if (
                    this.lastStatusText !== nextStatusText ||
                    this.lastStatusKind !== nextStatusKind
                ) {
                    this.lastStatusText = nextStatusText;
                    this.lastStatusKind = nextStatusKind;
                    this.context.setStatus?.(
                        nextStatusText,
                        nextStatusKind
                    );
                }

                const detail = {
                    busy,
                    taskCount: tasks.length,
                    progress,
                    activeTask: activeTask
                        ? safeClone(activeTask)
                        : null,
                    tasks: tasks.map(task => safeClone(task))
                };

                this.emit("change", detail);
                dispatch(
                    this.context.root,
                    "speciedex:terminal-loading-change",
                    detail,
                    { bubbles: true }
                );
                this.syncState();
            } finally {
                this.updating = false;
            }

            return true;
        }

        syncState() {
            if (this.syncingState || this.destroyed) {
                return false;
            }

            const state = this.context.state || this.context.stateStore;

            if (!state?.set) {
                return false;
            }

            this.syncingState = true;

            try {
                state.set(
                    "terminal.loading",
                    {
                        ready: this.ready,
                        busy: this.tasks.size > 0,
                        visible: this.visible,
                        tasks: this.tasks.size,
                        progress: this.aggregateProgress(),
                        updatedAt: nowISO()
                    },
                    {
                        source: "loading",
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

        status() {
            const tasks = [...this.tasks.values()];

            return {
                version: VERSION,
                ready: this.ready,
                busy: tasks.length > 0,
                visible: this.visible,
                progress: this.aggregateProgress(),
                taskCount: tasks.length,
                startup: {
                    enabled: this.options.startupTask,
                    taskID: this.startupTaskID,
                    active: this.tasks.has(this.startupTaskID),
                    completed: this.startupCompleted,
                    phase: this.startupPhase,
                    fallbackTimeout:
                        this.options.startupSimulationDuration,
                    holdAfterReady:
                        this.options.startupHoldAfterReady,
                    terminalRevealDelay:
                        this.options.terminalRevealDelay
                },
                animation: this.animation?.status?.() || null,
                tasks: tasks.map(task => ({
                    id: task.id,
                    label: task.label,
                    progress: task.progress,
                    elapsed: monotonicNow() - task.startedAt
                })),
                assets: {
                    root: this.assetRoot,
                    ring: joinAsset(
                        this.assetRoot,
                        this.options.useOutlineRing
                            ? this.options.ringOutline
                            : this.options.ring
                    ),
                    delegatedTo: "terminal-animation.js"
                },
                serviceRegistered: this.serviceRegistered,
                destroyed: this.destroyed
            };
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            for (const timer of [
                this.showTimer,
                this.hideTimer,
                this.collapseTimer,
                this.startupReadyTimer,
                this.startupSequenceTimer,
                this.bannerTimer,
                this.terminalRevealTimer
            ]) {
                window.clearTimeout(timer);
            }

            this.clearRevealTimers();

            for (const record of this.startupListeners) {
                try {
                    record.target?.removeEventListener(
                        record.type,
                        record.listener
                    );
                } catch (_error) {
                    /* Continue teardown. */
                }
            }

            this.startupListeners = [];

            for (const task of this.tasks.values()) {
                try {
                    task.abortController?.abort?.();
                } catch (_error) {
                    /* Continue teardown. */
                }
            }

            this.tasks.clear();
            this.animation?.destroy?.();
            this.animation = null;
            this.visible = false;
            this.ready = false;
            this.visibilityGeneration += 1;
            this.context.root?.classList?.remove?.(
                this.options.activeClass
            );

            if (this.overlay) {
                this.overlay.remove();
            }

            this.emit("destroy", { version: VERSION });
            this.watchers.clear();
            this.activeEmits.clear();

            if (this.context.root?.[LOADING_SYMBOL] === this) {
                delete this.context.root[LOADING_SYMBOL];
            }

            if (this.context.loading === this) {
                delete this.context.loading;
            }

            this.overlay = null;
            this.elements = {};
            this.destroyed = true;
            return true;
        }
    }

    function initialize(context = {}) {
        const safeContext = isObject(context) ? context : {};
        const root =
            safeContext.root &&
            typeof safeContext.root.querySelector === "function"
                ? safeContext.root
                : document.documentElement;

        const existing =
            safeContext.loading instanceof LoadingCoordinator
                ? safeContext.loading
                : safeContext.services?.get?.("loading") ||
                root?.[LOADING_SYMBOL];

        if (
            existing instanceof LoadingCoordinator &&
            !existing.destroyed
        ) {
            safeContext.loading = existing;
            return existing;
        }

        const dataset = root.dataset || {};
        const config = safeContext.config?.loading || {};

        const loading = new LoadingCoordinator(
            {
                ...safeContext,
                root
            },
            {
                minimumVisibleTime: finiteNumber(
                    dataset.terminalLoadingMinimumTime ??
                    config.minimumVisibleTime,
                    DEFAULT_OPTIONS.minimumVisibleTime,
                    0,
                    60000
                ),
                showDelay: finiteNumber(
                    dataset.terminalLoadingDelay ??
                    config.showDelay,
                    DEFAULT_OPTIONS.showDelay,
                    0,
                    60000
                ),
                startupTask: parseBoolean(
                    dataset.terminalLoadingStartup ??
                    config.startupTask,
                    DEFAULT_OPTIONS.startupTask
                ),
                startupHoldAfterReady: finiteNumber(
                    dataset.terminalLoadingStartupHold ??
                    config.startupHoldAfterReady,
                    DEFAULT_OPTIONS.startupHoldAfterReady,
                    0,
                    60000
                ),
                startupSimulationDuration: finiteNumber(
                    dataset.terminalLoadingStartupDuration ??
                    config.startupSimulationDuration,
                    DEFAULT_OPTIONS.startupSimulationDuration,
                    1000,
                    120000
                ),
                bannerLeadTime: finiteNumber(
                    dataset.terminalLoadingBannerLeadTime ??
                    config.bannerLeadTime,
                    DEFAULT_OPTIONS.bannerLeadTime,
                    0,
                    10000
                ),
                terminalRevealDelay: finiteNumber(
                    dataset.terminalLoadingTerminalRevealDelay ??
                    config.terminalRevealDelay,
                    DEFAULT_OPTIONS.terminalRevealDelay,
                    0,
                    10000
                ),
                startupLabel:
                    dataset.terminalLoadingStartupLabel ||
                    config.startupLabel ||
                    DEFAULT_OPTIONS.startupLabel,
                revealDelay: finiteNumber(
                    dataset.terminalLoadingRevealDelay ??
                    config.revealDelay,
                    DEFAULT_OPTIONS.revealDelay,
                    0,
                    10000
                ),
                revealStep: finiteNumber(
                    dataset.terminalLoadingRevealStep ??
                    config.revealStep,
                    DEFAULT_OPTIONS.revealStep,
                    0,
                    10000
                ),
                message:
                    dataset.terminalLoadingMessage ||
                    config.message ||
                    DEFAULT_OPTIONS.message,
                assetRoot:
                    dataset.terminalLoadingAssetRoot ||
                    config.assetRoot ||
                    DEFAULT_OPTIONS.assetRoot,
                ring:
                    dataset.terminalLoadingRing ||
                    config.ring ||
                    DEFAULT_OPTIONS.ring,
                ringOutline:
                    dataset.terminalLoadingRingOutline ||
                    config.ringOutline ||
                    DEFAULT_OPTIONS.ringOutline,
                useOutlineRing: parseBoolean(
                    dataset.terminalLoadingUseOutlineRing ??
                    config.useOutlineRing,
                    DEFAULT_OPTIONS.useOutlineRing
                ),
                animationLayout:
                    dataset.terminalLoadingAnimationLayout ||
                    config.animationLayout ||
                    config.layout ||
                    DEFAULT_OPTIONS.animationLayout,
                animationCreatureSet:
                    dataset.terminalLoadingCreatureSet ||
                    config.animationCreatureSet ||
                    config.creatureSet ||
                    DEFAULT_OPTIONS.animationCreatureSet,
                animationCreatureCount: finiteNumber(
                    dataset.terminalLoadingCreatureCount ??
                    config.animationCreatureCount ??
                    config.creatureCount,
                    DEFAULT_OPTIONS.animationCreatureCount,
                    1,
                    64
                ),
                injectStyles: parseBoolean(
                    dataset.terminalLoadingInjectStyles ??
                    config.injectStyles,
                    DEFAULT_OPTIONS.injectStyles
                ),
                reducedMotion: parseBoolean(
                    dataset.terminalLoadingReducedMotion ??
                    config.reducedMotion,
                    DEFAULT_OPTIONS.reducedMotion
                )
            }
        );

        root[LOADING_SYMBOL] = loading;
        safeContext.loading = loading;

        if (
            !loading.serviceRegistered &&
            typeof safeContext.registerService === "function"
        ) {
            loading.serviceRegistered = true;

            try {
                safeContext.registerService("loading", loading);
            } catch (error) {
                loading.serviceRegistered = false;
                throw error;
            }
        }

        loading.syncState();

        dispatch(document, "speciedex:terminal-loading-ready", {
            context: safeContext,
            loading,
            version: VERSION
        });

        return loading;
    }

    function resolveCommandContext(payload = {}) {
        return (
            payload.context ||
            payload.terminal?.context ||
            payload.app?.context ||
            payload
        );
    }

    function requireLoading(context = {}) {
        const safeContext = isObject(context) ? context : {};
        const loading =
            safeContext.loading instanceof LoadingCoordinator
                ? safeContext.loading
                : safeContext.services?.get?.("loading") ||
                initialize(safeContext);

        if (
            !(loading instanceof LoadingCoordinator) ||
            loading.destroyed
        ) {
            throw new Error(
                "Terminal loading coordinator is unavailable."
            );
        }

        return loading;
    }

    function writeResult(payload, value, type = "data") {
        if (
            typeof payload.writeJSON === "function" &&
            typeof value !== "string"
        ) {
            return payload.writeJSON(value);
        }

        if (typeof payload.write === "function") {
            return payload.write(
                typeof value === "string"
                    ? value
                    : JSON.stringify(safeClone(value), null, 2),
                type
            );
        }

        if (typeof payload.writeLine === "function") {
            return payload.writeLine(
                typeof value === "string"
                    ? value
                    : JSON.stringify(safeClone(value), null, 2)
            );
        }

        return value;
    }

    const commands = [
        {
            name: "loading",
            category: "system",
            description: "Display loading coordinator status.",
            usage: "loading",
            handler: payload => writeResult(
                payload,
                requireLoading(resolveCommandContext(payload)).status()
            )
        },
        {
            name: "loading-demo",
            category: "system",
            description: "Run the Speciedex loading animation.",
            usage: "loading-demo [seconds]",
            handler: async payload => {
                const loading = requireLoading(
                    resolveCommandContext(payload)
                );
                const args = Array.isArray(payload.args)
                    ? payload.args
                    : [];
                const seconds = clamp(Number(args[0]) || 5, 1, 60);
                const id = `demo:${Date.now()}`;

                loading.begin(
                    id,
                    "Demonstrating Speciedex loading animation",
                    { progress: 0 }
                );

                const started = monotonicNow();

                while (monotonicNow() - started < seconds * 1000) {
                    const elapsed = monotonicNow() - started;
                    loading.setProgress(
                        id,
                        clamp(
                            elapsed / (seconds * 1000) * 100,
                            0,
                            100
                        )
                    );
                    await wait(80);
                }

                loading.setProgress(id, 100);
                await wait(180);
                loading.end(id);

                return writeResult(
                    payload,
                    "Loading demonstration complete.",
                    "success"
                );
            }
        },
        {
            name: "loading-begin",
            category: "system",
            description: "Begin a named loading task.",
            usage: "loading-begin <id> [label]",
            handler: payload => {
                const args = Array.isArray(payload.args)
                    ? [...payload.args]
                    : [];
                const id = args.shift();

                if (!id) {
                    throw new Error("A loading task ID is required.");
                }

                requireLoading(resolveCommandContext(payload)).begin(
                    id,
                    args.join(" ") || id
                );

                return writeResult(
                    payload,
                    `Loading task started: ${id}`,
                    "success"
                );
            }
        },
        {
            name: "loading-progress",
            category: "system",
            description: "Set progress for a named loading task.",
            usage: "loading-progress <id> <0-100> [label]",
            handler: payload => {
                const args = Array.isArray(payload.args)
                    ? [...payload.args]
                    : [];
                const id = args.shift();
                const progress = args.shift();

                if (!id || progress === undefined) {
                    throw new Error(
                        "Usage: loading-progress <id> <0-100> [label]"
                    );
                }

                const parsed = parseProgress(progress);

                if (parsed === null) {
                    throw new Error(`Invalid loading progress: ${progress}`);
                }

                requireLoading(resolveCommandContext(payload)).setProgress(
                    id,
                    parsed,
                    args.join(" ") || null
                );

                return writeResult(
                    payload,
                    `Loading task ${id}: ${parsed}%`,
                    "success"
                );
            }
        },
        {
            name: "loading-end",
            category: "system",
            description: "Complete a named loading task.",
            usage: "loading-end <id>",
            handler: payload => {
                const id = payload.args?.[0];

                if (!id) {
                    throw new Error("A loading task ID is required.");
                }

                if (!requireLoading(
                    resolveCommandContext(payload)
                ).end(id)) {
                    throw new Error(`Unknown loading task: ${id}`);
                }

                return writeResult(
                    payload,
                    `Loading task completed: ${id}`,
                    "success"
                );
            }
        },
        {
            name: "loading-cancel",
            category: "system",
            description: "Cancel a named loading task.",
            usage: "loading-cancel <id>",
            handler: payload => {
                const id = payload.args?.[0];

                if (!id) {
                    throw new Error("A loading task ID is required.");
                }

                if (!requireLoading(
                    resolveCommandContext(payload)
                ).cancel(id)) {
                    throw new Error(`Unknown loading task: ${id}`);
                }

                return writeResult(
                    payload,
                    `Loading task cancelled: ${id}`,
                    "warning"
                );
            }
        },
        {
            name: "loading-clear",
            category: "system",
            description: "Cancel and clear every active loading task.",
            usage: "loading-clear",
            handler: payload => {
                const count = requireLoading(
                    resolveCommandContext(payload)
                ).clear();

                return writeResult(
                    payload,
                    `Cleared ${count} loading task${count === 1 ? "" : "s"}.`,
                    "success"
                );
            }
        }
    ];

    const api = Object.freeze({
        name: MODULE_NAME,
        version: VERSION,
        PRIMARY_COLOR,
        DEFAULT_ASSET_ROOT,
        LOADING_SYMBOL,
        DEFAULT_OPTIONS,
        LoadingCoordinator,
        isObject,
        safeClone,
        nowISO,
        monotonicNow,
        dispatch,
        clamp,
        finiteNumber,
        parseBoolean,
        parseProgress,
        normalizeID,
        normalizeLabel,
        wait,
        prefersReducedMotion,
        joinAsset,
        injectLoadingStyles,
        resolveCommandContext,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalLoading = api;
    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    dispatch(document, "speciedex:terminal-module-available", {
        name: MODULE_NAME,
        module: api
    });
})(window, document);
