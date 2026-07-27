/*
========================================================================
Speciedex.org
Provider Worker
========================================================================

High-performance worker-side provider analysis for SpeciedexTerminal.

Designed for browser integration through:

    _partials/splash.html
        -> _partials/terminal.html
        -> terminal WorkerPool
        -> static/js/terminal/workers/provider-worker.js

Features:

    • Provider normalization, health scoring, summaries, and ranking
    • Latency, availability, enablement, request, and error analysis
    • Record overlap, union, intersection, and difference calculations
    • Duplicate detection, coverage metrics, and pairwise comparisons
    • Provider record envelopes from JavaScript and Python workflows
    • Request cancellation, progress events, and structured responses

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

"use strict";

const WORKER_NAME = "provider";
const WORKER_VERSION = "3.0.0";

const DEFAULT_KEY = "id";
const MAX_RECORDS = 1000000;
const MAX_PROVIDERS = 10000;
const DEFAULT_PROGRESS_INTERVAL = 5000;
const MIN_PROGRESS_INTERVAL = 100;
const MAX_PROGRESS_INTERVAL = 100000;
const YIELD_INTERVAL = 2048;

const activeRequests = new Map();
const cancelledRequests = new Set();

function now() {
    return (
        typeof performance !== "undefined" &&
        typeof performance.now === "function"
    )
        ? performance.now()
        : Date.now();
}

function normalizeText(value) {
    return String(value ?? "").trim();
}

function normalizeKey(value) {
    return normalizeText(value).toLowerCase();
}

function numericValue(value, fallback = 0) {
    const result = Number(value);

    return Number.isFinite(result)
        ? result
        : fallback;
}

function integer(value, fallback, minimum, maximum) {
    const parsed = Number.parseInt(value, 10);

    return Number.isFinite(parsed)
        ? Math.min(maximum, Math.max(minimum, parsed))
        : fallback;
}

function booleanValue(value, fallback = false) {
    if (typeof value === "boolean") {
        return value;
    }

    if (typeof value === "number") {
        return value !== 0;
    }

    const normalized = normalizeKey(value);

    if (["true", "1", "yes", "on"].includes(normalized)) {
        return true;
    }

    if (["false", "0", "no", "off", ""].includes(normalized)) {
        return false;
    }

    return fallback;
}

function asArray(value) {
    if (value === undefined || value === null) {
        return [];
    }

    return Array.isArray(value)
        ? value
        : [value];
}

function createError(message, code, name = "Error") {
    const error = new Error(message);
    error.name = name;
    error.code = code;
    return error;
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
        worker: WORKER_NAME,
        workerVersion: WORKER_VERSION,
        ...payload
    });
}

function respond(id, result, error = null) {
    post(
        "response",
        id,
        error
            ? { error: serializeError(error) }
            : { result }
    );
}

function postProgress(id, phase, completed, total, extra = {}) {
    const percent = total > 0
        ? Math.min(100, (completed / total) * 100)
        : 100;

    post("progress", id, {
        phase,
        completed,
        total,
        percent,
        ...extra
    });
}

function yieldToWorker() {
    return new Promise(resolve => {
        setTimeout(resolve, 0);
    });
}

function assertActive(id) {
    if (id === null || id === undefined) {
        return;
    }

    if (
        cancelledRequests.has(id) ||
        activeRequests.get(id)?.cancelled === true
    ) {
        throw createError(
            "Provider worker request cancelled.",
            "PROVIDER_WORKER_CANCELLED",
            "AbortError"
        );
    }
}

function markCancelled(targetId) {
    if (targetId === null || targetId === undefined) {
        return false;
    }

    cancelledRequests.add(targetId);

    const request = activeRequests.get(targetId);

    if (request) {
        request.cancelled = true;
        return true;
    }

    return false;
}

function normalizeMessage(raw) {
    const message =
        raw && typeof raw === "object"
            ? raw
            : {};

    const payload =
        message.payload ??
        message.data ??
        message.options ??
        {};

    return {
        id:
            message.id ??
            message.requestId ??
            message.request_id ??
            null,

        type:
            normalizeKey(
                message.type ??
                message.operation ??
                message.action ??
                message.command
            ),

        payload:
            payload &&
            typeof payload === "object"
                ? payload
                : {},

        targetId:
            message.targetId ??
            message.target_id ??
            payload?.targetId ??
            payload?.target_id ??
            payload?.id ??
            null
    };
}

self.addEventListener("message", async event => {
    const message = normalizeMessage(event.data);

    if (message.type === "cancel" || message.type === "abort") {
        const found = markCancelled(message.targetId);

        /*
        Do not acknowledge cancellation using the original request ID.
        Doing so would resolve the WorkerPool promise before the cancelled
        request can return its AbortError.
        */
        if (
            message.id !== null &&
            message.id !== message.targetId
        ) {
            respond(message.id, {
                cancelled: true,
                found,
                targetId: message.targetId
            });
        }

        return;
    }

    const id =
        message.id ??
        `${WORKER_NAME}:${Date.now()}:${Math.random()
            .toString(36)
            .slice(2)}`;

    activeRequests.set(id, {
        cancelled: false,
        startedAt: now(),
        type: message.type
    });

    cancelledRequests.delete(id);

    try {
        const result = await handle(
            message.type,
            message.payload,
            id
        );

        assertActive(id);
        respond(id, result);
    } catch (error) {
        respond(id, null, error);
    } finally {
        activeRequests.delete(id);
        cancelledRequests.delete(id);
    }
});

