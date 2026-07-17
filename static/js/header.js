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
    • Add scroll-state classes
    • Keep header measurements available to CSS
    • Respond to viewport and include changes
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

    const HEADER_SELECTOR =
        "[data-site-header], .site-header";

    const SCROLLED_CLASS =
        "header-scrolled";

    const BODY_HEADER_CLASS =
        "has-site-header";

    const HEADER_HEIGHT_PROPERTY =
        "--site-header-height";

    let initialized = false;
    let header = null;
    let resizeObserver = null;
    let ticking = false;

    /*
    --------------------------------------------------------------------------
    Initialize the site header.
    --------------------------------------------------------------------------
    */

    function initializeHeader() {
        header = document.querySelector(
            HEADER_SELECTOR
        );

        if (!header) {
            return;
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
            updateHeaderHeight,
            {
                passive: true
            }
        );

        observeHeaderSize();

        document.addEventListener(
            "speciedex:include-loaded",
            handleIncludeLoaded
        );
    }

    /*
    --------------------------------------------------------------------------
    Update the header state based on page scroll position.
    --------------------------------------------------------------------------
    */

    function updateScrollState() {
        if (!header) {
            return;
        }

        const scrolled =
            window.scrollY > 0;

        header.classList.toggle(
            SCROLLED_CLASS,
            scrolled
        );

        document.body.classList.toggle(
            SCROLLED_CLASS,
            scrolled
        );

        ticking = false;
    }

    /*
    --------------------------------------------------------------------------
    Throttle scroll updates with requestAnimationFrame.
    --------------------------------------------------------------------------
    */

    function requestScrollUpdate() {
        if (ticking) {
            return;
        }

        ticking = true;

        window.requestAnimationFrame(
            updateScrollState
        );
    }

    /*
    --------------------------------------------------------------------------
    Publish the current header height as a CSS custom property.
    --------------------------------------------------------------------------
    */

    function updateHeaderHeight() {
        if (!header) {
            return;
        }

        const height =
            Math.ceil(
                header.getBoundingClientRect()
                    .height
            );

        document.documentElement.style.setProperty(
            HEADER_HEIGHT_PROPERTY,
            `${height}px`
        );
    }

    /*
    --------------------------------------------------------------------------
    Watch for header size changes.
    --------------------------------------------------------------------------
    */

    function observeHeaderSize() {
        if (
            typeof ResizeObserver !==
            "function"
        ) {
            return;
        }

        resizeObserver?.disconnect();

        resizeObserver =
            new ResizeObserver(() => {
                updateHeaderHeight();
            });

        resizeObserver.observe(header);
    }

    /*
    --------------------------------------------------------------------------
    Recheck the header when a partial has been loaded.
    --------------------------------------------------------------------------
    */

    function handleIncludeLoaded(event) {
        const includeName =
            event.detail?.name;

        if (
            includeName !== "header" &&
            includeName !== "nav"
        ) {
            return;
        }

        const nextHeader =
            document.querySelector(
                HEADER_SELECTOR
            );

        if (
            nextHeader &&
            nextHeader !== header
        ) {
            header = nextHeader;
            observeHeaderSize();
        }

        updateHeaderHeight();
        updateScrollState();
    }

    /*
    --------------------------------------------------------------------------
    Clean up listeners and observers.
    --------------------------------------------------------------------------
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
            updateHeaderHeight
        );

        document.removeEventListener(
            "speciedex:include-loaded",
            handleIncludeLoaded
        );

        resizeObserver?.disconnect();

        resizeObserver = null;
        header = null;
        initialized = false;
        ticking = false;

        document.body.classList.remove(
            BODY_HEADER_CLASS,
            SCROLLED_CLASS
        );

        document.documentElement.style
            .removeProperty(
                HEADER_HEIGHT_PROPERTY
            );
    }

    /*
    --------------------------------------------------------------------------
    Public module API.
    --------------------------------------------------------------------------
    */

    Speciedex.initializeHeader =
        initializeHeader;

    Speciedex.updateHeaderHeight =
        updateHeaderHeight;

    Speciedex.destroyHeader =
        destroyHeader;
})();
