"use strict";

/*
==============================================================================
Speciedex.org
Splash Module
==============================================================================

Loaded by:

    /static/js/script.js

Responsibilities:

    • Initialize splash / hero sections
    • Support scroll-down controls
    • Track splash visibility
    • Respect reduced-motion preferences
    • Control statistics and terminal visibility
    • Persist splash display preferences
    • Keep splash behavior isolated from other modules

Page-level vertical order:

    1. Hero introduction
    2. Live Speciedex statistics
    3. SpeciedexTerminal
       a. Live terminal species splash
       b. Interactive terminal console
    4. Page-specific content

==============================================================================
*/

(() => {
    const Speciedex =
        window.Speciedex =
        window.Speciedex || {};

    if (Speciedex.splashModuleLoaded) {
        return;
    }

    Speciedex.splashModuleLoaded = true;

    /*
    ==========================================================================
    Selectors / Classes
    ==========================================================================
    */

    const SPLASH_SELECTOR =
        "[data-site-splash], .site-splash, .splash";

    const SCROLL_BUTTON_SELECTOR =
        "[data-scroll-down]";

    const TOGGLE_SELECTOR =
        "[data-splash-toggle]";

    const REGION_SELECTOR =
        "[data-splash-region]";

    const VISIBLE_CLASS =
        "is-visible";

    const SCROLLED_CLASS =
        "is-scrolled";

    const COLLAPSED_CLASS =
        "is-collapsed";

    /*
    ==========================================================================
    Configuration
    ==========================================================================
    */

    const STORAGE_KEY =
        "speciedex:splash:visibility";

    const DEFAULT_VISIBILITY =
        Object.freeze({
            statistics: true,
            terminal: true
        });

    /*
    ==========================================================================
    Internal State
    ==========================================================================
    */

    let splash = null;
    let scrollButton = null;
    let observer = null;
    let initialized = false;

    const controllers =
        new Map();

    /*
    ==========================================================================
    Reduced Motion
    ==========================================================================
    */

    function prefersReducedMotion() {
        return (
            window.matchMedia &&
            window.matchMedia(
                "(prefers-reduced-motion: reduce)"
            ).matches
        );
    }

    /*
    ==========================================================================
    Persistent Visibility State
    ==========================================================================
    */

    function restoreVisibilityState() {
        try {
            const stored =
                JSON.parse(
                    window.localStorage.getItem(
                        STORAGE_KEY
                    ) || "{}"
                );

            return {
                ...DEFAULT_VISIBILITY,
                ...stored
            };
        } catch (error) {
            return {
                ...DEFAULT_VISIBILITY
            };
        }
    }

    function saveVisibilityState(state) {
        try {
            window.localStorage.setItem(
                STORAGE_KEY,
                JSON.stringify(state)
            );
        } catch (error) {
            /*
            ------------------------------------------------------------------
            Local storage is optional. Splash controls must continue to work
            when storage is disabled or unavailable.
            ------------------------------------------------------------------
            */
        }
    }

    /*
    ==========================================================================
    Splash Display Controller
    ==========================================================================
    */

    class SplashDisplayController {
        constructor(root) {
            this.root =
                root;

            this.state =
                restoreVisibilityState();

            this.regions =
                new Map();

            this.buttons =
                new Map();

            this.boundHandlers =
                new Map();

            this.captureRegions();
            this.captureButtons();
            this.bind();
            this.applyAll();
        }

        captureRegions() {
            const regions =
                this.root.querySelectorAll(
                    REGION_SELECTOR
                );

            for (const region of regions) {
                const name =
                    region.dataset.splashRegion;

                if (!name) {
                    continue;
                }

                this.regions.set(
                    name,
                    region
                );

                if (!(name in this.state)) {
                    this.state[name] =
                        true;
                }
            }
        }

        captureButtons() {
            const buttons =
                this.root.querySelectorAll(
                    TOGGLE_SELECTOR
                );

            for (const button of buttons) {
                const name =
                    button.dataset.splashToggle;

                if (!name) {
                    continue;
                }

                this.buttons.set(
                    name,
                    button
                );

                if (!(name in this.state)) {
                    this.state[name] =
                        true;
                }
            }
        }

        bind() {
            for (
                const [
                    name,
                    button
                ] of this.buttons.entries()
            ) {
                const handler =
                    event => {
                        event.preventDefault();

                        this.toggle(
                            name
                        );
                    };

                this.boundHandlers.set(
                    button,
                    handler
                );

                button.addEventListener(
                    "click",
                    handler
                );
            }
        }

        toggle(name) {
            this.set(
                name,
                !this.isVisible(name)
            );
        }

        set(name, visible) {
            if (!(name in this.state)) {
                throw new Error(
                    `Unknown splash region: ${name}`
                );
            }

            this.state[name] =
                Boolean(visible);

            this.apply(name);
            saveVisibilityState(
                this.state
            );

            document.dispatchEvent(
                new CustomEvent(
                    "speciedex:splash-region-visibility",
                    {
                        detail: {
                            splash:
                                this.root,
                            region:
                                name,
                            visible:
                                this.state[name]
                        }
                    }
                )
            );
        }

        isVisible(name) {
            return (
                name in this.state
                    ? Boolean(
                        this.state[name]
                    )
                    : true
            );
        }

        apply(name) {
            const visible =
                this.isVisible(name);

            const region =
                this.regions.get(name);

            const button =
                this.buttons.get(name);

            if (region) {
                region.hidden =
                    !visible;

                region.dataset.collapsed =
                    visible
                        ? "false"
                        : "true";

                region.setAttribute(
                    "aria-hidden",
                    String(!visible)
                );
            }

            if (button) {
                button.setAttribute(
                    "aria-expanded",
                    String(visible)
                );

                button.classList.toggle(
                    COLLAPSED_CLASS,
                    !visible
                );
            }

            this.root.classList.toggle(
                `splash-${name}-collapsed`,
                !visible
            );
        }

        applyAll() {
            for (const name of Object.keys(this.state)) {
                this.apply(name);
            }

            saveVisibilityState(
                this.state
            );
        }

        showAll() {
            for (const name of Object.keys(this.state)) {
                this.state[name] =
                    true;
            }

            this.applyAll();
        }

        hideAll() {
            for (const name of Object.keys(this.state)) {
                this.state[name] =
                    false;
            }

            this.applyAll();
        }

        reset() {
            this.state = {
                ...DEFAULT_VISIBILITY
            };

            for (const name of this.regions.keys()) {
                if (!(name in this.state)) {
                    this.state[name] =
                        true;
                }
            }

            this.applyAll();
        }

        snapshot() {
            return {
                ...this.state
            };
        }

        destroy() {
            for (
                const [
                    button,
                    handler
                ] of this.boundHandlers.entries()
            ) {
                button.removeEventListener(
                    "click",
                    handler
                );
            }

            this.boundHandlers.clear();
            this.buttons.clear();
            this.regions.clear();
        }
    }

    /*
    ==========================================================================
    Initialize Splash
    ==========================================================================
    */

    function initializeSplash() {
        if (initialized) {
            return (
                splash
                    ? controllers.get(splash) || null
                    : null
            );
        }

        splash =
            document.querySelector(
                SPLASH_SELECTOR
            );

        if (!splash) {
            return null;
        }

        initialized = true;

        splash.classList.add(
            VISIBLE_CLASS
        );

        initializeScrollButton();
        initializeObserver();

        const controller =
            new SplashDisplayController(
                splash
            );

        controllers.set(
            splash,
            controller
        );

        Speciedex.splashController =
            controller;

        Speciedex.splashControllers =
            [...controllers.values()];

        document.dispatchEvent(
            new CustomEvent(
                "speciedex:splash-ready",
                {
                    detail: {
                        splash,
                        controller,
                        visibility:
                            controller.snapshot()
                    }
                }
            )
        );

        return controller;
    }

    /*
    ==========================================================================
    Scroll Button
    ==========================================================================
    */

    function initializeScrollButton() {
        scrollButton =
            splash.querySelector(
                SCROLL_BUTTON_SELECTOR
            );

        if (!scrollButton) {
            return;
        }

        scrollButton.removeEventListener(
            "click",
            handleScrollButton
        );

        scrollButton.addEventListener(
            "click",
            handleScrollButton
        );
    }

    function handleScrollButton(event) {
        event.preventDefault();

        const target =
            document.querySelector(
                "#main-content"
            ) ||
            document.querySelector(
                "main"
            );

        if (!target) {
            return;
        }

        target.scrollIntoView({
            behavior:
                prefersReducedMotion()
                    ? "auto"
                    : "smooth",

            block:
                "start"
        });

        if (
            typeof target.focus ===
            "function" &&
            target.hasAttribute(
                "tabindex"
            )
        ) {
            target.focus({
                preventScroll: true
            });
        }
    }

    /*
    ==========================================================================
    Intersection Observer
    ==========================================================================
    */

    function initializeObserver() {
        observer?.disconnect();
        observer = null;

        if (
            typeof IntersectionObserver !==
            "function"
        ) {
            return;
        }

        observer =
            new IntersectionObserver(
                handleIntersection,
                {
                    threshold: 0.05
                }
            );

        observer.observe(
            splash
        );
    }

    function handleIntersection(entries) {
        const entry =
            entries[0];

        if (
            !entry ||
            !splash
        ) {
            return;
        }

        const scrolled =
            !entry.isIntersecting;

        splash.classList.toggle(
            SCROLLED_CLASS,
            scrolled
        );

        document.body.classList.toggle(
            "splash-scrolled",
            scrolled
        );

        document.dispatchEvent(
            new CustomEvent(
                "speciedex:splash-visibility",
                {
                    detail: {
                        splash,
                        visible:
                            entry.isIntersecting,
                        ratio:
                            entry.intersectionRatio
                    }
                }
            )
        );
    }

    /*
    ==========================================================================
    Public Region Controls
    ==========================================================================
    */

    function getSplashController() {
        if (!splash) {
            return null;
        }

        return (
            controllers.get(splash) ||
            null
        );
    }

    function setSplashRegionVisibility(
        name,
        visible
    ) {
        const controller =
            getSplashController();

        if (!controller) {
            return false;
        }

        controller.set(
            name,
            visible
        );

        return true;
    }

    function toggleSplashRegion(name) {
        const controller =
            getSplashController();

        if (!controller) {
            return false;
        }

        controller.toggle(
            name
        );

        return true;
    }

    function showAllSplashRegions() {
        const controller =
            getSplashController();

        if (!controller) {
            return false;
        }

        controller.showAll();

        return true;
    }

    function hideAllSplashRegions() {
        const controller =
            getSplashController();

        if (!controller) {
            return false;
        }

        controller.hideAll();

        return true;
    }

    function resetSplashRegions() {
        const controller =
            getSplashController();

        if (!controller) {
            return false;
        }

        controller.reset();

        return true;
    }

    /*
    ==========================================================================
    Destroy Splash
    ==========================================================================
    */

    function destroySplash() {
        observer?.disconnect();
        observer = null;

        if (scrollButton) {
            scrollButton.removeEventListener(
                "click",
                handleScrollButton
            );
        }

        if (splash) {
            controllers.get(
                splash
            )?.destroy();

            controllers.delete(
                splash
            );

            splash.classList.remove(
                VISIBLE_CLASS,
                SCROLLED_CLASS
            );
        }

        document.body.classList.remove(
            "splash-scrolled"
        );

        Speciedex.splashController =
            null;

        Speciedex.splashControllers =
            [...controllers.values()];

        scrollButton = null;
        splash = null;
        initialized = false;
    }

    /*
    ==========================================================================
    Public API
    ==========================================================================
    */

    Speciedex.SplashDisplayController =
        SplashDisplayController;

    Speciedex.initializeSplash =
        initializeSplash;

    Speciedex.destroySplash =
        destroySplash;

    Speciedex.getSplashController =
        getSplashController;

    Speciedex.setSplashRegionVisibility =
        setSplashRegionVisibility;

    Speciedex.toggleSplashRegion =
        toggleSplashRegion;

    Speciedex.showAllSplashRegions =
        showAllSplashRegions;

    Speciedex.hideAllSplashRegions =
        hideAllSplashRegions;

    Speciedex.resetSplashRegions =
        resetSplashRegions;
})();
