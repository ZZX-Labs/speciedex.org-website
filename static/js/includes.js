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
    • Load page components from /_partials/pages/<page>/
    • Resolve the current page from window.location.pathname
    • Support exact numbered bundles through data-page-count
    • Support optional manifest.json files for descriptive component filenames
    • Fall back to automatic 01.html, 02.html, 03.html discovery
    • Preserve successful page components when another component fails
    • Support nested flat and page includes
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

Explicit page and component-count example:

    <div
        data-page-includes="home"
        data-page-count="14"
    ></div>

Page-directory mappings:

    /                         -> /_partials/pages/root/
    /home/                    -> /_partials/pages/home/
    /landing-page/            -> /_partials/pages/landing-page/
    /legal/privacy-policy/    -> /_partials/pages/legal/privacy-policy/

Automatic numbered components:

    /_partials/pages/home/01.html
    /_partials/pages/home/02.html
    /_partials/pages/home/03.html
    ...

When data-page-count is absent, the loader first uses manifest.json when it is
available. If the manifest is not present, it discovers contiguous numbered
files and stops at the first missing number.

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

    const VERSION = "3.3.0";

    const INCLUDE_SELECTOR =
        "[data-include]";

    const PAGE_INCLUDE_SELECTOR =
        "[data-page-includes]";

    const COMBINED_SELECTOR =
        `${INCLUDE_SELECTOR}, ${PAGE_INCLUDE_SELECTOR}`;

    const INCLUDE_PATTERN =
        /^[a-z0-9_-]+$/i;

    const PAGE_PATTERN =
        /^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/i;

    const COMPONENT_PATTERN =
        /^[a-z0-9][a-z0-9._-]*\.html$/i;

    const PARTIAL_ROOT =
        "/_partials/";

    const PAGE_PARTIAL_ROOT =
        "/_partials/pages/";

    const PAGE_MANIFEST_NAME =
        "manifest.json";

    const DEFAULT_PAGE_START =
        1;

    const DEFAULT_PAGE_WIDTH =
        2;

    const MAX_INCLUDE_DEPTH =
        12;

    const MAX_PAGE_COMPONENTS =
        256;

    const DEFAULT_OPTIONS =
        Object.freeze({
            cache:
                "no-store",
            credentials:
                "same-origin"
        });

    /*
    ==========================================================================
    Internal State
    ==========================================================================
    */

    const pendingRequests =
        new Map();

    const pendingElements =
        new WeakMap();

    const activeEvents =
        new Set();

    let initializationPromise =
        null;

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

        const elements = [];

        if (
            root instanceof Element &&
            root.matches(COMBINED_SELECTOR)
        ) {
            elements.push(root);
        }

        elements.push(
            ...root.querySelectorAll(
                COMBINED_SELECTOR
            )
        );

        const uniqueElements =
            Array.from(
                new Set(elements)
            );

        const results = [];

        for (const element of uniqueElements) {
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
                        results.filter(
                            result => !result
                        ).length
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
            return pendingElements.get(
                element
            );
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
                                name,
                            accept:
                                "text/html"
                        }
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
                pendingElements.delete(
                    element
                );
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
            return pendingElements.get(
                element
            );
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

        const pageDirectoryURL =
            getPageDirectoryURL(
                pageName
            );

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
                pageDirectoryURL,
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
                pageDirectoryURL,
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

        const operation = (async () => {
            try {
                dispatchIncludeEvent(
                    "speciedex:page-includes-loading",
                    {
                        pageName,
                        pageDirectoryURL,
                        element
                    }
                );

                const plan =
                    await resolvePageComponentPlan(
                        element,
                        pageName,
                        options
                    );

                const componentResults =
                    await loadPageComponentPlan(
                        pageName,
                        plan,
                        options
                    );

                if (componentResults.length === 0) {
                    throw new Error(
                        `No page components were found for "${pageName}" in ${pageDirectoryURL}.`
                    );
                }

                const fragment =
                    document.createDocumentFragment();

                let loadedCount = 0;
                let failedCount = 0;
                let skippedCount = 0;

                for (const result of componentResults) {
                    if (result.ok) {
                        const template =
                            document.createElement(
                                "template"
                            );

                        template.innerHTML =
                            result.html;

                        fragment.append(
                            template.content
                        );

                        loadedCount += 1;
                        continue;
                    }

                    if (result.optional) {
                        skippedCount += 1;
                        continue;
                    }

                    const template =
                        document.createElement(
                            "template"
                        );

                    template.innerHTML =
                        createPageComponentErrorHTML(
                            pageName,
                            result.file,
                            result.error
                        );

                    fragment.append(
                        template.content
                    );

                    failedCount += 1;
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
                    failedCount > 0
                        ? "loaded-with-errors"
                        : "loaded";

                element.dataset.pageDiscoveryMode =
                    plan.mode;

                element.dataset.pageComponentCount =
                    String(
                        componentResults.length
                    );

                element.dataset.pageComponentLoadedCount =
                    String(
                        loadedCount
                    );

                element.dataset.pageComponentFailedCount =
                    String(
                        failedCount
                    );

                element.dataset.pageComponentSkippedCount =
                    String(
                        skippedCount
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
                    pageDirectoryURL,
                    element,
                    plan,
                    components:
                        componentResults,
                    loaded:
                        loadedCount,
                    failed:
                        failedCount,
                    skipped:
                        skippedCount
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
                    pageDirectoryURL,
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
                pendingElements.delete(
                    element
                );
            }
        }
    }

    /*
    ==========================================================================
    Resolve Page Component Plan
    ==========================================================================
    */

    async function resolvePageComponentPlan(
        element,
        pageName,
        options = {}
    ) {
        const explicitCount =
            parsePositiveInteger(
                element.dataset.pageCount
            );

        const start =
            parsePositiveInteger(
                element.dataset.pageStart
            ) || DEFAULT_PAGE_START;

        const width =
            parsePositiveInteger(
                element.dataset.pageWidth
            ) || DEFAULT_PAGE_WIDTH;

        if (
            explicitCount >
            MAX_PAGE_COMPONENTS
        ) {
            throw new RangeError(
                `Page "${pageName}" requests ${explicitCount} components, exceeding the ${MAX_PAGE_COMPONENTS}-component limit.`
            );
        }

        if (explicitCount > 0) {
            return {
                mode:
                    "exact-count",
                pageName,
                entries:
                    createNumberedEntries(
                        explicitCount,
                        start,
                        width
                    )
            };
        }

        const manifestMode =
            normalizeManifestMode(
                element.getAttribute(
                    "data-page-manifest"
                )
            );

        if (manifestMode !== "off") {
            try {
                const manifest =
                    await fetchPageManifest(
                        getPageManifestURL(
                            pageName
                        ),
                        pageName,
                        options
                    );

                return {
                    mode:
                        "manifest",
                    pageName,
                    manifest,
                    entries:
                        manifest.components
                };
            } catch (error) {
                const missingManifest =
                    isHTTPStatus(
                        error,
                        404
                    );

                if (
                    manifestMode === "required" ||
                    !missingManifest
                ) {
                    if (
                        manifestMode === "required"
                    ) {
                        throw error;
                    }

                    console.warn(
                        `Unable to use the optional page manifest for "${pageName}". Falling back to numbered discovery.`,
                        error
                    );
                }
            }
        }

        return {
            mode:
                "numbered-discovery",
            pageName,
            start,
            width,
            entries:
                []
        };
    }

    /*
    ==========================================================================
    Load Page Component Plan
    ==========================================================================
    */

    async function loadPageComponentPlan(
        pageName,
        plan,
        options = {}
    ) {
        if (
            plan.mode ===
            "numbered-discovery"
        ) {
            return discoverNumberedPageComponents(
                pageName,
                plan.start,
                plan.width,
                options
            );
        }

        return fetchPageComponents(
            pageName,
            plan.entries,
            options
        );
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
            parsed =
                JSON.parse(text);
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
                    parsed?.page ||
                    pageName
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
            file =
                entry;
        } else if (
            entry &&
            typeof entry === "object" &&
            !Array.isArray(entry)
        ) {
            file =
                entry.file || "";

            optional =
                entry.optional === true;
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
            file:
                safeFile,
            optional
        };
    }

    /*
    ==========================================================================
    Create Numbered Component Entries
    ==========================================================================
    */

    function createNumberedEntries(
        count,
        start = DEFAULT_PAGE_START,
        width = DEFAULT_PAGE_WIDTH
    ) {
        const safeCount =
            parsePositiveInteger(
                count
            );

        const safeStart =
            parsePositiveInteger(
                start
            );

        const safeWidth =
            parsePositiveInteger(
                width
            );

        if (
            !safeCount ||
            !safeStart ||
            !safeWidth
        ) {
            throw new TypeError(
                "Invalid numbered page-component configuration."
            );
        }

        return Array.from(
            {
                length:
                    safeCount
            },
            (_, offset) => ({
                file:
                    formatPageComponentFile(
                        safeStart + offset,
                        safeWidth
                    ),
                optional:
                    false
            })
        );
    }

    /*
    ==========================================================================
    Fetch Known Page Components Concurrently
    ==========================================================================
    */

    async function fetchPageComponents(
        pageName,
        components,
        options = {}
    ) {
        const settled =
            await Promise.allSettled(
                components.map(
                    component =>
                        fetchOnePageComponent(
                            pageName,
                            component,
                            options
                        )
                )
            );

        return settled.map(
            (result, index) => {
                const component =
                    components[index];

                if (
                    result.status ===
                    "fulfilled"
                ) {
                    return result.value;
                }

                return {
                    ...component,
                    url:
                        getPageComponentURL(
                            pageName,
                            component.file
                        ),
                    html:
                        "",
                    ok:
                        false,
                    error:
                        result.reason
                };
            }
        );
    }

    /*
    ==========================================================================
    Discover Numbered Page Components
    ==========================================================================
    */

    async function discoverNumberedPageComponents(
        pageName,
        start = DEFAULT_PAGE_START,
        width = DEFAULT_PAGE_WIDTH,
        options = {}
    ) {
        const results = [];

        for (
            let index = start;
            index <
            start + MAX_PAGE_COMPONENTS;
            index += 1
        ) {
            const component = {
                file:
                    formatPageComponentFile(
                        index,
                        width
                    ),
                optional:
                    false
            };

            try {
                const result =
                    await fetchOnePageComponent(
                        pageName,
                        component,
                        options
                    );

                results.push(
                    result
                );
            } catch (error) {
                if (
                    isHTTPStatus(
                        error,
                        404
                    )
                ) {
                    break;
                }

                results.push({
                    ...component,
                    url:
                        getPageComponentURL(
                            pageName,
                            component.file
                        ),
                    html:
                        "",
                    ok:
                        false,
                    error
                });

                break;
            }
        }

        return results;
    }

    /*
    ==========================================================================
    Fetch One Page Component
    ==========================================================================
    */

    async function fetchOnePageComponent(
        pageName,
        component,
        options = {}
    ) {
        const url =
            getPageComponentURL(
                pageName,
                component.file
            );

        const html =
            await fetchTextResource(
                url,
                {
                    ...options,
                    resourceType:
                        "page-component",
                    resourceName:
                        `${pageName}/${component.file}`,
                    accept:
                        "text/html",
                    rejectFullDocument:
                        true
                }
            );

        return {
            ...component,
            url,
            html,
            ok:
                true,
            error:
                null
        };
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
        const requestKey =
            createRequestKey(
                url,
                options
            );

        if (
            pendingRequests.has(
                requestKey
            )
        ) {
            return pendingRequests.get(
                requestKey
            );
        }

        const request =
            requestTextResource(
                url,
                options
            );

        pendingRequests.set(
            requestKey,
            request
        );

        try {
            return await request;
        } finally {
            if (
                pendingRequests.get(
                    requestKey
                ) === request
            ) {
                pendingRequests.delete(
                    requestKey
                );
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
                    method:
                        "GET",
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
                        settings.signal ||
                        undefined
                }
            );

        if (!response.ok) {
            throw createHTTPError(
                response
            );
        }

        const text =
            await response.text();

        if (
            settings.rejectFullDocument === true &&
            looksLikeFullHTMLDocument(text)
        ) {
            const error =
                new Error(
                    `Expected an HTML fragment but received a complete document from ${response.url}.`
                );

            error.name =
                "PageComponentBoundaryError";

            error.status =
                404;

            error.statusText =
                "Component Not Found";

            error.url =
                response.url;

            throw error;
        }

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
    Request Utilities
    ==========================================================================
    */

    function createRequestKey(
        url,
        options = {}
    ) {
        return [
            String(url),
            String(options.accept || ""),
            options.rejectFullDocument === true
                ? "fragment"
                : "text"
        ].join("|");
    }

    function createHTTPError(
        response
    ) {
        const error =
            new Error(
                `HTTP ${response.status} ${response.statusText}: ${response.url}`
            );

        error.name =
            "HTTPError";

        error.status =
            response.status;

        error.statusText =
            response.statusText;

        error.url =
            response.url;

        return error;
    }

    function isHTTPStatus(
        error,
        status
    ) {
        return Boolean(
            error &&
            Number(error.status) ===
            Number(status)
        );
    }

    function looksLikeFullHTMLDocument(
        text
    ) {
        const sample =
            String(text || "")
                .replace(
                    /^\uFEFF/,
                    ""
                )
                .trimStart()
                .slice(0, 512)
                .toLowerCase();

        return (
            sample.startsWith(
                "<!doctype html"
            ) ||
            sample.startsWith(
                "<html"
            ) ||
            /<html[\s>]/i.test(sample)
        );
    }

    /*
    ==========================================================================
    Resolve Flat Partial URL
    ==========================================================================
    */

    function getIncludeURL(
        name
    ) {
        const safeName =
            sanitizeIncludeName(
                name
            );

        if (!safeName) {
            throw new TypeError(
                `Invalid include name: ${name}`
            );
        }

        return new URL(
            `${safeName}.html`,
            getFlatPartialRootURL()
        ).href;
    }

    /*
    ==========================================================================
    Resolve Page URLs
    ==========================================================================
    */

    function getPageDirectoryURL(
        pageName
    ) {
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
            `${safePageName}/`,
            getPagePartialRootURL()
        ).href;
    }

    function getPageManifestURL(
        pageName
    ) {
        return new URL(
            PAGE_MANIFEST_NAME,
            getPageDirectoryURL(
                pageName
            )
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
            safeComponentFile,
            getPageDirectoryURL(
                safePageName
            )
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
        if (
            Speciedex.pagePartialRootURL
        ) {
            return new URL(
                Speciedex.pagePartialRootURL,
                window.location.origin
            );
        }

        if (
            Speciedex.partialRootURL
        ) {
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

    function getPageNameFromPath(
        pathname
    ) {
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
                    segment
                        .trim()
                        .toLowerCase()
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
            segments[lastIndex].endsWith(
                ".html"
            ) ||
            segments[lastIndex].endsWith(
                ".htm"
            )
        ) {
            segments[lastIndex] =
                segments[lastIndex]
                    .replace(
                        /\.html?$/i,
                        ""
                    );
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
    Validation and Formatting
    ==========================================================================
    */

    function sanitizeIncludeName(
        value
    ) {
        const name =
            String(value ?? "")
                .trim()
                .toLowerCase();

        return INCLUDE_PATTERN.test(
            name
        )
            ? name
            : "";
    }

    function sanitizePageName(
        value
    ) {
        const name =
            String(value ?? "")
                .trim()
                .toLowerCase()
                .replace(
                    /^\/+|\/+$/g,
                    ""
                );

        return PAGE_PATTERN.test(
            name
        )
            ? name
            : "";
    }

    function sanitizeComponentFile(
        value
    ) {
        const file =
            String(value ?? "")
                .trim()
                .toLowerCase();

        return COMPONENT_PATTERN.test(
            file
        )
            ? file
            : "";
    }

    function parsePositiveInteger(
        value
    ) {
        const number =
            Number.parseInt(
                String(value ?? ""),
                10
            );

        return (
            Number.isSafeInteger(number) &&
            number > 0
        )
            ? number
            : 0;
    }

    function formatPageComponentFile(
        index,
        width = DEFAULT_PAGE_WIDTH
    ) {
        const safeIndex =
            parsePositiveInteger(
                index
            );

        const safeWidth =
            parsePositiveInteger(
                width
            );

        if (!safeIndex || !safeWidth) {
            throw new TypeError(
                `Invalid page-component number: ${index}`
            );
        }

        return `${String(
            safeIndex
        ).padStart(
            safeWidth,
            "0"
        )}.html`;
    }

    function normalizeManifestMode(
        value
    ) {
        if (value === null) {
            return "auto";
        }

        const mode =
            String(value)
                .trim()
                .toLowerCase();

        if (
            mode === "false" ||
            mode === "off" ||
            mode === "none" ||
            mode === "0"
        ) {
            return "off";
        }

        if (
            mode === "required" ||
            mode === "true" ||
            mode === "1"
        ) {
            return "required";
        }

        return "auto";
    }

    /*
    ==========================================================================
    Error Markup
    ==========================================================================
    */

    function createPageComponentErrorHTML(
        pageName,
        file,
        error
    ) {
        const status =
            Number(error?.status || 0);

        const statusText =
            status > 0
                ? `HTTP ${status}`
                : "request failed";

        return `
            <section
                class="section include-error"
                role="alert"
                data-page-component-error="${escapeHTML(file)}"
            >
                <header class="section-heading">
                    <h2>Page Component Unavailable</h2>
                </header>
                <p>
                    Unable to load
                    <code>${escapeHTML(pageName)}/${escapeHTML(file)}</code>
                    (${escapeHTML(statusText)}).
                </p>
            </section>
        `;
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
                sourceURL:
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
                    bubbles:
                        true,
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
        sourceURL,
        error
    ) {
        console.error(
            `Unable to load page includes for "${pageName}" from ${sourceURL}:`,
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
            sourceURL,
            element,
            error
        };

        element.dispatchEvent(
            new CustomEvent(
                "speciedex:page-includes-error",
                {
                    bubbles:
                        true,
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
            typeof root.querySelectorAll !==
            "function"
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

    function escapeHTML(
        value
    ) {
        return String(value)
            .replaceAll(
                "&",
                "&amp;"
            )
            .replaceAll(
                "<",
                "&lt;"
            )
            .replaceAll(
                ">",
                "&gt;"
            )
            .replaceAll(
                '"',
                "&quot;"
            )
            .replaceAll(
                "'",
                "&#039;"
            );
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

        if (
            activeEvents.has(
                eventName
            )
        ) {
            return false;
        }

        activeEvents.add(
            eventName
        );

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
            activeEvents.delete(
                eventName
            );
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
            initializationPromise =
                null;
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

    Speciedex.fetchPageManifest =
        fetchPageManifest;

    Speciedex.getIncludeURL =
        getIncludeURL;

    Speciedex.getPageDirectoryURL =
        getPageDirectoryURL;

    Speciedex.getPageManifestURL =
        getPageManifestURL;

    Speciedex.getPageComponentURL =
        getPageComponentURL;

    Speciedex.resolvePageName =
        resolvePageName;

    Speciedex.getPageNameFromPath =
        getPageNameFromPath;

    Speciedex.formatPageComponentFile =
        formatPageComponentFile;

    Speciedex.createPageComponentErrorHTML =
        createPageComponentErrorHTML;

    Speciedex.initializeIncludes =
        initializeIncludes;

    Speciedex.includesStatus =
        () => ({
            version:
                VERSION,
            initialized:
                Speciedex.includesInitialized ===
                true,
            pendingRequests:
                pendingRequests.size,
            initializing:
                Boolean(
                    initializationPromise
                ),
            partialRootURL:
                getFlatPartialRootURL().href,
            pagePartialRootURL:
                getPagePartialRootURL().href,
            currentPageName:
                getPageNameFromPath(
                    window.location.pathname
                ),
            pageDiscovery:
                "exact-count, optional-manifest, numbered-fallback"
        });
})();
