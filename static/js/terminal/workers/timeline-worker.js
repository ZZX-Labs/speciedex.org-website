/*
========================================================================
Speciedex.org
Timeline Worker
========================================================================

High-performance worker-side timeline aggregation for SpeciedexTerminal.

Designed for browser integration through:

    _partials/splash.html
        -> _partials/terminal.html
        -> terminal WorkerPool
        -> static/js/terminal/workers/timeline-worker.js

The worker accepts JSON-compatible records emitted by the static site,
terminal JavaScript modules, Python workflow products, and archive exports.

Features:

    • Nested and wildcard date-field extraction
    • UTC or fixed-offset timeline processing
    • Year, quarter, month, ISO week, day, hour, minute, and second buckets
    • Date-range filtering with inclusive or exclusive boundaries
    • Grouped, stacked, cumulative, moving-average, and rate series
    • Optional empty-bucket filling across explicit or observed ranges
    • Event deduplication and per-record versus per-date counting
    • Timeline range, gap, density, and interval summaries
    • Request cancellation, progress events, and structured responses

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

"use strict";

const WORKER_NAME = "timeline";
const WORKER_VERSION = "3.0.0";

const MAX_RECORDS = 1000000;
const MAX_GROUPS = 10000;
const MAX_BUCKETS = 1000000;
const DEFAULT_PROGRESS_INTERVAL = 5000;
const MIN_PROGRESS_INTERVAL = 100;
const MAX_PROGRESS_INTERVAL = 100000;
const YIELD_INTERVAL = 2048;

const SUPPORTED_BUCKETS = Object.freeze([
    "year",
    "quarter",
    "month",
    "week",
    "day",
    "hour",
    "minute",
    "second"
]);

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

function numberValue(value, fallback = null) {
    const parsed = Number(value);

    return Number.isFinite(parsed)
        ? parsed
        : fallback;
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
            "Timeline worker request cancelled.",
            "TIMELINE_WORKER_CANCELLED",
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
        case "timeline":
        case "aggregate":
        case "build":
            return buildTimeline(payload, id);

        case "range":
            return calculateRange(payload, id);

        case "gaps":
        case "intervals":
            return calculateGaps(payload, id);

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
                `Unsupported timeline operation: ${type || "(empty)"}`,
                "TIMELINE_WORKER_UNSUPPORTED_OPERATION"
            );
    }
}

function status() {
    return {
        ready: true,
        worker: WORKER_NAME,
        workerVersion: WORKER_VERSION,
        buckets: [...SUPPORTED_BUCKETS],
        activeRequests: activeRequests.size,
        limits: {
            maxRecords: MAX_RECORDS,
            maxGroups: MAX_GROUPS,
            maxBuckets: MAX_BUCKETS
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
            `Timeline record limit exceeded: ${values.length} > ${MAX_RECORDS}.`,
            "TIMELINE_WORKER_RECORD_LIMIT",
            "RangeError"
        );
    }

    return values;
}

async function buildTimeline(payload = {}, id = null) {
    const startedAt = now();
    const records = extractRecords(payload);

    const field = normalizeText(
        payload.field ??
        payload.dateField ??
        payload.date_field ??
        "date"
    );

    const groupBy = normalizeText(
        payload.groupBy ??
        payload.group_by ??
        payload.group
    );

    const bucket = normalizeBucket(
        payload.bucket ??
        payload.interval ??
        "year"
    );

    const timezoneOffsetMinutes = clampInteger(
        payload.timezoneOffsetMinutes ??
        payload.timezone_offset_minutes ??
        0,
        0,
        -840,
        840
    );

    const from = normalizeBoundary(
        payload.from ??
        payload.start,
        false,
        timezoneOffsetMinutes
    );

    const to = normalizeBoundary(
        payload.to ??
        payload.end,
        true,
        timezoneOffsetMinutes
    );

    if (
        from !== null &&
        to !== null &&
        from > to
    ) {
        throw createError(
            "Timeline start date must not be later than the end date.",
            "TIMELINE_WORKER_INVALID_RANGE",
            "RangeError"
        );
    }

    const countMode = normalizeKey(
        payload.countMode ??
        payload.count_mode ??
        "date"
    );

    if (!["date", "record"].includes(countMode)) {
        throw createError(
            `Unsupported timeline count mode: ${countMode}`,
            "TIMELINE_WORKER_COUNT_MODE",
            "TypeError"
        );
    }

    const includeRecords = normalizeBoolean(
        payload.includeRecords ??
        payload.include_records,
        false
    );

    const dedupe = normalizeBoolean(
        payload.dedupe,
        countMode === "record"
    );

    const dedupeKey = normalizeText(
        payload.dedupeKey ??
        payload.dedupe_key ??
        "id"
    );

    const groups = new Map();
    let validDates = 0;
    let validRecords = 0;
    let invalidRecords = 0;
    let excludedDates = 0;
    let duplicateDates = 0;

    const progressEnabled = normalizeBoolean(
        payload.progress,
        false
    );

    const progressInterval = clampInteger(
        payload.progressInterval ??
        payload.progress_interval,
        DEFAULT_PROGRESS_INTERVAL,
        MIN_PROGRESS_INTERVAL,
        MAX_PROGRESS_INTERVAL
    );

    for (let index = 0; index < records.length; index += 1) {
        assertActive(id);

        const record = records[index];
        const values = fieldValues(record, field);

        if (!values.length) {
            invalidRecords += 1;
            continue;
        }

        const parsedDates = [];
        const seenDates = new Set();

        for (const rawValue of values) {
            const timestamp = parseTimestamp(
                rawValue,
                payload.numericUnit ??
                payload.numeric_unit
            );

            if (timestamp === null) {
                continue;
            }

            if (
                (from !== null && timestamp < from) ||
                (to !== null && timestamp > to)
            ) {
                excludedDates += 1;
                continue;
            }

            const dedupeValue = dedupe
                ? (
                    countMode === "record"
                        ? canonicalKey(
                            fieldValues(record, dedupeKey)[0] ??
                            index
                        )
                        : String(timestamp)
                )
                : `${index}:${parsedDates.length}:${timestamp}`;

            if (seenDates.has(dedupeValue)) {
                duplicateDates += 1;
                continue;
            }

            seenDates.add(dedupeValue);
            parsedDates.push(timestamp);

            if (countMode === "record") {
                break;
            }
        }

        if (!parsedDates.length) {
            invalidRecords += 1;
            continue;
        }

        validRecords += 1;

        const groupValues = groupBy
            ? fieldValues(record, groupBy)
            : ["all"];

        const normalizedGroups = groupValues.length
            ? groupValues
            : ["unknown"];

        for (const timestamp of parsedDates) {
            validDates += 1;

            const adjustedDate = dateWithOffset(
                timestamp,
                timezoneOffsetMinutes
            );

            const bucketInfo = bucketForDate(
                adjustedDate,
                bucket,
                timezoneOffsetMinutes
            );

            for (const rawGroup of normalizedGroups) {
                const groupName = normalizeText(rawGroup) || "unknown";
                const groupKey = canonicalKey(groupName);

                if (!groups.has(groupKey)) {
                    if (groups.size >= MAX_GROUPS) {
                        throw createError(
                            `Timeline group limit exceeded: ${MAX_GROUPS}.`,
                            "TIMELINE_WORKER_GROUP_LIMIT",
                            "RangeError"
                        );
                    }

                    groups.set(groupKey, {
                        name: groupName,
                        points: new Map()
                    });
                }

                const series = groups.get(groupKey);
                const existing = series.points.get(bucketInfo.key) || {
                    key: bucketInfo.key,
                    start: bucketInfo.start,
                    end: bucketInfo.end,
                    count: 0,
                    records: includeRecords ? [] : undefined,
                    firstTimestamp: timestamp,
                    lastTimestamp: timestamp
                };

                existing.count += 1;
                existing.firstTimestamp = Math.min(
                    existing.firstTimestamp,
                    timestamp
                );
                existing.lastTimestamp = Math.max(
                    existing.lastTimestamp,
                    timestamp
                );

                if (includeRecords) {
                    existing.records.push(record);
                }

                series.points.set(bucketInfo.key, existing);
            }
        }

        if (
            progressEnabled &&
            index > 0 &&
            index % progressInterval === 0
        ) {
            postProgress(
                id,
                "timeline",
                index,
                records.length,
                {
                    groups: groups.size,
                    validRecords,
                    invalidRecords,
                    validDates
                }
            );
        }

        if (index > 0 && index % YIELD_INTERVAL === 0) {
            await yieldToWorker();
        }
    }

    const fill = normalizeBoolean(payload.fill, false);
    const cumulative = normalizeBoolean(
        payload.cumulative,
        false
    );

    const movingAverageWindow = clampInteger(
        payload.movingAverageWindow ??
        payload.moving_average_window,
        0,
        0,
        100000
    );

    const rateUnit = normalizeKey(
        payload.rateUnit ??
        payload.rate_unit ??
        ""
    );

    const explicitFillStart = from !== null
        ? bucketForTimestamp(
            from,
            bucket,
            timezoneOffsetMinutes
        ).start
        : null;

    const explicitFillEnd = to !== null
        ? bucketForTimestamp(
            to,
            bucket,
            timezoneOffsetMinutes
        ).start
        : null;

    const series = [];

    for (const group of groups.values()) {
        assertActive(id);

        let points = [...group.points.values()]
            .sort((left, right) =>
                Date.parse(left.start) -
                Date.parse(right.start)
            );

        if (fill && points.length) {
            points = fillMissingBuckets(
                points,
                bucket,
                includeRecords,
                timezoneOffsetMinutes,
                explicitFillStart,
                explicitFillEnd
            );
        }

        if (cumulative) {
            let total = 0;

            points = points.map(point => {
                total += point.count;

                return {
                    ...point,
                    cumulative: total
                };
            });
        }

        if (movingAverageWindow > 0) {
            points = addMovingAverage(
                points,
                movingAverageWindow
            );
        }

        if (rateUnit) {
            points = addRate(
                points,
                rateUnit
            );
        }

        const total = points.reduce(
            (sum, point) => sum + point.count,
            0
        );

        series.push({
            group: group.name,
            points,
            total,
            minimum:
                points.length
                    ? Math.min(...points.map(point => point.count))
                    : 0,
            maximum:
                points.length
                    ? Math.max(...points.map(point => point.count))
                    : 0,
            average:
                points.length
                    ? total / points.length
                    : 0
        });
    }

    series.sort((left, right) =>
        right.total - left.total ||
        left.group.localeCompare(
            right.group,
            undefined,
            {
                numeric: true,
                sensitivity: "base"
            }
        )
    );

    const flat = groupBy
        ? undefined
        : (series[0]?.points || []);

    const result = {
        field,
        groupBy: groupBy || null,
        bucket,
        timezoneOffsetMinutes,
        countMode,
        records: records.length,
        validRecords,
        invalidRecords,
        validDates,
        excludedDates,
        duplicateDates,
        groups: series.length,
        series,
        timeline: flat,
        range: timelineRange(series),
        summary: summarizeTimeline(series),
        elapsed_ms: now() - startedAt,
        workerVersion: WORKER_VERSION
    };

    if (normalizeBoolean(
        payload.stacked,
        false
    )) {
        result.stacked = stackSeries(series);
    }

    return result;
}

async function calculateRange(payload = {}, id = null) {
    const startedAt = now();
    const records = extractRecords(payload);
    const field = normalizeText(
        payload.field ??
        payload.dateField ??
        payload.date_field ??
        "date"
    );

    let minimum = null;
    let maximum = null;
    let validDates = 0;
    let validRecords = 0;
    let invalidRecords = 0;

    for (let index = 0; index < records.length; index += 1) {
        assertActive(id);

        const values = fieldValues(records[index], field);
        let recordValid = false;

        for (const value of values) {
            const timestamp = parseTimestamp(
                value,
                payload.numericUnit ??
                payload.numeric_unit
            );

            if (timestamp === null) {
                continue;
            }

            recordValid = true;
            validDates += 1;

            minimum =
                minimum === null
                    ? timestamp
                    : Math.min(minimum, timestamp);

            maximum =
                maximum === null
                    ? timestamp
                    : Math.max(maximum, timestamp);
        }

        if (recordValid) {
            validRecords += 1;
        } else {
            invalidRecords += 1;
        }

        if (
            normalizeBoolean(payload.progress, false) &&
            index > 0 &&
            index % DEFAULT_PROGRESS_INTERVAL === 0
        ) {
            postProgress(
                id,
                "range",
                index,
                records.length,
                {
                    validDates,
                    validRecords,
                    invalidRecords
                }
            );
        }

        if (index > 0 && index % YIELD_INTERVAL === 0) {
            await yieldToWorker();
        }
    }

    return {
        field,
        records: records.length,
        validRecords,
        invalidRecords,
        validDates,
        minimum:
            minimum === null
                ? null
                : new Date(minimum).toISOString(),
        maximum:
            maximum === null
                ? null
                : new Date(maximum).toISOString(),
        duration_ms:
            minimum === null ||
            maximum === null
                ? null
                : maximum - minimum,
        elapsed_ms: now() - startedAt,
        workerVersion: WORKER_VERSION
    };
}

async function calculateGaps(payload = {}, id = null) {
    const startedAt = now();
    const records = extractRecords(payload);
    const field = normalizeText(
        payload.field ??
        payload.dateField ??
        payload.date_field ??
        "date"
    );

    const timestamps = [];

    for (let index = 0; index < records.length; index += 1) {
        assertActive(id);

        for (const value of fieldValues(records[index], field)) {
            const timestamp = parseTimestamp(
                value,
                payload.numericUnit ??
                payload.numeric_unit
            );

            if (timestamp !== null) {
                timestamps.push(timestamp);
            }
        }

        if (index > 0 && index % YIELD_INTERVAL === 0) {
            await yieldToWorker();
        }
    }

    timestamps.sort((left, right) => left - right);

    const intervals = [];

    for (let index = 1; index < timestamps.length; index += 1) {
        intervals.push({
            from: new Date(timestamps[index - 1]).toISOString(),
            to: new Date(timestamps[index]).toISOString(),
            duration_ms: timestamps[index] - timestamps[index - 1]
        });
    }

    const minimumGap = intervals.length
        ? Math.min(...intervals.map(item => item.duration_ms))
        : null;

    const maximumGap = intervals.length
        ? Math.max(...intervals.map(item => item.duration_ms))
        : null;

    const averageGap = intervals.length
        ? intervals.reduce(
            (sum, item) => sum + item.duration_ms,
            0
        ) / intervals.length
        : null;

    return {
        field,
        records: records.length,
        timestamps: timestamps.length,
        intervals:
            normalizeBoolean(
                payload.includeIntervals ??
                payload.include_intervals,
                true
            )
                ? intervals
                : undefined,
        minimumGap_ms: minimumGap,
        maximumGap_ms: maximumGap,
        averageGap_ms: averageGap,
        elapsed_ms: now() - startedAt,
        workerVersion: WORKER_VERSION
    };
}

function normalizeBucket(value) {
    const bucket = normalizeKey(value);

    if (!SUPPORTED_BUCKETS.includes(bucket)) {
        throw createError(
            `Unsupported timeline bucket: ${value}`,
            "TIMELINE_WORKER_UNSUPPORTED_BUCKET",
            "TypeError"
        );
    }

    return bucket;
}

function normalizeBoundary(
    value,
    endOfRange,
    timezoneOffsetMinutes = 0
) {
    if (
        value === undefined ||
        value === null ||
        value === ""
    ) {
        return null;
    }

    const timestamp = parseTimestamp(value);

    if (timestamp === null) {
        throw createError(
            `Invalid timeline boundary: ${value}`,
            "TIMELINE_WORKER_INVALID_BOUNDARY",
            "TypeError"
        );
    }

    if (!endOfRange) {
        return timestamp;
    }

    if (
        typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(value)
    ) {
        const adjusted = dateWithOffset(
            timestamp,
            timezoneOffsetMinutes
        );

        adjusted.setUTCHours(23, 59, 59, 999);

        return removeOffset(
            adjusted.getTime(),
            timezoneOffsetMinutes
        );
    }

    return timestamp;
}

function parseTimestamp(value, numericUnit = null) {
    if (value instanceof Date) {
        const timestamp = value.getTime();

        return Number.isFinite(timestamp)
            ? timestamp
            : null;
    }

    if (
        typeof value === "number" &&
        Number.isFinite(value)
    ) {
        const unit = normalizeKey(numericUnit);

        if (unit === "seconds" || unit === "second" || unit === "s") {
            return value * 1000;
        }

        if (
            unit === "microseconds" ||
            unit === "microsecond" ||
            unit === "us"
        ) {
            return value / 1000;
        }

        if (
            unit === "nanoseconds" ||
            unit === "nanosecond" ||
            unit === "ns"
        ) {
            return value / 1000000;
        }

        if (!unit && Math.abs(value) < 100000000000) {
            return value * 1000;
        }

        return value;
    }

    if (typeof value === "string") {
        const trimmed = value.trim();

        if (!trimmed) {
            return null;
        }

        if (/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) {
            return parseTimestamp(Number(trimmed), numericUnit);
        }

        const timestamp = Date.parse(trimmed);

        return Number.isFinite(timestamp)
            ? timestamp
            : null;
    }

    return null;
}

function dateWithOffset(timestamp, offsetMinutes) {
    return new Date(
        timestamp + offsetMinutes * 60000
    );
}

function removeOffset(timestamp, offsetMinutes) {
    return timestamp - offsetMinutes * 60000;
}

function bucketForTimestamp(
    timestamp,
    bucket,
    timezoneOffsetMinutes
) {
    return bucketForDate(
        dateWithOffset(
            timestamp,
            timezoneOffsetMinutes
        ),
        bucket,
        timezoneOffsetMinutes
    );
}

function bucketForDate(
    date,
    bucket,
    timezoneOffsetMinutes = 0
) {
    const start = new Date(date.getTime());

    switch (bucket) {
        case "year":
            start.setUTCMonth(0, 1);
            start.setUTCHours(0, 0, 0, 0);
            break;

        case "quarter": {
            const quarter = Math.floor(
                start.getUTCMonth() / 3
            );

            start.setUTCMonth(quarter * 3, 1);
            start.setUTCHours(0, 0, 0, 0);
            break;
        }

        case "month":
            start.setUTCDate(1);
            start.setUTCHours(0, 0, 0, 0);
            break;

        case "week": {
            start.setUTCHours(0, 0, 0, 0);

            const day = start.getUTCDay();
            const offset =
                day === 0
                    ? -6
                    : 1 - day;

            start.setUTCDate(
                start.getUTCDate() + offset
            );
            break;
        }

        case "day":
            start.setUTCHours(0, 0, 0, 0);
            break;

        case "hour":
            start.setUTCMinutes(0, 0, 0);
            break;

        case "minute":
            start.setUTCSeconds(0, 0);
            break;

        case "second":
            start.setUTCMilliseconds(0);
            break;

        default:
            throw createError(
                `Unsupported timeline bucket: ${bucket}`,
                "TIMELINE_WORKER_UNSUPPORTED_BUCKET"
            );
    }

    const next = addBucket(start, bucket, 1);
    const startUtc = new Date(
        removeOffset(
            start.getTime(),
            timezoneOffsetMinutes
        )
    );

    const nextUtc = new Date(
        removeOffset(
            next.getTime(),
            timezoneOffsetMinutes
        )
    );

    return {
        key: bucketKey(start, bucket),
        start: startUtc.toISOString(),
        end: new Date(
            nextUtc.getTime() - 1
        ).toISOString()
    };
}

function bucketKey(start, bucket) {
    const year = start.getUTCFullYear();
    const month = String(
        start.getUTCMonth() + 1
    ).padStart(2, "0");

    const day = String(
        start.getUTCDate()
    ).padStart(2, "0");

    const hour = String(
        start.getUTCHours()
    ).padStart(2, "0");

    const minute = String(
        start.getUTCMinutes()
    ).padStart(2, "0");

    const second = String(
        start.getUTCSeconds()
    ).padStart(2, "0");

    switch (bucket) {
        case "year":
            return String(year);

        case "quarter":
            return `${year}-Q${
                Math.floor(start.getUTCMonth() / 3) + 1
            }`;

        case "month":
            return `${year}-${month}`;

        case "week": {
            const week = isoWeek(start);

            return `${week.year}-W${String(
                week.week
            ).padStart(2, "0")}`;
        }

        case "day":
            return `${year}-${month}-${day}`;

        case "hour":
            return `${year}-${month}-${day}T${hour}:00`;

        case "minute":
            return `${year}-${month}-${day}T${hour}:${minute}`;

        case "second":
            return `${year}-${month}-${day}T${hour}:${minute}:${second}`;

        default:
            return start.toISOString();
    }
}

function addBucket(date, bucket, amount) {
    const output = new Date(date.getTime());

    switch (bucket) {
        case "year":
            output.setUTCFullYear(
                output.getUTCFullYear() + amount
            );
            break;

        case "quarter":
            output.setUTCMonth(
                output.getUTCMonth() + amount * 3
            );
            break;

        case "month":
            output.setUTCMonth(
                output.getUTCMonth() + amount
            );
            break;

        case "week":
            output.setUTCDate(
                output.getUTCDate() + amount * 7
            );
            break;

        case "day":
            output.setUTCDate(
                output.getUTCDate() + amount
            );
            break;

        case "hour":
            output.setUTCHours(
                output.getUTCHours() + amount
            );
            break;

        case "minute":
            output.setUTCMinutes(
                output.getUTCMinutes() + amount
            );
            break;

        case "second":
            output.setUTCSeconds(
                output.getUTCSeconds() + amount
            );
            break;

        default:
            throw createError(
                `Unsupported timeline bucket: ${bucket}`,
                "TIMELINE_WORKER_UNSUPPORTED_BUCKET"
            );
    }

    return output;
}

function fillMissingBuckets(
    points,
    bucket,
    includeRecords,
    timezoneOffsetMinutes,
    explicitStart = null,
    explicitEnd = null
) {
    if (!points.length) {
        return [];
    }

    const byStart = new Map(
        points.map(point => [
            point.start,
            point
        ])
    );

    const startIso = explicitStart ?? points[0].start;
    const endIso = explicitEnd ?? points.at(-1).start;

    let cursor = dateWithOffset(
        Date.parse(startIso),
        timezoneOffsetMinutes
    );

    const end = Date.parse(endIso);
    const output = [];
    let count = 0;

    while (
        removeOffset(
            cursor.getTime(),
            timezoneOffsetMinutes
        ) <= end
    ) {
        const descriptor = bucketForDate(
            cursor,
            bucket,
            timezoneOffsetMinutes
        );

        output.push(
            byStart.get(descriptor.start) || {
                key: descriptor.key,
                start: descriptor.start,
                end: descriptor.end,
                count: 0,
                records: includeRecords ? [] : undefined,
                firstTimestamp: null,
                lastTimestamp: null
            }
        );

        cursor = addBucket(cursor, bucket, 1);
        count += 1;

        if (count > MAX_BUCKETS) {
            throw createError(
                `Timeline bucket limit exceeded: ${MAX_BUCKETS}.`,
                "TIMELINE_WORKER_BUCKET_LIMIT",
                "RangeError"
            );
        }
    }

    return output;
}

function addMovingAverage(points, windowSize) {
    const output = [];
    const queue = [];
    let sum = 0;

    for (const point of points) {
        queue.push(point.count);
        sum += point.count;

        if (queue.length > windowSize) {
            sum -= queue.shift();
        }

        output.push({
            ...point,
            movingAverage: sum / queue.length,
            movingAverageWindow: queue.length
        });
    }

    return output;
}

function addRate(points, unit) {
    const divisor = rateDivisor(unit);

    return points.map(point => {
        const durationSeconds = Math.max(
            1,
            (
                Date.parse(point.end) -
                Date.parse(point.start) +
                1
            ) / 1000
        );

        return {
            ...point,
            rate:
                point.count /
                (durationSeconds / divisor),
            rateUnit: unit
        };
    });
}

function rateDivisor(unit) {
    switch (unit) {
        case "second":
        case "seconds":
        case "s":
            return 1;

        case "minute":
        case "minutes":
        case "m":
            return 60;

        case "hour":
        case "hours":
        case "h":
            return 3600;

        case "day":
        case "days":
        case "d":
            return 86400;

        default:
            throw createError(
                `Unsupported timeline rate unit: ${unit}`,
                "TIMELINE_WORKER_RATE_UNIT",
                "TypeError"
            );
    }
}

function timelineRange(series) {
    let minimum = null;
    let maximum = null;

    for (const group of series) {
        for (const point of group.points) {
            const start = Date.parse(point.start);
            const end = Date.parse(point.end);

            minimum =
                minimum === null
                    ? start
                    : Math.min(minimum, start);

            maximum =
                maximum === null
                    ? end
                    : Math.max(maximum, end);
        }
    }

    return {
        start:
            minimum === null
                ? null
                : new Date(minimum).toISOString(),
        end:
            maximum === null
                ? null
                : new Date(maximum).toISOString(),
        duration_ms:
            minimum === null ||
            maximum === null
                ? null
                : maximum - minimum
    };
}

function summarizeTimeline(series) {
    const points = series.flatMap(group =>
        group.points
    );

    const total = points.reduce(
        (sum, point) => sum + point.count,
        0
    );

    const nonEmpty = points.filter(
        point => point.count > 0
    );

    return {
        points: points.length,
        nonEmptyPoints: nonEmpty.length,
        emptyPoints: points.length - nonEmpty.length,
        total,
        minimum:
            points.length
                ? Math.min(...points.map(point => point.count))
                : 0,
        maximum:
            points.length
                ? Math.max(...points.map(point => point.count))
                : 0,
        average:
            points.length
                ? total / points.length
                : 0,
        density:
            points.length
                ? nonEmpty.length / points.length
                : 0
    };
}

function stackSeries(series) {
    const buckets = new Map();

    for (const group of series) {
        for (const point of group.points) {
            if (!buckets.has(point.key)) {
                buckets.set(point.key, {
                    key: point.key,
                    start: point.start,
                    end: point.end,
                    total: 0,
                    groups: {}
                });
            }

            const bucket = buckets.get(point.key);
            bucket.groups[group.group] = point.count;
            bucket.total += point.count;
        }
    }

    return [...buckets.values()]
        .sort((left, right) =>
            Date.parse(left.start) -
            Date.parse(right.start)
        );
}

function isoWeek(date) {
    const target = new Date(
        Date.UTC(
            date.getUTCFullYear(),
            date.getUTCMonth(),
            date.getUTCDate()
        )
    );

    const dayNumber =
        (target.getUTCDay() + 6) % 7;

    target.setUTCDate(
        target.getUTCDate() - dayNumber + 3
    );

    const firstThursday = new Date(
        Date.UTC(
            target.getUTCFullYear(),
            0,
            4
        )
    );

    const firstDayNumber =
        (firstThursday.getUTCDay() + 6) % 7;

    firstThursday.setUTCDate(
        firstThursday.getUTCDate() -
        firstDayNumber +
        3
    );

    return {
        year: target.getUTCFullYear(),
        week:
            1 +
            Math.round(
                (target - firstThursday) /
                604800000
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

    if (value !== undefined && value !== null) {
        output.push(value);
    }

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
