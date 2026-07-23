/*
========================================================================
Speciedex.org
Provider Worker
========================================================================

High-performance worker-side provider analysis for SpeciedexTerminal.

Supports:

    • Provider health normalization and summaries
    • Provider latency, errors, availability, and enablement analysis
    • Record overlap, union, intersection, and difference calculations
    • Duplicate detection and provider coverage metrics
    • Request cancellation and progress events
    • Structured worker responses and safe error serialization

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

"use strict";

const WORKER_VERSION = "2.0.0";
const DEFAULT_KEY = "id";
const MAX_RECORDS = 1000000;
const PROGRESS_INTERVAL = 5000;

const activeRequests = new Map();

function normalizeText(value) {
    return String(value ?? "").trim();
}

function numericValue(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number)
        ? number
        : fallback;
}

function booleanValue(value, fallback = false) {
    if (typeof value === "boolean") {
        return value;
    }

    if (value === "true" || value === 1 || value === "1") {
        return true;
    }

    if (value === "false" || value === 0 || value === "0") {
        return false;
    }

    return fallback;
}

function serializeError(error) {
    return {
        name: error?.name || "Error",
        message: error?.message || String(error),
        stack: error?.stack || null,
        code: error?.code || null
    };
}

function post(type, id, payload = {}) {
    self.postMessage({
        type,
        id,
        ...payload
    });
}

function respond(id, result, error = null) {
    if (error) {
        post("response", id, {
            error: serializeError(error)
        });
        return;
    }

    post("response", id, {
        result
    });
}

function assertNotCancelled(id) {
    if (
        id !== null &&
        activeRequests.get(id)?.cancelled
    ) {
        const error = new Error(
            "Provider worker request cancelled."
        );

        error.name = "AbortError";
        error.code = "PROVIDER_WORKER_CANCELLED";

        throw error;
    }
}

self.addEventListener("message", async event => {
    const message = event.data || {};
    const id = message.id ?? null;
    const type = normalizeText(message.type).toLowerCase();

    if (type === "cancel") {
        const targetId =
            message.payload?.id ??
            message.targetId ??
            id;

        if (activeRequests.has(targetId)) {
            activeRequests.get(targetId).cancelled = true;
        }

        respond(id, {
            cancelled: true,
            targetId
        });

        return;
    }

    activeRequests.set(id, {
        cancelled: false,
        startedAt: performance.now()
    });

    try {
        const result = await handle(
            type,
            message.payload || {},
            id
        );

        respond(id, result);
    } catch (error) {
        respond(id, null, error);
    } finally {
        activeRequests.delete(id);
    }
});

async function handle(type, payload, id) {
    switch (type) {
        case "health":
            return analyzeHealth(payload, id);

        case "health-summary":
        case "summary":
            return summarizeHealth(
                await analyzeHealth(payload, id)
            );

        case "overlap":
            return analyzeOverlap(payload, id);

        case "coverage":
            return analyzeCoverage(payload, id);

        case "duplicates":
            return findDuplicates(payload, id);

        case "normalize":
            return normalizeProviders(
                payload.providers
            );

        case "status":
            return {
                ready: true,
                workerVersion: WORKER_VERSION,
                activeRequests:
                    activeRequests.size
            };

        case "ping":
            return {
                pong: true,
                version: WORKER_VERSION
            };

        default:
            throw new Error(
                `Unsupported provider operation: ${type || "(empty)"}`
            );
    }
}

function normalizeProvider(provider, index = 0) {
    const source =
        provider &&
        typeof provider === "object"
            ? provider
            : {};

    const id =
        normalizeText(
            source.id ??
            source.key ??
            source.slug ??
            source.name ??
            `provider-${index + 1}`
        );

    const name =
        normalizeText(
            source.name ??
            source.label ??
            id
        );

    const enabled =
        source.enabled !== false &&
        source.disabled !== true;

    const latency =
        numericValue(
            source.latency ??
            source.latency_ms ??
            source.latencyMs,
            0
        );

    const errors =
        numericValue(
            source.errors ??
            source.error_count ??
            source.errorCount,
            0
        );

    const requests =
        numericValue(
            source.requests ??
            source.request_count ??
            source.requestCount,
            0
        );

    const successes =
        numericValue(
            source.successes ??
            source.success_count ??
            source.successCount,
            Math.max(0, requests - errors)
        );

    const available =
        source.available !== undefined
            ? booleanValue(
                source.available,
                false
            )
            : (
                enabled &&
                ![
                    "offline",
                    "down",
                    "failed",
                    "error",
                    "disabled"
                ].includes(
                    normalizeText(
                        source.status
                    ).toLowerCase()
                )
            );

    const status =
        normalizeText(
            source.status ||
            (
                !enabled
                    ? "disabled"
                    : (
                        available
                            ? "available"
                            : "unavailable"
                    )
            )
        ).toLowerCase();

    const successRate =
        requests > 0
            ? successes / requests
            : (
                errors > 0
                    ? 0
                    : null
            );

    return {
        ...source,
        id,
        name,
        enabled,
        available,
        status,
        latency,
        errors,
        requests,
        successes,
        successRate,
        index
    };
}

function normalizeProviders(providers) {
    const values =
        Array.isArray(providers)
            ? providers
            : [];

    return values.map(
        normalizeProvider
    );
}

async function analyzeHealth(payload = {}, id = null) {
    const providers =
        normalizeProviders(
            payload.providers
        );

    const results = [];

    for (
        let index = 0;
        index < providers.length;
        index += 1
    ) {
        assertNotCancelled(id);

        const provider =
            providers[index];

        const healthScore =
            calculateHealthScore(provider);

        results.push({
            id: provider.id,
            name: provider.name,
            enabled: provider.enabled,
            available: provider.available,
            status: provider.status,
            latency: provider.latency,
            errors: provider.errors,
            requests: provider.requests,
            successes: provider.successes,
            successRate: provider.successRate,
            healthScore,
            healthy:
                provider.enabled &&
                provider.available &&
                healthScore >= 0.75
        });

        if (
            payload.progress === true &&
            index > 0 &&
            index % PROGRESS_INTERVAL === 0
        ) {
            post("progress", id, {
                phase: "health",
                completed: index,
                total: providers.length
            });

            await Promise.resolve();
        }
    }

    return results;
}

function calculateHealthScore(provider) {
    if (!provider.enabled) {
        return 0;
    }

    let score = 1;

    if (!provider.available) {
        score -= 0.6;
    }

    if (provider.successRate !== null) {
        score *= Math.max(
            0,
            Math.min(
                1,
                provider.successRate
            )
        );
    } else if (provider.errors > 0) {
        score -= Math.min(
            0.4,
            provider.errors * 0.05
        );
    }

    if (provider.latency > 0) {
        if (provider.latency > 5000) {
            score -= 0.3;
        } else if (provider.latency > 2000) {
            score -= 0.2;
        } else if (provider.latency > 1000) {
            score -= 0.1;
        }
    }

    return Math.max(
        0,
        Math.min(1, score)
    );
}

function summarizeHealth(records) {
    const values =
        Array.isArray(records)
            ? records
            : [];

    const enabled =
        values.filter(
            provider =>
                provider.enabled
        );

    const available =
        enabled.filter(
            provider =>
                provider.available
        );

    const healthy =
        enabled.filter(
            provider =>
                provider.healthy
        );

    const latencies =
        enabled
            .map(
                provider =>
                    numericValue(
                        provider.latency,
                        0
                    )
            )
            .filter(
                value =>
                    value > 0
            );

    const totalErrors =
        values.reduce(
            (sum, provider) =>
                sum +
                numericValue(
                    provider.errors,
                    0
                ),
            0
        );

    const averageHealthScore =
        values.length
            ? values.reduce(
                (sum, provider) =>
                    sum +
                    numericValue(
                        provider.healthScore,
                        0
                    ),
                0
            ) /
              values.length
            : 0;

    return {
        providers:
            values.length,
        enabled:
            enabled.length,
        disabled:
            values.length -
            enabled.length,
        available:
            available.length,
        unavailable:
            enabled.length -
            available.length,
        healthy:
            healthy.length,
        unhealthy:
            enabled.length -
            healthy.length,
        totalErrors,
        averageLatency:
            latencies.length
                ? latencies.reduce(
                    (sum, value) =>
                        sum + value,
                    0
                ) /
                  latencies.length
                : 0,
        minimumLatency:
            latencies.length
                ? Math.min(
                    ...latencies
                )
                : 0,
        maximumLatency:
            latencies.length
                ? Math.max(
                    ...latencies
                )
                : 0,
        averageHealthScore
    };
}

function resolveRecordSets(payload = {}) {
    if (
        Array.isArray(payload.records) &&
        payload.records.length === 2 &&
        Array.isArray(payload.records[0]) &&
        Array.isArray(payload.records[1])
    ) {
        return {
            left:
                payload.records[0],
            right:
                payload.records[1]
        };
    }

    return {
        left:
            Array.isArray(payload.left)
                ? payload.left
                : [],
        right:
            Array.isArray(payload.right)
                ? payload.right
                : []
    };
}

function recordKey(record, key) {
    if (
        typeof key === "function"
    ) {
        return key(record);
    }

    const normalizedKey =
        normalizeText(
            key || DEFAULT_KEY
        );

    if (!normalizedKey) {
        return record;
    }

    const parts =
        normalizedKey.split(".");

    let value = record;

    for (const part of parts) {
        if (
            value === null ||
            value === undefined
        ) {
            return undefined;
        }

        value = value[part];
    }

    return value;
}

function canonicalKey(value, caseSensitive = false) {
    if (
        value === undefined ||
        value === null
    ) {
        return null;
    }

    if (typeof value === "object") {
        try {
            return JSON.stringify(value);
        } catch (_error) {
            return String(value);
        }
    }

    const text =
        String(value);

    return caseSensitive
        ? text
        : text.toLowerCase();
}

async function analyzeOverlap(payload = {}, id = null) {
    const {
        left,
        right
    } =
        resolveRecordSets(payload);

    if (
        left.length > MAX_RECORDS ||
        right.length > MAX_RECORDS
    ) {
        throw new RangeError(
            "Provider overlap record limit exceeded."
        );
    }

    const key =
        payload.key ||
        DEFAULT_KEY;

    const caseSensitive =
        payload.caseSensitive === true;

    const rightMap =
        new Map();

    for (
        let index = 0;
        index < right.length;
        index += 1
    ) {
        assertNotCancelled(id);

        const record =
            right[index];

        const value =
            canonicalKey(
                recordKey(
                    record,
                    key
                ),
                caseSensitive
            );

        if (value === null) {
            continue;
        }

        if (!rightMap.has(value)) {
            rightMap.set(
                value,
                []
            );
        }

        rightMap.get(value).push({
            index,
            record
        });
    }

    const intersection = [];
    const leftOnly = [];
    const matchedRightKeys =
        new Set();

    for (
        let index = 0;
        index < left.length;
        index += 1
    ) {
        assertNotCancelled(id);

        const record =
            left[index];

        const value =
            canonicalKey(
                recordKey(
                    record,
                    key
                ),
                caseSensitive
            );

        const matches =
            value === null
                ? null
                : rightMap.get(value);

        if (matches?.length) {
            matchedRightKeys.add(value);

            intersection.push({
                key:
                    recordKey(
                        record,
                        key
                    ),
                leftIndex:
                    index,
                left: record,
                right:
                    matches.map(
                        match =>
                            match.record
                    ),
                rightIndexes:
                    matches.map(
                        match =>
                            match.index
                    )
            });
        } else {
            leftOnly.push(record);
        }

        if (
            payload.progress === true &&
            index > 0 &&
            index % PROGRESS_INTERVAL === 0
        ) {
            post("progress", id, {
                phase: "overlap",
                completed: index,
                total: left.length
            });

            await Promise.resolve();
        }
    }

    const rightOnly =
        right.filter(record => {
            const value =
                canonicalKey(
                    recordKey(
                        record,
                        key
                    ),
                    caseSensitive
                );

            return (
                value === null ||
                !matchedRightKeys.has(value)
            );
        });

    const intersectionRecords =
        intersection.map(
            item =>
                item.left
        );

    const union =
        payload.includeUnion === false
            ? undefined
            : deduplicateRecords(
                [
                    ...left,
                    ...right
                ],
                key,
                caseSensitive
            );

    const denominator =
        left.length +
        right.length -
        intersectionRecords.length;

    return {
        key,
        leftCount:
            left.length,
        rightCount:
            right.length,
        intersectionCount:
            intersectionRecords.length,
        leftOnlyCount:
            leftOnly.length,
        rightOnlyCount:
            rightOnly.length,
        unionCount:
            union
                ? union.length
                : denominator,
        jaccard:
            denominator > 0
                ? intersectionRecords.length /
                  denominator
                : 1,
        overlapCoefficient:
            Math.min(
                left.length,
                right.length
            ) > 0
                ? intersectionRecords.length /
                  Math.min(
                      left.length,
                      right.length
                  )
                : 1,
        intersection:
            payload.includePairs === true
                ? intersection
                : intersectionRecords,
        leftOnly:
            payload.includeDifferences === false
                ? undefined
                : leftOnly,
        rightOnly:
            payload.includeDifferences === false
                ? undefined
                : rightOnly,
        union
    };
}

function deduplicateRecords(
    records,
    key = DEFAULT_KEY,
    caseSensitive = false
) {
    const seen = new Set();
    const output = [];

    for (const record of records) {
        const value =
            canonicalKey(
                recordKey(
                    record,
                    key
                ),
                caseSensitive
            );

        if (value === null) {
            output.push(record);
            continue;
        }

        if (seen.has(value)) {
            continue;
        }

        seen.add(value);
        output.push(record);
    }

    return output;
}

async function findDuplicates(payload = {}, id = null) {
    const records =
        Array.isArray(payload.records)
            ? payload.records
            : [];

    if (records.length > MAX_RECORDS) {
        throw new RangeError(
            "Provider duplicate-analysis record limit exceeded."
        );
    }

    const key =
        payload.key ||
        DEFAULT_KEY;

    const caseSensitive =
        payload.caseSensitive === true;

    const groups =
        new Map();

    for (
        let index = 0;
        index < records.length;
        index += 1
    ) {
        assertNotCancelled(id);

        const record =
            records[index];

        const rawValue =
            recordKey(
                record,
                key
            );

        const value =
            canonicalKey(
                rawValue,
                caseSensitive
            );

        if (value === null) {
            continue;
        }

        if (!groups.has(value)) {
            groups.set(
                value,
                {
                    key:
                        rawValue,
                    indexes: [],
                    records: []
                }
            );
        }

        const group =
            groups.get(value);

        group.indexes.push(index);
        group.records.push(record);

        if (
            payload.progress === true &&
            index > 0 &&
            index % PROGRESS_INTERVAL === 0
        ) {
            post("progress", id, {
                phase: "duplicates",
                completed: index,
                total: records.length
            });

            await Promise.resolve();
        }
    }

    const duplicates =
        [...groups.values()]
            .filter(
                group =>
                    group.records.length > 1
            )
            .sort(
                (left, right) =>
                    right.records.length -
                    left.records.length
            );

    return {
        key,
        records:
            records.length,
        duplicateGroups:
            duplicates.length,
        duplicateRecords:
            duplicates.reduce(
                (sum, group) =>
                    sum +
                    group.records.length,
                0
            ),
        duplicates
    };
}

async function analyzeCoverage(payload = {}, id = null) {
    const providers =
        Array.isArray(payload.providers)
            ? payload.providers
            : [];

    const key =
        payload.key ||
        DEFAULT_KEY;

    const caseSensitive =
        payload.caseSensitive === true;

    const globalKeys =
        new Set();

    const normalizedProviders = [];

    for (
        let index = 0;
        index < providers.length;
        index += 1
    ) {
        assertNotCancelled(id);

        const provider =
            providers[index] || {};

        const records =
            Array.isArray(provider.records)
                ? provider.records
                : [];

        const keys =
            new Set();

        for (const record of records) {
            const value =
                canonicalKey(
                    recordKey(
                        record,
                        key
                    ),
                    caseSensitive
                );

            if (value === null) {
                continue;
            }

            keys.add(value);
            globalKeys.add(value);
        }

        normalizedProviders.push({
            id:
                normalizeText(
                    provider.id ??
                    provider.name ??
                    `provider-${index + 1}`
                ),
            name:
                normalizeText(
                    provider.name ??
                    provider.id ??
                    `Provider ${index + 1}`
                ),
            records:
                records.length,
            unique:
                keys.size,
            keys
        });

        if (
            payload.progress === true &&
            index > 0 &&
            index % 100 === 0
        ) {
            post("progress", id, {
                phase: "coverage",
                completed: index,
                total:
                    providers.length
            });

            await Promise.resolve();
        }
    }

    const totalUnique =
        globalKeys.size;

    const coverage =
        normalizedProviders.map(
            provider => ({
                id:
                    provider.id,
                name:
                    provider.name,
                records:
                    provider.records,
                unique:
                    provider.unique,
                coverage:
                    totalUnique > 0
                        ? provider.unique /
                          totalUnique
                        : 0
            })
        );

    const pairwise = [];

    if (payload.includePairwise === true) {
        for (
            let leftIndex = 0;
            leftIndex <
                normalizedProviders.length;
            leftIndex += 1
        ) {
            for (
                let rightIndex =
                    leftIndex + 1;
                rightIndex <
                    normalizedProviders.length;
                rightIndex += 1
            ) {
                const left =
                    normalizedProviders[
                        leftIndex
                    ];

                const right =
                    normalizedProviders[
                        rightIndex
                    ];

                let intersection = 0;

                const smaller =
                    left.keys.size <=
                    right.keys.size
                        ? left.keys
                        : right.keys;

                const larger =
                    smaller === left.keys
                        ? right.keys
                        : left.keys;

                for (const value of smaller) {
                    if (larger.has(value)) {
                        intersection += 1;
                    }
                }

                const union =
                    left.keys.size +
                    right.keys.size -
                    intersection;

                pairwise.push({
                    left:
                        left.id,
                    right:
                        right.id,
                    intersection,
                    union,
                    jaccard:
                        union > 0
                            ? intersection /
                              union
                            : 1
                });
            }
        }
    }

    return {
        key,
        providers:
            coverage.length,
        uniqueRecords:
            totalUnique,
        coverage:
            coverage.sort(
                (left, right) =>
                    right.coverage -
                    left.coverage
            ),
        pairwise
    };
}
