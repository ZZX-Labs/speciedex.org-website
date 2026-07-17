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
    • Optionally expose footer height to CSS
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

    const FOOTER_SELECTOR =
        "[data-site-footer], .site-footer";

    const YEAR_SELECTOR =
        "[data-current-year], #current-year";

    const FOOTER_HEIGHT_PROPERTY =
        "--site-footer-height";

    let footer = null;
    let resizeObserver = null;
    let initialized = false;

    /*
    --------------------------------------------------------------------------
    Initialize the footer.
    --------------------------------------------------------------------------
    */

    function initializeFooter() {
        const nextFooter =
            document.querySelector(
                FOOTER_SELECTOR
            );

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
            initializeExternalLinks();
            updateFooterHeight();
            return;
        }

        if (initialized) {
            destroyFooter();
        }

        footer = nextFooter;
        initialized = true;

        initializeCurrentYear();
        initializeExternalLinks();
        updateFooterHeight();
        observeFooterSize();

        window.addEventListener(
            "resize",
            updateFooterHeight,
            {
                passive: true
            }
        );

        document.addEventListener(
            "speciedex:include-loaded",
            handleIncludeLoaded
        );

        document.body.classList.add(
            "has-site-footer"
        );
    }

    /*
    --------------------------------------------------------------------------
    Insert the current year.
    --------------------------------------------------------------------------
    */

    function initializeCurrentYear() {
        const year =
            new Date().getFullYear();

        document.querySelectorAll(
            YEAR_SELECTOR
        ).forEach((element) => {
            element.textContent =
                String(year);
        });
    }

    /*
    --------------------------------------------------------------------------
    Mark and secure external links.
    --------------------------------------------------------------------------
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
        ).forEach((link) => {
            let url;

            try {
                url = new URL(
                    link.href,
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
                return;
            }

            link.classList.add(
                "external-link"
            );

            if (
                link.target === "_blank"
            ) {
                const rel = new Set(
                    String(link.rel)
                        .split(/\s+/)
                        .filter(Boolean)
                );

                rel.add("noopener");
                rel.add("noreferrer");

                link.rel =
                    Array.from(rel).join(" ");
            }

            if (
                !link.hasAttribute(
                    "data-external-link"
                )
            ) {
                link.setAttribute(
                    "data-external-link",
                    ""
                );
            }
        });
    }

    /*
    --------------------------------------------------------------------------
    Publish footer height for CSS layout use.
    --------------------------------------------------------------------------
    */

    function updateFooterHeight() {
        if (!footer) {
            return;
        }

        const height =
            Math.ceil(
                footer.getBoundingClientRect()
                    .height
            );

        document.documentElement.style.setProperty(
            FOOTER_HEIGHT_PROPERTY,
            `${height}px`
        );
    }

    /*
    --------------------------------------------------------------------------
    Observe footer dimension changes.
    --------------------------------------------------------------------------
    */

    function observeFooterSize() {
        if (
            typeof ResizeObserver !==
            "function" ||
            !footer
        ) {
            return;
        }

        resizeObserver?.disconnect();

        resizeObserver =
            new ResizeObserver(() => {
                updateFooterHeight();
            });

        resizeObserver.observe(footer);
    }

    /*
    --------------------------------------------------------------------------
    Reinitialize when footer-related partials load.
    --------------------------------------------------------------------------
    */

    function handleIncludeLoaded(event) {
        const includeName =
            event.detail?.name;

        if (includeName !== "footer") {
            return;
        }

        const nextFooter =
            document.querySelector(
                FOOTER_SELECTOR
            );

        if (
            nextFooter &&
            nextFooter !== footer
        ) {
            footer = nextFooter;
            observeFooterSize();
        }

        initializeCurrentYear();
        initializeExternalLinks();
        updateFooterHeight();
    }

    /*
    --------------------------------------------------------------------------
    Cleanup.
    --------------------------------------------------------------------------
    */

    function destroyFooter() {
        if (!initialized) {
            return;
        }

        window.removeEventListener(
            "resize",
            updateFooterHeight
        );

        document.removeEventListener(
            "speciedex:include-loaded",
            handleIncludeLoaded
        );

        resizeObserver?.disconnect();

        resizeObserver = null;
        footer = null;
        initialized = false;

        document.body.classList.remove(
            "has-site-footer"
        );

        document.documentElement.style
            .removeProperty(
                FOOTER_HEIGHT_PROPERTY
            );
    }

    /*
    --------------------------------------------------------------------------
    Public module API.
    --------------------------------------------------------------------------
    */

    Speciedex.initializeFooter =
        initializeFooter;

    Speciedex.initializeCurrentYear =
        initializeCurrentYear;

    Speciedex.initializeExternalLinks =
        initializeExternalLinks;

    Speciedex.updateFooterHeight =
        updateFooterHeight;

    Speciedex.destroyFooter =
        destroyFooter;
})();