async function handle(type, payload, id) {
    switch (type) {
        case "health":
        case "analyze-health":
            return analyzeHealth(payload, id);

        case "health-summary":
        case "summary": {
            const analysis = await analyzeHealth(payload, id);

            return {
                summary: summarizeHealth(analysis.providers),
                providers: analysis.providers,
                elapsed_ms: analysis.elapsed_ms,
                workerVersion: WORKER_VERSION
            };
        }

        case "rank":
        case "ranking":
            return rankProviders(payload, id);

        case "overlap":
            return analyzeOverlap(payload, id);

        case "coverage":
            return analyzeCoverage(payload, id);

        case "duplicates":
        case "duplicate":
            return findDuplicates(payload, id);

        case "normalize":
            return {
                providers: normalizeProviders(
                    extractProviders(payload)
                )
            };

        case "status":
            return status();

        case "ping":
            return {
                pong: true,
                worker: WORKER_NAME,
                version: WORKER_VERSION,
                timestamp: new Date().toISOString()
            };

        default:
            throw createError(
                `Unsupported provider operation: ${type || "(empty)"}`,
                "PROVIDER_WORKER_UNSUPPORTED_OPERATION"
            );
    }
}

function status() {
    return {
        ready: true,
        worker: WORKER_NAME,
        workerVersion: WORKER_VERSION,
        activeRequests: activeRequests.size,
        limits: {
            maxRecords: MAX_RECORDS,
            maxProviders: MAX_PROVIDERS
        }
    };
}

function extractProviders(payload = {}) {
    const candidate =
        payload.providers ??
        payload.records ??
        payload.items ??
        payload.results ??
        payload.rows ??
        payload.data ??
        [];

    if (Array.isArray(candidate)) {
        return candidate;
    }

    if (
        candidate &&
        typeof candidate === "object"
    ) {
        for (const key of [
            "providers",
            "records",
            "items",
            "results",
            "rows",
            "data"
        ]) {
            if (Array.isArray(candidate[key])) {
                return candidate[key];
            }
        }
    }

    return [];
}

function extractRecords(source) {
    if (Array.isArray(source)) {
        return source;
    }

    if (!source || typeof source !== "object") {
        return [];
    }

    const candidate =
        source.records ??
        source.documents ??
        source.items ??
        source.results ??
        source.rows ??
        source.data ??
        [];

    if (Array.isArray(candidate)) {
        return candidate;
    }

    return [];
}

