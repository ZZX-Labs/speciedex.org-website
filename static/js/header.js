"use strict";

/*
==============================================================================
Speciedex.org
Header Module
==============================================================================

Loaded by:

    /static/js/script.js

Runs after reusable HTML partials have been inserted into the document.

Responsibilities:

    • Initialize the site header
    • Track scroll state
    • Publish measured header height to CSS
    • Respond to viewport changes
    • Respond to dynamically loaded header/navigation partials
    • Cleanly support reinitialization and teardown

==============================================================================
*/

(() => {
    const Speciedex =
        window.Speciedex =
        window.Speciedex || {};

    if (Speciedex.headerModuleLoaded) {
        return;
    }

    Speciedex.headerModuleLoaded = true;

    /*
    ==========================================================================
    Selectors / Classes
    ==========================================================================
    */

    const HEADER_SELECTOR =
        "[data-site-header], .site-header, .header";

    const SCROLLED_CLASS =
        "header-scrolled";

    const BODY_HEADER_CLASS =
        "has-site-header";

    const HEADER_HEIGHT_PROPERTY =
        "--site-header-height";

    /*
    ==========================================================================
    Internal State
    ==========================================================================
    */

    let initialized = false;
    let header = null;
    let resizeObserver = null;
    let animationFrame = null;
    let currentHeight = 0;

    /*
    ==========================================================================
    Resolve Header
    ==========================================================================
    */

    function findHeader() {
        return document.querySelector(
            HEADER_SELECTOR
        );
    }

    /*
    ==========================================================================
    Initialize Header
    ==========================================================================
    */

    function initializeHeader() {
        const nextHeader =
            findHeader();

        if (!nextHeader) {
            return;
        }

        if (
            header &&
            header !== nextHeader
        ) {
            detachHeaderObserver();

            header = nextHeader;

            observeHeaderSize();
        } else {
            header = nextHeader;
        }

        if (initialized) {
            updateHeaderHeight();
            updateScrollState();
            return;
        }

        initialized = true;

        document.body.classList.add(
            BODY_HEADER_CLASS
        );

        updateHeaderHeight();
        updateScrollState();

        window.addEventListener(
            "scroll",
            requestScrollUpdate,
            {
                passive: true
            }
        );

        window.addEventListener(
            "resize",
            requestHeaderMeasurement,
            {
                passive: true
            }
        );

        window.addEventListener(
            "orientationchange",
            requestHeaderMeasurement
        );

        document.addEventListener(
            "speciedex:include-loaded",
            handleIncludeLoaded
        );

        observeHeaderSize();

        document.dispatchEvent(
            new CustomEvent(
                "speciedex:header-ready",
                {
                    detail: {
                        header,
                        height:
                            currentHeight
                    }
                }
            )
        );
    }

    /*
    ==========================================================================
    Scroll State
    ==========================================================================
    */

    function updateScrollState() {
        if (!header) {
            return;
        }

        const scrolled =
            window.scrollY > 1;

        header.classList.toggle(
            SCROLLED_CLASS,
            scrolled
        );

        document.body.classList.toggle(
            SCROLLED_CLASS,
            scrolled
        );
    }

    function requestScrollUpdate() {
        if (animationFrame !== null) {
            return;
        }

        animationFrame =
            window.requestAnimationFrame(
                () => {
                    animationFrame = null;
                    updateScrollState();
                }
            );
    }

    /*
    ==========================================================================
    Header Height
    ==========================================================================
    */

    function updateHeaderHeight() {
        if (!header) {
            return 0;
        }

        const rect =
            header.getBoundingClientRect();

        const height =
            Math.max(
                0,
                Math.ceil(rect.height)
            );

        if (!height) {
            return currentHeight;
        }

        if (height === currentHeight) {
            return height;
        }

        currentHeight = height;

        document.documentElement
            .style
            .setProperty(
                HEADER_HEIGHT_PROPERTY,
                `${height}px`
            );

        document.dispatchEvent(
            new CustomEvent(
                "speciedex:header-resize",
                {
                    detail: {
                        header,
                        height
                    }
                }
            )
        );

        return height;
    }

    function requestHeaderMeasurement() {
        window.requestAnimationFrame(
            () => {
                updateHeaderHeight();
            }
        );
    }

    /*
    ==========================================================================
    Header Size Observer
    ==========================================================================
    */

    function observeHeaderSize() {
        detachHeaderObserver();

        if (
            !header ||
            typeof ResizeObserver !==
            "function"
        ) {
            return;
        }

        resizeObserver =
            new ResizeObserver(
                () => {
                    updateHeaderHeight();
                }
            );

        resizeObserver.observe(
            header
        );
    }

    function detachHeaderObserver() {
        resizeObserver?.disconnect();
        resizeObserver = null;
    }

    /*
    ==========================================================================
    Include Loader Integration
    ==========================================================================
    */

    function handleIncludeLoaded(event) {
        const includeName =
            String(
                event.detail?.name || ""
            ).toLowerCase();

        if (
            includeName !== "header" &&
            includeName !== "nav"
        ) {
            return;
        }

        const nextHeader =
            findHeader();

        if (!nextHeader) {
            return;
        }

        if (nextHeader !== header) {
            detachHeaderObserver();

            header = nextHeader;

            observeHeaderSize();
        }

        requestHeaderMeasurement();
        updateScrollState();
    }

    /*
    ==========================================================================
    Refresh Header
    ==========================================================================
    */

    function refreshHeader() {
        const nextHeader =
            findHeader();

        if (!nextHeader) {
            return;
        }

        if (nextHeader !== header) {
            detachHeaderObserver();

            header = nextHeader;

            observeHeaderSize();
        }

        updateHeaderHeight();
        updateScrollState();
    }

    /*
    ==========================================================================
    Destroy Header
    ==========================================================================
    */

    function destroyHeader() {
        if (!initialized) {
            return;
        }

        window.removeEventListener(
            "scroll",
            requestScrollUpdate
        );

        window.removeEventListener(
            "resize",
            requestHeaderMeasurement
        );

        window.removeEventListener(
            "orientationchange",
            requestHeaderMeasurement
        );

        document.removeEventListener(
            "speciedex:include-loaded",
            handleIncludeLoaded
        );

        if (animationFrame !== null) {
            window.cancelAnimationFrame(
                animationFrame
            );

            animationFrame = null;
        }

        detachHeaderObserver();

        if (header) {
            header.classList.remove(
                SCROLLED_CLASS
            );
        }

        document.body.classList.remove(
            BODY_HEADER_CLASS,
            SCROLLED_CLASS
        );

        document.documentElement
            .style
            .removeProperty(
                HEADER_HEIGHT_PROPERTY
            );

        header = null;
        currentHeight = 0;
        initialized = false;
    }

    /*
    ==========================================================================
    Public API
    ==========================================================================
    */

    Speciedex.initializeHeader =
        initializeHeader;

    Speciedex.refreshHeader =
        refreshHeader;

    Speciedex.updateHeaderHeight =
        updateHeaderHeight;

    Speciedex.destroyHeader =
        destroyHeader;
})();
