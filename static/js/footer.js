"use strict";

/*
==============================================================================
Speciedex.org
Footer Module
==============================================================================

Loaded by:

    /static/js/script.js

Responsibilities:

    • Initialize the site footer
    • Insert the current year
    • Normalize external links
    • Publish footer height to CSS
    • Respond to dynamically loaded footer partials
    • Support safe reinitialization and cleanup

==============================================================================
*/

(() => {
    const Speciedex =
        window.Speciedex =
        window.Speciedex || {};

    if (Speciedex.footerModuleLoaded) {
        return;
    }

    Speciedex.footerModuleLoaded = true;

    /*
    ==========================================================================
    Selectors / Properties
    ==========================================================================
    */

    const FOOTER_SELECTOR =
        "[data-site-footer], .site-footer, .footer";

    const YEAR_SELECTOR =
        "[data-current-year], #current-year";

    const FOOTER_HEIGHT_PROPERTY =
        "--site-footer-height";

    /*
    ==========================================================================
    Internal State
    ==========================================================================
    */

    let footer = null;
    let resizeObserver = null;
    let initialized = false;
    let currentHeight = 0;

    /*
    ==========================================================================
    Resolve Footer
    ==========================================================================
    */

    function findFooter() {
        return document.querySelector(
            FOOTER_SELECTOR
        );
    }

    /*
    ==========================================================================
    Initialize Footer
    ==========================================================================
    */

    function initializeFooter() {
        const nextFooter =
            findFooter();

        if (!nextFooter) {
            initializeCurrentYear();
            initializeExternalLinks();
            return;
        }

        if (
            initialized &&
            nextFooter === footer
        ) {
            initializeCurrentYear();
            initializeExternalLinks(
                footer
            );
            updateFooterHeight();
            return;
        }

        if (initialized) {
            destroyFooter();
        }

        footer = nextFooter;
        initialized = true;

        document.body.classList.add(
            "has-site-footer"
        );

        initializeCurrentYear();
        initializeExternalLinks(
            footer
        );
        updateFooterHeight();
        observeFooterSize();

        window.addEventListener(
            "resize",
            requestFooterMeasurement,
            {
                passive: true
            }
        );

        window.addEventListener(
            "orientationchange",
            requestFooterMeasurement
        );

        document.addEventListener(
            "speciedex:include-loaded",
            handleIncludeLoaded
        );

        document.dispatchEvent(
            new CustomEvent(
                "speciedex:footer-ready",
                {
                    detail: {
                        footer,
                        height:
                            currentHeight
                    }
                }
            )
        );
    }

    /*
    ==========================================================================
    Current Year
    ==========================================================================
    */

    function initializeCurrentYear(
        root = document
    ) {
        if (
            !root ||
            typeof root.querySelectorAll !==
            "function"
        ) {
            return;
        }

        const year =
            String(
                new Date().getFullYear()
            );

        root.querySelectorAll(
            YEAR_SELECTOR
        ).forEach(
            (element) => {
                if (
                    element.textContent !==
                    year
                ) {
                    element.textContent =
                        year;
                }
            }
        );
    }

    /*
    ==========================================================================
    External Links
    ==========================================================================
    */

    function initializeExternalLinks(
        root = footer || document
    ) {
        if (
            !root ||
            typeof root.querySelectorAll !==
            "function"
        ) {
            return;
        }

        root.querySelectorAll(
            "a[href]"
        ).forEach(
            (link) => {
                let url;

                try {
                    url =
                        new URL(
                            link.getAttribute(
                                "href"
                            ),
                            window.location.href
                        );
                } catch {
                    return;
                }

                if (
                    url.protocol !== "http:" &&
                    url.protocol !== "https:"
                ) {
                    return;
                }

                if (
                    url.origin ===
                    window.location.origin
                ) {
                    link.classList.remove(
                        "external-link"
                    );

                    link.removeAttribute(
                        "data-external-link"
                    );

                    return;
                }

                link.classList.add(
                    "external-link"
                );

                link.setAttribute(
                    "data-external-link",
                    ""
                );

                if (
                    link.target === "_blank"
                ) {
                    const rel =
                        new Set(
                            String(
                                link.rel || ""
                            )
                                .split(/\s+/)
                                .filter(Boolean)
                        );

                    rel.add(
                        "noopener"
                    );

                    rel.add(
                        "noreferrer"
                    );

                    link.rel =
                        Array.from(rel)
                            .join(" ");
                }
            }
        );
    }

    /*
    ==========================================================================
    Footer Height
    ==========================================================================
    */

    function updateFooterHeight() {
        if (!footer) {
            return 0;
        }

        const rect =
            footer.getBoundingClientRect();

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
                FOOTER_HEIGHT_PROPERTY,
                `${height}px`
            );

        document.dispatchEvent(
            new CustomEvent(
                "speciedex:footer-resize",
                {
                    detail: {
                        footer,
                        height
                    }
                }
            )
        );

        return height;
    }

    function requestFooterMeasurement() {
        window.requestAnimationFrame(
            () => {
                updateFooterHeight();
            }
        );
    }

    /*
    ==========================================================================
    Footer Resize Observer
    ==========================================================================
    */

    function observeFooterSize() {
        detachFooterObserver();

        if (
            !footer ||
            typeof ResizeObserver !==
            "function"
        ) {
            return;
        }

        resizeObserver =
            new ResizeObserver(
                () => {
                    updateFooterHeight();
                }
            );

        resizeObserver.observe(
            footer
        );
    }

    function detachFooterObserver() {
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
            includeName !== "footer"
        ) {
            return;
        }

        const nextFooter =
            findFooter();

        if (!nextFooter) {
            return;
        }

        if (
            nextFooter !== footer
        ) {
            detachFooterObserver();

            footer = nextFooter;

            observeFooterSize();
        }

        initializeCurrentYear(
            footer
        );

        initializeExternalLinks(
            footer
        );

        requestFooterMeasurement();
    }

    /*
    ==========================================================================
    Refresh Footer
    ==========================================================================
    */

    function refreshFooter() {
        const nextFooter =
            findFooter();

        if (!nextFooter) {
            initializeCurrentYear();
            initializeExternalLinks();
            return;
        }

        if (
            nextFooter !== footer
        ) {
            detachFooterObserver();

            footer = nextFooter;

            observeFooterSize();
        }

        initializeCurrentYear(
            footer
        );

        initializeExternalLinks(
            footer
        );

        updateFooterHeight();
    }

    /*
    ==========================================================================
    Destroy Footer
    ==========================================================================
    */

    function destroyFooter() {
        if (!initialized) {
            return;
        }

        window.removeEventListener(
            "resize",
            requestFooterMeasurement
        );

        window.removeEventListener(
            "orientationchange",
            requestFooterMeasurement
        );

        document.removeEventListener(
            "speciedex:include-loaded",
            handleIncludeLoaded
        );

        detachFooterObserver();

        document.body.classList.remove(
            "has-site-footer"
        );

        document.documentElement
            .style
            .removeProperty(
                FOOTER_HEIGHT_PROPERTY
            );

        footer = null;
        currentHeight = 0;
        initialized = false;
    }

    /*
    ==========================================================================
    Public API
    ==========================================================================
    */

    Speciedex.initializeFooter =
        initializeFooter;

    Speciedex.refreshFooter =
        refreshFooter;

    Speciedex.initializeCurrentYear =
        initializeCurrentYear;

    Speciedex.initializeExternalLinks =
        initializeExternalLinks;

    Speciedex.updateFooterHeight =
        updateFooterHeight;

    Speciedex.destroyFooter =
        destroyFooter;
})();
