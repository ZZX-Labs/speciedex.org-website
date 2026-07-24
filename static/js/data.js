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
    • Poll the live Speciedex database API for newly indexed taxa
    • Normalize SQLite and MariaDB API payloads
    • Maintain an incremental cursor
    • Feed new records into terminal-splash.js
    • Retry transient failures with bounded exponential backoff
    • Pause polling while the page is hidden
    • Persist stream cursor and recent deduplication keys
    • Expose live-stream status and controls

Browser JavaScript cannot directly open SQLite or MariaDB. This module consumes a
same-origin HTTP API backed by either database. The default endpoint is:

    /api/species/recent

The endpoint can be changed with any of the following, in priority order:

    window.Speciedex.liveDataEndpoint
    <html data-speciedex-live-data-endpoint="...">
    <body data-speciedex-live-data-endpoint="...">
    /api/species/recent

Expected query parameters:

    cursor      opaque cursor from the previous response
    after       ISO timestamp fallback when no cursor is available
    limit       maximum records requested
    provider    optional provider filter

Supported response shapes include:

    { records: [...], cursor: "...", has_more: true }
    { items: [...], next_cursor: "...", hasMore: true }
    { species: [...], updated_at: "..." }
    { data: { records: [...], cursor: "..." } }
    [...]

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
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
    Constants
    ==========================================================================
    */

    const MODULE_NAME =
        "Data";

    const VERSION =
        "2.1.0";

    const DATA_ROOT =
        "/static/data/";

    const DEFAULT_LIVE_ENDPOINT =
        "/api/species/recent";

    const DEFAULT_OPTIONS =
        Object.freeze({
            cache:
                false,

            refresh:
                false,

            requestCache:
                "no-store",

            credentials:
                "same-origin",

            validate:
                null,

            signal:
                undefined
        });

    const DEFAULT_STREAM_OPTIONS =
        Object.freeze({
            endpoint:
                DEFAULT_LIVE_ENDPOINT,

            interval:
                5000,

            hiddenInterval:
                30000,

            limit:
                128,

            batchLimit:
                4,

            timeout:
                15000,

            provider:
                "",

            autoplay:
                true,

            pauseWhenHidden:
                true,

            persistCursor:
                true,

            persistRecentKeys:
                true,

            recentKeyLimit:
                2048,

            initialLookback:
                300000,

            retryMinimum:
                2000,

            retryMaximum:
                60000,

            retryFactor:
                1.8,

            jitter:
                0.20,

            credentials:
                "same-origin",

            requestCache:
                "no-store"
        });

    const RECORD_ARRAY_KEYS =
        Object.freeze([
            "records",
            "items",
            "species",
            "taxa",
            "results",
            "rows",
            "entries",
            "additions",
            "updates"
        ]);

    const CURSOR_KEYS =
        Object.freeze([
            "cursor",
            "next_cursor",
            "nextCursor",
            "continuation",
            "continuation_token",
            "continuationToken",
            "watermark",
            "last_id",
            "lastId"
        ]);

    const HAS_MORE_KEYS =
        Object.freeze([
            "has_more",
            "hasMore",
            "more",
            "has_next",
            "hasNext"
        ]);

    /*
    ==========================================================================
    Internal State
    ==========================================================================
    */

    const responseCache =
        new Map();

    const pendingRequests =
        new Map();

    /*
    ==========================================================================
    Generic Utilities
    ==========================================================================
    */

    function text(
        value,
        fallback = ""
    ) {
        if (
            value === undefined ||
            value === null
        ) {
            return fallback;
        }

        const normalized =
            String(value)
                .normalize("NFKC")
                .replace(/\s+/g, " ")
                .trim();

        return normalized ||
            fallback;
    }

    function number(
        value,
        fallback = 0,
        minimum = -Infinity,
        maximum = Infinity
    ) {
        const parsed =
            Number(value);

        if (!Number.isFinite(parsed)) {
            return fallback;
        }

        return Math.min(
            maximum,
            Math.max(
                minimum,
                parsed
            )
        );
    }

    function integer(
        value,
        fallback = 0,
        minimum = Number.MIN_SAFE_INTEGER,
        maximum = Number.MAX_SAFE_INTEGER
    ) {
        const parsed =
            Number.parseInt(
                value,
                10
            );

        if (!Number.isFinite(parsed)) {
            return fallback;
        }

        return Math.min(
            maximum,
            Math.max(
                minimum,
                parsed
            )
        );
    }

    function boolean(
        value,
        fallback = false
    ) {
        if (typeof value === "boolean") {
            return value;
        }

        if (
            value === undefined ||
            value === null ||
            value === ""
        ) {
            return fallback;
        }

        const normalized =
            text(value)
                .toLowerCase();

        if (
            [
                "1",
                "true",
                "yes",
                "on",
                "enabled"
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
                "disabled"
            ].includes(
                normalized
            )
        ) {
            return false;
        }

        return fallback;
    }

    function clone(
        value
    ) {
        if (
            typeof structuredClone ===
            "function"
        ) {
            try {
                return structuredClone(
                    value
                );
            } catch (_error) {
                /*
                --------------------------------------------------------------
                Fall through to JSON cloning.
                --------------------------------------------------------------
                */
            }
        }

        if (
            value === null ||
            value === undefined ||
            typeof value !==
                "object"
        ) {
            return value;
        }

        try {
            return JSON.parse(
                JSON.stringify(
                    value
                )
            );
        } catch (_error) {
            return value;
        }
    }

    function sleep(
        milliseconds,
        signal
    ) {
        return new Promise(
            (
                resolve,
                reject
            ) => {
                if (
                    signal?.
                        aborted
                ) {
                    reject(
                        signal.reason ||
                        new DOMException(
                            "Aborted",
                            "AbortError"
                        )
                    );
                    return;
                }

                const timer =
                    window.setTimeout(
                        resolve,
                        Math.max(
                            0,
                            milliseconds
                        )
                    );

                const abort =
                    () => {
                        window.clearTimeout(
                            timer
                        );

                        reject(
                            signal.reason ||
                            new DOMException(
                                "Aborted",
                                "AbortError"
                            )
                        );
                    };

                signal?.
                    addEventListener?.(
                        "abort",
                        abort,
                        {
                            once:
                                true
                        }
                    );
            }
        );
    }

    function isPlainObject(
        value
    ) {
        if (
            value === null ||
            typeof value !==
                "object" ||
            Array.isArray(
                value
            )
        ) {
            return false;
        }

        const prototype =
            Object.getPrototypeOf(
                value
            );

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
        if (
            !isPlainObject(
                value
            )
        ) {
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
        if (
            !Array.isArray(
                value
            )
        ) {
            throw new TypeError(
                `${label} must be an array.`
            );
        }

        return value;
    }

    function dispatchDataEvent(
        name,
        detail = {},
        target =
            document,
        options = {}
    ) {
        if (
            !target ||
            typeof target.dispatchEvent !==
                "function"
        ) {
            return false;
        }

        try {
            return target.dispatchEvent(
                new CustomEvent(
                    name,
                    {
                        bubbles:
                            options.bubbles ===
                            true,

                        cancelable:
                            options.cancelable ===
                            true,

                        composed:
                            options.composed ===
                            true,

                        detail
                    }
                )
            );
        } catch (_error) {
            return false;
        }
    }

    /*
    ==========================================================================
    Static Data Paths and JSON Requests
    ==========================================================================
    */

    function normalizeDataPath(
        value
    ) {
        const path =
            String(
                value ??
                ""
            )
                .trim()
                .replace(
                    /^\/+/,
                    ""
                );

        if (!path) {
            throw new TypeError(
                "A data filename is required."
            );
        }

        if (
            path.includes(
                ".."
            ) ||
            path.includes(
                "\\"
            ) ||
            path.includes(
                "//"
            ) ||
            !/^[a-z0-9/_-]+\.json$/i.test(
                path
            )
        ) {
            throw new TypeError(
                `Invalid data path: ${value}`
            );
        }

        return path;
    }

    function getDataURL(
        filename
    ) {
        const path =
            normalizeDataPath(
                filename
            );

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

    function getRequestKey(
        url,
        settings
    ) {
        return [
            url,
            settings.requestCache,
            settings.credentials
        ].join(
            "|"
        );
    }

    async function fetchJSON(
        filename,
        options = {}
    ) {
        const settings = {
            ...DEFAULT_OPTIONS,
            ...options
        };

        const url =
            getDataURL(
                filename
            );

        if (
            settings.cache &&
            !settings.refresh &&
            responseCache.has(
                url
            )
        ) {
            return responseCache.get(
                url
            );
        }

        const requestKey =
            getRequestKey(
                url,
                settings
            );

        if (
            !settings.refresh &&
            pendingRequests.has(
                requestKey
            )
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

            if (
                settings.cache
            ) {
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
                ) ===
                request
            ) {
                pendingRequests.delete(
                    requestKey
                );
            }
        }
    }

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
                        method:
                            "GET",

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

            if (
                !response.ok
            ) {
                throw new Error(
                    `HTTP ${response.status} ${response.statusText}: ${response.url}`
                );
            }

            const contentType =
                response.headers
                    .get(
                        "content-type"
                    )
                    ?.toLowerCase() ||
                "";

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

                if (
                    valid ===
                    false
                ) {
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
                    error: {
                        name:
                            error?.name ||
                            "Error",

                        message:
                            error?.message ||
                            String(
                                error
                            )
                    }
                }
            );

            throw error;
        }
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
            Array.isArray(
                path
            )
                ? path
                : String(
                    path ??
                    ""
                )
                    .split(
                        "."
                    )
                    .filter(
                        Boolean
                    );

        if (
            !keys.length
        ) {
            return source;
        }

        let value =
            source;

        for (
            const key of keys
        ) {
            if (
                value === null ||
                value === undefined ||
                !Object.prototype
                    .hasOwnProperty
                    .call(
                        Object(
                            value
                        ),
                        key
                    )
            ) {
                return fallback;
            }

            value =
                value[key];
        }

        return value;
    }

    /*
    ==========================================================================
    Formatting
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

        const numeric =
            Number(
                value
            );

        if (
            !Number.isFinite(
                numeric
            )
        ) {
            return String(
                value
            );
        }

        return new Intl.NumberFormat(
            options.locale ||
            "en-US",
            options.format ||
            {}
        ).format(
            numeric
        );
    }

    function parseDate(
        value
    ) {
        if (
            value === undefined ||
            value === null ||
            value === ""
        ) {
            return null;
        }

        const parsed =
            value instanceof
            Date
                ? new Date(
                    value.getTime()
                )
                : new Date(
                    value
                );

        return Number.isNaN(
            parsed.getTime()
        )
            ? null
            : parsed;
    }

    function formatDate(
        value,
        options = {}
    ) {
        const parsed =
            parseDate(
                value
            );

        if (
            !parsed
        ) {
            return value
                ? String(
                    value
                )
                : options.fallback ??
                    "Unavailable";
        }

        return new Intl.DateTimeFormat(
            options.locale ||
            "en-US",
            {
                year:
                    "numeric",

                month:
                    "long",

                day:
                    "numeric",

                timeZone:
                    "UTC",

                ...(
                    options.format ||
                    {}
                )
            }
        ).format(
            parsed
        );
    }

    function formatDateTime(
        value,
        options = {}
    ) {
        const parsed =
            parseDate(
                value
            );

        if (
            !parsed
        ) {
            return value
                ? String(
                    value
                )
                : options.fallback ??
                    "Unavailable";
        }

        return new Intl.DateTimeFormat(
            options.locale ||
            "en-US",
            {
                year:
                    "numeric",

                month:
                    "long",

                day:
                    "numeric",

                hour:
                    "numeric",

                minute:
                    "2-digit",

                timeZone:
                    "UTC",

                timeZoneName:
                    "short",

                ...(
                    options.format ||
                    {}
                )
            }
        ).format(
            parsed
        );
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
        if (
            typeof Element !==
                "undefined" &&
            !(
                element instanceof
                Element
            )
        ) {
            return false;
        }

        if (!element) {
            return false;
        }

        element.textContent =
            value === undefined ||
            value === null ||
            value === ""
                ? fallback
                : String(
                    value
                );

        return true;
    }

    function setUnavailable(
        elements,
        value = "Unavailable"
    ) {
        if (!elements) {
            return 0;
        }

        const collection =
            Array.isArray(
                elements
            )
                ? elements
                : (
                    typeof NodeList !==
                        "undefined" &&
                    elements instanceof
                        NodeList
                ) ||
                (
                    typeof HTMLCollection !==
                        "undefined" &&
                    elements instanceof
                        HTMLCollection
                )
                    ? Array.from(
                        elements
                    )
                    : Object.values(
                        elements
                    );

        let updated =
            0;

        collection.forEach(
            (
                element
            ) => {
                if (
                    setText(
                        element,
                        value,
                        value
                    )
                ) {
                    updated +=
                        1;
                }
            }
        );

        return updated;
    }

    /*
    ==========================================================================
    Static Cache Management
    ==========================================================================
    */

    function clearDataCache(
        filename = null
    ) {
        if (!filename) {
            responseCache.clear();
            return true;
        }

        return responseCache.delete(
            getDataURL(
                filename
            )
        );
    }

    function hasCachedData(
        filename
    ) {
        return responseCache.has(
            getDataURL(
                filename
            )
        );
    }

    /*
    ==========================================================================
    Live Record Normalization
    ==========================================================================
    */

    function first(
        record,
        keys,
        fallback = ""
    ) {
        for (
            const key of keys
        ) {
            const value =
                record?.[key];

            if (
                value !== undefined &&
                value !== null &&
                value !== ""
            ) {
                return value;
            }
        }

        return fallback;
    }

    function normalizeLiveRecord(
        record,
        index = 0,
        source = "speciedex-database"
    ) {
        if (
            record === null ||
            record === undefined
        ) {
            return null;
        }

        if (
            typeof record !==
                "object"
        ) {
            record = {
                scientific_name:
                    text(
                        record
                    )
            };
        }

        const scientificName =
            text(
                first(
                    record,
                    [
                        "scientific_name",
                        "scientificName",
                        "canonical_name",
                        "canonicalName",
                        "accepted_name",
                        "acceptedName",
                        "taxon_name",
                        "taxonName",
                        "name"
                    ]
                ),
                "Unknown taxon"
            );

        const commonName =
            text(
                first(
                    record,
                    [
                        "common_name",
                        "commonName",
                        "vernacular_name",
                        "vernacularName",
                        "preferred_common_name",
                        "preferredCommonName",
                        "english_name",
                        "englishName"
                    ]
                ),
                "No common name"
            );

        const speciedexId =
            text(
                first(
                    record,
                    [
                        "speciedex_id",
                        "speciedexId",
                        "speciedex_key",
                        "speciedexKey",
                        "canonical_id",
                        "canonicalId",
                        "taxon_id",
                        "taxonId",
                        "id",
                        "key"
                    ]
                ),
                `pending-${index + 1}`
            );

        const provider =
            text(
                first(
                    record,
                    [
                        "provider",
                        "provider_name",
                        "providerName",
                        "source",
                        "source_name",
                        "sourceName",
                        "dataset",
                        "dataset_name",
                        "datasetName"
                    ]
                ),
                source
            );

        const timestampValue =
            first(
                record,
                [
                    "indexed_at",
                    "indexedAt",
                    "created_at",
                    "createdAt",
                    "updated_at",
                    "updatedAt",
                    "timestamp",
                    "detected_at",
                    "detectedAt"
                ]
            );

        const parsedTimestamp =
            parseDate(
                timestampValue
            );

        return {
            ...record,

            index:
                record.index ??
                index,

            id:
                text(
                    record.id ??
                    record.taxon_id ??
                    record.taxonId ??
                    speciedexId
                ),

            speciedex_id:
                speciedexId,

            speciedexId,

            scientific_name:
                scientificName,

            scientificName,

            canonical_name:
                text(
                    record.canonical_name ??
                    record.canonicalName ??
                    scientificName
                ),

            canonicalName:
                text(
                    record.canonicalName ??
                    record.canonical_name ??
                    scientificName
                ),

            common_name:
                commonName,

            commonName,

            rank:
                text(
                    record.rank ??
                    record.taxon_rank ??
                    record.taxonRank ??
                    ""
                ),

            status:
                text(
                    record.status ??
                    record.taxonomic_status ??
                    record.taxonomicStatus ??
                    ""
                ),

            provider,

            source:
                text(
                    record.source ??
                    provider
                ),

            indexed_at:
                parsedTimestamp
                    ? parsedTimestamp.toISOString()
                    : new Date().toISOString()
        };
    }

    function liveRecordKey(
        record
    ) {
        return [
            text(
                record.speciedex_id ??
                record.speciedexId ??
                record.id
            ),
            text(
                record.scientific_name ??
                record.scientificName
            ).toLowerCase(),
            text(
                record.provider ??
                record.source
            ).toLowerCase(),
            text(
                record.indexed_at ??
                record.updated_at ??
                record.created_at
            )
        ].join(
            "|"
        );
    }

    function extractPayloadObject(
        payload
    ) {
        if (
            payload &&
            isPlainObject(
                payload.data
            )
        ) {
            return payload.data;
        }

        return payload;
    }

    function extractLiveRecords(
        payload
    ) {
        if (
            Array.isArray(
                payload
            )
        ) {
            return payload;
        }

        if (
            !payload ||
            typeof payload !==
                "object"
        ) {
            return [];
        }

        const nested =
            extractPayloadObject(
                payload
            );

        if (
            Array.isArray(
                nested
            )
        ) {
            return nested;
        }

        for (
            const key of RECORD_ARRAY_KEYS
        ) {
            if (
                Array.isArray(
                    nested?.[key]
                )
            ) {
                return nested[key];
            }
        }

        if (
            isPlainObject(
                nested?.record
            )
        ) {
            return [
                nested.record
            ];
        }

        if (
            isPlainObject(
                nested?.species
            )
        ) {
            return [
                nested.species
            ];
        }

        return [];
    }

    function extractCursor(
        payload,
        fallback = ""
    ) {
        const nested =
            extractPayloadObject(
                payload
            );

        for (
            const key of CURSOR_KEYS
        ) {
            const value =
                nested?.[key] ??
                payload?.[key];

            if (
                value !== undefined &&
                value !== null &&
                value !== ""
            ) {
                return String(
                    value
                );
            }
        }

        return fallback;
    }

    function extractHasMore(
        payload,
        fallback = false
    ) {
        const nested =
            extractPayloadObject(
                payload
            );

        for (
            const key of HAS_MORE_KEYS
        ) {
            const value =
                nested?.[key] ??
                payload?.[key];

            if (
                value !== undefined &&
                value !== null
            ) {
                return boolean(
                    value,
                    fallback
                );
            }
        }

        return fallback;
    }

    function normalizeLiveResponse(
        payload,
        options = {}
    ) {
        const source =
            extractLiveRecords(
                payload
            );

        const records =
            source
                .map(
                    (
                        record,
                        index
                    ) =>
                        normalizeLiveRecord(
                            record,
                            index,
                            options.source ||
                            "speciedex-database"
                        )
                )
                .filter(
                    Boolean
                );

        const total =
            Number(
                payload?.total ??
                payload?.count ??
                payload?.data?.total
            );

        const updatedAt =
            text(
                payload?.updated_at ??
                payload?.updatedAt ??
                payload?.data?.updated_at ??
                payload?.data?.updatedAt ??
                ""
            );

        return {
            records,

            total:
                Number.isFinite(
                    total
                )
                    ? total
                    : records.length,

            cursor:
                extractCursor(
                    payload,
                    options.cursor ||
                    ""
                ),

            hasMore:
                extractHasMore(
                    payload,
                    false
                ),

            updatedAt:
                parseDate(
                    updatedAt
                )?.toISOString() ||
                new Date().toISOString(),

            raw:
                payload
        };
    }

    /*
    ==========================================================================
    Live Stream
    ==========================================================================
    */

    class LiveDataStream
        extends EventTarget {
        constructor(
            options = {}
        ) {
            super();

            const documentElement =
                document.documentElement;
            const body =
                document.body;

            const configuredEndpoint =
                Speciedex.liveDataEndpoint ||
                documentElement?.
                    dataset?.
                    speciedexLiveDataEndpoint ||
                body?.
                    dataset?.
                    speciedexLiveDataEndpoint ||
                options.endpoint ||
                DEFAULT_LIVE_ENDPOINT;

            this.options = {
                ...DEFAULT_STREAM_OPTIONS,
                ...options,

                endpoint:
                    configuredEndpoint,

                interval:
                    integer(
                        options.interval ??
                        documentElement?.
                            dataset?.
                            speciedexLiveDataInterval,
                        DEFAULT_STREAM_OPTIONS.interval,
                        250,
                        3600000
                    ),

                hiddenInterval:
                    integer(
                        options.hiddenInterval ??
                        documentElement?.
                            dataset?.
                            speciedexLiveDataHiddenInterval,
                        DEFAULT_STREAM_OPTIONS.hiddenInterval,
                        1000,
                        3600000
                    ),

                limit:
                    integer(
                        options.limit ??
                        documentElement?.
                            dataset?.
                            speciedexLiveDataLimit,
                        DEFAULT_STREAM_OPTIONS.limit,
                        1,
                        5000
                    ),

                batchLimit:
                    integer(
                        options.batchLimit,
                        DEFAULT_STREAM_OPTIONS.batchLimit,
                        1,
                        100
                    ),

                timeout:
                    integer(
                        options.timeout,
                        DEFAULT_STREAM_OPTIONS.timeout,
                        1000,
                        120000
                    ),

                autoplay:
                    boolean(
                        options.autoplay ??
                        documentElement?.
                            dataset?.
                            speciedexLiveDataAutoplay,
                        DEFAULT_STREAM_OPTIONS.autoplay
                    ),

                pauseWhenHidden:
                    boolean(
                        options.pauseWhenHidden,
                        DEFAULT_STREAM_OPTIONS.pauseWhenHidden
                    ),

                persistCursor:
                    boolean(
                        options.persistCursor,
                        DEFAULT_STREAM_OPTIONS.persistCursor
                    ),

                persistRecentKeys:
                    boolean(
                        options.persistRecentKeys,
                        DEFAULT_STREAM_OPTIONS.persistRecentKeys
                    ),

                recentKeyLimit:
                    integer(
                        options.recentKeyLimit,
                        DEFAULT_STREAM_OPTIONS.recentKeyLimit,
                        32,
                        50000
                    ),

                initialLookback:
                    integer(
                        options.initialLookback,
                        DEFAULT_STREAM_OPTIONS.initialLookback,
                        0,
                        604800000
                    ),

                retryMinimum:
                    integer(
                        options.retryMinimum,
                        DEFAULT_STREAM_OPTIONS.retryMinimum,
                        250,
                        60000
                    ),

                retryMaximum:
                    integer(
                        options.retryMaximum,
                        DEFAULT_STREAM_OPTIONS.retryMaximum,
                        1000,
                        3600000
                    ),

                retryFactor:
                    number(
                        options.retryFactor,
                        DEFAULT_STREAM_OPTIONS.retryFactor,
                        1,
                        10
                    ),

                jitter:
                    number(
                        options.jitter,
                        DEFAULT_STREAM_OPTIONS.jitter,
                        0,
                        1
                    )
            };

            this.instance =
                text(
                    options.instance ??
                    documentElement?.
                        dataset?.
                        terminalInstance ??
                    "default"
                );

            this.storagePrefix =
                text(
                    options.storagePrefix,
                    "speciedex:data-stream"
                );

            this.cursorKey =
                `${this.storagePrefix}:cursor:${this.instance}`;

            this.recentKey =
                `${this.storagePrefix}:recent:${this.instance}`;

            this.cursor =
                this.restoreCursor();

            this.after =
                this.cursor
                    ? ""
                    : new Date(
                        Date.now() -
                        this.options.initialLookback
                    ).toISOString();

            this.recentKeys =
                new Set(
                    this.restoreRecentKeys()
                );

            this.recentQueue =
                Array.from(
                    this.recentKeys
                );

            this.running =
                false;

            this.paused =
                false;

            this.autoPaused =
                false;

            this.destroyed =
                false;

            this.timer =
                0;

            this.requestController =
                null;

            this.failureCount =
                0;

            this.lastError =
                null;

            this.lastRequestAt =
                null;

            this.lastSuccessAt =
                null;

            this.lastRecordAt =
                null;

            this.lastDuration =
                null;

            this.metrics = {
                requests:
                    0,

                successes:
                    0,

                failures:
                    0,

                batches:
                    0,

                received:
                    0,

                accepted:
                    0,

                duplicates:
                    0,

                empty:
                    0,

                dispatched:
                    0
            };

            this._visibilityHandler =
                () => {
                    if (
                        !this.options.pauseWhenHidden
                    ) {
                        return;
                    }

                    if (
                        document.visibilityState ===
                        "hidden"
                    ) {
                        if (
                            this.running &&
                            !this.paused
                        ) {
                            this.autoPaused =
                                true;

                            this.pause({
                                automatic:
                                    true
                            });
                        }
                    } else if (
                        this.running &&
                        this.paused &&
                        this.autoPaused
                    ) {
                        this.autoPaused =
                            false;

                        this.resume({
                            automatic:
                                true,

                            immediate:
                                true
                        });
                    }
                };

            document.addEventListener(
                "visibilitychange",
                this._visibilityHandler
            );

            if (
                this.options.autoplay
            ) {
                this.start();
            }
        }

        emit(
            type,
            detail = {}
        ) {
            const event = {
                type,

                timestamp:
                    new Date().toISOString(),

                ...detail
            };

            dispatchDataEvent(
                type,
                event,
                this
            );

            dispatchDataEvent(
                `speciedex:data-stream-${type}`,
                event
            );

            return event;
        }

        restoreCursor() {
            if (
                !this.options.persistCursor
            ) {
                return "";
            }

            try {
                return text(
                    window.localStorage?.
                        getItem?.(
                            this.cursorKey
                        )
                );
            } catch (_error) {
                return "";
            }
        }

        persistCursor() {
            if (
                !this.options.persistCursor
            ) {
                return false;
            }

            try {
                if (
                    this.cursor
                ) {
                    window.localStorage?.
                        setItem?.(
                            this.cursorKey,
                            this.cursor
                        );
                } else {
                    window.localStorage?.
                        removeItem?.(
                            this.cursorKey
                        );
                }

                return true;
            } catch (error) {
                this.lastError =
                    error;

                return false;
            }
        }

        restoreRecentKeys() {
            if (
                !this.options.persistRecentKeys
            ) {
                return [];
            }

            try {
                const raw =
                    window.localStorage?.
                        getItem?.(
                            this.recentKey
                        );

                const parsed =
                    raw
                        ? JSON.parse(
                            raw
                        )
                        : [];

                return Array.isArray(
                    parsed
                )
                    ? parsed
                        .map(
                            text
                        )
                        .filter(
                            Boolean
                        )
                        .slice(
                            -this.options.recentKeyLimit
                        )
                    : [];
            } catch (_error) {
                return [];
            }
        }

        persistRecentKeys() {
            if (
                !this.options.persistRecentKeys
            ) {
                return false;
            }

            try {
                window.localStorage?.
                    setItem?.(
                        this.recentKey,
                        JSON.stringify(
                            this.recentQueue.slice(
                                -this.options.recentKeyLimit
                            )
                        )
                    );

                return true;
            } catch (error) {
                this.lastError =
                    error;

                return false;
            }
        }

        rememberKey(
            value
        ) {
            if (
                this.recentKeys.has(
                    value
                )
            ) {
                return false;
            }

            this.recentKeys.add(
                value
            );

            this.recentQueue.push(
                value
            );

            while (
                this.recentQueue.length >
                this.options.recentKeyLimit
            ) {
                const removed =
                    this.recentQueue.shift();

                if (
                    removed
                ) {
                    this.recentKeys.delete(
                        removed
                    );
                }
            }

            return true;
        }

        buildURL() {
            const url =
                new URL(
                    this.options.endpoint,
                    window.location.origin
                );

            if (
                this.cursor
            ) {
                url.searchParams.set(
                    "cursor",
                    this.cursor
                );
            } else if (
                this.after
            ) {
                url.searchParams.set(
                    "after",
                    this.after
                );
            }

            url.searchParams.set(
                "limit",
                String(
                    this.options.limit
                )
            );

            if (
                this.options.provider
            ) {
                url.searchParams.set(
                    "provider",
                    this.options.provider
                );
            }

            return url;
        }

        nextDelay() {
            if (
                this.failureCount >
                0
            ) {
                const base =
                    Math.min(
                        this.options.retryMaximum,
                        this.options.retryMinimum *
                        Math.pow(
                            this.options.retryFactor,
                            this.failureCount -
                            1
                        )
                    );

                const spread =
                    base *
                    this.options.jitter;

                return Math.max(
                    250,
                    Math.round(
                        base +
                        (
                            Math.random() *
                            2 -
                            1
                        ) *
                        spread
                    )
                );
            }

            return (
                document.visibilityState ===
                    "hidden"
                    ? this.options.hiddenInterval
                    : this.options.interval
            );
        }

        schedule(
            delay =
                this.nextDelay()
        ) {
            if (
                !this.running ||
                this.paused ||
                this.destroyed
            ) {
                return false;
            }

            if (
                this.timer
            ) {
                window.clearTimeout(
                    this.timer
                );
            }

            this.timer =
                window.setTimeout(
                    () => {
                        this.timer =
                            0;

                        this.poll().
                            catch(
                                () => {
                                    /*
                                    ------------------------------------------
                                    poll() records and emits its own errors.
                                    ------------------------------------------
                                    */
                                }
                            );
                    },
                    Math.max(
                        0,
                        delay
                    )
                );

            return true;
        }

        async requestPage() {
            const url =
                this.buildURL();

            const controller =
                new AbortController();

            const timeout =
                window.setTimeout(
                    () => {
                        controller.abort(
                            new DOMException(
                                "Live data request timed out.",
                                "TimeoutError"
                            )
                        );
                    },
                    this.options.timeout
                );

            this.requestController =
                controller;

            this.lastRequestAt =
                new Date().toISOString();

            const started =
                performance.now();

            this.metrics.requests +=
                1;

            this.emit(
                "request",
                {
                    url:
                        url.href,

                    cursor:
                        this.cursor,

                    after:
                        this.after
                }
            );

            try {
                const response =
                    await fetch(
                        url.href,
                        {
                            method:
                                "GET",

                            cache:
                                this.options.requestCache,

                            credentials:
                                this.options.credentials,

                            headers: {
                                Accept:
                                    "application/json"
                            },

                            signal:
                                controller.signal
                        }
                    );

                if (
                    !response.ok
                ) {
                    const error =
                        new Error(
                            `HTTP ${response.status} ${response.statusText}: ${response.url}`
                        );

                    error.status =
                        response.status;

                    throw error;
                }

                const payload =
                    await response.json();

                const normalized =
                    normalizeLiveResponse(
                        payload,
                        {
                            cursor:
                                this.cursor,

                            source:
                                "speciedex-database"
                        }
                    );

                this.lastDuration =
                    performance.now() -
                    started;

                this.metrics.successes +=
                    1;

                this.failureCount =
                    0;

                this.lastError =
                    null;

                this.lastSuccessAt =
                    new Date().toISOString();

                return normalized;
            } finally {
                window.clearTimeout(
                    timeout
                );

                if (
                    this.requestController ===
                    controller
                ) {
                    this.requestController =
                        null;
                }
            }
        }

        acceptRecords(
            records
        ) {
            const accepted =
                [];

            let duplicates =
                0;

            for (
                const record of records
            ) {
                const key =
                    liveRecordKey(
                        record
                    );

                if (
                    this.recentKeys.has(
                        key
                    )
                ) {
                    duplicates +=
                        1;

                    continue;
                }

                this.rememberKey(
                    key
                );

                accepted.push(
                    record
                );
            }

            this.metrics.received +=
                records.length;

            this.metrics.accepted +=
                accepted.length;

            this.metrics.duplicates +=
                duplicates;

            if (
                accepted.length
            ) {
                this.lastRecordAt =
                    new Date().toISOString();

                this.persistRecentKeys();
            }

            return {
                records:
                    accepted,

                duplicates
            };
        }

        dispatchRecords(
            records,
            metadata = {}
        ) {
            if (
                !records.length
            ) {
                return 0;
            }

            const detail = {
                records,

                source:
                    "speciedex-database",

                endpoint:
                    this.options.endpoint,

                cursor:
                    this.cursor,

                receivedAt:
                    new Date().toISOString(),

                ...metadata
            };

            /*
            ------------------------------------------------------------------
            terminal-splash.js already listens for speciedex:stream-record.
            A single batch event avoids rendering once per record.
            ------------------------------------------------------------------
            */

            dispatchDataEvent(
                "speciedex:stream-record",
                detail
            );

            /*
            ------------------------------------------------------------------
            General site consumers can subscribe to this event without
            depending on terminal-specific naming.
            ------------------------------------------------------------------
            */

            dispatchDataEvent(
                "speciedex:data-updated",
                detail
            );

            dispatchDataEvent(
                "speciedex:database-records",
                detail
            );

            this.metrics.dispatched +=
                records.length;

            this.emit(
                "records",
                {
                    count:
                        records.length,

                    records,

                    cursor:
                        this.cursor
                }
            );

            return records.length;
        }

        async poll(
            options = {}
        ) {
            if (
                this.destroyed
            ) {
                throw new Error(
                    "Live data stream has been destroyed."
                );
            }

            if (
                !this.running &&
                options.force !==
                    true
            ) {
                return {
                    received:
                        0,

                    accepted:
                        0,

                    duplicates:
                        0
                };
            }

            if (
                this.paused &&
                options.force !==
                    true
            ) {
                return {
                    received:
                        0,

                    accepted:
                        0,

                    duplicates:
                        0
                };
            }

            if (
                this.requestController
            ) {
                return {
                    received:
                        0,

                    accepted:
                        0,

                    duplicates:
                        0,

                    pending:
                        true
                };
            }

            let received =
                0;

            let accepted =
                0;

            let duplicates =
                0;

            let batches =
                0;

            try {
                for (
                    let page = 0;
                    page < this.options.batchLimit;
                    page += 1
                ) {
                    const result =
                        await this.requestPage();

                    batches +=
                        1;

                    this.metrics.batches +=
                        1;

                    received +=
                        result.records.length;

                    const filtered =
                        this.acceptRecords(
                            result.records
                        );

                    accepted +=
                        filtered.records.length;

                    duplicates +=
                        filtered.duplicates;

                    const previousCursor =
                        this.cursor;

                    if (
                        result.cursor
                    ) {
                        this.cursor =
                            result.cursor;

                        this.after =
                            "";

                        this.persistCursor();
                    } else if (
                        result.updatedAt
                    ) {
                        this.after =
                            result.updatedAt;
                    }

                    this.dispatchRecords(
                        filtered.records,
                        {
                            batch:
                                page + 1,

                            hasMore:
                                result.hasMore,

                            updatedAt:
                                result.updatedAt
                        }
                    );

                    if (
                        !result.records.length
                    ) {
                        this.metrics.empty +=
                            1;
                    }

                    if (
                        !result.hasMore
                    ) {
                        break;
                    }

                    if (
                        result.cursor &&
                        result.cursor ===
                            previousCursor
                    ) {
                        break;
                    }
                }

                const summary = {
                    received,
                    accepted,
                    duplicates,
                    batches,
                    cursor:
                        this.cursor,
                    duration:
                        this.lastDuration
                };

                this.emit(
                    "complete",
                    summary
                );

                return summary;
            } catch (error) {
                if (
                    error?.name ===
                        "AbortError" &&
                    (
                        !this.running ||
                        this.destroyed
                    )
                ) {
                    return {
                        received,
                        accepted,
                        duplicates,
                        aborted:
                            true
                    };
                }

                this.failureCount +=
                    1;

                this.metrics.failures +=
                    1;

                this.lastError =
                    error instanceof
                    Error
                        ? error
                        : new Error(
                            String(
                                error
                            )
                        );

                this.emit(
                    "error",
                    {
                        error: {
                            name:
                                this.lastError.name,

                            message:
                                this.lastError.message,

                            stack:
                                this.lastError.stack ||
                                ""
                        },

                        failureCount:
                            this.failureCount,

                        retryIn:
                            this.nextDelay()
                    }
                );

                throw this.lastError;
            } finally {
                if (
                    this.running &&
                    !this.paused &&
                    !this.destroyed
                ) {
                    this.schedule();
                }
            }
        }

        start(
            options = {}
        ) {
            if (
                this.destroyed
            ) {
                throw new Error(
                    "Live data stream has been destroyed."
                );
            }

            if (
                this.running &&
                !this.paused
            ) {
                return this;
            }

            this.running =
                true;

            this.paused =
                false;

            this.autoPaused =
                false;

            this.emit(
                "start",
                {
                    endpoint:
                        this.options.endpoint,

                    interval:
                        this.options.interval,

                    cursor:
                        this.cursor
                }
            );

            if (
                options.immediate !==
                false
            ) {
                this.schedule(
                    0
                );
            } else {
                this.schedule();
            }

            return this;
        }

        stop(
            options = {}
        ) {
            const wasRunning =
                this.running ||
                this.paused;

            this.running =
                false;

            this.paused =
                false;

            this.autoPaused =
                false;

            if (
                this.timer
            ) {
                window.clearTimeout(
                    this.timer
                );

                this.timer =
                    0;
            }

            if (
                options.abort !==
                    false
            ) {
                this.requestController?.
                    abort?.(
                        new DOMException(
                            "Live data stream stopped.",
                            "AbortError"
                        )
                    );
            }

            if (
                wasRunning &&
                options.silent !==
                    true
            ) {
                this.emit(
                    "stop",
                    {}
                );
            }

            return wasRunning;
        }

        pause(
            options = {}
        ) {
            if (
                !this.running ||
                this.paused
            ) {
                return false;
            }

            this.paused =
                true;

            if (
                this.timer
            ) {
                window.clearTimeout(
                    this.timer
                );

                this.timer =
                    0;
            }

            if (
                options.automatic !==
                    true
            ) {
                this.autoPaused =
                    false;

                this.emit(
                    "pause",
                    {}
                );
            }

            return true;
        }

        resume(
            options = {}
        ) {
            if (
                !this.running
            ) {
                this.start({
                    immediate:
                        options.immediate !==
                        false
                });

                return true;
            }

            if (
                !this.paused
            ) {
                return false;
            }

            this.paused =
                false;

            this.autoPaused =
                false;

            if (
                options.automatic !==
                    true
            ) {
                this.emit(
                    "resume",
                    {}
                );
            }

            this.schedule(
                options.immediate ===
                    true
                    ? 0
                    : this.nextDelay()
            );

            return true;
        }

        reset(
            options = {}
        ) {
            this.cursor =
                "";

            this.after =
                new Date(
                    Date.now() -
                    this.options.initialLookback
                ).toISOString();

            this.recentKeys.clear();

            this.recentQueue =
                [];

            this.failureCount =
                0;

            this.lastError =
                null;

            this.persistCursor();
            this.persistRecentKeys();

            this.emit(
                "reset",
                {
                    after:
                        this.after
                }
            );

            if (
                options.poll ===
                    true
            ) {
                return this.poll({
                    force:
                        true
                });
            }

            return true;
        }

        update(
            options = {}
        ) {
            if (
                !isPlainObject(
                    options
                )
            ) {
                throw new TypeError(
                    "Live stream options must be an object."
                );
            }

            const wasRunning =
                this.running;

            const wasPaused =
                this.paused;

            if (
                options.endpoint !==
                undefined
            ) {
                this.options.endpoint =
                    text(
                        options.endpoint,
                        this.options.endpoint
                    );
            }

            if (
                options.interval !==
                undefined
            ) {
                this.options.interval =
                    integer(
                        options.interval,
                        this.options.interval,
                        250,
                        3600000
                    );
            }

            if (
                options.hiddenInterval !==
                undefined
            ) {
                this.options.hiddenInterval =
                    integer(
                        options.hiddenInterval,
                        this.options.hiddenInterval,
                        1000,
                        3600000
                    );
            }

            if (
                options.limit !==
                undefined
            ) {
                this.options.limit =
                    integer(
                        options.limit,
                        this.options.limit,
                        1,
                        5000
                    );
            }

            if (
                options.provider !==
                undefined
            ) {
                this.options.provider =
                    text(
                        options.provider
                    );
            }

            if (
                wasRunning
            ) {
                if (
                    this.timer
                ) {
                    window.clearTimeout(
                        this.timer
                    );

                    this.timer =
                        0;
                }

                if (
                    !wasPaused
                ) {
                    this.schedule(
                        0
                    );
                }
            }

            this.emit(
                "update",
                {
                    options:
                        this.publicOptions()
                }
            );

            return this;
        }

        publicOptions() {
            return {
                endpoint:
                    this.options.endpoint,

                interval:
                    this.options.interval,

                hiddenInterval:
                    this.options.hiddenInterval,

                limit:
                    this.options.limit,

                batchLimit:
                    this.options.batchLimit,

                timeout:
                    this.options.timeout,

                provider:
                    this.options.provider,

                autoplay:
                    this.options.autoplay,

                pauseWhenHidden:
                    this.options.pauseWhenHidden,

                persistCursor:
                    this.options.persistCursor,

                persistRecentKeys:
                    this.options.persistRecentKeys
            };
        }

        status() {
            return {
                name:
                    "speciedex-live-data-stream",

                module:
                    MODULE_NAME,

                version:
                    VERSION,

                running:
                    this.running,

                paused:
                    this.paused,

                autoPaused:
                    this.autoPaused,

                endpoint:
                    this.options.endpoint,

                cursor:
                    this.cursor,

                after:
                    this.after,

                pending:
                    Boolean(
                        this.requestController
                    ),

                failureCount:
                    this.failureCount,

                lastRequestAt:
                    this.lastRequestAt,

                lastSuccessAt:
                    this.lastSuccessAt,

                lastRecordAt:
                    this.lastRecordAt,

                lastDuration:
                    this.lastDuration,

                options:
                    this.publicOptions(),

                metrics: {
                    ...this.metrics
                },

                lastError:
                    this.lastError
                        ? {
                            name:
                                this.lastError.name,

                            message:
                                this.lastError.message
                        }
                        : null,

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

            this.stop({
                silent:
                    true
            });

            document.removeEventListener(
                "visibilitychange",
                this._visibilityHandler
            );

            this.destroyed =
                true;

            this.emit(
                "destroy",
                {}
            );

            return true;
        }
    }

    /*
    ==========================================================================
    Live Stream Initialization
    ==========================================================================
    */

    function initializeLiveData(
        options = {}
    ) {
        if (
            Speciedex.liveDataStream instanceof
                LiveDataStream &&
            !Speciedex.liveDataStream.destroyed
        ) {
            if (
                isPlainObject(
                    options
                ) &&
                Object.keys(
                    options
                ).length
            ) {
                Speciedex.liveDataStream.update(
                    options
                );
            }

            return Speciedex.liveDataStream;
        }

        const stream =
            new LiveDataStream(
                options
            );

        Speciedex.liveDataStream =
            stream;

        return stream;
    }

    function getLiveDataStream() {
        return (
            Speciedex.liveDataStream ||
            null
        );
    }

    /*
    ==========================================================================
    Module Initializer
    ==========================================================================
    */

    async function initializeData(
        options = {}
    ) {
        if (
            Speciedex.dataInitialized
        ) {
            return {
                data:
                    Speciedex.Data,

                stream:
                    getLiveDataStream()
            };
        }

        Speciedex.dataInitialized =
            true;

        const root =
            getDataURL(
                "_probe.json"
            ).replace(
                "_probe.json",
                ""
            );

        const liveOptions =
            isPlainObject(
                options.live
            )
                ? options.live
                : {};

        const stream =
            options.live ===
                false
                ? null
                : initializeLiveData(
                    liveOptions
                );

        dispatchDataEvent(
            "speciedex:data-ready",
            {
                root,
                stream:
                    stream?.
                        status?.() ||
                    null,

                version:
                    VERSION
            }
        );

        return {
            data:
                Speciedex.Data,

            stream
        };
    }

    /*
    ==========================================================================
    Public Data API
    ==========================================================================
    */

    Speciedex.Data =
        Object.freeze({
            name:
                MODULE_NAME,

            version:
                VERSION,

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

            parseDate,

            setText,

            setUnavailable,

            clearCache:
                clearDataCache,

            hasCache:
                hasCachedData,

            dispatch:
                dispatchDataEvent,

            normalizeLiveRecord,

            normalizeLiveResponse,

            liveRecordKey,

            LiveDataStream,

            initializeLive:
                initializeLiveData,

            getLiveStream:
                getLiveDataStream
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

    Speciedex.initializeLiveData =
        initializeLiveData;

    /*
    ==========================================================================
    Automatic Initialization
    ==========================================================================
    */

    const autoInitialize =
        () => {
            initializeData().
                catch(
                    (
                        error
                    ) => {
                        dispatchDataEvent(
                            "speciedex:data-initialize-error",
                            {
                                error: {
                                    name:
                                        error?.name ||
                                        "Error",

                                    message:
                                        error?.message ||
                                        String(
                                            error
                                        )
                                }
                            }
                        );
                    }
                );
        };

    if (
        document.readyState ===
        "loading"
    ) {
        document.addEventListener(
            "DOMContentLoaded",
            autoInitialize,
            {
                once:
                    true
            }
        );
    } else {
        autoInitialize();
    }
})();
