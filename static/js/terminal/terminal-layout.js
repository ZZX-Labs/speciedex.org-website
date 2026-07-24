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
        "2.1.0";

    const CONTROLLER_SYMBOL =
        Symbol.for(
            "speciedex.terminal.layout.controller"
        );

    const STORAGE_PREFIX =
        "speciedex-terminal:layout:";

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

    function parseBoolean(
        value,
        fallback = false
    ) {
        if (
            value === undefined ||
            value === null ||
            value === ""
        ) {
            return fallback;
        }

        return ![
            "false",
            "0",
            "no",
            "off"
        ].includes(
            String(value)
                .trim()
                .toLowerCase()
        );
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
                context;

            this.root =
                context.root;

            if (
                !this.root ||
                typeof this.root.querySelector !==
                    "function"
            ) {
                throw new TypeError(
                    "LayoutController requires a valid terminal root element."
                );
            }

            this.options = {
                ...DEFAULT_OPTIONS,
                ...options
            };

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

            this.destroyed =
                false;

            this.resizeObserver =
                null;

            this.resizeFrame =
                0;

            this.abortController =
                new AbortController();

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
                    normalizeMode(
                        this.options.mode
                    ) ||
                    "standard";

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
                    normalizeMode(
                        this.options.mode
                    ) ||
                    "standard";

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
                this.abortController.signal;

            if (
                this.options.responsive &&
                "ResizeObserver" in
                    window
            ) {
                this.resizeObserver =
                    new ResizeObserver(
                        this.boundResize
                    );

                this.resizeObserver.observe(
                    this.root
                );
            } else if (
                this.options.responsive
            ) {
                window.addEventListener(
                    "resize",
                    this.boundResize,
                    {
                        signal
                    }
                );
            }

            document.addEventListener(
                "fullscreenchange",
                this.boundFullscreenChange,
                {
                    signal
                }
            );

            document.addEventListener(
                "webkitfullscreenchange",
                this.boundFullscreenChange,
                {
                    signal
                }
            );
        }

        scheduleResize() {
            if (
                this.destroyed ||
                this.resizeFrame
            ) {
                return;
            }

            this.resizeFrame =
                window.requestAnimationFrame(
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
                options.responsive ===
                    true;

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
                options.force !==
                    true
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
                    options.forceVisibility ===
                    true ||
                    [
                        "console-only",
                        "splash-only"
                    ].includes(
                        this.mode
                    )
            });

            if (
                !responsive &&
                options.persist !==
                    false
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

            this.dispatchEvent(
                new CustomEvent(
                    "mode",
                    {
                        detail
                    }
                )
            );

            this.context.events?.emit?.(
                "layout:mode",
                detail
            );

            this.root.dispatchEvent(
                new CustomEvent(
                    "speciedex:terminal-layout",
                    {
                        bubbles:
                            true,
                        detail: {
                            ...detail,
                            controller:
                                this
                        }
                    }
                )
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

            this.dispatchEvent(
                new CustomEvent(
                    "ratio",
                    {
                        detail: {
                            splashRatio:
                                this.splashRatio,

                            consoleRatio:
                                1 -
                                this.splashRatio
                        }
                    }
                )
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
                Boolean(
                    visible
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

            this.elements.shell.dataset.terminalLayout =
                this.mode;

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

                this.elements.shell.classList.toggle(
                    `terminal-layout-${mode}`,
                    mode ===
                    this.mode
                );
            }

            this.applyVisibilityForMode(
                options.forceVisibility ===
                    true
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
                this.root.getBoundingClientRect()
                    .width;

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

                await request.call(
                    shell
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

                document.body.classList.add(
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

                    await exit?.call(
                        document
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

            document.body.classList.remove(
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
                    this.root.getBoundingClientRect()
                        .width,

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
                DEFAULT_OPTIONS.splashRatio;

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
            if (
                this.destroyed
            ) {
                return false;
            }

            this.resizeObserver?.
                disconnect();

            if (
                this.resizeFrame
            ) {
                window.cancelAnimationFrame(
                    this.resizeFrame
                );

                this.resizeFrame =
                    0;
            }

            this.abortController.abort();

            if (
                this.fullscreenFallback
            ) {
                this.elements.shell.classList.remove(
                    "terminal-fullscreen-fallback"
                );

                this.root.classList.remove(
                    "is-fullscreen"
                );

                document.documentElement.classList.remove(
                    "terminal-document-fullscreen"
                );

                document.body.classList.remove(
                    "terminal-document-fullscreen"
                );
            }

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

            this.destroyed =
                true;

            this.dispatchEvent(
                new CustomEvent(
                    "destroy",
                    {
                        detail: {
                            version:
                                VERSION
                        }
                    }
                )
            );

            return true;
        }

    }

    /*
    ==========================================================================
    Initialization
    ==========================================================================
    */

    function initialize(
        context
    ) {
        const root =
            context.root;

        const existing =
            context.layout instanceof
                LayoutController
                ? context.layout
                : root?.[
                    CONTROLLER_SYMBOL
                ];

        if (
            existing instanceof
                LayoutController &&
            !existing.destroyed
        ) {
            context.layout =
                existing;

            context.registerService?.(
                "layout",
                existing
            );

            return existing;
        }

        const controller =
            new LayoutController(
                context,
                {
                    mode:
                        root?.
                            dataset.
                            terminalLayout ||
                        DEFAULT_OPTIONS.mode,

                    splashRatio:
                        parseNumber(
                            root?.
                                dataset.
                                terminalSplashRatio,
                            DEFAULT_OPTIONS.splashRatio
                        ),

                    persist:
                        parseBoolean(
                            root?.
                                dataset.
                                terminalPersistLayout,
                            true
                        ),

                    responsive:
                        parseBoolean(
                            root?.
                                dataset.
                                terminalResponsiveLayout,
                            true
                        ),

                    compactBreakpoint:
                        parseNumber(
                            root?.
                                dataset.
                                terminalCompactBreakpoint,
                            DEFAULT_OPTIONS.compactBreakpoint
                        ),

                    wideBreakpoint:
                        parseNumber(
                            root?.
                                dataset.
                                terminalWideBreakpoint,
                            DEFAULT_OPTIONS.wideBreakpoint
                        )
                }
            );

        root[
            CONTROLLER_SYMBOL
        ] =
            controller;

        context.layout =
            controller;

        context.registerService?.(
            "layout",
            controller
        );

        return controller;
    }

    /*
    ==========================================================================
    Commands
    ==========================================================================
    */

    const commands =
        [
            {
                name:
                    "layout",

                category:
                    "interface",

                description:
                    "Display or set the terminal layout mode.",

                usage:
                    "layout [standard|compact|wide|split|fullscreen|console-only|splash-only]",

                handler: async ({
                    args,
                    context,
                    write,
                    writeJSON
                }) => {
                    if (!args.length) {
                        return writeJSON(
                            context.layout.status()
                        );
                    }

                    const mode =
                        args[0];

                    if (
                        mode ===
                        "fullscreen"
                    ) {
                        await context.layout.toggleFullscreen();
                    } else {
                        context.layout.setMode(
                            mode
                        );
                    }

                    return write(
                        `Layout: ${context.layout.mode}`,
                        "success"
                    );
                }
            },

            {
                name:
                    "layout-ratio",

                category:
                    "interface",

                description:
                    "Set the terminal splash-to-console height ratio.",

                usage:
                    "layout-ratio <0.15-0.80|15%-80%>",

                handler: ({
                    args,
                    context,
                    write
                }) => {
                    if (!args[0]) {
                        return write(
                            `Splash ratio: ${(
                                context.layout.splashRatio *
                                100
                            ).toFixed(2)}%`
                        );
                    }

                    const raw =
                        String(
                            args[0]
                        );

                    const value =
                        raw.endsWith("%")
                            ? Number(
                                raw.slice(
                                    0,
                                    -1
                                )
                            ) /
                            100
                            : Number(raw);

                    const ratio =
                        context.layout.setSplashRatio(
                            value
                        );

                    return write(
                        `Splash ratio: ${(
                            ratio *
                            100
                        ).toFixed(2)}%`,
                        "success"
                    );
                }
            },

            {
                name:
                    "layout-toggle",

                category:
                    "interface",

                description:
                    "Toggle a terminal region.",

                usage:
                    "layout-toggle <terminal|splash|console>",

                handler: ({
                    args,
                    context,
                    write
                }) => {
                    const region =
                        String(
                            args[0] ||
                            ""
                        ).toLowerCase();

                    if (
                        ![
                            "terminal",
                            "splash",
                            "console"
                        ].includes(
                            region
                        )
                    ) {
                        throw new Error(
                            "Use: layout-toggle terminal|splash|console"
                        );
                    }

                    const element =
                        region ===
                            "terminal"
                            ? context.layout.elements.regions
                            : region ===
                                "splash"
                                ? context.layout.elements.splash
                                : context.layout.elements.console;

                    const visible =
                        Boolean(
                            element &&
                            !element.hidden
                        );

                    context.layout.setRegionVisibility(
                        region,
                        !visible
                    );

                    return write(
                        `${!visible ? "Visible" : "Hidden"}: ${region}`,
                        "success"
                    );
                }
            },

            {
                name:
                    "layout-status",

                category:
                    "interface",

                description:
                    "Display current terminal layout state.",

                usage:
                    "layout-status",

                handler: ({
                    context,
                    writeJSON
                }) =>
                    writeJSON(
                        context.layout.status()
                    )
            },

            {
                name:
                    "layout-reset",

                category:
                    "interface",

                description:
                    "Reset terminal layout preferences.",

                usage:
                    "layout-reset",

                handler: ({
                    context,
                    write
                }) => {
                    context.layout.reset();

                    return write(
                        "Terminal layout reset.",
                        "success"
                    );
                }
            },

            {
                name:
                    "layout-show",

                category:
                    "interface",

                description:
                    "Show a terminal region.",

                usage:
                    "layout-show <terminal|splash|console>",

                handler: ({
                    args,
                    context,
                    write
                }) => {
                    const region =
                        args[0];

                    if (
                        ![
                            "terminal",
                            "splash",
                            "console"
                        ].includes(
                            region
                        )
                    ) {
                        throw new Error(
                            "Use: layout-show terminal|splash|console"
                        );
                    }

                    context.layout.setRegionVisibility(
                        region,
                        true
                    );

                    return write(
                        `Visible: ${region}`,
                        "success"
                    );
                }
            },

            {
                name:
                    "layout-hide",

                category:
                    "interface",

                description:
                    "Hide a terminal region.",

                usage:
                    "layout-hide <terminal|splash|console>",

                handler: ({
                    args,
                    context,
                    write
                }) => {
                    const region =
                        args[0];

                    if (
                        ![
                            "terminal",
                            "splash",
                            "console"
                        ].includes(
                            region
                        )
                    ) {
                        throw new Error(
                            "Use: layout-hide terminal|splash|console"
                        );
                    }

                    context.layout.setRegionVisibility(
                        region,
                        false
                    );

                    return write(
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

    document.dispatchEvent(
        new CustomEvent(
            "speciedex:terminal-module-available",
            {
                detail: {
                    name:
                        MODULE_NAME,

                    module:
                        api
                }
            }
        )
    );
})(window, document);
