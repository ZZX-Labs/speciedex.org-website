"use strict";

/*
==============================================================================
Speciedex.org
HTML Include Loader
==============================================================================

Loaded by:

    /static/js/script.js

Responsibilities:

    • Load reusable flat partials such as header, nav, splash, and footer
    • Load page-specific component bundles from /_partials/pages/<page>/
    • Resolve the current page automatically from window.location.pathname
    • Read each page's generated manifest.json in display order
    • Support nested includes
    • Prevent duplicate simultaneous requests
    • Validate partial, page, and component names
    • Guard against recursive include loops
    • Dispatch include and page-component lifecycle events

Flat partial examples:

    <div data-include="header"></div>
    <div data-include="splash"></div>
    <div data-include="footer"></div>

Automatic page-component example:

    <main class="container">
        <div data-page-includes></div>
    </main>

Explicit page-component override:

    <div data-page-includes="root"></div>

The automatic page mount derives these mappings:

    /                         -> /_partials/pages/root/manifest.json
    /home/                    -> /_partials/pages/home/manifest.json
    /landing-page/            -> /_partials/pages/landing-page/manifest.json
    /legal/privacy-policy/    -> /_partials/pages/legal/privacy-policy/manifest.json

A page manifest contains an ordered component list:

    {
        "page": "root",
        "components": [
            "01-open-species-index.html",
            "02-what-is-speciedex.html"
        ]
    }

Static hosting cannot enumerate a directory at runtime. The manifest is therefore
required, but it is generated automatically by:

    python static/tools/build-page-partial-manifests.py

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

    const VERSION = "3.0.0";

    const INCLUDE_SELECTOR = "[data-include]";
    const PAGE_INCLUDE_SELECTOR = "[data-page-includes]";
    const COMBINED_SELECTOR =
        `${INCLUDE_SELECTOR}, ${PAGE_INCLUDE_SELECTOR}`;

    const INCLUDE_PATTERN = /^[a-z0-9_-]+$/i;
    const PAGE_PATTERN =
        /^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/i;
    const COMPONENT_PATTERN =
        /^[a-z0-9][a-z0-9._-]*\.html$/i;

    const PARTIAL_ROOT = "/_partials/";
    const PAGE_PARTIAL_ROOT = "/_partials/pages/";
    const PAGE_MANIFEST_NAME = "manifest.json";

    const MAX_INCLUDE_DEPTH = 12;
    const MAX_PAGE_COMPONENTS = 256;

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
    const pendingElements = new WeakMap();
    const activeEvents = new Set();

    let initializationPromise = null;

    /*
    ==========================================================================
    Load All Flat and Page Includes
    ==========================================================================
    */

    async function loadIncludes(
        root = document,
        options = {}
    ) {
        if (
            !root ||
            typeof root.querySelectorAll !== "function"
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

        const includes = [];

        if (
            root instanceof Element &&
            root.matches(COMBINED_SELECTOR)
        ) {
            includes.push(root);
        }

        includes.push(
            ...root.querySelectorAll(
                COMBINED_SELECTOR
            )
        );

        const results = [];

        for (const element of includes) {
            let result = null;

            if (
                element.hasAttribute(
                    "data-page-includes"
                )
            ) {
                result =
                    await loadPageIncludes(
                        element,
                        {
                            ...options,
                            depth
                        }
                    );
            } else {
                result =
                    await loadInclude(
                        element,
                        {
                            ...options,
                            depth
                        }
                    );
            }

            results.push(result);
        }

        if (depth === 0) {
            dispatchIncludeEvent(
                "speciedex:includes-ready",
                {
                    root,
                    results,
                    loaded:
                        results.filter(Boolean).length,
                    failed:
                        results.filter(result => !result).length
                }
            );
        }

        return results;
    }

    /*
    ==========================================================================
    Load One Flat Include
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
            pendingElements.has(element)
        ) {
            return pendingElements.get(element);
        }

        if (
            element.dataset.includeState ===
            "loading"
        ) {
            element.dataset.includeState = "";
        }

        const depth =
            Number(options.depth || 0);

        const ancestry =
            Array.isArray(options.ancestry)
                ? options.ancestry
                : [];

        const ancestryKey =
            `partial:${name}`;

        if (ancestry.includes(ancestryKey)) {
            const error =
                new Error(
                    `Recursive include loop detected: ${[
                        ...ancestry,
                        ancestryKey
                    ].join(" -> ")}`
                );

            handleIncludeError(
                element,
                name,
                getIncludeURL(name),
                error
            );

            return null;
        }

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

        const operation = (async () => {
            try {
                const html =
                    await fetchTextResource(
                        url,
                        {
                            ...options,
                            resourceType:
                                "include",
                            resourceName:
                                name
                        }
                    );

                element.innerHTML = html;

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

                await loadIncludes(
                    element,
                    {
                        ...options,
                        depth:
                            depth + 1,
                        ancestry:
                            [
                                ...ancestry,
                                ancestryKey
                            ]
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
        })();

        pendingElements.set(
            element,
            operation
        );

        try {
            return await operation;
        } finally {
            if (
                pendingElements.get(element) ===
                operation
            ) {
                pendingElements.delete(element);
            }
        }
    }

    /*
    ==========================================================================
    Load One Page Component Bundle
    ==========================================================================
    */

    async function loadPageIncludes(
        element,
        options = {}
    ) {
        if (!(element instanceof Element)) {
            return null;
        }

        if (
            element.dataset.pageIncludeState ===
            "loaded"
        ) {
            return element;
        }

        if (
            pendingElements.has(element)
        ) {
            return pendingElements.get(element);
        }

        if (
            element.dataset.pageIncludeState ===
            "loading"
        ) {
            element.dataset.pageIncludeState = "";
        }

        const rawPageName =
            element.getAttribute(
                "data-page-includes"
            ) || "";

        const pageName =
            resolvePageName(
                rawPageName
            );

        if (!pageName) {
            handleInvalidPageInclude(
                element,
                rawPageName
            );

            return null;
        }

        const depth =
            Number(options.depth || 0);

        const ancestry =
            Array.isArray(options.ancestry)
                ? options.ancestry
                : [];

        const ancestryKey =
            `page:${pageName}`;

        if (ancestry.includes(ancestryKey)) {
            const error =
                new Error(
                    `Recursive page include loop detected: ${[
                        ...ancestry,
                        ancestryKey
                    ].join(" -> ")}`
                );

            handlePageIncludeError(
                element,
                pageName,
                getPageManifestURL(pageName),
                error
            );

            return null;
        }

        if (depth >= MAX_INCLUDE_DEPTH) {
            const error =
                new Error(
                    `Maximum include depth reached while loading page "${pageName}".`
                );

            handlePageIncludeError(
                element,
                pageName,
                getPageManifestURL(pageName),
                error
            );

            return null;
        }

        element.dataset.pageIncludeState =
            "loading";

        element.dataset.pageName =
            pageName;

        element.setAttribute(
            "aria-busy",
            "true"
        );

        const manifestURL =
            getPageManifestURL(
                pageName
            );

        const operation = (async () => {
            try {
                dispatchIncludeEvent(
                    "speciedex:page-includes-loading",
                    {
                        pageName,
                        manifestURL,
                        element
                    }
                );

                const manifest =
                    await fetchPageManifest(
                        manifestURL,
                        pageName,
                        options
                    );

                const componentResults =
                    await fetchPageComponents(
                        pageName,
                        manifest.components,
                        options
                    );

                const failedRequired =
                    componentResults.filter(
                        result =>
                            !result.ok &&
                            !result.optional
                    );

                if (failedRequired.length > 0) {
                    throw new AggregateError(
                        failedRequired.map(
                            result => result.error
                        ),
                        `Unable to load ${failedRequired.length} required component(s) for page "${pageName}".`
                    );
                }

                const fragment =
                    document.createDocumentFragment();

                for (const result of componentResults) {
                    if (!result.ok) {
                        continue;
                    }

                    const template =
                        document.createElement(
                            "template"
                        );

                    template.innerHTML =
                        result.html;

                    fragment.append(
                        template.content
                    );
                }

                element.replaceChildren(
                    fragment
                );

                element.removeAttribute(
                    "data-page-includes"
                );

                element.dataset.pageName =
                    pageName;

                element.dataset.pageIncludeState =
                    "loaded";

                element.dataset.pageComponentCount =
                    String(
                        componentResults.filter(
                            result => result.ok
                        ).length
                    );

                element.removeAttribute(
                    "aria-busy"
                );

                await loadIncludes(
                    element,
                    {
                        ...options,
                        depth:
                            depth + 1,
                        ancestry:
                            [
                                ...ancestry,
                                ancestryKey
                            ]
                    }
                );

                const detail = {
                    pageName,
                    manifestURL,
                    element,
                    manifest,
                    components:
                        componentResults
                };

                element.dispatchEvent(
                    new CustomEvent(
                        "speciedex:page-includes-loaded",
                        {
                            bubbles: true,
                            detail
                        }
                    )
                );

                document.dispatchEvent(
                    new CustomEvent(
                        "speciedex:page-includes-loaded-global",
                        {
                            detail
                        }
                    )
                );

                return element;
            } catch (error) {
                handlePageIncludeError(
                    element,
                    pageName,
                    manifestURL,
                    error
                );

                return null;
            }
        })();

        pendingElements.set(
            element,
            operation
        );

        try {
            return await operation;
        } finally {
            if (
                pendingElements.get(element) ===
                operation
            ) {
                pendingElements.delete(element);
            }
        }
    }

    /*
    ==========================================================================
    Fetch Page Manifest
    ==========================================================================
    */

    async function fetchPageManifest(
        url,
        pageName,
        options = {}
    ) {
        const text =
            await fetchTextResource(
                url,
                {
                    ...options,
                    resourceType:
                        "page-manifest",
                    resourceName:
                        pageName,
                    accept:
                        "application/json, text/json;q=0.9, */*;q=0.1"
                }
            );

        let parsed;

        try {
            parsed = JSON.parse(text);
        } catch (error) {
            throw new SyntaxError(
                `Invalid JSON in page manifest ${url}: ${error.message}`
            );
        }

        const rawComponents =
            Array.isArray(parsed)
                ? parsed
                : parsed?.components;

        if (!Array.isArray(rawComponents)) {
            throw new TypeError(
                `Page manifest ${url} must contain a "components" array.`
            );
        }

        if (
            rawComponents.length >
            MAX_PAGE_COMPONENTS
        ) {
            throw new RangeError(
                `Page manifest ${url} exceeds the ${MAX_PAGE_COMPONENTS}-component limit.`
            );
        }

        const components =
            rawComponents.map(
                (entry, index) =>
                    normalizeManifestEntry(
                        entry,
                        index,
                        url
                    )
            );

        return {
            page:
                sanitizePageName(
                    parsed?.page || pageName
                ) || pageName,
            components
        };
    }

    /*
    ==========================================================================
    Normalize Manifest Entry
    ==========================================================================
    */

    function normalizeManifestEntry(
        entry,
        index,
        manifestURL
    ) {
        let file = "";
        let optional = false;

        if (typeof entry === "string") {
            file = entry;
        } else if (
            entry &&
            typeof entry === "object" &&
            !Array.isArray(entry)
        ) {
            file = entry.file || "";
            optional = entry.optional === true;
        } else {
            throw new TypeError(
                `Invalid component entry at index ${index} in ${manifestURL}.`
            );
        }

        const safeFile =
            sanitizeComponentFile(
                file
            );

        if (!safeFile) {
            throw new TypeError(
                `Invalid component filename "${file}" at index ${index} in ${manifestURL}.`
            );
        }

        return {
            file: safeFile,
            optional
        };
    }

    /*
    ==========================================================================
    Fetch Page Components Concurrently, Preserve Manifest Order
    ==========================================================================
    */

    async function fetchPageComponents(
        pageName,
        components,
        options = {}
    ) {
        const requests =
            components.map(
                async component => {
                    const url =
                        getPageComponentURL(
                            pageName,
                            component.file
                        );

                    try {
                        const html =
                            await fetchTextResource(
                                url,
                                {
                                    ...options,
                                    resourceType:
                                        "page-component",
                                    resourceName:
                                        `${pageName}/${component.file}`
                                }
                            );

                        return {
                            ...component,
                            url,
                            html,
                            ok: true,
                            error: null
                        };
                    } catch (error) {
                        return {
                            ...component,
                            url,
                            html: "",
                            ok: false,
                            error
                        };
                    }
                }
            );

        return Promise.all(requests);
    }

    /*
    ==========================================================================
    Shared Request Cache
    ==========================================================================
    */

    async function fetchTextResource(
        url,
        options = {}
    ) {
        if (pendingRequests.has(url)) {
            return pendingRequests.get(url);
        }

        const request =
            requestTextResource(
                url,
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
    Perform HTTP Request
    ==========================================================================
    */

    async function requestTextResource(
        url,
        options = {}
    ) {
        const settings = {
            ...DEFAULT_OPTIONS,
            ...options
        };

        const resourceType =
            settings.resourceType ||
            "resource";

        const resourceName =
            settings.resourceName ||
            url;

        dispatchIncludeEvent(
            "speciedex:include-loading",
            {
                name:
                    resourceName,
                url,
                resourceType
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
                            settings.accept ||
                            "text/html"
                    },
                    signal:
                        settings.signal || undefined
                }
            );

        if (!response.ok) {
            throw new Error(
                `HTTP ${response.status} ${response.statusText}: ${response.url}`
            );
        }

        const text =
            await response.text();

        dispatchIncludeEvent(
            "speciedex:include-fetched",
            {
                name:
                    resourceName,
                url,
                resourceType
            }
        );

        return text;
    }

    /*
    ==========================================================================
    Resolve Flat Partial URL
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
            getFlatPartialRootURL();

        return new URL(
            `${safeName}.html`,
            root
        ).href;
    }

    /*
    ==========================================================================
    Resolve Page Manifest and Component URLs
    ==========================================================================
    */

    function getPageManifestURL(pageName) {
        const safePageName =
            sanitizePageName(
                pageName
            );

        if (!safePageName) {
            throw new TypeError(
                `Invalid page name: ${pageName}`
            );
        }

        return new URL(
            `${safePageName}/${PAGE_MANIFEST_NAME}`,
            getPagePartialRootURL()
        ).href;
    }

    function getPageComponentURL(
        pageName,
        componentFile
    ) {
        const safePageName =
            sanitizePageName(
                pageName
            );

        const safeComponentFile =
            sanitizeComponentFile(
                componentFile
            );

        if (!safePageName) {
            throw new TypeError(
                `Invalid page name: ${pageName}`
            );
        }

        if (!safeComponentFile) {
            throw new TypeError(
                `Invalid page component filename: ${componentFile}`
            );
        }

        return new URL(
            `${safePageName}/${safeComponentFile}`,
            getPagePartialRootURL()
        ).href;
    }

    function getFlatPartialRootURL() {
        return Speciedex.partialRootURL
            ? new URL(
                Speciedex.partialRootURL,
                window.location.origin
            )
            : new URL(
                PARTIAL_ROOT,
                window.location.origin
            );
    }

    function getPagePartialRootURL() {
        if (Speciedex.pagePartialRootURL) {
            return new URL(
                Speciedex.pagePartialRootURL,
                window.location.origin
            );
        }

        if (Speciedex.partialRootURL) {
            return new URL(
                "pages/",
                getFlatPartialRootURL()
            );
        }

        return new URL(
            PAGE_PARTIAL_ROOT,
            window.location.origin
        );
    }

    /*
    ==========================================================================
    Resolve Current Page Name
    ==========================================================================
    */

    function resolvePageName(
        explicitName = ""
    ) {
        const requested =
            String(explicitName ?? "")
                .trim()
                .toLowerCase();

        if (
            requested &&
            requested !== "auto" &&
            requested !== "true"
        ) {
            return sanitizePageName(
                requested
            );
        }

        return getPageNameFromPath(
            window.location.pathname
        );
    }

    function getPageNameFromPath(pathname) {
        let decodedPath = "";

        try {
            decodedPath =
                decodeURIComponent(
                    String(pathname || "/")
                );
        } catch {
            decodedPath =
                String(pathname || "/");
        }

        const segments =
            decodedPath
                .split("/")
                .map(segment =>
                    segment.trim().toLowerCase()
                )
                .filter(Boolean);

        if (segments.length === 0) {
            return "root";
        }

        const lastIndex =
            segments.length - 1;

        if (
            segments[lastIndex] === "index.html" ||
            segments[lastIndex] === "index.htm"
        ) {
            segments.pop();
        } else if (
            segments[lastIndex].endsWith(".html") ||
            segments[lastIndex].endsWith(".htm")
        ) {
            segments[lastIndex] =
                segments[lastIndex]
                    .replace(/\.html?$/i, "");
        }

        if (segments.length === 0) {
            return "root";
        }

        return sanitizePageName(
            segments.join("/")
        );
    }

    /*
    ==========================================================================
    Validation
    ==========================================================================
    */

    function sanitizeIncludeName(value) {
        const name =
            String(value ?? "")
                .trim()
                .toLowerCase();

        return INCLUDE_PATTERN.test(name)
            ? name
            : "";
    }

    function sanitizePageName(value) {
        const name =
            String(value ?? "")
                .trim()
                .toLowerCase()
                .replace(/^\/+|\/+$/g, "");

        return PAGE_PATTERN.test(name)
            ? name
            : "";
    }

    function sanitizeComponentFile(value) {
        const file =
            String(value ?? "")
                .trim()
                .toLowerCase();

        return COMPONENT_PATTERN.test(file)
            ? file
            : "";
    }

    /*
    ==========================================================================
    Invalid Flat Include Handling
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
    Invalid Page Include Handling
    ==========================================================================
    */

    function handleInvalidPageInclude(
        element,
        rawPageName
    ) {
        console.warn(
            "Speciedex rejected an invalid page include name:",
            rawPageName
        );

        element.dataset.pageIncludeState =
            "invalid";

        element.removeAttribute(
            "aria-busy"
        );

        element.innerHTML = `
            <div
                class="include-error"
                role="alert"
            >
                Invalid page include.
            </div>
        `;

        dispatchIncludeEvent(
            "speciedex:page-includes-error",
            {
                pageName:
                    String(rawPageName || ""),
                manifestURL:
                    null,
                element,
                error:
                    new TypeError(
                        "Invalid page include name."
                    )
            }
        );
    }

    /*
    ==========================================================================
    Failed Flat Include Handling
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
    Failed Page Include Handling
    ==========================================================================
    */

    function handlePageIncludeError(
        element,
        pageName,
        manifestURL,
        error
    ) {
        console.error(
            `Unable to load page includes for "${pageName}" from ${manifestURL}:`,
            error
        );

        element.innerHTML = `
            <div
                class="include-error"
                role="alert"
            >
                Unable to load page content for ${escapeHTML(pageName)}.
            </div>
        `;

        element.dataset.pageIncludeState =
            "error";

        element.dataset.pageName =
            pageName;

        element.removeAttribute(
            "aria-busy"
        );

        const detail = {
            pageName,
            manifestURL,
            element,
            error
        };

        element.dispatchEvent(
            new CustomEvent(
                "speciedex:page-includes-error",
                {
                    bubbles: true,
                    detail
                }
            )
        );

        document.dispatchEvent(
            new CustomEvent(
                "speciedex:page-includes-error-global",
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
            typeof root.querySelectorAll !== "function"
        ) {
            return [];
        }

        const failed =
            Array.from(
                root.querySelectorAll(
                    [
                        '[data-include][data-include-state="error"]',
                        '[data-page-includes][data-page-include-state="error"]'
                    ].join(", ")
                )
            );

        const results = [];

        for (const element of failed) {
            if (
                element.hasAttribute(
                    "data-page-includes"
                )
            ) {
                element.dataset.pageIncludeState =
                    "";

                results.push(
                    await loadPageIncludes(
                        element
                    )
                );
            } else {
                element.dataset.includeState =
                    "";

                results.push(
                    await loadInclude(
                        element
                    )
                );
            }
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
        const eventName =
            String(name || "");

        if (activeEvents.has(eventName)) {
            return false;
        }

        activeEvents.add(eventName);

        try {
            document.dispatchEvent(
                new CustomEvent(
                    eventName,
                    {
                        detail
                    }
                )
            );

            return true;
        } finally {
            activeEvents.delete(eventName);
        }
    }

    /*
    ==========================================================================
    Module Initializer
    ==========================================================================
    */

    async function initializeIncludes(
        root = document,
        options = {}
    ) {
        if (initializationPromise) {
            return initializationPromise;
        }

        initializationPromise = (async () => {
            const results =
                await loadIncludes(
                    root,
                    options
                );

            Speciedex.includesInitialized =
                true;

            return results;
        })();

        try {
            return await initializationPromise;
        } finally {
            initializationPromise = null;
        }
    }

    /*
    ==========================================================================
    Public API
    ==========================================================================
    */

    Speciedex.includesVersion =
        VERSION;

    Speciedex.pageIncludesVersion =
        VERSION;

    Speciedex.loadIncludes =
        loadIncludes;

    Speciedex.loadInclude =
        loadInclude;

    Speciedex.loadPageIncludes =
        loadPageIncludes;

    Speciedex.retryFailedIncludes =
        retryFailedIncludes;

    Speciedex.getIncludeURL =
        getIncludeURL;

    Speciedex.getPageManifestURL =
        getPageManifestURL;

    Speciedex.getPageComponentURL =
        getPageComponentURL;

    Speciedex.resolvePageName =
        resolvePageName;

    Speciedex.getPageNameFromPath =
        getPageNameFromPath;

    Speciedex.initializeIncludes =
        initializeIncludes;

    Speciedex.includesStatus =
        () => ({
            version:
                VERSION,
            initialized:
                Speciedex.includesInitialized === true,
            pendingRequests:
                pendingRequests.size,
            initializing:
                Boolean(initializationPromise),
            partialRootURL:
                getFlatPartialRootURL().href,
            pagePartialRootURL:
                getPagePartialRootURL().href,
            currentPageName:
                getPageNameFromPath(
                    window.location.pathname
                )
        });
})();
