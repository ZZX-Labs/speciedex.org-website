/*
========================================================================
Speciedex.org
Terminal Statistics Service
========================================================================

Loads, normalizes, combines, analyzes, and reports canonical Speciedex dataset
statistics, statistics history, provider acquisition metrics, and live terminal
state metrics.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/
(function (window, document) {
    "use strict";

    const MODULE_NAME = "Stats";
    const VERSION = "2.2.0";
    const SERVICE_SYMBOL =
        Symbol.for(
            "speciedex.terminal.stats.service"
        );

    const DEFAULT_TTL = 60000;
    const DEFAULT_HISTORY_LIMIT = 30;
    const DEFAULT_PROVIDER_LIMIT = 50;
    const DEFAULT_HISTORY_MAXIMUM = 10000;
    const DEFAULT_PROVIDER_MAXIMUM = 5000;

    const DEFAULT_URLS = Object.freeze({
        statistics: "/static/data/statistics.json",
        history: "/static/data/statistics-history.json",
        sources: "/static/data/statistics-sources.json",
        speciesIndex: "/static/data/db/indexes/canonical-records.json",
        databaseManifest: "/static/data/db/manifest.json",
        browserManifest: "/static/data/db/indexes/manifest.json"
    });

    const PRIMARY_KEYS = Object.freeze([
        "species", "subspecies", "genera", "families", "orders",
        "classes", "phyla", "kingdoms", "records_archived",
        "source_assertions", "synonyms", "unresolved_conflicts",
        "volumes", "providers", "enabled_providers", "eligible_providers"
    ]);

    const RANK_ALIASES = Object.freeze({
        domain: "domains",
        kingdom: "kingdoms",
        phylum: "phyla",
        class: "classes",
        order: "orders",
        family: "families",
        tribe: "tribes",
        genus: "genera",
        species: "species",
        subspecies: "subspecies",
        variety: "varieties",
        varietas: "varieties",
        form: "forms",
        forma: "forms",
        clade: "clades",
        unranked: "unranked"
    });

    const VALUE_ALIASES = Object.freeze({
        species_count: "species",
        subspecies_count: "subspecies",
        genus: "genera",
        genus_count: "genera",
        family: "families",
        family_count: "families",
        order: "orders",
        order_count: "orders",
        class: "classes",
        class_count: "classes",
        phylum: "phyla",
        phylum_count: "phyla",
        kingdom: "kingdoms",
        kingdom_count: "kingdoms",
        records: "records_archived",
        canonical_records: "records_archived",
        assertions: "source_assertions",
        conflicts: "unresolved_conflicts",
        archive_volumes: "volumes",
        provider_count: "providers",
        registered_providers: "providers",
        providers_total: "providers",
        updated: "last_updated"
    });

    function isObject(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    function clone(
        value,
        seen =
            new WeakMap()
    ) {
        if (
            value ===
                undefined ||
            value ===
                null ||
            typeof value !==
                "object"
        ) {
            return value;
        }

        if (
            typeof structuredClone ===
                "function"
        ) {
            try {
                return structuredClone(
                    value
                );
            } catch (_error) {
                /* Continue with deterministic fallback. */
            }
        }

        if (
            seen.has(
                value
            )
        ) {
            return seen.get(
                value
            );
        }

        if (
            value instanceof
                Date
        ) {
            return new Date(
                value.getTime()
            );
        }

        if (
            Array.isArray(
                value
            )
        ) {
            const output =
                [];

            seen.set(
                value,
                output
            );

            for (
                const item of
                value
            ) {
                output.push(
                    clone(
                        item,
                        seen
                    )
                );
            }

            return output;
        }

        if (
            value instanceof
                Map
        ) {
            const output =
                new Map();

            seen.set(
                value,
                output
            );

            for (
                const [
                    key,
                    item
                ] of value
            ) {
                output.set(
                    clone(
                        key,
                        seen
                    ),
                    clone(
                        item,
                        seen
                    )
                );
            }

            return output;
        }

        if (
            value instanceof
                Set
        ) {
            const output =
                new Set();

            seen.set(
                value,
                output
            );

            for (
                const item of
                value
            ) {
                output.add(
                    clone(
                        item,
                        seen
                    )
                );
            }

            return output;
        }

        const output =
            {};

        seen.set(
            value,
            output
        );

        for (
            const [
                key,
                item
            ] of Object.entries(
                value
            )
        ) {
            output[
                key
            ] =
                clone(
                    item,
                    seen
                );
        }

        return output;
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

    function mergeAbortSignals(
        ...signals
    ) {
        const active =
            signals.filter(
                Boolean
            );

        if (!active.length) {
            return null;
        }

        if (
            active.length ===
                1
        ) {
            return active[0];
        }

        if (
            typeof AbortSignal.any ===
                "function"
        ) {
            return AbortSignal.any(
                active
            );
        }

        const controller =
            new AbortController();

        for (
            const signal of
            active
        ) {
            const abort =
                () => {
                    if (
                        !controller.signal.aborted
                    ) {
                        try {
                            controller.abort(
                                signal.reason
                            );
                        } catch (_error) {
                            controller.abort();
                        }
                    }
                };

            if (
                signal.aborted
            ) {
                abort();

                break;
            }

            signal.addEventListener(
                "abort",
                abort,
                {
                    once:
                        true
                }
            );
        }

        return controller.signal;
    }

    function freeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.freeze(value);
        Object.values(value).forEach(freeze);
        return value;
    }

    function finite(value, fallback = 0) {
        if (typeof value === "string" && value.trim() === "") return fallback;
        const number = Number(value);
        return Number.isFinite(number) ? number : fallback;
    }

    function integer(value, fallback = 0) {
        return Math.trunc(finite(value, fallback));
    }

    function clamp(value, minimum, maximum) {
        return Math.min(maximum, Math.max(minimum, value));
    }

    function timestamp(value) {
        if (!value) return null;
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }

    function nowISO() {
        return new Date().toISOString();
    }


    function firstFinite(...values) {
        for (const value of values) {
            const number = Number(value);
            if (Number.isFinite(number)) return number;
        }
        return null;
    }

    function collectionLength(value) {
        if (Array.isArray(value)) return value.length;
        if (!isObject(value)) return null;

        const direct = firstFinite(
            value.count,
            value.total,
            value.total_count,
            value.record_count,
            value.records_count,
            value.species_count,
            value.statistics?.species,
            value.statistics?.records_archived,
            value.summary?.species,
            value.summary?.records_archived,
            value.meta?.count,
            value.meta?.total
        );
        if (direct !== null) return direct;

        for (const key of ["records", "items", "results", "data", "species"]) {
            if (Array.isArray(value[key])) return value[key].length;
        }

        return null;
    }

    function statisticsFromFallback(payload, sourceName = "fallback") {
        const count = collectionLength(payload);
        if (count === null) {
            throw new TypeError(`Unable to determine a record count from ${sourceName}.`);
        }

        const generatedAt = timestamp(
            payload?.generated_at ||
            payload?.last_updated ||
            payload?.updated_at ||
            payload?.created_at ||
            payload?.meta?.generated_at
        ) || nowISO();

        return {
            species: count,
            records_archived: count,
            rank_counts: {
                species: count
            },
            last_updated: generatedAt,
            count_method: sourceName
        };
    }

    function normalizeKey(value) {
        return String(value || "")
            .trim()
            .toLowerCase()
            .replace(/[\s-]+/g, "_")
            .replace(/[^a-z0-9_]/g, "");
    }

    function canonicalKey(value) {
        const key = normalizeKey(value);
        return VALUE_ALIASES[key] || RANK_ALIASES[key] || key;
    }

    function emit(context, name, detail = {}) {
        try {
            if (context.events && typeof context.events.emit === "function") {
                context.events.emit(name, detail);
            } else if (context.events && typeof context.events.dispatchEvent === "function") {
                context.events.dispatchEvent(new CustomEvent(name, { detail }));
            }
        } catch (error) {
            /* Event observers must not break statistics collection. */
        }

        try {
            document.dispatchEvent(new CustomEvent(`speciedex:${name}`, { detail }));
        } catch (error) {
            /* Ignore unavailable DOM event implementations. */
        }
    }

    function setState(context, path, value) {
        const state = context.state || context.stateStore || context.services?.get?.("state");
        if (!state || typeof state.set !== "function") return;
        try {
            state.set(path, clone(value), {
                source: "terminal-stats",
                history: false,
                persist: false
            });
        } catch (error) {
            try { state.set(path, clone(value)); } catch (ignored) { /* optional */ }
        }
    }

    function getState(context, path, fallback) {
        const state = context.state || context.stateStore || context.services?.get?.("state");
        if (!state || typeof state.get !== "function") return fallback;
        try { return state.get(path, fallback); } catch (error) { return fallback; }
    }

    function objectNumbers(source) {
        const result = {};
        if (!isObject(source)) return result;
        for (const [rawKey, rawValue] of Object.entries(source)) {
            const key = canonicalKey(rawKey);
            const value = Number(rawValue);
            if (key && Number.isFinite(value)) result[key] = value;
        }
        return result;
    }

    function normalizeStatistics(payload) {
        const source = isObject(payload?.statistics) ? payload.statistics : payload;
        if (!isObject(source)) throw new TypeError("Statistics payload must be an object.");

        const result = {};
        for (const [rawKey, rawValue] of Object.entries(source)) {
            const key = canonicalKey(rawKey);
            if (!key || key === "rank_counts") continue;
            if (typeof rawValue === "number" || /^-?\d+(\.\d+)?$/.test(String(rawValue || ""))) {
                result[key] = finite(rawValue);
            } else if (key.includes("updated") || key.endsWith("_at")) {
                result[key] = timestamp(rawValue) || rawValue || null;
            } else if (["count_method", "source", "version"].includes(key)) {
                result[key] = rawValue;
            }
        }

        const ranks = objectNumbers(source.rank_counts);
        for (const [key, value] of Object.entries(ranks)) {
            if (!(key in result)) result[key] = value;
        }

        result.rank_counts = ranks;
        result.last_updated = timestamp(
            source.last_updated || source.updated || source.generated_at || source.modified_at
        );
        result.count_method = source.count_method || null;

        return result;
    }

    function normalizeHistory(payload) {
        const rows = Array.isArray(payload)
            ? payload
            : Array.isArray(payload?.history)
                ? payload.history
                : [];

        return rows.map((row, index) => {
            if (!isObject(row)) return null;
            const normalized = normalizeStatistics(row);
            normalized.timestamp = timestamp(
                row.timestamp || row.last_updated || row.generated_at || row.created_at
            );
            normalized.source = row.source || null;
            normalized._index = index;
            return normalized;
        }).filter(Boolean).sort((a, b) => {
            const left = a.timestamp ? new Date(a.timestamp).getTime() : 0;
            const right = b.timestamp ? new Date(b.timestamp).getTime() : 0;
            return left - right || a._index - b._index;
        }).map(row => {
            delete row._index;
            return row;
        });
    }

    function normalizeProvider(row) {
        const provider = String(row?.provider || row?.name || row?.id || "unknown").trim();
        return {
            provider,
            fetched: integer(row?.fetched),
            created: integer(row?.created),
            matched: integer(row?.matched),
            revised: integer(row?.revised),
            conflicted: integer(row?.conflicted),
            rejected: integer(row?.rejected),
            requests: integer(row?.requests),
            latency_ms: finite(row?.latency_ms ?? row?.latency, 0),
            enabled: row?.enabled === undefined ? null : Boolean(row.enabled),
            eligible: row?.eligible === undefined ? null : Boolean(row.eligible),
            error: row?.error ? String(row.error) : null,
            success_rate: 0,
            acceptance_rate: 0
        };
    }

    function normalizeSources(payload) {
        const source = isObject(payload) ? payload : {};
        const providers = Array.isArray(source.providers)
            ? source.providers.map(normalizeProvider)
            : [];
        const skipped = Array.isArray(source.skipped)
            ? source.skipped.map(item => ({
                provider: String(item?.provider || item?.name || "unknown"),
                reason: String(item?.reason || "unspecified")
            }))
            : [];

        providers.forEach(provider => {
            const accepted = provider.created + provider.matched + provider.revised;
            provider.success_rate = provider.requests > 0 && !provider.error ? 1 : 0;
            provider.acceptance_rate = provider.fetched > 0
                ? accepted / provider.fetched
                : 0;
        });

        return {
            generated_at: timestamp(source.generated_at || source.last_updated),
            providers,
            skipped
        };
    }

    function sum(rows, key) {
        return rows.reduce((total, row) => total + finite(row?.[key]), 0);
    }

    function percentage(numerator, denominator) {
        return denominator > 0 ? numerator / denominator : 0;
    }

    function round(value, digits = 4) {
        if (!Number.isFinite(value)) return 0;
        const factor = 10 ** digits;
        return Math.round(value * factor) / factor;
    }

    function ageMilliseconds(value) {
        const iso = timestamp(value);
        return iso ? Math.max(0, Date.now() - new Date(iso).getTime()) : null;
    }

    function compareValues(current, previous) {
        const currentValue = finite(current);
        const previousValue = finite(previous);
        const delta = currentValue - previousValue;
        return {
            current: currentValue,
            previous: previousValue,
            delta,
            percent: previousValue === 0
                ? (currentValue === 0 ? 0 : null)
                : round((delta / Math.abs(previousValue)) * 100, 4)
        };
    }

    function dateDistanceDays(left, right) {
        const a = timestamp(left);
        const b = timestamp(right);
        if (!a || !b) return null;
        return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86400000;
    }

    function computeTrend(history, current, key, windowSize = 7) {
        const candidates = history
            .filter(row => Number.isFinite(Number(row[key])))
            .slice(-Math.max(1, windowSize));

        if (Number.isFinite(Number(current[key]))) {
            const currentTime = current.last_updated || nowISO();
            if (!candidates.length || candidates[candidates.length - 1].timestamp !== currentTime) {
                candidates.push({ timestamp: currentTime, [key]: finite(current[key]) });
            }
        }

        if (candidates.length < 2) {
            return {
                key,
                points: candidates.length,
                first: candidates[0]?.[key] ?? null,
                last: candidates[0]?.[key] ?? null,
                delta: 0,
                percent: 0,
                per_day: null,
                direction: "flat"
            };
        }

        const first = candidates[0];
        const last = candidates[candidates.length - 1];
        const comparison = compareValues(last[key], first[key]);
        const days = dateDistanceDays(last.timestamp, first.timestamp);
        return {
            key,
            points: candidates.length,
            first: comparison.previous,
            last: comparison.current,
            delta: comparison.delta,
            percent: comparison.percent,
            per_day: days && days > 0 ? round(comparison.delta / days, 4) : null,
            direction: comparison.delta > 0 ? "up" : comparison.delta < 0 ? "down" : "flat"
        };
    }

    function providerSummary(sources) {
        const providers = sources.providers || [];
        const errored = providers.filter(item => item.error);
        const active = providers.filter(item => item.fetched > 0 || item.created > 0 || item.requests > 0);
        const fetched = sum(providers, "fetched");
        const accepted = sum(providers, "created") + sum(providers, "matched") + sum(providers, "revised");

        return {
            total: providers.length,
            active: active.length,
            healthy: providers.length - errored.length,
            errored: errored.length,
            skipped: sources.skipped?.length || 0,
            fetched,
            created: sum(providers, "created"),
            matched: sum(providers, "matched"),
            revised: sum(providers, "revised"),
            conflicted: sum(providers, "conflicted"),
            rejected: sum(providers, "rejected"),
            requests: sum(providers, "requests"),
            acceptance_rate: round(percentage(accepted, fetched), 6),
            request_error_rate: round(percentage(errored.length, providers.length), 6)
        };
    }

    function arrayFromPayload(
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

        for (
            const key of
            [
                "records",
                "items",
                "results",
                "data",
                "species",
                "providers",
                "history"
            ]
        ) {
            if (
                Array.isArray(
                    payload[
                        key
                    ]
                )
            ) {
                return payload[
                    key
                ];
            }
        }

        return [];
    }

    function rankCountsFromRecords(
        records
    ) {
        const ranks =
            {};

        for (
            const record of
            records
        ) {
            const rank =
                canonicalKey(
                    record?.rank ||
                    record?.taxon_rank ||
                    record?.taxonRank ||
                    "unranked"
                );

            ranks[
                rank ||
                "unranked"
            ] =
                (
                    ranks[
                        rank ||
                        "unranked"
                    ] ||
                    0
                ) +
                1;
        }

        return ranks;
    }

    class StatisticsService extends EventTarget {
        constructor(context, options = {}) {
            super();
            this.context = context;
            this.options = {
                ttl: clamp(integer(options.ttl, DEFAULT_TTL), 0, 3600000),
                urls: { ...DEFAULT_URLS, ...(options.urls || {}) },
                apiPath:
                    options.apiPath ||
                    null,

                historyMaximum:
                    clamp(
                        integer(
                            options.historyMaximum,
                            DEFAULT_HISTORY_MAXIMUM
                        ),
                        1,
                        100000
                    ),

                providerMaximum:
                    clamp(
                        integer(
                            options.providerMaximum,
                            DEFAULT_PROVIDER_MAXIMUM
                        ),
                        1,
                        100000
                    )
            };
            this.cache = null;
            this.cacheTime = 0;
            this.pending = null;
            this.lastError = null;
            this.destroyed = false;
            this.controller =
                new AbortController();

            this.requestSerial =
                0;

            this.activeRequest =
                null;

            this.publishing =
                false;

            this.metrics = {
                loads:
                    0,
                cacheHits:
                    0,
                apiLoads:
                    0,
                libraryLoads:
                    0,
                indexLoads:
                    0,
                staticLoads:
                    0,
                fallbacks:
                    0,
                failures:
                    0,
                cancelled:
                    0,
                publishes:
                    0
            };
        }

        assertActive() {
            if (
                this.destroyed
            ) {
                throw new Error(
                    "Statistics service has been destroyed."
                );
            }
        }

        resolveLibrary() {
            return (
                this.context.library ||
                this.context.services?.get?.(
                    "library"
                ) ||
                null
            );
        }

        resolveIndex() {
            return (
                this.context.index ||
                this.context.services?.get?.(
                    "index"
                ) ||
                null
            );
        }

        resolveProviderManager() {
            return (
                this.context.providerManager ||
                this.context.services?.get?.(
                    "provider-manager"
                ) ||
                this.context.services?.get?.(
                    "providers"
                ) ||
                null
            );
        }

        resolveProviderHealth() {
            return (
                this.context.providerHealth ||
                this.context.services?.get?.(
                    "provider-health"
                ) ||
                null
            );
        }

        configure(options = {}) {
            if (options.ttl !== undefined) {
                this.options.ttl = clamp(integer(options.ttl, DEFAULT_TTL), 0, 3600000);
            }
            if (isObject(options.urls)) {
                this.options.urls = { ...this.options.urls, ...options.urls };
            }
            if (options.apiPath !== undefined) this.options.apiPath = options.apiPath || null;
            return this;
        }

        isFresh() {
            return Boolean(this.cache) && Date.now() - this.cacheTime <= this.options.ttl;
        }

        async fetchJSON(url, signal) {
            if (!url) throw new Error("Statistics URL is not configured.");
            const response = await fetch(url, {
                method: "GET",
                headers: { Accept: "application/json" },
                credentials: "same-origin",
                cache: "no-store",
                signal
            });
            if (!response.ok) throw new Error(`Statistics request failed with HTTP ${response.status}: ${url}`);
            return response.json();
        }

        async fetchFirstJSON(candidates, signal) {
            const errors = [];

            for (const candidate of candidates) {
                if (!candidate?.url) continue;
                try {
                    return {
                        name: candidate.name,
                        url: candidate.url,
                        payload: await this.fetchJSON(candidate.url, signal)
                    };
                } catch (error) {
                    if (error?.name === "AbortError") throw error;
                    errors.push({
                        name: candidate.name,
                        url: candidate.url,
                        message: String(error?.message || error)
                    });
                }
            }

            const failure = new Error("No statistics or database index source could be loaded.");
            failure.sources = errors;
            throw failure;
        }

        statisticsFromRecords(
            records,
            source =
                "library"
        ) {
            const rankCounts =
                rankCountsFromRecords(
                    records
                );

            const species =
                firstFinite(
                    rankCounts.species,
                    records.length
                ) ||
                0;

            return {
                statistics: {
                    species,
                    records_archived:
                        records.length,
                    rank_counts:
                        rankCounts,
                    last_updated:
                        nowISO(),
                    count_method:
                        source
                },
                history:
                    [],
                sources:
                    {},
                warnings: []
            };
        }

        loadLibrary() {
            const library =
                this.resolveLibrary();

            if (!library?.get) {
                return null;
            }

            const statisticsCollections = [
                "statistics",
                "dataset-statistics",
                "canonical-statistics",
                "stats"
            ];

            for (
                const collection of
                statisticsCollections
            ) {
                try {
                    const value =
                        library.get(
                            collection
                        );

                    if (
                        isObject(
                            value
                        ) &&
                        (
                            isObject(
                                value.statistics
                            ) ||
                            firstFinite(
                                value.species,
                                value.records_archived,
                                value.records
                            ) !==
                                null
                        )
                    ) {
                        return {
                            statistics:
                                value.statistics ||
                                value,
                            history:
                                library.get(
                                    "statistics-history"
                                ) ||
                                [],
                            sources:
                                library.get(
                                    "statistics-sources"
                                ) ||
                                {},
                            warnings:
                                [],
                            origin:
                                `library:${collection}`
                        };
                    }
                } catch (_error) {
                    /* Continue through candidates. */
                }
            }

            const recordCollections = [
                "records",
                "canonical-records",
                "species",
                "taxa"
            ];

            for (
                const collection of
                recordCollections
            ) {
                try {
                    const value =
                        library.get(
                            collection
                        );

                    const records =
                        Array.isArray(
                            value
                        )
                            ? value
                            : arrayFromPayload(
                                value
                            );

                    if (records.length) {
                        return {
                            ...this.statisticsFromRecords(
                                records,
                                `library:${collection}`
                            ),
                            origin:
                                `library:${collection}`
                        };
                    }
                } catch (_error) {
                    /* Continue through candidates. */
                }
            }

            return null;
        }

        async loadIndex(
            signal
        ) {
            const index =
                this.resolveIndex();

            if (!index) {
                return null;
            }

            if (
                signal?.aborted
            ) {
                throw new DOMException(
                    "Statistics load cancelled.",
                    "AbortError"
                );
            }

            if (
                typeof index.status ===
                    "function"
            ) {
                const status =
                    await index.status();

                const count =
                    firstFinite(
                        status?.documents,
                        status?.records,
                        status?.count,
                        status?.total
                    );

                if (
                    count !==
                        null &&
                    count >
                        0
                ) {
                    return {
                        statistics: {
                            species:
                                firstFinite(
                                    status.species,
                                    count
                                ),
                            records_archived:
                                count,
                            rank_counts:
                                status.rank_counts ||
                                {},
                            last_updated:
                                timestamp(
                                    status.updatedAt ||
                                    status.updated_at
                                ) ||
                                nowISO(),
                            count_method:
                                "index:status"
                        },
                        history:
                            [],
                        sources:
                            {},
                        warnings:
                            [],
                        origin:
                            "index:status"
                    };
                }
            }

            if (
                Array.isArray(
                    index.records
                ) &&
                index.records.length
            ) {
                return {
                    ...this.statisticsFromRecords(
                        index.records,
                        "index:records"
                    ),
                    origin:
                        "index:records"
                };
            }

            return null;
        }

        liveProviderSources() {
            const manager =
                this.resolveProviderManager();

            const health =
                this.resolveProviderHealth();

            let providers =
                [];

            try {
                providers =
                    manager?.list?.({
                        redact:
                            true
                    }) ||
                    [];
            } catch (_error) {
                providers =
                    [];
            }

            if (
                !Array.isArray(
                    providers
                )
            ) {
                providers =
                    [];
            }

            return {
                generated_at:
                    nowISO(),

                providers:
                    providers
                        .slice(
                            0,
                            this.options.providerMaximum
                        )
                        .map(
                            provider => {
                                let providerHealth =
                                    null;

                                try {
                                    providerHealth =
                                        health?.get?.(
                                            provider.id
                                        ) ||
                                        health?.evaluate?.(
                                            provider.id
                                        ) ||
                                        null;
                                } catch (_error) {
                                    providerHealth =
                                        null;
                                }

                                return {
                                    provider:
                                        provider.id ||
                                        provider.name,
                                    fetched:
                                        finite(
                                            provider.statistics?.fetched
                                        ),
                                    created:
                                        finite(
                                            provider.statistics?.created
                                        ),
                                    matched:
                                        finite(
                                            provider.statistics?.matched
                                        ),
                                    revised:
                                        finite(
                                            provider.statistics?.revised
                                        ),
                                    conflicted:
                                        finite(
                                            provider.statistics?.conflicted
                                        ),
                                    rejected:
                                        finite(
                                            provider.statistics?.rejected
                                        ),
                                    requests:
                                        finite(
                                            provider.statistics?.requests
                                        ),
                                    latency_ms:
                                        finite(
                                            providerHealth?.latency ??
                                            provider.statistics?.latency
                                        ),
                                    enabled:
                                        provider.enabled,
                                    eligible:
                                        provider.eligible,
                                    error:
                                        providerHealth?.state ===
                                            "critical"
                                            ? providerHealth.reason ||
                                                "Provider health is critical."
                                            : null
                                };
                            }
                        ),

                skipped:
                    []
            };
        }

        async loadAPI(parameters, signal) {
            if (!this.options.apiPath || !this.context.api?.get) return null;
            try {
                return await this.context.api.get(this.options.apiPath, parameters, { signal });
            } catch (error) {
                return null;
            }
        }

        async loadFiles(signal) {
            const primary = await this.fetchFirstJSON([
                { name: "statistics", url: this.options.urls.statistics },
                { name: "species-index", url: this.options.urls.speciesIndex },
                { name: "browser-manifest", url: this.options.urls.browserManifest },
                { name: "database-manifest", url: this.options.urls.databaseManifest }
            ], signal);

            const optional = await Promise.allSettled([
                this.fetchJSON(this.options.urls.history, signal),
                this.fetchJSON(this.options.urls.sources, signal)
            ]);

            const [history, sources] = optional;
            let statistics = primary.payload;

            if (primary.name !== "statistics") {
                statistics = statisticsFromFallback(primary.payload, primary.name);
            }

            const warnings = optional
                .map((entry, index) => entry.status === "rejected"
                    ? {
                        source: ["history", "sources"][index],
                        error: String(entry.reason?.message || entry.reason)
                    }
                    : null)
                .filter(Boolean);

            if (primary.name !== "statistics") {
                warnings.unshift({
                    source: "statistics",
                    error: `Canonical statistics file unavailable; using ${primary.name}: ${primary.url}`
                });
            }

            this.metrics.staticLoads +=
                1;

            return {
                statistics,
                history:
                    history.status ===
                        "fulfilled"
                        ? arrayFromPayload(
                            history.value
                        ).slice(
                            -this.options.historyMaximum
                        )
                        : [],
                sources:
                    sources.status ===
                        "fulfilled"
                        ? sources.value
                        : {},
                warnings
            };
        }

        buildDataset(raw, origin = "static") {
            const statistics = normalizeStatistics(raw.statistics || raw);
            const history = normalizeHistory(raw.history || []);
            const liveSources =
                this.liveProviderSources();

            const sourcePayload =
                raw.sources &&
                (
                    Array.isArray(
                        raw.sources.providers
                    ) &&
                    raw.sources.providers.length
                )
                    ? raw.sources
                    : liveSources;

            const sources =
                normalizeSources(
                    sourcePayload
                );

            sources.providers =
                sources.providers.slice(
                    0,
                    this.options.providerMaximum
                );

            const providers =
                providerSummary(
                    sources
                );

            if (!Number.isFinite(Number(statistics.providers))) statistics.providers = providers.total;
            if (!Number.isFinite(Number(statistics.enabled_providers))) {
                statistics.enabled_providers = sources.providers.filter(item => item.enabled === true).length;
            }
            if (!Number.isFinite(Number(statistics.eligible_providers))) {
                statistics.eligible_providers = sources.providers.filter(item => item.eligible === true).length;
            }

            const dataset = {
                version: VERSION,
                generated_at: nowISO(),
                origin,
                statistics,
                history,
                sources,
                providers,
                warnings: Array.isArray(raw.warnings) ? raw.warnings : []
            };

            dataset.summary = this.summarizeDataset(dataset);
            dataset.integrity = this.validateDataset(dataset);
            return freeze(dataset);
        }

        summarizeDataset(dataset) {
            const stats = dataset.statistics;
            const latestHistory = dataset.history[dataset.history.length - 1] || null;
            const totals = {};
            PRIMARY_KEYS.forEach(key => {
                if (Number.isFinite(Number(stats[key]))) totals[key] = finite(stats[key]);
            });

            return {
                ...totals,
                last_updated: stats.last_updated,
                age_ms: ageMilliseconds(stats.last_updated),
                count_method: stats.count_method,
                rank_total: Object.values(stats.rank_counts || {}).reduce((total, value) => total + finite(value), 0),
                provider_health: dataset.providers,
                history_points: dataset.history.length,
                latest_history_timestamp: latestHistory?.timestamp || null,
                warnings: dataset.warnings.length
            };
        }

        validateDataset(dataset) {
            const errors = [];
            const warnings = [];
            const stats = dataset.statistics;

            for (const key of PRIMARY_KEYS) {
                if (stats[key] !== undefined && finite(stats[key]) < 0) {
                    errors.push({ key, message: "Statistic cannot be negative." });
                }
            }

            if (!stats.last_updated) warnings.push({ key: "last_updated", message: "No valid update timestamp is available." });
            if (!Object.keys(stats.rank_counts || {}).length) warnings.push({ key: "rank_counts", message: "No rank counts are available." });
            if (!dataset.history.length) warnings.push({ key: "history", message: "No statistics history is available." });
            if (!dataset.sources.providers.length) warnings.push({ key: "providers", message: "No provider source metrics are available." });

            return {
                valid: errors.length === 0,
                errors,
                warnings,
                checked_at: nowISO()
            };
        }

        publish(
            dataset
        ) {
            if (
                this.publishing ||
                this.destroyed
            ) {
                return false;
            }

            this.publishing =
                true;

            try {
                setState(
                    this.context,
                    "statistics",
                    {
                        ...dataset.statistics,
                        summary:
                            dataset.summary,
                        providers:
                            dataset.providers,
                        integrity:
                            dataset.integrity,
                        historyCount:
                            dataset.history.length,
                        sourceGeneratedAt:
                            dataset.sources.generated_at,
                        loadedAt:
                            dataset.generated_at,
                        loading:
                            false,
                        error:
                            null
                    }
                );

                emit(
                    this.context,
                    "stats:loaded",
                    dataset.summary
                );

                this.dispatchEvent(
                    new CustomEvent(
                        "loaded",
                        {
                            detail:
                                dataset
                        }
                    )
                );

                this.metrics.publishes +=
                    1;

                return true;
            } finally {
                this.publishing =
                    false;
            }
        }

        async load(
            parameters = {}
        ) {
            this.assertActive();

            const refresh =
                Boolean(
                    parameters.refresh ||
                    parameters.force
                );

            if (
                !refresh &&
                this.isFresh()
            ) {
                this.metrics.cacheHits +=
                    1;

                return this.cache;
            }

            if (
                !refresh &&
                this.pending
            ) {
                return this.pending;
            }

            if (
                refresh &&
                this.activeRequest
            ) {
                try {
                    this.activeRequest.controller.abort(
                        "superseded"
                    );
                } catch (_error) {
                    this.activeRequest.controller.abort();
                }
            }

            const requestID =
                ++this.requestSerial;

            const controller =
                new AbortController();

            const signal =
                mergeAbortSignals(
                    controller.signal,
                    parameters.signal,
                    this.controller.signal
                );

            this.activeRequest = {
                id:
                    requestID,
                controller,
                startedAt:
                    Date.now()
            };

            this.metrics.loads +=
                1;

            this.pending =
                (async () => {
                    setState(
                        this.context,
                        "statistics.loading",
                        true
                    );

                    emit(
                        this.context,
                        "stats:loading",
                        {
                            refresh,
                            requestID
                        }
                    );

                    try {
                        let raw =
                            null;

                        let origin =
                            null;

                        const apiPayload =
                            await this.loadAPI(
                                parameters,
                                signal
                            );

                        if (apiPayload) {
                            raw =
                                apiPayload;

                            origin =
                                "api";

                            this.metrics.apiLoads +=
                                1;
                        }

                        if (!raw) {
                            const libraryPayload =
                                this.loadLibrary();

                            if (libraryPayload) {
                                raw =
                                    libraryPayload;

                                origin =
                                    libraryPayload.origin ||
                                    "library";

                                this.metrics.libraryLoads +=
                                    1;
                            }
                        }

                        if (!raw) {
                            const indexPayload =
                                await this.loadIndex(
                                    signal
                                );

                            if (indexPayload) {
                                raw =
                                    indexPayload;

                                origin =
                                    indexPayload.origin ||
                                    "index";

                                this.metrics.indexLoads +=
                                    1;
                            }
                        }

                        if (!raw) {
                            raw =
                                await this.loadFiles(
                                    signal
                                );

                            origin =
                                "static";

                            this.metrics.fallbacks +=
                                1;
                        }

                        if (
                            requestID !==
                            this.requestSerial
                        ) {
                            throw new DOMException(
                                "Statistics request superseded.",
                                "AbortError"
                            );
                        }

                        const dataset =
                            this.buildDataset(
                                raw,
                                origin
                            );

                        this.cache =
                            dataset;

                        this.cacheTime =
                            Date.now();

                        this.lastError =
                            null;

                        this.publish(
                            dataset
                        );

                        return dataset;
                    } catch (error) {
                        if (
                            isAbortError(
                                error
                            )
                        ) {
                            this.metrics.cancelled +=
                                1;
                        } else {
                            this.metrics.failures +=
                                1;

                            this.lastError =
                                error;

                            setState(
                                this.context,
                                "statistics.error",
                                {
                                    message:
                                        error.message,
                                    timestamp:
                                        nowISO()
                                }
                            );

                            emit(
                                this.context,
                                "stats:error",
                                {
                                    error
                                }
                            );
                        }

                        throw error;
                    } finally {
                        if (
                            requestID ===
                            this.requestSerial
                        ) {
                            setState(
                                this.context,
                                "statistics.loading",
                                false
                            );
                        }

                        if (
                            this.activeRequest?.id ===
                            requestID
                        ) {
                            this.activeRequest =
                                null;
                        }

                        if (
                            this.pending
                        ) {
                            this.pending =
                                null;
                        }
                    }
                })();

            return this.pending;
        }

        clear() {
            if (
                this.destroyed
            ) {
                return false;
            }

            this.cache = null;
            this.cacheTime = 0;
            this.lastError = null;
            setState(this.context, "statistics.cacheClearedAt", nowISO());
            emit(this.context, "stats:cache-cleared", {});
            return true;
        }

        async summary(parameters = {}) {
            const dataset = await this.load(parameters);
            return clone(dataset.summary);
        }

        async getRecordCount(parameters = {}) {
            const dataset = await this.load(parameters);
            return firstFinite(
                dataset.statistics.records_archived,
                dataset.statistics.species,
                dataset.summary.records_archived,
                dataset.summary.species,
                collectionLength(dataset)
            ) || 0;
        }

        async getSpeciesCount(parameters = {}) {
            const dataset = await this.load(parameters);
            return firstFinite(
                dataset.statistics.species,
                dataset.statistics.rank_counts?.species,
                dataset.summary.species
            ) || 0;
        }

        async getProviderCount(parameters = {}) {
            const dataset = await this.load(parameters);
            return firstFinite(
                dataset.statistics.providers,
                dataset.providers.total,
                dataset.sources.providers?.length
            ) || 0;
        }

        async ranks(parameters = {}) {
            const dataset = await this.load(parameters);
            const ranks = Object.entries(dataset.statistics.rank_counts || {})
                .map(([rank, count]) => ({ rank, count: finite(count) }))
                .sort((a, b) => b.count - a.count || a.rank.localeCompare(b.rank));
            return {
                generated_at: dataset.generated_at,
                last_updated: dataset.statistics.last_updated,
                total: ranks.reduce((value, row) => value + row.count, 0),
                ranks
            };
        }

        async providers(parameters = {}) {
            const dataset = await this.load(parameters);
            const query = String(parameters.query || "").trim().toLowerCase();
            const includeErrors = parameters.errors === true;
            const sort = normalizeKey(parameters.sort || "fetched");
            const direction = parameters.direction === "asc" ? 1 : -1;
            const limit = clamp(integer(parameters.limit, DEFAULT_PROVIDER_LIMIT), 1, 1000);

            let rows = dataset.sources.providers.slice();
            if (query) rows = rows.filter(row => row.provider.toLowerCase().includes(query));
            if (includeErrors) rows = rows.filter(row => row.error);
            rows.sort((a, b) => {
                const left = a[sort];
                const right = b[sort];
                if (typeof left === "number" || typeof right === "number") {
                    return (finite(left) - finite(right)) * direction || a.provider.localeCompare(b.provider);
                }
                return String(left || "").localeCompare(String(right || "")) * direction;
            });

            return {
                generated_at: dataset.sources.generated_at,
                summary: clone(dataset.providers),
                count: Math.min(rows.length, limit),
                total_matching: rows.length,
                providers: clone(rows.slice(0, limit)),
                skipped: parameters.includeSkipped ? clone(dataset.sources.skipped) : undefined
            };
        }

        async history(parameters = {}) {
            const dataset = await this.load(parameters);
            const limit = clamp(integer(parameters.limit, DEFAULT_HISTORY_LIMIT), 1, 1000);
            const key = parameters.key ? canonicalKey(parameters.key) : null;
            let rows = dataset.history.slice(-limit);
            if (key) {
                rows = rows.map(row => ({
                    timestamp: row.timestamp,
                    source: row.source,
                    [key]: row[key] ?? null
                }));
            }
            return {
                count: rows.length,
                total: dataset.history.length,
                key,
                history: clone(rows)
            };
        }

        async trends(parameters = {}) {
            const dataset = await this.load(parameters);
            const windowSize = clamp(integer(parameters.window, 7), 2, 365);
            const requested = parameters.keys
                ? String(parameters.keys).split(",").map(canonicalKey).filter(Boolean)
                : ["species", "genera", "families", "records_archived", "source_assertions"];
            const trends = {};
            requested.forEach(key => {
                trends[key] = computeTrend(dataset.history, dataset.statistics, key, windowSize);
            });
            return {
                window: windowSize,
                generated_at: dataset.generated_at,
                trends
            };
        }

        async compare(parameters = {}) {
            const dataset = await this.load(parameters);
            const index = integer(parameters.index, -1);
            const history = dataset.history;
            const previous = index < 0
                ? history[history.length + index]
                : history[index];
            if (!previous) throw new RangeError("Requested historical statistics snapshot does not exist.");

            const keys = parameters.keys
                ? String(parameters.keys).split(",").map(canonicalKey).filter(Boolean)
                : PRIMARY_KEYS;
            const comparison = {};
            keys.forEach(key => {
                comparison[key] = compareValues(dataset.statistics[key], previous[key]);
            });
            return {
                current_timestamp: dataset.statistics.last_updated,
                previous_timestamp: previous.timestamp,
                comparison
            };
        }

        stateMetrics() {
            const state = this.context.state || this.context.stateStore || this.context.services?.get?.("state");
            const metrics = state && typeof state.metrics === "function" ? state.metrics() : null;
            return {
                collected_at: nowISO(),
                store: metrics || {
                    available: Boolean(state),
                    roots: isObject(state?.tree) ? Object.keys(state.tree).length : null
                },
                runtime: clone(getState(this.context, "runtime", {})),
                loading: clone(getState(this.context, "loading", {})),
                search: clone(getState(this.context, "search", {})),
                scan: clone(getState(this.context, "scan", {})),
                stream: clone(getState(this.context, "stream", {})),
                index: clone(getState(this.context, "index", {}))
            };
        }

        async run(parameters = {}) {
            emit(this.context, "stats:run", parameters);
            const view = normalizeKey(parameters.view || parameters.command || "summary");
            switch (view) {
                case "summary": return this.summary(parameters);
                case "count":
                case "records": return { records: await this.getRecordCount(parameters) };
                case "species-count": return { species: await this.getSpeciesCount(parameters) };
                case "provider-count": return { providers: await this.getProviderCount(parameters) };
                case "all": return clone(await this.load(parameters));
                case "ranks":
                case "rank": return this.ranks(parameters);
                case "providers":
                case "provider": return this.providers(parameters);
                case "history": return this.history(parameters);
                case "trends":
                case "trend": return this.trends(parameters);
                case "compare":
                case "delta": return this.compare(parameters);
                case "state":
                case "runtime": return this.stateMetrics();
                case "health":
                case "integrity": return clone((await this.load(parameters)).integrity);
                case "refresh": return clone(await this.load({ ...parameters, refresh: true }));
                case "clear": return { cleared: this.clear() };
                default: throw new Error(`Unknown statistics view: ${view}`);
            }
        }

        status() {
            return {
                name: "stats",
                version: VERSION,
                cached: Boolean(this.cache),
                fresh: this.isFresh(),
                cache_age_ms: this.cache ? Date.now() - this.cacheTime : null,
                ttl_ms: this.options.ttl,
                loading: Boolean(this.pending),
                error: this.lastError ? this.lastError.message : null,
                active_request:
                    this.activeRequest
                        ? {
                            id:
                                this.activeRequest.id,
                            started_at:
                                new Date(
                                    this.activeRequest.startedAt
                                ).toISOString()
                        }
                        : null,
                origin:
                    this.cache?.origin ||
                    null,
                metrics: {
                    ...this.metrics
                },
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

            if (
                this.activeRequest
            ) {
                try {
                    this.activeRequest.controller.abort(
                        "destroyed"
                    );
                } catch (_error) {
                    this.activeRequest.controller.abort();
                }
            }

            try {
                this.controller.abort(
                    "destroyed"
                );
            } catch (_error) {
                this.controller.abort();
            }

            this.pending =
                null;

            this.cache =
                null;

            this.cacheTime =
                0;

            this.lastError =
                null;

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

            this.destroyed =
                true;

            this.dispatchEvent(
                new CustomEvent(
                    "destroy",
                    {
                        detail: {
                            version:
                                VERSION
                        }
                    }
                )
            );

            return true;
        }

    }

    function parseArguments(args = []) {
        const tokens = Array.isArray(args) ? args.slice() : [];
        const parameters = { view: "summary" };
        if (tokens[0] && !String(tokens[0]).startsWith("-")) parameters.view = tokens.shift();

        for (let index = 0; index < tokens.length; index += 1) {
            const token = String(tokens[index]);
            if (!token.startsWith("-")) {
                if (!parameters.query) parameters.query = token;
                continue;
            }

            const match = token.match(/^--?([^=]+)(?:=(.*))?$/);
            if (!match) continue;
            const key = normalizeKey(match[1]);
            let value = match[2];
            if (value === undefined && tokens[index + 1] && !String(tokens[index + 1]).startsWith("-")) {
                value = tokens[++index];
            }
            if (value === undefined) value = true;

            switch (key) {
                case "refresh":
                case "force": parameters.refresh = value !== "false"; break;
                case "errors": parameters.errors = value !== "false"; break;
                case "skipped": parameters.includeSkipped = value !== "false"; break;
                case "limit": parameters.limit = integer(value, DEFAULT_PROVIDER_LIMIT); break;
                case "window": parameters.window = integer(value, 7); break;
                case "index": parameters.index = integer(value, -1); break;
                case "query":
                case "q": parameters.query = String(value); break;
                case "sort": parameters.sort = String(value); break;
                case "direction":
                case "dir": parameters.direction = String(value).toLowerCase(); break;
                case "key": parameters.key = String(value); break;
                case "keys": parameters.keys = String(value); break;
                default: parameters[key] = value;
            }
        }
        return parameters;
    }

    function initialize(
        context
    ) {
        if (
            !context ||
            typeof context !==
                "object"
        ) {
            throw new TypeError(
                "Terminal Stats requires a terminal context object."
            );
        }

        const root =
            context.root;

        const existing =
            context.stats instanceof
                StatisticsService
                ? context.stats
                : context.services?.get?.(
                    "stats"
                ) ||
                root?.[
                    SERVICE_SYMBOL
                ];

        if (
            existing instanceof
                StatisticsService &&
            !existing.destroyed
        ) {
            context.stats =
                existing;

            context.registerService?.(
                "stats",
                existing
            );

            return existing;
        }

        const options = {
            ttl:
                root?.
                    dataset?.
                    terminalStatsTtl,

            apiPath:
                root?.
                    dataset?.
                    terminalStatsApi ||
                null,

            historyMaximum:
                root?.
                    dataset?.
                    terminalStatsHistoryMaximum,

            providerMaximum:
                root?.
                    dataset?.
                    terminalStatsProviderMaximum,

            urls: {
                statistics:
                    root?.
                        dataset?.
                        terminalStatisticsUrl ||
                    DEFAULT_URLS.statistics,

                history:
                    root?.
                        dataset?.
                        terminalStatisticsHistoryUrl ||
                    DEFAULT_URLS.history,

                sources:
                    root?.
                        dataset?.
                        terminalStatisticsSourcesUrl ||
                    DEFAULT_URLS.sources,

                speciesIndex:
                    root?.
                        dataset?.
                        terminalSpeciesIndexUrl ||
                    DEFAULT_URLS.speciesIndex,

                databaseManifest:
                    root?.
                        dataset?.
                        terminalDatabaseManifestUrl ||
                    DEFAULT_URLS.databaseManifest,

                browserManifest:
                    root?.
                        dataset?.
                        terminalBrowserManifestUrl ||
                    DEFAULT_URLS.browserManifest
            }
        };

        const service =
            new StatisticsService(
                context,
                options
            );

        root[
            SERVICE_SYMBOL
        ] =
            service;

        context.stats =
            service;

        context.registerService?.(
            "stats",
            service
        );

        setState(
            context,
            "statistics.service",
            service.status()
        );

        emit(
            context,
            "stats:ready",
            service.status()
        );

        return service;
    }

    const commands = [{
        name: "stats",
        aliases: ["statistics"],
        category: "data",
        description: "Display canonical dataset, rank, provider, history, trend, and runtime statistics.",
        usage: "stats [summary|count|species-count|provider-count|all|ranks|providers|history|trends|compare|state|health|refresh|clear] [options]",
        examples: [
            "stats",
            "stats ranks",
            "stats providers --sort=fetched --limit=25",
            "stats providers --errors --skipped",
            "stats history --key=species --limit=14",
            "stats trends --keys=species,genera,records_archived --window=30",
            "stats compare --index=-1",
            "stats refresh"
        ],
        handler: async ({
            args = [],
            context,
            writeJSON
        }) => {
            const service = context.services?.get?.("stats") || context.stats;
            if (!service || typeof service.run !== "function") {
                throw new Error("Statistics service is unavailable.");
            }
            const result = await service.run(parseArguments(args));
            return writeJSON(result);
        }
    }];

    const api = Object.freeze({
        name: MODULE_NAME,
        version: VERSION,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        StatisticsService,
        SERVICE_SYMBOL,
        normalizeStatistics,
        normalizeHistory,
        normalizeSources,
        arrayFromPayload,
        rankCountsFromRecords,
        isAbortError,
        mergeAbortSignals,
        parseArguments,
        commands
    });

    window.SpeciedexTerminalStats = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
