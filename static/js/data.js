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
    • Fetch and parse JSON, JSONL, and NDJSON documents
    • Prevent duplicate simultaneous requests
    • Optionally cache completed requests
    • Validate expected data structures
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
    • Fall back to static Speciedex indexes when a live API is unavailable
    • Expose live-stream status and controls

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

    const MODULE_NAME = "Data";
    const VERSION = "2.3.0";
    const DATA_ROOT = "/static/data/";
    const DEFAULT_LIVE_ENDPOINT = "/api/species/recent";

    const STATIC_FALLBACK_ENDPOINTS = Object.freeze([
        "/static/data/db/indexes/species.json",
        "/static/data/db/indexes/taxa.json",
        "/static/data/db/manifest.json",
        "/static/data/db/indexes/manifest.json",
        "/static/data/indexes/species.json",
        "/static/data/indexes/manifest.json",
        "/static/data/species.json"
    ]);

    const DEFAULT_OPTIONS = Object.freeze({
        cache: false,
        refresh: false,
        requestCache: "no-store",
        credentials: "same-origin",
        validate: null,
        signal: undefined
    });

    const DEFAULT_STREAM_OPTIONS = Object.freeze({
        endpoint: DEFAULT_LIVE_ENDPOINT,
        interval: 5000,
        hiddenInterval: 30000,
        limit: 128,
        batchLimit: 4,
        timeout: 15000,
        provider: "",
        autoplay: true,
        pauseWhenHidden: true,
        persistCursor: true,
        persistRecentKeys: true,
        recentKeyLimit: 2048,
        initialLookback: 300000,
        retryMinimum: 2000,
        retryMaximum: 60000,
        retryFactor: 1.8,
        jitter: 0.20,
        credentials: "same-origin",
        requestCache: "no-store",
        fallbackToStatic: true,
        fallbackLimit: 4096,
        stopOnPermanentError: false
    });

    const RECORD_ARRAY_KEYS = Object.freeze([
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

    const CURSOR_KEYS = Object.freeze([
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

    const HAS_MORE_KEYS = Object.freeze([
        "has_more",
        "hasMore",
        "more",
        "has_next",
        "hasNext"
    ]);

    const responseCache = new Map();
    const pendingRequests = new Map();
    const activeEvents = new WeakMap();

    let initializationPromise = null;

    function text(value, fallback = "") {
        if (value === undefined || value === null) {
            return fallback;
        }

        let normalized;

        try {
            normalized = String(value)
                .normalize("NFKC")
                .replace(/\s+/g, " ")
                .trim();
        } catch (_error) {
            normalized = String(value).trim();
        }

        return normalized || fallback;
    }

    function number(
        value,
        fallback = 0,
        minimum = -Infinity,
        maximum = Infinity
    ) {
        const parsed = Number(value);

        if (!Number.isFinite(parsed)) {
            return fallback;
        }

        return Math.min(maximum, Math.max(minimum, parsed));
    }

    function integer(
        value,
        fallback = 0,
        minimum = Number.MIN_SAFE_INTEGER,
        maximum = Number.MAX_SAFE_INTEGER
    ) {
        const parsed = Number.parseInt(value, 10);

        if (!Number.isFinite(parsed)) {
            return fallback;
        }

        return Math.min(maximum, Math.max(minimum, parsed));
    }

    function boolean(value, fallback = false) {
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

        const normalized = text(value).toLowerCase();

        if (["1", "true", "yes", "on", "enabled"].includes(normalized)) {
            return true;
        }

        if (["0", "false", "no", "off", "disabled"].includes(normalized)) {
            return false;
        }

        return fallback;
    }

    function isPlainObject(value) {
        if (
            value === null ||
            typeof value !== "object" ||
            Array.isArray(value)
        ) {
            return false;
        }

        const prototype = Object.getPrototypeOf(value);

        return (
            prototype === Object.prototype ||
            prototype === null
        );
    }

    function clone(value, seen = new WeakMap()) {
        if (
            value === null ||
            value === undefined ||
            typeof value !== "object"
        ) {
            return value;
        }

        if (typeof structuredClone === "function") {
            try {
                return structuredClone(value);
            } catch (_error) {
                /* Continue with deterministic fallback. */
            }
        }

        if (seen.has(value)) {
            return seen.get(value);
        }

        if (value instanceof Date) {
            return new Date(value.getTime());
        }

        if (value instanceof RegExp) {
            return new RegExp(value.source, value.flags);
        }

        if (value instanceof Map) {
            const output = new Map();
            seen.set(value, output);

            for (const [key, item] of value.entries()) {
                output.set(
                    clone(key, seen),
                    clone(item, seen)
                );
            }

            return output;
        }

        if (value instanceof Set) {
            const output = new Set();
            seen.set(value, output);

            for (const item of value.values()) {
                output.add(clone(item, seen));
            }

            return output;
        }

        if (Array.isArray(value)) {
            const output = [];
            seen.set(value, output);

            for (const item of value) {
                output.push(clone(item, seen));
            }

            return output;
        }

        const output = {};
        seen.set(value, output);

        for (const [key, item] of Object.entries(value)) {
            if (
                key === "__proto__" ||
                key === "prototype" ||
                key === "constructor"
            ) {
                continue;
            }

            output[key] = clone(item, seen);
        }

        return output;
    }

    function abortError(message = "Aborted") {
        try {
            return new DOMException(message, "AbortError");
        } catch (_error) {
            const error = new Error(message);
            error.name = "AbortError";
            return error;
        }
    }

    function sleep(milliseconds, signal) {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) {
                reject(signal.reason || abortError());
                return;
            }

            let settled = false;

            const cleanup = () => {
                signal?.removeEventListener?.("abort", onAbort);
            };

            const finish = () => {
                if (settled) {
                    return;
                }

                settled = true;
                cleanup();
                resolve();
            };

            const onAbort = () => {
                if (settled) {
                    return;
                }

                settled = true;
                window.clearTimeout(timer);
                cleanup();
                reject(signal.reason || abortError());
            };

            const timer = window.setTimeout(
                finish,
                Math.max(0, Number(milliseconds) || 0)
            );

            signal?.addEventListener?.(
                "abort",
                onAbort,
                { once: true }
            );
        });
    }

    function requireObject(value, label = "JSON data") {
        if (!isPlainObject(value)) {
            throw new TypeError(`${label} must be an object.`);
        }

        return value;
    }

    function requireArray(value, label = "JSON data") {
        if (!Array.isArray(value)) {
            throw new TypeError(`${label} must be an array.`);
        }

        return value;
    }

    function dispatchDataEvent(
        name,
        detail = {},
        target = document,
        options = {}
    ) {
        if (
            !target ||
            typeof target.dispatchEvent !== "function"
        ) {
            return false;
        }

        const eventName = String(name || "");

        if (!eventName) {
            return false;
        }

        let targetEvents = activeEvents.get(target);

        if (!targetEvents) {
            targetEvents = new Set();
            activeEvents.set(target, targetEvents);
        }

        if (targetEvents.has(eventName)) {
            return false;
        }

        targetEvents.add(eventName);

        try {
            return target.dispatchEvent(
                new CustomEvent(eventName, {
                    bubbles: options.bubbles === true,
                    cancelable: options.cancelable === true,
                    composed: options.composed === true,
                    detail
                })
            );
        } catch (_error) {
            return false;
        } finally {
            targetEvents.delete(eventName);
        }
    }

    function normalizeDataPath(value) {
        const raw = String(value ?? "").trim();

        if (!raw) {
            throw new TypeError("A data filename is required.");
        }

        let decoded;

        try {
            decoded = decodeURIComponent(raw);
        } catch (_error) {
            decoded = raw;
        }

        const path = decoded
            .replace(/^\/+/, "")
            .replace(/^\.\//, "");

        if (
            path.includes("..") ||
            path.includes("\\") ||
            path.includes("//") ||
            /[\u0000-\u001f\u007f]/.test(path) ||
            !/^[a-z0-9][a-z0-9/_.-]*\.(?:json|jsonl|ndjson)$/i.test(path)
        ) {
            throw new TypeError(`Invalid data path: ${value}`);
        }

        return path;
    }

    function getDataRootURL() {
        const configured = Speciedex.dataRootURL || DATA_ROOT;
        const root = new URL(configured, window.location.href);

        if (!root.pathname.endsWith("/")) {
            root.pathname += "/";
        }

        return root;
    }

    function getDataURL(filename) {
        const path = normalizeDataPath(filename);
        const root = getDataRootURL();
        const url = new URL(path, root);

        if (url.origin !== root.origin) {
            throw new TypeError("Cross-origin data paths are not allowed.");
        }

        if (!url.pathname.startsWith(root.pathname)) {
            throw new TypeError("Data path escaped the configured data root.");
        }

        return url.href;
    }

    function getRequestKey(url, settings) {
        return [
            url,
            settings.requestCache,
            settings.credentials
        ].join("|");
    }

    function parseJSONLines(source, label = "JSONL data") {
        const records = [];

        for (const [index, rawLine] of String(source).split(/\r?\n/).entries()) {
            const line = rawLine.trim();

            if (!line) {
                continue;
            }

            try {
                records.push(JSON.parse(line));
            } catch (error) {
                throw new SyntaxError(
                    `${label} contains invalid JSON at line ${index + 1}: ${error.message}`
                );
            }
        }

        return records;
    }

    async function parseResponse(response, label) {
        const contentType = String(
            response.headers.get("content-type") || ""
        ).toLowerCase();

        const url = response.url || label || "";

        if (
            contentType.includes("application/x-ndjson") ||
            contentType.includes("application/jsonl") ||
            /\.(?:jsonl|ndjson)(?:$|\?)/i.test(url)
        ) {
            return parseJSONLines(
                await response.text(),
                url
            );
        }

        try {
            return await response.json();
        } catch (error) {
            throw new SyntaxError(
                `Invalid JSON returned by ${url || label}: ${error.message}`
            );
        }
    }

    async function requestJSON(url, filename, settings) {
        dispatchDataEvent(
            "speciedex:data-loading",
            { filename, url }
        );

        try {
            const response = await fetch(url, {
                method: "GET",
                cache: settings.requestCache,
                credentials: settings.credentials,
                signal: settings.signal,
                headers: {
                    Accept:
                        "application/json, application/x-ndjson, application/jsonl, text/plain"
                }
            });

            if (!response.ok) {
                const error = new Error(
                    `HTTP ${response.status} ${response.statusText}: ${response.url || url}`
                );
                error.status = response.status;
                throw error;
            }

            const data = await parseResponse(response, filename);

            if (typeof settings.validate === "function") {
                const valid = await settings.validate(data);

                if (valid === false) {
                    throw new TypeError(
                        `Validation failed for ${filename}.`
                    );
                }
            }

            dispatchDataEvent(
                "speciedex:data-loaded",
                { filename, url, data }
            );

            return data;
        } catch (error) {
            dispatchDataEvent(
                "speciedex:data-error",
                {
                    filename,
                    url,
                    error: {
                        name: error?.name || "Error",
                        message: error?.message || String(error)
                    }
                }
            );

            throw error;
        }
    }

    async function fetchJSON(filename, options = {}) {
        const settings = {
            ...DEFAULT_OPTIONS,
            ...options
        };

        const url = getDataURL(filename);

        if (
            settings.cache &&
            !settings.refresh &&
            responseCache.has(url)
        ) {
            return clone(responseCache.get(url));
        }

        const requestKey = getRequestKey(url, settings);

        /*
        A caller-provided signal must own its request. Sharing that promise
        would let one caller abort another caller's fetch.
        */
        const mayShare = !settings.signal;

        if (
            mayShare &&
            !settings.refresh &&
            pendingRequests.has(requestKey)
        ) {
            return pendingRequests.get(requestKey);
        }

        const request = requestJSON(
            url,
            filename,
            settings
        );

        if (mayShare) {
            pendingRequests.set(requestKey, request);
        }

        try {
            const data = await request;

            if (settings.cache) {
                responseCache.set(url, clone(data));
            }

            return data;
        } finally {
            if (
                mayShare &&
                pendingRequests.get(requestKey) === request
            ) {
                pendingRequests.delete(requestKey);
            }
        }
    }

    function getValue(source, path, fallback = null) {
        if (source === null || source === undefined) {
            return fallback;
        }

        const keys = Array.isArray(path)
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
                !Object.prototype.hasOwnProperty.call(
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

    function formatNumber(value, options = {}) {
        if (
            value === undefined ||
            value === null ||
            value === ""
        ) {
            return options.fallback ?? "Unavailable";
        }

        const numeric = Number(value);

        if (!Number.isFinite(numeric)) {
            return String(value);
        }

        return new Intl.NumberFormat(
            options.locale || "en-US",
            options.format || {}
        ).format(numeric);
    }

    function parseDate(value) {
        if (
            value === undefined ||
            value === null ||
            value === ""
        ) {
            return null;
        }

        const parsed = value instanceof Date
            ? new Date(value.getTime())
            : new Date(value);

        return Number.isNaN(parsed.getTime())
            ? null
            : parsed;
    }

    function formatDate(value, options = {}) {
        const parsed = parseDate(value);

        if (!parsed) {
            return value
                ? String(value)
                : options.fallback ?? "Unavailable";
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
        ).format(parsed);
    }

    function formatDateTime(value, options = {}) {
        const parsed = parseDate(value);

        if (!parsed) {
            return value
                ? String(value)
                : options.fallback ?? "Unavailable";
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
        ).format(parsed);
    }

    function setText(element, value, fallback = "Unavailable") {
        if (
            !element ||
            typeof element.textContent === "undefined"
        ) {
            return false;
        }

        element.textContent =
            value === undefined ||
            value === null ||
            value === ""
                ? fallback
                : String(value);

        return true;
    }

    function setUnavailable(elements, value = "Unavailable") {
        if (!elements) {
            return 0;
        }

        let collection;

        if (
            Array.isArray(elements) ||
            (
                typeof NodeList !== "undefined" &&
                elements instanceof NodeList
            ) ||
            (
                typeof HTMLCollection !== "undefined" &&
                elements instanceof HTMLCollection
            ) ||
            elements instanceof Set
        ) {
            collection = Array.from(elements);
        } else if (
            elements &&
            typeof elements === "object" &&
            typeof elements.textContent === "undefined"
        ) {
            collection = Object.values(elements);
        } else {
            collection = [elements];
        }

        let updated = 0;

        for (const element of collection) {
            if (setText(element, value, value)) {
                updated += 1;
            }
        }

        return updated;
    }

    function clearDataCache(filename = null) {
        if (!filename) {
            responseCache.clear();
            pendingRequests.clear();
            return true;
        }

        const url = getDataURL(filename);
        const removed = responseCache.delete(url);

        for (const key of pendingRequests.keys()) {
            if (key.startsWith(`${url}|`)) {
                pendingRequests.delete(key);
            }
        }

        return removed;
    }

    function hasCachedData(filename) {
        return responseCache.has(getDataURL(filename));
    }

    function first(record, keys, fallback = "") {
        for (const key of keys) {
            const value = record?.[key];

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
        input,
        index = 0,
        source = "speciedex-database"
    ) {
        if (input === null || input === undefined) {
            return null;
        }

        const record =
            typeof input === "object"
                ? input
                : {
                    scientific_name: text(input)
                };

        const scientificName = text(
            first(record, [
                "scientific_name",
                "scientificName",
                "canonical_name",
                "canonicalName",
                "accepted_name",
                "acceptedName",
                "taxon_name",
                "taxonName",
                "name"
            ]),
            "Unknown taxon"
        );

        const commonName = text(
            first(record, [
                "common_name",
                "commonName",
                "vernacular_name",
                "vernacularName",
                "preferred_common_name",
                "preferredCommonName",
                "english_name",
                "englishName"
            ]),
            "No common name"
        );

        const stableFallbackId = [
            scientificName.toLowerCase(),
            text(
                record.provider ??
                record.source ??
                source
            ).toLowerCase(),
            text(record.rank).toLowerCase()
        ].join(":");

        const speciedexId = text(
            first(record, [
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
            ]),
            stableFallbackId || `pending-${index + 1}`
        );

        const provider = text(
            first(record, [
                "provider",
                "provider_name",
                "providerName",
                "source",
                "source_name",
                "sourceName",
                "dataset",
                "dataset_name",
                "datasetName"
            ]),
            source
        );

        const timestampValue = first(record, [
            "indexed_at",
            "indexedAt",
            "created_at",
            "createdAt",
            "updated_at",
            "updatedAt",
            "timestamp",
            "detected_at",
            "detectedAt"
        ]);

        const parsedTimestamp = parseDate(timestampValue);

        return {
            ...record,
            index: record.index ?? index,
            id: text(
                record.id ??
                record.taxon_id ??
                record.taxonId ??
                speciedexId
            ),
            speciedex_id: speciedexId,
            speciedexId,
            scientific_name: scientificName,
            scientificName,
            canonical_name: text(
                record.canonical_name ??
                record.canonicalName ??
                scientificName
            ),
            canonicalName: text(
                record.canonicalName ??
                record.canonical_name ??
                scientificName
            ),
            common_name: commonName,
            commonName,
            rank: text(
                record.rank ??
                record.taxon_rank ??
                record.taxonRank ??
                ""
            ),
            status: text(
                record.status ??
                record.taxonomic_status ??
                record.taxonomicStatus ??
                ""
            ),
            provider,
            source: text(record.source ?? provider),
            indexed_at: parsedTimestamp
                ? parsedTimestamp.toISOString()
                : ""
        };
    }

    function liveRecordKey(record) {
        const identifier = text(
            record.speciedex_id ??
            record.speciedexId ??
            record.id
        );

        if (identifier) {
            return `id:${identifier.toLowerCase()}`;
        }

        return [
            "name",
            text(
                record.scientific_name ??
                record.scientificName
            ).toLowerCase(),
            text(record.rank).toLowerCase(),
            text(
                record.provider ??
                record.source
            ).toLowerCase()
        ].join("|");
    }

    function payloadCandidates(payload) {
        const candidates = [];
        const seen = new WeakSet();

        function visit(value, depth = 0) {
            if (
                value === null ||
                value === undefined ||
                depth > 5
            ) {
                return;
            }

            if (Array.isArray(value)) {
                candidates.push(value);
                return;
            }

            if (
                typeof value !== "object" ||
                seen.has(value)
            ) {
                return;
            }

            seen.add(value);
            candidates.push(value);

            for (const key of [
                "data",
                "payload",
                "result",
                "response",
                "page",
                "body"
            ]) {
                if (value[key] !== undefined) {
                    visit(value[key], depth + 1);
                }
            }
        }

        visit(payload);
        return candidates;
    }

    function extractPayloadObject(payload) {
        for (const candidate of payloadCandidates(payload)) {
            if (isPlainObject(candidate)) {
                return candidate;
            }
        }

        return payload;
    }

    function extractLiveRecords(payload) {
        if (Array.isArray(payload)) {
            return payload;
        }

        for (const candidate of payloadCandidates(payload)) {
            if (Array.isArray(candidate)) {
                return candidate;
            }

            if (!isPlainObject(candidate)) {
                continue;
            }

            for (const key of RECORD_ARRAY_KEYS) {
                if (Array.isArray(candidate[key])) {
                    return candidate[key];
                }
            }

            if (isPlainObject(candidate.record)) {
                return [candidate.record];
            }

            if (isPlainObject(candidate.species)) {
                return [candidate.species];
            }
        }

        return [];
    }

    function extractCursor(payload, fallback = "") {
        for (const candidate of payloadCandidates(payload)) {
            if (!isPlainObject(candidate)) {
                continue;
            }

            for (const key of CURSOR_KEYS) {
                const value = candidate[key];

                if (
                    value !== undefined &&
                    value !== null &&
                    value !== ""
                ) {
                    return String(value);
                }
            }
        }

        return fallback;
    }

    function extractHasMore(payload, fallback = false) {
        for (const candidate of payloadCandidates(payload)) {
            if (!isPlainObject(candidate)) {
                continue;
            }

            for (const key of HAS_MORE_KEYS) {
                const value = candidate[key];

                if (
                    value !== undefined &&
                    value !== null
                ) {
                    return boolean(value, fallback);
                }
            }
        }

        return fallback;
    }

    function normalizeLiveResponse(payload, options = {}) {
        const source = extractLiveRecords(payload);

        const records = source
            .map((record, index) =>
                normalizeLiveRecord(
                    record,
                    index,
                    options.source || "speciedex-database"
                )
            )
            .filter(Boolean);

        let total = NaN;
        let updatedAt = "";

        for (const candidate of payloadCandidates(payload)) {
            if (!isPlainObject(candidate)) {
                continue;
            }

            if (!Number.isFinite(total)) {
                total = Number(
                    candidate.total ??
                    candidate.count ??
                    candidate.record_count ??
                    candidate.recordCount
                );
            }

            if (!updatedAt) {
                updatedAt = text(
                    candidate.updated_at ??
                    candidate.updatedAt ??
                    candidate.generated_at ??
                    candidate.generatedAt ??
                    ""
                );
            }
        }

        /*
        Do not preserve the previous cursor as a fallback. If a response omits
        a cursor, retaining the old one causes repeated requests for the same
        page and prevents timestamp fallback from advancing.
        */
        const cursor = extractCursor(payload, "");

        return {
            records,
            total: Number.isFinite(total)
                ? total
                : records.length,
            cursor,
            hasMore: extractHasMore(payload, false),
            updatedAt:
                parseDate(updatedAt)?.toISOString() ||
                records
                    .map(record => parseDate(record.indexed_at))
                    .filter(Boolean)
                    .sort((a, b) => b - a)[0]
                    ?.toISOString() ||
                "",
            raw: payload
        };
    }

    function normalizeDatasetRecords(payload, limit = Infinity) {
        const records = [];
        const seen = new Set();
        const seenObjects = new WeakSet();

        function add(record) {
            const normalized = normalizeLiveRecord(
                record,
                records.length,
                "speciedex-static-index"
            );

            if (!normalized) {
                return;
            }

            const key = liveRecordKey(normalized);

            if (seen.has(key)) {
                return;
            }

            seen.add(key);
            records.push(normalized);
        }

        function visit(value, depth = 0) {
            if (
                value === null ||
                value === undefined ||
                records.length >= limit ||
                depth > 10
            ) {
                return;
            }

            if (Array.isArray(value)) {
                for (const item of value) {
                    visit(item, depth + 1);

                    if (records.length >= limit) {
                        break;
                    }
                }

                return;
            }

            if (
                typeof value !== "object" ||
                seenObjects.has(value)
            ) {
                return;
            }

            seenObjects.add(value);

            const recordLike = [
                "speciedex_id",
                "speciedexId",
                "taxon_id",
                "taxonId",
                "scientific_name",
                "scientificName",
                "canonical_name",
                "canonicalName"
            ].some(key =>
                value[key] !== undefined &&
                value[key] !== null
            );

            if (recordLike) {
                add(value);
                return;
            }

            for (const [key, child] of Object.entries(value)) {
                if (
                    [
                        "checksums",
                        "schema",
                        "license",
                        "statistics",
                        "summary"
                    ].includes(key)
                ) {
                    continue;
                }

                visit(child, depth + 1);

                if (records.length >= limit) {
                    break;
                }
            }
        }

        visit(payload);
        return records;
    }

    function extractStaticShardURLs(payload, baseEndpoint) {
        const urls = new Set();
        const seen = new WeakSet();
        const base = new URL(baseEndpoint, window.location.href);

        function visit(value, depth = 0, hinted = false) {
            if (
                value === null ||
                value === undefined ||
                depth > 8
            ) {
                return;
            }

            if (typeof value === "string") {
                if (
                    hinted ||
                    /\.(?:json|jsonl|ndjson)(?:$|\?)/i.test(value)
                ) {
                    try {
                        const url = new URL(value, base);

                        if (url.origin === window.location.origin) {
                            urls.add(url.href);
                        }
                    } catch (_error) {
                        /* Ignore malformed manifest paths. */
                    }
                }

                return;
            }

            if (Array.isArray(value)) {
                for (const child of value) {
                    visit(child, depth + 1, hinted);
                }

                return;
            }

            if (
                typeof value !== "object" ||
                seen.has(value)
            ) {
                return;
            }

            seen.add(value);

            for (const [key, child] of Object.entries(value)) {
                visit(
                    child,
                    depth + 1,
                    hinted ||
                    /(?:shards?|files?|parts?|volumes?|indexes?|paths?|urls?)/i.test(key)
                );
            }
        }

        visit(payload);
        return [...urls];
    }

    class LiveDataStream extends EventTarget {
        constructor(options = {}) {
            super();

            const documentElement = document.documentElement;
            const body = document.body;

            const configuredEndpoint =
                Speciedex.liveDataEndpoint ||
                documentElement?.dataset?.speciedexLiveDataEndpoint ||
                body?.dataset?.speciedexLiveDataEndpoint ||
                options.endpoint ||
                DEFAULT_LIVE_ENDPOINT;

            this.options = {
                ...DEFAULT_STREAM_OPTIONS,
                ...options,
                endpoint: text(
                    configuredEndpoint,
                    DEFAULT_LIVE_ENDPOINT
                ),
                interval: integer(
                    options.interval ??
                    documentElement?.dataset?.speciedexLiveDataInterval,
                    DEFAULT_STREAM_OPTIONS.interval,
                    250,
                    3600000
                ),
                hiddenInterval: integer(
                    options.hiddenInterval ??
                    documentElement?.dataset?.speciedexLiveDataHiddenInterval,
                    DEFAULT_STREAM_OPTIONS.hiddenInterval,
                    1000,
                    3600000
                ),
                limit: integer(
                    options.limit ??
                    documentElement?.dataset?.speciedexLiveDataLimit,
                    DEFAULT_STREAM_OPTIONS.limit,
                    1,
                    5000
                ),
                batchLimit: integer(
                    options.batchLimit,
                    DEFAULT_STREAM_OPTIONS.batchLimit,
                    1,
                    100
                ),
                timeout: integer(
                    options.timeout,
                    DEFAULT_STREAM_OPTIONS.timeout,
                    1000,
                    120000
                ),
                autoplay: boolean(
                    options.autoplay ??
                    documentElement?.dataset?.speciedexLiveDataAutoplay,
                    DEFAULT_STREAM_OPTIONS.autoplay
                ),
                pauseWhenHidden: boolean(
                    options.pauseWhenHidden,
                    DEFAULT_STREAM_OPTIONS.pauseWhenHidden
                ),
                persistCursor: boolean(
                    options.persistCursor,
                    DEFAULT_STREAM_OPTIONS.persistCursor
                ),
                persistRecentKeys: boolean(
                    options.persistRecentKeys,
                    DEFAULT_STREAM_OPTIONS.persistRecentKeys
                ),
                recentKeyLimit: integer(
                    options.recentKeyLimit,
                    DEFAULT_STREAM_OPTIONS.recentKeyLimit,
                    32,
                    50000
                ),
                initialLookback: integer(
                    options.initialLookback,
                    DEFAULT_STREAM_OPTIONS.initialLookback,
                    0,
                    604800000
                ),
                retryMinimum: integer(
                    options.retryMinimum,
                    DEFAULT_STREAM_OPTIONS.retryMinimum,
                    250,
                    60000
                ),
                retryMaximum: integer(
                    options.retryMaximum,
                    DEFAULT_STREAM_OPTIONS.retryMaximum,
                    1000,
                    3600000
                ),
                retryFactor: number(
                    options.retryFactor,
                    DEFAULT_STREAM_OPTIONS.retryFactor,
                    1,
                    10
                ),
                jitter: number(
                    options.jitter,
                    DEFAULT_STREAM_OPTIONS.jitter,
                    0,
                    1
                ),
                fallbackToStatic: boolean(
                    options.fallbackToStatic,
                    DEFAULT_STREAM_OPTIONS.fallbackToStatic
                ),
                fallbackLimit: integer(
                    options.fallbackLimit,
                    DEFAULT_STREAM_OPTIONS.fallbackLimit,
                    1,
                    100000
                ),
                stopOnPermanentError: boolean(
                    options.stopOnPermanentError,
                    DEFAULT_STREAM_OPTIONS.stopOnPermanentError
                )
            };

            this.instance = text(
                options.instance ??
                documentElement?.dataset?.terminalInstance ??
                "default"
            );

            this.storagePrefix = text(
                options.storagePrefix,
                "speciedex:data-stream"
            );

            this.cursorKey =
                `${this.storagePrefix}:cursor:${this.instance}`;
            this.recentKey =
                `${this.storagePrefix}:recent:${this.instance}`;

            this.cursor = this.restoreCursor();
            this.after = this.cursor
                ? ""
                : new Date(
                    Date.now() -
                    this.options.initialLookback
                ).toISOString();

            this.recentKeys = new Set(
                this.restoreRecentKeys()
            );
            this.recentQueue = Array.from(this.recentKeys);

            this.running = false;
            this.paused = false;
            this.autoPaused = false;
            this.destroyed = false;
            this.timer = 0;
            this.requestController = null;
            this.pollPromise = null;
            this.failureCount = 0;
            this.lastError = null;
            this.lastRequestAt = null;
            this.lastSuccessAt = null;
            this.lastRecordAt = null;
            this.lastDuration = null;
            this.staticFallbackLoaded = false;
            this.staticFallbackPromise = null;

            this.metrics = {
                requests: 0,
                successes: 0,
                failures: 0,
                batches: 0,
                received: 0,
                accepted: 0,
                duplicates: 0,
                empty: 0,
                dispatched: 0,
                staticFallbacks: 0
            };

            this._visibilityHandler = () => {
                if (!this.options.pauseWhenHidden) {
                    return;
                }

                if (document.visibilityState === "hidden") {
                    if (this.running && !this.paused) {
                        this.autoPaused = true;
                        this.pause({ automatic: true });
                    }
                } else if (
                    this.running &&
                    this.paused &&
                    this.autoPaused
                ) {
                    this.resume({
                        automatic: true,
                        immediate: true
                    });
                }
            };

            document.addEventListener(
                "visibilitychange",
                this._visibilityHandler
            );

            if (this.options.autoplay) {
                this.start();
            }
        }

        emit(type, detail = {}) {
            const event = {
                type,
                timestamp: new Date().toISOString(),
                ...detail
            };

            dispatchDataEvent(type, event, this);
            dispatchDataEvent(
                `speciedex:data-stream-${type}`,
                event
            );

            return event;
        }

        restoreCursor() {
            if (!this.options.persistCursor) {
                return "";
            }

            try {
                return text(
                    window.localStorage?.getItem?.(
                        this.cursorKey
                    )
                );
            } catch (_error) {
                return "";
            }
        }

        persistCursor() {
            if (!this.options.persistCursor) {
                return false;
            }

            try {
                if (this.cursor) {
                    window.localStorage?.setItem?.(
                        this.cursorKey,
                        this.cursor
                    );
                } else {
                    window.localStorage?.removeItem?.(
                        this.cursorKey
                    );
                }

                return true;
            } catch (error) {
                this.lastError = error;
                return false;
            }
        }

        restoreRecentKeys() {
            if (!this.options.persistRecentKeys) {
                return [];
            }

            try {
                const raw =
                    window.localStorage?.getItem?.(
                        this.recentKey
                    );
                const parsed = raw
                    ? JSON.parse(raw)
                    : [];

                return Array.isArray(parsed)
                    ? parsed
                        .map(value => text(value))
                        .filter(Boolean)
                        .slice(-this.options.recentKeyLimit)
                    : [];
            } catch (_error) {
                return [];
            }
        }

        persistRecentKeys() {
            if (!this.options.persistRecentKeys) {
                return false;
            }

            try {
                window.localStorage?.setItem?.(
                    this.recentKey,
                    JSON.stringify(
                        this.recentQueue.slice(
                            -this.options.recentKeyLimit
                        )
                    )
                );

                return true;
            } catch (error) {
                this.lastError = error;
                return false;
            }
        }

        rememberKey(value) {
            if (!value || this.recentKeys.has(value)) {
                return false;
            }

            this.recentKeys.add(value);
            this.recentQueue.push(value);

            while (
                this.recentQueue.length >
                this.options.recentKeyLimit
            ) {
                const removed = this.recentQueue.shift();

                if (removed) {
                    this.recentKeys.delete(removed);
                }
            }

            return true;
        }

        buildURL() {
            const url = new URL(
                this.options.endpoint,
                window.location.href
            );

            if (this.cursor) {
                url.searchParams.set("cursor", this.cursor);
                url.searchParams.delete("after");
            } else if (this.after) {
                url.searchParams.set("after", this.after);
                url.searchParams.delete("cursor");
            }

            url.searchParams.set(
                "limit",
                String(this.options.limit)
            );

            if (this.options.provider) {
                url.searchParams.set(
                    "provider",
                    this.options.provider
                );
            } else {
                url.searchParams.delete("provider");
            }

            return url;
        }

        nextDelay() {
            if (this.failureCount > 0) {
                const base = Math.min(
                    this.options.retryMaximum,
                    this.options.retryMinimum *
                    Math.pow(
                        this.options.retryFactor,
                        this.failureCount - 1
                    )
                );

                const spread = base * this.options.jitter;

                return Math.max(
                    250,
                    Math.round(
                        base +
                        (Math.random() * 2 - 1) *
                        spread
                    )
                );
            }

            return document.visibilityState === "hidden"
                ? this.options.hiddenInterval
                : this.options.interval;
        }

        schedule(delay = this.nextDelay()) {
            if (
                !this.running ||
                this.paused ||
                this.destroyed
            ) {
                return false;
            }

            if (this.timer) {
                window.clearTimeout(this.timer);
            }

            this.timer = window.setTimeout(() => {
                this.timer = 0;
                void this.poll().catch(() => {
                    /* poll() records and emits its own errors. */
                });
            }, Math.max(0, delay));

            return true;
        }

        async requestPage() {
            const url = this.buildURL();
            const controller = new AbortController();

            const timeout = window.setTimeout(() => {
                const error = abortError(
                    "Live data request timed out."
                );
                error.timeout = true;
                controller.abort(error);
            }, this.options.timeout);

            this.requestController = controller;
            this.lastRequestAt = new Date().toISOString();

            const started = performance.now();
            this.metrics.requests += 1;

            this.emit("request", {
                url: url.href,
                cursor: this.cursor,
                after: this.after
            });

            try {
                const response = await fetch(url.href, {
                    method: "GET",
                    cache: this.options.requestCache,
                    credentials: this.options.credentials,
                    headers: {
                        Accept:
                            "application/json, application/x-ndjson, application/jsonl"
                    },
                    signal: controller.signal
                });

                if (!response.ok) {
                    const error = new Error(
                        `HTTP ${response.status} ${response.statusText}: ${response.url || url.href}`
                    );
                    error.status = response.status;
                    throw error;
                }

                const payload = await parseResponse(
                    response,
                    url.href
                );

                const normalized = normalizeLiveResponse(
                    payload,
                    {
                        source:
                            "speciedex-database"
                    }
                );

                this.lastDuration =
                    performance.now() - started;
                this.metrics.successes += 1;
                this.failureCount = 0;
                this.lastError = null;
                this.lastSuccessAt =
                    new Date().toISOString();

                return normalized;
            } catch (error) {
                if (
                    controller.signal.aborted &&
                    controller.signal.reason
                ) {
                    throw controller.signal.reason;
                }

                throw error;
            } finally {
                window.clearTimeout(timeout);

                if (
                    this.requestController === controller
                ) {
                    this.requestController = null;
                }
            }
        }

        acceptRecords(records) {
            const accepted = [];
            let duplicates = 0;

            for (const record of records) {
                const key = liveRecordKey(record);

                if (this.recentKeys.has(key)) {
                    duplicates += 1;
                    continue;
                }

                this.rememberKey(key);
                accepted.push(record);
            }

            this.metrics.received += records.length;
            this.metrics.accepted += accepted.length;
            this.metrics.duplicates += duplicates;

            if (accepted.length) {
                this.lastRecordAt =
                    new Date().toISOString();
                this.persistRecentKeys();
            }

            return {
                records: accepted,
                duplicates
            };
        }

        dispatchRecords(records, metadata = {}) {
            if (!records.length) {
                return 0;
            }

            const detail = {
                records,
                source:
                    metadata.source ||
                    "speciedex-database",
                endpoint:
                    metadata.endpoint ||
                    this.options.endpoint,
                cursor: this.cursor,
                receivedAt:
                    new Date().toISOString(),
                ...metadata
            };

            dispatchDataEvent(
                "speciedex:stream-record",
                detail
            );
            dispatchDataEvent(
                "speciedex:data-updated",
                detail
            );
            dispatchDataEvent(
                "speciedex:database-records",
                detail
            );
            dispatchDataEvent(
                "speciedex:terminal-records-ready",
                detail
            );

            this.metrics.dispatched += records.length;

            this.emit("records", {
                count: records.length,
                records,
                cursor: this.cursor,
                source: detail.source
            });

            return records.length;
        }

        async loadStaticFallback() {
            if (
                !this.options.fallbackToStatic ||
                this.destroyed
            ) {
                return {
                    records: [],
                    endpoint: null
                };
            }

            if (this.staticFallbackPromise) {
                return this.staticFallbackPromise;
            }

            this.staticFallbackPromise = (async () => {
                let lastError = null;

                for (const endpoint of STATIC_FALLBACK_ENDPOINTS) {
                    try {
                        const response = await fetch(endpoint, {
                            cache: "no-store",
                            credentials: "same-origin",
                            headers: {
                                Accept:
                                    "application/json, application/x-ndjson, application/jsonl"
                            }
                        });

                        if (!response.ok) {
                            throw new Error(
                                `${endpoint} returned HTTP ${response.status}.`
                            );
                        }

                        const payload = await parseResponse(
                            response,
                            endpoint
                        );

                        let records = normalizeDatasetRecords(
                            payload,
                            this.options.fallbackLimit
                        );

                        if (!records.length) {
                            const shardURLs =
                                extractStaticShardURLs(
                                    payload,
                                    endpoint
                                );

                            for (const shardURL of shardURLs.slice(0, 256)) {
                                if (
                                    records.length >=
                                    this.options.fallbackLimit
                                ) {
                                    break;
                                }

                                try {
                                    const shardResponse = await fetch(
                                        shardURL,
                                        {
                                            cache: "no-store",
                                            credentials: "same-origin",
                                            headers: {
                                                Accept:
                                                    "application/json, application/x-ndjson, application/jsonl"
                                            }
                                        }
                                    );

                                    if (!shardResponse.ok) {
                                        continue;
                                    }

                                    const shard = await parseResponse(
                                        shardResponse,
                                        shardURL
                                    );

                                    records.push(
                                        ...normalizeDatasetRecords(
                                            shard,
                                            this.options.fallbackLimit -
                                            records.length
                                        )
                                    );
                                } catch (error) {
                                    lastError = error;
                                }
                            }

                            records = normalizeDatasetRecords(
                                records,
                                this.options.fallbackLimit
                            );
                        }

                        if (!records.length) {
                            throw new Error(
                                `${endpoint} contained no taxon records.`
                            );
                        }

                        this.staticFallbackLoaded = true;
                        this.metrics.staticFallbacks += 1;

                        const filtered =
                            this.acceptRecords(records);

                        this.dispatchRecords(
                            filtered.records,
                            {
                                source:
                                    "speciedex-static-index",
                                endpoint,
                                fallback:
                                    true,
                                snapshot:
                                    true
                            }
                        );

                        this.emit("fallback", {
                            endpoint,
                            received: records.length,
                            accepted:
                                filtered.records.length,
                            duplicates:
                                filtered.duplicates
                        });

                        return {
                            records:
                                filtered.records,
                            endpoint
                        };
                    } catch (error) {
                        lastError = error;
                    }
                }

                throw lastError ||
                    new Error(
                        "No static Speciedex data source was available."
                    );
            })();

            try {
                return await this.staticFallbackPromise;
            } finally {
                this.staticFallbackPromise = null;
            }
        }

        async performPoll(options = {}) {
            let received = 0;
            let accepted = 0;
            let duplicates = 0;
            let batches = 0;

            try {
                for (
                    let page = 0;
                    page < this.options.batchLimit;
                    page += 1
                ) {
                    const result = await this.requestPage();

                    batches += 1;
                    this.metrics.batches += 1;
                    received += result.records.length;

                    const filtered =
                        this.acceptRecords(result.records);

                    accepted += filtered.records.length;
                    duplicates += filtered.duplicates;

                    const previousCursor = this.cursor;

                    if (result.cursor) {
                        this.cursor = result.cursor;
                        this.after = "";
                        this.persistCursor();
                    } else {
                        /*
                        Explicitly clear a stale cursor when the server omits
                        one, then advance using the newest available timestamp.
                        */
                        if (this.cursor) {
                            this.cursor = "";
                            this.persistCursor();
                        }

                        if (result.updatedAt) {
                            this.after = result.updatedAt;
                        }
                    }

                    this.dispatchRecords(
                        filtered.records,
                        {
                            batch: page + 1,
                            hasMore: result.hasMore,
                            updatedAt: result.updatedAt
                        }
                    );

                    if (!result.records.length) {
                        this.metrics.empty += 1;
                    }

                    if (!result.hasMore) {
                        break;
                    }

                    if (
                        result.cursor &&
                        result.cursor === previousCursor
                    ) {
                        break;
                    }

                    if (
                        !result.cursor &&
                        !result.updatedAt
                    ) {
                        break;
                    }
                }

                const summary = {
                    received,
                    accepted,
                    duplicates,
                    batches,
                    cursor: this.cursor,
                    after: this.after,
                    duration: this.lastDuration
                };

                this.emit("complete", summary);
                return summary;
            } catch (error) {
                if (
                    error?.name === "AbortError" &&
                    (
                        !this.running ||
                        this.destroyed
                    )
                ) {
                    return {
                        received,
                        accepted,
                        duplicates,
                        aborted: true
                    };
                }

                this.failureCount += 1;
                this.metrics.failures += 1;
                this.lastError =
                    error instanceof Error
                        ? error
                        : new Error(String(error));

                let fallback = null;

                if (
                    this.options.fallbackToStatic &&
                    !this.staticFallbackLoaded &&
                    (
                        this.lastError.status === 404 ||
                        this.lastError.status === 405 ||
                        this.lastError.status === 501 ||
                        !navigator.onLine
                    )
                ) {
                    try {
                        fallback = await this.loadStaticFallback();
                    } catch (_fallbackError) {
                        /* Preserve and report the live API error. */
                    }
                }

                this.emit("error", {
                    error: {
                        name: this.lastError.name,
                        message: this.lastError.message,
                        stack: this.lastError.stack || "",
                        status: this.lastError.status || null
                    },
                    failureCount: this.failureCount,
                    retryIn: this.nextDelay(),
                    fallback:
                        fallback
                            ? {
                                endpoint:
                                    fallback.endpoint,
                                records:
                                    fallback.records.length
                            }
                            : null
                });

                if (fallback?.records?.length) {
                    return {
                        received:
                            fallback.records.length,
                        accepted:
                            fallback.records.length,
                        duplicates: 0,
                        fallback: true,
                        endpoint:
                            fallback.endpoint
                    };
                }

                if (
                    this.options.stopOnPermanentError &&
                    [400, 401, 403, 404, 405, 410, 422, 501]
                        .includes(this.lastError.status)
                ) {
                    this.stop({
                        abort: false,
                        silent: true
                    });
                }

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

        poll(options = {}) {
            if (this.destroyed) {
                return Promise.reject(
                    new Error(
                        "Live data stream has been destroyed."
                    )
                );
            }

            if (
                !this.running &&
                options.force !== true
            ) {
                return Promise.resolve({
                    received: 0,
                    accepted: 0,
                    duplicates: 0
                });
            }

            if (
                this.paused &&
                options.force !== true
            ) {
                return Promise.resolve({
                    received: 0,
                    accepted: 0,
                    duplicates: 0
                });
            }

            if (this.pollPromise) {
                return this.pollPromise;
            }

            this.pollPromise =
                this.performPoll(options);

            return this.pollPromise.finally(() => {
                this.pollPromise = null;
            });
        }

        start(options = {}) {
            if (this.destroyed) {
                throw new Error(
                    "Live data stream has been destroyed."
                );
            }

            if (this.running && !this.paused) {
                return this;
            }

            this.running = true;
            this.paused = false;
            this.autoPaused = false;

            this.emit("start", {
                endpoint: this.options.endpoint,
                interval: this.options.interval,
                cursor: this.cursor,
                after: this.after
            });

            this.schedule(
                options.immediate !== false
                    ? 0
                    : this.nextDelay()
            );

            return this;
        }

        stop(options = {}) {
            const wasRunning =
                this.running ||
                this.paused;

            this.running = false;
            this.paused = false;
            this.autoPaused = false;

            if (this.timer) {
                window.clearTimeout(this.timer);
                this.timer = 0;
            }

            if (options.abort !== false) {
                this.requestController?.abort?.(
                    abortError(
                        "Live data stream stopped."
                    )
                );
            }

            if (
                wasRunning &&
                options.silent !== true
            ) {
                this.emit("stop", {});
            }

            return wasRunning;
        }

        pause(options = {}) {
            if (!this.running || this.paused) {
                return false;
            }

            this.paused = true;

            if (this.timer) {
                window.clearTimeout(this.timer);
                this.timer = 0;
            }

            if (options.abort === true) {
                this.requestController?.abort?.(
                    abortError(
                        "Live data stream paused."
                    )
                );
            }

            if (options.automatic !== true) {
                this.autoPaused = false;
            }

            this.emit("pause", {
                automatic:
                    options.automatic === true
            });

            return true;
        }

        resume(options = {}) {
            if (!this.running) {
                this.start({
                    immediate:
                        options.immediate !== false
                });
                return true;
            }

            if (!this.paused) {
                return false;
            }

            const automatic =
                options.automatic === true;

            this.paused = false;
            this.autoPaused = false;

            this.emit("resume", {
                automatic
            });

            this.schedule(
                options.immediate === true
                    ? 0
                    : this.nextDelay()
            );

            return true;
        }

        reset(options = {}) {
            this.cursor = "";
            this.after = new Date(
                Date.now() -
                this.options.initialLookback
            ).toISOString();

            this.recentKeys.clear();
            this.recentQueue = [];
            this.failureCount = 0;
            this.lastError = null;
            this.staticFallbackLoaded = false;

            this.persistCursor();
            this.persistRecentKeys();

            this.emit("reset", {
                after: this.after
            });

            if (options.poll === true) {
                return this.poll({ force: true });
            }

            return true;
        }

        update(options = {}) {
            if (!isPlainObject(options)) {
                throw new TypeError(
                    "Live stream options must be an object."
                );
            }

            const wasRunning = this.running;
            const wasPaused = this.paused;

            if (options.endpoint !== undefined) {
                this.options.endpoint = text(
                    options.endpoint,
                    this.options.endpoint
                );
            }

            const integerOptions = [
                ["interval", 250, 3600000],
                ["hiddenInterval", 1000, 3600000],
                ["limit", 1, 5000],
                ["batchLimit", 1, 100],
                ["timeout", 1000, 120000],
                ["recentKeyLimit", 32, 50000],
                ["initialLookback", 0, 604800000],
                ["retryMinimum", 250, 60000],
                ["retryMaximum", 1000, 3600000],
                ["fallbackLimit", 1, 100000]
            ];

            for (const [key, minimum, maximum] of integerOptions) {
                if (options[key] !== undefined) {
                    this.options[key] = integer(
                        options[key],
                        this.options[key],
                        minimum,
                        maximum
                    );
                }
            }

            if (options.provider !== undefined) {
                this.options.provider =
                    text(options.provider);
            }

            if (options.retryFactor !== undefined) {
                this.options.retryFactor = number(
                    options.retryFactor,
                    this.options.retryFactor,
                    1,
                    10
                );
            }

            if (options.jitter !== undefined) {
                this.options.jitter = number(
                    options.jitter,
                    this.options.jitter,
                    0,
                    1
                );
            }

            for (const key of [
                "autoplay",
                "pauseWhenHidden",
                "persistCursor",
                "persistRecentKeys",
                "fallbackToStatic",
                "stopOnPermanentError"
            ]) {
                if (options[key] !== undefined) {
                    this.options[key] = boolean(
                        options[key],
                        this.options[key]
                    );
                }
            }

            if (wasRunning) {
                if (this.timer) {
                    window.clearTimeout(this.timer);
                    this.timer = 0;
                }

                if (!wasPaused) {
                    this.schedule(0);
                }
            }

            this.emit("update", {
                options: this.publicOptions()
            });

            return this;
        }

        publicOptions() {
            return {
                endpoint: this.options.endpoint,
                interval: this.options.interval,
                hiddenInterval: this.options.hiddenInterval,
                limit: this.options.limit,
                batchLimit: this.options.batchLimit,
                timeout: this.options.timeout,
                provider: this.options.provider,
                autoplay: this.options.autoplay,
                pauseWhenHidden:
                    this.options.pauseWhenHidden,
                persistCursor:
                    this.options.persistCursor,
                persistRecentKeys:
                    this.options.persistRecentKeys,
                fallbackToStatic:
                    this.options.fallbackToStatic,
                fallbackLimit:
                    this.options.fallbackLimit,
                stopOnPermanentError:
                    this.options.stopOnPermanentError
            };
        }

        status() {
            return {
                name:
                    "speciedex-live-data-stream",
                module: MODULE_NAME,
                version: VERSION,
                running: this.running,
                paused: this.paused,
                autoPaused: this.autoPaused,
                endpoint: this.options.endpoint,
                cursor: this.cursor,
                after: this.after,
                pending:
                    Boolean(
                        this.requestController ||
                        this.pollPromise
                    ),
                staticFallbackLoaded:
                    this.staticFallbackLoaded,
                failureCount: this.failureCount,
                lastRequestAt: this.lastRequestAt,
                lastSuccessAt: this.lastSuccessAt,
                lastRecordAt: this.lastRecordAt,
                lastDuration: this.lastDuration,
                options: this.publicOptions(),
                metrics: { ...this.metrics },
                lastError: this.lastError
                    ? {
                        name: this.lastError.name,
                        message: this.lastError.message,
                        status:
                            this.lastError.status || null
                    }
                    : null,
                destroyed: this.destroyed
            };
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            this.stop({ silent: true });

            document.removeEventListener(
                "visibilitychange",
                this._visibilityHandler
            );

            /*
            Emit while the instance is still active so listeners receive the
            terminal lifecycle event before teardown becomes final.
            */
            this.emit("destroy", {});
            this.destroyed = true;

            if (Speciedex.liveDataStream === this) {
                Speciedex.liveDataStream = null;
            }

            return true;
        }
    }

    function initializeLiveData(options = {}) {
        if (
            Speciedex.liveDataStream instanceof LiveDataStream &&
            !Speciedex.liveDataStream.destroyed
        ) {
            if (
                isPlainObject(options) &&
                Object.keys(options).length
            ) {
                Speciedex.liveDataStream.update(options);
            }

            return Speciedex.liveDataStream;
        }

        const stream = new LiveDataStream(options);
        Speciedex.liveDataStream = stream;
        return stream;
    }

    function getLiveDataStream() {
        return Speciedex.liveDataStream || null;
    }

    async function initializeData(options = {}) {
        if (initializationPromise) {
            return initializationPromise;
        }

        initializationPromise = (async () => {
            if (Speciedex.dataInitialized) {
                const existing = getLiveDataStream();

                if (
                    options.live !== false &&
                    !existing
                ) {
                    initializeLiveData(
                        isPlainObject(options.live)
                            ? options.live
                            : {}
                    );
                }

                return {
                    data: Speciedex.Data,
                    stream: getLiveDataStream()
                };
            }

            const root = getDataRootURL().href;
            const liveOptions = isPlainObject(options.live)
                ? options.live
                : {};

            let stream = null;

            if (options.live !== false) {
                stream = initializeLiveData(liveOptions);
            }

            Speciedex.dataInitialized = true;

            dispatchDataEvent(
                "speciedex:data-ready",
                {
                    root,
                    stream:
                        stream?.status?.() || null,
                    version: VERSION
                }
            );

            return {
                data: Speciedex.Data,
                stream
            };
        })();

        try {
            return await initializationPromise;
        } catch (error) {
            Speciedex.dataInitialized = false;
            throw error;
        } finally {
            initializationPromise = null;
        }
    }

    Speciedex.Data = Object.freeze({
        name: MODULE_NAME,
        version: VERSION,
        getURL: getDataURL,
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
        clearCache: clearDataCache,
        hasCache: hasCachedData,
        dispatch: dispatchDataEvent,
        normalizeLiveRecord,
        normalizeLiveResponse,
        normalizeDatasetRecords,
        liveRecordKey,
        extractLiveRecords,
        extractCursor,
        extractHasMore,
        LiveDataStream,
        initializeLive: initializeLiveData,
        getLiveStream: getLiveDataStream,
        initialize: initializeData
    });

    Speciedex.getDataURL = getDataURL;
    Speciedex.fetchJSON = fetchJSON;
    Speciedex.clearDataCache = clearDataCache;
    Speciedex.initializeData = initializeData;
    Speciedex.initializeLiveData = initializeLiveData;

    const autoInitialize = () => {
        initializeData().catch(error => {
            dispatchDataEvent(
                "speciedex:data-initialize-error",
                {
                    error: {
                        name: error?.name || "Error",
                        message:
                            error?.message ||
                            String(error)
                    }
                }
            );
        });
    };

    if (document.readyState === "loading") {
        document.addEventListener(
            "DOMContentLoaded",
            autoInitialize,
            { once: true }
        );
    } else {
        autoInitialize();
    }

    dispatchDataEvent(
        "speciedex:data-module-available",
        {
            module: Speciedex.Data,
            version: VERSION
        }
    );
})();