function normalizeProvider(provider, index = 0) {
    const source =
        provider &&
        typeof provider === "object"
            ? provider
            : {};

    const id = normalizeText(
        source.id ??
        source.key ??
        source.slug ??
        source.provider_id ??
        source.providerId ??
        source.name ??
        `provider-${index + 1}`
    );

    const name = normalizeText(
        source.name ??
        source.label ??
        source.title ??
        id
    );

    const explicitlyEnabled =
        source.enabled ??
        source.is_enabled ??
        source.isEnabled;

    const explicitlyDisabled =
        source.disabled ??
        source.is_disabled ??
        source.isDisabled;

    const enabled =
        explicitlyEnabled !== undefined
            ? booleanValue(explicitlyEnabled, true)
            : !booleanValue(explicitlyDisabled, false);

    const latency = Math.max(
        0,
        numericValue(
            source.latency ??
            source.latency_ms ??
            source.latencyMs ??
            source.response_time_ms ??
            source.responseTimeMs,
            0
        )
    );

    const errors = Math.max(
        0,
        numericValue(
            source.errors ??
            source.error_count ??
            source.errorCount ??
            source.failed_requests ??
            source.failedRequests,
            0
        )
    );

    const requests = Math.max(
        0,
        numericValue(
            source.requests ??
            source.request_count ??
            source.requestCount ??
            source.total_requests ??
            source.totalRequests,
            0
        )
    );

    const successes = Math.max(
        0,
        numericValue(
            source.successes ??
            source.success_count ??
            source.successCount ??
            source.successful_requests ??
            source.successfulRequests,
            Math.max(0, requests - errors)
        )
    );

    const rawStatus = normalizeKey(
        source.status ??
        source.state ??
        source.health
    );

    const unavailableStatuses = new Set([
        "offline",
        "down",
        "failed",
        "error",
        "unavailable",
        "disabled",
        "blocked"
    ]);

    const available =
        source.available !== undefined
            ? booleanValue(source.available, false)
            : (
                source.is_available !== undefined
                    ? booleanValue(source.is_available, false)
                    : enabled && !unavailableStatuses.has(rawStatus)
            );

    const status = rawStatus || (
        !enabled
            ? "disabled"
            : (
                available
                    ? "available"
                    : "unavailable"
            )
    );

    const successRate =
        requests > 0
            ? Math.max(
                0,
                Math.min(1, successes / requests)
            )
            : (
                errors > 0
                    ? 0
                    : null
            );

    const records = extractRecords(source);

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
        records,
        recordCount:
            numericValue(
                source.record_count ??
                source.recordCount,
                records.length
            ),
        index
    };
}

function normalizeProviders(providers) {
    const values = Array.isArray(providers)
        ? providers
        : [];

    if (values.length > MAX_PROVIDERS) {
        throw createError(
            `Provider limit exceeded: ${values.length} > ${MAX_PROVIDERS}.`,
            "PROVIDER_WORKER_PROVIDER_LIMIT",
            "RangeError"
        );
    }

    return values.map(normalizeProvider);
}

async function analyzeHealth(payload = {}, id = null) {
    const startedAt = now();
    const providers = normalizeProviders(
        extractProviders(payload)
    );

    const results = [];
    const threshold = Math.max(
        0,
        Math.min(
            1,
            numericValue(
                payload.healthyThreshold ??
                payload.healthy_threshold,
                0.75
            )
        )
    );

    const progressEnabled = booleanValue(
        payload.progress,
        false
    );

    const progressInterval = integer(
        payload.progressInterval ??
        payload.progress_interval,
        DEFAULT_PROGRESS_INTERVAL,
        MIN_PROGRESS_INTERVAL,
        MAX_PROGRESS_INTERVAL
    );

    for (let index = 0; index < providers.length; index += 1) {
        assertActive(id);

        const provider = providers[index];
        const healthScore = calculateHealthScore(
            provider,
            payload
        );

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
            recordCount: provider.recordCount,
            healthScore,
            healthPercent: healthScore * 100,
            healthy:
                provider.enabled &&
                provider.available &&
                healthScore >= threshold,
            severity: healthSeverity(healthScore)
        });

        if (
            progressEnabled &&
            index > 0 &&
            index % progressInterval === 0
        ) {
            postProgress(
                id,
                "health",
                index,
                providers.length
            );
        }

        if (index > 0 && index % YIELD_INTERVAL === 0) {
            await yieldToWorker();
        }
    }

    return {
        providers: results,
        summary: summarizeHealth(results),
        threshold,
        elapsed_ms: now() - startedAt,
        workerVersion: WORKER_VERSION
    };
}

