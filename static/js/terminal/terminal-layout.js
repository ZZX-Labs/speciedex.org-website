/*
========================================================================
Speciedex.org
Terminal Layout Controller
========================================================================

Layout and region-management service for SpeciedexTerminal.

Provides:

    • terminal layout modes
    • splash and console region visibility
    • split sizing
    • responsive layout selection
    • persisted layout preferences
    • fullscreen coordination
    • layout inspection
    • resize observation
    • terminal commands

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME =
        "Layout";

    const VERSION =
        "2.2.0";

    const CONTROLLER_SYMBOL =
        Symbol.for(
            "speciedex.terminal.layout.controller"
        );

    const STORAGE_PREFIX =
        "speciedex-terminal:layout:";

    const activeDispatches =
        new WeakMap();

    const MODES =
        Object.freeze([
            "standard",
            "compact",
            "wide",
            "split",
            "fullscreen",
            "console-only",
            "splash-only"
        ]);

    const DEFAULT_OPTIONS =
        Object.freeze({
            mode:
                "standard",

            splashRatio:
                0.42,

            minimumSplashRatio:
                0.15,

            maximumSplashRatio:
                0.8,

            persist:
                true,

            responsive:
                true,

            compactBreakpoint:
                720,

            wideBreakpoint:
                1280
        });

    /*
    ==========================================================================
    Utilities
    ==========================================================================
    */

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
            typeof value.querySelector ===
                "function"
        );
    }

    function dispatch(target, name, detail, options = {}) {
        if (
            !target ||
            typeof target.dispatchEvent !==
                "function" ||
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

    function clamp(
        value,
        minimum,
        maximum
    ) {
        const numeric =
            Number(value);

        const lower =
            Math.min(
                Number(minimum),
                Number(maximum)
            );

        const upper =
            Math.max(
                Number(minimum),
                Number(maximum)
            );

        if (
            !Number.isFinite(numeric) ||
            !Number.isFinite(lower) ||
            !Number.isFinite(upper)
        ) {
            return Number.isFinite(lower)
                ? lower
                : 0;
        }

        return Math.min(
            upper,
            Math.max(
                lower,
                numeric
            )
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

    function parseNumber(
        value,
        fallback
    ) {
        const parsed =
            Number(value);

        return Number.isFinite(
            parsed
        )
            ? parsed
            : fallback;
    }

    function normalizeMode(
        mode
    ) {
        return String(
            mode ?? ""
        )
            .normalize("NFKC")
            .trim()
            .toLowerCase();
    }

    function safeStorage() {
        try {
            const key =
                "__speciedex_layout_probe__";

            window.localStorage.setItem(
                key,
                key
            );

            window.localStorage.removeItem(
                key
            );

            return window.localStorage;
        } catch (error) {
            return null;
        }
    }

    /*
    ==========================================================================
    Layout Controller
    ==========================================================================
    */

    class LayoutController
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

            this.root =
                isElement(this.context.root)
                    ? this.context.root
                    : document.documentElement;

            const minimumSplashRatio =
                clamp(
                    parseNumber(
                        options.minimumSplashRatio,
                        DEFAULT_OPTIONS.minimumSplashRatio
                    ),
                    0,
                    0.95
                );

            const maximumSplashRatio =
                clamp(
                    parseNumber(
                        options.maximumSplashRatio,
                        DEFAULT_OPTIONS.maximumSplashRatio
                    ),
                    minimumSplashRatio,
                    1
                );

            this.options = {
                mode:
                    MODES.includes(
                        normalizeMode(
                            options.mode
                        )
                    )
                        ? normalizeMode(
                            options.mode
                        )
                        : DEFAULT_OPTIONS.mode,
                splashRatio:
                    parseNumber(
                        options.splashRatio,
                        DEFAULT_OPTIONS.splashRatio
                    ),
                minimumSplashRatio,
                maximumSplashRatio,
                persist:
                    parseBoolean(
                        options.persist,
                        DEFAULT_OPTIONS.persist
                    ),
                responsive:
                    parseBoolean(
                        options.responsive,
                        DEFAULT_OPTIONS.responsive
                    ),
                compactBreakpoint:
                    Math.max(
                        0,
                        parseNumber(
                            options.compactBreakpoint,
                            DEFAULT_OPTIONS.compactBreakpoint
                        )
                    ),
                wideBreakpoint:
                    Math.max(
                        0,
                        parseNumber(
                            options.wideBreakpoint,
                            DEFAULT_OPTIONS.wideBreakpoint
                        )
                    )
            };

            if (
                this.options.wideBreakpoint <
                this.options.compactBreakpoint
            ) {
                const temporary =
                    this.options.wideBreakpoint;

                this.options.wideBreakpoint =
                    this.options.compactBreakpoint;

                this.options.compactBreakpoint =
                    temporary;
            }

            this.storage =
                safeStorage();

            this.storageKey =
                `${STORAGE_PREFIX}${
                    this.root.dataset.terminalInstance ||
                    "default"
                }`;

            this.elements = {
                shell:
                    this.root.querySelector(
                        "[data-terminal-shell]"
                    ) ||
                    this.root,

                regions:
                    this.root.querySelector(
                        "[data-terminal-regions]"
                    ),

                splash:
                    this.root.querySelector(
                        "[data-terminal-splash]"
                    ),

                console:
                    this.root.querySelector(
                        "[data-terminal-console-region]"
                    ),

                screen:
                    this.root.querySelector(
                        "[data-terminal-screen]"
                    )
            };

            this.mode =
                "standard";

            this.requestedMode =
                "standard";

            this.responsiveMode =
                null;

            this.splashRatio =
                clamp(
                    parseNumber(
                        this.options.splashRatio,
                        DEFAULT_OPTIONS.splashRatio
                    ),
                    this.options.minimumSplashRatio,
                    this.options.maximumSplashRatio
                );

            this.previousMode =
                null;

            this.ready =
                true;

            this.destroyed =
                false;

            this.watchers =
                new Set();

            this.resizeObserver =
                null;

            this.resizeFrame =
                0;

            this.abortController =
                typeof AbortController ===
                    "function"
                    ? new AbortController()
                    : null;

            this.boundListeners =
                [];

            this.fullscreenFallback =
                false;

            this.boundResize =
                () =>
                    this.scheduleResize();

            this.boundFullscreenChange =
                () =>
                    this.handleFullscreenChange();

            this.restore();
            this.bind();
            this.apply({
                forceVisibility:
                    true
            });
        }

        emit(name, detail = {}) {
            if (
                this.destroyed &&
                name !== "destroy"
            ) {
                return false;
            }

            dispatch(
                this,
                name,
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
                            type: name,
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
                    `layout:${name}`,
                    detail
                );
            } catch (_error) {
                /* External event failures are isolated. */
            }

            dispatch(
                this.root,
                `speciedex:terminal-layout-${name}`,
                {
                    ...detail,
                    controller:
                        this
                },
                {
                    bubbles: true
                }
            );

            return true;
        }

        watch(callback, options = {}) {
            if (typeof callback !== "function") {
                throw new TypeError(
                    "Layout watcher must be a function."
                );
            }

            this.watchers.add(callback);

            if (options.immediate === true) {
                callback(
                    {
                        type: "initial",
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

        /*
        ======================================================================
        Persistence
        ======================================================================
        */

        restore() {
            if (
                !this.options.persist ||
                !this.storage
            ) {
                this.mode =
                    MODES.includes(
                        normalizeMode(
                            this.options.mode
                        )
                    )
                        ? normalizeMode(
                            this.options.mode
                        )
                        : "standard";

                this.requestedMode =
                    this.mode;

                return;
            }

            try {
                const stored =
                    JSON.parse(
                        this.storage.getItem(
                            this.storageKey
                        ) ||
                        "{}"
                    );

                this.mode =
                    MODES.includes(
                        normalizeMode(
                            stored.mode
                        )
                    )
                        ? normalizeMode(
                            stored.mode
                        )
                        : normalizeMode(
                            this.options.mode
                        ) ||
                        "standard";

                this.splashRatio =
                    clamp(
                        parseNumber(
                            stored.splashRatio,
                            this.splashRatio
                        ),
                        this.options.minimumSplashRatio,
                        this.options.maximumSplashRatio
                    );

                this.requestedMode =
                    this.mode;
            } catch (error) {
                this.mode =
                    MODES.includes(
                        normalizeMode(
                            this.options.mode
                        )
                    )
                        ? normalizeMode(
                            this.options.mode
                        )
                        : "standard";

                this.requestedMode =
                    this.mode;
            }
        }

        persist() {
            if (
                !this.options.persist ||
                !this.storage
            ) {
                return;
            }

            try {
                this.storage.setItem(
                    this.storageKey,
                    JSON.stringify({
                        mode:
                            this.requestedMode,

                        splashRatio:
                            this.splashRatio
                    })
                );
            } catch (error) {
                /*
                --------------------------------------------------------------
                Storage is optional. Layout behavior must continue without it.
                --------------------------------------------------------------
                */
            }
        }

        resetPersistence() {
            try {
                this.storage?.removeItem(
                    this.storageKey
                );
            } catch (error) {
                /*
                --------------------------------------------------------------
                Ignore unavailable storage.
                --------------------------------------------------------------
                */
            }
        }

        /*
        ======================================================================
        Binding
        ======================================================================
        */

        bind() {
            const signal =
                this.abortController?.signal ||
                null;

            const add =
                (
                    target,
                    name,
                    handler,
                    options = {}
                ) => {
                    if (
                        !target ||
                        typeof target.addEventListener !==
                            "function"
                    ) {
                        return;
                    }

                    const listenerOptions = {
                        ...options
                    };

                    if (signal) {
                        listenerOptions.signal =
                            signal;
                    }

                    try {
                        target.addEventListener(
                            name,
                            handler,
                            listenerOptions
                        );
                    } catch (_error) {
                        const capture =
                            options.capture === true;

                        target.addEventListener(
                            name,
                            handler,
                            capture
                        );

                        this.boundListeners.push(
                            () =>
                                target.removeEventListener(
                                    name,
                                    handler,
                                    capture
                                )
                        );
                    }
                };

            if (
                this.options.responsive &&
                typeof window.ResizeObserver ===
                    "function"
            ) {
                this.resizeObserver =
                    new window.ResizeObserver(
                        this.boundResize
                    );

                this.resizeObserver.observe(
                    this.root
                );
            } else if (
                this.options.responsive
            ) {
                add(
                    window,
                    "resize",
                    this.boundResize
                );
            }

            add(
                document,
                "fullscreenchange",
                this.boundFullscreenChange
            );

            add(
                document,
                "webkitfullscreenchange",
                this.boundFullscreenChange
            );
        }

        scheduleResize() {
            if (
                this.destroyed ||
                this.resizeFrame
            ) {
                return;
            }

            const requestFrame =
                typeof window.requestAnimationFrame ===
                    "function"
                    ? window.requestAnimationFrame.bind(
                        window
                    )
                    : callback =>
                        window.setTimeout(
                            callback,
                            16
                        );

            this.resizeFrame =
                requestFrame(
                    () => {
                        this.resizeFrame =
                            0;

                        this.handleResize();
                    }
                );
        }

        /*
        ======================================================================
        Mode Management
        ======================================================================
        */

        setMode(
            mode,
            options = {}
        ) {
            const normalized =
                normalizeMode(
                    mode
                );

            if (
                !MODES.includes(
                    normalized
                )
            ) {
                throw new Error(
                    `Unsupported layout mode: ${mode}`
                );
            }

            const responsive =
                parseBoolean(
                    options.responsive,
                    false
                );

            if (!responsive) {
                this.requestedMode =
                    normalized;

                this.responsiveMode =
                    null;
            } else {
                this.responsiveMode =
                    normalized;
            }

            const nextMode =
                responsive
                    ? normalized
                    : this.requestedMode;

            if (
                nextMode ===
                    this.mode &&
                !parseBoolean(
                    options.force,
                    false
                )
            ) {
                return this.mode;
            }

            const previous =
                this.mode;

            if (!responsive) {
                this.previousMode =
                    previous;
            }

            this.mode =
                nextMode;

            this.apply({
                forceVisibility:
                    parseBoolean(
                        options.forceVisibility,
                        false
                    ) ||
                    [
                        "console-only",
                        "splash-only"
                    ].includes(
                        this.mode
                    )
            });

            if (
                !responsive &&
                parseBoolean(
                    options.persist,
                    true
                )
            ) {
                this.persist();
            }

            const detail = {
                previous,
                mode:
                    this.mode,
                requestedMode:
                    this.requestedMode,
                responsiveMode:
                    this.responsiveMode
            };

            this.emit(
                "mode",
                detail
            );

            dispatch(
                this.root,
                "speciedex:terminal-layout",
                {
                    ...detail,
                    controller:
                        this
                },
                {
                    bubbles: true
                }
            );

            return this.mode;
        }

        restorePreviousMode() {
            const candidate =
                MODES.includes(
                    this.requestedMode
                ) &&
                this.requestedMode !==
                    "fullscreen"
                    ? this.requestedMode
                    : MODES.includes(
                        this.previousMode
                    ) &&
                      this.previousMode !==
                        "fullscreen"
                        ? this.previousMode
                        : "standard";

            return this.setMode(
                candidate,
                {
                    persist:
                        false,
                    force:
                        true
                }
            );
        }

        /*
        ======================================================================
        Region Sizing
        ======================================================================
        */

        setSplashRatio(
            ratio,
            options = {}
        ) {
            const parsed =
                parseNumber(
                    ratio,
                    this.splashRatio
                );

            this.splashRatio =
                clamp(
                    parsed,
                    this.options.minimumSplashRatio,
                    this.options.maximumSplashRatio
                );

            this.applySplit();

            if (
                options.persist !==
                false
            ) {
                this.persist();
            }

            this.emit(
                "ratio",
                {
                    splashRatio:
                        this.splashRatio,
                    consoleRatio:
                        1 -
                        this.splashRatio
                }
            );

            return this.splashRatio;
        }

        applySplit() {
            const regions =
                this.elements.regions;

            if (!regions) {
                return;
            }

            regions.style.setProperty(
                "--terminal-splash-ratio",
                String(
                    this.splashRatio
                )
            );

            regions.style.setProperty(
                "--terminal-console-ratio",
                String(
                    1 -
                    this.splashRatio
                )
            );

            regions.style.setProperty(
                "--terminal-splash-percent",
                `${(
                    this.splashRatio *
                    100
                ).toFixed(2)}%`
            );

            regions.style.setProperty(
                "--terminal-console-percent",
                `${(
                    (
                        1 -
                        this.splashRatio
                    ) *
                    100
                ).toFixed(2)}%`
            );
        }

        /*
        ======================================================================
        Region Visibility
        ======================================================================
        */

        setRegionVisibility(
            name,
            visible
        ) {
            const normalized =
                String(
                    name ||
                    ""
                ).toLowerCase();

            const element =
                normalized ===
                    "splash"
                    ? this.elements.splash
                    : normalized ===
                        "console"
                        ? this.elements.console
                        : normalized ===
                            "terminal"
                            ? this.elements.regions
                            : null;

            if (!element) {
                return false;
            }

            const nextVisible =
                parseBoolean(
                    visible,
                    false
                );

            element.hidden =
                !nextVisible;

            element.dataset.collapsed =
                nextVisible
                    ? "false"
                    : "true";

            element.setAttribute(
                "aria-hidden",
                String(
                    !nextVisible
                )
            );

            const selector =
                normalized ===
                    "terminal"
                    ? "[data-terminal-toggle-terminal]"
                    : normalized ===
                        "splash"
                        ? "[data-terminal-toggle-splash]"
                        : "[data-terminal-toggle-console]";

            const button =
                this.root.querySelector(
                    selector
                );

            button?.setAttribute(
                "aria-expanded",
                String(
                    nextVisible
                )
            );

            button?.classList.toggle(
                "is-collapsed",
                !nextVisible
            );

            this.root.classList.toggle(
                `terminal-${normalized}-collapsed`,
                !nextVisible
            );

            this.emit(
                "visibility",
                {
                    region:
                        normalized,
                    visible:
                        nextVisible
                }
            );

            return true;
        }

        applyVisibilityForMode(
            force = false
        ) {
            switch (
                this.mode
            ) {
                case "console-only":
                    this.setRegionVisibility(
                        "terminal",
                        true
                    );

                    this.setRegionVisibility(
                        "splash",
                        false
                    );

                    this.setRegionVisibility(
                        "console",
                        true
                    );

                    break;

                case "splash-only":
                    this.setRegionVisibility(
                        "terminal",
                        true
                    );

                    this.setRegionVisibility(
                        "splash",
                        true
                    );

                    this.setRegionVisibility(
                        "console",
                        false
                    );

                    break;

                default:
                    if (!force) {
                        break;
                    }

                    this.setRegionVisibility(
                        "terminal",
                        true
                    );

                    this.setRegionVisibility(
                        "splash",
                        true
                    );

                    this.setRegionVisibility(
                        "console",
                        true
                    );
            }
        }

        /*
        ======================================================================
        Apply Layout
        ======================================================================
        */

        apply(
            options = {}
        ) {
            this.root.dataset.terminalLayout =
                this.mode;

            if (this.elements.shell?.dataset) {
                this.elements.shell.dataset.terminalLayout =
                    this.mode;
            }

            this.root.dataset.terminalRequestedLayout =
                this.requestedMode;

            if (this.responsiveMode) {
                this.root.dataset.terminalResponsiveLayout =
                    this.responsiveMode;
            } else {
                delete this.root.dataset.terminalResponsiveLayout;
            }

            for (const mode of MODES) {
                this.root.classList.toggle(
                    `terminal-layout-${mode}`,
                    mode ===
                    this.mode
                );

                this.elements.shell?.classList?.toggle(
                    `terminal-layout-${mode}`,
                    mode ===
                    this.mode
                );
            }

            this.applyVisibilityForMode(
                parseBoolean(
                    options.forceVisibility,
                    false
                )
            );

            this.applySplit();

            if (
                this.mode ===
                "compact"
            ) {
                this.elements.screen?.setAttribute(
                    "data-terminal-density",
                    "compact"
                );
            } else {
                this.elements.screen?.removeAttribute(
                    "data-terminal-density"
                );
            }

            this.root.setAttribute(
                "aria-label",
                `SpeciedexTerminal ${this.mode} layout`
            );
        }

        /*
        ======================================================================
        Responsive Behavior
        ======================================================================
        */

        handleResize() {
            if (
                !this.options.responsive ||
                this.destroyed
            ) {
                return;
            }

            const width =
                this.root.getBoundingClientRect?.()
                    ?.width ||
                this.root.clientWidth ||
                window.innerWidth ||
                0;

            if (
                this.mode ===
                    "fullscreen" ||
                [
                    "console-only",
                    "splash-only"
                ].includes(
                    this.requestedMode
                )
            ) {
                return;
            }

            let suggested =
                null;

            if (
                width <=
                this.options.compactBreakpoint
            ) {
                suggested =
                    "compact";
            } else if (
                width >=
                this.options.wideBreakpoint
            ) {
                suggested =
                    "wide";
            } else {
                suggested =
                    this.requestedMode;
            }

            if (
                suggested !==
                    this.mode
            ) {
                this.setMode(
                    suggested,
                    {
                        responsive:
                            suggested !==
                            this.requestedMode,
                        persist:
                            false,
                        forceVisibility:
                            false
                    }
                );
            }
        }

        /*
        ======================================================================
        Fullscreen Coordination
        ======================================================================
        */

        async enterFullscreen() {
            const shell =
                this.elements.shell;

            if (
                document.fullscreenElement ===
                    shell ||
                document.webkitFullscreenElement ===
                    shell
            ) {
                this.handleFullscreenChange();

                return true;
            }

            this.previousMode =
                this.requestedMode;

            try {
                const request =
                    shell.requestFullscreen ||
                    shell.webkitRequestFullscreen;

                if (!request) {
                    throw new Error(
                        "Fullscreen API is unavailable."
                    );
                }

                await Promise.resolve(
                    request.call(
                        shell
                    )
                );

                this.fullscreenFallback =
                    false;
            } catch (error) {
                this.fullscreenFallback =
                    true;

                shell.classList.add(
                    "terminal-fullscreen-fallback"
                );

                this.root.classList.add(
                    "is-fullscreen"
                );

                document.documentElement.classList.add(
                    "terminal-document-fullscreen"
                );

                document.body?.classList?.add(
                    "terminal-document-fullscreen"
                );
            }

            this.setMode(
                "fullscreen",
                {
                    persist:
                        false,
                    force:
                        true
                }
            );

            this.syncFullscreenButton();

            return !this.fullscreenFallback;
        }

        async exitFullscreen() {
            const shell =
                this.elements.shell;

            try {
                const active =
                    document.fullscreenElement ||
                    document.webkitFullscreenElement;

                if (active) {
                    const exit =
                        document.exitFullscreen ||
                        document.webkitExitFullscreen;

                    await Promise.resolve(
                        exit?.call(
                            document
                        )
                    );
                }
            } catch (error) {
                /*
                --------------------------------------------------------------
                CSS fallback cleanup still runs below.
                --------------------------------------------------------------
                */
            }

            this.fullscreenFallback =
                false;

            shell.classList.remove(
                "terminal-fullscreen-fallback"
            );

            this.root.classList.remove(
                "is-fullscreen"
            );

            document.documentElement.classList.remove(
                "terminal-document-fullscreen"
            );

            document.body?.classList?.remove(
                "terminal-document-fullscreen"
            );

            this.restorePreviousMode();
            this.syncFullscreenButton();

            return true;
        }

        async toggleFullscreen() {
            if (
                this.mode ===
                    "fullscreen" ||
                document.fullscreenElement ===
                    this.elements.shell ||
                document.webkitFullscreenElement ===
                    this.elements.shell ||
                this.fullscreenFallback
            ) {
                return this.exitFullscreen();
            }

            return this.enterFullscreen();
        }

        handleFullscreenChange() {
            if (
                this.destroyed
            ) {
                return;
            }

            const active =
                document.fullscreenElement ===
                    this.elements.shell ||
                document.webkitFullscreenElement ===
                    this.elements.shell;

            if (active) {
                this.fullscreenFallback =
                    false;

                if (
                    this.mode !==
                    "fullscreen"
                ) {
                    this.previousMode =
                        this.requestedMode;

                    this.mode =
                        "fullscreen";

                    this.apply({
                        forceVisibility:
                            false
                    });
                }
            } else if (
                this.mode ===
                    "fullscreen" &&
                !this.fullscreenFallback
            ) {
                this.restorePreviousMode();
            }

            this.syncFullscreenButton();
        }

        syncFullscreenButton() {
            const active =
                document.fullscreenElement ===
                    this.elements.shell ||
                document.webkitFullscreenElement ===
                    this.elements.shell ||
                this.fullscreenFallback;

            const button =
                this.root.querySelector(
                    '[data-terminal-action="fullscreen"], ' +
                    "[data-terminal-fullscreen]"
                );

            button?.setAttribute(
                "aria-pressed",
                String(
                    active
                )
            );

            return active;
        }

        /*
        ======================================================================
        Inspection
        ======================================================================
        */

        status() {
            return {
                version:
                    VERSION,

                ready:
                    this.ready,

                mode:
                    this.mode,

                requestedMode:
                    this.requestedMode,

                responsiveMode:
                    this.responsiveMode,

                previousMode:
                    this.previousMode,

                splashRatio:
                    this.splashRatio,

                consoleRatio:
                    1 -
                    this.splashRatio,

                responsive:
                    this.options.responsive,

                persist:
                    this.options.persist,

                regions: {
                    terminal:
                        this.elements.regions
                            ? !this.elements.regions.hidden
                            : null,

                    splash:
                        this.elements.splash
                            ? !this.elements.splash.hidden
                            : null,

                    console:
                        this.elements.console
                            ? !this.elements.console.hidden
                            : null
                },

                width:
                    this.root.getBoundingClientRect?.()
                        ?.width ||
                    this.root.clientWidth ||
                    0,

                fullscreen:
                    document.fullscreenElement ===
                        this.elements.shell ||
                    document.webkitFullscreenElement ===
                        this.elements.shell ||
                    this.fullscreenFallback,

                destroyed:
                    this.destroyed
            };
        }

        reset() {
            this.resetPersistence();

            this.splashRatio =
                clamp(
                    DEFAULT_OPTIONS.splashRatio,
                    this.options.minimumSplashRatio,
                    this.options.maximumSplashRatio
                );

            this.previousMode =
                null;

            this.requestedMode =
                "standard";

            this.responsiveMode =
                null;

            return this.setMode(
                "standard",
                {
                    persist:
                        false,

                    force:
                        true
                }
            );
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            this.resizeObserver?.disconnect?.();

            if (this.resizeFrame) {
                const cancelFrame =
                    typeof window.cancelAnimationFrame ===
                        "function"
                        ? window.cancelAnimationFrame.bind(
                            window
                        )
                        : window.clearTimeout.bind(
                            window
                        );

                cancelFrame(
                    this.resizeFrame
                );

                this.resizeFrame = 0;
            }

            try {
                this.abortController?.abort?.();
            } catch (_error) {
                /* Continue teardown. */
            }

            for (
                const dispose
                of this.boundListeners.splice(0)
            ) {
                try {
                    dispose();
                } catch (_error) {
                    /* Continue teardown. */
                }
            }

            if (this.fullscreenFallback) {
                this.elements.shell?.classList?.remove(
                    "terminal-fullscreen-fallback"
                );

                this.root.classList.remove(
                    "is-fullscreen"
                );

                document.documentElement.classList.remove(
                    "terminal-document-fullscreen"
                );

                document.body?.classList?.remove(
                    "terminal-document-fullscreen"
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
                this.root[
                    CONTROLLER_SYMBOL
                ] ===
                    this
            ) {
                delete this.root[
                    CONTROLLER_SYMBOL
                ];
            }

            this.ready =
                false;

            this.destroyed =
                true;

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
            isElement(safeContext.root)
                ? safeContext.root
                : document.documentElement;

        const existing =
            safeContext.layout instanceof
                LayoutController
                ? safeContext.layout
                : safeContext.services?.get?.(
                    "layout"
                ) ||
                root?.[CONTROLLER_SYMBOL];

        if (
            existing instanceof LayoutController &&
            !existing.destroyed
        ) {
            safeContext.layout =
                existing;

            safeContext.registerService?.(
                "layout",
                existing
            );

            return existing;
        }

        const dataset =
            root.dataset || {};

        const config =
            safeContext.config?.layout ||
            {};

        const controller =
            new LayoutController(
                {
                    ...safeContext,
                    root
                },
                {
                    mode:
                        dataset.terminalLayout ||
                        config.mode ||
                        DEFAULT_OPTIONS.mode,
                    splashRatio:
                        parseNumber(
                            dataset.terminalSplashRatio ??
                            config.splashRatio,
                            DEFAULT_OPTIONS.splashRatio
                        ),
                    minimumSplashRatio:
                        parseNumber(
                            dataset.terminalMinimumSplashRatio ??
                            config.minimumSplashRatio,
                            DEFAULT_OPTIONS.minimumSplashRatio
                        ),
                    maximumSplashRatio:
                        parseNumber(
                            dataset.terminalMaximumSplashRatio ??
                            config.maximumSplashRatio,
                            DEFAULT_OPTIONS.maximumSplashRatio
                        ),
                    persist:
                        parseBoolean(
                            dataset.terminalPersistLayout ??
                            config.persist,
                            DEFAULT_OPTIONS.persist
                        ),
                    responsive:
                        parseBoolean(
                            dataset.terminalResponsiveLayout ??
                            config.responsive,
                            DEFAULT_OPTIONS.responsive
                        ),
                    compactBreakpoint:
                        parseNumber(
                            dataset.terminalCompactBreakpoint ??
                            config.compactBreakpoint,
                            DEFAULT_OPTIONS.compactBreakpoint
                        ),
                    wideBreakpoint:
                        parseNumber(
                            dataset.terminalWideBreakpoint ??
                            config.wideBreakpoint,
                            DEFAULT_OPTIONS.wideBreakpoint
                        )
                }
            );

        root[CONTROLLER_SYMBOL] =
            controller;

        safeContext.layout =
            controller;

        safeContext.registerService?.(
            "layout",
            controller
        );

        if (
            typeof safeContext.toggleRegion !==
                "function"
        ) {
            safeContext.toggleRegion =
                region => {
                    const normalized =
                        String(region || "")
                            .toLowerCase();

                    const element =
                        normalized === "terminal"
                            ? controller.elements.regions
                            : normalized === "splash"
                                ? controller.elements.splash
                                : normalized === "console"
                                    ? controller.elements.console
                                    : null;

                    if (!element) {
                        return false;
                    }

                    return controller.setRegionVisibility(
                        normalized,
                        element.hidden
                    );
                };
        }

        dispatch(
            document,
            "speciedex:terminal-layout-ready",
            {
                context:
                    safeContext,
                layout:
                    controller,
                version:
                    VERSION
            }
        );

        return controller;
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

    function requireLayout(context) {
        const safeContext =
            isObject(context)
                ? context
                : {};

        const layout =
            safeContext.layout instanceof
                LayoutController
                ? safeContext.layout
                : safeContext.services?.get?.(
                    "layout"
                ) ||
                initialize(safeContext);

        if (
            !(layout instanceof LayoutController) ||
            layout.destroyed
        ) {
            throw new Error(
                "Terminal layout service is unavailable."
            );
        }

        return layout;
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
                name: "layout",
                category: "interface",
                description:
                    "Display or set the terminal layout mode.",
                usage:
                    "layout [standard|compact|wide|split|fullscreen|console-only|splash-only]",
                handler: async payload => {
                    const context =
                        resolveCommandContext(payload);

                    const args =
                        Array.isArray(payload.args)
                            ? payload.args
                            : [];

                    const layout =
                        requireLayout(context);

                    if (!args.length) {
                        return writeResult(
                            payload,
                            layout.status()
                        );
                    }

                    const mode =
                        normalizeMode(
                            args[0]
                        );

                    if (mode === "fullscreen") {
                        await layout.toggleFullscreen();
                    } else {
                        layout.setMode(mode);
                    }

                    return writeResult(
                        payload,
                        `Layout: ${layout.mode}`,
                        "success"
                    );
                }
            },

            {
                name: "layout-ratio",
                category: "interface",
                description:
                    "Set the terminal splash-to-console height ratio.",
                usage:
                    "layout-ratio <0.15-0.80|15%-80%>",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    const args =
                        Array.isArray(payload.args)
                            ? payload.args
                            : [];

                    const layout =
                        requireLayout(context);

                    if (!args[0]) {
                        return writeResult(
                            payload,
                            `Splash ratio: ${(layout.splashRatio * 100).toFixed(2)}%`
                        );
                    }

                    const raw =
                        String(args[0]).trim();

                    const value =
                        raw.endsWith("%")
                            ? Number(
                                raw.slice(0, -1)
                            ) / 100
                            : Number(raw);

                    if (!Number.isFinite(value)) {
                        throw new Error(
                            `Invalid splash ratio: ${raw}`
                        );
                    }

                    const ratio =
                        layout.setSplashRatio(
                            value
                        );

                    return writeResult(
                        payload,
                        `Splash ratio: ${(ratio * 100).toFixed(2)}%`,
                        "success"
                    );
                }
            },

            {
                name: "layout-toggle",
                category: "interface",
                description:
                    "Toggle a terminal region.",
                usage:
                    "layout-toggle <terminal|splash|console>",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    const args =
                        Array.isArray(payload.args)
                            ? payload.args
                            : [];

                    const region =
                        String(
                            args[0] || ""
                        ).toLowerCase();

                    if (
                        ![
                            "terminal",
                            "splash",
                            "console"
                        ].includes(region)
                    ) {
                        throw new Error(
                            "Use: layout-toggle terminal|splash|console"
                        );
                    }

                    const layout =
                        requireLayout(context);

                    const element =
                        region === "terminal"
                            ? layout.elements.regions
                            : region === "splash"
                                ? layout.elements.splash
                                : layout.elements.console;

                    if (!element) {
                        throw new Error(
                            `Terminal layout region is unavailable: ${region}`
                        );
                    }

                    const visible =
                        !element.hidden;

                    layout.setRegionVisibility(
                        region,
                        !visible
                    );

                    return writeResult(
                        payload,
                        `${!visible ? "Visible" : "Hidden"}: ${region}`,
                        "success"
                    );
                }
            },

            {
                name: "layout-status",
                category: "interface",
                description:
                    "Display current terminal layout state.",
                usage:
                    "layout-status",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    return writeResult(
                        payload,
                        requireLayout(
                            context
                        ).status()
                    );
                }
            },

            {
                name: "layout-reset",
                category: "interface",
                description:
                    "Reset terminal layout preferences.",
                usage:
                    "layout-reset",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    requireLayout(
                        context
                    ).reset();

                    return writeResult(
                        payload,
                        "Terminal layout reset.",
                        "success"
                    );
                }
            },

            {
                name: "layout-show",
                category: "interface",
                description:
                    "Show a terminal region.",
                usage:
                    "layout-show <terminal|splash|console>",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    const args =
                        Array.isArray(payload.args)
                            ? payload.args
                            : [];

                    const region =
                        String(
                            args[0] || ""
                        ).toLowerCase();

                    if (
                        ![
                            "terminal",
                            "splash",
                            "console"
                        ].includes(region)
                    ) {
                        throw new Error(
                            "Use: layout-show terminal|splash|console"
                        );
                    }

                    const changed =
                        requireLayout(
                            context
                        ).setRegionVisibility(
                            region,
                            true
                        );

                    if (!changed) {
                        throw new Error(
                            `Terminal layout region is unavailable: ${region}`
                        );
                    }

                    return writeResult(
                        payload,
                        `Visible: ${region}`,
                        "success"
                    );
                }
            },

            {
                name: "layout-hide",
                category: "interface",
                description:
                    "Hide a terminal region.",
                usage:
                    "layout-hide <terminal|splash|console>",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    const args =
                        Array.isArray(payload.args)
                            ? payload.args
                            : [];

                    const region =
                        String(
                            args[0] || ""
                        ).toLowerCase();

                    if (
                        ![
                            "terminal",
                            "splash",
                            "console"
                        ].includes(region)
                    ) {
                        throw new Error(
                            "Use: layout-hide terminal|splash|console"
                        );
                    }

                    const changed =
                        requireLayout(
                            context
                        ).setRegionVisibility(
                            region,
                            false
                        );

                    if (!changed) {
                        throw new Error(
                            `Terminal layout region is unavailable: ${region}`
                        );
                    }

                    return writeResult(
                        payload,
                        `Hidden: ${region}`,
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

            MODES,
            DEFAULT_OPTIONS,
            CONTROLLER_SYMBOL,
            LayoutController,

            normalizeMode,
            parseBoolean,
            parseNumber,
            dispatch,
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

    window.SpeciedexTerminalLayout =
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
