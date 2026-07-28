/*
========================================================================
Speciedex.org
Terminal Provider Health
========================================================================

Provider health aggregation, diagnostics, and monitoring for
SpeciedexTerminal.

Provides:

    • provider availability tracking
    • latency statistics
    • error-rate statistics
    • data freshness analysis
    • assertion and species coverage counts
    • provider overlap measurements
    • uptime calculations
    • weighted health scoring
    • configurable health thresholds
    • periodic monitoring
    • runtime event ingestion
    • library collection ingestion
    • filtering, sorting, summaries, and diagnostics
    • JSON and CSV export
    • terminal commands
    • clean teardown

Expected provider-related library collections may include:

    providers
    provider-health
    provider-errors
    provider-latency
    provider-statistics
    provider-assertions
    provider-species
    enabled-providers
    eligible-providers

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME =
        "ProviderHealth";

    const VERSION =
        "2.2.0";

    const SERVICE_SYMBOL =
        Symbol.for(
            "speciedex.terminal.providerHealth.service"
        );

    const RESERVED_KEYS =
        new Set([
            "__proto__",
            "prototype",
            "constructor"
        ]);

    const activeDispatches =
        new WeakMap();

    const DEFAULT_OPTIONS =
        Object.freeze({
            interval:
                60000,

            historyLimit:
                1000,

            staleAfter:
                24 * 60 * 60 * 1000,

            unhealthyAfter:
                72 * 60 * 60 * 1000,

            latencyWarning:
                1500,

            latencyCritical:
                5000,

            errorRateWarning:
                0.05,

            errorRateCritical:
                0.20,

            uptimeWarning:
                0.98,

            uptimeCritical:
                0.90,

            minimumAssertions:
                1,

            scoreWeights: {
                availability:
                    0.30,

                latency:
                    0.15,

                errors:
                    0.20,

                freshness:
                    0.20,

                coverage:
                    0.10,

                overlap:
                    0.05
            },

            autoStart:
                false,

            emitNotifications:
                true,

            ingestOnInitialize:
                true,

            ingestDebounce:
                100,

            maximumProviders:
                1000,

            maximumConcurrentChecks:
                16
        });

    const HEALTH_STATES =
        Object.freeze([
            "healthy",
            "degraded",
            "warning",
            "critical",
            "offline",
            "unknown"
        ]);

    /*
    ==========================================================================
    Utilities
    ==========================================================================
    */

    function isObject(value) {
        return (
            value !== null &&
            typeof value === "object" &&
            !Array.isArray(value)
        );
    }

    function monotonicNow() {
        return (
            typeof performance !== "undefined" &&
            typeof performance.now === "function"
        )
            ? monotonicNow()
            : Date.now();
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

    function dispatch(target, name, detail, options = {}) {
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

    function safeClone(
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
                    value.stack || null
            };
        }

        if (Array.isArray(value)) {
            return value.map(
                item =>
                    safeClone(
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
                safeClone(
                    item,
                    seen,
                    depth + 1
                );
        }

        return output;
    }

    function safeStringify(value, compact = false) {
        return JSON.stringify(
            safeClone(value),
            null,
            compact ? 0 : 2
        );
    }

    function clamp(
        value,
        minimum,
        maximum
    ) {
        const numeric =
            Number(value);

        const lower =
            Math.min(
                Number(minimum),
                Number(maximum)
            );

        const upper =
            Math.max(
                Number(minimum),
                Number(maximum)
            );

        if (!Number.isFinite(numeric)) {
            return Number.isFinite(lower)
                ? lower
                : 0;
        }

        return Math.min(
            upper,
            Math.max(
                lower,
                numeric
            )
        );
    }

    function parseNumber(
        value,
        fallback = 0
    ) {
        const parsed =
            Number(value);

        return Number.isFinite(
            parsed
        )
            ? parsed
            : fallback;
    }

    function parseBoolean(
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

    function normalizeProviderID(
        value
    ) {
        const normalized =
            String(
                value ?? ""
            )
                .trim()
                .toLowerCase()
                .replace(/\s+/g, "-");

        if (!normalized) {
            return "unknown";
        }

        return normalized;
    }

    function normalizeText(
        value
    ) {
        return String(
            value ?? ""
        ).trim();
    }

    function normalizeTimestamp(
        value
    ) {
        if (
            value === null ||
            value === undefined ||
            value === ""
        ) {
            return null;
        }

        if (
            value instanceof
            Date
        ) {
            const timestamp =
                value.getTime();

            return Number.isFinite(
                timestamp
            )
                ? timestamp
                : null;
        }

        if (
            typeof value ===
            "number"
        ) {
            return Number.isFinite(
                value
            )
                ? value
                : null;
        }

        const timestamp =
            Date.parse(
                value
            );

        return Number.isFinite(
            timestamp
        )
            ? timestamp
            : null;
    }

    function firstValue(
        record,
        fields
    ) {
        for (const field of fields) {
            if (RESERVED_KEYS.has(field)) {
                continue;
            }

            const value =
                record?.[
                    field
                ];

            if (
                value !== undefined &&
                value !== null &&
                value !== ""
            ) {
                return value;
            }
        }

        return null;
    }

    function mean(
        values
    ) {
        const filtered =
            values.filter(
                value =>
                    Number.isFinite(
                        value
                    )
            );

        if (!filtered.length) {
            return null;
        }

        return filtered.reduce(
            (
                total,
                value
            ) =>
                total +
                value,
            0
        ) /
        filtered.length;
    }

    function percentile(
        values,
        percentileValue
    ) {
        const filtered =
            values
                .filter(
                    value =>
                        Number.isFinite(
                            value
                        )
                )
                .sort(
                    (
                        left,
                        right
                    ) =>
                        left -
                        right
                );

        if (!filtered.length) {
            return null;
        }

        const position =
            (
                filtered.length -
                1
            ) *
            percentileValue;

        const lower =
            Math.floor(
                position
            );

        const upper =
            Math.ceil(
                position
            );

        if (
            lower ===
            upper
        ) {
            return filtered[
                lower
            ];
        }

        const weight =
            position -
            lower;

        return (
            filtered[
                lower
            ] *
            (
                1 -
                weight
            )
        ) +
        (
            filtered[
                upper
            ] *
            weight
        );
    }

    function formatDuration(
        milliseconds
    ) {
        const value =
            Math.max(
                0,
                Number(
                    milliseconds
                ) ||
                0
            );

        if (value < 1000) {
            return `${Math.round(value)}ms`;
        }

        if (
            value <
            60 * 1000
        ) {
            return `${(
                value /
                1000
            ).toFixed(1)}s`;
        }

        if (
            value <
            60 * 60 * 1000
        ) {
            return `${(
                value /
                (
                    60 *
                    1000
                )
            ).toFixed(1)}m`;
        }

        if (
            value <
            24 * 60 * 60 * 1000
        ) {
            return `${(
                value /
                (
                    60 *
                    60 *
                    1000
                )
            ).toFixed(1)}h`;
        }

        return `${(
            value /
            (
                24 *
                60 *
                60 *
                1000
            )
        ).toFixed(1)}d`;
    }

    function healthRank(
        state
    ) {
        return {
            healthy:
                0,

            degraded:
                1,

            warning:
                2,

            critical:
                3,

            offline:
                4,

            unknown:
                5
        }[
            state
        ] ??
        6;
    }

    function escapeCSV(
        value
    ) {
        const text =
            String(
                value ?? ""
            );

        if (
            /[",\n\r]/.test(
                text
            )
        ) {
            return `"${text.replace(/"/g, '""')}"`;
        }

        return text;
    }

    function stableSampleKey(
        provider,
        type,
        timestamp,
        value
    ) {
        return [
            normalizeProviderID(
                provider
            ),
            String(
                type ||
                "sample"
            ),
            String(
                normalizeTimestamp(
                    timestamp
                ) ??
                ""
            ),
            String(
                value ??
                ""
            )
        ].join(
            "::"
        );
    }

    function normalizeCollectionName(
        value
    ) {
        return String(
            value ??
            ""
        )
            .trim()
            .toLowerCase();
    }

    /*
    ==========================================================================
    Provider Health Service
    ==========================================================================
    */

    class ProviderHealthService
        extends EventTarget {
        constructor(
            context,
            options = {}
        ) {
            super();

            this.context =
                isObject(context)
                    ? context
                    : {};

            this.context.root =
                this.context.root &&
                typeof this.context.root.dispatchEvent ===
                    "function"
                    ? this.context.root
                    : document.documentElement;

            this.options = {
                ...DEFAULT_OPTIONS,
                ...options,

                interval:
                    clamp(
                        parseNumber(
                            options.interval,
                            DEFAULT_OPTIONS.interval
                        ),
                        5000,
                        24 * 60 * 60 * 1000
                    ),

                historyLimit:
                    clamp(
                        parseNumber(
                            options.historyLimit,
                            DEFAULT_OPTIONS.historyLimit
                        ),
                        10,
                        100000
                    ),

                staleAfter:
                    clamp(
                        parseNumber(
                            options.staleAfter,
                            DEFAULT_OPTIONS.staleAfter
                        ),
                        0,
                        365 * 24 * 60 * 60 * 1000
                    ),

                unhealthyAfter:
                    clamp(
                        parseNumber(
                            options.unhealthyAfter,
                            DEFAULT_OPTIONS.unhealthyAfter
                        ),
                        0,
                        365 * 24 * 60 * 60 * 1000
                    ),

                maximumProviders:
                    clamp(
                        parseNumber(
                            options.maximumProviders,
                            DEFAULT_OPTIONS.maximumProviders
                        ),
                        1,
                        100000
                    ),

                maximumConcurrentChecks:
                    clamp(
                        parseNumber(
                            options.maximumConcurrentChecks,
                            DEFAULT_OPTIONS.maximumConcurrentChecks
                        ),
                        1,
                        256
                    ),

                autoStart:
                    parseBoolean(
                        options.autoStart,
                        DEFAULT_OPTIONS.autoStart
                    ),

                emitNotifications:
                    parseBoolean(
                        options.emitNotifications,
                        DEFAULT_OPTIONS.emitNotifications
                    ),

                ingestOnInitialize:
                    parseBoolean(
                        options.ingestOnInitialize,
                        DEFAULT_OPTIONS.ingestOnInitialize
                    ),

                scoreWeights: {
                    ...DEFAULT_OPTIONS.scoreWeights,
                    ...(
                        isObject(
                            options.scoreWeights
                        )
                            ? safeClone(
                                options.scoreWeights
                            )
                            : {}
                    )
                }
            };

            if (
                this.options.unhealthyAfter <
                this.options.staleAfter
            ) {
                this.options.unhealthyAfter =
                    this.options.staleAfter;
            }

            this.providers =
                new Map();

            this.samples =
                new Map();

            this.errors =
                new Map();

            this.latencies =
                new Map();

            this.assertions =
                new Map();

            this.species =
                new Map();

            this.overlap =
                new Map();

            this.history =
                [];

            this.timer =
                0;

            this.running =
                false;

            this.destroyed =
                false;

            this.boundHandlers =
                [];

            this.abortController =
                typeof AbortController ===
                    "function"
                    ? new AbortController()
                    : null;

            this.watchers =
                new Set();

            this.emitting =
                false;

            this.boundDisposers =
                [];

            this.ingesting =
                false;

            this.ingestPending =
                false;

            this.ingestTimer =
                0;

            this.initialized =
                false;

            this.seenSamples =
                new Set();

            this.seenLatencies =
                new Set();

            this.seenErrors =
                new Set();

            this.metrics = {
                ingestions:
                    0,
                skippedRecursiveIngestions:
                    0,
                duplicateSamples:
                    0,
                duplicateLatencies:
                    0,
                duplicateErrors:
                    0,
                checks:
                    0,
                checkErrors:
                    0
            };

            this.bindRuntimeEvents();

            if (
                this.options.ingestOnInitialize
            ) {
                this.ingestLibrary({
                    emit:
                        false,
                    source:
                        "initialize"
                });
            }

            this.initialized =
                true;

            if (
                this.options.autoStart
            ) {
                this.start();
            }
        }

        watch(callback, options = {}) {
            this.assertActive();

            if (typeof callback !== "function") {
                throw new TypeError(
                    "Provider-health watcher must be a function."
                );
            }

            this.watchers.add(callback);

            if (options.immediate === true) {
                callback(
                    {
                        type:
                            "initial",
                        timestamp:
                            nowISO(),
                        status:
                            this.status()
                    },
                    this
                );
            }

            return () =>
                this.watchers.delete(
                    callback
                );
        }

        addManagedListener(
            target,
            name,
            handler,
            options = {}
        ) {
            if (
                !target ||
                typeof target.addEventListener !==
                    "function"
            ) {
                return false;
            }

            const listenerOptions = {
                ...options
            };

            if (this.abortController?.signal) {
                listenerOptions.signal =
                    this.abortController.signal;
            }

            try {
                target.addEventListener(
                    name,
                    handler,
                    listenerOptions
                );

                return true;
            } catch (_error) {
                const capture =
                    options.capture === true;

                target.addEventListener(
                    name,
                    handler,
                    capture
                );

                this.boundDisposers.push(
                    () =>
                        target.removeEventListener(
                            name,
                            handler,
                            capture
                        )
                );

                return true;
            }
        }

        assertActive() {
            if (
                this.destroyed
            ) {
                throw new Error(
                    "ProviderHealthService has been destroyed."
                );
            }
        }

        scheduleLibraryIngestion(
            options = {}
        ) {
            if (
                this.destroyed
            ) {
                return false;
            }

            window.clearTimeout(
                this.ingestTimer
            );

            this.ingestTimer =
                window.setTimeout(
                    () => {
                        this.ingestTimer =
                            0;

                        Promise.resolve(
                            this.ingestLibrary({
                                ...options,
                                source:
                                    options.source ||
                                    "scheduled"
                            })
                        ).catch(
                            error =>
                                this.emit(
                                    "ingest-error",
                                    {
                                        error
                                    }
                                )
                        );
                    },
                    Math.max(
                        0,
                        parseNumber(
                            this.options.ingestDebounce,
                            DEFAULT_OPTIONS.ingestDebounce
                        )
                    )
                );

            return true;
        }

        /*
        ======================================================================
        Provider Registration
        ======================================================================
        */

        ensureProvider(
            provider,
            metadata = {}
        ) {
            this.assertActive();

            const id =
                normalizeProviderID(
                    provider
                );

            if (
                !this.providers.has(
                    id
                )
            ) {
                if (
                    this.providers.size >=
                    this.options.maximumProviders
                ) {
                    throw new Error(
                        `Provider limit reached: ${this.options.maximumProviders}`
                    );
                }

                this.providers.set(
                    id,
                    {
                        id,

                        name:
                            normalizeText(
                                metadata.name ||
                                provider
                            ) ||
                            id,

                        enabled:
                            metadata.enabled !==
                            false,

                        eligible:
                            metadata.eligible !==
                            false,

                        endpoint:
                            normalizeText(
                                metadata.endpoint ||
                                metadata.url ||
                                ""
                            ),

                        documentation:
                            normalizeText(
                                metadata.documentation ||
                                metadata.docs ||
                                ""
                            ),

                        createdAt:
                            nowISO(),

                        updatedAt:
                            nowISO(),

                        metadata:
                            safeClone(
                                metadata
                            )
                    }
                );
            } else if (
                metadata &&
                typeof metadata ===
                "object"
            ) {
                const current =
                    this.providers.get(
                        id
                    );

                current.name =
                    normalizeText(
                        metadata.name ||
                        current.name
                    );

                current.enabled =
                    metadata.enabled ??
                    current.enabled;

                current.eligible =
                    metadata.eligible ??
                    current.eligible;

                current.endpoint =
                    normalizeText(
                        metadata.endpoint ||
                        metadata.url ||
                        current.endpoint
                    );

                current.documentation =
                    normalizeText(
                        metadata.documentation ||
                        metadata.docs ||
                        current.documentation
                    );

                current.updatedAt =
                    nowISO();

                current.metadata = {
                    ...safeClone(
                        current.metadata
                    ),
                    ...safeClone(
                        metadata
                    )
                };
            }

            return this.providers.get(
                id
            );
        }

        registerProvider(
            provider,
            metadata = {}
        ) {
            const result =
                this.ensureProvider(
                    provider,
                    metadata
                );

            this.emit(
                "provider",
                {
                    provider:
                        result
                }
            );

            return result;
        }

        /*
        ======================================================================
        Sample Recording
        ======================================================================
        */

        recordSample(
            provider,
            sample = {},
            options = {}
        ) {
            this.assertActive();

            const id =
                normalizeProviderID(
                    provider
                );

            this.ensureProvider(
                id,
                sample
            );

            const timestamp =
                normalizeTimestamp(
                    sample.timestamp ||
                    sample.checkedAt ||
                    sample.updatedAt
                ) ??
                Date.now();

            const sampleKey =
                stableSampleKey(
                    id,
                    "sample",
                    timestamp,
                    [
                        sample.statusCode ||
                        sample.status_code ||
                        sample.httpStatus ||
                        "",
                        sample.latency ||
                        sample.latencyMs ||
                        sample.latency_ms ||
                        sample.duration ||
                        "",
                        sample.success ??
                        sample.ok ??
                        sample.status ??
                        ""
                    ].join(
                        ":"
                    )
                );

            if (
                this.seenSamples.has(
                    sampleKey
                )
            ) {
                this.metrics.duplicateSamples +=
                    1;

                return this.evaluate(
                    id
                );
            }

            this.seenSamples.add(
                sampleKey
            );

            const success =
                sample.success ??
                sample.ok ??
                (
                    String(
                        sample.status ||
                        ""
                    ).toLowerCase() ===
                    "healthy"
                );

            const statusCode =
                parseNumber(
                    sample.statusCode ||
                    sample.status_code ||
                    sample.httpStatus,
                    success
                        ? 200
                        : 0
                );

            const latency =
                parseNumber(
                    sample.latency ||
                    sample.latencyMs ||
                    sample.latency_ms ||
                    sample.duration,
                    null
                );

            const record = {
                provider:
                    id,

                timestamp,

                success:
                    Boolean(
                        success
                    ),

                statusCode,

                latency,

                assertions:
                    parseNumber(
                        sample.assertions ||
                        sample.sourceAssertions,
                        null
                    ),

                species:
                    parseNumber(
                        sample.species ||
                        sample.speciesCount,
                        null
                    ),

                lastUpdated:
                    normalizeTimestamp(
                        sample.lastUpdated ||
                        sample.last_updated ||
                        sample.freshnessTimestamp
                    ),

                error:
                    sample.error
                        ? normalizeText(
                            sample.error.message ||
                            sample.error
                        )
                        : "",

                metadata:
                    safeClone(
                        sample
                    )
            };

            if (
                !this.samples.has(
                    id
                )
            ) {
                this.samples.set(
                    id,
                    []
                );
            }

            this.samples.get(
                id
            ).push(
                record
            );

            this.samples.set(
                id,
                this.samples.get(
                    id
                ).slice(
                    -this.options.historyLimit
                )
            );

            if (
                latency !==
                null
            ) {
                this.recordLatency(
                    id,
                    latency,
                    timestamp,
                    false,
                    {
                        source:
                            options.source ||
                            "sample"
                    }
                );
            }

            if (
                !record.success ||
                record.error
            ) {
                this.recordError(
                    id,
                    record.error ||
                    `Provider check failed with status ${statusCode}.`,
                    timestamp,
                    false,
                    {
                        source:
                            options.source ||
                            "sample"
                    }
                );
            }

            if (
                record.assertions !==
                null
            ) {
                this.assertions.set(
                    id,
                    record.assertions
                );
            }

            if (
                record.species !==
                null
            ) {
                this.species.set(
                    id,
                    record.species
                );
            }

            const health =
                this.evaluate(
                    id
                );

            if (
                options.archive !==
                false
            ) {
                this.archive(
                    health
                );
            }

            if (
                options.emit !==
                false
            ) {
                this.emit(
                    "sample",
                    {
                        sample:
                            record,

                        health
                    }
                );
            }

            if (
                options.notify !==
                false
            ) {
                this.notifyTransition(
                    health
                );
            }

            return health;
        }

        recordLatency(
            provider,
            latency,
            timestamp =
                Date.now(),
            emit =
                true,
            options = {}
        ) {
            this.assertActive();

            const id =
                normalizeProviderID(
                    provider
                );

            this.ensureProvider(
                id
            );

            const value =
                parseNumber(
                    latency,
                    null
                );

            if (
                value ===
                null
            ) {
                return null;
            }

            const normalizedTimestamp =
                normalizeTimestamp(
                    timestamp
                ) ??
                Date.now();

            const latencyKey =
                stableSampleKey(
                    id,
                    "latency",
                    normalizedTimestamp,
                    value
                );

            if (
                this.seenLatencies.has(
                    latencyKey
                )
            ) {
                this.metrics.duplicateLatencies +=
                    1;

                return null;
            }

            this.seenLatencies.add(
                latencyKey
            );

            if (
                !this.latencies.has(
                    id
                )
            ) {
                this.latencies.set(
                    id,
                    []
                );
            }

            const record = {
                timestamp:
                    normalizedTimestamp,

                value,

                source:
                    options.source ||
                    "runtime"
            };

            this.latencies.get(
                id
            ).push(
                record
            );

            this.latencies.set(
                id,
                this.latencies.get(
                    id
                ).slice(
                    -this.options.historyLimit
                )
            );

            if (emit) {
                this.emit(
                    "latency",
                    {
                        provider:
                            id,

                        latency:
                            record
                    }
                );
            }

            return record;
        }

        recordError(
            provider,
            error,
            timestamp =
                Date.now(),
            emit =
                true,
            options = {}
        ) {
            this.assertActive();

            const id =
                normalizeProviderID(
                    provider
                );

            this.ensureProvider(
                id
            );

            const normalizedTimestamp =
                normalizeTimestamp(
                    timestamp
                ) ??
                Date.now();

            const normalizedMessage =
                error instanceof
                    Error
                    ? error.message
                    : normalizeText(
                        error
                    );

            const errorKey =
                stableSampleKey(
                    id,
                    "error",
                    normalizedTimestamp,
                    normalizedMessage
                );

            if (
                this.seenErrors.has(
                    errorKey
                )
            ) {
                this.metrics.duplicateErrors +=
                    1;

                return null;
            }

            this.seenErrors.add(
                errorKey
            );

            if (
                !this.errors.has(
                    id
                )
            ) {
                this.errors.set(
                    id,
                    []
                );
            }

            const record = {
                timestamp:
                    normalizedTimestamp,

                message:
                    normalizedMessage,

                name:
                    error instanceof
                    Error
                        ? error.name
                        : "Error",

                source:
                    options.source ||
                    "runtime"
            };

            this.errors.get(
                id
            ).push(
                record
            );

            this.errors.set(
                id,
                this.errors.get(
                    id
                ).slice(
                    -this.options.historyLimit
                )
            );

            if (emit) {
                this.emit(
                    "error",
                    {
                        provider:
                            id,

                        error:
                            record
                    }
                );
            }

            return record;
        }

        setAssertions(
            provider,
            count
        ) {
            const id =
                normalizeProviderID(
                    provider
                );

            this.ensureProvider(
                id
            );

            this.assertions.set(
                id,
                Math.max(
                    0,
                    parseNumber(
                        count,
                        0
                    )
                )
            );

            return this.assertions.get(
                id
            );
        }

        setSpecies(
            provider,
            count
        ) {
            const id =
                normalizeProviderID(
                    provider
                );

            this.ensureProvider(
                id
            );

            this.species.set(
                id,
                Math.max(
                    0,
                    parseNumber(
                        count,
                        0
                    )
                )
            );

            return this.species.get(
                id
            );
        }

        setOverlap(
            provider,
            value
        ) {
            const id =
                normalizeProviderID(
                    provider
                );

            this.ensureProvider(
                id
            );

            this.overlap.set(
                id,
                clamp(
                    parseNumber(
                        value,
                        0
                    ),
                    0,
                    1
                )
            );

            return this.overlap.get(
                id
            );
        }

        /*
        ======================================================================
        Health Calculation
        ======================================================================
        */

        evaluate(
            provider
        ) {
            const id =
                normalizeProviderID(
                    provider
                );

            const metadata =
                this.ensureProvider(
                    id
                );

            const samples =
                this.samples.get(
                    id
                ) ||
                [];

            const latencyRecords =
                this.latencies.get(
                    id
                ) ||
                [];

            const errorRecords =
                this.errors.get(
                    id
                ) ||
                [];

            const now =
                Date.now();

            const recentWindow =
                now -
                this.options.unhealthyAfter;

            const recentSamples =
                samples.filter(
                    sample =>
                        sample.timestamp >=
                        recentWindow
                );

            const recentErrors =
                errorRecords.filter(
                    error =>
                        error.timestamp >=
                        recentWindow
                );

            const recentLatencies =
                latencyRecords
                    .filter(
                        record =>
                            record.timestamp >=
                            recentWindow
                    )
                    .map(
                        record =>
                            record.value
                    );

            const successful =
                recentSamples.filter(
                    sample =>
                        sample.success
                ).length;

            const uptime =
                recentSamples.length
                    ? successful /
                    recentSamples.length
                    : null;

            const errorRate =
                recentSamples.length
                    ? Math.min(
                        1,
                        recentErrors.length /
                        recentSamples.length
                    )
                    : recentErrors.length
                        ? 1
                        : null;

            const lastSample =
                samples.length
                    ? samples[
                        samples.length -
                        1
                    ]
                    : null;

            const freshnessTimestamp =
                lastSample?.lastUpdated ??
                lastSample?.timestamp ??
                null;

            const age =
                freshnessTimestamp ===
                null
                    ? null
                    : now -
                    freshnessTimestamp;

            const latencyAverage =
                mean(
                    recentLatencies
                );

            const latencyP50 =
                percentile(
                    recentLatencies,
                    0.50
                );

            const latencyP95 =
                percentile(
                    recentLatencies,
                    0.95
                );

            const assertions =
                this.assertions.get(
                    id
                ) ??
                lastSample?.assertions ??
                0;

            const species =
                this.species.get(
                    id
                ) ??
                lastSample?.species ??
                0;

            const overlap =
                this.overlap.get(
                    id
                ) ??
                0;

            const availabilityScore =
                uptime ===
                    null
                    ? 0.5
                    : clamp(
                        uptime,
                        0,
                        1
                    );

            const latencyScore =
                latencyAverage ===
                    null
                    ? 0.5
                    : latencyAverage <=
                        this.options.latencyWarning
                        ? 1
                        : latencyAverage >=
                            this.options.latencyCritical
                            ? 0
                            : 1 -
                                (
                                    (
                                        latencyAverage -
                                        this.options.latencyWarning
                                    ) /
                                    (
                                        this.options.latencyCritical -
                                        this.options.latencyWarning
                                    )
                                );

            const errorScore =
                errorRate ===
                    null
                    ? 0.5
                    : errorRate <=
                        this.options.errorRateWarning
                        ? 1
                        : errorRate >=
                            this.options.errorRateCritical
                            ? 0
                            : 1 -
                                (
                                    (
                                        errorRate -
                                        this.options.errorRateWarning
                                    ) /
                                    (
                                        this.options.errorRateCritical -
                                        this.options.errorRateWarning
                                    )
                                );

            const freshnessScore =
                age ===
                    null
                    ? 0.5
                    : age <=
                        this.options.staleAfter
                        ? 1
                        : age >=
                            this.options.unhealthyAfter
                            ? 0
                            : 1 -
                                (
                                    (
                                        age -
                                        this.options.staleAfter
                                    ) /
                                    (
                                        this.options.unhealthyAfter -
                                        this.options.staleAfter
                                    )
                                );

            const coverageScore =
                assertions >=
                    this.options.minimumAssertions
                    ? clamp(
                        Math.log10(
                            assertions +
                            1
                        ) /
                        6,
                        0,
                        1
                    )
                    : 0;

            const overlapScore =
                clamp(
                    overlap,
                    0,
                    1
                );

            const weights =
                Object.fromEntries(
                    Object.entries(
                        this.options.scoreWeights
                    ).map(
                        (
                            [
                                key,
                                value
                            ]
                        ) => [
                            key,
                            Math.max(
                                0,
                                parseNumber(
                                    value,
                                    0
                                )
                            )
                        ]
                    )
                );

            const weightTotal =
                Object.values(
                    weights
                ).reduce(
                    (
                        total,
                        value
                    ) =>
                        total +
                        value,
                    0
                ) ||
                1;

            const score =
                (
                    availabilityScore *
                        weights.availability +
                    latencyScore *
                        weights.latency +
                    errorScore *
                        weights.errors +
                    freshnessScore *
                        weights.freshness +
                    coverageScore *
                        weights.coverage +
                    overlapScore *
                        weights.overlap
                ) /
                weightTotal *
                100;

            let state =
                "unknown";

            if (
                metadata.enabled ===
                false
            ) {
                state =
                    "offline";
            } else if (
                lastSample &&
                lastSample.success ===
                false &&
                age !==
                    null &&
                age >=
                    this.options.unhealthyAfter
            ) {
                state =
                    "offline";
            } else if (
                score >=
                85
            ) {
                state =
                    "healthy";
            } else if (
                score >=
                70
            ) {
                state =
                    "degraded";
            } else if (
                score >=
                50
            ) {
                state =
                    "warning";
            } else if (
                samples.length ||
                errorRecords.length
            ) {
                state =
                    "critical";
            }

            return {
                provider:
                    id,

                name:
                    metadata.name,

                state,

                score:
                    Number(
                        score.toFixed(
                            2
                        )
                    ),

                enabled:
                    metadata.enabled,

                eligible:
                    metadata.eligible,

                endpoint:
                    metadata.endpoint,

                lastCheck:
                    lastSample
                        ? new Date(
                            lastSample.timestamp
                        ).toISOString()
                        : null,

                lastUpdated:
                    freshnessTimestamp ===
                        null
                        ? null
                        : new Date(
                            freshnessTimestamp
                        ).toISOString(),

                age,

                freshness:
                    age ===
                        null
                        ? "unknown"
                        : formatDuration(
                            age
                        ),

                uptime,

                availability:
                    uptime ===
                        null
                        ? null
                        : Number(
                            (
                                uptime *
                                100
                            ).toFixed(
                                3
                            )
                        ),

                errorRate,

                errors:
                    recentErrors.length,

                samples:
                    recentSamples.length,

                latency: {
                    average:
                        latencyAverage,

                    p50:
                        latencyP50,

                    p95:
                        latencyP95,

                    samples:
                        recentLatencies.length
                },

                assertions,

                species,

                overlap,

                components: {
                    availability:
                        availabilityScore,

                    latency:
                        latencyScore,

                    errors:
                        errorScore,

                    freshness:
                        freshnessScore,

                    coverage:
                        coverageScore,

                    overlap:
                        overlapScore
                },

                metadata:
                    safeClone(
                        metadata.metadata
                    )
            };
        }

        evaluateAll() {
            return [
                ...this.providers.keys()
            ]
                .map(
                    provider =>
                        this.evaluate(
                            provider
                        )
                )
                .sort(
                    (
                        left,
                        right
                    ) => {
                        const stateDifference =
                            healthRank(
                                left.state
                            ) -
                            healthRank(
                                right.state
                            );

                        if (
                            stateDifference
                        ) {
                            return stateDifference;
                        }

                        return (
                            right.score -
                            left.score
                        );
                    }
                );
        }

        summary() {
            const providers =
                this.evaluateAll();

            const byState =
                Object.fromEntries(
                    HEALTH_STATES.map(
                        state => [
                            state,
                            0
                        ]
                    )
                );

            for (const provider of providers) {
                byState[
                    provider.state
                ] =
                    (
                        byState[
                            provider.state
                        ] ||
                        0
                    ) +
                    1;
            }

            const scores =
                providers
                    .map(
                        provider =>
                            provider.score
                    )
                    .filter(
                        score =>
                            Number.isFinite(
                                score
                            )
                    );

            const latencies =
                providers
                    .map(
                        provider =>
                            provider.latency.average
                    )
                    .filter(
                        latency =>
                            Number.isFinite(
                                latency
                            )
                    );

            return {
                version:
                    VERSION,

                generatedAt:
                    nowISO(),

                providers:
                    providers.length,

                enabled:
                    providers.filter(
                        provider =>
                            provider.enabled
                    ).length,

                eligible:
                    providers.filter(
                        provider =>
                            provider.eligible
                    ).length,

                byState,

                averageScore:
                    mean(
                        scores
                    ),

                averageLatency:
                    mean(
                        latencies
                    ),

                assertions:
                    providers.reduce(
                        (
                            total,
                            provider
                        ) =>
                            total +
                            provider.assertions,
                        0
                    ),

                species:
                    providers.reduce(
                        (
                            total,
                            provider
                        ) =>
                            total +
                            provider.species,
                        0
                    ),

                providersData:
                    providers
            };
        }

        /*
        ======================================================================
        Library Ingestion
        ======================================================================
        */

        async ingestLibrary(
            options = {}
        ) {
            if (this.destroyed) {
                return {
                    providers: 0,
                    samples: 0,
                    latencies: 0,
                    errors: 0,
                    skipped: true
                };
            }

            if (this.ingesting) {
                this.ingestPending = true;
                this.metrics.skippedRecursiveIngestions += 1;

                return {
                    providers: 0,
                    samples: 0,
                    latencies: 0,
                    errors: 0,
                    skipped: true,
                    recursive: true
                };
            }

            const library =
                this.context.library ||
                this.context.services?.get?.(
                    "library"
                );

            if (
                !library ||
                typeof library.get !==
                    "function"
            ) {
                return {
                    providers: 0,
                    samples: 0,
                    latencies: 0,
                    errors: 0,
                    skipped: true,
                    reason:
                        "library-unavailable"
                };
            }

            this.ingesting = true;
            this.ingestPending = false;

            const counts = {
                providers: 0,
                samples: 0,
                latencies: 0,
                errors: 0,
                skipped: false
            };

            const getCollection =
                async name => {
                    const result =
                        library.get(name);

                    return result &&
                    typeof result.then ===
                        "function"
                        ? await result
                        : result;
                };

            try {
                const providerCollections = [
                    "providers",
                    "enabled-providers",
                    "eligible-providers",
                    "provider-statistics",
                    "provider-health"
                ];

                for (
                    const collection
                    of providerCollections
                ) {
                    const records =
                        await getCollection(
                            collection
                        ) ||
                        [];

                    if (!Array.isArray(records)) {
                        continue;
                    }

                    for (const record of records) {
                        if (!isObject(record)) {
                            continue;
                        }

                        const provider =
                            firstValue(
                                record,
                                [
                                    "provider",
                                    "provider_id",
                                    "providerId",
                                    "id",
                                    "name",
                                    "key"
                                ]
                            );

                        if (!provider) {
                            continue;
                        }

                        this.ensureProvider(
                            provider,
                            record
                        );

                        counts.providers += 1;

                        if (
                            collection ===
                            "provider-health"
                        ) {
                            this.recordSample(
                                provider,
                                record,
                                {
                                    emit: false,
                                    notify: false,
                                    archive: false,
                                    source:
                                        options.source ||
                                        "library"
                                }
                            );

                            counts.samples += 1;
                        }

                        const assertions =
                            firstValue(
                                record,
                                [
                                    "assertions",
                                    "source_assertions",
                                    "sourceAssertions"
                                ]
                            );

                        if (assertions !== null) {
                            this.setAssertions(
                                provider,
                                assertions
                            );
                        }

                        const species =
                            firstValue(
                                record,
                                [
                                    "species",
                                    "species_count",
                                    "speciesCount"
                                ]
                            );

                        if (species !== null) {
                            this.setSpecies(
                                provider,
                                species
                            );
                        }

                        const overlap =
                            firstValue(
                                record,
                                [
                                    "overlap",
                                    "overlap_ratio",
                                    "overlapRatio"
                                ]
                            );

                        if (overlap !== null) {
                            this.setOverlap(
                                provider,
                                overlap
                            );
                        }
                    }
                }

                const latencyRecords =
                    await getCollection(
                        "provider-latency"
                    ) ||
                    [];

                if (Array.isArray(latencyRecords)) {
                    for (const record of latencyRecords) {
                        if (!isObject(record)) {
                            continue;
                        }

                        const provider =
                            firstValue(
                                record,
                                [
                                    "provider",
                                    "provider_id",
                                    "providerId",
                                    "id"
                                ]
                            );

                        if (!provider) {
                            continue;
                        }

                        const result =
                            this.recordLatency(
                                provider,
                                firstValue(
                                    record,
                                    [
                                        "latency",
                                        "latency_ms",
                                        "latencyMs",
                                        "duration"
                                    ]
                                ),
                                firstValue(
                                    record,
                                    [
                                        "timestamp",
                                        "checkedAt",
                                        "date"
                                    ]
                                ),
                                false,
                                {
                                    source:
                                        options.source ||
                                        "library"
                                }
                            );

                        if (result) {
                            counts.latencies += 1;
                        }
                    }
                }

                const errorRecords =
                    await getCollection(
                        "provider-errors"
                    ) ||
                    [];

                if (Array.isArray(errorRecords)) {
                    for (const record of errorRecords) {
                        if (!isObject(record)) {
                            continue;
                        }

                        const provider =
                            firstValue(
                                record,
                                [
                                    "provider",
                                    "provider_id",
                                    "providerId",
                                    "id"
                                ]
                            );

                        if (!provider) {
                            continue;
                        }

                        const result =
                            this.recordError(
                                provider,
                                firstValue(
                                    record,
                                    [
                                        "error",
                                        "message",
                                        "detail"
                                    ]
                                ) ||
                                "Provider error",
                                firstValue(
                                    record,
                                    [
                                        "timestamp",
                                        "date",
                                        "occurredAt"
                                    ]
                                ),
                                false,
                                {
                                    source:
                                        options.source ||
                                        "library"
                                }
                            );

                        if (result) {
                            counts.errors += 1;
                        }
                    }
                }

                this.metrics.ingestions += 1;

                if (options.emit !== false) {
                    this.emit(
                        "ingest",
                        {
                            counts:
                                safeClone(
                                    counts
                                ),
                            source:
                                options.source ||
                                "runtime"
                        }
                    );
                }

                return counts;
            } finally {
                this.ingesting = false;

                if (
                    this.ingestPending &&
                    !this.destroyed
                ) {
                    this.ingestPending = false;

                    this.scheduleLibraryIngestion({
                        emit:
                            options.emit,
                        source:
                            "pending"
                    });
                }
            }
        }

        /*
        ======================================================================
        Runtime Event Ingestion
        ======================================================================
        */

        bindEvent(
            target,
            name,
            handler
        ) {
            if (
                !target ||
                typeof target.addEventListener !==
                    "function"
            ) {
                return false;
            }

            const bound =
                this.addManagedListener(
                    target,
                    name,
                    handler
                );

            if (bound) {
                this.boundHandlers.push({
                    target,
                    name,
                    handler
                });
            }

            return bound;
        }

        bindRuntimeEvents() {
            const sampleHandler =
                event => {
                    const detail =
                        event.detail ||
                        {};

                    const provider =
                        detail.provider ||
                        detail.id ||
                        detail.name;

                    if (provider) {
                        this.recordSample(
                            provider,
                            detail
                        );
                    }
                };

            const latencyHandler =
                event => {
                    const detail =
                        event.detail ||
                        {};

                    if (detail.provider) {
                        this.recordLatency(
                            detail.provider,
                            detail.latency ||
                            detail.value ||
                            detail.duration,
                            detail.timestamp
                        );
                    }
                };

            const errorHandler =
                event => {
                    const detail =
                        event.detail ||
                        {};

                    if (detail.provider) {
                        this.recordError(
                            detail.provider,
                            detail.error ||
                            detail.message ||
                            "Provider error",
                            detail.timestamp
                        );
                    }
                };

            const libraryHandler =
                event => {
                    const detail =
                        event.detail ||
                        {};

                    const collection =
                        normalizeCollectionName(
                            detail.collection
                        );

                    if (
                        collection ===
                            "providers" ||
                        collection ===
                            "enabled-providers" ||
                        collection ===
                            "eligible-providers" ||
                        collection ===
                            "provider-health" ||
                        collection ===
                            "provider-errors" ||
                        collection ===
                            "provider-latency" ||
                        collection ===
                            "provider-statistics" ||
                        collection ===
                            "provider-assertions" ||
                        collection ===
                            "provider-species"
                    ) {
                        this.scheduleLibraryIngestion({
                            source:
                                `library-event:${collection}`
                        });
                    }
                };

            this.bindEvent(
                document,
                "speciedex:provider-health",
                sampleHandler
            );

            this.bindEvent(
                document,
                "speciedex:provider-latency",
                latencyHandler
            );

            this.bindEvent(
                document,
                "speciedex:provider-error",
                errorHandler
            );

            this.bindEvent(
                document,
                "speciedex:terminal-library-updated",
                libraryHandler
            );

            this.bindEvent(
                this.context.root,
                "speciedex:terminal-library-update",
                libraryHandler
            );

            this.bindEvent(
                this.context.root,
                "speciedex:terminal-library-batch",
                libraryHandler
            );
        }

        /*
        ======================================================================
        Monitoring
        ======================================================================
        */

        async run(
            parameters = {}
        ) {
            this.assertActive();

            if (
                parameters.refresh !==
                false
            ) {
                await this.ingestLibrary();
            }

            const provider =
                parameters.provider ||
                parameters.args?.[0] ||
                null;

            if (provider) {
                return this.evaluate(
                    provider
                );
            }

            return this.summary();
        }

        async checkProvider(
            provider,
            options = {}
        ) {
            this.assertActive();

            this.metrics.checks +=
                1;

            const metadata =
                this.ensureProvider(
                    provider
                );

            if (!metadata.endpoint) {
                throw new Error(
                    `Provider "${metadata.id}" has no configured endpoint.`
                );
            }

            if (typeof fetch !== "function") {
                throw new Error(
                    "Fetch is unavailable in this environment."
                );
            }

            const controller =
                typeof AbortController ===
                    "function"
                    ? new AbortController()
                    : null;

            const timeout =
                window.setTimeout(
                    () =>
                        controller?.abort?.(),
                    parseNumber(
                        options.timeout,
                        15000
                    )
                );

            const started =
                monotonicNow();

            try {
                const response =
                    await fetch(
                        metadata.endpoint,
                        {
                            method:
                                options.method ||
                                "HEAD",

                            cache:
                                "no-store",

                            signal:
                                controller?.signal,

                            headers:
                                options.headers ||
                                {}
                        }
                    );

                const latency =
                    monotonicNow() -
                    started;

                return this.recordSample(
                    metadata.id,
                    {
                        success:
                            response.ok,

                        statusCode:
                            response.status,

                        latency,

                        timestamp:
                            Date.now(),

                        lastUpdated:
                            response.headers.get(
                                "last-modified"
                            ) ||
                            Date.now()
                    }
                );
            } catch (error) {
                this.metrics.checkErrors +=
                    1;

                const latency =
                    monotonicNow() -
                    started;

                return this.recordSample(
                    metadata.id,
                    {
                        success:
                            false,

                        latency,

                        timestamp:
                            Date.now(),

                        error
                    }
                );
            } finally {
                window.clearTimeout(
                    timeout
                );
            }
        }

        async checkAll(
            options = {}
        ) {
            const providers =
                [
                    ...this.providers.values()
                ].filter(
                    provider =>
                        provider.enabled &&
                        provider.endpoint
                );

            const concurrency =
                clamp(
                    parseNumber(
                        options.concurrency,
                        4
                    ),
                    1,
                    this.options.maximumConcurrentChecks
                );

            const results =
                [];

            let index =
                0;

            const worker =
                async () => {
                    while (
                        index <
                        providers.length
                    ) {
                        const current =
                            providers[
                                index++
                            ];

                        results.push(
                            await this.checkProvider(
                                current.id,
                                options
                            )
                        );
                    }
                };

            if (
                providers.length
            ) {
                await Promise.all(
                    Array.from(
                        {
                            length:
                                Math.min(
                                    concurrency,
                                    providers.length
                                )
                        },
                        () =>
                            worker()
                    )
                );
            }

            return results;
        }

        start(
            interval =
                this.options.interval
        ) {
            this.assertActive();

            if (this.running) {
                return false;
            }

            this.running =
                true;

            const delay =
                Math.max(
                    5000,
                    parseNumber(
                        interval,
                        this.options.interval
                    )
                );

            let ticking =
                false;

            const tick =
                async () => {
                    if (
                        !this.running ||
                        this.destroyed ||
                        ticking
                    ) {
                        return;
                    }

                    ticking = true;

                    try {
                        await this.checkAll();
                    } catch (error) {
                        this.emit(
                            "monitor-error",
                            {
                                error
                            }
                        );
                    } finally {
                        ticking = false;
                    }
                };

            tick();

            this.timer =
                window.setInterval(
                    tick,
                    delay
                );

            this.emit(
                "monitor-start",
                {
                    interval:
                        delay
                }
            );

            return true;
        }

        stop() {
            if (!this.running) {
                return false;
            }

            this.running =
                false;

            if (this.timer) {
                window.clearInterval(
                    this.timer
                );

                this.timer =
                    0;
            }

            this.emit(
                "monitor-stop",
                {}
            );

            return true;
        }

        /*
        ======================================================================
        History and Notifications
        ======================================================================
        */

        archive(
            health
        ) {
            const entry = {
                timestamp:
                    nowISO(),

                health
            };

            this.history.push(
                entry
            );

            this.history =
                this.history.slice(
                    -this.options.historyLimit
                );

            return entry;
        }

        notifyTransition(
            health
        ) {
            if (
                !this.options.emitNotifications ||
                !this.context.notifications
            ) {
                return;
            }

            const previous =
                this.history.length >=
                    2
                    ? this.history[
                        this.history.length -
                        2
                    ]?.health
                    : null;

            if (
                previous?.provider !==
                    health.provider ||
                previous?.state ===
                    health.state
            ) {
                return;
            }

            if (
                [
                    "warning",
                    "critical",
                    "offline"
                ].includes(
                    health.state
                )
            ) {
                const type =
                    health.state ===
                    "warning"
                        ? "warning"
                        : "error";

                this.context.notifications.notify(
                    `${health.name} provider health changed to ${health.state}.`,
                    type,
                    health.state ===
                        "offline"
                        ? 0
                        : 7000,
                    {
                        title:
                            "Provider Health",

                        priority:
                            health.state ===
                                "offline"
                                ? "urgent"
                                : "high",

                        persistent:
                            health.state ===
                            "offline"
                    }
                );
            }
        }

        /*
        ======================================================================
        Filtering and Export
        ======================================================================
        */

        list(
            options = {}
        ) {
            const state =
                options.state
                    ? String(
                        options.state
                    ).toLowerCase()
                    : null;

            const enabled =
                options.enabled;

            const eligible =
                options.eligible;

            const contains =
                normalizeText(
                    options.contains ||
                    options.text
                ).toLowerCase();

            const minimumScore =
                options.minimumScore !==
                    undefined
                    ? parseNumber(
                        options.minimumScore,
                        0
                    )
                    : null;

            const maximumScore =
                options.maximumScore !==
                    undefined
                    ? parseNumber(
                        options.maximumScore,
                        100
                    )
                    : null;

            let results =
                this.evaluateAll()
                    .filter(
                        provider =>
                            (
                                !state ||
                                provider.state ===
                                state
                            ) &&
                            (
                                enabled ===
                                    undefined ||
                                provider.enabled ===
                                enabled
                            ) &&
                            (
                                eligible ===
                                    undefined ||
                                provider.eligible ===
                                eligible
                            ) &&
                            (
                                !contains ||
                                [
                                    provider.provider,
                                    provider.name,
                                    provider.endpoint,
                                    provider.state
                                ]
                                    .join(" ")
                                    .toLowerCase()
                                    .includes(
                                        contains
                                    )
                            ) &&
                            (
                                minimumScore ===
                                    null ||
                                provider.score >=
                                minimumScore
                            ) &&
                            (
                                maximumScore ===
                                    null ||
                                provider.score <=
                                maximumScore
                            )
                    );

            const sort =
                String(
                    options.sort ||
                    "state"
                );

            results.sort(
                (
                    left,
                    right
                ) => {
                    switch (sort) {
                        case "score":
                            return (
                                right.score -
                                left.score
                            );

                        case "latency":
                            return (
                                (
                                    left.latency.average ??
                                    Number.POSITIVE_INFINITY
                                ) -
                                (
                                    right.latency.average ??
                                    Number.POSITIVE_INFINITY
                                )
                            );

                        case "name":
                            return left.name.localeCompare(
                                right.name
                            );

                        case "state":
                        default:
                            return (
                                healthRank(
                                    left.state
                                ) -
                                healthRank(
                                    right.state
                                )
                            );
                    }
                }
            );

            const limit =
                clamp(
                    parseNumber(
                        options.limit,
                        results.length ||
                        1
                    ),
                    1,
                    10000
                );

            return results.slice(
                0,
                limit
            );
        }

        exportJSON() {
            return {
                version:
                    VERSION,

                generatedAt:
                    nowISO(),

                options:
                    safeClone(
                        this.options
                    ),

                summary:
                    this.summary(),

                history:
                    this.history
            };
        }

        exportCSV() {
            const rows =
                this.evaluateAll();

            const header = [
                "provider",
                "name",
                "state",
                "score",
                "enabled",
                "eligible",
                "availability_percent",
                "error_rate",
                "latency_average_ms",
                "latency_p50_ms",
                "latency_p95_ms",
                "assertions",
                "species",
                "overlap",
                "last_check",
                "last_updated",
                "freshness"
            ];

            const lines = [
                header.join(",")
            ];

            for (const provider of rows) {
                lines.push(
                    [
                        provider.provider,
                        provider.name,
                        provider.state,
                        provider.score,
                        provider.enabled,
                        provider.eligible,
                        provider.availability,
                        provider.errorRate,
                        provider.latency.average,
                        provider.latency.p50,
                        provider.latency.p95,
                        provider.assertions,
                        provider.species,
                        provider.overlap,
                        provider.lastCheck,
                        provider.lastUpdated,
                        provider.freshness
                    ]
                        .map(
                            escapeCSV
                        )
                        .join(",")
                );
            }

            return lines.join(
                "\n"
            );
        }

        status() {
            return {
                version:
                    VERSION,

                running:
                    this.running,

                interval:
                    this.options.interval,

                providers:
                    this.providers.size,

                samples:
                    [
                        ...this.samples.values()
                    ].reduce(
                        (
                            total,
                            values
                        ) =>
                            total +
                            values.length,
                        0
                    ),

                latencySamples:
                    [
                        ...this.latencies.values()
                    ].reduce(
                        (
                            total,
                            values
                        ) =>
                            total +
                            values.length,
                        0
                    ),

                errors:
                    [
                        ...this.errors.values()
                    ].reduce(
                        (
                            total,
                            values
                        ) =>
                            total +
                            values.length,
                        0
                    ),

                history:
                    this.history.length,

                ingesting:
                    this.ingesting,

                ingestPending:
                    this.ingestPending,

                initialized:
                    this.initialized,

                destroyed:
                    this.destroyed,

                deduplication: {
                    samples:
                        this.seenSamples.size,
                    latencies:
                        this.seenLatencies.size,
                    errors:
                        this.seenErrors.size
                },

                metrics:
                    safeClone(
                        this.metrics
                    ),

                summary:
                    this.summary()
            };
        }

        /*
        ======================================================================
        Events and Teardown
        ======================================================================
        */

        emit(
            type,
            detail = {}
        ) {
            if (
                this.destroyed &&
                type !== "destroy"
            ) {
                return false;
            }

            if (this.emitting) {
                return false;
            }

            const payload =
                safeClone(detail);

            this.emitting = true;

            try {
                dispatch(
                    this,
                    type,
                    payload
                );

                for (
                    const watcher
                    of Array.from(
                        this.watchers
                    )
                ) {
                    try {
                        watcher(
                            {
                                type,
                                timestamp:
                                    nowISO(),
                                detail:
                                    payload
                            },
                            this
                        );
                    } catch (_error) {
                        /* Watcher failures are isolated. */
                    }
                }

                try {
                    this.context.events?.emit?.(
                        `provider-health:${type}`,
                        payload
                    );
                } catch (_error) {
                    /* External event-bus failures are isolated. */
                }

                dispatch(
                    this.context.root,
                    `speciedex:terminal-provider-health-${type}`,
                    payload,
                    {
                        bubbles:
                            true
                    }
                );

                dispatch(
                    document,
                    `speciedex:terminal-provider-health-${type}`,
                    payload
                );

                return true;
            } finally {
                this.emitting = false;
            }
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            this.stop();

            window.clearTimeout(
                this.ingestTimer
            );

            try {
                this.abortController?.abort?.();
            } catch (_error) {
                /* Continue teardown. */
            }

            for (
                const dispose
                of this.boundDisposers.splice(0)
            ) {
                try {
                    dispose();
                } catch (_error) {
                    /* Continue teardown. */
                }
            }

            this.emit(
                "destroy",
                {
                    version:
                        VERSION
                }
            );

            this.boundHandlers = [];
            this.watchers.clear();
            this.providers.clear();
            this.samples.clear();
            this.errors.clear();
            this.latencies.clear();
            this.assertions.clear();
            this.species.clear();
            this.overlap.clear();
            this.seenSamples.clear();
            this.seenLatencies.clear();
            this.seenErrors.clear();

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
                this.context.providerHealth ===
                    this
            ) {
                delete this.context.providerHealth;
            }

            if (
                this.context.providerhealth ===
                    this
            ) {
                delete this.context.providerhealth;
            }

            this.destroyed = true;

            return true;
        }

    }

    /*
    ==========================================================================
    Initialization
    ==========================================================================
    */

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
            safeContext.providerHealth instanceof
                ProviderHealthService
                ? safeContext.providerHealth
                : safeContext.services?.get?.(
                    "provider-health"
                ) ||
                root?.[
                    SERVICE_SYMBOL
                ];

        if (
            existing instanceof
                ProviderHealthService &&
            !existing.destroyed
        ) {
            safeContext.providerHealth =
                existing;

            safeContext.providerhealth =
                existing;

            safeContext.registerService?.(
                "provider-health",
                existing
            );

            return existing;
        }

        const dataset =
            root.dataset || {};

        const config =
            safeContext.config?.
                providerHealth ||
            safeContext.config?.
                providerhealth ||
            {};

        const service =
            new ProviderHealthService(
                {
                    ...safeContext,
                    root
                },
                {
                    interval:
                        parseNumber(
                            dataset.
                                terminalProviderHealthInterval ??
                            config.interval,
                            DEFAULT_OPTIONS.interval
                        ),

                    historyLimit:
                        parseNumber(
                            dataset.
                                terminalProviderHealthHistory ??
                            config.historyLimit,
                            DEFAULT_OPTIONS.historyLimit
                        ),

                    staleAfter:
                        parseNumber(
                            dataset.
                                terminalProviderStaleAfter ??
                            config.staleAfter,
                            DEFAULT_OPTIONS.staleAfter
                        ),

                    unhealthyAfter:
                        parseNumber(
                            dataset.
                                terminalProviderUnhealthyAfter ??
                            config.unhealthyAfter,
                            DEFAULT_OPTIONS.unhealthyAfter
                        ),

                    latencyWarning:
                        parseNumber(
                            dataset.
                                terminalProviderLatencyWarning ??
                            config.latencyWarning,
                            DEFAULT_OPTIONS.latencyWarning
                        ),

                    latencyCritical:
                        parseNumber(
                            dataset.
                                terminalProviderLatencyCritical ??
                            config.latencyCritical,
                            DEFAULT_OPTIONS.latencyCritical
                        ),

                    autoStart:
                        parseBoolean(
                            dataset.
                                terminalProviderHealthAutoStart ??
                            config.autoStart,
                            DEFAULT_OPTIONS.autoStart
                        ),

                    emitNotifications:
                        parseBoolean(
                            dataset.
                                terminalProviderHealthNotifications ??
                            config.emitNotifications,
                            DEFAULT_OPTIONS.emitNotifications
                        ),

                    ingestOnInitialize:
                        parseBoolean(
                            dataset.
                                terminalProviderHealthIngest ??
                            config.ingestOnInitialize,
                            DEFAULT_OPTIONS.ingestOnInitialize
                        ),

                    ingestDebounce:
                        parseNumber(
                            dataset.
                                terminalProviderHealthIngestDebounce ??
                            config.ingestDebounce,
                            DEFAULT_OPTIONS.ingestDebounce
                        ),

                    maximumProviders:
                        parseNumber(
                            dataset.
                                terminalProviderHealthMaximumProviders ??
                            config.maximumProviders,
                            DEFAULT_OPTIONS.maximumProviders
                        ),

                    maximumConcurrentChecks:
                        parseNumber(
                            dataset.
                                terminalProviderHealthMaximumConcurrentChecks ??
                            config.maximumConcurrentChecks,
                            DEFAULT_OPTIONS.maximumConcurrentChecks
                        ),

                    scoreWeights:
                        config.scoreWeights
                }
            );

        root[
            SERVICE_SYMBOL
        ] =
            service;

        safeContext.providerHealth =
            service;

        safeContext.providerhealth =
            service;

        safeContext.registerService?.(
            "provider-health",
            service
        );

        dispatch(
            document,
            "speciedex:terminal-provider-health-ready",
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

    /*
    ==========================================================================
    Commands
    ==========================================================================
    */

    function resolveCommandContext(payload = {}) {
        return (
            payload.context ||
            payload.terminal?.context ||
            payload.app?.context ||
            payload
        );
    }

    function requireProviderHealth(
        context = {}
    ) {
        const safeContext =
            isObject(context)
                ? context
                : {};

        const service =
            safeContext.providerHealth ||
            safeContext.services?.get?.(
                "provider-health"
            ) ||
            initialize(safeContext);

        if (
            !(service instanceof ProviderHealthService) ||
            service.destroyed
        ) {
            throw new Error(
                "Provider health service is unavailable."
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
            typeof payload.writeJSON ===
                "function" &&
            typeof value !==
                "string"
        ) {
            return payload.writeJSON(
                value
            );
        }

        if (
            typeof payload.write ===
                "function"
        ) {
            return payload.write(
                typeof value ===
                    "string"
                    ? value
                    : safeStringify(
                        value
                    ),
                type
            );
        }

        if (
            typeof payload.writeLine ===
                "function"
        ) {
            return payload.writeLine(
                typeof value ===
                    "string"
                    ? value
                    : safeStringify(
                        value
                    )
            );
        }

        return value;
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

        anchor.href =
            url;

        anchor.download =
            filename;

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

    const commands =
        [
            {
                name:
                    "provider-health",
                category:
                    "data",
                description:
                    "Inspect provider health summaries or one provider.",
                usage:
                    "provider-health [provider] [--state STATE] [--sort state|score|latency|name]",
                handler: async payload => {
                    const context =
                        resolveCommandContext(
                            payload
                        );

                    const args =
                        Array.isArray(
                            payload.args
                        )
                            ? payload.args
                            : [];

                    const parsed =
                        isObject(
                            payload.parsed
                        )
                            ? payload.parsed
                            : {
                                flags: {},
                                options: {}
                            };

                    const service =
                        requireProviderHealth(
                            context
                        );

                    if (args[0]) {
                        return writeResult(
                            payload,
                            service.evaluate(
                                args[0]
                            )
                        );
                    }

                    if (
                        parsed.options?.state ||
                        parsed.options?.sort ||
                        parsed.options?.contains ||
                        parsed.options?.limit
                    ) {
                        return writeResult(
                            payload,
                            service.list({
                                state:
                                    parsed.options.state,
                                sort:
                                    parsed.options.sort,
                                contains:
                                    parsed.options.contains,
                                limit:
                                    parsed.options.limit,
                                enabled:
                                    parseBoolean(
                                        parsed.flags?.enabled,
                                        false
                                    )
                                        ? true
                                        : undefined,
                                eligible:
                                    parseBoolean(
                                        parsed.flags?.eligible,
                                        false
                                    )
                                        ? true
                                        : undefined
                            })
                        );
                    }

                    return writeResult(
                        payload,
                        await service.run()
                    );
                }
            },

            {
                name:
                    "provider-health-status",
                category:
                    "data",
                description:
                    "Display provider-health service status.",
                usage:
                    "provider-health-status",
                handler: payload => {
                    const context =
                        resolveCommandContext(
                            payload
                        );

                    return writeResult(
                        payload,
                        requireProviderHealth(
                            context
                        ).status()
                    );
                }
            },

            {
                name:
                    "provider-health-refresh",
                category:
                    "data",
                description:
                    "Refresh provider-health data from terminal library collections.",
                usage:
                    "provider-health-refresh",
                handler: async payload => {
                    const context =
                        resolveCommandContext(
                            payload
                        );

                    return writeResult(
                        payload,
                        await requireProviderHealth(
                            context
                        ).ingestLibrary({
                            source:
                                "command"
                        })
                    );
                }
            },

            {
                name:
                    "provider-health-check",
                category:
                    "data",
                description:
                    "Check one configured provider endpoint.",
                usage:
                    "provider-health-check <provider> [--timeout MS] [--method HEAD|GET]",
                handler: async payload => {
                    const context =
                        resolveCommandContext(
                            payload
                        );

                    const args =
                        Array.isArray(
                            payload.args
                        )
                            ? payload.args
                            : [];

                    const parsed =
                        isObject(
                            payload.parsed
                        )
                            ? payload.parsed
                            : {
                                options: {}
                            };

                    const provider =
                        args[0];

                    if (!provider) {
                        throw new Error(
                            "A provider ID is required."
                        );
                    }

                    return writeResult(
                        payload,
                        await requireProviderHealth(
                            context
                        ).checkProvider(
                            provider,
                            {
                                timeout:
                                    parsed.options?.timeout,
                                method:
                                    parsed.options?.method
                            }
                        )
                    );
                }
            },

            {
                name:
                    "provider-health-check-all",
                category:
                    "data",
                description:
                    "Check all enabled providers with configured endpoints.",
                usage:
                    "provider-health-check-all [--concurrency N] [--timeout MS]",
                handler: async payload => {
                    const context =
                        resolveCommandContext(
                            payload
                        );

                    const parsed =
                        isObject(
                            payload.parsed
                        )
                            ? payload.parsed
                            : {
                                options: {}
                            };

                    return writeResult(
                        payload,
                        await requireProviderHealth(
                            context
                        ).checkAll({
                            concurrency:
                                parsed.options?.concurrency,
                            timeout:
                                parsed.options?.timeout,
                            method:
                                parsed.options?.method
                        })
                    );
                }
            },

            {
                name:
                    "provider-health-start",
                category:
                    "data",
                description:
                    "Start periodic provider-health monitoring.",
                usage:
                    "provider-health-start [interval-ms]",
                handler: payload => {
                    const context =
                        resolveCommandContext(
                            payload
                        );

                    const args =
                        Array.isArray(
                            payload.args
                        )
                            ? payload.args
                            : [];

                    const started =
                        requireProviderHealth(
                            context
                        ).start(
                            args[0]
                        );

                    return writeResult(
                        payload,
                        started
                            ? "Provider-health monitoring started."
                            : "Provider-health monitoring is already running.",
                        started
                            ? "success"
                            : "warning"
                    );
                }
            },

            {
                name:
                    "provider-health-stop",
                category:
                    "data",
                description:
                    "Stop periodic provider-health monitoring.",
                usage:
                    "provider-health-stop",
                handler: payload => {
                    const context =
                        resolveCommandContext(
                            payload
                        );

                    const stopped =
                        requireProviderHealth(
                            context
                        ).stop();

                    return writeResult(
                        payload,
                        stopped
                            ? "Provider-health monitoring stopped."
                            : "Provider-health monitoring was not running.",
                        stopped
                            ? "success"
                            : "warning"
                    );
                }
            },

            {
                name:
                    "provider-health-record",
                category:
                    "data",
                description:
                    "Record a manual provider-health sample.",
                usage:
                    "provider-health-record <provider> <success|failure> [latency-ms]",
                handler: payload => {
                    const context =
                        resolveCommandContext(
                            payload
                        );

                    const args =
                        Array.isArray(
                            payload.args
                        )
                            ? payload.args
                            : [];

                    const provider =
                        args[0];

                    const state =
                        String(
                            args[1] ||
                            ""
                        ).toLowerCase();

                    if (
                        !provider ||
                        ![
                            "success",
                            "failure",
                            "ok",
                            "error"
                        ].includes(
                            state
                        )
                    ) {
                        throw new Error(
                            "Usage: provider-health-record <provider> <success|failure> [latency-ms]"
                        );
                    }

                    return writeResult(
                        payload,
                        requireProviderHealth(
                            context
                        ).recordSample(
                            provider,
                            {
                                success:
                                    [
                                        "success",
                                        "ok"
                                    ].includes(
                                        state
                                    ),
                                latency:
                                    args[2],
                                timestamp:
                                    Date.now()
                            }
                        )
                    );
                }
            },

            {
                name:
                    "provider-health-export",
                category:
                    "data",
                description:
                    "Export provider health as JSON or CSV.",
                usage:
                    "provider-health-export [json|csv] [filename]",
                handler: payload => {
                    const context =
                        resolveCommandContext(
                            payload
                        );

                    const args =
                        Array.isArray(
                            payload.args
                        )
                            ? payload.args
                            : [];

                    const service =
                        requireProviderHealth(
                            context
                        );

                    const format =
                        String(
                            args[0] ||
                            "json"
                        ).toLowerCase();

                    if (format === "csv") {
                        const filename =
                            args[1] ||
                            "speciedex-provider-health.csv";

                        download(
                            service.exportCSV(),
                            filename,
                            "text/csv;charset=utf-8",
                            context
                        );

                        return writeResult(
                            payload,
                            `Provider health exported to ${filename}.`,
                            "success"
                        );
                    }

                    if (format !== "json") {
                        throw new Error(
                            "Use: provider-health-export json|csv [filename]"
                        );
                    }

                    const filename =
                        args[1] ||
                        "speciedex-provider-health.json";

                    download(
                        safeStringify(
                            service.exportJSON()
                        ),
                        filename,
                        "application/json;charset=utf-8",
                        context
                    );

                    return writeResult(
                        payload,
                        `Provider health exported to ${filename}.`,
                        "success"
                    );
                }
            }
        ];

    /*
    ==========================================================================
    Public Module API
    ==========================================================================
    */

    const api =
        Object.freeze({
            name:
                MODULE_NAME,

            version:
                VERSION,

            DEFAULT_OPTIONS,
            HEALTH_STATES,
            SERVICE_SYMBOL,
            ProviderHealthService,

            clamp,
            parseNumber,
            parseBoolean,
            normalizeProviderID,
            normalizeCollectionName,
            normalizeTimestamp,
            stableSampleKey,
            mean,
            percentile,
            formatDuration,
            healthRank,
            dispatch,
            safeClone,
            safeStringify,
            resolveCommandContext,

            initialize,
            mount:
                initialize,
            init:
                initialize,
            setup:
                initialize,

            commands
        });

    window.SpeciedexTerminalProviderHealth =
        api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules ||
        {};

    window.SpeciedexTerminalModules[
        MODULE_NAME
    ] =
        api;

    dispatch(
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
