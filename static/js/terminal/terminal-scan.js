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
    const VERSION = "2.0.0";

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
        retainRecords: false
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
        if (value === undefined || value === null || value === "") {
            return fallback;
        }

        return !["false", "0", "no", "off"].includes(
            String(value).trim().toLowerCase()
        );
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
            const value = record?.[field];

            if (value !== undefined && value !== null && value !== "") {
                return value;
            }
        }

        return null;
    }

    function cloneValue(value) {
        try {
            return structuredClone(value);
        } catch (error) {
            try {
                return JSON.parse(JSON.stringify(value));
            } catch (nestedError) {
                return value;
            }
        }
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
        const normalized = normalizeRecord(record);

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
            timestamp: new Date().toISOString()
        };
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
                ...options
            };

            this.id = options.id || makeID("scan");
            this.type = options.type || "library";
            this.source = options.source || options.collection || "records";
            this.label = options.label || `Scan ${this.source}`;
            this.state = "pending";
            this.createdAt = new Date().toISOString();
            this.startedAt = null;
            this.completedAt = null;
            this.pausedAt = null;
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
                providers: {}
            };

            this.identityMap = new Map();
            this.nameMap = new Map();
            this.abortController = new AbortController();
            this.pausePromise = null;
            this.pauseResolve = null;
            this.progressID = `scan:${this.id}`;
            this.loadingID = `scan:${this.id}`;
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
                    detectTimestamps: this.options.detectTimestamps
                }
            };
        }

        setState(state) {
            this.state = state;
            this.dispatchEvent(new CustomEvent("state", {
                detail: this.snapshot()
            }));
            this.service.emit(`job:${state}`, {
                job: this.snapshot()
            });
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

            await this.pausePromise;
        }

        pause() {
            if (this.state !== "running") {
                return false;
            }

            this.pausedAt = performance.now();
            this.setState("paused");
            this.service.context.progress?.pause?.(this.progressID);

            return true;
        }

        resume() {
            if (this.state !== "paused") {
                return false;
            }

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

            this.abortController.abort(reason);
            this.pauseResolve?.();
            this.pauseResolve = null;
            this.pausePromise = null;
            this.completedAt = new Date().toISOString();
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

        updateProgress() {
            this.percent = this.total
                ? Math.min(100, (this.processed / this.total) * 100)
                : 0;

            this.context.progress?.set?.(
                this.progressID,
                this.percent,
                {
                    label: this.label,
                    complete: false,
                    metadata: {
                        processed: this.processed,
                        total: this.total
                    }
                }
            );

            this.context.loading?.setProgress?.(
                this.loadingID,
                this.percent,
                `${this.label}: ${this.processed}/${this.total}`
            );

            this.service.emit("progress", {
                job: this.snapshot()
            });
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
                job: this.snapshot(),
                issue: serializeIssue(issue)
            });
        }

        emitRecord(normalized) {
            if (!this.options.emitRecords) {
                return;
            }

            const detail = {
                scanId: this.id,
                source: this.source,
                provider: normalized.provider,
                identifier: normalized.identifier,
                speciedexId: normalized.identifier,
                scientificName: normalized.scientificName,
                commonName: normalized.commonName,
                rank: normalized.rank,
                record: normalized.record
            };

            this.service.emit("record", detail);

            if (normalized.scientificName) {
                this.service.emit("species", detail);
                document.dispatchEvent(
                    new CustomEvent(
                        "speciedex:terminal-splash-record",
                        { detail }
                    )
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

            const classification = classifyRecord(record);
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

            const fatal = this.results.some(issue =>
                issue.recordIndex === index &&
                issue.severity === "error"
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

            this.total = records.length;
            this.startedAt = new Date().toISOString();
            this.startedPerformance = performance.now();
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

            const batchSize = parseInteger(
                this.options.batchSize,
                DEFAULT_OPTIONS.batchSize,
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
                        throw new DOMException(
                            "Scan cancelled.",
                            "AbortError"
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
                                timestamp: new Date().toISOString()
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

                    this.updateProgress();

                    await new Promise(resolve =>
                        window.setTimeout(resolve, 0)
                    );
                }

                this.completedAt = new Date().toISOString();
                this.duration =
                    performance.now() - this.startedPerformance;
                this.percent = 100;
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
                this.completedAt = new Date().toISOString();
                this.duration =
                    performance.now() - this.startedPerformance;

                if (
                    error?.name === "AbortError" ||
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
                        timestamp: new Date().toISOString()
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
            if (this.options.updateLibrary && this.context.library) {
                this.context.library.set?.(
                    `scan-results:${this.id}`,
                    this.results.map(serializeIssue),
                    {
                        source: "scan",
                        description: `Scan findings for ${this.source}.`
                    }
                );

                this.context.library.set?.(
                    "scan-results",
                    this.results.map(serializeIssue),
                    {
                        source: "scan",
                        description: "Most recent Speciedex scan findings."
                    }
                );
            }

            if (
                this.options.rebuildIndex &&
                this.context.index?.build &&
                this.options.collection
            ) {
                const records =
                    this.context.library?.get?.(
                        this.options.collection
                    ) || [];

                this.context.index.build(records);
            }

            this.service.archive(this);

            this.context.notifications?.success?.(
                `${this.label} complete: ${this.processed} records, ${this.results.length} findings.`,
                {
                    title: "Scan Complete",
                    timeout: 6000
                }
            );
        }
    }

    class ScanService extends EventTarget {
        constructor(context, options = {}) {
            super();

            this.context = context;
            this.options = {
                ...DEFAULT_OPTIONS,
                ...options
            };

            this.jobs = new Map();
            this.history = [];
            this.lastJob = null;
            this.destroyed = false;
        }

        createJob(options = {}) {
            const job = new ScanJob(
                this,
                {
                    ...this.options,
                    ...options
                }
            );

            this.jobs.set(job.id, job);
            this.lastJob = job;

            job.addEventListener("state", event => {
                this.emit("job:state", {
                    job: event.detail
                });
            });

            return job;
        }

        resolveRecords(parameters = {}) {
            if (Array.isArray(parameters.records)) {
                return parameters.records;
            }

            const collection =
                parameters.collection ||
                this.options.collection;

            return this.context.library?.get?.(
                collection
            ) || [];
        }

        async run(parameters = {}) {
            const action = normalizeText(
                parameters.action ||
                parameters.args?.[0] ||
                "library"
            ).toLowerCase();

            if (action === "status") {
                return this.status();
            }

            if (action === "history") {
                return this.history.map(entry =>
                    cloneValue(entry)
                );
            }

            if (action === "stats" || action === "statistics") {
                return this.statistics();
            }

            if (action === "queue" || action === "jobs") {
                return this.activeJobs();
            }

            if (action === "pause") {
                return this.pause(
                    parameters.id ||
                    parameters.args?.[1]
                );
            }

            if (action === "resume") {
                return this.resume(
                    parameters.id ||
                    parameters.args?.[1]
                );
            }

            if (action === "cancel") {
                return this.cancel(
                    parameters.id ||
                    parameters.args?.[1]
                );
            }

            if (action === "results") {
                return this.results(
                    parameters.id ||
                    parameters.args?.[1]
                );
            }

            if (action === "errors") {
                return this.errors(
                    parameters.id ||
                    parameters.args?.[1]
                );
            }

            const collection =
                parameters.collection ||
                (
                    action === "library"
                        ? parameters.args?.[1]
                        : action
                ) ||
                this.options.collection;

            const records = this.resolveRecords({
                ...parameters,
                collection
            });

            const job = this.createJob({
                type: parameters.type || "library",
                source: parameters.source || collection,
                collection,
                label: parameters.label || `Scan ${collection}`,
                batchSize: parameters.batchSize,
                emitRecords: parameters.emitRecords,
                updateLibrary: parameters.updateLibrary,
                rebuildIndex: parameters.rebuildIndex,
                detectDuplicates: parameters.detectDuplicates,
                detectConflicts: parameters.detectConflicts,
                detectMissing: parameters.detectMissing,
                detectCoordinates: parameters.detectCoordinates,
                detectTimestamps: parameters.detectTimestamps,
                retainRecords: parameters.retainRecords
            });

            this.emit("start", {
                job: job.snapshot()
            });

            return job.run(records);
        }

        async scanLibrary(collection = "records", options = {}) {
            return this.run({
                ...options,
                action: "library",
                collection,
                type: "library"
            });
        }

        async scanProvider(provider, options = {}) {
            const collection =
                options.collection ||
                `provider:${provider}`;

            let records =
                this.context.library?.get?.(
                    collection
                ) || [];

            if (!records.length && this.context.api?.get) {
                records = await this.context.api.get(
                    "provider",
                    {
                        provider,
                        limit: options.limit || 10000
                    }
                );

                if (!Array.isArray(records)) {
                    records =
                        records?.records ||
                        records?.results ||
                        [];
                }
            }

            this.context.providerHealth?.recordSample?.(
                provider,
                {
                    success: true,
                    assertions: records.length,
                    timestamp: Date.now()
                }
            );

            return this.run({
                ...options,
                records,
                source: provider,
                collection,
                type: "provider",
                label: `Scan provider ${provider}`
            });
        }

        async scanSearch(query, options = {}) {
            if (!this.context.search?.search) {
                throw new Error(
                    "Search service is unavailable."
                );
            }

            const results = await this.context.search.search(
                query,
                {
                    limit: options.limit || 1000,
                    collection: options.collection || "records"
                }
            );

            return this.run({
                ...options,
                records: Array.isArray(results)
                    ? results
                    : results?.results || [],
                source: `search:${query}`,
                collection: options.collection || "records",
                type: "search",
                label: `Scan search results: ${query}`
            });
        }

        async scanArchive(collection = "archive", options = {}) {
            return this.run({
                ...options,
                collection,
                source: collection,
                type: "archive",
                label: `Scan archive ${collection}`
            });
        }

        getJob(id) {
            if (!id) {
                return this.lastJob;
            }

            return this.jobs.get(String(id)) || null;
        }

        pause(id = null) {
            const job = this.getJob(id);

            if (!job) {
                throw new Error(
                    `Unknown scan job: ${id || "(none)"}`
                );
            }

            return {
                changed: job.pause(),
                job: job.snapshot()
            };
        }

        resume(id = null) {
            const job = this.getJob(id);

            if (!job) {
                throw new Error(
                    `Unknown scan job: ${id || "(none)"}`
                );
            }

            return {
                changed: job.resume(),
                job: job.snapshot()
            };
        }

        cancel(id = null) {
            const job = this.getJob(id);

            if (!job) {
                throw new Error(
                    `Unknown scan job: ${id || "(none)"}`
                );
            }

            return {
                changed: job.cancel("command"),
                job: job.snapshot()
            };
        }

        isRunning() {
            return [...this.jobs.values()].some(job =>
                ["running", "paused"].includes(job.state)
            );
        }

        activeJobs() {
            return [...this.jobs.values()]
                .filter(job =>
                    ["pending", "running", "paused"].includes(job.state)
                )
                .map(job => job.snapshot());
        }

        results(id = null) {
            const job = this.getJob(id);

            if (!job) {
                return [];
            }

            return job.results.map(serializeIssue);
        }

        errors(id = null) {
            const job = this.getJob(id);

            if (!job) {
                return [];
            }

            return cloneValue(job.errors);
        }

        archive(job) {
            const snapshot = job.snapshot({
                includeResults: true,
                includeErrors: true
            });

            this.history.push(snapshot);
            this.history = this.history.slice(
                -this.options.maximumHistory
            );

            this.emit("complete", {
                job: snapshot
            });

            return snapshot;
        }

        statistics() {
            const totals = {
                jobs: this.history.length,
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
                duration: 0
            };

            for (const job of this.history) {
                const statistics = job.statistics || {};

                for (const key of Object.keys(totals)) {
                    if (
                        key !== "jobs" &&
                        key !== "duration" &&
                        Number.isFinite(Number(statistics[key]))
                    ) {
                        totals[key] += Number(statistics[key]);
                    }
                }

                totals.duration += Number(job.duration) || 0;
            }

            totals.activeJobs = this.activeJobs().length;
            totals.averageDuration = totals.jobs
                ? totals.duration / totals.jobs
                : null;

            return totals;
        }

        status() {
            return {
                version: VERSION,
                running: this.isRunning(),
                jobs: this.jobs.size,
                activeJobs: this.activeJobs(),
                history: this.history.length,
                lastJob: this.lastJob
                    ? this.lastJob.snapshot()
                    : null,
                statistics: this.statistics()
            };
        }

        export(id = null) {
            const job = this.getJob(id);

            return {
                version: VERSION,
                generatedAt: new Date().toISOString(),
                job: job
                    ? job.snapshot({
                        includeResults: true,
                        includeErrors: true
                    })
                    : null,
                history: cloneValue(this.history),
                statistics: this.statistics()
            };
        }

        exportCSV(id = null) {
            const rows = this.results(id);
            const header = [
                "id",
                "type",
                "severity",
                "message",
                "record_index",
                "identity",
                "provider",
                "scientific_name",
                "fields",
                "timestamp"
            ];

            const lines = [
                header.join(",")
            ];

            for (const row of rows) {
                lines.push(
                    [
                        row.id,
                        row.type,
                        row.severity,
                        row.message,
                        row.recordIndex,
                        row.identity,
                        row.provider,
                        row.scientificName,
                        (row.fields || []).join("|"),
                        row.timestamp
                    ]
                        .map(escapeCSV)
                        .join(",")
                );
            }

            return lines.join("\n");
        }

        emit(type, detail = {}) {
            this.dispatchEvent(
                new CustomEvent(type, {
                    detail
                })
            );

            this.context.events?.emit?.(
                `scan:${type}`,
                detail
            );

            this.context.root?.dispatchEvent?.(
                new CustomEvent(
                    `speciedex:terminal-scan-${type}`,
                    {
                        bubbles: true,
                        detail
                    }
                )
            );

            document.dispatchEvent(
                new CustomEvent(
                    `speciedex:terminal-scan-${type}`,
                    {
                        detail
                    }
                )
            );
        }

        destroy() {
            if (this.destroyed) {
                return;
            }

            for (const job of this.jobs.values()) {
                if (
                    ["pending", "running", "paused"].includes(
                        job.state
                    )
                ) {
                    job.cancel("service-destroyed");
                }
            }

            this.jobs.clear();
            this.destroyed = true;

            this.dispatchEvent(
                new CustomEvent("destroy")
            );
        }
    }

    function initialize(context) {
        if (context.scan instanceof ScanService) {
            return context.scan;
        }

        const root = context.root;

        const service = new ScanService(
            context,
            {
                collection:
                    root?.dataset.terminalScanCollection ||
                    DEFAULT_OPTIONS.collection,

                batchSize:
                    parseInteger(
                        root?.dataset.terminalScanBatchSize,
                        DEFAULT_OPTIONS.batchSize,
                        1,
                        10000
                    ),

                maximumHistory:
                    parseInteger(
                        root?.dataset.terminalScanHistory,
                        DEFAULT_OPTIONS.maximumHistory,
                        10,
                        5000
                    ),

                maximumResults:
                    parseInteger(
                        root?.dataset.terminalScanResults,
                        DEFAULT_OPTIONS.maximumResults,
                        100,
                        100000
                    ),

                emitRecords:
                    parseBoolean(
                        root?.dataset.terminalScanEmitRecords,
                        true
                    ),

                updateLibrary:
                    parseBoolean(
                        root?.dataset.terminalScanUpdateLibrary,
                        true
                    ),

                rebuildIndex:
                    parseBoolean(
                        root?.dataset.terminalScanRebuildIndex,
                        true
                    )
            }
        );

        context.scan = service;
        context.registerService?.(
            "scan",
            service
        );

        return service;
    }

    function download(content, filename, mime) {
        const blob = new Blob(
            [content],
            {
                type: mime
            }
        );

        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");

        anchor.href = url;
        anchor.download = filename;
        anchor.click();

        window.setTimeout(
            () => URL.revokeObjectURL(url),
            1000
        );

        return filename;
    }

    function parsedOptions(parsed) {
        return {
            flags: parsed?.flags || {},
            options: parsed?.options || {}
        };
    }

    const commands = [
        {
            name: "scan",
            category: "data",
            description: "Scan a library collection for anomalies.",
            usage: "scan [collection] [--batch N] [--no-duplicates] [--no-conflicts] [--no-missing]",
            handler: async ({
                args,
                parsed,
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
                        "text/csv"
                    );
                } else {
                    download(
                        JSON.stringify(
                            context.scan.export(
                                jobID
                            ),
                            null,
                            2
                        ),
                        filename,
                        "application/json"
                    );
                }

                return write(
                    `Scan data exported to ${filename}.`,
                    "success"
                );
            }
        }
    ];

    const api = Object.freeze({
        name: MODULE_NAME,
        version: VERSION,
        DEFAULT_OPTIONS,
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
        normalizeRecord,
        classifyRecord,
        serializeIssue,
        createIssue,
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

    document.dispatchEvent(
        new CustomEvent(
            "speciedex:terminal-module-available",
            {
                detail: {
                    name: MODULE_NAME,
                    module: api
                }
            }
        )
    );
})(window, document);
