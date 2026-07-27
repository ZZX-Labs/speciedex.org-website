/*
========================================================================
Speciedex.org
Terminal ProviderOverlap Module
========================================================================

Provider record-overlap comparison service for SpeciedexTerminal.

Provides:

    • Validated provider-overlap API requests
    • Provider-pair, rank, field, record, threshold, metric, and date filters
    • Normalized overlap comparison records
    • Jaccard, Dice, containment, shared, unique, and coverage metrics
    • Pairwise matrix, provider, rank, metric, and threshold summaries
    • TTL caching and inflight-request deduplication
    • AbortSignal-aware request lifecycle tracking
    • Single-comparison retrieval with cache fallback
    • High-overlap, low-overlap, duplicate, asymmetric, active, and verified views
    • Optional provider-worker overlap, duplicate, and coverage analysis
    • Idempotent service registration and safe teardown
    • Terminal command integration

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "ProviderOverlap";
    const VERSION = "3.0.0";
    const SERVICE_NAME = "provider-overlap";
    const WORKER_NAME = "provider";

    const DEFAULT_LIMIT = 50;
    const MIN_LIMIT = 1;
    const MAX_LIMIT = 1000;
    const DEFAULT_HIGH_THRESHOLD = 0.75;
    const DEFAULT_LOW_THRESHOLD = 0.25;
    const DEFAULT_DUPLICATE_THRESHOLD = 0.99;
    const DEFAULT_ASYMMETRY_THRESHOLD = 0.25;
    const DEFAULT_CACHE_TTL = 60000;
    const MAX_CACHE_ENTRIES = 128;

    const SORT_FIELDS = Object.freeze([
        "jaccard",
        "dice",
        "containment",
        "containment_a",
        "containment_b",
        "asymmetry",
        "shared",
        "unique_a",
        "unique_b",
        "total_a",
        "total_b",
        "union",
        "provider_a",
        "provider_b",
        "rank",
        "metric",
        "status",
        "updated_at",
        "created_at",
        "id"
    ]);

    const FILTER_FIELDS = Object.freeze([
        "provider",
        "provider_a",
        "provider_b",
        "rank",
        "field",
        "record",
        "record_id",
        "metric",
        "comparison",
        "comparison_id",
        "status",
        "region",
        "country",
        "category",
        "type"
    ]);

    const BOOLEAN_FIELDS = Object.freeze([
        "duplicate",
        "asymmetric",
        "active",
        "verified"
    ]);

    const RATIO_FIELDS = Object.freeze([
        ["min_jaccard", "minJaccard"],
        ["max_jaccard", "maxJaccard"],
        ["min_dice", "minDice"],
        ["max_dice", "maxDice"],
        ["min_containment", "minContainment"],
        ["max_containment", "maxContainment"],
        ["min_asymmetry", "minAsymmetry"],
        ["max_asymmetry", "maxAsymmetry"],
        ["threshold", "threshold"]
    ]);

    const COUNT_FIELDS = Object.freeze([
        ["min_shared", "minShared"],
        ["max_shared", "maxShared"],
        ["min_total", "minTotal"],
        ["max_total", "maxTotal"],
        ["min_union", "minUnion"],
        ["max_union", "maxUnion"]
    ]);

    function now() {
        return (
            window.performance &&
            typeof window.performance.now === "function"
        )
            ? window.performance.now()
            : Date.now();
    }

    function dispatch(target, name, detail, options = {}) {
        if (!target || typeof target.dispatchEvent !== "function") {
            return false;
        }

        try {
            return target.dispatchEvent(
                new CustomEvent(name, {
                    bubbles: options.bubbles === true,
                    cancelable: options.cancelable === true,
                    detail
                })
            );
        } catch (_error) {
            return false;
        }
    }

    function createError(message, code, name = "Error") {
        const error = new Error(message);
        error.name = name;
        error.code = code;
        return error;
    }

    function abortError(message = "Provider-overlap request aborted.") {
        return createError(
            message,
            "PROVIDER_OVERLAP_ABORTED",
            "AbortError"
        );
    }

    function throwIfAborted(signal) {
        if (signal?.aborted) {
            throw signal.reason instanceof Error
                ? signal.reason
                : abortError();
        }
    }

    function normalizeText(value) {
        return String(value ?? "").trim();
    }

    function normalizeKey(value) {
        return normalizeText(value).toLowerCase();
    }

    function numericValue(value, fallback = 0) {
        const number = Number(value);
        return Number.isFinite(number) ? number : fallback;
    }

    function clampInteger(value, fallback, minimum, maximum) {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed)) {
            return fallback;
        }
        return Math.min(maximum, Math.max(minimum, parsed));
    }

    function normalizeBoolean(value, fallback = null) {
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

    function normalizeDate(value) {
        const text = normalizeText(value);

        if (!text) {
            return "";
        }

        const timestamp = Date.parse(text);

        if (!Number.isFinite(timestamp)) {
            throw new TypeError(`Invalid date value: ${value}`);
        }

        return new Date(timestamp).toISOString();
    }

    function normalizeRatio(value, fallback = null) {
        const number = Number(value);

        if (!Number.isFinite(number)) {
            return fallback;
        }

        return Math.min(
            1,
            Math.max(
                0,
                number > 1 && number <= 100
                    ? number / 100
                    : number
            )
        );
    }

    function normalizeSort(value) {
        const normalized = normalizeKey(
            value || "jaccard"
        ).replace(/-/g, "_");

        if (!SORT_FIELDS.includes(normalized)) {
            throw new TypeError(
                `Unsupported provider-overlap sort field: ${value}`
            );
        }

        return normalized;
    }

    function normalizeDirection(value) {
        const normalized = normalizeKey(value || "desc");

        if (normalized !== "asc" && normalized !== "desc") {
            throw new TypeError(
                `Unsupported sort direction: ${value}`
            );
        }

        return normalized;
    }

    function validateRange(source, minimumKey, maximumKey, label) {
        if (
            source[minimumKey] !== undefined &&
            source[maximumKey] !== undefined &&
            source[minimumKey] > source[maximumKey]
        ) {
            throw new RangeError(
                `Minimum ${label} must not exceed maximum ${label}.`
            );
        }
    }

    function normalizeParameters(parameters = {}) {
        const source =
            parameters && typeof parameters === "object"
                ? parameters
                : {};

        const normalized = {
            q: normalizeText(
                source.q ??
                source.query ??
                source.search ??
                ""
            ),
            limit: clampInteger(
                source.limit,
                DEFAULT_LIMIT,
                MIN_LIMIT,
                MAX_LIMIT
            ),
            offset: clampInteger(
                source.offset,
                0,
                0,
                Number.MAX_SAFE_INTEGER
            ),
            sort: normalizeSort(source.sort),
            direction: normalizeDirection(
                source.direction ??
                source.order
            )
        };

        for (const field of FILTER_FIELDS) {
            const value = source[field];

            if (
                value !== undefined &&
                value !== null &&
                value !== ""
            ) {
                normalized[field] = normalizeText(value);
            }
        }

        for (const field of BOOLEAN_FIELDS) {
            const value = source[field];

            if (
                value === undefined ||
                value === null ||
                value === ""
            ) {
                continue;
            }

            const parsed = normalizeBoolean(value, null);

            if (parsed === null) {
                throw new TypeError(
                    `Invalid ${field} value: ${value}`
                );
            }

            normalized[field] = parsed;
        }

        for (const [snakeCase, camelCase] of RATIO_FIELDS) {
            const value =
                source[snakeCase] ??
                source[camelCase];

            if (
                value === undefined ||
                value === null ||
                value === ""
            ) {
                continue;
            }

            const parsed = normalizeRatio(value, null);

            if (parsed === null) {
                throw new TypeError(
                    `Invalid ${snakeCase} value: ${value}`
                );
            }

            normalized[snakeCase] = parsed;
        }

        for (const [snakeCase, camelCase] of COUNT_FIELDS) {
            const value =
                source[snakeCase] ??
                source[camelCase];

            if (
                value === undefined ||
                value === null ||
                value === ""
            ) {
                continue;
            }

            normalized[snakeCase] = clampInteger(
                value,
                0,
                0,
                Number.MAX_SAFE_INTEGER
            );
        }

        validateRange(
            normalized,
            "min_jaccard",
            "max_jaccard",
            "Jaccard value"
        );

        validateRange(
            normalized,
            "min_dice",
            "max_dice",
            "Dice value"
        );

        validateRange(
            normalized,
            "min_containment",
            "max_containment",
            "containment value"
        );

        validateRange(
            normalized,
            "min_asymmetry",
            "max_asymmetry",
            "asymmetry value"
        );

        validateRange(
            normalized,
            "min_shared",
            "max_shared",
            "shared count"
        );

        validateRange(
            normalized,
            "min_total",
            "max_total",
            "total count"
        );

        validateRange(
            normalized,
            "min_union",
            "max_union",
            "union count"
        );

        const from =
            source.from ??
            source.since ??
            source.start;

        const to =
            source.to ??
            source.until ??
            source.end;

        if (
            from !== undefined &&
            from !== null &&
            from !== ""
        ) {
            normalized.from = normalizeDate(from);
        }

        if (
            to !== undefined &&
            to !== null &&
            to !== ""
        ) {
            normalized.to = normalizeDate(to);
        }

        if (
            normalized.from &&
            normalized.to &&
            Date.parse(normalized.from) >
            Date.parse(normalized.to)
        ) {
            throw new RangeError(
                "Provider-overlap start date must not be later than the end date."
            );
        }

        return normalized;
    }

    function safeDivide(numerator, denominator) {
        if (
            !Number.isFinite(numerator) ||
            !Number.isFinite(denominator) ||
            denominator <= 0
        ) {
            return 0;
        }

        return numerator / denominator;
    }

    function canonicalPair(providerA, providerB) {
        const left = normalizeText(providerA);
        const right = normalizeText(providerB);

        return left.localeCompare(right) <= 0
            ? [left, right]
            : [right, left];
    }

    function normalizeRecord(record, index = 0) {
        if (!record || typeof record !== "object") {
            return {
                index,
                id: normalizeText(record),
                provider_a: "",
                provider_b: "",
                canonical_provider_a: "",
                canonical_provider_b: "",
                pair: "",
                shared: 0,
                unique_a: 0,
                unique_b: 0,
                total_a: 0,
                total_b: 0,
                union: 0,
                jaccard: 0,
                dice: 0,
                containment_a: 0,
                containment_b: 0,
                containment: 0,
                asymmetry: 0,
                coverage_a: 0,
                coverage_b: 0,
                duplicate: false,
                asymmetric: false,
                active: true,
                verified: false,
                status: "unknown",
                rank: "",
                field: "",
                metric: "jaccard",
                region: "",
                country: "",
                category: "",
                type: "",
                created_at: "",
                updated_at: ""
            };
        }

        const providerA = normalizeText(
            record.provider_a ??
            record.providerA ??
            record.left_provider ??
            record.leftProvider ??
            record.source_provider ??
            record.sourceProvider ??
            ""
        );

        const providerB = normalizeText(
            record.provider_b ??
            record.providerB ??
            record.right_provider ??
            record.rightProvider ??
            record.target_provider ??
            record.targetProvider ??
            ""
        );

        const [canonicalA, canonicalB] =
            canonicalPair(providerA, providerB);

        const shared = Math.max(
            0,
            numericValue(
                record.shared ??
                record.overlap ??
                record.shared_records ??
                record.sharedRecords ??
                record.intersection,
                0
            )
        );

        const statedUniqueA = Math.max(
            0,
            numericValue(
                record.unique_a ??
                record.uniqueA ??
                record.left_unique ??
                record.leftUnique,
                0
            )
        );

        const statedUniqueB = Math.max(
            0,
            numericValue(
                record.unique_b ??
                record.uniqueB ??
                record.right_unique ??
                record.rightUnique,
                0
            )
        );

        const totalA = Math.max(
            shared,
            numericValue(
                record.total_a ??
                record.totalA ??
                record.records_a ??
                record.recordsA ??
                record.left_total ??
                record.leftTotal,
                shared + statedUniqueA
            )
        );

        const totalB = Math.max(
            shared,
            numericValue(
                record.total_b ??
                record.totalB ??
                record.records_b ??
                record.recordsB ??
                record.right_total ??
                record.rightTotal,
                shared + statedUniqueB
            )
        );

        const uniqueA = Math.max(
            0,
            numericValue(
                record.unique_a ??
                record.uniqueA ??
                record.left_unique ??
                record.leftUnique,
                totalA - shared
            )
        );

        const uniqueB = Math.max(
            0,
            numericValue(
                record.unique_b ??
                record.uniqueB ??
                record.right_unique ??
                record.rightUnique,
                totalB - shared
            )
        );

        const union = Math.max(
            shared,
            numericValue(
                record.union ??
                record.union_count ??
                record.unionCount,
                shared + uniqueA + uniqueB
            )
        );

        const jaccard = normalizeRatio(
            record.jaccard ??
            record.jaccard_index ??
            record.jaccardIndex ??
            safeDivide(shared, union),
            0
        );

        const dice = normalizeRatio(
            record.dice ??
            record.dice_coefficient ??
            record.diceCoefficient ??
            safeDivide(2 * shared, totalA + totalB),
            0
        );

        const containmentA = normalizeRatio(
            record.containment_a ??
            record.containmentA ??
            record.left_containment ??
            record.leftContainment ??
            safeDivide(shared, totalA),
            0
        );

        const containmentB = normalizeRatio(
            record.containment_b ??
            record.containmentB ??
            record.right_containment ??
            record.rightContainment ??
            safeDivide(shared, totalB),
            0
        );

        const containment = normalizeRatio(
            record.containment ??
            record.containment_score ??
            record.containmentScore ??
            Math.max(containmentA, containmentB),
            0
        );

        const asymmetry = Math.abs(
            containmentA - containmentB
        );

        const status = normalizeKey(
            record.status ??
            record.state ??
            "active"
        );

        const duplicate =
            normalizeBoolean(
                record.duplicate ??
                record.is_duplicate ??
                record.isDuplicate,
                false
            ) ||
            jaccard >= DEFAULT_DUPLICATE_THRESHOLD;

        const asymmetric =
            normalizeBoolean(
                record.asymmetric ??
                record.is_asymmetric ??
                record.isAsymmetric,
                false
            ) ||
            asymmetry >= DEFAULT_ASYMMETRY_THRESHOLD;

        return {
            ...record,
            index: record.index ?? index,
            id: normalizeText(
                record.id ??
                record.comparison_id ??
                record.comparisonId ??
                record.uuid ??
                `${canonicalA || "provider-a"}::${canonicalB || "provider-b"}`
            ),
            provider_a: providerA,
            provider_b: providerB,
            canonical_provider_a: canonicalA,
            canonical_provider_b: canonicalB,
            pair: `${canonicalA}::${canonicalB}`,
            shared,
            unique_a: uniqueA,
            unique_b: uniqueB,
            total_a: totalA,
            total_b: totalB,
            union,
            jaccard,
            dice,
            containment_a: containmentA,
            containment_b: containmentB,
            containment,
            asymmetry,
            coverage_a: containmentA,
            coverage_b: containmentB,
            duplicate,
            asymmetric,
            active:
                normalizeBoolean(record.active, true) &&
                !["inactive", "deleted", "retired"].includes(status),
            verified:
                normalizeBoolean(record.verified, false) ||
                ["verified", "confirmed"].includes(status),
            status,
            rank: normalizeKey(
                record.rank ??
                record.taxon_rank ??
                record.taxonRank ??
                ""
            ),
            field: normalizeText(
                record.field ??
                record.property ??
                record.attribute ??
                ""
            ),
            metric: normalizeKey(
                record.metric ??
                record.method ??
                "jaccard"
            ),
            region: normalizeText(record.region ?? ""),
            country: normalizeText(record.country ?? ""),
            category: normalizeText(record.category ?? ""),
            type: normalizeText(
                record.type ??
                record.comparison_type ??
                record.comparisonType ??
                ""
            ),
            created_at:
                record.created_at ??
                record.createdAt ??
                "",
            updated_at:
                record.updated_at ??
                record.updatedAt ??
                record.measured_at ??
                record.measuredAt ??
                record.timestamp ??
                ""
        };
    }

    function percentile(values, percentage) {
        const numbers = values
            .map(Number)
            .filter(Number.isFinite)
            .sort((left, right) => left - right);

        if (!numbers.length) {
            return null;
        }

        if (numbers.length === 1) {
            return numbers[0];
        }

        const position =
            (numbers.length - 1) * percentage;

        const lower = Math.floor(position);
        const upper = Math.ceil(position);

        if (lower === upper) {
            return numbers[lower];
        }

        const weight = position - lower;

        return (
            numbers[lower] * (1 - weight) +
            numbers[upper] * weight
        );
    }

    function metricSummary(values) {
        const numbers = values
            .map(Number)
            .filter(Number.isFinite);

        if (!numbers.length) {
            return {
                count: 0,
                minimum: null,
                maximum: null,
                average: null,
                median: null,
                p75: null,
                p90: null,
                p95: null,
                p99: null,
                standardDeviation: null
            };
        }

        const average =
            numbers.reduce(
                (sum, value) => sum + value,
                0
            ) / numbers.length;

        const variance =
            numbers.reduce(
                (sum, value) =>
                    sum + Math.pow(value - average, 2),
                0
            ) / numbers.length;

        return {
            count: numbers.length,
            minimum: Math.min(...numbers),
            maximum: Math.max(...numbers),
            average,
            median: percentile(numbers, 0.5),
            p75: percentile(numbers, 0.75),
            p90: percentile(numbers, 0.9),
            p95: percentile(numbers, 0.95),
            p99: percentile(numbers, 0.99),
            standardDeviation: Math.sqrt(variance)
        };
    }

    function incrementMap(map, value) {
        const key = normalizeText(value) || "unknown";
        map.set(key, (map.get(key) || 0) + 1);
    }

    function sortedObject(map) {
        return Object.fromEntries(
            [...map.entries()].sort((left, right) =>
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
        );
    }

    function buildMatrix(records, metric = "jaccard") {
        const matrix = {};

        for (const item of records) {
            const providerA = item.provider_a || "unknown";
            const providerB = item.provider_b || "unknown";

            matrix[providerA] = matrix[providerA] || {};
            matrix[providerB] = matrix[providerB] || {};

            matrix[providerA][providerA] = {
                shared: item.total_a,
                jaccard: 1,
                dice: 1,
                containment: 1,
                coverage: 1,
                value: 1
            };

            matrix[providerB][providerB] = {
                shared: item.total_b,
                jaccard: 1,
                dice: 1,
                containment: 1,
                coverage: 1,
                value: 1
            };

            matrix[providerA][providerB] = {
                shared: item.shared,
                jaccard: item.jaccard,
                dice: item.dice,
                containment: item.containment,
                coverage: item.coverage_a,
                value: numericValue(item[metric], item.jaccard)
            };

            matrix[providerB][providerA] = {
                shared: item.shared,
                jaccard: item.jaccard,
                dice: item.dice,
                containment: item.containment,
                coverage: item.coverage_b,
                value: numericValue(item[metric], item.jaccard)
            };
        }

        return matrix;
    }

    function summarize(records) {
        const values = Array.isArray(records)
            ? records
            : [];

        const providers = new Map();
        const ranks = new Map();
        const metrics = new Map();
        const statuses = new Map();
        const categories = new Map();
        const regions = new Map();
        const countries = new Map();

        let shared = 0;
        let uniqueA = 0;
        let uniqueB = 0;
        let union = 0;

        for (const item of values) {
            incrementMap(providers, item.provider_a);
            incrementMap(providers, item.provider_b);
            incrementMap(ranks, item.rank);
            incrementMap(metrics, item.metric);
            incrementMap(statuses, item.status);
            incrementMap(categories, item.category);
            incrementMap(regions, item.region);
            incrementMap(countries, item.country);

            shared += numericValue(item.shared, 0);
            uniqueA += numericValue(item.unique_a, 0);
            uniqueB += numericValue(item.unique_b, 0);
            union += numericValue(item.union, 0);
        }

        const duplicate = values.filter(
            item => item.duplicate
        ).length;

        const asymmetric = values.filter(
            item => item.asymmetric
        ).length;

        const verified = values.filter(
            item => item.verified
        ).length;

        return {
            total: values.length,
            active: values.filter(item => item.active).length,
            verified,
            unverified: values.length - verified,
            duplicate,
            asymmetric,
            duplicateRate:
                values.length
                    ? duplicate / values.length
                    : 0,
            asymmetryRate:
                values.length
                    ? asymmetric / values.length
                    : 0,
            shared,
            uniqueA,
            uniqueB,
            union,
            jaccard: metricSummary(
                values.map(item => item.jaccard)
            ),
            dice: metricSummary(
                values.map(item => item.dice)
            ),
            containment: metricSummary(
                values.map(item => item.containment)
            ),
            containmentA: metricSummary(
                values.map(item => item.containment_a)
            ),
            containmentB: metricSummary(
                values.map(item => item.containment_b)
            ),
            asymmetry: metricSummary(
                values.map(item => item.asymmetry)
            ),
            sharedCounts: metricSummary(
                values.map(item => item.shared)
            ),
            totalA: metricSummary(
                values.map(item => item.total_a)
            ),
            totalB: metricSummary(
                values.map(item => item.total_b)
            ),
            unionCounts: metricSummary(
                values.map(item => item.union)
            ),
            providers: sortedObject(providers),
            ranks: sortedObject(ranks),
            metrics: sortedObject(metrics),
            statuses: sortedObject(statuses),
            categories: sortedObject(categories),
            regions: sortedObject(regions),
            countries: sortedObject(countries),
            matrix: buildMatrix(values)
        };
    }

    function enrichPagination(result) {
        const limit = Math.max(
            0,
            numericValue(result.limit, 0)
        );

        const offset = Math.max(
            0,
            numericValue(result.offset, 0)
        );

        const total = Math.max(
            0,
            numericValue(result.total, 0)
        );

        const returned = result.records.length;

        return {
            ...result,
            returned,
            page:
                limit > 0
                    ? Math.floor(offset / limit) + 1
                    : 1,
            pages:
                limit > 0
                    ? Math.ceil(total / limit)
                    : (total > 0 ? 1 : 0),
            hasPrevious: offset > 0,
            hasNext: offset + returned < total
        };
    }

    function normalizeResponse(payload) {
        if (Array.isArray(payload)) {
            const records = payload.map(normalizeRecord);

            return enrichPagination({
                records,
                total: records.length,
                limit: records.length,
                offset: 0,
                summary: summarize(records),
                raw: payload
            });
        }

        if (payload && typeof payload === "object") {
            const values =
                payload.records ??
                payload.items ??
                payload.overlap ??
                payload.comparisons ??
                payload.results ??
                payload.rows ??
                payload.data ??
                [];

            const records = Array.isArray(values)
                ? values.map(normalizeRecord)
                : [];

            return enrichPagination({
                records,
                total:
                    Number.isFinite(Number(payload.total))
                        ? Number(payload.total)
                        : records.length,
                limit:
                    Number.isFinite(Number(payload.limit))
                        ? Number(payload.limit)
                        : records.length,
                offset:
                    Number.isFinite(Number(payload.offset))
                        ? Number(payload.offset)
                        : 0,
                summary:
                    payload.summary &&
                    typeof payload.summary === "object"
                        ? {
                            ...summarize(records),
                            ...payload.summary
                        }
                        : summarize(records),
                next:
                    payload.next ??
                    payload.nextPage ??
                    payload.next_page ??
                    null,
                previous:
                    payload.previous ??
                    payload.previousPage ??
                    payload.previous_page ??
                    null,
                raw: payload
            });
        }

        return enrichPagination({
            records: [],
            total: 0,
            limit: 0,
            offset: 0,
            summary: summarize([]),
            raw: payload
        });
    }

    function stableStringify(value) {
        if (value === null || typeof value !== "object") {
            return JSON.stringify(value);
        }

        if (Array.isArray(value)) {
            return `[${value.map(stableStringify).join(",")}]`;
        }

        return `{${Object.keys(value)
            .sort()
            .map(key =>
                `${JSON.stringify(key)}:${stableStringify(value[key])}`
            )
            .join(",")}}`;
    }

    function cacheKey(parameters) {
        return stableStringify(parameters);
    }

    function clone(value) {
        if (typeof structuredClone === "function") {
            try {
                return structuredClone(value);
            } catch (_error) {
                /* Fall through. */
            }
        }

        return JSON.parse(JSON.stringify(value));
    }

    class ProviderOverlapService extends EventTarget {
        constructor(context, options = {}) {
            super();

            if (!context || typeof context !== "object") {
                throw new TypeError(
                    "A terminal context is required."
                );
            }

            this.context = context;
            this.destroyed = false;
            this.cache = new Map();
            this.inflight = new Map();
            this.requests = new Map();
            this.sequence = 0;
            this.cacheTTL = clampInteger(
                options.cacheTTL ??
                options.cache_ttl,
                DEFAULT_CACHE_TTL,
                0,
                Number.MAX_SAFE_INTEGER
            );
            this.workerName = normalizeText(
                options.workerName ??
                options.worker_name ??
                WORKER_NAME
            );
        }

        ensureAvailable() {
            if (this.destroyed) {
                throw createError(
                    "Provider-overlap service has been destroyed.",
                    "PROVIDER_OVERLAP_DESTROYED"
                );
            }

            if (
                !this.context.api ||
                typeof this.context.api.get !== "function"
            ) {
                throw createError(
                    "Speciedex API client is unavailable.",
                    "PROVIDER_OVERLAP_API_UNAVAILABLE"
                );
            }
        }

        emit(name, detail) {
            dispatch(this, name, detail);

            try {
                this.context.events?.emit?.(
                    `provider-overlap:${name}`,
                    detail
                );
            } catch (_error) {
                /* Observer failures are isolated. */
            }

            dispatch(
                this.context.root,
                `speciedex:terminal-provider-overlap-${name}`,
                detail,
                { bubbles: true }
            );
        }

        createRequest(operation, detail = {}) {
            const id =
                `provider-overlap:${Date.now()}:${++this.sequence}`;

            const request = {
                id,
                operation,
                startedAt: now(),
                timestamp: new Date().toISOString(),
                ...detail
            };

            this.requests.set(id, request);
            return request;
        }

        finishRequest(request, result, error = null) {
            request.duration = now() - request.startedAt;
            request.completedAt = new Date().toISOString();
            request.error = error || null;
            request.result = result;
            this.requests.delete(request.id);
            return request;
        }

        getCached(parameters, options = {}) {
            const key = cacheKey(parameters);
            const entry = this.cache.get(key);

            if (!entry) {
                return null;
            }

            const ttl = clampInteger(
                options.cacheTTL ??
                options.cache_ttl,
                this.cacheTTL,
                0,
                Number.MAX_SAFE_INTEGER
            );

            if (
                ttl > 0 &&
                Date.now() - entry.timestamp > ttl
            ) {
                this.cache.delete(key);
                return null;
            }

            entry.hits += 1;
            entry.lastAccessed = Date.now();

            return clone(entry.value);
        }

        setCached(parameters, value) {
            const key = cacheKey(parameters);

            this.cache.set(key, {
                timestamp: Date.now(),
                lastAccessed: Date.now(),
                hits: 0,
                value: clone(value)
            });

            if (this.cache.size > MAX_CACHE_ENTRIES) {
                const oldest = [...this.cache.entries()]
                    .sort((left, right) =>
                        left[1].lastAccessed -
                        right[1].lastAccessed
                    )[0];

                if (oldest) {
                    this.cache.delete(oldest[0]);
                }
            }
        }

        clearCache() {
            const entries = this.cache.size;
            this.cache.clear();

            this.emit("cache-clear", {
                entries,
                timestamp: new Date().toISOString()
            });

            return entries;
        }

        async list(parameters = {}, options = {}) {
            this.ensureAvailable();

            const normalized = normalizeParameters(parameters);
            const signal = options.signal;
            const force = normalizeBoolean(
                options.force ??
                options.refresh,
                false
            );

            throwIfAborted(signal);

            if (!force) {
                const cached = this.getCached(
                    normalized,
                    options
                );

                if (cached) {
                    cached.cache = {
                        hit: true,
                        timestamp: new Date().toISOString()
                    };

                    this.emit("cache-hit", {
                        operation: "list",
                        parameters: normalized
                    });

                    return cached;
                }
            }

            const key = cacheKey(normalized);

            if (!force && this.inflight.has(key)) {
                return this.awaitWithSignal(
                    this.inflight.get(key),
                    signal
                );
            }

            const request = this.createRequest(
                "list",
                { parameters: normalized }
            );

            this.emit("request", {
                requestId: request.id,
                operation: "list",
                parameters: normalized
            });

            const operation = this.performList(
                normalized,
                options,
                request
            );

            this.inflight.set(key, operation);

            try {
                return await this.awaitWithSignal(
                    operation,
                    signal
                );
            } finally {
                if (this.inflight.get(key) === operation) {
                    this.inflight.delete(key);
                }
            }
        }

        async performList(normalized, options, request) {
            try {
                const payload = await this.context.api.get(
                    "providers/overlap",
                    normalized,
                    options
                );

                const result = normalizeResponse(payload);

                result.parameters = normalized;
                result.duration = now() - request.startedAt;
                result.cache = {
                    hit: false,
                    timestamp: new Date().toISOString()
                };

                this.setCached(normalized, result);
                this.finishRequest(request, result);

                this.emit("complete", {
                    requestId: request.id,
                    ...result
                });

                return result;
            } catch (error) {
                this.finishRequest(request, null, error);

                this.emit("error", {
                    requestId: request.id,
                    operation: "list",
                    error,
                    parameters: normalized,
                    duration: request.duration
                });

                throw error;
            }
        }

        awaitWithSignal(promise, signal) {
            if (!signal) {
                return promise;
            }

            throwIfAborted(signal);

            return new Promise((resolve, reject) => {
                const onAbort = () => {
                    reject(
                        signal.reason instanceof Error
                            ? signal.reason
                            : abortError()
                    );
                };

                signal.addEventListener(
                    "abort",
                    onAbort,
                    { once: true }
                );

                promise.then(
                    value => {
                        signal.removeEventListener(
                            "abort",
                            onAbort
                        );
                        resolve(value);
                    },
                    error => {
                        signal.removeEventListener(
                            "abort",
                            onAbort
                        );
                        reject(error);
                    }
                );
            });
        }

        async get(id, options = {}) {
            this.ensureAvailable();

            const normalizedId = normalizeText(id);

            if (!normalizedId) {
                throw new TypeError(
                    "An overlap comparison ID is required."
                );
            }

            throwIfAborted(options.signal);

            const request = this.createRequest(
                "get",
                { comparison: normalizedId }
            );

            this.emit("request", {
                requestId: request.id,
                operation: "get",
                comparison: normalizedId
            });

            try {
                const payload = await this.context.api.get(
                    `providers/overlap/${encodeURIComponent(normalizedId)}`,
                    {},
                    options
                );

                const item = normalizeRecord(payload, 0);

                this.finishRequest(request, item);

                this.emit("complete", {
                    requestId: request.id,
                    operation: "get",
                    comparison: item
                });

                return item;
            } catch (error) {
                const match = this.findCachedComparison(
                    normalizedId
                );

                if (match) {
                    this.finishRequest(request, match);

                    this.emit("fallback", {
                        requestId: request.id,
                        operation: "get",
                        comparison: match,
                        error
                    });

                    return match;
                }

                this.finishRequest(request, null, error);

                this.emit("error", {
                    requestId: request.id,
                    operation: "get",
                    comparison: normalizedId,
                    error
                });

                throw error;
            }
        }

        findCachedComparison(id) {
            const normalizedId = normalizeKey(id);

            for (const entry of this.cache.values()) {
                const match = entry.value?.records?.find(
                    item =>
                        normalizeKey(item.id) === normalizedId ||
                        normalizeKey(item.pair) === normalizedId
                );

                if (match) {
                    return clone(match);
                }
            }

            return null;
        }

        async compare(
            providerA,
            providerB,
            parameters = {},
            options = {}
        ) {
            const left = normalizeText(providerA);
            const right = normalizeText(providerB);

            if (!left || !right) {
                throw new TypeError(
                    "Two provider IDs or names are required."
                );
            }

            const result = await this.list(
                {
                    ...parameters,
                    provider_a: left,
                    provider_b: right
                },
                options
            );

            const [canonicalA, canonicalB] =
                canonicalPair(left, right);

            const match = result.records.find(
                item =>
                    item.canonical_provider_a === canonicalA &&
                    item.canonical_provider_b === canonicalB
            );

            return match || result;
        }

        async high(
            threshold = DEFAULT_HIGH_THRESHOLD,
            parameters = {},
            options = {}
        ) {
            const normalizedThreshold =
                normalizeRatio(
                    threshold,
                    DEFAULT_HIGH_THRESHOLD
                );

            return this.filteredView(
                {
                    ...parameters,
                    min_jaccard: normalizedThreshold,
                    threshold: normalizedThreshold
                },
                item => item.jaccard >= normalizedThreshold,
                options,
                { threshold: normalizedThreshold }
            );
        }

        async low(
            threshold = DEFAULT_LOW_THRESHOLD,
            parameters = {},
            options = {}
        ) {
            const normalizedThreshold =
                normalizeRatio(
                    threshold,
                    DEFAULT_LOW_THRESHOLD
                );

            return this.filteredView(
                {
                    ...parameters,
                    max_jaccard: normalizedThreshold,
                    threshold: normalizedThreshold
                },
                item => item.jaccard <= normalizedThreshold,
                options,
                { threshold: normalizedThreshold }
            );
        }

        async duplicates(parameters = {}, options = {}) {
            const threshold =
                normalizeRatio(
                    parameters.min_jaccard ??
                    parameters.minJaccard ??
                    DEFAULT_DUPLICATE_THRESHOLD,
                    DEFAULT_DUPLICATE_THRESHOLD
                );

            return this.filteredView(
                {
                    ...parameters,
                    duplicate: true,
                    min_jaccard: threshold
                },
                item =>
                    item.duplicate ||
                    item.jaccard >= threshold,
                options,
                { threshold }
            );
        }

        async asymmetric(parameters = {}, options = {}) {
            const threshold =
                normalizeRatio(
                    parameters.min_asymmetry ??
                    parameters.minAsymmetry ??
                    DEFAULT_ASYMMETRY_THRESHOLD,
                    DEFAULT_ASYMMETRY_THRESHOLD
                );

            return this.filteredView(
                {
                    ...parameters,
                    asymmetric: true,
                    min_asymmetry: threshold
                },
                item =>
                    item.asymmetric ||
                    item.asymmetry >= threshold,
                options,
                { threshold }
            );
        }

        async active(parameters = {}, options = {}) {
            return this.filteredView(
                {
                    ...parameters,
                    active: true
                },
                item => item.active,
                options
            );
        }

        async verified(parameters = {}, options = {}) {
            return this.filteredView(
                {
                    ...parameters,
                    verified: true
                },
                item => item.verified,
                options
            );
        }

        async filteredView(
            parameters,
            predicate,
            options,
            extra = {}
        ) {
            const result = await this.list(
                parameters,
                options
            );

            const records = result.records.filter(predicate);

            return {
                ...result,
                ...extra,
                records,
                returned: records.length,
                summary: summarize(records)
            };
        }

        async matrix(parameters = {}, options = {}) {
            const result = await this.list(
                {
                    ...parameters,
                    limit:
                        parameters.limit ??
                        MAX_LIMIT
                },
                options
            );

            const metric = normalizeKey(
                parameters.metric ??
                "jaccard"
            );

            return {
                parameters: result.parameters,
                metric,
                providers: [
                    ...new Set(
                        result.records
                            .flatMap(item => [
                                item.provider_a,
                                item.provider_b
                            ])
                            .filter(Boolean)
                    )
                ].sort(),
                matrix: buildMatrix(
                    result.records,
                    metric
                ),
                summary: summarize(result.records),
                duration: result.duration,
                cache: result.cache
            };
        }

        async summary(parameters = {}, options = {}) {
            const result = await this.list(
                {
                    ...parameters,
                    limit:
                        parameters.limit ??
                        MAX_LIMIT
                },
                options
            );

            return {
                parameters: result.parameters,
                summary: summarize(result.records),
                comparisons: result.records,
                duration: result.duration,
                cache: result.cache
            };
        }

        async workerOverlap(parameters = {}, options = {}) {
            const result = await this.list(
                {
                    ...parameters,
                    limit:
                        parameters.limit ??
                        MAX_LIMIT
                },
                options
            );

            return this.callWorker(
                "overlap",
                {
                    records: result.records
                },
                options
            );
        }

        async workerDuplicates(parameters = {}, options = {}) {
            const result = await this.list(
                {
                    ...parameters,
                    limit:
                        parameters.limit ??
                        MAX_LIMIT
                },
                options
            );

            return this.callWorker(
                "duplicates",
                {
                    records: result.records,
                    fields: [
                        "canonical_provider_a",
                        "canonical_provider_b",
                        "rank",
                        "field"
                    ]
                },
                options
            );
        }

        async coverage(parameters = {}, options = {}) {
            const result = await this.list(
                {
                    ...parameters,
                    limit:
                        parameters.limit ??
                        MAX_LIMIT
                },
                options
            );

            return this.callWorker(
                "coverage",
                {
                    providers: summarizeByProvider(
                        result.records
                    )
                },
                options
            );
        }

        async callWorker(type, payload, options = {}) {
            const workers =
                this.context.workers ??
                this.context.workerPool ??
                this.context.worker_pool;

            const candidates = [
                () => workers?.request?.(
                    this.workerName,
                    type,
                    payload,
                    options
                ),
                () => workers?.run?.(
                    this.workerName,
                    type,
                    payload,
                    options
                ),
                () => workers?.execute?.(
                    this.workerName,
                    type,
                    payload,
                    options
                ),
                () => workers?.call?.(
                    this.workerName,
                    type,
                    payload,
                    options
                ),
                () => this.context.services
                    ?.get?.("workers")
                    ?.request?.(
                        this.workerName,
                        type,
                        payload,
                        options
                    )
            ];

            for (const candidate of candidates) {
                try {
                    const result = candidate();

                    if (
                        result &&
                        typeof result.then === "function"
                    ) {
                        return await result;
                    }

                    if (result !== undefined) {
                        return result;
                    }
                } catch (error) {
                    if (error?.code === "WORKER_UNAVAILABLE") {
                        continue;
                    }

                    throw error;
                }
            }

            throw createError(
                "Provider worker service is unavailable.",
                "PROVIDER_OVERLAP_WORKER_UNAVAILABLE"
            );
        }

        status() {
            return {
                version: VERSION,
                endpoint: "providers/overlap",
                service: SERVICE_NAME,
                worker: this.workerName,
                available: Boolean(
                    this.context.api &&
                    typeof this.context.api.get === "function"
                ),
                workerAvailable: Boolean(
                    this.context.workers ||
                    this.context.workerPool ||
                    this.context.worker_pool ||
                    this.context.services?.get?.("workers")
                ),
                cacheEntries: this.cache.size,
                cacheTTL: this.cacheTTL,
                inflight: this.inflight.size,
                activeRequests: this.requests.size,
                destroyed: this.destroyed
            };
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            const detail = {
                timestamp: new Date().toISOString(),
                cacheEntries: this.cache.size,
                inflight: this.inflight.size,
                activeRequests: this.requests.size
            };

            this.cache.clear();
            this.inflight.clear();
            this.requests.clear();
            this.destroyed = true;

            dispatch(this, "destroy", detail);

            try {
                this.context.unregisterService?.(
                    SERVICE_NAME
                );

                this.context.unregisterService?.(
                    "providerOverlap"
                );
            } catch (_error) {
                /* Teardown must remain safe. */
            }

            return true;
        }
    }

    function summarizeByProvider(records) {
        const providers = new Map();

        for (const item of records) {
            for (
                const [
                    id,
                    peer,
                    total,
                    coverage,
                    unique
                ] of
                [
                    [
                        item.provider_a,
                        item.provider_b,
                        item.total_a,
                        item.coverage_a,
                        item.unique_a
                    ],
                    [
                        item.provider_b,
                        item.provider_a,
                        item.total_b,
                        item.coverage_b,
                        item.unique_b
                    ]
                ]
            ) {
                const key = id || "unknown";

                if (!providers.has(key)) {
                    providers.set(key, {
                        id: key,
                        name: key,
                        comparisons: 0,
                        peers: new Set(),
                        records: 0,
                        shared: 0,
                        unique: 0,
                        coverage: 0,
                        averageCoverage: 0
                    });
                }

                const provider = providers.get(key);

                provider.comparisons += 1;
                provider.peers.add(peer || "unknown");
                provider.records += numericValue(total, 0);
                provider.shared += numericValue(item.shared, 0);
                provider.unique += numericValue(unique, 0);
                provider.coverage += numericValue(coverage, 0);
            }
        }

        return [...providers.values()].map(provider => ({
            ...provider,
            peers: [...provider.peers].sort(),
            averageCoverage:
                provider.comparisons > 0
                    ? provider.coverage /
                      provider.comparisons
                    : 0
        }));
    }

    function initialize(context, options = {}) {
        if (!context || typeof context !== "object") {
            throw new TypeError(
                "A terminal context is required."
            );
        }

        const existing =
            context.services?.get?.(SERVICE_NAME);

        if (
            existing instanceof ProviderOverlapService &&
            !existing.destroyed
        ) {
            context.providerOverlap = existing;
            return existing;
        }

        if (
            context.providerOverlap instanceof ProviderOverlapService &&
            !context.providerOverlap.destroyed
        ) {
            return context.providerOverlap;
        }

        const service = new ProviderOverlapService(
            context,
            options
        );

        context.providerOverlap = service;

        context.registerService?.(
            SERVICE_NAME,
            service
        );

        context.registerService?.(
            "providerOverlap",
            service
        );

        dispatch(
            document,
            "speciedex:terminal-provider-overlap-ready",
            {
                context,
                service,
                version: VERSION
            }
        );

        return service;
    }

    function unmount(context) {
        const service =
            context?.providerOverlap ??
            context?.services?.get?.(SERVICE_NAME);

        if (!(service instanceof ProviderOverlapService)) {
            return false;
        }

        const destroyed = service.destroy();

        if (context?.providerOverlap === service) {
            context.providerOverlap = null;
        }

        return destroyed;
    }

    function requireService(context) {
        const service =
            context?.providerOverlap ??
            context?.services?.get?.(SERVICE_NAME);

        if (!(service instanceof ProviderOverlapService)) {
            throw createError(
                "Provider-overlap service is unavailable.",
                "PROVIDER_OVERLAP_SERVICE_UNAVAILABLE"
            );
        }

        return service;
    }

    function parseCommandArguments(args = []) {
        const parameters = {};
        const positional = [];

        for (let index = 0; index < args.length; index += 1) {
            const argument = normalizeText(args[index]);

            if (!argument) {
                continue;
            }

            const booleanFlags = {
                "--duplicate": ["duplicate", true],
                "--not-duplicate": ["duplicate", false],
                "--asymmetric": ["asymmetric", true],
                "--symmetric": ["asymmetric", false],
                "--active": ["active", true],
                "--inactive": ["active", false],
                "--verified": ["verified", true],
                "--unverified": ["verified", false]
            };

            if (booleanFlags[argument]) {
                const [field, value] = booleanFlags[argument];
                parameters[field] = value;
                continue;
            }

            if (argument.startsWith("--")) {
                const equals = argument.indexOf("=");
                let name;
                let value;

                if (equals >= 0) {
                    name = argument.slice(2, equals);
                    value = argument.slice(equals + 1);
                } else {
                    name = argument.slice(2);
                    value = args[index + 1];

                    if (
                        value !== undefined &&
                        !String(value).startsWith("--")
                    ) {
                        index += 1;
                    } else {
                        value = "";
                    }
                }

                const normalizedName = name.replace(/-/g, "_");

                const aliases = {
                    query: "q",
                    order: "direction",
                    since: "from",
                    start: "from",
                    until: "to",
                    end: "to",
                    minjaccard: "min_jaccard",
                    maxjaccard: "max_jaccard",
                    mindice: "min_dice",
                    maxdice: "max_dice",
                    mincontainment: "min_containment",
                    maxcontainment: "max_containment",
                    minasymmetry: "min_asymmetry",
                    maxasymmetry: "max_asymmetry",
                    minshared: "min_shared",
                    maxshared: "max_shared",
                    mintotal: "min_total",
                    maxtotal: "max_total",
                    minunion: "min_union",
                    maxunion: "max_union"
                };

                parameters[
                    aliases[normalizedName] ??
                    normalizedName
                ] = value;

                continue;
            }

            positional.push(argument);
        }

        if (positional.length) {
            parameters.q = positional[0];
        }

        if (positional[1] !== undefined) {
            parameters.limit = positional[1];
        }

        return normalizeParameters(parameters);
    }

    function writeJSONValue(writeJSON, value) {
        if (typeof writeJSON === "function") {
            return writeJSON(value);
        }

        return value;
    }

    const commands = [
        {
            name: "provider-overlap",
            aliases: ["providers-overlap"],
            category: "providers",
            description:
                "Compare record overlap between providers.",
            usage:
                "provider-overlap [query] [limit] [--provider=ID] [--provider-a=ID] [--provider-b=ID] [--rank=RANK] [--field=FIELD] [--record=ID] [--metric=METRIC] [--comparison=ID] [--status=STATUS] [--region=REGION] [--country=COUNTRY] [--category=CATEGORY] [--type=TYPE] [--duplicate|--not-duplicate] [--asymmetric|--symmetric] [--active|--inactive] [--verified|--unverified] [--min-jaccard=N] [--max-jaccard=N] [--min-dice=N] [--max-dice=N] [--min-containment=N] [--max-containment=N] [--min-asymmetry=N] [--max-asymmetry=N] [--min-shared=N] [--max-shared=N] [--min-total=N] [--max-total=N] [--min-union=N] [--max-union=N] [--from=DATE] [--to=DATE] [--sort=FIELD] [--direction=asc|desc] [--offset=N]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).list(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "provider-overlap-get",
            aliases: ["provider-overlap-comparison"],
            category: "providers",
            description:
                "Retrieve one provider-overlap comparison by ID or canonical pair.",
            usage:
                "provider-overlap-get <id|provider-a::provider-b>",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error(
                        "An overlap comparison ID is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).get(
                        id,
                        { signal }
                    )
                );
            }
        },
        {
            name: "provider-overlap-compare",
            aliases: ["compare-providers"],
            category: "providers",
            description:
                "Compare overlap between two providers.",
            usage:
                "provider-overlap-compare <provider-a> <provider-b> [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) => {
                if (args.length < 2) {
                    throw new Error(
                        "Two provider IDs or names are required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).compare(
                        args[0],
                        args[1],
                        parseCommandArguments(args.slice(2)),
                        { signal }
                    )
                );
            }
        },
        {
            name: "provider-overlap-high",
            aliases: ["high-provider-overlap"],
            category: "providers",
            description:
                "List provider comparisons at or above a Jaccard threshold.",
            usage:
                "provider-overlap-high [threshold] [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) => {
                let threshold = DEFAULT_HIGH_THRESHOLD;
                let filters = args;

                if (
                    args.length &&
                    !String(args[0]).startsWith("--") &&
                    Number.isFinite(Number(args[0]))
                ) {
                    threshold = Number(args[0]);
                    filters = args.slice(1);
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).high(
                        threshold,
                        parseCommandArguments(filters),
                        { signal }
                    )
                );
            }
        },
        {
            name: "provider-overlap-low",
            aliases: ["low-provider-overlap"],
            category: "providers",
            description:
                "List provider comparisons at or below a Jaccard threshold.",
            usage:
                "provider-overlap-low [threshold] [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) => {
                let threshold = DEFAULT_LOW_THRESHOLD;
                let filters = args;

                if (
                    args.length &&
                    !String(args[0]).startsWith("--") &&
                    Number.isFinite(Number(args[0]))
                ) {
                    threshold = Number(args[0]);
                    filters = args.slice(1);
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).low(
                        threshold,
                        parseCommandArguments(filters),
                        { signal }
                    )
                );
            }
        },
        {
            name: "provider-overlap-duplicates",
            aliases: ["duplicate-provider-overlap"],
            category: "providers",
            description:
                "List near-duplicate provider comparisons.",
            usage:
                "provider-overlap-duplicates [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).duplicates(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "provider-overlap-asymmetric",
            aliases: ["asymmetric-provider-overlap"],
            category: "providers",
            description:
                "List comparisons with asymmetric containment.",
            usage:
                "provider-overlap-asymmetric [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).asymmetric(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "provider-overlap-matrix",
            aliases: ["provider-similarity-matrix"],
            category: "providers",
            description:
                "Build a pairwise provider-overlap matrix.",
            usage:
                "provider-overlap-matrix [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).matrix(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "provider-overlap-summary",
            aliases: ["provider-similarity-summary"],
            category: "providers",
            description:
                "Summarize overlap, similarity, containment, duplication, asymmetry, ranks, metrics, and matrix values.",
            usage:
                "provider-overlap-summary [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).summary(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "provider-overlap-worker",
            aliases: ["provider-overlap-analyze"],
            category: "providers",
            description:
                "Analyze provider overlap using the provider worker.",
            usage:
                "provider-overlap-worker [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).workerOverlap(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "provider-overlap-coverage",
            aliases: ["provider-overlap-provider-coverage"],
            category: "providers",
            description:
                "Analyze provider coverage using overlap comparisons.",
            usage:
                "provider-overlap-coverage [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).coverage(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "provider-overlap-cache-clear",
            aliases: ["provider-similarity-cache-clear"],
            category: "providers",
            description:
                "Clear the provider-overlap response cache.",
            usage:
                "provider-overlap-cache-clear",
            handler: ({ context, writeJSON }) =>
                writeJSONValue(
                    writeJSON,
                    {
                        cleared:
                            requireService(context)
                                .clearCache()
                    }
                )
        },
        {
            name: "provider-overlap-status",
            category: "providers",
            description:
                "Show provider-overlap service status.",
            usage:
                "provider-overlap-status",
            handler: ({ context, writeJSON }) =>
                writeJSONValue(
                    writeJSON,
                    requireService(context).status()
                )
        }
    ];

    const api = Object.freeze({
        name: MODULE_NAME,
        version: VERSION,
        serviceName: SERVICE_NAME,
        workerName: WORKER_NAME,
        ProviderOverlapService,
        normalizeParameters,
        normalizeRecord,
        normalizeResponse,
        normalizeRatio,
        canonicalPair,
        safeDivide,
        percentile,
        metricSummary,
        buildMatrix,
        summarize,
        summarizeByProvider,
        parseCommandArguments,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        unmount,
        destroy: unmount,
        commands
    });

    window.SpeciedexTerminalProviderOverlap = api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules || {};

    window.SpeciedexTerminalModules[
        MODULE_NAME
    ] = api;

    dispatch(
        document,
        "speciedex:terminal-module-available",
        {
            name: MODULE_NAME,
            module: api,
            version: VERSION
        }
    );
})(window, document);