function calculateHealthScore(provider, options = {}) {
    if (!provider.enabled) {
        return 0;
    }

    const availabilityWeight = numericValue(
        options.availabilityWeight ??
        options.availability_weight,
        0.45
    );

    const successWeight = numericValue(
        options.successWeight ??
        options.success_weight,
        0.35
    );

    const latencyWeight = numericValue(
        options.latencyWeight ??
        options.latency_weight,
        0.20
    );

    const totalWeight =
        availabilityWeight +
        successWeight +
        latencyWeight;

    const normalizedWeights = totalWeight > 0
        ? {
            availability: availabilityWeight / totalWeight,
            success: successWeight / totalWeight,
            latency: latencyWeight / totalWeight
        }
        : {
            availability: 0.45,
            success: 0.35,
            latency: 0.20
        };

    const availabilityScore =
        provider.available
            ? 1
            : 0;

    const successScore =
        provider.successRate !== null
            ? provider.successRate
            : (
                provider.errors > 0
                    ? Math.max(0, 1 - provider.errors * 0.05)
                    : 1
            );

    const latencyTarget = Math.max(
        1,
        numericValue(
            options.latencyTargetMs ??
            options.latency_target_ms,
            1000
        )
    );

    const latencyScore =
        provider.latency <= 0
            ? 1
            : Math.max(
                0,
                Math.min(
                    1,
                    latencyTarget / provider.latency
                )
            );

    const score =
        availabilityScore * normalizedWeights.availability +
        successScore * normalizedWeights.success +
        latencyScore * normalizedWeights.latency;

    return Math.max(0, Math.min(1, score));
}

function healthSeverity(score) {
    if (score >= 0.9) {
        return "excellent";
    }

    if (score >= 0.75) {
        return "healthy";
    }

    if (score >= 0.5) {
        return "degraded";
    }

    if (score > 0) {
        return "critical";
    }

    return "offline";
}

function summarizeHealth(records) {
    const values = Array.isArray(records)
        ? records
        : [];

    const enabled = values.filter(provider =>
        provider.enabled
    );

    const available = enabled.filter(provider =>
        provider.available
    );

    const healthy = enabled.filter(provider =>
        provider.healthy
    );

    const latencies = enabled
        .map(provider =>
            numericValue(provider.latency, 0)
        )
        .filter(value => value > 0)
        .sort((left, right) => left - right);

    const totalErrors = values.reduce(
        (sum, provider) =>
            sum + numericValue(provider.errors, 0),
        0
    );

    const totalRequests = values.reduce(
        (sum, provider) =>
            sum + numericValue(provider.requests, 0),
        0
    );

    const totalSuccesses = values.reduce(
        (sum, provider) =>
            sum + numericValue(provider.successes, 0),
        0
    );

    const totalRecords = values.reduce(
        (sum, provider) =>
            sum + numericValue(provider.recordCount, 0),
        0
    );

    const averageHealthScore =
        values.length
            ? values.reduce(
                (sum, provider) =>
                    sum + numericValue(
                        provider.healthScore,
                        0
                    ),
                0
            ) / values.length
            : 0;

    return {
        providers: values.length,
        enabled: enabled.length,
        disabled: values.length - enabled.length,
        available: available.length,
        unavailable: enabled.length - available.length,
        healthy: healthy.length,
        unhealthy: enabled.length - healthy.length,
        totalErrors,
        totalRequests,
        totalSuccesses,
        totalRecords,
        aggregateSuccessRate:
            totalRequests > 0
                ? totalSuccesses / totalRequests
                : null,
        averageLatency:
            latencies.length
                ? latencies.reduce(
                    (sum, value) => sum + value,
                    0
                ) / latencies.length
                : 0,
        medianLatency:
            percentile(latencies, 0.5),
        p95Latency:
            percentile(latencies, 0.95),
        minimumLatency:
            latencies.length
                ? latencies[0]
                : 0,
        maximumLatency:
            latencies.length
                ? latencies.at(-1)
                : 0,
        averageHealthScore,
        averageHealthPercent:
            averageHealthScore * 100
    };
}

