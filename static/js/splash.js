"use strict";

/*
==============================================================================
Speciedex.org
Splash Module
==============================================================================

Loaded by:

    /static/js/script.js

Responsibilities:

    • Initialize one or more splash / hero sections
    • Support scroll-down controls
    • Track splash visibility
    • Respect reduced-motion preferences
    • Control statistics and terminal visibility
    • Persist splash display preferences
    • Support splash markup inserted after initial page load
    • Keep splash behavior isolated from other modules
    • Preserve the existing public Speciedex splash API

Page-level vertical order:

    1. Hero introduction
    2. Live Speciedex statistics
    3. SpeciedexTerminal
       a. Live terminal species splash
       b. Interactive terminal console
    4. Page-specific content

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
==============================================================================
*/

(() => {
    const Speciedex =
        window.Speciedex =
        window.Speciedex || {};

    if (
        Speciedex
            .splashModuleLoaded
    ) {
        return;
    }

    Speciedex
        .splashModuleLoaded =
        true;

    /*
    ==========================================================================
    Module Metadata
    ==========================================================================
    */

    const MODULE_NAME =
        "Splash";

    const VERSION =
        "2.1.0";

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
            statistics:
                true,

            terminal:
                true
        });

    const PARTIAL_EVENTS =
        Object.freeze([
            "speciedex:includes-loaded",
            "speciedex:include-loaded",
            "speciedex:partials-loaded",
            "speciedex:partial-loaded",
            "speciedex:header-loaded",
            "speciedex:splash-loaded"
        ]);

    const MUTATION_DEBOUNCE =
        40;

    const PARTIAL_DEBOUNCE =
        20;

    /*
    ==========================================================================
    Internal State
    ==========================================================================
    */

    let primarySplash =
        null;

    let observer =
        null;

    let mutationObserver =
        null;

    let mediaQuery =
        null;

    let mutationTimer =
        0;

    let partialTimer =
        0;

    let initialized =
        false;

    let destroyed =
        false;

    let listenersBound =
        false;

    const controllers =
        new Map();

    const activeEvents =
        new Set();

    /*
    ==========================================================================
    Generic Utilities
    ==========================================================================
    */

    function normalizeName(
        value
    ) {
        return String(
            value || ""
        )
            .trim()
            .toLowerCase()
            .replace(
                /[\s._]+/g,
                "-"
            )
            .replace(
                /-+/g,
                "-"
            )
            .replace(
                /^-+|-+$/g,
                ""
            );
    }

    function boolean(
        value,
        fallback =
            false
    ) {
        if (
            typeof value ===
                "boolean"
        ) {
            return value;
        }

        if (
            value ===
                undefined ||
            value ===
                null ||
            value ===
                ""
        ) {
            return fallback;
        }

        const normalized =
            String(
                value
            )
                .trim()
                .toLowerCase();

        if (
            [
                "1",
                "true",
                "yes",
                "on",
                "show",
                "shown",
                "visible",
                "expanded"
            ].includes(
                normalized
            )
        ) {
            return true;
        }

        if (
            [
                "0",
                "false",
                "no",
                "off",
                "hide",
                "hidden",
                "collapsed"
            ].includes(
                normalized
            )
        ) {
            return false;
        }

        return fallback;
    }

    function isElement(
        value
    ) {
        return (
            typeof Element !==
                "undefined" &&
            value instanceof
                Element
        );
    }

    function isSplashElement(
        value
    ) {
        return (
            isElement(
                value
            ) &&
            value.matches(
                SPLASH_SELECTOR
            )
        );
    }

    function dispatchSplashEvent(
        name,
        detail = {},
        target =
            document
    ) {
        if (
            destroyed ||
            !name ||
            !target ||
            typeof target
                .dispatchEvent !==
                "function" ||
            activeEvents.has(
                name
            )
        ) {
            return false;
        }

        activeEvents.add(
            name
        );

        try {
            return target
                .dispatchEvent(
                    new CustomEvent(
                        name,
                        {
                            detail
                        }
                    )
                );
        } catch (_error) {
            return false;
        } finally {
            activeEvents.delete(
                name
            );
        }
    }

    function getSplashIdentifier(
        root
    ) {
        if (
            !root
        ) {
            return "default";
        }

        return (
            normalizeName(
                root.dataset
                    ?.splashId ||
                root.dataset
                    ?.siteSplash ||
                root.id ||
                "default"
            ) ||
            "default"
        );
    }

    function getStorageKey(
        root
    ) {
        const identifier =
            getSplashIdentifier(
                root
            );

        return identifier ===
            "default"
            ? STORAGE_KEY
            : `${STORAGE_KEY}:${identifier}`;
    }

    /*
    ==========================================================================
    Reduced Motion
    ==========================================================================
    */

    function prefersReducedMotion() {
        try {
            if (
                typeof window.matchMedia !==
                    "function"
            ) {
                return false;
            }

            if (!mediaQuery) {
                mediaQuery =
                    window.matchMedia(
                        "(prefers-reduced-motion: reduce)"
                    );
            }

            return Boolean(
                mediaQuery.matches
            );
        } catch (_error) {
            return false;
        }
    }

    /*
    ==========================================================================
    Persistent Visibility State
    ==========================================================================
    */

    function sanitizeVisibilityState(
        value
    ) {
        const state = {
            ...DEFAULT_VISIBILITY
        };

        if (
            !value ||
            typeof value !==
                "object" ||
            Array.isArray(
                value
            )
        ) {
            return state;
        }

        for (
            const [
                rawName,
                rawVisible
            ]
            of Object.entries(
                value
            )
        ) {
            const name =
                normalizeName(
                    rawName
                );

            if (!name) {
                continue;
            }

            state[name] =
                boolean(
                    rawVisible,
                    true
                );
        }

        return state;
    }

    function restoreVisibilityState(
        root
    ) {
        const key =
            getStorageKey(
                root
            );

        try {
            const stored =
                window.localStorage
                    ?.getItem?.(
                        key
                    );

            if (!stored) {
                return {
                    ...DEFAULT_VISIBILITY
                };
            }

            return sanitizeVisibilityState(
                JSON.parse(
                    stored
                )
            );
        } catch (_error) {
            return {
                ...DEFAULT_VISIBILITY
            };
        }
    }

    function saveVisibilityState(
        root,
        state
    ) {
        try {
            window.localStorage
                ?.setItem?.(
                    getStorageKey(
                        root
                    ),
                    JSON.stringify(
                        sanitizeVisibilityState(
                            state
                        )
                    )
                );

            return true;
        } catch (_error) {
            /*
            ------------------------------------------------------------------
            Local storage is optional. Splash controls continue to work when
            storage is disabled or unavailable.
            ------------------------------------------------------------------
            */
            return false;
        }
    }

    /*
    ==========================================================================
    Scroll Target Resolution
    ==========================================================================
    */

    function resolveScrollTarget(
        button,
        root
    ) {
        const explicit =
            button
                ?.dataset
                ?.scrollDown ||
            button
                ?.getAttribute
                ?.("href") ||
            root
                ?.dataset
                ?.scrollTarget ||
            "";

        if (
            explicit &&
            explicit !==
                "#" &&
            explicit !==
                "true"
        ) {
            try {
                const target =
                    document
                        .querySelector(
                            explicit
                        );

                if (target) {
                    return target;
                }
            } catch (_error) {
                /*
                --------------------------------------------------------------
                Ignore malformed selectors and use normal fallbacks.
                --------------------------------------------------------------
                */
            }
        }

        const sibling =
            root
                ?.nextElementSibling;

        return (
            document
                .querySelector(
                    "#main-content"
                ) ||
            document
                .querySelector(
                    "main"
                ) ||
            sibling ||
            null
        );
    }

    function scrollToTarget(
        target
    ) {
        if (!target) {
            return false;
        }

        const behavior =
            prefersReducedMotion()
                ? "auto"
                : "smooth";

        try {
            target
                .scrollIntoView(
                    {
                        behavior,

                        block:
                            "start"
                    }
                );
        } catch (_error) {
            try {
                target
                    .scrollIntoView();
            } catch (_fallbackError) {
                return false;
            }
        }

        if (
            typeof target.focus ===
                "function"
        ) {
            const hadTabIndex =
                target.hasAttribute(
                    "tabindex"
                );

            if (!hadTabIndex) {
                target.setAttribute(
                    "tabindex",
                    "-1"
                );
            }

            try {
                target.focus(
                    {
                        preventScroll:
                            true
                    }
                );
            } catch (_error) {
                try {
                    target.focus();
                } catch (_fallbackError) {
                    /*
                    ----------------------------------------------------------
                    Focus support is optional.
                    ----------------------------------------------------------
                    */
                }
            }

            if (!hadTabIndex) {
                const restore =
                    () => {
                        target.removeAttribute(
                            "tabindex"
                        );

                        target.removeEventListener(
                            "blur",
                            restore
                        );
                    };

                target.addEventListener(
                    "blur",
                    restore,
                    {
                        once:
                            true
                    }
                );
            }
        }

        return true;
    }

    /*
    ==========================================================================
    Splash Display Controller
    ==========================================================================
    */

    class SplashDisplayController {
        constructor(
            root
        ) {
            if (
                !isSplashElement(
                    root
                )
            ) {
                throw new TypeError(
                    "SplashDisplayController requires a splash element."
                );
            }

            this.root =
                root;

            this.identifier =
                getSplashIdentifier(
                    root
                );

            this.state =
                restoreVisibilityState(
                    root
                );

            this.regions =
                new Map();

            this.buttons =
                new Map();

            this.scrollButtons =
                new Set();

            this.boundHandlers =
                new Map();

            this.destroyed =
                false;

            this.visible =
                true;

            this.intersectionRatio =
                1;

            this.capture();
            this.bind();
            this.applyAll(
                {
                    persist:
                        false,

                    emit:
                        false
                }
            );
        }

        capture() {
            this.captureRegions();
            this.captureButtons();
            this.captureScrollButtons();

            return this;
        }

        captureRegions() {
            this.regions.clear();

            const regions =
                this.root
                    .querySelectorAll(
                        REGION_SELECTOR
                    );

            for (
                const region
                of regions
            ) {
                const name =
                    normalizeName(
                        region.dataset
                            .splashRegion
                    );

                if (!name) {
                    continue;
                }

                this.regions.set(
                    name,
                    region
                );

                if (
                    !(name in
                        this.state)
                ) {
                    this.state[name] =
                        true;
                }
            }

            return this.regions;
        }

        captureButtons() {
            this.buttons.clear();

            const buttons =
                this.root
                    .querySelectorAll(
                        TOGGLE_SELECTOR
                    );

            for (
                const button
                of buttons
            ) {
                const name =
                    normalizeName(
                        button.dataset
                            .splashToggle
                    );

                if (!name) {
                    continue;
                }

                if (
                    !this.buttons.has(
                        name
                    )
                ) {
                    this.buttons.set(
                        name,
                        new Set()
                    );
                }

                this.buttons
                    .get(
                        name
                    )
                    .add(
                        button
                    );

                if (
                    !(name in
                        this.state)
                ) {
                    this.state[name] =
                        true;
                }
            }

            return this.buttons;
        }

        captureScrollButtons() {
            this.scrollButtons =
                new Set(
                    this.root
                        .querySelectorAll(
                            SCROLL_BUTTON_SELECTOR
                        )
                );

            return this.scrollButtons;
        }

        bindElement(
            element,
            type,
            handler,
            key
        ) {
            if (
                !element ||
                typeof element
                    .addEventListener !==
                    "function"
            ) {
                return false;
            }

            if (
                !this.boundHandlers.has(
                    element
                )
            ) {
                this.boundHandlers.set(
                    element,
                    new Map()
                );
            }

            const handlers =
                this.boundHandlers
                    .get(
                        element
                    );

            if (
                handlers.has(
                    key
                )
            ) {
                element.removeEventListener(
                    type,
                    handlers.get(
                        key
                    )
                );
            }

            handlers.set(
                key,
                handler
            );

            element.addEventListener(
                type,
                handler
            );

            return true;
        }

        bind() {
            if (
                this.destroyed
            ) {
                return this;
            }

            for (
                const [
                    name,
                    buttonSet
                ]
                of this.buttons
                    .entries()
            ) {
                for (
                    const button
                    of buttonSet
                ) {
                    const handler =
                        event => {
                            event.preventDefault();

                            this.toggle(
                                name
                            );
                        };

                    this.bindElement(
                        button,
                        "click",
                        handler,
                        `toggle:${name}`
                    );
                }
            }

            for (
                const button
                of this.scrollButtons
            ) {
                const handler =
                    event => {
                        event.preventDefault();

                        const target =
                            resolveScrollTarget(
                                button,
                                this.root
                            );

                        if (
                            scrollToTarget(
                                target
                            )
                        ) {
                            dispatchSplashEvent(
                                "speciedex:splash-scroll",
                                {
                                    splash:
                                        this.root,

                                    button,

                                    target,

                                    controller:
                                        this
                                }
                            );
                        }
                    };

                this.bindElement(
                    button,
                    "click",
                    handler,
                    "scroll"
                );
            }

            return this;
        }

        refresh() {
            if (
                this.destroyed
            ) {
                return this;
            }

            this.unbind();
            this.capture();
            this.bind();
            this.applyAll(
                {
                    persist:
                        false,

                    emit:
                        false
                }
            );

            return this;
        }

        unbind() {
            for (
                const [
                    element,
                    handlers
                ]
                of this.boundHandlers
                    .entries()
            ) {
                for (
                    const [
                        key,
                        handler
                    ]
                    of handlers.entries()
                ) {
                    const type =
                        key ===
                            "scroll" ||
                        key.startsWith(
                            "toggle:"
                        )
                            ? "click"
                            : key;

                    element.removeEventListener(
                        type,
                        handler
                    );
                }
            }

            this.boundHandlers.clear();

            return this;
        }

        toggle(
            name
        ) {
            return this.set(
                name,
                !this.isVisible(
                    name
                )
            );
        }

        set(
            name,
            visible,
            options = {}
        ) {
            const normalized =
                normalizeName(
                    name
                );

            if (!normalized) {
                return false;
            }

            if (
                !(normalized in
                    this.state)
            ) {
                /*
                --------------------------------------------------------------
                Permit controls added after initialization. Unknown state keys
                become valid when a matching region or button exists.
                --------------------------------------------------------------
                */
                if (
                    !this.regions.has(
                        normalized
                    ) &&
                    !this.buttons.has(
                        normalized
                    )
                ) {
                    return false;
                }

                this.state[normalized] =
                    true;
            }

            const next =
                Boolean(
                    visible
                );

            const changed =
                this.state[normalized] !==
                    next;

            this.state[normalized] =
                next;

            this.apply(
                normalized,
                options
            );

            if (
                options.persist !==
                    false
            ) {
                saveVisibilityState(
                    this.root,
                    this.state
                );
            }

            if (
                options.emit !==
                    false &&
                changed
            ) {
                dispatchSplashEvent(
                    "speciedex:splash-region-visibility",
                    {
                        splash:
                            this.root,

                        controller:
                            this,

                        region:
                            normalized,

                        visible:
                            next,

                        visibility:
                            this.snapshot()
                    }
                );
            }

            return true;
        }

        isVisible(
            name
        ) {
            const normalized =
                normalizeName(
                    name
                );

            return (
                normalized in
                    this.state
                    ? Boolean(
                        this.state[
                            normalized
                        ]
                    )
                    : true
            );
        }

        apply(
            name,
            options = {}
        ) {
            const normalized =
                normalizeName(
                    name
                );

            if (!normalized) {
                return false;
            }

            const visible =
                this.isVisible(
                    normalized
                );

            const region =
                this.regions.get(
                    normalized
                );

            const buttonSet =
                this.buttons.get(
                    normalized
                ) ||
                new Set();

            if (region) {
                region.hidden =
                    !visible;

                region.dataset.collapsed =
                    visible
                        ? "false"
                        : "true";

                region.setAttribute(
                    "aria-hidden",
                    String(
                        !visible
                    )
                );

                region.classList.toggle(
                    COLLAPSED_CLASS,
                    !visible
                );

                if (
                    !region.id
                ) {
                    region.id =
                        `splash-${this.identifier}-${normalized}`;
                }
            }

            for (
                const button
                of buttonSet
            ) {
                button.setAttribute(
                    "aria-expanded",
                    String(
                        visible
                    )
                );

                button.classList.toggle(
                    COLLAPSED_CLASS,
                    !visible
                );

                if (region?.id) {
                    button.setAttribute(
                        "aria-controls",
                        region.id
                    );
                }

                if (
                    !button.hasAttribute(
                        "type"
                    ) &&
                    button.tagName ===
                        "BUTTON"
                ) {
                    button.setAttribute(
                        "type",
                        "button"
                    );
                }
            }

            this.root.classList.toggle(
                `splash-${normalized}-collapsed`,
                !visible
            );

            if (
                options.emit ===
                    true
            ) {
                dispatchSplashEvent(
                    "speciedex:splash-region-applied",
                    {
                        splash:
                            this.root,

                        controller:
                            this,

                        region:
                            normalized,

                        visible
                    }
                );
            }

            return true;
        }

        applyAll(
            options = {}
        ) {
            const names =
                new Set([
                    ...Object.keys(
                        this.state
                    ),
                    ...this.regions.keys(),
                    ...this.buttons.keys()
                ]);

            for (
                const name
                of names
            ) {
                if (
                    !(name in
                        this.state)
                ) {
                    this.state[name] =
                        true;
                }

                this.apply(
                    name,
                    options
                );
            }

            if (
                options.persist !==
                    false
            ) {
                saveVisibilityState(
                    this.root,
                    this.state
                );
            }

            if (
                options.emit ===
                    true
            ) {
                dispatchSplashEvent(
                    "speciedex:splash-regions-applied",
                    {
                        splash:
                            this.root,

                        controller:
                            this,

                        visibility:
                            this.snapshot()
                    }
                );
            }

            return this;
        }

        showAll() {
            for (
                const name
                of new Set([
                    ...Object.keys(
                        this.state
                    ),
                    ...this.regions.keys(),
                    ...this.buttons.keys()
                ])
            ) {
                this.state[name] =
                    true;
            }

            this.applyAll(
                {
                    persist:
                        true,

                    emit:
                        true
                }
            );

            return this;
        }

        hideAll() {
            for (
                const name
                of new Set([
                    ...Object.keys(
                        this.state
                    ),
                    ...this.regions.keys(),
                    ...this.buttons.keys()
                ])
            ) {
                this.state[name] =
                    false;
            }

            this.applyAll(
                {
                    persist:
                        true,

                    emit:
                        true
                }
            );

            return this;
        }

        reset() {
            this.state = {
                ...DEFAULT_VISIBILITY
            };

            for (
                const name
                of new Set([
                    ...this.regions.keys(),
                    ...this.buttons.keys()
                ])
            ) {
                if (
                    !(name in
                        this.state)
                ) {
                    this.state[name] =
                        true;
                }
            }

            this.applyAll(
                {
                    persist:
                        true,

                    emit:
                        true
                }
            );

            dispatchSplashEvent(
                "speciedex:splash-regions-reset",
                {
                    splash:
                        this.root,

                    controller:
                        this,

                    visibility:
                        this.snapshot()
                }
            );

            return this;
        }

        snapshot() {
            return {
                ...this.state
            };
        }

        status() {
            return {
                identifier:
                    this.identifier,

                visible:
                    this.visible,

                intersectionRatio:
                    this.intersectionRatio,

                regions:
                    this.regions.size,

                buttons:
                    [...this.buttons
                        .values()]
                        .reduce(
                            (
                                total,
                                set
                            ) =>
                                total +
                                set.size,
                            0
                        ),

                scrollButtons:
                    this.scrollButtons.size,

                visibility:
                    this.snapshot(),

                destroyed:
                    this.destroyed
            };
        }

        destroy() {
            if (
                this.destroyed
            ) {
                return false;
            }

            this.unbind();

            this.buttons.clear();
            this.regions.clear();
            this.scrollButtons.clear();

            this.root.classList.remove(
                VISIBLE_CLASS,
                SCROLLED_CLASS
            );

            this.destroyed =
                true;

            return true;
        }
    }

    /*
    ==========================================================================
    Splash Discovery and Initialization
    ==========================================================================
    */

    function findSplashElements(
        root =
            document
    ) {
        const splashes =
            [];

        if (
            isSplashElement(
                root
            )
        ) {
            splashes.push(
                root
            );
        }

        if (
            root &&
            typeof root.querySelectorAll ===
                "function"
        ) {
            for (
                const element
                of root.querySelectorAll(
                    SPLASH_SELECTOR
                )
            ) {
                if (
                    !splashes.includes(
                        element
                    )
                ) {
                    splashes.push(
                        element
                    );
                }
            }
        }

        return splashes;
    }

    function choosePrimarySplash() {
        if (
            primarySplash &&
            primarySplash.isConnected &&
            controllers.has(
                primarySplash
            )
        ) {
            return primarySplash;
        }

        primarySplash =
            [...controllers.keys()]
                .find(
                    element =>
                        element.isConnected
                ) ||
            null;

        return primarySplash;
    }

    function updatePublicControllerReferences() {
        choosePrimarySplash();

        Speciedex.splashController =
            primarySplash
                ? controllers.get(
                    primarySplash
                ) ||
                    null
                : null;

        Speciedex.splashControllers =
            [...controllers.values()]
                .filter(
                    controller =>
                        !controller.destroyed
                );

        Speciedex.splashElements =
            [...controllers.keys()]
                .filter(
                    element =>
                        element.isConnected
                );
    }

    function initializeSplashElement(
        root
    ) {
        if (
            destroyed ||
            !isSplashElement(
                root
            )
        ) {
            return null;
        }

        if (
            controllers.has(
                root
            )
        ) {
            const existing =
                controllers.get(
                    root
                );

            existing.refresh();

            root.classList.add(
                VISIBLE_CLASS
            );

            return existing;
        }

        const controller =
            new SplashDisplayController(
                root
            );

        controllers.set(
            root,
            controller
        );

        if (!primarySplash) {
            primarySplash =
                root;
        }

        root.classList.add(
            VISIBLE_CLASS
        );

        if (observer) {
            observer.observe(
                root
            );
        }

        updatePublicControllerReferences();

        dispatchSplashEvent(
            "speciedex:splash-ready",
            {
                splash:
                    root,

                controller,

                visibility:
                    controller.snapshot(),

                primary:
                    root ===
                        primarySplash
            }
        );

        return controller;
    }

    function initializeSplash(
        root =
            document
    ) {
        if (
            destroyed
        ) {
            return null;
        }

        initializeObserver();

        const splashes =
            findSplashElements(
                root
            );

        for (
            const element
            of splashes
        ) {
            initializeSplashElement(
                element
            );
        }

        cleanupDetachedSplashes();

        initialized =
            controllers.size >
            0;

        updatePublicControllerReferences();

        if (
            isSplashElement(
                root
            )
        ) {
            return controllers.get(
                root
            ) ||
                null;
        }

        return getSplashController();
    }

    /*
    ==========================================================================
    Intersection Observer
    ==========================================================================
    */

    function initializeObserver() {
        if (
            observer ||
            typeof IntersectionObserver !==
                "function"
        ) {
            return observer;
        }

        observer =
            new IntersectionObserver(
                handleIntersection,
                {
                    root:
                        null,

                    rootMargin:
                        "0px",

                    threshold: [
                        0,
                        0.01,
                        0.05,
                        0.25,
                        0.5,
                        0.75,
                        1
                    ]
                }
            );

        for (
            const root
            of controllers.keys()
        ) {
            observer.observe(
                root
            );
        }

        return observer;
    }

    function handleIntersection(
        entries
    ) {
        for (
            const entry
            of entries
        ) {
            const root =
                entry.target;

            const controller =
                controllers.get(
                    root
                );

            if (!controller) {
                continue;
            }

            const visible =
                Boolean(
                    entry.isIntersecting
                );

            const ratio =
                Number.isFinite(
                    entry.intersectionRatio
                )
                    ? entry.intersectionRatio
                    : visible
                        ? 1
                        : 0;

            controller.visible =
                visible;

            controller.intersectionRatio =
                ratio;

            const scrolled =
                !visible;

            root.classList.toggle(
                SCROLLED_CLASS,
                scrolled
            );

            if (
                root ===
                    primarySplash
            ) {
                document.body
                    ?.classList
                    ?.toggle(
                        "splash-scrolled",
                        scrolled
                    );
            }

            dispatchSplashEvent(
                "speciedex:splash-visibility",
                {
                    splash:
                        root,

                    controller,

                    visible,

                    ratio,

                    primary:
                        root ===
                            primarySplash
                }
            );
        }
    }

    /*
    ==========================================================================
    Mutation and Partial Support
    ==========================================================================
    */

    function nodeContainsSplashMarkup(
        node
    ) {
        if (
            !isElement(
                node
            )
        ) {
            return false;
        }

        if (
            node.matches(
                [
                    SPLASH_SELECTOR,
                    TOGGLE_SELECTOR,
                    REGION_SELECTOR,
                    SCROLL_BUTTON_SELECTOR
                ].join(
                    ","
                )
            )
        ) {
            return true;
        }

        return Boolean(
            node.querySelector(
                [
                    SPLASH_SELECTOR,
                    TOGGLE_SELECTOR,
                    REGION_SELECTOR,
                    SCROLL_BUTTON_SELECTOR
                ].join(
                    ","
                )
            )
        );
    }

    function scheduleSplashRefresh(
        delay =
            MUTATION_DEBOUNCE
    ) {
        if (
            destroyed
        ) {
            return;
        }

        if (
            mutationTimer
        ) {
            window.clearTimeout(
                mutationTimer
            );
        }

        mutationTimer =
            window.setTimeout(
                () => {
                    mutationTimer =
                        0;

                    initializeSplash(
                        document
                    );
                },
                delay
            );
    }

    function initializeMutationObserver() {
        if (
            mutationObserver ||
            typeof MutationObserver ===
                "undefined"
        ) {
            return mutationObserver;
        }

        mutationObserver =
            new MutationObserver(
                mutations => {
                    let relevant =
                        false;

                    for (
                        const mutation
                        of mutations
                    ) {
                        if (
                            mutation.type ===
                                "attributes" &&
                            isElement(
                                mutation.target
                            )
                        ) {
                            relevant =
                                true;

                            break;
                        }

                        for (
                            const node
                            of mutation.addedNodes
                        ) {
                            if (
                                nodeContainsSplashMarkup(
                                    node
                                )
                            ) {
                                relevant =
                                    true;

                                break;
                            }
                        }

                        if (relevant) {
                            break;
                        }

                        for (
                            const node
                            of mutation.removedNodes
                        ) {
                            if (
                                nodeContainsSplashMarkup(
                                    node
                                )
                            ) {
                                relevant =
                                    true;

                                break;
                            }
                        }

                        if (relevant) {
                            break;
                        }
                    }

                    if (relevant) {
                        scheduleSplashRefresh();
                    }
                }
            );

        mutationObserver.observe(
            document.documentElement,
            {
                childList:
                    true,

                subtree:
                    true,

                attributes:
                    true,

                attributeFilter: [
                    "data-site-splash",
                    "data-splash-region",
                    "data-splash-toggle",
                    "data-scroll-down",
                    "id",
                    "class"
                ]
            }
        );

        Speciedex.splashMutationObserver =
            mutationObserver;

        return mutationObserver;
    }

    function bindPartialEvents() {
        if (
            listenersBound
        ) {
            return;
        }

        listenersBound =
            true;

        for (
            const eventName
            of PARTIAL_EVENTS
        ) {
            document.addEventListener(
                eventName,
                () => {
                    if (
                        partialTimer
                    ) {
                        window.clearTimeout(
                            partialTimer
                        );
                    }

                    partialTimer =
                        window.setTimeout(
                            () => {
                                partialTimer =
                                    0;

                                initializeSplash(
                                    document
                                );
                            },
                            PARTIAL_DEBOUNCE
                        );
                }
            );
        }
    }

    function cleanupDetachedSplashes() {
        for (
            const [
                root,
                controller
            ]
            of controllers.entries()
        ) {
            if (
                root.isConnected
            ) {
                continue;
            }

            observer?.unobserve?.(
                root
            );

            controller.destroy();

            controllers.delete(
                root
            );

            if (
                primarySplash ===
                    root
            ) {
                primarySplash =
                    null;
            }
        }

        updatePublicControllerReferences();
    }

    /*
    ==========================================================================
    Public Region Controls
    ==========================================================================
    */

    function getSplashController(
        root =
            null
    ) {
        if (
            isSplashElement(
                root
            )
        ) {
            return controllers.get(
                root
            ) ||
                null;
        }

        if (
            typeof root ===
                "string" &&
            root
        ) {
            const normalized =
                normalizeName(
                    root
                );

            for (
                const controller
                of controllers.values()
            ) {
                if (
                    controller.identifier ===
                        normalized
                ) {
                    return controller;
                }
            }
        }

        choosePrimarySplash();

        return primarySplash
            ? controllers.get(
                primarySplash
            ) ||
                null
            : null;
    }

    function setSplashRegionVisibility(
        name,
        visible,
        root =
            null
    ) {
        const controller =
            getSplashController(
                root
            );

        if (!controller) {
            return false;
        }

        return controller.set(
            name,
            visible
        );
    }

    function toggleSplashRegion(
        name,
        root =
            null
    ) {
        const controller =
            getSplashController(
                root
            );

        if (!controller) {
            return false;
        }

        return controller.toggle(
            name
        );
    }

    function showAllSplashRegions(
        root =
            null
    ) {
        const controller =
            getSplashController(
                root
            );

        if (!controller) {
            return false;
        }

        controller.showAll();

        return true;
    }

    function hideAllSplashRegions(
        root =
            null
    ) {
        const controller =
            getSplashController(
                root
            );

        if (!controller) {
            return false;
        }

        controller.hideAll();

        return true;
    }

    function resetSplashRegions(
        root =
            null
    ) {
        const controller =
            getSplashController(
                root
            );

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

    function destroySplash(
        root =
            null
    ) {
        if (
            isSplashElement(
                root
            )
        ) {
            const controller =
                controllers.get(
                    root
                );

            if (!controller) {
                return false;
            }

            observer?.unobserve?.(
                root
            );

            controller.destroy();

            controllers.delete(
                root
            );

            if (
                primarySplash ===
                    root
            ) {
                primarySplash =
                    null;
            }

            choosePrimarySplash();
            updatePublicControllerReferences();

            document.body
                ?.classList
                ?.remove(
                    "splash-scrolled"
                );

            dispatchSplashEvent(
                "speciedex:splash-destroyed",
                {
                    splash:
                        root,

                    all:
                        false
                }
            );

            initialized =
                controllers.size >
                0;

            return true;
        }

        observer?.disconnect?.();
        observer =
            null;

        mutationObserver
            ?.disconnect?.();

        mutationObserver =
            null;

        if (
            mutationTimer
        ) {
            window.clearTimeout(
                mutationTimer
            );

            mutationTimer =
                0;
        }

        if (
            partialTimer
        ) {
            window.clearTimeout(
                partialTimer
            );

            partialTimer =
                0;
        }

        for (
            const controller
            of controllers.values()
        ) {
            controller.destroy();
        }

        controllers.clear();

        document.body
            ?.classList
            ?.remove(
                "splash-scrolled"
            );

        primarySplash =
            null;

        initialized =
            false;

        updatePublicControllerReferences();

        dispatchSplashEvent(
            "speciedex:splash-destroyed",
            {
                splash:
                    null,

                all:
                    true
            }
        );

        return true;
    }

    function destroySplashModule() {
        if (
            destroyed
        ) {
            return false;
        }

        destroySplash();

        destroyed =
            true;

        Speciedex.splashMutationObserver =
            null;

        return true;
    }

    /*
    ==========================================================================
    Status
    ==========================================================================
    */

    function getSplashStatus() {
        return {
            name:
                MODULE_NAME,

            version:
                VERSION,

            initialized,

            destroyed,

            splashCount:
                controllers.size,

            primary:
                primarySplash
                    ? getSplashIdentifier(
                        primarySplash
                    )
                    : null,

            reducedMotion:
                prefersReducedMotion(),

            controllers:
                [...controllers.values()]
                    .map(
                        controller =>
                            controller.status()
                    )
        };
    }

    /*
    ==========================================================================
    Startup
    ==========================================================================
    */

    function bindInitialSplash() {
        const initialize =
            () => {
                initializeMutationObserver();

                initializeSplash(
                    document
                );
            };

        if (
            document.readyState ===
                "loading"
        ) {
            document.addEventListener(
                "DOMContentLoaded",
                initialize,
                {
                    once:
                        true
                }
            );
        } else {
            initialize();
        }
    }

    /*
    ==========================================================================
    Public API
    ==========================================================================
    */

    const SplashAPI =
        Object.freeze({
            name:
                MODULE_NAME,

            version:
                VERSION,

            initialize:
                initializeSplash,

            destroy:
                destroySplash,

            destroyModule:
                destroySplashModule,

            status:
                getSplashStatus,

            getController:
                getSplashController,

            setRegionVisibility:
                setSplashRegionVisibility,

            toggleRegion:
                toggleSplashRegion,

            showAll:
                showAllSplashRegions,

            hideAll:
                hideAllSplashRegions,

            reset:
                resetSplashRegions,

            prefersReducedMotion,

            find:
                findSplashElements,

            controllers:
                () =>
                    [...controllers.values()]
        });

    Speciedex.Splash =
        SplashAPI;

    Speciedex.SplashDisplayController =
        SplashDisplayController;

    Speciedex.initializeSplash =
        initializeSplash;

    Speciedex.destroySplash =
        destroySplash;

    Speciedex.destroySplashModule =
        destroySplashModule;

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

    Speciedex.getSplashStatus =
        getSplashStatus;

    /*
    ==========================================================================
    Module Startup
    ==========================================================================
    */

    bindPartialEvents();

    bindInitialSplash();

    dispatchSplashEvent(
        "speciedex:splash-module-available",
        {
            module:
                SplashAPI,

            version:
                VERSION
        }
    );
})();
