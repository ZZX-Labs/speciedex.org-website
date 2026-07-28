/*
========================================================================
Speciedex.org
Terminal Scan Module
========================================================================

SpeciedexTerminal ingestion and anomaly-scanning coordinator.

Responsibilities:

    • scan terminal library collections
    • scan provider results
    • scan imported records
    • inspect archives and search results
    • normalize record identity
    • detect duplicates
    • detect likely synonyms
    • detect conflicts
    • detect missing identifiers and taxonomic ranks
    • detect malformed coordinates and timestamps
    • coordinate progress and loading services
    • emit live species records to terminal-splash.js
    • maintain job history, statistics, results, and errors
    • support pause, resume, and cancellation
    • export scan reports
    • expose terminal commands

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Scan";
    const VERSION = "2.2.0";

    const SERVICE_SYMBOL =
        Symbol.for(
            "speciedex.terminal.scan.service"
        );

    const RESERVED_KEYS =
        new Set([
            "__proto__",
            "prototype",
            "constructor"
        ]);

    const activeDispatches =
        new WeakMap();

    const DEFAULT_OPTIONS = Object.freeze({
        collection: "records",
        batchSize: 100,
        concurrency: 1,
        maximumHistory: 250,
        maximumResults: 10000,
        maximumErrors: 2000,
        emitRecords: true,
        updateLibrary: true,
        rebuildIndex: true,
        detectDuplicates: true,
        detectConflicts: true,
        detectMissing: true,
        detectCoordinates: true,
        detectTimestamps: true,
        retainRecords: false,
        maximumJobs: 500,
        progressInterval: 100,
        eventBatchSize: 50,
        rebuildIndexMode: "deferred",
        notifyOnComplete: true
    });

    const REQUIRED_TAXON_FIELDS = Object.freeze([
        "scientific_name",
        "rank"
    ]);

    const IDENTIFIER_FIELDS = Object.freeze([
        "speciedex_id",
        "id",
        "taxon_id",
        "taxonID",
        "key",
        "uuid",
        "guid"
    ]);

    const SCIENTIFIC_NAME_FIELDS = Object.freeze([
        "scientific_name",
        "scientificName",
        "canonical_name",
        "canonicalName",
        "name"
    ]);

    const COMMON_NAME_FIELDS = Object.freeze([
        "common_name",
        "commonName",
        "vernacular_name",
        "vernacularName"
    ]);

    const PROVIDER_FIELDS = Object.freeze([
        "provider",
        "provider_id",
        "providerId",
        "source",
        "dataset"
    ]);

    const RANK_FIELDS = Object.freeze([
        "rank",
        "taxon_rank",
        "taxonRank"
    ]);

    const LATITUDE_FIELDS = Object.freeze([
        "latitude",
        "decimalLatitude",
        "lat"
    ]);

    const LONGITUDE_FIELDS = Object.freeze([
        "longitude",
        "decimalLongitude",
        "lon",
        "lng"
    ]);

    const TIMESTAMP_FIELDS = Object.freeze([
        "timestamp",
        "updated_at",
        "updatedAt",
        "modified",
        "last_updated",
        "lastUpdated",
        "eventDate"
    ]);

    function isObject(value) {
        return (
            value !== null &&
            typeof value === "object" &&
            !Array.isArray(value)
        );
    }

    function nowISO(value = Date.now()) {
        const date =
            value instanceof Date
                ? value
                : new Date(value);

        return Number.isFinite(date.getTime())
            ? date.toISOString()
            : nowISO();
    }

    function monotonicNow() {
        return (
            typeof performance !== "undefined" &&
            typeof performance.now === "function"
        )
            ? monotonicNow()
            : Date.now();
    }

    function dispatchSafe(target, name, detail, options = {}) {
        if (
            !target ||
            typeof target.dispatchEvent !== "function" ||
            !name
        ) {
            return false;
        }

        let names =
            activeDispatches.get(target);

        if (!names) {
            names = new Set();
            activeDispatches.set(target, names);
        }

        if (names.has(name)) {
            return false;
        }

        names.add(name);

        try {
            return target.dispatchEvent(
                new CustomEvent(
                    name,
                    {
                        bubbles:
                            options.bubbles === true,
                        cancelable:
                            options.cancelable === true,
                        detail
                    }
                )
            );
        } catch (_error) {
            return false;
        } finally {
            names.delete(name);
        }
    }

    function safeStringify(value, compact = false) {
        return JSON.stringify(
            cloneValue(value),
            null,
            compact ? 0 : 2
        );
    }

    function makeAbortError(message = "Scan cancelled.") {
        if (typeof DOMException === "function") {
            return new DOMException(
                message,
                "AbortError"
            );
        }

        const error =
            new Error(message);

        error.name =
            "AbortError";

        return error;
    }

    function makeID(prefix = "scan") {
        if (window.crypto && typeof window.crypto.randomUUID === "function") {
            return `${prefix}:${window.crypto.randomUUID()}`;
        }

        return `${prefix}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    }

    function normalizeText(value) {
        return String(value ?? "").trim();
    }

    function normalizeKey(value) {
        return normalizeText(value)
            .normalize("NFKC")
            .toLowerCase()
            .replace(/\s+/g, " ");
    }

    function parseBoolean(value, fallback = false) {
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
            String(value)
                .trim()
                .toLowerCase();

        if (
            ["1", "true", "yes", "on", "enabled"].includes(
                normalized
            )
        ) {
            return true;
        }

        if (
            ["0", "false", "no", "off", "disabled"].includes(
                normalized
            )
        ) {
            return false;
        }

        return fallback;
    }

    function parseInteger(value, fallback, minimum, maximum) {
        const parsed = Number.parseInt(value, 10);

        if (!Number.isFinite(parsed)) {
            return fallback;
        }

        return Math.min(maximum, Math.max(minimum, parsed));
    }

    function parseNumber(value, fallback = null) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function firstValue(record, fields) {
        for (const field of fields) {
            if (RESERVED_KEYS.has(field)) {
                continue;
            }

            const value = record?.[field];

            if (value !== undefined && value !== null && value !== "") {
                return value;
            }
        }

        return null;
    }

    function cloneValue(
        value,
        seen = new WeakMap(),
        depth = 0
    ) {
        if (
            value === null ||
            value === undefined ||
            typeof value !== "object"
        ) {
            return typeof value === "bigint"
                ? String(value)
                : value;
        }

        if (depth > 24) {
            return "[Truncated]";
        }

        if (seen.has(value)) {
            return "[Circular]";
        }

        seen.set(value, true);

        if (value instanceof Date) {
            return nowISO(value);
        }

        if (value instanceof Error) {
            return {
                name:
                    value.name,
                message:
                    value.message,
                stack:
                    value.stack ||
                    null
            };
        }

        if (Array.isArray(value)) {
            return value.map(
                item =>
                    cloneValue(
                        item,
                        seen,
                        depth + 1
                    )
            );
        }

        const output = {};

        for (
            const [key, item]
            of Object.entries(value)
        ) {
            if (RESERVED_KEYS.has(key)) {
                continue;
            }

            output[key] =
                cloneValue(
                    item,
                    seen,
                    depth + 1
                );
        }

        return output;
    }

    function safeError(error) {
        if (error instanceof Error) {
            return {
                name: error.name,
                message: error.message,
                stack: error.stack || null
            };
        }

        return {
            name: "Error",
            message: String(error)
        };
    }

    function normalizeRecord(record, index = 0, source = "unknown") {
        const safeRecord =
            isObject(record)
                ? record
                : {
                    value:
                        record
                };

        record =
            safeRecord;

        const scientificName = normalizeText(
            firstValue(record, SCIENTIFIC_NAME_FIELDS)
        );

        const commonName = normalizeText(
            firstValue(record, COMMON_NAME_FIELDS)
        );

        const provider = normalizeText(
            firstValue(record, PROVIDER_FIELDS) || source
        );

        const identifier = normalizeText(
            firstValue(record, IDENTIFIER_FIELDS)
        );

        const rank = normalizeText(
            firstValue(record, RANK_FIELDS)
        ).toLowerCase();

        const latitude = parseNumber(
            firstValue(record, LATITUDE_FIELDS),
            null
        );

        const longitude = parseNumber(
            firstValue(record, LONGITUDE_FIELDS),
            null
        );

        const timestampValue = firstValue(record, TIMESTAMP_FIELDS);
        const timestamp = timestampValue ? Date.parse(timestampValue) : null;

        const identity = identifier
            ? `id:${normalizeKey(identifier)}`
            : scientificName
                ? `name:${normalizeKey(scientificName)}|rank:${rank || "unknown"}`
                : `record:${source}:${index}`;

        return {
            index,
            source,
            identity,
            identifier,
            scientificName,
            commonName,
            provider,
            rank,
            latitude,
            longitude,
            timestamp: Number.isFinite(timestamp) ? timestamp : null,
            record
        };
    }

    function classifyRecord(record) {
        const normalized =
            record &&
            typeof record.identity === "string"
                ? record
                : normalizeRecord(record);

        if (normalized.scientificName) {
            return "taxon";
        }

        if (
            normalized.latitude !== null ||
            normalized.longitude !== null
        ) {
            return "occurrence";
        }

        return "generic";
    }

    function serializeIssue(issue) {
        return {
            id: issue.id,
            type: issue.type,
            severity: issue.severity,
            message: issue.message,
            recordIndex: issue.recordIndex,
            identity: issue.identity,
            provider: issue.provider,
            scientificName: issue.scientificName,
            fields: [...(issue.fields || [])],
            related: cloneValue(issue.related || null),
            timestamp: issue.timestamp
        };
    }

    function createIssue(type, normalized, message, options = {}) {
        return {
            id: makeID("issue"),
            type,
            severity: options.severity || "warning",
            message,
            recordIndex: normalized.index,
            identity: normalized.identity,
            provider: normalized.provider,
            scientificName: normalized.scientificName,
            fields: options.fields || [],
            related: options.related || null,
            timestamp: nowISO()
        };
    }

    function isAbortError(
        error
    ) {
        return Boolean(
            error &&
            (
                error.name ===
                    "AbortError" ||
                error.code ===
                    20
            )
        );
    }

    function yieldToMainThread() {
        return new Promise(
            resolve => {
                if (
                    typeof window.requestIdleCallback ===
                        "function"
                ) {
                    window.requestIdleCallback(
                        () =>
                            resolve(),
                        {
                            timeout:
                                50
                        }
                    );

                    return;
                }

                window.setTimeout(
                    resolve,
                    0
                );
            }
        );
    }

    function escapeCSV(value) {
        const text = String(value ?? "");

        if (/[",\n\r]/.test(text)) {
            return `"${text.replace(/"/g, '""')}"`;
        }

        return text;
    }

    class ScanJob extends EventTarget {
        constructor(service, options = {}) {
            super();

            this.service = service;
            this.context = service.context;
            this.options = {
                ...DEFAULT_OPTIONS,
                ...options,
                batchSize:
                    parseInteger(
                        options.batchSize,
                        DEFAULT_OPTIONS.batchSize,
                        1,
                        10000
                    ),
                maximumResults:
                    parseInteger(
                        options.maximumResults,
                        DEFAULT_OPTIONS.maximumResults,
                        1,
                        1000000
                    ),
                maximumErrors:
                    parseInteger(
                        options.maximumErrors,
                        DEFAULT_OPTIONS.maximumErrors,
                        1,
                        1000000
                    ),
                eventBatchSize:
                    parseInteger(
                        options.eventBatchSize,
                        DEFAULT_OPTIONS.eventBatchSize,
                        1,
                        10000
                    ),
                progressInterval:
                    parseInteger(
                        options.progressInterval,
                        DEFAULT_OPTIONS.progressInterval,
                        16,
                        10000
                    ),
                emitRecords:
                    parseBoolean(
                        options.emitRecords,
                        DEFAULT_OPTIONS.emitRecords
                    ),
                updateLibrary:
                    parseBoolean(
                        options.updateLibrary,
                        DEFAULT_OPTIONS.updateLibrary
                    ),
                rebuildIndex:
                    parseBoolean(
                        options.rebuildIndex,
                        DEFAULT_OPTIONS.rebuildIndex
                    ),
                detectDuplicates:
                    parseBoolean(
                        options.detectDuplicates,
                        DEFAULT_OPTIONS.detectDuplicates
                    ),
                detectConflicts:
                    parseBoolean(
                        options.detectConflicts,
                        DEFAULT_OPTIONS.detectConflicts
                    ),
                detectMissing:
                    parseBoolean(
                        options.detectMissing,
                        DEFAULT_OPTIONS.detectMissing
                    ),
                detectCoordinates:
                    parseBoolean(
                        options.detectCoordinates,
                        DEFAULT_OPTIONS.detectCoordinates
                    ),
                detectTimestamps:
                    parseBoolean(
                        options.detectTimestamps,
                        DEFAULT_OPTIONS.detectTimestamps
                    ),
                retainRecords:
                    parseBoolean(
                        options.retainRecords,
                        DEFAULT_OPTIONS.retainRecords
                    )
            };

            this.id = options.id || makeID("scan");
            this.type = options.type || "library";
            this.source = options.source || options.collection || "records";
            this.label = options.label || `Scan ${this.source}`;
            this.state = "pending";
            this.createdAt = nowISO();
            this.startedAt = null;
            this.completedAt = null;
            this.pausedAt = null;
            this.pausedDuration = 0;
            this.duration = 0;
            this.processed = 0;
            this.total = 0;
            this.percent = 0;
            this.records = [];
            this.results = [];
            this.errors = [];
            this.statistics = {
                scanned: 0,
                accepted: 0,
                rejected: 0,
                duplicates: 0,
                conflicts: 0,
                missing: 0,
                coordinateErrors: 0,
                timestampErrors: 0,
                taxa: 0,
                occurrences: 0,
                generic: 0,
                providers:
                    Object.create(null)
            };

            this.identityMap = new Map();
            this.nameMap = new Map();
            this.abortController =
                typeof AbortController === "function"
                    ? new AbortController()
                    : {
                        signal: {
                            aborted: false,
                            addEventListener() {}
                        },
                        abort() {
                            this.signal.aborted = true;
                        }
                    };
            this.pausePromise = null;
            this.pauseResolve = null;
            this.progressID = `scan:${this.id}`;
            this.loadingID = `scan:${this.id}`;
            this.lastProgressEmit = 0;
            this.pendingRecords = [];
            this.destroyed = false;
        }

        snapshot(options = {}) {
            return {
                id: this.id,
                type: this.type,
                source: this.source,
                label: this.label,
                state: this.state,
                createdAt: this.createdAt,
                startedAt: this.startedAt,
                completedAt: this.completedAt,
                duration: this.duration,
                processed: this.processed,
                total: this.total,
                percent: this.percent,
                statistics: cloneValue(this.statistics),
                results: options.includeResults
                    ? this.results.map(serializeIssue)
                    : undefined,
                errors: options.includeErrors
                    ? cloneValue(this.errors)
                    : undefined,
                options: {
                    collection: this.options.collection,
                    batchSize: this.options.batchSize,
                    concurrency: this.options.concurrency,
                    emitRecords: this.options.emitRecords,
                    updateLibrary: this.options.updateLibrary,
                    rebuildIndex: this.options.rebuildIndex,
                    detectDuplicates: this.options.detectDuplicates,
                    detectConflicts: this.options.detectConflicts,
                    detectMissing: this.options.detectMissing,
                    detectCoordinates: this.options.detectCoordinates,
                    detectTimestamps: this.options.detectTimestamps,
                    progressInterval: this.options.progressInterval,
                    eventBatchSize: this.options.eventBatchSize,
                    rebuildIndexMode: this.options.rebuildIndexMode
                },
                aborted: this.abortController.signal.aborted
            };
        }

        setState(state) {
            if (
                this.destroyed ||
                this.state ===
                    state
            ) {
                return false;
            }

            this.state = state;
            dispatchSafe(
                this,
                "state",
                this.snapshot()
            );
            this.service.emit(`job:${state}`, {
                job: this.snapshot()
            });

            return true;
        }

        async waitIfPaused() {
            if (this.state !== "paused") {
                return;
            }

            if (!this.pausePromise) {
                this.pausePromise = new Promise(resolve => {
                    this.pauseResolve = resolve;
                });
            }

            await Promise.race([
                this.pausePromise,
                new Promise(
                    (
                        _resolve,
                        reject
                    ) => {
                        if (
                            this.abortController.signal.aborted
                        ) {
                            reject(
                                makeAbortError(
                                    "Scan cancelled."
                                )
                            );

                            return;
                        }

                        this.abortController.signal.addEventListener(
                            "abort",
                            () =>
                                reject(
                                    new DOMException(
                                        "Scan cancelled.",
                                        "AbortError"
                                    )
                                ),
                            {
                                once:
                                    true
                            }
                        );
                    }
                )
            ]);
        }

        pause() {
            if (this.state !== "running") {
                return false;
            }

            this.pausedAt = monotonicNow();
            this.setState("paused");
            this.service.context.progress?.pause?.(this.progressID);

            return true;
        }

        resume() {
            if (this.state !== "paused") {
                return false;
            }

            if (
                this.pausedAt !== null
            ) {
                this.pausedDuration +=
                    Math.max(
                        0,
                        monotonicNow() -
                        this.pausedAt
                    );
            }

            this.pausedAt = null;

            this.setState("running");
            this.service.context.progress?.resume?.(this.progressID);
            this.pauseResolve?.();
            this.pauseResolve = null;
            this.pausePromise = null;

            return true;
        }

        cancel(reason = "cancelled") {
            if (["complete", "failed", "cancelled"].includes(this.state)) {
                return false;
            }

            try {
                this.abortController.abort(
                    reason
                );
            } catch (_error) {
                this.abortController.abort();
            }
            this.pauseResolve?.();
            this.pauseResolve = null;
            this.pausePromise = null;
            this.completedAt = nowISO();
            this.setState("cancelled");
            this.service.context.progress?.cancel?.(
                this.progressID,
                reason
            );
            this.service.context.loading?.cancel?.(
                this.loadingID
            );

            return true;
        }

        updateProgress(
            force = false
        ) {
            this.percent = this.total
                ? Math.min(
                    100,
                    (
                        this.processed /
                        this.total
                    ) *
                    100
                )
                : 0;

            const now =
                monotonicNow();

            if (
                !force &&
                now -
                this.lastProgressEmit <
                this.options.progressInterval
            ) {
                return false;
            }

            this.lastProgressEmit =
                now;

            this.context.progress?.set?.(
                this.progressID,
                this.percent,
                {
                    label:
                        this.label,
                    complete:
                        false,
                    metadata: {
                        processed:
                            this.processed,
                        total:
                            this.total
                    }
                }
            );

            this.context.loading?.setProgress?.(
                this.loadingID,
                this.percent,
                `${this.label}: ${this.processed}/${this.total}`
            );

            this.service.emit(
                "progress",
                {
                    job:
                        this.snapshot()
                }
            );

            return true;
        }

        flushRecordEvents() {
            if (
                !this.pendingRecords.length
            ) {
                return 0;
            }

            const records =
                this.pendingRecords.splice(
                    0
                );

            this.service.emit(
                "records",
                {
                    scanId:
                        this.id,
                    source:
                        this.source,
                    records
                }
            );

            return records.length;
        }

        addIssue(issue) {
            this.results.push(issue);
            this.results = this.results.slice(
                -this.options.maximumResults
            );

            switch (issue.type) {
                case "duplicate":
                    this.statistics.duplicates += 1;
                    break;
                case "conflict":
                    this.statistics.conflicts += 1;
                    break;
                case "missing":
                    this.statistics.missing += 1;
                    break;
                case "coordinate":
                    this.statistics.coordinateErrors += 1;
                    break;
                case "timestamp":
                    this.statistics.timestampErrors += 1;
                    break;
                default:
                    break;
            }

            this.service.emit(issue.type, {
                job: {
                    id:
                        this.id,
                    source:
                        this.source,
                    processed:
                        this.processed,
                    total:
                        this.total,
                    state:
                        this.state
                },
                issue:
                    serializeIssue(
                        issue
                    )
            });
        }

        emitRecord(
            normalized
        ) {
            if (
                !this.options.emitRecords
            ) {
                return;
            }

            const detail = {
                scanId:
                    this.id,
                source:
                    this.source,
                provider:
                    normalized.provider,
                identifier:
                    normalized.identifier,
                speciedexId:
                    normalized.identifier,
                scientificName:
                    normalized.scientificName,
                commonName:
                    normalized.commonName,
                rank:
                    normalized.rank,
                record:
                    normalized.record
            };

            this.pendingRecords.push(
                detail
            );

            if (
                this.pendingRecords.length >=
                this.options.eventBatchSize
            ) {
                this.flushRecordEvents();
            }

            if (
                normalized.scientificName
            ) {
                this.service.emit(
                    "species",
                    detail
                );

                dispatchSafe(
                    document,
                    "speciedex:terminal-splash-record",
                    cloneValue(detail)
                );
            }
        }

        inspectMissing(normalized) {
            if (!this.options.detectMissing) {
                return;
            }

            const missing = [];

            if (!normalized.scientificName) {
                missing.push("scientific_name");
            }

            if (!normalized.rank) {
                missing.push("rank");
            }

            if (!normalized.identifier) {
                missing.push("identifier");
            }

            if (missing.length) {
                this.addIssue(
                    createIssue(
                        "missing",
                        normalized,
                        `Missing required or recommended fields: ${missing.join(", ")}`,
                        {
                            severity: missing.includes("scientific_name")
                                ? "error"
                                : "warning",
                            fields: missing
                        }
                    )
                );
            }
        }

        inspectCoordinates(normalized) {
            if (!this.options.detectCoordinates) {
                return;
            }

            const hasLatitude = normalized.latitude !== null;
            const hasLongitude = normalized.longitude !== null;

            if (hasLatitude !== hasLongitude) {
                this.addIssue(
                    createIssue(
                        "coordinate",
                        normalized,
                        "Incomplete coordinate pair.",
                        {
                            severity: "warning",
                            fields: ["latitude", "longitude"]
                        }
                    )
                );

                return;
            }

            if (
                hasLatitude &&
                (
                    normalized.latitude < -90 ||
                    normalized.latitude > 90 ||
                    normalized.longitude < -180 ||
                    normalized.longitude > 180
                )
            ) {
                this.addIssue(
                    createIssue(
                        "coordinate",
                        normalized,
                        "Coordinate is outside valid latitude/longitude bounds.",
                        {
                            severity: "error",
                            fields: ["latitude", "longitude"],
                            related: {
                                latitude: normalized.latitude,
                                longitude: normalized.longitude
                            }
                        }
                    )
                );
            }
        }

        inspectTimestamp(normalized) {
            if (!this.options.detectTimestamps) {
                return;
            }

            const raw = firstValue(
                normalized.record,
                TIMESTAMP_FIELDS
            );

            if (raw && normalized.timestamp === null) {
                this.addIssue(
                    createIssue(
                        "timestamp",
                        normalized,
                        `Invalid timestamp: ${raw}`,
                        {
                            severity: "warning",
                            fields: ["timestamp"]
                        }
                    )
                );
            }
        }

        inspectDuplicate(normalized) {
            if (!this.options.detectDuplicates) {
                return;
            }

            const previous = this.identityMap.get(
                normalized.identity
            );

            if (previous) {
                this.addIssue(
                    createIssue(
                        "duplicate",
                        normalized,
                        `Duplicate identity detected: ${normalized.identity}`,
                        {
                            severity: "warning",
                            related: {
                                previousIndex: previous.index,
                                previousProvider: previous.provider
                            }
                        }
                    )
                );

                return;
            }

            this.identityMap.set(
                normalized.identity,
                normalized
            );
        }

        inspectConflict(normalized) {
            if (
                !this.options.detectConflicts ||
                !normalized.scientificName
            ) {
                return;
            }

            const key = normalizeKey(
                normalized.scientificName
            );

            const previous = this.nameMap.get(key);

            if (
                previous &&
                (
                    previous.rank !== normalized.rank ||
                    (
                        previous.identifier &&
                        normalized.identifier &&
                        previous.identifier !== normalized.identifier
                    )
                )
            ) {
                this.addIssue(
                    createIssue(
                        "conflict",
                        normalized,
                        `Conflicting assertions for ${normalized.scientificName}.`,
                        {
                            severity: "warning",
                            fields: ["rank", "identifier"],
                            related: {
                                previousIndex: previous.index,
                                previousRank: previous.rank,
                                previousIdentifier: previous.identifier,
                                currentRank: normalized.rank,
                                currentIdentifier: normalized.identifier
                            }
                        }
                    )
                );
            } else if (!previous) {
                this.nameMap.set(
                    key,
                    normalized
                );
            }
        }

        inspectRecord(record, index) {
            const normalized = normalizeRecord(
                record,
                index,
                this.source
            );

            const classification =
                classifyRecord(normalized);
            this.statistics[classification === "taxon"
                ? "taxa"
                : classification === "occurrence"
                    ? "occurrences"
                    : "generic"] += 1;

            const provider = normalized.provider || "unknown";
            this.statistics.providers[provider] =
                (this.statistics.providers[provider] || 0) + 1;

            this.inspectMissing(normalized);
            this.inspectCoordinates(normalized);
            this.inspectTimestamp(normalized);
            this.inspectDuplicate(normalized);
            this.inspectConflict(normalized);
            this.emitRecord(normalized);

            const fatal =
                this.results
                    .slice(
                        -8
                    )
                    .some(
                        issue =>
                            issue.recordIndex ===
                                index &&
                            issue.severity ===
                                "error"
                    );

            if (fatal) {
                this.statistics.rejected += 1;
            } else {
                this.statistics.accepted += 1;
            }

            if (this.options.retainRecords) {
                this.records.push(record);
            }

            return normalized;
        }

        async run(records) {
            if (!Array.isArray(records)) {
                throw new TypeError(
                    "Scan input must be an array of records."
                );
            }

            if (
                this.state !==
                "pending"
            ) {
                throw new Error(
                    `Scan job ${this.id} has already started.`
                );
            }

            this.total =
                records.length;
            this.startedAt = nowISO();
            this.startedPerformance = monotonicNow();
            this.setState("running");

            this.context.progress?.begin?.(
                this.progressID,
                this.label,
                {
                    maximum: 100,
                    cancellable: true,
                    description: `Scanning ${this.total} records from ${this.source}.`
                }
            );

            this.context.loading?.begin?.(
                this.loadingID,
                this.label,
                {
                    progress: 0,
                    cancellable: true,
                    metadata: {
                        source: this.source,
                        scanId: this.id
                    }
                }
            );

            const batchSize =
                parseInteger(
                    this.options.batchSize,
                    DEFAULT_OPTIONS.batchSize,
                    1,
                    10000
                );

            this.options.progressInterval =
                parseInteger(
                    this.options.progressInterval,
                    DEFAULT_OPTIONS.progressInterval,
                    16,
                    10000
                );

            this.options.eventBatchSize =
                parseInteger(
                    this.options.eventBatchSize,
                    DEFAULT_OPTIONS.eventBatchSize,
                    1,
                    10000
                );

            try {
                for (
                    let offset = 0;
                    offset < records.length;
                    offset += batchSize
                ) {
                    if (this.abortController.signal.aborted) {
                        throw makeAbortError(
                            "Scan cancelled."
                        );
                    }

                    await this.waitIfPaused();

                    const batch = records.slice(
                        offset,
                        offset + batchSize
                    );

                    for (
                        let localIndex = 0;
                        localIndex < batch.length;
                        localIndex += 1
                    ) {
                        if (this.abortController.signal.aborted) {
                            throw new DOMException(
                                "Scan cancelled.",
                                "AbortError"
                            );
                        }

                        const index = offset + localIndex;

                        try {
                            this.inspectRecord(
                                batch[localIndex],
                                index
                            );
                        } catch (error) {
                            const failure = {
                                index,
                                error: safeError(error),
                                timestamp: nowISO()
                            };

                            this.errors.push(failure);
                            this.errors = this.errors.slice(
                                -this.options.maximumErrors
                            );
                            this.statistics.rejected += 1;

                            this.service.emit("record:error", {
                                job: this.snapshot(),
                                error: failure
                            });
                        }

                        this.processed += 1;
                        this.statistics.scanned += 1;
                    }

                    this.flushRecordEvents();
                    this.updateProgress();

                    await yieldToMainThread();
                }

                this.completedAt = nowISO();
                this.duration =
                    Math.max(
                        0,
                        monotonicNow() -
                        this.startedPerformance -
                        this.pausedDuration
                    );
                this.percent = 100;
                this.flushRecordEvents();
                this.updateProgress(
                    true
                );
                this.setState("complete");

                this.context.progress?.complete?.(
                    this.progressID,
                    this.snapshot()
                );

                this.context.loading?.end?.(
                    this.loadingID,
                    this.snapshot()
                );

                await this.finalize();

                return this.snapshot({
                    includeResults: true,
                    includeErrors: true
                });
            } catch (error) {
                this.completedAt = nowISO();
                this.duration =
                    Math.max(
                        0,
                        monotonicNow() -
                        this.startedPerformance -
                        this.pausedDuration
                    );

                if (
                    isAbortError(
                        error
                    ) ||
                    this.abortController.signal.aborted
                ) {
                    this.setState("cancelled");
                    this.context.progress?.cancel?.(
                        this.progressID,
                        "cancelled"
                    );
                    this.context.loading?.cancel?.(
                        this.loadingID
                    );
                } else {
                    this.errors.push({
                        index: null,
                        error: safeError(error),
                        timestamp: nowISO()
                    });

                    this.setState("failed");
                    this.context.progress?.fail?.(
                        this.progressID,
                        error
                    );
                    this.context.loading?.fail?.(
                        this.loadingID,
                        error
                    );
                }

                throw error;
            }
        }

        async finalize() {
            const serializedResults =
                this.results.map(
                    serializeIssue
                );

            const library =
                this.context.library ||
                this.context.services?.get?.(
                    "library"
                );

            if (
                this.options.updateLibrary &&
                library
            ) {
                const writeResults =
                    async () => {
                        await library.set?.(
                            `scan-results:${this.id}`,
                            serializedResults,
                            {
                                source:
                                    "scan",
                                description:
                                    `Scan findings for ${this.source}.`
                            }
                        );

                        await library.set?.(
                            "scan-results",
                            serializedResults,
                            {
                                source:
                                    "scan",
                                description:
                                    "Most recent Speciedex scan findings."
                            }
                        );
                    };

                if (
                    typeof library.batch ===
                        "function"
                ) {
                    const result =
                        library.batch(
                            writeResults
                        );

                    if (
                        result &&
                        typeof result.then ===
                            "function"
                    ) {
                        await result;
                    }
                } else {
                    await writeResults();
                }
            }

            const index =
                this.context.index ||
                this.context.services?.get?.(
                    "index"
                );

            if (
                this.options.rebuildIndex &&
                index &&
                this.options.collection
            ) {
                const libraryResult =
                    library?.get?.(
                        this.options.collection
                    );

                const records =
                    libraryResult &&
                    typeof libraryResult.then ===
                        "function"
                        ? await libraryResult
                        : libraryResult ||
                        [];

                const rebuild =
                    async () => {
                        if (
                            typeof index.rebuild ===
                                "function"
                        ) {
                            await index.rebuild(
                                records,
                                {
                                    source:
                                        "scan",
                                    collection:
                                        this.options.collection,
                                    scanId:
                                        this.id
                                }
                            );

                            return;
                        }

                        if (
                            typeof index.build ===
                                "function"
                        ) {
                            await index.build(
                                records,
                                {
                                    source:
                                        "scan",
                                    collection:
                                        this.options.collection,
                                    scanId:
                                        this.id
                                }
                            );
                        }
                    };

                if (
                    String(
                        this.options.rebuildIndexMode
                    ).toLowerCase() ===
                        "immediate"
                ) {
                    await rebuild();
                } else {
                    window.setTimeout(
                        () => {
                            if (!this.service.destroyed) {
                                Promise.resolve(
                                    rebuild()
                                ).catch(
                                    error =>
                                        this.service.emit(
                                            "index:error",
                                            {
                                                scanId:
                                                    this.id,
                                                error:
                                                    safeError(
                                                        error
                                                    )
                                            }
                                        )
                                );
                            }
                        },
                        0
                    );
                }
            }

            this.service.archive(
                this
            );

            if (
                this.options.notifyOnComplete
            ) {
                const notifications =
                    this.context.notifications ||
                    this.context.services?.get?.(
                        "notifications"
                    );

                notifications?.success?.(
                    `${this.label} complete: ${this.processed} records, ${this.results.length} findings.`,
                    {
                        title:
                            "Scan Complete",
                        timeout:
                            6000
                    }
                );
            }
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            for (
                const entry
                of this.queue.splice(0)
            ) {
                entry.job.cancel(
                    "service-destroyed"
                );

                entry.reject(
                    makeAbortError(
                        "Scan service destroyed."
                    )
                );
            }

            for (
                const job
                of this.jobs.values()
            ) {
                job.destroy();
            }

            this.emit(
                "destroy",
                {
                    version:
                        VERSION
                }
            );

            this.watchers.clear();
            this.jobs.clear();
            this.activeRuns.clear();
            this.history = [];
            this.lastJob = null;

            if (
                this.context.root?.[
                    SERVICE_SYMBOL
                ] ===
                    this
            ) {
                delete this.context.root[
                    SERVICE_SYMBOL
                ];
            }

            if (
                this.context.scan ===
                    this
            ) {
                delete this.context.scan;
            }

            this.destroyed = true;

            return true;
        }

    }

    function initialize(
        context = {}
    ) {
        const safeContext =
            isObject(context)
                ? context
                : {};

        const root =
            safeContext.root &&
            typeof safeContext.root.dispatchEvent ===
                "function"
                ? safeContext.root
                : document.documentElement;

        const existing =
            safeContext.scan instanceof
                ScanService
                ? safeContext.scan
                : safeContext.services?.get?.(
                    "scan"
                ) ||
                root?.[
                    SERVICE_SYMBOL
                ];

        if (
            existing instanceof
                ScanService &&
            !existing.destroyed
        ) {
            safeContext.scan =
                existing;

            safeContext.registerService?.(
                "scan",
                existing
            );

            return existing;
        }

        const dataset =
            root.dataset || {};

        const config =
            safeContext.config?.
                scan ||
            {};

        const service =
            new ScanService(
                {
                    ...safeContext,
                    root
                },
                {
                    collection:
                        dataset.
                            terminalScanCollection ||
                        config.collection ||
                        DEFAULT_OPTIONS.collection,

                    batchSize:
                        parseInteger(
                            dataset.
                                terminalScanBatchSize ??
                            config.batchSize,
                            DEFAULT_OPTIONS.batchSize,
                            1,
                            10000
                        ),

                    concurrency:
                        parseInteger(
                            dataset.
                                terminalScanConcurrency ??
                            config.concurrency,
                            DEFAULT_OPTIONS.concurrency,
                            1,
                            64
                        ),

                    maximumHistory:
                        parseInteger(
                            dataset.
                                terminalScanHistory ??
                            config.maximumHistory,
                            DEFAULT_OPTIONS.maximumHistory,
                            10,
                            5000
                        ),

                    maximumResults:
                        parseInteger(
                            dataset.
                                terminalScanResults ??
                            config.maximumResults,
                            DEFAULT_OPTIONS.maximumResults,
                            100,
                            100000
                        ),

                    maximumErrors:
                        parseInteger(
                            dataset.
                                terminalScanErrors ??
                            config.maximumErrors,
                            DEFAULT_OPTIONS.maximumErrors,
                            10,
                            100000
                        ),

                    maximumJobs:
                        parseInteger(
                            dataset.
                                terminalScanMaximumJobs ??
                            config.maximumJobs,
                            DEFAULT_OPTIONS.maximumJobs,
                            1,
                            100000
                        ),

                    emitRecords:
                        parseBoolean(
                            dataset.
                                terminalScanEmitRecords ??
                            config.emitRecords,
                            DEFAULT_OPTIONS.emitRecords
                        ),

                    updateLibrary:
                        parseBoolean(
                            dataset.
                                terminalScanUpdateLibrary ??
                            config.updateLibrary,
                            DEFAULT_OPTIONS.updateLibrary
                        ),

                    rebuildIndex:
                        parseBoolean(
                            dataset.
                                terminalScanRebuildIndex ??
                            config.rebuildIndex,
                            DEFAULT_OPTIONS.rebuildIndex
                        ),

                    rebuildIndexMode:
                        dataset.
                            terminalScanRebuildIndexMode ||
                        config.rebuildIndexMode ||
                        DEFAULT_OPTIONS.rebuildIndexMode,

                    progressInterval:
                        parseInteger(
                            dataset.
                                terminalScanProgressInterval ??
                            config.progressInterval,
                            DEFAULT_OPTIONS.progressInterval,
                            16,
                            10000
                        ),

                    eventBatchSize:
                        parseInteger(
                            dataset.
                                terminalScanEventBatchSize ??
                            config.eventBatchSize,
                            DEFAULT_OPTIONS.eventBatchSize,
                            1,
                            10000
                        ),

                    notifyOnComplete:
                        parseBoolean(
                            dataset.
                                terminalScanNotify ??
                            config.notifyOnComplete,
                            DEFAULT_OPTIONS.notifyOnComplete
                        )
                }
            );

        root[
            SERVICE_SYMBOL
        ] =
            service;

        safeContext.scan =
            service;

        safeContext.registerService?.(
            "scan",
            service
        );

        dispatchSafe(
            document,
            "speciedex:terminal-scan-ready",
            {
                context:
                    safeContext,
                service,
                version:
                    VERSION
            }
        );

        return service;
    }

    function download(
        content,
        filename,
        mime,
        context = {}
    ) {
        const exporter =
            context.exporter ||
            context.services?.get?.(
                "export"
            ) ||
            context.services?.get?.(
                "exporter"
            );

        if (
            exporter &&
            typeof exporter.download ===
                "function"
        ) {
            exporter.download(
                content,
                filename,
                mime
            );

            return filename;
        }

        if (
            typeof URL?.createObjectURL !==
                "function"
        ) {
            throw new Error(
                "Browser download URLs are unavailable."
            );
        }

        const blob =
            new Blob(
                [content],
                {
                    type:
                        mime
                }
            );

        const url =
            URL.createObjectURL(
                blob
            );

        const anchor =
            document.createElement(
                "a"
            );

        anchor.href = url;
        anchor.download = filename;

        (
            document.body ||
            document.documentElement
        ).appendChild(anchor);

        try {
            anchor.click();
        } finally {
            anchor.remove();

            window.setTimeout(
                () =>
                    URL.revokeObjectURL(
                        url
                    ),
                1000
            );
        }

        return filename;
    }

    function parsedOptions(parsed) {
        return {
            flags: parsed?.flags || {},
            options: parsed?.options || {}
        };
    }

    function resolveCommandContext(payload = {}) {
        return (
            payload.context ||
            payload.terminal?.context ||
            payload.app?.context ||
            payload
        );
    }

    function requireScan(context = {}) {
        const safeContext =
            isObject(context)
                ? context
                : {};

        const service =
            safeContext.scan ||
            safeContext.services?.get?.(
                "scan"
            ) ||
            initialize(safeContext);

        if (
            !(service instanceof ScanService) ||
            service.destroyed
        ) {
            throw new Error(
                "Scan service is unavailable."
            );
        }

        return service;
    }

    function writeResult(
        payload,
        value,
        type = "data"
    ) {
        if (
            typeof payload.writeJSON === "function" &&
            typeof value !== "string"
        ) {
            return payload.writeJSON(value);
        }

        if (typeof payload.write === "function") {
            return payload.write(
                typeof value === "string"
                    ? value
                    : safeStringify(value),
                type
            );
        }

        if (typeof payload.writeLine === "function") {
            return payload.writeLine(
                typeof value === "string"
                    ? value
                    : safeStringify(value)
            );
        }

        return value;
    }

    const commands = [
        {
            name: "scan",
            category: "data",
            description: "Scan a library collection for anomalies.",
            usage: "scan [collection] [--batch N] [--no-duplicates] [--no-conflicts] [--no-missing]",
            handler: async ({
                args = [],
                parsed = {
                    flags: {},
                    options: {}
                },
                context,
                writeJSON
            }) => {
                const service =
                    context.services?.get?.("scan") ||
                    context.scan;

                if (!service) {
                    throw new Error(
                        "Scan service is unavailable."
                    );
                }

                const parsedData = parsedOptions(parsed);
                const first = args[0] || "records";

                if (
                    [
                        "status",
                        "history",
                        "stats",
                        "statistics",
                        "queue",
                        "jobs",
                        "pause",
                        "resume",
                        "cancel",
                        "results",
                        "errors"
                    ].includes(first)
                ) {
                    return writeJSON(
                        await service.run({
                            args
                        })
                    );
                }

                return writeJSON(
                    await service.scanLibrary(
                        first,
                        {
                            batchSize:
                                parsedData.options.batch,

                            detectDuplicates:
                                !parsedData.flags[
                                    "no-duplicates"
                                ],

                            detectConflicts:
                                !parsedData.flags[
                                    "no-conflicts"
                                ],

                            detectMissing:
                                !parsedData.flags[
                                    "no-missing"
                                ],

                            detectCoordinates:
                                !parsedData.flags[
                                    "no-coordinates"
                                ],

                            detectTimestamps:
                                !parsedData.flags[
                                    "no-timestamps"
                                ],

                            progressInterval:
                                parsedData.options.progress,

                            eventBatchSize:
                                parsedData.options.events,

                            rebuildIndexMode:
                                parsedData.options[
                                    "index-mode"
                                ]
                        }
                    )
                );
            }
        },

        {
            name: "scan-provider",
            category: "data",
            description: "Scan one provider result set.",
            usage: "scan-provider <provider> [collection]",
            handler: async ({
                args,
                context,
                writeJSON
            }) => {
                const provider = args[0];

                if (!provider) {
                    throw new Error(
                        "A provider ID is required."
                    );
                }

                return writeJSON(
                    await context.scan.scanProvider(
                        provider,
                        {
                            collection: args[1]
                        }
                    )
                );
            }
        },

        {
            name: "scan-search",
            category: "data",
            description: "Search and scan the returned records.",
            usage: "scan-search <query>",
            handler: async ({
                args,
                context,
                writeJSON
            }) => {
                const query = args.join(" ");

                if (!query) {
                    throw new Error(
                        "A search query is required."
                    );
                }

                return writeJSON(
                    await context.scan.scanSearch(
                        query
                    )
                );
            }
        },

        {
            name: "scan-archive",
            category: "data",
            description: "Scan an archive library collection.",
            usage: "scan-archive [collection]",
            handler: async ({
                args,
                context,
                writeJSON
            }) =>
                writeJSON(
                    await context.scan.scanArchive(
                        args[0] ||
                        "archive"
                    )
                )
        },

        {
            name: "scan-status",
            category: "data",
            description: "Display scan-service status.",
            usage: "scan-status",
            handler: ({
                context,
                writeJSON
            }) =>
                writeJSON(
                    context.scan.status()
                )
        },

        {
            name: "scan-history",
            category: "data",
            description: "Display scan history.",
            usage: "scan-history [count]",
            handler: ({
                args,
                context,
                writeJSON
            }) => {
                const count = parseInteger(
                    args[0],
                    25,
                    1,
                    1000
                );

                return writeJSON(
                    context.scan.history.slice(
                        -count
                    )
                );
            }
        },

        {
            name: "scan-stats",
            category: "data",
            description: "Display aggregate scan statistics.",
            usage: "scan-stats",
            handler: ({
                context,
                writeJSON
            }) =>
                writeJSON(
                    context.scan.statistics()
                )
        },

        {
            name: "scan-jobs",
            category: "data",
            description: "Display active scan jobs.",
            usage: "scan-jobs",
            handler: ({
                context,
                writeJSON
            }) =>
                writeJSON(
                    context.scan.activeJobs()
                )
        },

        {
            name: "scan-pause",
            category: "data",
            description: "Pause a scan job.",
            usage: "scan-pause [job-id]",
            handler: ({
                args,
                context,
                writeJSON
            }) =>
                writeJSON(
                    context.scan.pause(
                        args[0]
                    )
                )
        },

        {
            name: "scan-resume",
            category: "data",
            description: "Resume a paused scan job.",
            usage: "scan-resume [job-id]",
            handler: ({
                args,
                context,
                writeJSON
            }) =>
                writeJSON(
                    context.scan.resume(
                        args[0]
                    )
                )
        },

        {
            name: "scan-cancel",
            category: "data",
            description: "Cancel a scan job.",
            usage: "scan-cancel [job-id]",
            handler: ({
                args,
                context,
                writeJSON
            }) =>
                writeJSON(
                    context.scan.cancel(
                        args[0]
                    )
                )
        },

        {
            name: "scan-results",
            category: "data",
            description: "Display scan findings.",
            usage: "scan-results [job-id] [type]",
            handler: ({
                args,
                context,
                writeJSON
            }) => {
                const rows =
                    context.scan.results(
                        args[0]
                    );

                const type =
                    normalizeText(
                        args[1]
                    ).toLowerCase();

                return writeJSON(
                    type
                        ? rows.filter(
                            row =>
                                row.type === type
                        )
                        : rows
                );
            }
        },

        {
            name: "scan-errors",
            category: "data",
            description: "Display scan execution errors.",
            usage: "scan-errors [job-id]",
            handler: ({
                args,
                context,
                writeJSON
            }) =>
                writeJSON(
                    context.scan.errors(
                        args[0]
                    )
                )
        },

        {
            name: "scan-conflicts",
            category: "data",
            description: "Display conflict findings from the latest scan.",
            usage: "scan-conflicts [job-id]",
            handler: ({
                args,
                context,
                writeJSON
            }) =>
                writeJSON(
                    context.scan.results(
                        args[0]
                    ).filter(
                        issue =>
                            issue.type ===
                            "conflict"
                    )
                )
        },

        {
            name: "scan-duplicates",
            category: "data",
            description: "Display duplicate findings from the latest scan.",
            usage: "scan-duplicates [job-id]",
            handler: ({
                args,
                context,
                writeJSON
            }) =>
                writeJSON(
                    context.scan.results(
                        args[0]
                    ).filter(
                        issue =>
                            issue.type ===
                            "duplicate"
                    )
                )
        },

        {
            name: "scan-missing",
            category: "data",
            description: "Display missing-field findings from the latest scan.",
            usage: "scan-missing [job-id]",
            handler: ({
                args,
                context,
                writeJSON
            }) =>
                writeJSON(
                    context.scan.results(
                        args[0]
                    ).filter(
                        issue =>
                            issue.type ===
                            "missing"
                    )
                )
        },

        {
            name: "scan-remove",
            category: "data",
            description: "Remove a completed scan job from memory.",
            usage: "scan-remove <job-id>",
            handler: ({
                args = [],
                context,
                writeJSON
            }) => {
                const id =
                    args[0];

                if (!id) {
                    throw new Error(
                        "A scan job ID is required."
                    );
                }

                const job =
                    context.scan.getJob(
                        id
                    );

                if (!job) {
                    return writeJSON({
                        removed: false,
                        id
                    });
                }

                if (
                    [
                        "pending",
                        "running",
                        "paused"
                    ].includes(
                        job.state
                    )
                ) {
                    throw new Error(
                        "Active scan jobs must be cancelled before removal."
                    );
                }

                job.destroy();
                context.scan.jobs.delete(
                    id
                );

                return writeJSON({
                    removed: true,
                    id
                });
            }
        },

        {
            name: "scan-export",
            category: "data",
            description: "Export scan data as JSON or CSV.",
            usage: "scan-export [json|csv] [filename] [job-id]",
            handler: ({
                args,
                context,
                write
            }) => {
                const format =
                    normalizeText(
                        args[0] ||
                        "json"
                    ).toLowerCase();

                const filename =
                    args[1] ||
                    (
                        format === "csv"
                            ? "speciedex-scan.csv"
                            : "speciedex-scan.json"
                    );

                const jobID =
                    args[2] ||
                    null;

                if (format === "csv") {
                    download(
                        context.scan.exportCSV(
                            jobID
                        ),
                        filename,
                        "text/csv;charset=utf-8",
                        context
                    );
                } else if (format === "json") {
                    download(
                        safeStringify(
                            context.scan.export(
                                jobID
                            )
                        ),
                        filename,
                        "application/json;charset=utf-8",
                        context
                    );
                } else {
                    throw new Error(
                        "Use: scan-export json|csv [filename] [job-id]"
                    );
                }

                return write(
                    `Scan data exported to ${filename}.`,
                    "success"
                );
            }
        }
    ];

    for (const command of commands) {
        const handler =
            command.handler;

        command.handler =
            payload => {
                const safePayload =
                    isObject(payload)
                        ? payload
                        : {};

                safePayload.context =
                    resolveCommandContext(
                        safePayload
                    );

                const service =
                    requireScan(
                        safePayload.context
                    );

                safePayload.context.scan =
                    service;

                safePayload.args =
                    Array.isArray(
                        safePayload.args
                    )
                        ? [
                            ...safePayload.args
                        ]
                        : [];

                safePayload.parsed =
                    isObject(
                        safePayload.parsed
                    )
                        ? safePayload.parsed
                        : {
                            flags: {},
                            options: {}
                        };

                safePayload.parsed.flags =
                    isObject(
                        safePayload.parsed.flags
                    )
                        ? safePayload.parsed.flags
                        : {};

                safePayload.parsed.options =
                    isObject(
                        safePayload.parsed.options
                    )
                        ? safePayload.parsed.options
                        : {};

                safePayload.writeJSON =
                    typeof safePayload.writeJSON ===
                        "function"
                        ? safePayload.writeJSON
                        : value =>
                            writeResult(
                                safePayload,
                                value
                            );

                safePayload.write =
                    typeof safePayload.write ===
                        "function"
                        ? safePayload.write
                        : (
                            value,
                            type
                        ) =>
                            writeResult(
                                safePayload,
                                value,
                                type
                            );

                return handler(
                    safePayload
                );
            };
    }

    const api = Object.freeze({
        name: MODULE_NAME,
        version: VERSION,
        DEFAULT_OPTIONS,
        SERVICE_SYMBOL,
        REQUIRED_TAXON_FIELDS,
        IDENTIFIER_FIELDS,
        SCIENTIFIC_NAME_FIELDS,
        COMMON_NAME_FIELDS,
        PROVIDER_FIELDS,
        RANK_FIELDS,
        LATITUDE_FIELDS,
        LONGITUDE_FIELDS,
        TIMESTAMP_FIELDS,
        ScanJob,
        ScanService,
        makeID,
        normalizeText,
        normalizeKey,
        parseBoolean,
        parseInteger,
        parseNumber,
        firstValue,
        cloneValue,
        safeError,
        isAbortError,
        yieldToMainThread,
        normalizeRecord,
        classifyRecord,
        serializeIssue,
        createIssue,
        dispatchSafe,
        safeStringify,
        resolveCommandContext,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalScan = api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules ||
        {};

    window.SpeciedexTerminalModules[
        MODULE_NAME
    ] = api;

    dispatchSafe(
        document,
        "speciedex:terminal-module-available",
        {
            name:
                MODULE_NAME,
            module:
                api
        }
    );
})(window, document);