function percentile(values, fraction) {
    if (!values.length) {
        return 0;
    }

    const index =
        (values.length - 1) * fraction;

    const lower = Math.floor(index);
    const upper = Math.ceil(index);

    if (lower === upper) {
        return values[lower];
    }

    const weight = index - lower;

    return (
        values[lower] * (1 - weight) +
        values[upper] * weight
    );
}

async function rankProviders(payload = {}, id = null) {
    const analysis = await analyzeHealth(payload, id);
    const providers = [...analysis.providers];

    providers.sort((left, right) =>
        right.healthScore - left.healthScore ||
        right.recordCount - left.recordCount ||
        left.latency - right.latency ||
        left.name.localeCompare(
            right.name,
            undefined,
            {
                numeric: true,
                sensitivity: "base"
            }
        )
    );

    return {
        providers: providers.map(
            (provider, index) => ({
                rank: index + 1,
                ...provider
            })
        ),
        summary: analysis.summary,
        elapsed_ms: analysis.elapsed_ms,
        workerVersion: WORKER_VERSION
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
            left: payload.records[0],
            right: payload.records[1]
        };
    }

    return {
        left: extractRecords(
            payload.left ??
            payload.a ??
            []
        ),
        right: extractRecords(
            payload.right ??
            payload.b ??
            []
        )
    };
}

function tokenizePath(path) {
    return normalizeText(path)
        .replace(/\[["']?([^"'[\]]+)["']?\]/g, ".$1")
        .split(".")
        .map(normalizeText)
        .filter(Boolean);
}

function recordValues(record, path) {
    if (record === null || record === undefined) {
        return [];
    }

    const parts = tokenizePath(path);

    if (!parts.length) {
        return [record];
    }

    return resolveParts([record], parts, 0);
}

function resolveParts(values, parts, index) {
    if (index >= parts.length) {
        return flatten(values);
    }

    const part = parts[index];
    const next = [];

    for (const value of values) {
        if (value === null || value === undefined) {
            continue;
        }

        if (Array.isArray(value)) {
            if (/^\d+$/.test(part)) {
                const indexed = value[Number(part)];

                if (indexed !== undefined) {
                    next.push(indexed);
                }
            }

            for (const item of value) {
                if (part === "*") {
                    next.push(item);
                } else if (
                    item &&
                    typeof item === "object" &&
                    part in item
                ) {
                    next.push(item[part]);
                }
            }

            continue;
        }

        if (typeof value !== "object") {
            continue;
        }

        if (part === "*") {
            next.push(...Object.values(value));
        } else if (part in value) {
            next.push(value[part]);
        } else {
            const camel = part.replace(
                /_([a-z])/g,
                (_match, character) =>
                    character.toUpperCase()
            );

            if (camel in value) {
                next.push(value[camel]);
            }
        }
    }

    return resolveParts(next, parts, index + 1);
}

function flatten(value, output = []) {
    if (Array.isArray(value)) {
        for (const item of value) {
            flatten(item, output);
        }

        return output;
    }

    if (
        value &&
        typeof value === "object"
    ) {
        for (const item of Object.values(value)) {
            flatten(item, output);
        }

        return output;
    }

    if (value !== undefined && value !== null) {
        output.push(value);
    }

    return output;
}

