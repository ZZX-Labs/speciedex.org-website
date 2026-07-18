"use strict";

/*
==============================================================================
Speciedex.org
HTML Include Loader
==============================================================================

Loaded by:

    /static/js/script.js

Responsibilities:

    • Load reusable HTML partials
    • Resolve /_partials/{name}.html
    • Support nested includes
    • Prevent duplicate simultaneous partial requests
    • Validate include names
    • Guard against recursive include loops
    • Dispatch include lifecycle events

Example:

    <div data-include="header"></div>
    <div data-include="splash"></div>
    <div data-include="nav"></div>
    <div data-include="footer"></div>

==============================================================================
*/

(() => {
    const Speciedex =
        window.Speciedex =
        window.Speciedex || {};

    if (Speciedex.includesModuleLoaded) {
        return;
    }

    Speciedex.includesModuleLoaded = true;

    /*
    ==========================================================================
    Configuration
    ==========================================================================
    */

    const INCLUDE_SELECTOR = "[data-include]";
    const INCLUDE_PATTERN = /^[a-z0-9_-]+$/i;
    const PARTIAL_ROOT = "/_partials/";
    const MAX_INCLUDE_DEPTH = 12;

    const DEFAULT_OPTIONS = Object.freeze({
        cache: "no-store",
        credentials: "same-origin"
    });

    /*
    ==========================================================================
    Internal State
    ==========================================================================
    */

    const pendingRequests = new Map();

    /*
    ==========================================================================
    Load All Includes
    ==========================================================================
    */

    async function loadIncludes(
        root = document,
        options = {}
    ) {
        if (
            !root ||
            typeof root.querySelectorAll !==
            "function"
        ) {
            return [];
        }

        const depth =
            Number(options.depth || 0);

        if (depth > MAX_INCLUDE_DEPTH) {
            throw new Error(
                `Maximum include depth of ${MAX_INCLUDE_DEPTH} exceeded.`
            );
        }

        const includes =
            Array.from(
                root.querySelectorAll(
                    INCLUDE_SELECTOR
                )
            );

        const results = [];

        for (const element of includes) {
            const result =
                await loadInclude(
                    element,
                    {
                        ...options,
                        depth
                    }
                );

            results.push(result);
        }

        return results;
    }

    /*
    ==========================================================================
    Load One Include
    ==========================================================================
    */

    async function loadInclude(
        element,
        options = {}
    ) {
        if (!(element instanceof Element)) {
            return null;
        }

        const rawName =
            element.dataset.include || "";

        const name =
            sanitizeIncludeName(
                rawName
            );

        if (!name) {
            handleInvalidInclude(
                element,
                rawName
            );

            return null;
        }

        if (
            element.dataset.includeState ===
            "loaded"
        ) {
            return element;
        }

        if (
            element.dataset.includeState ===
            "loading"
        ) {
            return element;
        }

        const depth =
            Number(options.depth || 0);

        if (depth >= MAX_INCLUDE_DEPTH) {
            const error =
                new Error(
                    `Maximum include depth reached while loading "${name}".`
                );

            handleIncludeError(
                element,
                name,
                getIncludeURL(name),
                error
            );

            return null;
        }

        element.dataset.includeState =
            "loading";

        element.setAttribute(
            "aria-busy",
            "true"
        );

        const url =
            getIncludeURL(name);

        try {
            const html =
                await fetchIncludeHTML(
                    url,
                    name,
                    options
                );

            element.innerHTML =
                html;

            element.removeAttribute(
                "data-include"
            );

            element.dataset.includeName =
                name;

            element.dataset.includeState =
                "loaded";

            element.removeAttribute(
                "aria-busy"
            );

            /*
            ------------------------------------------------------------------
            Load nested includes inserted by this partial.
            ------------------------------------------------------------------
            */

            await loadIncludes(
                element,
                {
                    ...options,
                    depth:
                        depth + 1
                }
            );

            const detail = {
                name,
                url,
                element
            };

            element.dispatchEvent(
                new CustomEvent(
                    "speciedex:include-loaded",
                    {
                        bubbles: true,
                        detail
                    }
                )
            );

            document.dispatchEvent(
                new CustomEvent(
                    "speciedex:include-loaded-global",
                    {
                        detail
                    }
                )
            );

            return element;
        } catch (error) {
            handleIncludeError(
                element,
                name,
                url,
                error
            );

            return null;
        }
    }

    /*
    ==========================================================================
    Fetch Partial HTML
    ==========================================================================
    */

    async function fetchIncludeHTML(
        url,
        name,
        options = {}
    ) {
        if (
            pendingRequests.has(url)
        ) {
            return pendingRequests.get(
                url
            );
        }

        const request =
            requestIncludeHTML(
                url,
                name,
                options
            );

        pendingRequests.set(
            url,
            request
        );

        try {
            return await request;
        } finally {
            if (
                pendingRequests.get(url) ===
                request
            ) {
                pendingRequests.delete(url);
            }
        }
    }

    /*
    ==========================================================================
    Perform Include Request
    ==========================================================================
    */

    async function requestIncludeHTML(
        url,
        name,
        options = {}
    ) {
        const settings = {
            ...DEFAULT_OPTIONS,
            ...options
        };

        dispatchIncludeEvent(
            "speciedex:include-loading",
            {
                name,
                url
            }
        );

        const response =
            await fetch(
                url,
                {
                    method: "GET",
                    cache:
                        settings.cache,
                    credentials:
                        settings.credentials,
                    headers: {
                        Accept:
                            "text/html"
                    }
                }
            );

        if (!response.ok) {
            throw new Error(
                `HTTP ${response.status} ${response.statusText}: ${response.url}`
            );
        }

        const contentType =
            response.headers
                .get("content-type")
                ?.toLowerCase() || "";

        if (
            contentType &&
            !contentType.includes(
                "text/html"
            )
        ) {
            console.warn(
                `Expected HTML from ${response.url}, but received "${contentType}".`
            );
        }

        const html =
            await response.text();

        dispatchIncludeEvent(
            "speciedex:include-fetched",
            {
                name,
                url
            }
        );

        return html;
    }

    /*
    ==========================================================================
    Resolve Partial URL
    ==========================================================================
    */

    function getIncludeURL(name) {
        const safeName =
            sanitizeIncludeName(
                name
            );

        if (!safeName) {
            throw new TypeError(
                `Invalid include name: ${name}`
            );
        }

        const root =
            Speciedex.partialRootURL
                ? new URL(
                    Speciedex.partialRootURL,
                    window.location.origin
                )
                : new URL(
                    PARTIAL_ROOT,
                    window.location.origin
                );

        return new URL(
            `${safeName}.html`,
            root
        ).href;
    }

    /*
    ==========================================================================
    Validate Include Name
    ==========================================================================
    */

    function sanitizeIncludeName(
        value
    ) {
        const name =
            String(value ?? "")
                .trim()
                .toLowerCase();

        return INCLUDE_PATTERN.test(name)
            ? name
            : "";
    }

    /*
    ==========================================================================
    Invalid Include Handling
    ==========================================================================
    */

    function handleInvalidInclude(
        element,
        rawName
    ) {
        console.warn(
            "Speciedex rejected an invalid include name:",
            rawName
        );

        element.dataset.includeState =
            "invalid";

        element.removeAttribute(
            "aria-busy"
        );

        element.innerHTML = `
            <div
                class="include-error"
                role="alert"
            >
                Invalid include.
            </div>
        `;

        dispatchIncludeEvent(
            "speciedex:include-error",
            {
                name:
                    String(rawName || ""),
                url:
                    null,
                element,
                error:
                    new TypeError(
                        "Invalid include name."
                    )
            }
        );
    }

    /*
    ==========================================================================
    Failed Include Handling
    ==========================================================================
    */

    function handleIncludeError(
        element,
        name,
        url,
        error
    ) {
        console.error(
            `Unable to load include "${name}" from ${url}:`,
            error
        );

        element.innerHTML = `
            <div
                class="include-error"
                role="alert"
            >
                Unable to load ${escapeHTML(name)}.
            </div>
        `;

        element.dataset.includeState =
            "error";

        element.dataset.includeName =
            name;

        element.removeAttribute(
            "aria-busy"
        );

        /*
        ----------------------------------------------------------------------
        Preserve data-include so failed partials can be retried later.
        ----------------------------------------------------------------------
        */

        const detail = {
            name,
            url,
            element,
            error
        };

        element.dispatchEvent(
            new CustomEvent(
                "speciedex:include-error",
                {
                    bubbles: true,
                    detail
                }
            )
        );

        document.dispatchEvent(
            new CustomEvent(
                "speciedex:include-error-global",
                {
                    detail
                }
            )
        );
    }

    /*
    ==========================================================================
    Retry Failed Includes
    ==========================================================================
    */

    async function retryFailedIncludes(
        root = document
    ) {
        if (
            !root ||
            typeof root.querySelectorAll !==
            "function"
        ) {
            return [];
        }

        const failed =
            Array.from(
                root.querySelectorAll(
                    '[data-include][data-include-state="error"]'
                )
            );

        const results = [];

        for (const element of failed) {
            element.dataset.includeState =
                "";

            const result =
                await loadInclude(
                    element
                );

            results.push(result);
        }

        return results;
    }

    /*
    ==========================================================================
    Escape HTML
    ==========================================================================
    */

    function escapeHTML(value) {
        return String(value)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#039;");
    }

    /*
    ==========================================================================
    Event Dispatch
    ==========================================================================
    */

    function dispatchIncludeEvent(
        name,
        detail = {}
    ) {
        document.dispatchEvent(
            new CustomEvent(
                name,
                {
                    detail
                }
            )
        );
    }

    /*
    ==========================================================================
    Module Initializer
    ==========================================================================
    */

    async function initializeIncludes() {
        if (
            Speciedex.includesInitialized
        ) {
            return;
        }

        Speciedex.includesInitialized =
            true;
    }

    /*
    ==========================================================================
    Public API
    ==========================================================================
    */

    Speciedex.loadIncludes =
        loadIncludes;

    Speciedex.loadInclude =
        loadInclude;

    Speciedex.retryFailedIncludes =
        retryFailedIncludes;

    Speciedex.getIncludeURL =
        getIncludeURL;

    Speciedex.initializeIncludes =
        initializeIncludes;
})();
