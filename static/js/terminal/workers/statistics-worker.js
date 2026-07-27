/*
========================================================================
Speciedex.org
Statistics Worker
========================================================================

High-performance worker-side statistics engine for SpeciedexTerminal.

Designed for browser integration through:

    _partials/splash.html
        -> _partials/terminal.html
        -> terminal WorkerPool
        -> static/js/terminal/workers/statistics-worker.js

The worker accepts JSON-compatible records emitted by the static site,
terminal JavaScript modules, Python workflow products, and archive exports.

Features:

    • Record, field, type, null, and distinct-value summaries
    • Numeric min, max, range, sum, mean, median, variance, and deviation
    • Population and sample variance and standard deviation
    • Percentiles, quartiles, interquartile range, MAD, skewness, kurtosis
    • Numeric and categorical histograms
    • Grouped and pivot-style statistics
    • Pearson and Spearman correlations
    • Covariance matrices and linear-regression summaries
    • Nested and wildcard record-field paths
    • Request cancellation, progress events, and structured responses

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

"use strict";

const WORKER_NAME = "statistics";
const WORKER_VERSION = "3.0.0";

const MAX_RECORDS = 1000000;
const MAX_FIELDS = 512;
const DEFAULT_PERCENTILES = Object.freeze([
    0,
    0.25,
    0.5,
    0.75,
    1
]);
const DEFAULT_BINS = 10;
const MAX_BINS = 1000;
const DEFAULT_TOP_VALUES = 20;
const MAX_TOP_VALUES = 1000;
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

function normalizeBoolean(value, fallback = false) {
    if (typeof value === "boolean") {
        return value;
    }

    if (typeof value === "number") {
        return value !== 0;
    }

    const text = normalizeKey(value);

    if (["true", "1", "yes", "on"].includes(text)) {
        return true;
    }

    if (["false", "0", "no", "off", ""].includes(text)) {
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

function uniqueStrings(value) {
    return [
        ...new Set(
            asArray(value)
                .flatMap(item =>
                    typeof item === "string"
                        ? item.split(",")
                        : [item]
                )
                .map(normalizeText)
                .filter(Boolean)
        )
    ];
}

function clampInteger(value, fallback, minimum, maximum) {
    const parsed = Number.parseInt(value, 10);

    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.min(maximum, Math.max(minimum, parsed));
}

function clampNumber(value, fallback, minimum, maximum) {
    const parsed = Number(value);

    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.min(maximum, Math.max(minimum, parsed));
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
            "Statistics worker request cancelled.",
            "STATISTICS_WORKER_CANCELLED",
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
        case "calculate":
        case "summary":
        case "describe":
            return calculateStatistics(payload, id);

        case "field":
        case "describe-field":
            return calculateFieldStatistics(payload, id);

        case "group":
        case "grouped":
        case "group-by":
            return calculateGroupedStatistics(payload, id);

        case "correlation":
        case "correlations":
            return calculateCorrelations(payload, id);

        case "covariance":
        case "covariances":
            return calculateCovariances(payload, id);

        case "regression":
        case "linear-regression":
            return calculateRegression(payload, id);

        case "histogram":
            return calculateHistogramOperation(payload, id);

        case "frequency":
        case "frequencies":
            return calculateFrequencyOperation(payload, id);

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
                `Unsupported statistics operation: ${type || "(empty)"}`,
                "STATISTICS_WORKER_UNSUPPORTED_OPERATION"
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
            maxFields: MAX_FIELDS,
            maxBins: MAX_BINS,
            maxTopValues: MAX_TOP_VALUES
        }
    };
}

function extractRecords(payload = {}) {
    const candidate =
        payload.records ??
        payload.documents ??
        payload.items ??
        payload.results ??
        payload.rows ??
        payload.data ??
        [];

    if (Array.isArray(candidate)) {
        return normalizeRecords(candidate);
    }

    if (
        candidate &&
        typeof candidate === "object"
    ) {
        for (const key of [
            "records",
            "documents",
            "items",
            "results",
            "rows",
            "data"
        ]) {
            if (Array.isArray(candidate[key])) {
                return normalizeRecords(candidate[key]);
            }
        }
    }

    return [];
}

function normalizeRecords(records) {
    const values = Array.isArray(records)
        ? records
        : [];

    if (values.length > MAX_RECORDS) {
        throw createError(
            `Statistics record limit exceeded: ${values.length} > ${MAX_RECORDS}.`,
            "STATISTICS_WORKER_RECORD_LIMIT",
            "RangeError"
        );
    }

    return values;
}

function normalizeFields(requested, records) {
    const fields = uniqueStrings(requested).length
        ? uniqueStrings(requested)
        : discoverFields(records);

    if (fields.length > MAX_FIELDS) {
        throw createError(
            `Statistics field limit exceeded: ${fields.length} > ${MAX_FIELDS}.`,
            "STATISTICS_WORKER_FIELD_LIMIT",
            "RangeError"
        );
    }

    return fields;
}

function discoverFields(records) {
    const fields = new Set();

    for (const record of records) {
        collectFieldPaths(record, "", fields);

        if (fields.size >= MAX_FIELDS) {
            break;
        }
    }

    return [...fields]
        .filter(Boolean)
        .sort()
        .slice(0, MAX_FIELDS);
}

function collectFieldPaths(value, prefix, output, depth = 0) {
    if (
        value === null ||
        value === undefined ||
        depth > 8
    ) {
        return;
    }

    if (Array.isArray(value)) {
        for (const item of value.slice(0, 16)) {
            collectFieldPaths(item, prefix, output, depth + 1);
        }
        return;
    }

    if (typeof value !== "object") {
        if (prefix) {
            output.add(prefix);
        }
        return;
    }

    for (const [key, child] of Object.entries(value)) {
        const path = prefix
            ? `${prefix}.${key}`
            : key;

        if (
            child === null ||
            child === undefined ||
            typeof child !== "object"
        ) {
            output.add(path);
        } else {
            collectFieldPaths(child, path, output, depth + 1);
        }

        if (output.size >= MAX_FIELDS) {
            return;
        }
    }
}

async function calculateStatistics(payload = {}, id = null) {
    const startedAt = now();
    const records = extractRecords(payload);
    const fields = normalizeFields(payload.fields, records);
    const percentiles = normalizePercentiles(payload.percentiles);
    const bins = clampInteger(
        payload.bins,
        DEFAULT_BINS,
        1,
        MAX_BINS
    );

    const result = {
        records: records.length,
        fields: fields.length,
        fieldNames: fields,
        distinct: {},
        nulls: {},
        types: {},
        numeric: {},
        categorical: {},
        elapsed_ms: 0,
        workerVersion: WORKER_VERSION
    };

    const progressEnabled = normalizeBoolean(
        payload.progress,
        false
    );

    for (let index = 0; index < fields.length; index += 1) {
        assertActive(id);

        const field = fields[index];
        const values = [];

        for (
            let recordIndex = 0;
            recordIndex < records.length;
            recordIndex += 1
        ) {
            values.push(...fieldValues(records[recordIndex], field));

            if (
                recordIndex > 0 &&
                recordIndex % YIELD_INTERVAL === 0
            ) {
                assertActive(id);
                await yieldToWorker();
            }
        }

        const summary = summarizeValues(values, {
            percentiles,
            bins,
            includeHistogram: normalizeBoolean(
                payload.histograms,
                false
            ),
            topValues:
                payload.topValues ??
                payload.top_values,
            sample: normalizeBoolean(payload.sample, true)
        });

        result.distinct[field] = summary.distinct;
        result.nulls[field] = {
            count: summary.nulls,
            rate:
                values.length
                    ? summary.nulls / values.length
                    : 0
        };
        result.types[field] = summary.types;

        if (summary.numeric) {
            result.numeric[field] = summary.numeric;
        }

        if (summary.categorical) {
            result.categorical[field] = summary.categorical;
        }

        if (progressEnabled) {
            postProgress(
                id,
                "calculate",
                index + 1,
                fields.length,
                { field }
            );
        }

        if (index > 0 && index % 8 === 0) {
            await yieldToWorker();
        }
    }

    result.elapsed_ms = now() - startedAt;
    return result;
}

async function calculateFieldStatistics(payload = {}, id = null) {
    const startedAt = now();
    const records = extractRecords(payload);
    const field = normalizeText(payload.field);

    if (!field) {
        throw createError(
            "A statistics field is required.",
            "STATISTICS_WORKER_FIELD_REQUIRED",
            "TypeError"
        );
    }

    const values = [];
    const progressInterval = clampInteger(
        payload.progressInterval ??
        payload.progress_interval,
        DEFAULT_PROGRESS_INTERVAL,
        MIN_PROGRESS_INTERVAL,
        MAX_PROGRESS_INTERVAL
    );

    for (let index = 0; index < records.length; index += 1) {
        assertActive(id);
        values.push(...fieldValues(records[index], field));

        if (
            normalizeBoolean(payload.progress, false) &&
            index > 0 &&
            index % progressInterval === 0
        ) {
            postProgress(
                id,
                "field",
                index,
                records.length,
                { values: values.length }
            );
        }

        if (index > 0 && index % YIELD_INTERVAL === 0) {
            await yieldToWorker();
        }
    }

    return {
        field,
        records: records.length,
        values: values.length,
        summary: summarizeValues(values, {
            percentiles: normalizePercentiles(payload.percentiles),
            bins: clampInteger(
                payload.bins,
                DEFAULT_BINS,
                1,
                MAX_BINS
            ),
            includeHistogram: normalizeBoolean(
                payload.histogram,
                true
            ),
            topValues:
                payload.topValues ??
                payload.top_values,
            sample: normalizeBoolean(payload.sample, true)
        }),
        elapsed_ms: now() - startedAt,
        workerVersion: WORKER_VERSION
    };
}

async function calculateGroupedStatistics(payload = {}, id = null) {
    const startedAt = now();
    const records = extractRecords(payload);
    const groupBy = normalizeText(
        payload.groupBy ??
        payload.group_by ??
        payload.group
    );

    if (!groupBy) {
        throw createError(
            "A groupBy field is required.",
            "STATISTICS_WORKER_GROUP_FIELD_REQUIRED",
            "TypeError"
        );
    }

    const valueFields = normalizeFields(
        payload.fields,
        records
    ).filter(field => field !== groupBy);

    const groups = new Map();

    for (let index = 0; index < records.length; index += 1) {
        assertActive(id);

        const record = records[index];
        const groupValues = fieldValues(record, groupBy);
        const normalizedGroups = groupValues.length
            ? groupValues
            : [null];

        for (const groupValue of normalizedGroups) {
            const groupKey = canonicalKey(groupValue);

            if (!groups.has(groupKey)) {
                groups.set(groupKey, {
                    value: groupValue,
                    records: []
                });
            }

            groups.get(groupKey).records.push(record);
        }

        if (
            normalizeBoolean(payload.progress, false) &&
            index > 0 &&
            index % DEFAULT_PROGRESS_INTERVAL === 0
        ) {
            postProgress(
                id,
                "group",
                index,
                records.length,
                { groups: groups.size }
            );
        }

        if (index > 0 && index % YIELD_INTERVAL === 0) {
            await yieldToWorker();
        }
    }

    const results = [];
    const percentiles = normalizePercentiles(payload.percentiles);
    const bins = clampInteger(
        payload.bins,
        DEFAULT_BINS,
        1,
        MAX_BINS
    );

    for (const group of groups.values()) {
        assertActive(id);
        const fields = {};

        for (const field of valueFields) {
            const values = group.records.flatMap(record =>
                fieldValues(record, field)
            );

            fields[field] = summarizeValues(values, {
                percentiles,
                bins,
                includeHistogram: normalizeBoolean(
                    payload.histograms,
                    false
                ),
                topValues:
                    payload.topValues ??
                    payload.top_values,
                sample: normalizeBoolean(payload.sample, true)
            });
        }

        results.push({
            group: group.value,
            records: group.records.length,
            fields
        });
    }

    results.sort((left, right) =>
        right.records - left.records ||
        normalizeText(left.group).localeCompare(
            normalizeText(right.group),
            undefined,
            {
                numeric: true,
                sensitivity: "base"
            }
        )
    );

    const limit = clampInteger(
        payload.limit,
        results.length || 1,
        1,
        MAX_LIMIT_SAFE()
    );

    return {
        groupBy,
        groups: results.length,
        records: records.length,
        results: results.slice(0, limit),
        elapsed_ms: now() - startedAt,
        workerVersion: WORKER_VERSION
    };
}

function MAX_LIMIT_SAFE() {
    return 100000;
}

async function calculateCorrelations(payload = {}, id = null) {
    const startedAt = now();
    const records = extractRecords(payload);
    const fields = normalizeFields(payload.fields, records);
    const method = normalizeKey(payload.method ?? "pearson");

    if (fields.length < 2) {
        throw createError(
            "At least two fields are required for correlation.",
            "STATISTICS_WORKER_CORRELATION_FIELDS",
            "RangeError"
        );
    }

    if (!["pearson", "spearman"].includes(method)) {
        throw createError(
            `Unsupported correlation method: ${method}`,
            "STATISTICS_WORKER_CORRELATION_METHOD",
            "TypeError"
        );
    }

    const pairs = [];

    for (
        let leftIndex = 0;
        leftIndex < fields.length;
        leftIndex += 1
    ) {
        for (
            let rightIndex = leftIndex + 1;
            rightIndex < fields.length;
            rightIndex += 1
        ) {
            assertActive(id);

            const leftField = fields[leftIndex];
            const rightField = fields[rightIndex];
            const leftValues = [];
            const rightValues = [];

            for (
                let recordIndex = 0;
                recordIndex < records.length;
                recordIndex += 1
            ) {
                const left = firstNumericValue(
                    records[recordIndex],
                    leftField
                );

                const right = firstNumericValue(
                    records[recordIndex],
                    rightField
                );

                if (left === null || right === null) {
                    continue;
                }

                leftValues.push(left);
                rightValues.push(right);

                if (
                    recordIndex > 0 &&
                    recordIndex % YIELD_INTERVAL === 0
                ) {
                    assertActive(id);
                    await yieldToWorker();
                }
            }

            const correlation =
                method === "spearman"
                    ? spearmanCorrelation(leftValues, rightValues)
                    : pearsonCorrelation(leftValues, rightValues);

            pairs.push({
                left: leftField,
                right: rightField,
                count: leftValues.length,
                method,
                correlation,
                coefficientOfDetermination:
                    correlation === null
                        ? null
                        : correlation ** 2
            });
        }

        if (normalizeBoolean(payload.progress, false)) {
            postProgress(
                id,
                "correlation",
                leftIndex + 1,
                fields.length
            );
        }

        if (leftIndex > 0 && leftIndex % 4 === 0) {
            await yieldToWorker();
        }
    }

    pairs.sort((left, right) =>
        Math.abs(right.correlation ?? 0) -
        Math.abs(left.correlation ?? 0)
    );

    return {
        records: records.length,
        fields,
        method,
        pairs,
        elapsed_ms: now() - startedAt,
        workerVersion: WORKER_VERSION
    };
}

async function calculateCovariances(payload = {}, id = null) {
    const startedAt = now();
    const records = extractRecords(payload);
    const fields = normalizeFields(payload.fields, records);
    const sample = normalizeBoolean(payload.sample, true);
    const pairs = [];

    if (fields.length < 2) {
        throw createError(
            "At least two fields are required for covariance.",
            "STATISTICS_WORKER_COVARIANCE_FIELDS",
            "RangeError"
        );
    }

    for (
        let leftIndex = 0;
        leftIndex < fields.length;
        leftIndex += 1
    ) {
        for (
            let rightIndex = leftIndex;
            rightIndex < fields.length;
            rightIndex += 1
        ) {
            assertActive(id);

            const leftValues = [];
            const rightValues = [];

            for (const record of records) {
                const left = firstNumericValue(
                    record,
                    fields[leftIndex]
                );

                const right = firstNumericValue(
                    record,
                    fields[rightIndex]
                );

                if (left === null || right === null) {
                    continue;
                }

                leftValues.push(left);
                rightValues.push(right);
            }

            pairs.push({
                left: fields[leftIndex],
                right: fields[rightIndex],
                count: leftValues.length,
                covariance: covariance(
                    leftValues,
                    rightValues,
                    sample
                )
            });
        }

        if (leftIndex > 0 && leftIndex % 4 === 0) {
            await yieldToWorker();
        }
    }

    return {
        records: records.length,
        fields,
        sample,
        pairs,
        elapsed_ms: now() - startedAt,
        workerVersion: WORKER_VERSION
    };
}

async function calculateRegression(payload = {}, id = null) {
    const startedAt = now();
    const records = extractRecords(payload);
    const xField = normalizeText(
        payload.x ??
        payload.xField ??
        payload.x_field
    );
    const yField = normalizeText(
        payload.y ??
        payload.yField ??
        payload.y_field
    );

    if (!xField || !yField) {
        throw createError(
            "Both x and y fields are required for regression.",
            "STATISTICS_WORKER_REGRESSION_FIELDS",
            "TypeError"
        );
    }

    const x = [];
    const y = [];

    for (let index = 0; index < records.length; index += 1) {
        assertActive(id);

        const left = firstNumericValue(records[index], xField);
        const right = firstNumericValue(records[index], yField);

        if (left !== null && right !== null) {
            x.push(left);
            y.push(right);
        }

        if (index > 0 && index % YIELD_INTERVAL === 0) {
            await yieldToWorker();
        }
    }

    const model = linearRegression(x, y);

    return {
        xField,
        yField,
        records: records.length,
        pairs: x.length,
        ...model,
        elapsed_ms: now() - startedAt,
        workerVersion: WORKER_VERSION
    };
}

async function calculateHistogramOperation(payload = {}, id = null) {
    const startedAt = now();
    const records = extractRecords(payload);
    const field = normalizeText(payload.field);

    if (!field) {
        throw createError(
            "A histogram field is required.",
            "STATISTICS_WORKER_HISTOGRAM_FIELD",
            "TypeError"
        );
    }

    const values = [];

    for (let index = 0; index < records.length; index += 1) {
        assertActive(id);

        for (const value of fieldValues(records[index], field)) {
            const parsed = numericValue(value);

            if (parsed !== null) {
                values.push(parsed);
            }
        }

        if (
            normalizeBoolean(payload.progress, false) &&
            index > 0 &&
            index % DEFAULT_PROGRESS_INTERVAL === 0
        ) {
            postProgress(
                id,
                "histogram",
                index,
                records.length,
                { values: values.length }
            );
        }

        if (index > 0 && index % YIELD_INTERVAL === 0) {
            await yieldToWorker();
        }
    }

    return {
        field,
        records: records.length,
        values: values.length,
        histogram: buildHistogram(
            values,
            clampInteger(
                payload.bins,
                DEFAULT_BINS,
                1,
                MAX_BINS
            )
        ),
        elapsed_ms: now() - startedAt,
        workerVersion: WORKER_VERSION
    };
}

async function calculateFrequencyOperation(payload = {}, id = null) {
    const startedAt = now();
    const records = extractRecords(payload);
    const field = normalizeText(payload.field);

    if (!field) {
        throw createError(
            "A frequency field is required.",
            "STATISTICS_WORKER_FREQUENCY_FIELD",
            "TypeError"
        );
    }

    const values = [];

    for (let index = 0; index < records.length; index += 1) {
        assertActive(id);
        values.push(...fieldValues(records[index], field));

        if (index > 0 && index % YIELD_INTERVAL === 0) {
            await yieldToWorker();
        }
    }

    const topValues = clampInteger(
        payload.limit ??
        payload.topValues ??
        payload.top_values,
        DEFAULT_TOP_VALUES,
        1,
        MAX_TOP_VALUES
    );

    return {
        field,
        records: records.length,
        values: values.length,
        frequencies: buildFrequencies(values, topValues),
        elapsed_ms: now() - startedAt,
        workerVersion: WORKER_VERSION
    };
}

function normalizePercentiles(values) {
    const input =
        Array.isArray(values) &&
        values.length
            ? values
            : DEFAULT_PERCENTILES;

    return [
        ...new Set(
            input.map(value =>
                clampNumber(value, 0.5, 0, 1)
            )
        )
    ].sort((left, right) => left - right);
}

function summarizeValues(values, options = {}) {
    const typeCounts = {
        null: 0,
        number: 0,
        string: 0,
        boolean: 0,
        date: 0,
        object: 0,
        array: 0,
        other: 0
    };

    const distinct = new Set();
    const numeric = [];
    const categorical = new Map();

    for (const value of values) {
        const type = valueType(value);
        typeCounts[type] = (typeCounts[type] || 0) + 1;

        if (
            value === null ||
            value === undefined ||
            value === ""
        ) {
            continue;
        }

        distinct.add(canonicalKey(value));

        const parsed = numericValue(value);

        if (parsed !== null) {
            numeric.push(parsed);
        }

        const category = facetKey(value);

        categorical.set(
            category,
            (categorical.get(category) || 0) + 1
        );
    }

    const nulls = typeCounts.null;
    const result = {
        count: values.length,
        nonNull: values.length - nulls,
        nulls,
        nullRate:
            values.length
                ? nulls / values.length
                : 0,
        distinct: distinct.size,
        distinctRate:
            values.length - nulls > 0
                ? distinct.size / (values.length - nulls)
                : 0,
        types: typeCounts
    };

    if (numeric.length) {
        result.numeric = summarizeNumeric(
            numeric,
            options
        );
    }

    if (categorical.size) {
        result.categorical = {
            unique: categorical.size,
            top: [...categorical.entries()]
                .sort((left, right) =>
                    right[1] - left[1] ||
                    left[0].localeCompare(
                        right[0],
                        undefined,
                        {
                            numeric: true,
                            sensitivity: "base"
                        }
                    )
                )
                .slice(
                    0,
                    clampInteger(
                        options.topValues,
                        DEFAULT_TOP_VALUES,
                        1,
                        MAX_TOP_VALUES
                    )
                )
                .map(([value, count]) => ({
                    value,
                    count,
                    rate:
                        values.length
                            ? count / values.length
                            : 0
                }))
        };
    }

    return result;
}

function summarizeNumeric(values, options = {}) {
    const sorted = [...values].sort(
        (left, right) => left - right
    );

    const count = sorted.length;
    const sum = compensatedSum(sorted);
    const mean = sum / count;
    const minimum = sorted[0];
    const maximum = sorted.at(-1);
    const sample = normalizeBoolean(options.sample, true);

    let squaredDeviationSum = 0;
    let thirdMoment = 0;
    let fourthMoment = 0;

    for (const value of sorted) {
        const delta = value - mean;
        const square = delta * delta;

        squaredDeviationSum += square;
        thirdMoment += square * delta;
        fourthMoment += square * square;
    }

    const populationVariance =
        count > 0
            ? squaredDeviationSum / count
            : null;

    const sampleVariance =
        count > 1
            ? squaredDeviationSum / (count - 1)
            : null;

    const variance = sample
        ? sampleVariance
        : populationVariance;

    const percentileValues = {};

    for (
        const percentile of
        options.percentiles ||
        DEFAULT_PERCENTILES
    ) {
        percentileValues[
            percentileLabel(percentile)
        ] = percentileValue(sorted, percentile);
    }

    const median = percentileValue(sorted, 0.5);
    const q1 = percentileValue(sorted, 0.25);
    const q3 = percentileValue(sorted, 0.75);
    const standardDeviation =
        variance === null
            ? null
            : Math.sqrt(variance);

    const populationStandardDeviation =
        populationVariance === null
            ? null
            : Math.sqrt(populationVariance);

    const skewness =
        count > 2 &&
        populationStandardDeviation > 0
            ? (thirdMoment / count) /
              (populationStandardDeviation ** 3)
            : null;

    const kurtosis =
        count > 3 &&
        populationStandardDeviation > 0
            ? (fourthMoment / count) /
              (populationStandardDeviation ** 4) - 3
            : null;

    return {
        count,
        sum,
        minimum,
        maximum,
        range: maximum - minimum,
        mean,
        median,
        mode: numericModes(sorted),
        q1,
        q3,
        interquartileRange: q3 - q1,
        medianAbsoluteDeviation:
            medianAbsoluteDeviation(sorted, median),
        variance,
        sampleVariance,
        populationVariance,
        standardDeviation,
        sampleStandardDeviation:
            sampleVariance === null
                ? null
                : Math.sqrt(sampleVariance),
        populationStandardDeviation,
        coefficientOfVariation:
            mean !== 0 && standardDeviation !== null
                ? standardDeviation / Math.abs(mean)
                : null,
        skewness,
        excessKurtosis: kurtosis,
        percentiles: percentileValues,
        histogram:
            normalizeBoolean(
                options.includeHistogram,
                false
            )
                ? buildHistogram(
                    sorted,
                    options.bins ?? DEFAULT_BINS
                )
                : undefined
    };
}

function compensatedSum(values) {
    let sum = 0;
    let compensation = 0;

    for (const value of values) {
        const adjusted = value - compensation;
        const temporary = sum + adjusted;
        compensation = (temporary - sum) - adjusted;
        sum = temporary;
    }

    return sum;
}

function numericModes(sorted) {
    if (!sorted.length) {
        return [];
    }

    let maximumCount = 0;
    const counts = new Map();

    for (const value of sorted) {
        const count = (counts.get(value) || 0) + 1;
        counts.set(value, count);
        maximumCount = Math.max(maximumCount, count);
    }

    if (maximumCount <= 1) {
        return [];
    }

    return [...counts.entries()]
        .filter(([, count]) => count === maximumCount)
        .map(([value]) => value);
}

function medianAbsoluteDeviation(sorted, median) {
    if (!sorted.length || median === null) {
        return null;
    }

    const deviations = sorted
        .map(value => Math.abs(value - median))
        .sort((left, right) => left - right);

    return percentileValue(deviations, 0.5);
}

function percentileValue(sorted, percentile) {
    if (!sorted.length) {
        return null;
    }

    if (sorted.length === 1) {
        return sorted[0];
    }

    const position = percentile * (sorted.length - 1);
    const lower = Math.floor(position);
    const upper = Math.ceil(position);

    if (lower === upper) {
        return sorted[lower];
    }

    const weight = position - lower;

    return (
        sorted[lower] * (1 - weight) +
        sorted[upper] * weight
    );
}

function percentileLabel(percentile) {
    const value = percentile * 100;

    return `p${
        Number.isInteger(value)
            ? value
            : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")
    }`;
}

function buildHistogram(values, bins) {
    if (!values.length) {
        return {
            bins: [],
            minimum: null,
            maximum: null,
            width: null,
            count: 0
        };
    }

    const sorted = [...values].sort(
        (left, right) => left - right
    );

    const minimum = sorted[0];
    const maximum = sorted.at(-1);

    if (minimum === maximum) {
        return {
            bins: [{
                index: 0,
                start: minimum,
                end: maximum,
                count: sorted.length,
                rate: 1
            }],
            minimum,
            maximum,
            width: 0,
            count: sorted.length
        };
    }

    const count = clampInteger(
        bins,
        DEFAULT_BINS,
        1,
        MAX_BINS
    );

    const width = (maximum - minimum) / count;
    const output = Array.from(
        { length: count },
        (_value, index) => ({
            index,
            start: minimum + index * width,
            end:
                index === count - 1
                    ? maximum
                    : minimum + (index + 1) * width,
            count: 0,
            rate: 0
        })
    );

    for (const value of sorted) {
        const index = Math.min(
            count - 1,
            Math.floor((value - minimum) / width)
        );

        output[index].count += 1;
    }

    for (const bin of output) {
        bin.rate = bin.count / sorted.length;
    }

    return {
        bins: output,
        minimum,
        maximum,
        width,
        count: sorted.length
    };
}

function buildFrequencies(values, limit) {
    const counts = new Map();

    for (const value of values) {
        const canonical = canonicalKey(value);
        const existing = counts.get(canonical);

        if (existing) {
            existing.count += 1;
        } else {
            counts.set(canonical, {
                value,
                count: 1
            });
        }
    }

    const sorted = [...counts.values()]
        .sort((left, right) =>
            right.count - left.count ||
            normalizeText(left.value).localeCompare(
                normalizeText(right.value),
                undefined,
                {
                    numeric: true,
                    sensitivity: "base"
                }
            )
        );

    return {
        unique: sorted.length,
        top: sorted
            .slice(0, limit)
            .map(item => ({
                ...item,
                rate:
                    values.length
                        ? item.count / values.length
                        : 0
            }))
    };
}

function pearsonCorrelation(left, right) {
    if (
        left.length !== right.length ||
        left.length < 2
    ) {
        return null;
    }

    const covarianceValue = covariance(left, right, true);
    const leftDeviation = sampleStandardDeviation(left);
    const rightDeviation = sampleStandardDeviation(right);

    if (
        covarianceValue === null ||
        !leftDeviation ||
        !rightDeviation
    ) {
        return null;
    }

    return covarianceValue /
        (leftDeviation * rightDeviation);
}

function spearmanCorrelation(left, right) {
    if (
        left.length !== right.length ||
        left.length < 2
    ) {
        return null;
    }

    return pearsonCorrelation(
        rankValues(left),
        rankValues(right)
    );
}

function rankValues(values) {
    const indexed = values
        .map((value, index) => ({
            value,
            index
        }))
        .sort((left, right) =>
            left.value - right.value ||
            left.index - right.index
        );

    const ranks = new Array(values.length);

    for (let start = 0; start < indexed.length;) {
        let end = start + 1;

        while (
            end < indexed.length &&
            indexed[end].value === indexed[start].value
        ) {
            end += 1;
        }

        const averageRank =
            (start + 1 + end) / 2;

        for (let index = start; index < end; index += 1) {
            ranks[indexed[index].index] = averageRank;
        }

        start = end;
    }

    return ranks;
}

function covariance(left, right, sample = true) {
    if (
        left.length !== right.length ||
        left.length < (sample ? 2 : 1)
    ) {
        return null;
    }

    const leftMean = compensatedSum(left) / left.length;
    const rightMean = compensatedSum(right) / right.length;

    let sum = 0;

    for (let index = 0; index < left.length; index += 1) {
        sum +=
            (left[index] - leftMean) *
            (right[index] - rightMean);
    }

    return sum / (
        sample
            ? left.length - 1
            : left.length
    );
}

function sampleStandardDeviation(values) {
    if (values.length < 2) {
        return null;
    }

    const mean = compensatedSum(values) / values.length;
    let sum = 0;

    for (const value of values) {
        sum += (value - mean) ** 2;
    }

    return Math.sqrt(sum / (values.length - 1));
}

function linearRegression(x, y) {
    if (
        x.length !== y.length ||
        x.length < 2
    ) {
        return {
            slope: null,
            intercept: null,
            correlation: null,
            rSquared: null,
            residualStandardError: null
        };
    }

    const xMean = compensatedSum(x) / x.length;
    const yMean = compensatedSum(y) / y.length;

    let numerator = 0;
    let denominator = 0;

    for (let index = 0; index < x.length; index += 1) {
        const xDelta = x[index] - xMean;
        numerator += xDelta * (y[index] - yMean);
        denominator += xDelta ** 2;
    }

    if (denominator === 0) {
        return {
            slope: null,
            intercept: yMean,
            correlation: null,
            rSquared: null,
            residualStandardError: null
        };
    }

    const slope = numerator / denominator;
    const intercept = yMean - slope * xMean;
    const correlation = pearsonCorrelation(x, y);

    let residualSumSquares = 0;

    for (let index = 0; index < x.length; index += 1) {
        const predicted = intercept + slope * x[index];
        residualSumSquares += (y[index] - predicted) ** 2;
    }

    return {
        slope,
        intercept,
        correlation,
        rSquared:
            correlation === null
                ? null
                : correlation ** 2,
        residualStandardError:
            x.length > 2
                ? Math.sqrt(
                    residualSumSquares / (x.length - 2)
                )
                : null
    };
}

function firstNumericValue(record, field) {
    for (const value of fieldValues(record, field)) {
        const parsed = numericValue(value);

        if (parsed !== null) {
            return parsed;
        }
    }

    return null;
}

function numericValue(value) {
    if (
        value === null ||
        value === undefined ||
        value === "" ||
        typeof value === "boolean"
    ) {
        return null;
    }

    const parsed = Number(value);

    return Number.isFinite(parsed)
        ? parsed
        : null;
}

function valueType(value) {
    if (
        value === null ||
        value === undefined ||
        value === ""
    ) {
        return "null";
    }

    if (Array.isArray(value)) {
        return "array";
    }

    if (typeof value === "number") {
        return "number";
    }

    if (typeof value === "boolean") {
        return "boolean";
    }

    if (value instanceof Date) {
        return "date";
    }

    if (typeof value === "string") {
        return isDateString(value)
            ? "date"
            : "string";
    }

    if (typeof value === "object") {
        return "object";
    }

    return "other";
}

function isDateString(value) {
    const text = normalizeText(value);

    if (
        !/^\d{4}-\d{2}-\d{2}/.test(text) &&
        !/[T:/]/.test(text)
    ) {
        return false;
    }

    return Number.isFinite(Date.parse(text));
}

function tokenizePath(path) {
    return normalizeText(path)
        .replace(/\[["']?([^"'[\]]+)["']?\]/g, ".$1")
        .split(".")
        .map(normalizeText)
        .filter(Boolean);
}

function fieldValues(record, path) {
    if (
        record === null ||
        record === undefined
    ) {
        return [];
    }

    const parts = tokenizePath(path);

    if (!parts.length) {
        return flatten(record);
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
        typeof value === "object" &&
        !(value instanceof Date)
    ) {
        for (const item of Object.values(value)) {
            flatten(item, output);
        }

        return output;
    }

    output.push(value);
    return output;
}

function canonicalKey(value) {
    if (value === null || value === undefined) {
        return "null";
    }

    if (typeof value === "object") {
        try {
            return stableStringify(value);
        } catch (_error) {
            return String(value);
        }
    }

    return `${typeof value}:${String(value)}`;
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

function facetKey(value) {
    if (value === null) {
        return "null";
    }

    if (value === undefined) {
        return "";
    }

    if (typeof value === "object") {
        try {
            return stableStringify(value);
        } catch (_error) {
            return String(value);
        }
    }

    return normalizeText(value);
}
