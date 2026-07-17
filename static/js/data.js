"use strict";

/*
==============================================================================
Speciedex.org
Data Module
==============================================================================

Loaded by:

    /static/js/script.js

Responsibilities:

    • Resolve files under /static/data/
    • Fetch and parse JSON documents
    • Prevent duplicate simultaneous requests
    • Optionally cache completed requests
    • Validate expected JSON structures
    • Provide shared number and date formatting
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

    const DATA_ROOT =
        "/static/data/";

    const DEFAULT_OPTIONS = {
        cache: false,
        requestCache: "no-store",
        credentials: "same-origin"
    };

    /*
    --------------------------------------------------------------------------
    Completed response cache.

    Stores parsed JSON values when cache: true is requested.
    --------------------------------------------------------------------------
    */

    const responseCache =
        new Map();

    /*
    --------------------------------------------------------------------------
    Active request cache.

    Prevents multiple modules from downloading the same file simultaneously.
    --------------------------------------------------------------------------
    */

    const pendingRequests =
        new Map();

    /*
    --------------------------------------------------------------------------
    Validate a data filename.

    Allowed examples:

        statistics.json
        releases/latest.json
        status/network.json
    --------------------------------------------------------------------------
    */

    function normalizeDataPath(value) {
        const path =
            String(value || "")
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
            !/^[a-z0-9/_-]+\.json$/i.test(path)
        ) {
            throw new TypeError(
                `Invalid data path: ${value}`
            );
        }

        return path;
    }

    /*
    --------------------------------------------------------------------------
    Resolve a JSON file beneath /static/data/.
    --------------------------------------------------------------------------
    */

    function getDataURL(filename) {
        const path =
            normalizeDataPath(filename);

        return new URL(
            `${DATA_ROOT}${path}`,
            window.location.origin
        ).href;
    }

    /*
    --------------------------------------------------------------------------
    Fetch and parse a JSON data file.

    Options:

        cache:
            Store the parsed response in memory.

        refresh:
            Ignore and replace any cached response.

        requestCache:
            Browser fetch cache policy.

        signal:
            Optional AbortSignal.

        validate:
            Optional function receiving parsed JSON.
            It must return true or throw an error.
    --------------------------------------------------------------------------
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

        if (
            !settings.refresh &&
            pendingRequests.has(url)
        ) {
            return pendingRequests.get(url);
        }

        const request =
            requestJSON(
                url,
                filename,
                settings
            );

        pendingRequests.set(
            url,
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
            pendingRequests.delete(url);
        }
    }

    /*
    --------------------------------------------------------------------------
    Perform one JSON request.
    --------------------------------------------------------------------------
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
                    `HTTP ${response.status}: ${response.url}`
                );
            }

            const contentType =
                response.headers.get(
                    "content-type"
                ) || "";

            if (
                !contentType
                    .toLowerCase()
                    .includes(
                        "application/json"
                    )
            ) {
                console.warn(
                    `Expected JSON from ${response.url}, ` +
                    `but received "${contentType || "unknown"}".`
                );
            }

            const data =
                await response.json();

            if (
                typeof settings.validate ===
                "function"
            ) {
                const valid =
                    settings.validate(data);

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
    --------------------------------------------------------------------------
    Return true when a value is a plain JSON object.
    --------------------------------------------------------------------------
    */

    function isPlainObject(value) {
        return (
            value !== null &&
            typeof value === "object" &&
            !Array.isArray(value)
        );
    }

    /*
    --------------------------------------------------------------------------
    Require a plain JSON object.
    --------------------------------------------------------------------------
    */

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

    /*
    --------------------------------------------------------------------------
    Require a JSON array.
    --------------------------------------------------------------------------
    */

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
    --------------------------------------------------------------------------
    Read a nested object value using a dot-separated path.

    Example:

        getValue(data, "network.nodes.total", 0)
    --------------------------------------------------------------------------
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
                : String(path)
                    .split(".")
                    .filter(Boolean);

        let value = source;

        for (const key of keys) {
            if (
                value === null ||
                value === undefined ||
                !Object.prototype
                    .hasOwnProperty
                    .call(value, key)
            ) {
                return fallback;
            }

            value = value[key];
        }

        return value;
    }

    /*
    --------------------------------------------------------------------------
    Format a numeric value for display.
    --------------------------------------------------------------------------
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
            return "Unavailable";
        }

        const number =
            Number(value);

        if (!Number.isFinite(number)) {
            return String(value);
        }

        return number.toLocaleString(
            options.locale || "en-US",
            options.format || {}
        );
    }

    /*
    --------------------------------------------------------------------------
    Format a date for display.
    --------------------------------------------------------------------------
    */

    function formatDate(
        value,
        options = {}
    ) {
        if (!value) {
            return "Unavailable";
        }

        const date =
            new Date(value);

        if (
            Number.isNaN(
                date.getTime()
            )
        ) {
            return String(value);
        }

        return date.toLocaleDateString(
            options.locale || "en-US",
            {
                year: "numeric",
                month: "long",
                day: "numeric",
                timeZone: "UTC",
                ...(options.format || {})
            }
        );
    }

    /*
    --------------------------------------------------------------------------
    Format a date and time for display.
    --------------------------------------------------------------------------
    */

    function formatDateTime(
        value,
        options = {}
    ) {
        if (!value) {
            return "Unavailable";
        }

        const date =
            new Date(value);

        if (
            Number.isNaN(
                date.getTime()
            )
        ) {
            return String(value);
        }

        return date.toLocaleString(
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
        );
    }

    /*
    --------------------------------------------------------------------------
    Write a value into an element.
    --------------------------------------------------------------------------
    */

    function setText(
        element,
        value,
        fallback = "Unavailable"
    ) {
        if (!element) {
            return;
        }

        if (
            value === undefined ||
            value === null ||
            value === ""
        ) {
            element.textContent =
                fallback;

            return;
        }

        element.textContent =
            String(value);
    }

    /*
    --------------------------------------------------------------------------
    Mark selected elements unavailable.
    --------------------------------------------------------------------------
    */

    function setUnavailable(
        elements,
        value = "Unavailable"
    ) {
        const collection =
            Array.isArray(elements)
                ? elements
                : Object.values(
                    elements || {}
                );

        collection.forEach((element) => {
            if (element) {
                element.textContent =
                    value;
            }
        });
    }

    /*
    --------------------------------------------------------------------------
    Clear one cached response or the complete response cache.
    --------------------------------------------------------------------------
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

    /*
    --------------------------------------------------------------------------
    Dispatch a document-level data event.
    --------------------------------------------------------------------------
    */

    function dispatchDataEvent(
        name,
        detail
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
    --------------------------------------------------------------------------
    Public data API.
    --------------------------------------------------------------------------
    */

    Speciedex.Data = Object.freeze({
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
            clearDataCache
    });

    /*
    --------------------------------------------------------------------------
    Compatibility aliases for direct module access.
    --------------------------------------------------------------------------
    */

    Speciedex.getDataURL =
        getDataURL;

    Speciedex.fetchJSON =
        fetchJSON;

    Speciedex.clearDataCache =
        clearDataCache;
})();
