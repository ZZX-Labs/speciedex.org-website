"use strict";

/*
==============================================================================
Speciedex.org
Data Module
==============================================================================

Loaded by:

    /static/js/script.js

Responsibilities:

    • Resolve files beneath /static/data/
    • Fetch and parse JSON documents
    • Prevent duplicate simultaneous requests
    • Optionally cache completed requests
    • Validate expected JSON structures
    • Provide shared number and date formatting
    • Provide safe DOM text helpers
    • Dispatch data lifecycle events

Feature modules such as statistics.js, releases.js, status.js, and activity.js
use this module instead of implementing their own fetch logic.

==============================================================================
*/

(() => {
    const Speciedex =
        window.Speciedex =
        window.Speciedex || {};

    if (Speciedex.dataModuleLoaded) {
        return;
    }

    Speciedex.dataModuleLoaded = true;

    /*
    ==========================================================================
    Configuration
    ==========================================================================
    */

    const DATA_ROOT = "/static/data/";

    const DEFAULT_OPTIONS = Object.freeze({
        cache: false,
        refresh: false,
        requestCache: "no-store",
        credentials: "same-origin",
        validate: null,
        signal: undefined
    });

    /*
    ==========================================================================
    Internal State
    ==========================================================================
    */

    const responseCache = new Map();
    const pendingRequests = new Map();

    /*
    ==========================================================================
    Normalize Data Path
    ==========================================================================
    */

    function normalizeDataPath(value) {
        const path =
            String(value ?? "")
                .trim()
                .replace(/^\/+/, "");

        if (!path) {
            throw new TypeError(
                "A data filename is required."
            );
        }

        if (
            path.includes("..") ||
            path.includes("\\") ||
            path.includes("//") ||
            !/^[a-z0-9/_-]+\.json$/i.test(path)
        ) {
            throw new TypeError(
                `Invalid data path: ${value}`
            );
        }

        return path;
    }

    /*
    ==========================================================================
    Resolve Data URL
    ==========================================================================
    */

    function getDataURL(filename) {
        const path =
            normalizeDataPath(filename);

        const root =
            Speciedex.dataRootURL
                ? new URL(
                    Speciedex.dataRootURL,
                    window.location.origin
                )
                : new URL(
                    DATA_ROOT,
                    window.location.origin
                );

        return new URL(
            path,
            root
        ).href;
    }

    /*
    ==========================================================================
    Request Key
    ==========================================================================
    */

    function getRequestKey(
        url,
        settings
    ) {
        return [
            url,
            settings.requestCache,
            settings.credentials
        ].join("|");
    }

    /*
    ==========================================================================
    Fetch JSON
    ==========================================================================
    */

    async function fetchJSON(
        filename,
        options = {}
    ) {
        const settings = {
            ...DEFAULT_OPTIONS,
            ...options
        };

        const url =
            getDataURL(filename);

        if (
            settings.cache &&
            !settings.refresh &&
            responseCache.has(url)
        ) {
            return responseCache.get(url);
        }

        const requestKey =
            getRequestKey(
                url,
                settings
            );

        if (
            !settings.refresh &&
            pendingRequests.has(requestKey)
        ) {
            return pendingRequests.get(
                requestKey
            );
        }

        const request =
            requestJSON(
                url,
                filename,
                settings
            );

        pendingRequests.set(
            requestKey,
            request
        );

        try {
            const data =
                await request;

            if (settings.cache) {
                responseCache.set(
                    url,
                    data
                );
            }

            return data;
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
    Perform JSON Request
    ==========================================================================
    */

    async function requestJSON(
        url,
        filename,
        settings
    ) {
        dispatchDataEvent(
            "speciedex:data-loading",
            {
                filename,
                url
            }
        );

        try {
            const response =
                await fetch(
                    url,
                    {
                        method: "GET",
                        cache:
                            settings.requestCache,
                        credentials:
                            settings.credentials,
                        signal:
                            settings.signal,
                        headers: {
                            Accept:
                                "application/json"
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
                    "application/json"
                ) &&
                !contentType.includes(
                    "+json"
                )
            ) {
                console.warn(
                    `Expected JSON from ${response.url}, but received "${contentType}".`
                );
            }

            let data;

            try {
                data =
                    await response.json();
            } catch (error) {
                throw new SyntaxError(
                    `Invalid JSON returned by ${response.url}: ${error.message}`
                );
            }

            if (
                typeof settings.validate ===
                "function"
            ) {
                const valid =
                    await settings.validate(
                        data
                    );

                if (valid === false) {
                    throw new TypeError(
                        `Validation failed for ${filename}.`
                    );
                }
            }

            dispatchDataEvent(
                "speciedex:data-loaded",
                {
                    filename,
                    url,
                    data
                }
            );

            return data;
        } catch (error) {
            dispatchDataEvent(
                "speciedex:data-error",
                {
                    filename,
                    url,
                    error
                }
            );

            throw error;
        }
    }

    /*
    ==========================================================================
    Data Type Helpers
    ==========================================================================
    */

    function isPlainObject(value) {
        if (
            value === null ||
            typeof value !== "object" ||
            Array.isArray(value)
        ) {
            return false;
        }

        const prototype =
            Object.getPrototypeOf(value);

        return (
            prototype ===
                Object.prototype ||
            prototype ===
                null
        );
    }

    function requireObject(
        value,
        label = "JSON data"
    ) {
        if (!isPlainObject(value)) {
            throw new TypeError(
                `${label} must be an object.`
            );
        }

        return value;
    }

    function requireArray(
        value,
        label = "JSON data"
    ) {
        if (!Array.isArray(value)) {
            throw new TypeError(
                `${label} must be an array.`
            );
        }

        return value;
    }

    /*
    ==========================================================================
    Nested Value Access
    ==========================================================================
    */

    function getValue(
        source,
        path,
        fallback = null
    ) {
        if (
            source === null ||
            source === undefined
        ) {
            return fallback;
        }

        const keys =
            Array.isArray(path)
                ? path
                : String(path ?? "")
                    .split(".")
                    .filter(Boolean);

        if (!keys.length) {
            return source;
        }

        let value = source;

        for (const key of keys) {
            if (
                value === null ||
                value === undefined ||
                !Object.prototype
                    .hasOwnProperty
                    .call(
                        Object(value),
                        key
                    )
            ) {
                return fallback;
            }

            value = value[key];
        }

        return value;
    }

    /*
    ==========================================================================
    Number Formatting
    ==========================================================================
    */

    function formatNumber(
        value,
        options = {}
    ) {
        if (
            value === undefined ||
            value === null ||
            value === ""
        ) {
            return options.fallback ??
                "Unavailable";
        }

        const number =
            Number(value);

        if (!Number.isFinite(number)) {
            return String(value);
        }

        return new Intl.NumberFormat(
            options.locale || "en-US",
            options.format || {}
        ).format(number);
    }

    /*
    ==========================================================================
    Date Formatting
    ==========================================================================
    */

    function parseDate(value) {
        if (
            value === undefined ||
            value === null ||
            value === ""
        ) {
            return null;
        }

        const date =
            value instanceof Date
                ? new Date(
                    value.getTime()
                )
                : new Date(value);

        if (
            Number.isNaN(
                date.getTime()
            )
        ) {
            return null;
        }

        return date;
    }

    function formatDate(
        value,
        options = {}
    ) {
        const date =
            parseDate(value);

        if (!date) {
            return (
                value
                    ? String(value)
                    : options.fallback ??
                        "Unavailable"
            );
        }

        return new Intl.DateTimeFormat(
            options.locale || "en-US",
            {
                year: "numeric",
                month: "long",
                day: "numeric",
                timeZone: "UTC",
                ...(options.format || {})
            }
        ).format(date);
    }

    function formatDateTime(
        value,
        options = {}
    ) {
        const date =
            parseDate(value);

        if (!date) {
            return (
                value
                    ? String(value)
                    : options.fallback ??
                        "Unavailable"
            );
        }

        return new Intl.DateTimeFormat(
            options.locale || "en-US",
            {
                year: "numeric",
                month: "long",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
                timeZone: "UTC",
                timeZoneName: "short",
                ...(options.format || {})
            }
        ).format(date);
    }

    /*
    ==========================================================================
    DOM Text Helpers
    ==========================================================================
    */

    function setText(
        element,
        value,
        fallback = "Unavailable"
    ) {
        if (!(element instanceof Element)) {
            return;
        }

        element.textContent =
            value === undefined ||
            value === null ||
            value === ""
                ? fallback
                : String(value);
    }

    function setUnavailable(
        elements,
        value = "Unavailable"
    ) {
        if (!elements) {
            return;
        }

        const collection =
            Array.isArray(elements)
                ? elements
                : (
                    elements instanceof
                        NodeList ||
                    elements instanceof
                        HTMLCollection
                )
                    ? Array.from(elements)
                    : Object.values(
                        elements
                    );

        collection.forEach(
            (element) => {
                setText(
                    element,
                    value,
                    value
                );
            }
        );
    }

    /*
    ==========================================================================
    Cache Management
    ==========================================================================
    */

    function clearDataCache(
        filename = null
    ) {
        if (!filename) {
            responseCache.clear();
            return;
        }

        responseCache.delete(
            getDataURL(filename)
        );
    }

    function hasCachedData(filename) {
        return responseCache.has(
            getDataURL(filename)
        );
    }

    /*
    ==========================================================================
    Event Dispatch
    ==========================================================================
    */

    function dispatchDataEvent(
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

    async function initializeData() {
        if (Speciedex.dataInitialized) {
            return;
        }

        Speciedex.dataInitialized = true;

        dispatchDataEvent(
            "speciedex:data-ready",
            {
                root:
                    getDataURL(
                        "_probe.json"
                    ).replace(
                        "_probe.json",
                        ""
                    )
            }
        );
    }

    /*
    ==========================================================================
    Public Data API
    ==========================================================================
    */

    Speciedex.Data =
        Object.freeze({
            getURL:
                getDataURL,

            fetchJSON,

            isPlainObject,

            requireObject,

            requireArray,

            getValue,

            formatNumber,

            formatDate,

            formatDateTime,

            setText,

            setUnavailable,

            clearCache:
                clearDataCache,

            hasCache:
                hasCachedData
        });

    /*
    ==========================================================================
    Compatibility Aliases
    ==========================================================================
    */

    Speciedex.getDataURL =
        getDataURL;

    Speciedex.fetchJSON =
        fetchJSON;

    Speciedex.clearDataCache =
        clearDataCache;

    Speciedex.initializeData =
        initializeData;
})();
