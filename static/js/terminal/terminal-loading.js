/*
========================================================================
Speciedex.org
Terminal Loading Coordinator
========================================================================

Animated loading coordinator for SpeciedexTerminal.

Visual sequence:

    loading-ring.gif
    tortoise.gif
    rabbit.gif
    cheetah.gif
    dolphin.gif
    animated HTML "Loading, please wait..." message

Canonical asset root:

    /static/images/terminal/loading/

Primary GIF assets:

    loading-ring.gif
    tortoise.gif
    rabbit.gif
    cheetah.gif
    dolphin.gif

Eight-frame PNG fallbacks:

    loading-ring/frame-01.png ... frame-08.png
    tortoise/frame-01.png     ... frame-08.png
    rabbit/frame-01.png       ... frame-08.png
    cheetah/frame-01.png      ... frame-08.png
    dolphin/frame-01.png      ... frame-08.png

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME =
        "Loading";

    const VERSION =
        "3.4.0";

    const PRIMARY_COLOR =
        "#c0d674";

    const DEFAULT_ASSET_ROOT =
        "/static/images/terminal/loading/";

    const LOADING_SYMBOL =
        Symbol.for(
            "speciedex.terminal.loading.coordinator"
        );

    const RESERVED_KEYS =
        new Set([
            "__proto__",
            "prototype",
            "constructor"
        ]);

    const activeDispatches =
        new WeakMap();

    const DEFAULT_OPTIONS =
        Object.freeze({
            minimumVisibleTime:
                2600,

            showDelay:
                80,

            startupTask:
                true,

            startupHoldAfterReady:
                5600,

            startupLabel:
                "Loading terminal modules, providers, datasets, and session state",

            revealDelay:
                180,

            revealStep:
                190,

            assetReadyTimeout:
                1800,

            frameInterval:
                120,

            progress:
                null,

            message:
                "Loading, please wait",

            assetRoot:
                DEFAULT_ASSET_ROOT,

            ring:
                "loading-ring.gif",

            ringOutline:
                "loading-ring-outline.gif",

            useOutlineRing:
                false,

            injectStyles:
                true,

            overlayClass:
                "terminal-loading-overlay",

            hiddenClass:
                "terminal-loading-hidden",

            activeClass:
                "terminal-is-loading",

            reducedMotion:
                false
        });

    const ANIMATIONS =
        Object.freeze([
            {
                name:
                    "loading-ring",

                label:
                    "Loading ring",

                gif:
                    "loading-ring.gif",

                frameRoot:
                    "loading-ring/",

                frameCount:
                    8,

                duration:
                    70,

                role:
                    "ring"
            },

            {
                name:
                    "tortoise",

                label:
                    "Tortoise",

                gif:
                    "tortoise.gif",

                frameRoot:
                    "tortoise/",

                frameCount:
                    8,

                duration:
                    190,

                role:
                    "animal"
            },

            {
                name:
                    "rabbit",

                label:
                    "Rabbit",

                gif:
                    "rabbit.gif",

                frameRoot:
                    "rabbit/",

                frameCount:
                    8,

                duration:
                    105,

                role:
                    "animal"
            },

            {
                name:
                    "cheetah",

                label:
                    "Cheetah",

                gif:
                    "cheetah.gif",

                frameRoot:
                    "cheetah/",

                frameCount:
                    8,

                duration:
                    80,

                role:
                    "animal"
            },

            {
                name:
                    "dolphin",

                label:
                    "Dolphin",

                gif:
                    "dolphin.gif",

                frameRoot:
                    "dolphin/",

                frameCount:
                    8,

                duration:
                    125,

                role:
                    "animal"
            }
        ]);

    const ANIMALS =
        Object.freeze(
            ANIMATIONS.filter(
                animation =>
                    animation.role ===
                    "animal"
            )
        );

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

    function monotonicNow() {
        return (
            typeof performance !== "undefined" &&
            typeof performance.now === "function"
        )
            ? monotonicNow()
            : Date.now();
    }

    function dispatch(target, name, detail, options = {}) {
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
            activeDispatches.set(
                target,
                names
            );
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

        if (value instanceof Error) {
            return {
                name: value.name,
                message: value.message,
                stack: value.stack || null
            };
        }

        if (value instanceof Date) {
            return nowISO(value);
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

    function frameNames(
        definition
    ) {
        return Array.from(
            {
                length:
                    definition.frameCount ||
                    8
            },
            (
                _,
                index
            ) =>
                `${definition.frameRoot}frame-${String(
                    index + 1
                ).padStart(
                    2,
                    "0"
                )}.png`
        );
    }

    /*
    ==========================================================================
    Utilities
    ==========================================================================
    */

    function normalizeID(value) {
        const id =
            String(
                value ?? ""
            ).trim();

        if (!id) {
            throw new Error(
                "Loading task ID is required."
            );
        }

        return id;
    }

    function normalizeLabel(
        value,
        fallback
    ) {
        const label =
            String(
                value ?? ""
            ).trim();

        return label ||
            fallback;
    }

    function clamp(
        value,
        minimum,
        maximum
    ) {
        return Math.min(
            maximum,
            Math.max(
                minimum,
                value
            )
        );
    }

    function parseProgress(value) {
        if (
            value === null ||
            value === undefined ||
            value === ""
        ) {
            return null;
        }

        const numeric =
            Number(value);

        if (!Number.isFinite(numeric)) {
            return null;
        }

        return clamp(
            numeric,
            0,
            100
        );
    }

    function parseBoolean(
        value,
        fallback = false
    ) {
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
            String(value)
                .trim()
                .toLowerCase();

        if (
            ["1", "true", "yes", "on", "enabled"].includes(
                normalized
            )
        ) {
            return true;
        }

        if (
            ["0", "false", "no", "off", "disabled"].includes(
                normalized
            )
        ) {
            return false;
        }

        return fallback;
    }

    function finiteNumber(
        value,
        fallback,
        minimum = -Infinity,
        maximum = Infinity
    ) {
        const numeric = Number(value);

        if (!Number.isFinite(numeric)) {
            return fallback;
        }

        return clamp(numeric, minimum, maximum);
    }

    function prefersReducedMotion() {
        return Boolean(
            window.matchMedia &&
            window.matchMedia(
                "(prefers-reduced-motion: reduce)"
            ).matches
        );
    }

    function joinAsset(
        root,
        path
    ) {
        const base =
            String(
                root ||
                DEFAULT_ASSET_ROOT
            );

        const asset =
            String(path || "");

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
            const normalizedRoot =
                base.endsWith("/")
                    ? base
                    : `${base}/`;

            return `${normalizedRoot}${asset.replace(/^\/+/, "")}`;
        }
    }

    function wait(milliseconds) {
        return new Promise(
            resolve =>
                window.setTimeout(
                    resolve,
                    milliseconds
                )
        );
    }

    /*
    ==========================================================================
    Styles
    ==========================================================================
    */

    function injectLoadingStyles() {
        if (
            document.getElementById(
                "speciedex-terminal-loading-styles"
            )
        ) {
            return;
        }

        const style =
            document.createElement(
                "style"
            );

        style.id =
            "speciedex-terminal-loading-styles";

        style.textContent = `
            .terminal-loading-overlay {
                --terminal-loading-color: ${PRIMARY_COLOR};
                --terminal-loading-bg: rgba(3, 8, 5, 0.965);
                position: absolute;
                inset: 0;
                z-index: 80;
                display: grid;
                place-items: center;
                min-height: 24rem;
                padding: 1.5rem;
                overflow: hidden;
                color: var(--terminal-loading-color);
                background:
                    radial-gradient(
                        circle at 50% 18%,
                        rgba(192, 214, 116, 0.09),
                        transparent 34%
                    ),
                    var(--terminal-loading-bg);
                opacity: 1;
                visibility: visible;
                transition:
                    opacity 180ms ease,
                    visibility 180ms ease;
            }

            .terminal-loading-overlay.terminal-loading-hidden {
                opacity: 0;
                visibility: hidden;
                pointer-events: none;
            }

            .terminal-loading-overlay.terminal-loading-inline {
                position: relative;
                inset: auto;
                z-index: 1;
                display: block;
                min-height: 0;
                width: 100%;
                margin: 0 0 1.25rem;
                padding: 1.25rem 0.75rem 1.5rem;
                overflow: visible;
                background:
                    radial-gradient(
                        circle at 50% 18%,
                        rgba(192, 214, 116, 0.08),
                        transparent 38%
                    );
                border-bottom: 1px solid rgba(192, 214, 116, 0.16);
            }

            .terminal-loading-inline .terminal-loading-stage {
                width: 100%;
                max-width: 72rem;
                margin: 0 auto;
            }

            .terminal-loading-inline .terminal-loading-ring-wrap {
                width: 7.5rem;
                height: 7.5rem;
            }

            .terminal-loading-inline .terminal-loading-race {
                grid-template-columns:
                    repeat(4, minmax(0, 1fr));
                align-items: end;
                width: 100%;
                max-width: 68rem;
                margin-inline: auto;
            }

            .terminal-loading-inline .terminal-loading-animal {
                margin: 0;
            }

            .terminal-loading-inline .terminal-loading-animal-image {
                width: min(100%, 12rem);
                height: 8.7rem;
            }

            .terminal-loading-stage {
                display: grid;
                width: min(100%, 72rem);
                justify-items: center;
                gap: 0.9rem;
                text-align: center;
                transform: translateZ(0);
                contain: layout paint;
            }

            .terminal-loading-stage > * {
                opacity: 0;
                transform: translateY(0.45rem);
                transition:
                    opacity 240ms ease,
                    transform 300ms cubic-bezier(0.2, 0.7, 0.2, 1);
                will-change: opacity, transform;
            }

            .terminal-loading-stage > *.is-revealed {
                opacity: 1;
                transform: translateY(0);
            }

            .terminal-loading-ring-wrap {
                position: relative;
                display: grid;
                width: 7.5rem;
                height: 7.5rem;
                place-items: center;
                overflow: hidden;
                isolation: isolate;
            }

            .terminal-loading-ring,
            .terminal-loading-ring-outline {
                position: absolute;
                inset: 0;
                width: 100%;
                height: 100%;
                object-fit: contain;
                image-rendering: pixelated;
                image-rendering: crisp-edges;
                pointer-events: none;
                user-select: none;
            }

            .terminal-loading-ring {
                filter:
                    drop-shadow(
                        0 0 0.34rem
                        rgba(192, 214, 116, 0.32)
                    );
                transform: translateZ(0);
                backface-visibility: hidden;
            }

            .terminal-loading-ring-outline {
                opacity: 0.68;
            }

            .terminal-loading-ring-wrap[data-asset-state="missing"]
            .terminal-loading-ring,
            .terminal-loading-ring-wrap[data-asset-state="missing"]
            .terminal-loading-ring-outline {
                opacity: 0;
            }

            .terminal-loading-ring-core {
                position: absolute;
                inset: 1.63rem;
                display: grid;
                place-items: center;
                border: 1px solid rgba(192, 214, 116, 0.22);
                border-radius: 50%;
                color: var(--terminal-loading-color);
                background: rgba(3, 8, 5, 0.78);
                font-size: 0.74rem;
                line-height: 1;
                letter-spacing: 0.04em;
            }

            .terminal-loading-ellipsis {
                display: inline-flex;
                min-height: 1.35rem;
                align-items: center;
                justify-content: center;
                gap: 0.7rem;
                margin: 0.1rem 0 0.4rem;
                color: var(--terminal-loading-color);
                font-size: 1.3rem;
                line-height: 1;
            }

            .terminal-loading-dot {
                width: 0.46rem;
                height: 0.46rem;
                border-radius: 50%;
                background: currentColor;
                opacity: 0.2;
                transform: scale(0.8);
                animation:
                    speciedex-terminal-loading-dot
                    1.5s ease-in-out infinite;
                box-shadow:
                    0 0 0.28rem
                    rgba(192, 214, 116, 0.22);
            }

            .terminal-loading-dot:nth-child(2) {
                animation-delay: 0.22s;
            }

            .terminal-loading-dot:nth-child(3) {
                animation-delay: 0.44s;
            }

            .terminal-loading-race {
                display: grid;
                grid-template-columns:
                    repeat(4, minmax(0, 1fr));
                width: min(100%, 68rem);
                align-items: end;
                gap: clamp(0.75rem, 2.4vw, 2rem);
                margin: 0.15rem auto 0.35rem;
            }

            .terminal-loading-animal {
                position: relative;
                display: grid;
                min-width: 0;
                height: 10rem;
                margin: 0;
                justify-items: center;
                align-items: end;
                gap: 0;
                overflow: hidden;
            }

            .terminal-loading-animal::after {
                content: "";
                display: block;
                position: absolute;
                left: 9%;
                right: 9%;
                bottom: 0.55rem;
                width: auto;
                height: 1px;
                background:
                    linear-gradient(
                        90deg,
                        transparent,
                        rgba(192, 214, 116, 0.4),
                        transparent
                    );
                box-shadow:
                    0 0 0.42rem
                    rgba(192, 214, 116, 0.15);
            }

            .terminal-loading-animal-image {
                position: absolute;
                left: 50%;
                bottom: 0.7rem;
                display: block;
                width: min(100%, 12rem);
                height: 8.7rem;
                object-fit: contain;
                object-position: center bottom;
                image-rendering: pixelated;
                image-rendering: crisp-edges;
                filter:
                    drop-shadow(
                        0 0 0.22rem
                        rgba(192, 214, 116, 0.10)
                    );
                transform:
                    translate3d(-50%, 0, 0);
                backface-visibility: hidden;
                user-select: none;
                pointer-events: none;
            }

            .terminal-loading-animal[data-asset-state="missing"]
            .terminal-loading-animal-image {
                opacity: 0;
            }

            .terminal-loading-animal-fallback {
                position: absolute;
                inset: auto 0 1.1rem;
                display: none;
                color: rgba(192, 214, 116, 0.72);
                font-size: 0.73rem;
                letter-spacing: 0.08em;
                text-transform: uppercase;
            }

            .terminal-loading-animal[data-asset-state="missing"]
            .terminal-loading-animal-fallback {
                display: block;
            }

            .terminal-loading-message {
                margin: 0.25rem 0 0;
                color: var(--terminal-loading-color);
                font-family:
                    "IBM Plex Mono",
                    ui-monospace,
                    SFMono-Regular,
                    Consolas,
                    monospace;
                font-size: clamp(0.88rem, 2.2vw, 1.15rem);
                letter-spacing: 0.05em;
                text-shadow:
                    0 0 0.28rem
                    rgba(192, 214, 116, 0.2);
            }

            .terminal-loading-message-dots {
                display: inline-block;
                width: 2.5em;
                text-align: left;
            }

            .terminal-loading-message-dots::after {
                content: "";
                animation:
                    speciedex-terminal-loading-text-dots
                    1.35s steps(4, end) infinite;
            }

            .terminal-loading-task {
                min-height: 1.2rem;
                margin: 0;
                color: rgba(216, 230, 219, 0.72);
                font-size: 0.74rem;
            }

            .terminal-loading-progress-text {
                min-height: 1.2rem;
                margin: 0;
                color: rgba(192, 214, 116, 0.7);
                font-size: 0.72rem;
            }


            @keyframes speciedex-terminal-loading-dot {
                0%,
                20%,
                100% {
                    opacity: 0.18;
                    transform: scale(0.72);
                }

                45% {
                    opacity: 1;
                    transform: scale(1);
                }
            }

            @keyframes speciedex-terminal-loading-text-dots {
                0% {
                    content: "";
                }

                25% {
                    content: ".";
                }

                50% {
                    content: "..";
                }

                75%,
                100% {
                    content: "...";
                }
            }

            @media (max-width: 760px) {
                .terminal-loading-overlay {
                    min-height: 34rem;
                }

                .terminal-loading-race {
                    grid-template-columns:
                        repeat(2, minmax(7rem, 1fr));
                    gap: 1.2rem;
                }

                .terminal-loading-animal-image {
                    height: 6.5rem;
                }
            }

            @media (prefers-reduced-motion: reduce) {
                .terminal-loading-dot,
                .terminal-loading-message-dots::after {
                    animation-duration: 3.5s;
                }

                .terminal-loading-ring,
                .terminal-loading-animal-image {
                    animation: none !important;
                }
            }
        `;

        (
            document.head ||
            document.documentElement
        ).appendChild(
            style
        );
    }

    /*
    ==========================================================================
    Loading Coordinator
    ==========================================================================
    */

    class LoadingCoordinator
        extends EventTarget {
        constructor(
            context,
            options = {}
        ) {
            super();

            this.context =
                isObject(context)
                    ? context
                    : {};

            this.context.root =
                this.context.root &&
                typeof this.context.root.querySelector ===
                    "function"
                    ? this.context.root
                    : document.documentElement;

            this.options = {
                ...DEFAULT_OPTIONS,
                ...options,
                minimumVisibleTime:
                    finiteNumber(
                        options.minimumVisibleTime,
                        DEFAULT_OPTIONS.minimumVisibleTime,
                        0,
                        60000
                    ),
                showDelay:
                    finiteNumber(
                        options.showDelay,
                        DEFAULT_OPTIONS.showDelay,
                        0,
                        60000
                    ),
                startupTask:
                    parseBoolean(
                        options.startupTask,
                        DEFAULT_OPTIONS.startupTask
                    ),
                startupHoldAfterReady:
                    finiteNumber(
                        options.startupHoldAfterReady,
                        DEFAULT_OPTIONS.startupHoldAfterReady,
                        0,
                        60000
                    ),
                revealDelay:
                    finiteNumber(
                        options.revealDelay,
                        DEFAULT_OPTIONS.revealDelay,
                        0,
                        10000
                    ),
                revealStep:
                    finiteNumber(
                        options.revealStep,
                        DEFAULT_OPTIONS.revealStep,
                        0,
                        10000
                    ),
                assetReadyTimeout:
                    finiteNumber(
                        options.assetReadyTimeout,
                        DEFAULT_OPTIONS.assetReadyTimeout,
                        0,
                        30000
                    ),
                frameInterval:
                    finiteNumber(
                        options.frameInterval,
                        DEFAULT_OPTIONS.frameInterval,
                        16,
                        60000
                    ),
                injectStyles:
                    parseBoolean(
                        options.injectStyles,
                        DEFAULT_OPTIONS.injectStyles
                    ),
                useOutlineRing:
                    parseBoolean(
                        options.useOutlineRing,
                        DEFAULT_OPTIONS.useOutlineRing
                    ),
                reducedMotion:
                    parseBoolean(
                        options.reducedMotion,
                        false
                    ) ||
                    prefersReducedMotion()
            };

            this.tasks =
                new Map();

            this.frameTimers =
                new Map();

            this.assets =
                new Map();

            this.overlay =
                null;

            this.elements =
                {};

            this.visible =
                false;

            this.showTimer =
                0;

            this.hideTimer =
                0;

            this.shownAt =
                0;

            this.visibilityGeneration =
                0;

            this.ready =
                true;

            this.destroyed =
                false;

            this.watchers =
                new Set();

            this.emitting =
                false;

            this.syncingState =
                false;

            this.startupTaskID =
                "terminal:startup";

            this.startupReadyTimer =
                0;

            this.startupListeners =
                [];

            this.revealTimers =
                [];

            this.assetsReady =
                false;

            this.assetReadyPromise =
                null;

            const configuredAssetRoot =
                String(
                    this.options.assetRoot ||
                    DEFAULT_ASSET_ROOT
                );

            this.assetRoot =
                configuredAssetRoot.endsWith("/")
                    ? configuredAssetRoot
                    : `${configuredAssetRoot}/`;

            if (
                this.options.injectStyles
            ) {
                injectLoadingStyles();
            }

            this.mount();

            this.assetReadyPromise =
                this.preloadAssets()
                    .finally(
                        () => {
                            this.assetsReady =
                                true;
                        }
                    );

            this.bindStartupLifecycle();
        }

        emit(type, detail = {}) {
            if (
                this.destroyed &&
                type !== "destroy"
            ) {
                return false;
            }

            if (this.emitting) {
                return false;
            }

            this.emitting = true;

            try {
                dispatch(
                    this,
                    type,
                    detail
                );

                for (
                    const watcher
                    of Array.from(
                        this.watchers
                    )
                ) {
                    try {
                        watcher(
                            {
                                type,
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

                try {
                    this.context.events?.emit?.(
                        `loading:${type}`,
                        detail
                    );
                } catch (_error) {
                    /* External event failures are isolated. */
                }

                dispatch(
                    document,
                    `speciedex:terminal-loading-${type}`,
                    detail
                );

                return true;
            } finally {
                this.emitting = false;
            }
        }

        watch(callback, options = {}) {
            if (typeof callback !== "function") {
                throw new TypeError(
                    "Loading watcher must be a function."
                );
            }

            this.watchers.add(callback);

            if (options.immediate === true) {
                callback(
                    {
                        type: "initial",
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

        syncState() {
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
                    "terminal.loading",
                    {
                        ready:
                            this.ready,
                        busy:
                            this.tasks.size > 0,
                        visible:
                            this.visible,
                        tasks:
                            this.tasks.size,
                        progress:
                            this.aggregateProgress(),
                        updatedAt:
                            nowISO()
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

        /*
        ======================================================================
        DOM Construction
        ======================================================================
        */

        mount() {
            const existing =
                this.context.root?.
                    querySelector?.(
                        "[data-terminal-loading-overlay]"
                    );

            if (existing) {
                this.overlay =
                    existing;

                this.overlay.classList.add(
                    "terminal-loading-inline"
                );

                this.bindExistingAssets();
                this.captureElements();

                return existing;
            }

            const overlay =
                document.createElement(
                    "section"
                );

            overlay.className =
                `${this.options.overlayClass} terminal-loading-inline ${this.options.hiddenClass}`;

            overlay.hidden =
                false;

            overlay.dataset.terminalLoadingOverlay =
                "";

            overlay.dataset.loadingState =
                "idle";

            overlay.setAttribute(
                "role",
                "status"
            );

            overlay.setAttribute(
                "aria-live",
                "polite"
            );

            overlay.setAttribute(
                "aria-atomic",
                "true"
            );

            const stage =
                document.createElement(
                    "div"
                );

            stage.className =
                "terminal-loading-stage";

            stage.dataset.terminalLoadingStage =
                "";

            const ringWrap =
                document.createElement(
                    "div"
                );

            ringWrap.className =
                "terminal-loading-ring-wrap";

            ringWrap.dataset.assetState =
                "loading";

            const ring =
                document.createElement(
                    "img"
                );

            ring.className =
                "terminal-loading-ring";

            ring.alt =
                "";

            ring.decoding =
                "async";

            ring.loading =
                "eager";

            ring.setAttribute(
                "aria-hidden",
                "true"
            );

            ring.dataset.terminalLoadingRing =
                "";

            ring.src =
                joinAsset(
                    this.assetRoot,
                    this.options.useOutlineRing
                        ? this.options.ringOutline
                        : this.options.ring
                );

            ring.addEventListener(
                "load",
                () => {
                    ringWrap.dataset.assetState =
                        "ready";
                }
            );

            ring.addEventListener(
                "error",
                () => {
                    this.activateFrameFallback(
                        ringWrap,
                        ring,
                        ANIMATIONS[0]
                    );
                },
                {
                    once:
                        true
                }
            );

            const ringCore =
                document.createElement(
                    "span"
                );

            ringCore.className =
                "terminal-loading-ring-core";

            ringCore.dataset.terminalLoadingRingValue =
                "";

            ringCore.textContent =
                "•••";

            ringWrap.append(
                ring,
                ringCore
            );

            const ellipsis =
                document.createElement(
                    "div"
                );

            ellipsis.className =
                "terminal-loading-ellipsis";

            ellipsis.dataset.terminalLoadingEllipsis =
                "";

            ellipsis.setAttribute(
                "aria-hidden",
                "true"
            );

            for (
                let index = 0;
                index < 3;
                index += 1
            ) {
                const dot =
                    document.createElement(
                        "span"
                    );

                dot.className =
                    "terminal-loading-dot";

                ellipsis.appendChild(
                    dot
                );
            }

            const race =
                document.createElement(
                    "div"
                );

            race.className =
                "terminal-loading-race";

            race.dataset.terminalLoadingRace =
                "";

            for (const animal of ANIMALS) {
                race.appendChild(
                    this.createAnimal(
                        animal
                    )
                );
            }

            const message =
                document.createElement(
                    "p"
                );

            message.className =
                "terminal-loading-message";

            message.dataset.terminalLoadingMessage =
                "";

            const messageText =
                document.createElement(
                    "span"
                );

            messageText.dataset.terminalLoadingMessageText =
                "";

            messageText.textContent =
                this.options.message;

            const messageDots =
                document.createElement(
                    "span"
                );

            messageDots.className =
                "terminal-loading-message-dots";

            messageDots.setAttribute(
                "aria-hidden",
                "true"
            );

            message.append(
                messageText,
                messageDots
            );

            const task =
                document.createElement(
                    "p"
                );

            task.className =
                "terminal-loading-task";

            task.dataset.terminalLoadingTask =
                "";

            const progress =
                document.createElement(
                    "p"
                );

            progress.className =
                "terminal-loading-progress-text";

            progress.dataset.terminalLoadingProgressText =
                "";

            stage.append(
                ringWrap,
                ellipsis,
                race,
                message,
                task,
                progress
            );

            overlay.appendChild(
                stage
            );

            const host =
                this.context.elements?.
                    output ||
                this.context.elements?.
                    body ||
                this.context.root;

            const safeHost =
                host &&
                typeof host.appendChild ===
                    "function"
                    ? host
                    : this.context.root;

            try {
                const computed =
                    window.getComputedStyle?.(
                        safeHost
                    );

                if (
                    computed?.position ===
                    "static"
                ) {
                    safeHost.style.position =
                        "relative";
                }
            } catch (_error) {
                /* Styling fallback is optional. */
            }

            safeHost.appendChild(
                overlay
            );

            this.overlay =
                overlay;

            this.captureElements();

            return overlay;
        }

        createAnimal(
            definition
        ) {
            const wrapper =
                document.createElement(
                    "figure"
                );

            wrapper.className =
                "terminal-loading-animal";

            wrapper.dataset.loadingAnimal =
                definition.name;

            wrapper.dataset.assetState =
                "loading";

            const image =
                document.createElement(
                    "img"
                );

            image.className =
                "terminal-loading-animal-image";

            image.alt =
                `${definition.label} running animation`;

            image.decoding =
                "async";

            image.loading =
                "eager";

            image.dataset.loadingAnimalImage =
                definition.name;

            image.src =
                joinAsset(
                    this.assetRoot,
                    definition.gif
                );

            image.addEventListener(
                "load",
                () => {
                    wrapper.dataset.assetState =
                        "ready";
                }
            );

            image.addEventListener(
                "error",
                () => {
                    this.activateFrameFallback(
                        wrapper,
                        image,
                        definition
                    );
                },
                {
                    once:
                        true
                }
            );

            const fallback =
                document.createElement(
                    "figcaption"
                );

            fallback.className =
                "terminal-loading-animal-fallback";

            fallback.textContent =
                definition.label;

            wrapper.append(
                image,
                fallback
            );

            return wrapper;
        }

        bindExistingAssets() {
            const ringWrap =
                this.overlay.querySelector(
                    ".terminal-loading-ring-wrap"
                );

            const ring =
                this.overlay.querySelector(
                    "[data-terminal-loading-ring]"
                );

            if (
                ringWrap &&
                ring
            ) {
                ring.addEventListener(
                    "load",
                    () => {
                        ringWrap.dataset.assetState =
                            "ready";
                    }
                );

                ring.addEventListener(
                    "error",
                    () => {
                        this.activateFrameFallback(
                            ringWrap,
                            ring,
                            ANIMATIONS[0]
                        );
                    },
                    {
                        once:
                            true
                    }
                );

                if (
                    ring.complete &&
                    ring.naturalWidth
                ) {
                    ringWrap.dataset.assetState =
                        "ready";
                }
            }

            for (const definition of ANIMALS) {
                const wrapper =
                    this.overlay.querySelector(
                        `[data-loading-animal="${definition.name}"]`
                    );

                const image =
                    this.overlay.querySelector(
                        `[data-loading-animal-image="${definition.name}"]`
                    );

                if (
                    !wrapper ||
                    !image
                ) {
                    continue;
                }

                image.addEventListener(
                    "load",
                    () => {
                        wrapper.dataset.assetState =
                            "ready";
                    }
                );

                image.addEventListener(
                    "error",
                    () => {
                        this.activateFrameFallback(
                            wrapper,
                            image,
                            definition
                        );
                    },
                    {
                        once:
                            true
                    }
                );

                if (
                    image.complete &&
                    image.naturalWidth
                ) {
                    wrapper.dataset.assetState =
                        "ready";
                }
            }
        }

        captureElements() {
            const find =
                selector =>
                    this.overlay.querySelector(
                        selector
                    );

            this.elements.ring =
                find(
                    "[data-terminal-loading-ring]"
                );

            this.elements.ringValue =
                find(
                    "[data-terminal-loading-ring-value]"
                );

            this.elements.message =
                find(
                    "[data-terminal-loading-message-text]"
                );

            this.elements.task =
                find(
                    "[data-terminal-loading-task]"
                );

            this.elements.progressText =
                find(
                    "[data-terminal-loading-progress-text]"
                );
        }

        /*
        ======================================================================
        Assets
        ======================================================================
        */

        async preloadImage(
            url
        ) {
            if (this.assets.has(url)) {
                return this.assets.get(url);
            }

            const promise =
                new Promise(
                    (resolve, reject) => {
                        if (
                            typeof Image !== "function"
                        ) {
                            reject(
                                new Error(
                                    "Image preloading is unavailable."
                                )
                            );
                            return;
                        }

                        const image =
                            new Image();

                        image.decoding =
                            "async";

                        let settled = false;

                        const finish =
                            (callback, value) => {
                                if (settled) {
                                    return;
                                }

                                settled = true;

                                window.clearTimeout(
                                    timeout
                                );

                                image.onload = null;
                                image.onerror = null;

                                callback(value);
                            };

                        const timeout =
                            window.setTimeout(
                                () =>
                                    finish(
                                        reject,
                                        new Error(
                                            `Timed out loading image: ${url}`
                                        )
                                    ),
                                Math.max(
                                    1000,
                                    this.options.assetReadyTimeout *
                                    2
                                )
                            );

                        image.onload =
                            () =>
                                finish(
                                    resolve,
                                    url
                                );

                        image.onerror =
                            () =>
                                finish(
                                    reject,
                                    new Error(
                                        `Unable to load image: ${url}`
                                    )
                                );

                        image.src = url;
                    }
                );

            this.assets.set(
                url,
                promise
            );

            return promise;
        }

        async preloadAssets() {
            const urls =
                [];

            for (const animation of ANIMATIONS) {
                urls.push(
                    joinAsset(
                        this.assetRoot,
                        animation.gif
                    )
                );

                for (
                    const frame of
                    frameNames(
                        animation
                    )
                ) {
                    urls.push(
                        joinAsset(
                            this.assetRoot,
                            frame
                        )
                    );
                }
            }

            if (
                this.options.ringOutline
            ) {
                urls.push(
                    joinAsset(
                        this.assetRoot,
                        this.options.ringOutline
                    )
                );
            }

            const uniqueURLs =
                [
                    ...new Set(
                        urls
                    )
                ];

            const results =
                await Promise.allSettled(
                    uniqueURLs.map(
                        url =>
                            this.preloadImage(
                                url
                            )
                    )
                );

            this.emit(
                "assets",
                {
                    loaded:
                        results.filter(
                            result =>
                                result.status ===
                                "fulfilled"
                        ).length,

                    failed:
                        results.filter(
                            result =>
                                result.status ===
                                "rejected"
                        ).length,

                    total:
                        results.length
                }
            );

            return results;
        }

        async activateFrameFallback(
            wrapper,
            image,
            definition
        ) {
            if (
                this.destroyed ||
                !wrapper ||
                !image ||
                !definition
            ) {
                return;
            }
            const frameURLs =
                frameNames(
                    definition
                ).map(
                    frame =>
                        joinAsset(
                            this.assetRoot,
                            frame
                        )
                );

            const results =
                await Promise.allSettled(
                    frameURLs.map(
                        url =>
                            this.preloadImage(
                                url
                            )
                    )
                );

            const available =
                results
                    .filter(
                        result =>
                            result.status ===
                            "fulfilled"
                    )
                    .map(
                        result =>
                            result.value
                    );

            if (!available.length) {
                wrapper.dataset.assetState =
                    "missing";

                return;
            }

            wrapper.dataset.assetState =
                "fallback";

            image.src =
                available[0];

            if (
                available.length <
                    2 ||
                this.options.reducedMotion
            ) {
                return;
            }

            const existingTimer =
                this.frameTimers.get(
                    definition.name
                );

            if (existingTimer) {
                window.clearInterval(
                    existingTimer
                );
            }

            let index =
                0;

            const timer =
                window.setInterval(
                    () => {
                        index =
                            (
                                index +
                                1
                            ) %
                            available.length;

                        image.src =
                            available[
                                index
                            ];
                    },
                    definition.duration ||
                    this.options.frameInterval
                );

            this.frameTimers.set(
                definition.name,
                timer
            );
        }

        clearRevealTimers() {
            for (const timer of this.revealTimers) {
                window.clearTimeout(
                    timer
                );
            }

            this.revealTimers =
                [];
        }

        async revealStage() {
            if (
                !this.overlay ||
                this.destroyed
            ) {
                return;
            }

            this.clearRevealTimers();

            const stage =
                this.overlay.querySelector(
                    "[data-terminal-loading-stage]"
                );

            if (!stage) {
                return;
            }

            const children =
                [
                    ...stage.children
                ];

            for (const child of children) {
                child.classList.remove(
                    "is-revealed"
                );
            }

            await Promise.race([
                this.assetReadyPromise ||
                    Promise.resolve(),
                wait(
                    this.options.assetReadyTimeout
                )
            ]);

            if (
                this.destroyed ||
                !this.visible
            ) {
                return;
            }

            children.forEach(
                (
                    child,
                    index
                ) => {
                    const timer =
                        window.setTimeout(
                            () => {
                                if (
                                    this.destroyed ||
                                    !this.visible
                                ) {
                                    return;
                                }

                                child.classList.add(
                                    "is-revealed"
                                );
                            },
                            this.options.revealDelay +
                            index *
                            this.options.revealStep
                        );

                    this.revealTimers.push(
                        timer
                    );
                }
            );
        }

        /*
        ======================================================================
        Startup Lifecycle
        ======================================================================
        */

        bindStartupLifecycle() {
            if (
                !this.options.startupTask ||
                this.destroyed
            ) {
                return;
            }

            if (
                !this.tasks.has(
                    this.startupTaskID
                )
            ) {
                this.begin(
                    this.startupTaskID,
                    this.options.startupLabel,
                    {
                        progress:
                            null,

                        metadata: {
                            automatic:
                                true,

                            phase:
                                "startup"
                        }
                    }
                );
            }

            const readyHandler =
                event => {
                    if (
                        event.target !==
                        this.context.root
                    ) {
                        return;
                    }

                    this.completeStartupAfterReady(
                        event.detail ||
                        {}
                    );
                };

            const errorHandler =
                event => {
                    if (
                        event.target !==
                        this.context.root
                    ) {
                        return;
                    }

                    this.completeStartupAfterReady(
                        {
                            error:
                                event.detail?.error ||
                                "Terminal initialization completed with an error."
                        }
                    );
                };

            this.context.root?.addEventListener(
                "speciedex:terminal-application-ready",
                readyHandler
            );

            this.context.root?.addEventListener(
                "speciedex:terminal-application-error",
                errorHandler
            );

            this.startupListeners.push(
                [
                    "speciedex:terminal-application-ready",
                    readyHandler
                ],
                [
                    "speciedex:terminal-application-error",
                    errorHandler
                ]
            );

            if (
                this.context.root?.dataset.
                    terminalReady ===
                    "true"
            ) {
                this.completeStartupAfterReady(
                    {
                        alreadyReady:
                            true
                    }
                );
            }
        }

        completeStartupAfterReady(
            detail = {}
        ) {
            if (
                this.destroyed ||
                !this.tasks.has(
                    this.startupTaskID
                )
            ) {
                return;
            }

            window.clearTimeout(
                this.startupReadyTimer
            );

            this.clearRevealTimers();

            this.setProgress(
                this.startupTaskID,
                100,
                detail.error
                    ? "Terminal ready with initialization warnings"
                    : "Terminal ready"
            );

            this.emit(
                "startup-ready",
                {
                    hold:
                        this.options.startupHoldAfterReady,

                    detail
                }
            );

            this.startupReadyTimer =
                window.setTimeout(
                    () => {
                        if (
                            this.destroyed
                        ) {
                            return;
                        }

                        this.end(
                            this.startupTaskID,
                            {
                                startup:
                                    true,

                                ready:
                                    true
                            }
                        );
                    },
                    this.options.startupHoldAfterReady
                );
        }

        /*
        ======================================================================
        Task Lifecycle
        ======================================================================
        */

        begin(
            id,
            label = id,
            options = {}
        ) {
            if (this.destroyed) {
                throw new Error(
                    "Cannot begin a loading task after the coordinator is destroyed."
                );
            }

            const taskID =
                normalizeID(
                    id
                );

            const now =
                monotonicNow();

            if (this.tasks.has(taskID)) {
                this.end(
                    taskID,
                    {
                        replaced: true
                    }
                );
            }

            const task = {
                id:
                    taskID,

                label:
                    normalizeLabel(
                        label,
                        taskID
                    ),

                startedAt:
                    now,

                progress:
                    parseProgress(
                        options.progress
                    ),

                metadata:
                    options.metadata &&
                    typeof options.metadata ===
                    "object"
                        ? safeClone(
                            options.metadata
                        )
                        : {},

                abortController:
                    options.abortController ||
                    null
            };

            this.tasks.set(
                taskID,
                task
            );

            this.emit(
                "task-begin",
                safeClone(task)
            );

            this.update();

            return taskID;
        }

        setProgress(
            id,
            progress,
            label = null
        ) {
            const taskID =
                normalizeID(
                    id
                );

            const task =
                this.tasks.get(
                    taskID
                );

            if (!task) {
                throw new Error(
                    `Unknown loading task: ${taskID}`
                );
            }

            task.progress =
                parseProgress(
                    progress
                );

            if (
                label !==
                null
            ) {
                task.label =
                    normalizeLabel(
                        label,
                        task.label
                    );
            }

            this.update();

            return safeClone(task);
        }

        end(
            id,
            result = null
        ) {
            const taskID =
                normalizeID(
                    id
                );

            const task =
                this.tasks.get(
                    taskID
                ) ||
                null;

            if (!task) {
                return null;
            }

            this.tasks.delete(
                taskID
            );

            const completed = {
                ...safeClone(task),

                endedAt:
                    monotonicNow(),

                elapsed:
                    monotonicNow() -
                    task.startedAt,

                result
            };

            this.emit(
                "task-end",
                completed
            );

            this.update();

            return completed;
        }

        fail(
            id,
            error
        ) {
            const completed =
                this.end(
                    id,
                    null
                );

            if (!completed) {
                return null;
            }

            const failed = {
                ...completed,

                error:
                    error instanceof Error
                        ? {
                            name:
                                error.name,

                            message:
                                error.message
                        }
                        : {
                            name:
                                "Error",

                            message:
                                String(error)
                        }
            };

            this.emit(
                "task-fail",
                failed
            );

            return failed;
        }

        cancel(
            id
        ) {
            const taskID =
                normalizeID(
                    id
                );

            const task =
                this.tasks.get(
                    taskID
                );

            if (!task) {
                return false;
            }

            try {
                task.abortController?.abort?.();
            } catch (_error) {
                /* Continue cancellation. */
            }

            this.tasks.delete(
                taskID
            );

            this.emit(
                "task-cancel",
                {
                    ...task,

                    cancelledAt:
                        monotonicNow()
                }
            );

            this.update();

            return true;
        }

        clear() {
            const count =
                this.tasks.size;

            for (
                const task
                of this.tasks.values()
            ) {
                try {
                    task.abortController?.abort?.();
                } catch (_error) {
                    /* Continue clearing tasks. */
                }
            }

            this.tasks.clear();

            this.emit(
                "clear",
                {
                    count
                }
            );

            this.update();

            return count;
        }

        /*
        ======================================================================
        Visibility
        ======================================================================
        */

        show() {
            if (
                this.destroyed ||
                this.visible ||
                !this.overlay
            ) {
                return;
            }

            this.visibilityGeneration += 1;

            window.clearTimeout(
                this.showTimer
            );

            window.clearTimeout(
                this.hideTimer
            );

            this.visible =
                true;

            this.shownAt =
                monotonicNow();

            this.overlay.classList.remove(
                this.options.hiddenClass
            );

            this.overlay.dataset.loadingState =
                "active";

            this.overlay.setAttribute(
                "aria-hidden",
                "false"
            );

            this.revealStage();

            this.emit(
                "show",
                this.status()
            );
        }

        async hide() {
            if (
                this.destroyed ||
                !this.visible ||
                !this.overlay
            ) {
                return;
            }

            const generation =
                ++this.visibilityGeneration;

            const elapsed =
                monotonicNow() -
                this.shownAt;

            const remaining =
                Math.max(
                    0,
                    this.options.minimumVisibleTime -
                    elapsed
                );

            if (remaining) {
                await wait(
                    remaining
                );
            }

            if (
                this.destroyed ||
                this.tasks.size ||
                generation !== this.visibilityGeneration
            ) {
                return;
            }

            this.visible =
                false;

            this.clearRevealTimers();

            this.overlay
                .querySelectorAll(
                    ".is-revealed"
                )
                .forEach(
                    element =>
                        element.classList.remove(
                            "is-revealed"
                        )
                );

            this.overlay.classList.add(
                this.options.hiddenClass
            );

            this.overlay.dataset.loadingState =
                "idle";

            this.overlay.setAttribute(
                "aria-hidden",
                "true"
            );

            this.emit(
                "hide",
                this.status()
            );
        }

        /*
        ======================================================================
        Rendering
        ======================================================================
        */

        aggregateProgress() {
            const progress =
                [
                    ...this.tasks.values()
                ]
                    .map(
                        task =>
                            task.progress
                    )
                    .filter(
                        value =>
                            value !==
                            null
                    );

            if (!progress.length) {
                return null;
            }

            return progress.reduce(
                (
                    total,
                    value
                ) =>
                    total +
                    value,
                0
            ) /
            progress.length;
        }

        updateRing(
            progress
        ) {
            if (
                !this.elements.ringValue
            ) {
                return;
            }

            if (progress === null) {
                this.elements.ringValue.textContent =
                    "•••";

                return;
            }

            const normalized =
                clamp(
                    progress,
                    0,
                    100
                );

            this.elements.ringValue.textContent =
                `${Math.round(normalized)}%`;
        }

        update() {
            const busy =
                this.tasks.size >
                0;

            this.context.root?.
                classList.toggle(
                    this.options.activeClass,
                    busy
                );

            if (busy) {
                window.clearTimeout(
                    this.showTimer
                );

                this.showTimer =
                    window.setTimeout(
                        () =>
                            this.show(),
                        this.visible
                            ? 0
                            : this.options.showDelay
                    );
            } else {
                window.clearTimeout(
                    this.showTimer
                );

                this.hide();
            }

            const tasks =
                [
                    ...this.tasks.values()
                ];

            const activeTask =
                tasks[
                    tasks.length -
                    1
                ] ||
                null;

            const progress =
                this.aggregateProgress();

            this.updateRing(
                progress
            );

            if (
                this.elements.message
            ) {
                this.elements.message.textContent =
                    this.options.message;
            }

            if (
                this.elements.task
            ) {
                this.elements.task.textContent =
                    activeTask
                        ? activeTask.label
                        : "";
            }

            if (
                this.elements.progressText
            ) {
                this.elements.progressText.textContent =
                    progress ===
                    null
                        ? busy
                            ? `${tasks.length} active task${
                                tasks.length ===
                                1
                                    ? ""
                                    : "s"
                            }`
                            : ""
                        : `${Math.round(progress)}% complete`;
            }

            if (busy) {
                this.context.setStatus?.(
                    `Loading (${this.tasks.size})`,
                    "loading"
                );
            }

            const detail = {
                busy,
                progress,
                activeTask:
                    activeTask
                        ? safeClone(activeTask)
                        : null,
                tasks:
                    tasks.map(
                        task =>
                            safeClone(task)
                    )
            };

            this.emit(
                "change",
                detail
            );

            dispatch(
                this.context.root,
                "speciedex:terminal-loading-change",
                detail,
                {
                    bubbles: true
                }
            );

            this.syncState();
        }

        /*
        ======================================================================
        Diagnostics
        ======================================================================
        */

        status() {
            const tasks =
                [
                    ...this.tasks.values()
                ];

            return {
                version:
                    VERSION,

                ready:
                    this.ready,

                busy:
                    tasks.length >
                    0,

                visible:
                    this.visible,

                progress:
                    this.aggregateProgress(),

                taskCount:
                    tasks.length,

                startup: {
                    enabled:
                        this.options.startupTask,

                    taskID:
                        this.startupTaskID,

                    active:
                        this.tasks.has(
                            this.startupTaskID
                        ),

                    holdAfterReady:
                        this.options.startupHoldAfterReady,

                    revealDelay:
                        this.options.revealDelay,

                    revealStep:
                        this.options.revealStep,

                    assetsReady:
                        this.assetsReady
                },

                tasks:
                    tasks.map(
                        task => ({
                            id:
                                task.id,

                            label:
                                task.label,

                            progress:
                                task.progress,

                            elapsed:
                                monotonicNow() -
                                task.startedAt
                        })
                    ),

                destroyed:
                    this.destroyed,

                assets: {
                    root:
                        this.assetRoot,

                    animations:
                        ANIMATIONS.map(
                            animation => ({
                                name:
                                    animation.name,

                                role:
                                    animation.role,

                                gif:
                                    joinAsset(
                                        this.assetRoot,
                                        animation.gif
                                    ),

                                frames:
                                    frameNames(
                                        animation
                                    ).map(
                                        frame =>
                                            joinAsset(
                                                this.assetRoot,
                                                frame
                                            )
                                    )
                            })
                        ),

                    ring:
                        joinAsset(
                            this.assetRoot,
                            this.options.useOutlineRing
                                ? this.options.ringOutline
                                : this.options.ring
                        )
                }
            };
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            window.clearTimeout(
                this.showTimer
            );

            window.clearTimeout(
                this.hideTimer
            );

            window.clearTimeout(
                this.startupReadyTimer
            );

            this.clearRevealTimers();

            for (
                const [type, listener]
                of this.startupListeners
            ) {
                try {
                    this.context.root?.removeEventListener(
                        type,
                        listener
                    );
                } catch (_error) {
                    /* Continue teardown. */
                }
            }

            this.startupListeners = [];

            for (
                const timer
                of this.frameTimers.values()
            ) {
                window.clearInterval(timer);
            }

            this.frameTimers.clear();

            for (
                const task
                of this.tasks.values()
            ) {
                try {
                    task.abortController?.abort?.();
                } catch (_error) {
                    /* Continue teardown. */
                }
            }

            this.tasks.clear();
            this.visible = false;
            this.visibilityGeneration += 1;

            this.context.root?.classList?.remove(
                this.options.activeClass
            );

            if (this.overlay) {
                this.overlay.classList.add(
                    this.options.hiddenClass
                );

                this.overlay.dataset.loadingState =
                    "idle";

                this.overlay.setAttribute(
                    "aria-hidden",
                    "true"
                );
            }

            this.emit(
                "destroy",
                {
                    version:
                        VERSION
                }
            );

            this.watchers.clear();

            if (
                this.context.root?.[
                    LOADING_SYMBOL
                ] ===
                    this
            ) {
                delete this.context.root[
                    LOADING_SYMBOL
                ];
            }

            if (this.context.loading === this) {
                delete this.context.loading;
            }

            this.overlay = null;
            this.elements = {};
            this.assets.clear();

            this.ready = false;
            this.destroyed = true;

            return true;
        }
    }

    /*
    ==========================================================================
    Initialization
    ==========================================================================
    */

    function initialize(
        context = {}
    ) {
        const safeContext =
            isObject(context)
                ? context
                : {};

        const root =
            safeContext.root &&
            typeof safeContext.root.querySelector ===
                "function"
                ? safeContext.root
                : document.documentElement;

        const existing =
            safeContext.loading instanceof
                LoadingCoordinator
                ? safeContext.loading
                : safeContext.services?.get?.(
                    "loading"
                ) ||
                root?.[LOADING_SYMBOL];

        if (
            existing instanceof LoadingCoordinator &&
            !existing.destroyed
        ) {
            safeContext.loading =
                existing;

            safeContext.registerService?.(
                "loading",
                existing
            );

            return existing;
        }

        const dataset =
            root.dataset || {};

        const config =
            safeContext.config?.loading ||
            {};

        const loading =
            new LoadingCoordinator(
                {
                    ...safeContext,
                    root
                },
                {
                    minimumVisibleTime:
                        finiteNumber(
                            dataset.terminalLoadingMinimumTime ??
                            config.minimumVisibleTime,
                            DEFAULT_OPTIONS.minimumVisibleTime,
                            0,
                            60000
                        ),
                    showDelay:
                        finiteNumber(
                            dataset.terminalLoadingDelay ??
                            config.showDelay,
                            DEFAULT_OPTIONS.showDelay,
                            0,
                            60000
                        ),
                    startupTask:
                        parseBoolean(
                            dataset.terminalLoadingStartup ??
                            config.startupTask,
                            DEFAULT_OPTIONS.startupTask
                        ),
                    startupHoldAfterReady:
                        finiteNumber(
                            dataset.terminalLoadingStartupHold ??
                            config.startupHoldAfterReady,
                            DEFAULT_OPTIONS.startupHoldAfterReady,
                            0,
                            60000
                        ),
                    startupLabel:
                        dataset.terminalLoadingStartupLabel ||
                        config.startupLabel ||
                        DEFAULT_OPTIONS.startupLabel,
                    revealDelay:
                        finiteNumber(
                            dataset.terminalLoadingRevealDelay ??
                            config.revealDelay,
                            DEFAULT_OPTIONS.revealDelay,
                            0,
                            10000
                        ),
                    revealStep:
                        finiteNumber(
                            dataset.terminalLoadingRevealStep ??
                            config.revealStep,
                            DEFAULT_OPTIONS.revealStep,
                            0,
                            10000
                        ),
                    assetReadyTimeout:
                        finiteNumber(
                            dataset.terminalLoadingAssetReadyTimeout ??
                            config.assetReadyTimeout,
                            DEFAULT_OPTIONS.assetReadyTimeout,
                            0,
                            30000
                        ),
                    frameInterval:
                        finiteNumber(
                            dataset.terminalLoadingFrameInterval ??
                            config.frameInterval,
                            DEFAULT_OPTIONS.frameInterval,
                            16,
                            60000
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
                    useOutlineRing:
                        parseBoolean(
                            dataset.terminalLoadingUseOutlineRing ??
                            config.useOutlineRing,
                            DEFAULT_OPTIONS.useOutlineRing
                        ),
                    injectStyles:
                        parseBoolean(
                            dataset.terminalLoadingInjectStyles ??
                            config.injectStyles,
                            DEFAULT_OPTIONS.injectStyles
                        ),
                    reducedMotion:
                        parseBoolean(
                            dataset.terminalLoadingReducedMotion ??
                            config.reducedMotion,
                            false
                        )
                }
            );

        root[LOADING_SYMBOL] =
            loading;

        safeContext.loading =
            loading;

        safeContext.registerService?.(
            "loading",
            loading
        );

        loading.syncState();

        dispatch(
            document,
            "speciedex:terminal-loading-ready",
            {
                context:
                    safeContext,
                loading,
                version:
                    VERSION
            }
        );

        return loading;
    }

    /*
    ==========================================================================
    Commands
    ==========================================================================
    */

    function resolveCommandContext(payload = {}) {
        return (
            payload.context ||
            payload.terminal?.context ||
            payload.app?.context ||
            payload
        );
    }

    function requireLoading(context) {
        const safeContext =
            isObject(context)
                ? context
                : {};

        const loading =
            safeContext.loading instanceof
                LoadingCoordinator
                ? safeContext.loading
                : safeContext.services?.get?.(
                    "loading"
                ) ||
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
            typeof payload.writeJSON ===
                "function" &&
            typeof value !== "string"
        ) {
            return payload.writeJSON(value);
        }

        if (typeof payload.write === "function") {
            return payload.write(
                typeof value === "string"
                    ? value
                    : JSON.stringify(
                        value,
                        null,
                        2
                    ),
                type
            );
        }

        if (typeof payload.writeLine === "function") {
            return payload.writeLine(
                typeof value === "string"
                    ? value
                    : JSON.stringify(
                        value,
                        null,
                        2
                    )
            );
        }

        return value;
    }

    const commands =
        [
            {
                name: "loading",
                category: "system",
                description:
                    "Display loading coordinator status.",
                usage: "loading",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    return writeResult(
                        payload,
                        requireLoading(
                            context
                        ).status()
                    );
                }
            },

            {
                name: "loading-demo",
                category: "system",
                description:
                    "Run the animated Speciedex loading demonstration.",
                usage:
                    "loading-demo [seconds]",
                handler: async payload => {
                    const context =
                        resolveCommandContext(payload);

                    const args =
                        Array.isArray(payload.args)
                            ? payload.args
                            : [];

                    const loading =
                        requireLoading(context);

                    const seconds =
                        clamp(
                            Number(args[0]) || 5,
                            1,
                            60
                        );

                    const id =
                        `demo:${Date.now()}`;

                    loading.begin(
                        id,
                        "Demonstrating Speciedex loading animation",
                        {
                            progress: 0
                        }
                    );

                    const started =
                        monotonicNow();

                    while (
                        monotonicNow() - started <
                        seconds * 1000
                    ) {
                        const elapsed =
                            monotonicNow() - started;

                        loading.setProgress(
                            id,
                            clamp(
                                (
                                    elapsed /
                                    (seconds * 1000)
                                ) * 100,
                                0,
                                100
                            )
                        );

                        await wait(80);
                    }

                    loading.setProgress(
                        id,
                        100
                    );

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
                description:
                    "Begin a named loading task.",
                usage:
                    "loading-begin <id> [label]",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    const args =
                        Array.isArray(payload.args)
                            ? [...payload.args]
                            : [];

                    const id =
                        args.shift();

                    if (!id) {
                        throw new Error(
                            "A loading task ID is required."
                        );
                    }

                    requireLoading(
                        context
                    ).begin(
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
                description:
                    "Set progress for a named loading task.",
                usage:
                    "loading-progress <id> <0-100> [label]",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    const args =
                        Array.isArray(payload.args)
                            ? [...payload.args]
                            : [];

                    const id =
                        args.shift();

                    const progress =
                        args.shift();

                    if (
                        !id ||
                        progress === undefined
                    ) {
                        throw new Error(
                            "Usage: loading-progress <id> <0-100> [label]"
                        );
                    }

                    const parsedProgress =
                        parseProgress(progress);

                    if (parsedProgress === null) {
                        throw new Error(
                            `Invalid loading progress: ${progress}`
                        );
                    }

                    requireLoading(
                        context
                    ).setProgress(
                        id,
                        parsedProgress,
                        args.join(" ") ||
                        null
                    );

                    return writeResult(
                        payload,
                        `Loading task ${id}: ${parsedProgress}%`,
                        "success"
                    );
                }
            },

            {
                name: "loading-end",
                category: "system",
                description:
                    "Complete a named loading task.",
                usage:
                    "loading-end <id>",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    const args =
                        Array.isArray(payload.args)
                            ? payload.args
                            : [];

                    const id =
                        args[0];

                    if (!id) {
                        throw new Error(
                            "A loading task ID is required."
                        );
                    }

                    if (
                        !requireLoading(
                            context
                        ).end(id)
                    ) {
                        throw new Error(
                            `Unknown loading task: ${id}`
                        );
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
                description:
                    "Cancel a named loading task.",
                usage:
                    "loading-cancel <id>",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    const args =
                        Array.isArray(payload.args)
                            ? payload.args
                            : [];

                    const id =
                        args[0];

                    if (!id) {
                        throw new Error(
                            "A loading task ID is required."
                        );
                    }

                    if (
                        !requireLoading(
                            context
                        ).cancel(id)
                    ) {
                        throw new Error(
                            `Unknown loading task: ${id}`
                        );
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
                description:
                    "Cancel and clear every active loading task.",
                usage:
                    "loading-clear",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    const count =
                        requireLoading(
                            context
                        ).clear();

                    return writeResult(
                        payload,
                        `Cleared ${count} loading task${count === 1 ? "" : "s"}.`,
                        "success"
                    );
                }
            }
        ];

    /*
    ==========================================================================
    Public Module API
    ==========================================================================
    */

    const api =
        Object.freeze({
            name:
                MODULE_NAME,

            version:
                VERSION,

            PRIMARY_COLOR,
            DEFAULT_ASSET_ROOT,
            LOADING_SYMBOL,
            DEFAULT_OPTIONS,
            ANIMATIONS,
            ANIMALS,
            frameNames,
            LoadingCoordinator,

            normalizeID,
            normalizeLabel,
            parseProgress,
            parseBoolean,
            finiteNumber,
            injectLoadingStyles,
            joinAsset,
            dispatch,
            safeClone,
            resolveCommandContext,

            initialize,
            mount:
                initialize,
            init:
                initialize,
            setup:
                initialize,

            commands
        });

    window.SpeciedexTerminalLoading =
        api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules ||
        {};

    window.SpeciedexTerminalModules[
        MODULE_NAME
    ] = api;

    dispatch(
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