function recordKey(record, key = DEFAULT_KEY) {
    return recordValues(record, key)[0];
}

function canonicalKey(value, caseSensitive = false) {
    if (value === undefined || value === null) {
        return null;
    }

    if (typeof value === "object") {
        try {
            return stableStringify(value);
        } catch (_error) {
            return String(value);
        }
    }

    const result = String(value)
        .normalize("NFKD")
        .replace(/\p{M}+/gu, "");

    return caseSensitive
        ? result
        : result.toLowerCase();
}

function stableStringify(value) {
    if (
        value === null ||
        typeof value !== "object"
    ) {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        return `[${value
            .map(stableStringify)
            .join(",")}]`;
    }

    return `{${Object.keys(value)
        .sort()
        .map(key =>
            `${JSON.stringify(key)}:${stableStringify(value[key])}`
        )
        .join(",")}}`;
}

async function analyzeOverlap(payload = {}, id = null) {
    const startedAt = now();
    const { left, right } = resolveRecordSets(payload);

    ensureRecordLimit(left, "left overlap set");
    ensureRecordLimit(right, "right overlap set");

    const matchKey =
        payload.key ??
        payload.idField ??
        payload.id_field ??
        DEFAULT_KEY;

    const caseSensitive = booleanValue(
        payload.caseSensitive ??
        payload.case_sensitive,
        false
    );

    const rightMap = new Map();

    for (let index = 0; index < right.length; index += 1) {
        assertActive(id);

        const record = right[index];
        const rawValue = recordKey(record, matchKey);
        const value = canonicalKey(rawValue, caseSensitive);

        if (value === null) {
            continue;
        }

        if (!rightMap.has(value)) {
            rightMap.set(value, []);
        }

        rightMap.get(value).push({
            index,
            record
        });

        if (index > 0 && index % YIELD_INTERVAL === 0) {
            await yieldToWorker();
        }
    }

    const intersection = [];
    const leftOnly = [];
    const matchedRightIndexes = new Set();

    for (let index = 0; index < left.length; index += 1) {
        assertActive(id);

        const record = left[index];
        const rawValue = recordKey(record, matchKey);
        const value = canonicalKey(rawValue, caseSensitive);
        const matches =
            value === null
                ? null
                : rightMap.get(value);

        if (matches?.length) {
            for (const match of matches) {
                matchedRightIndexes.add(match.index);
            }

            intersection.push({
                key: rawValue,
                leftIndex: index,
                left: record,
                right: matches.map(match => match.record),
                rightIndexes: matches.map(match => match.index)
            });
        } else {
            leftOnly.push(record);
        }

        if (
            booleanValue(payload.progress, false) &&
            index > 0 &&
            index % DEFAULT_PROGRESS_INTERVAL === 0
        ) {
            postProgress(
                id,
                "overlap",
                index,
                left.length,
                {
                    intersection: intersection.length,
                    leftOnly: leftOnly.length
                }
            );
        }

        if (index > 0 && index % YIELD_INTERVAL === 0) {
            await yieldToWorker();
        }
    }

    const rightOnly = right.filter(
        (_record, index) =>
            !matchedRightIndexes.has(index)
    );

    const intersectionRecords = intersection.map(
        item => item.left
    );

    const includeUnion = booleanValue(
        payload.includeUnion ??
        payload.include_union,
        true
    );

    const union = includeUnion
        ? deduplicateRecords(
            [...left, ...right],
            matchKey,
            caseSensitive
        )
        : undefined;

    const denominator =
        left.length +
        right.length -
        intersectionRecords.length;

    return {
        key: matchKey,
        leftCount: left.length,
        rightCount: right.length,
        intersectionCount: intersectionRecords.length,
        leftOnlyCount: leftOnly.length,
        rightOnlyCount: rightOnly.length,
        unionCount:
            union
                ? union.length
                : denominator,
        jaccard:
            denominator > 0
                ? intersectionRecords.length / denominator
                : 1,
        overlapCoefficient:
            Math.min(left.length, right.length) > 0
                ? intersectionRecords.length /
                  Math.min(left.length, right.length)
                : 1,
        intersection:
            booleanValue(
                payload.includePairs ??
                payload.include_pairs,
                false
            )
                ? intersection
                : intersectionRecords,
        leftOnly:
            booleanValue(
                payload.includeDifferences ??
                payload.include_differences,
                true
            )
                ? leftOnly
                : undefined,
        rightOnly:
            booleanValue(
                payload.includeDifferences ??
                payload.include_differences,
                true
            )
                ? rightOnly
                : undefined,
        union,
        elapsed_ms: now() - startedAt,
        workerVersion: WORKER_VERSION
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
        const value = canonicalKey(
            recordKey(record, key),
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
    const startedAt = now();
    const records = extractRecords(payload);
    ensureRecordLimit(records, "duplicate-analysis set");

    const matchKey =
        payload.key ??
        payload.idField ??
        payload.id_field ??
        DEFAULT_KEY;

    const caseSensitive = booleanValue(
        payload.caseSensitive ??
        payload.case_sensitive,
        false
    );

    const groups = new Map();
    let missingKeys = 0;

    for (let index = 0; index < records.length; index += 1) {
        assertActive(id);

        const record = records[index];
        const rawValue = recordKey(record, matchKey);
        const value = canonicalKey(rawValue, caseSensitive);

        if (value === null) {
            missingKeys += 1;
            continue;
        }

        if (!groups.has(value)) {
            groups.set(value, {
                key: rawValue,
                canonicalKey: value,
                indexes: [],
                records: []
            });
        }

        const group = groups.get(value);
        group.indexes.push(index);
        group.records.push(record);

        if (
            booleanValue(payload.progress, false) &&
            index > 0 &&
            index % DEFAULT_PROGRESS_INTERVAL === 0
        ) {
            postProgress(
                id,
                "duplicates",
                index,
                records.length,
                {
                    groups: groups.size
                }
            );
        }

        if (index > 0 && index % YIELD_INTERVAL === 0) {
            await yieldToWorker();
        }
    }

    const duplicates = [...groups.values()]
        .filter(group => group.records.length > 1)
        .sort((left, right) =>
            right.records.length - left.records.length ||
            String(left.key).localeCompare(String(right.key))
        );

    const duplicateRecords = duplicates.reduce(
        (sum, group) =>
            sum + group.records.length,
        0
    );

    const excessDuplicates = duplicates.reduce(
        (sum, group) =>
            sum + group.records.length - 1,
        0
    );

    return {
        key: matchKey,
        records: records.length,
        uniqueKeys: groups.size,
        missingKeys,
        duplicateGroups: duplicates.length,
        duplicateRecords,
        excessDuplicates,
        duplicateRate:
            records.length > 0
                ? excessDuplicates / records.length
                : 0,
        duplicates,
        elapsed_ms: now() - startedAt,
        workerVersion: WORKER_VERSION
    };
}

async function analyzeCoverage(payload = {}, id = null) {
    const startedAt = now();
    const providers = normalizeProviders(
        extractProviders(payload)
    );

    const matchKey =
        payload.key ??
        payload.idField ??
        payload.id_field ??
        DEFAULT_KEY;

    const caseSensitive = booleanValue(
        payload.caseSensitive ??
        payload.case_sensitive,
        false
    );

    const globalKeys = new Set();
    const normalized = [];

    for (let index = 0; index < providers.length; index += 1) {
        assertActive(id);

        const provider = providers[index];
        const records = provider.records;

        ensureRecordLimit(
            records,
            `coverage set for provider "${provider.id}"`
        );

        const keys = new Set();
        let missingKeys = 0;

        for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
            const value = canonicalKey(
                recordKey(records[recordIndex], matchKey),
                caseSensitive
            );

            if (value === null) {
                missingKeys += 1;
                continue;
            }

            keys.add(value);
            globalKeys.add(value);

            if (
                recordIndex > 0 &&
                recordIndex % YIELD_INTERVAL === 0
            ) {
                assertActive(id);
                await yieldToWorker();
            }
        }

        normalized.push({
            id: provider.id,
            name: provider.name,
            records: records.length,
            unique: keys.size,
            duplicates:
                Math.max(
                    0,
                    records.length -
                    missingKeys -
                    keys.size
                ),
            missingKeys,
            keys
        });

        if (
            booleanValue(payload.progress, false) &&
            index > 0 &&
            index % 100 === 0
        ) {
            postProgress(
                id,
                "coverage",
                index,
                providers.length,
                {
                    uniqueRecords: globalKeys.size
                }
            );
        }

        if (index > 0 && index % 16 === 0) {
            await yieldToWorker();
        }
    }

    const totalUnique = globalKeys.size;

    const coverage = normalized.map(provider => ({
        id: provider.id,
        name: provider.name,
        records: provider.records,
        unique: provider.unique,
        duplicates: provider.duplicates,
        missingKeys: provider.missingKeys,
        coverage:
            totalUnique > 0
                ? provider.unique / totalUnique
                : 0,
        coveragePercent:
            totalUnique > 0
                ? provider.unique / totalUnique * 100
                : 0
    }));

    const pairwise = [];

    if (booleanValue(
        payload.includePairwise ??
        payload.include_pairwise,
        false
    )) {
        for (
            let leftIndex = 0;
            leftIndex < normalized.length;
            leftIndex += 1
        ) {
            for (
                let rightIndex = leftIndex + 1;
                rightIndex < normalized.length;
                rightIndex += 1
            ) {
                assertActive(id);

                const left = normalized[leftIndex];
                const right = normalized[rightIndex];
                const intersection = setIntersectionSize(
                    left.keys,
                    right.keys
                );

                const union =
                    left.keys.size +
                    right.keys.size -
                    intersection;

                pairwise.push({
                    left: left.id,
                    right: right.id,
                    intersection,
                    union,
                    jaccard:
                        union > 0
                            ? intersection / union
                            : 1,
                    overlapCoefficient:
                        Math.min(
                            left.keys.size,
                            right.keys.size
                        ) > 0
                            ? intersection /
                              Math.min(
                                  left.keys.size,
                                  right.keys.size
                              )
                            : 1
                });
            }

            if (leftIndex > 0 && leftIndex % 8 === 0) {
                await yieldToWorker();
            }
        }

        pairwise.sort((left, right) =>
            right.jaccard - left.jaccard ||
            left.left.localeCompare(right.left) ||
            left.right.localeCompare(right.right)
        );
    }

    return {
        key: matchKey,
        providers: coverage.length,
        uniqueRecords: totalUnique,
        totalRecords: normalized.reduce(
            (sum, provider) =>
                sum + provider.records,
            0
        ),
        coverage: coverage.sort((left, right) =>
            right.coverage - left.coverage ||
            right.unique - left.unique ||
            left.name.localeCompare(right.name)
        ),
        pairwise,
        elapsed_ms: now() - startedAt,
        workerVersion: WORKER_VERSION
    };
}

function ensureRecordLimit(records, label) {
    if (records.length > MAX_RECORDS) {
        throw createError(
            `Provider ${label} exceeds the record limit: ${records.length} > ${MAX_RECORDS}.`,
            "PROVIDER_WORKER_RECORD_LIMIT",
            "RangeError"
        );
    }
}

function setIntersectionSize(left, right) {
    const smaller =
        left.size <= right.size
            ? left
            : right;

    const larger =
        smaller === left
            ? right
            : left;

    let count = 0;

    for (const value of smaller) {
        if (larger.has(value)) {
            count += 1;
        }
    }

    return count;
}
