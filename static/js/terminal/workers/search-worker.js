/*
========================================================================
Speciedex.org
Search Worker
========================================================================

High-performance worker-side search engine for SpeciedexTerminal.

Designed for browser integration through:

    _partials/splash.html
        -> _partials/terminal.html
        -> terminal WorkerPool
        -> static/js/terminal/workers/search-worker.js

The worker accepts JSON-compatible records emitted by the static site,
terminal JavaScript modules, Python workflow products, and archive exports.

Features:

    • Persistent in-worker indexes
    • Raw query strings and normalized query plans
    • Quoted phrases, fields, comparisons, ranges, wildcards, and regex
    • Boolean AND, OR, NOT expressions with parentheses
    • Scientific names, vernacular names, taxonomy, geography, identifiers
    • Unicode-aware normalization and fuzzy matching
    • Deterministic relevance scoring and field weighting
    • Sorting, paging, offsets, projection, facets, and result metadata
    • Incremental add, update, remove, rebuild, and clear operations
    • Request cancellation, progress events, and structured responses

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

"use strict";

const WORKER_NAME = "search";
const WORKER_VERSION = "4.0.0";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 10000;
const MAX_RECORDS = 1000000;
const MAX_FIELDS = 512;
const DEFAULT_PROGRESS_INTERVAL = 5000;
const MIN_PROGRESS_INTERVAL = 100;
const MAX_PROGRESS_INTERVAL = 100000;
const YIELD_INTERVAL = 2048;

const FIELD_ALIASES = Object.freeze({
    id: "speciedex_id",
    key: "speciedex_id",
    sid: "speciedex_id",
    speciedex: "speciedex_id",
    speciedex_id: "speciedex_id",

    scientific: "scientific_name",
    scientific_name: "scientific_name",
    canonical: "scientific_name",
    canonical_name: "canonical_name",
    accepted: "accepted_name",
    accepted_name: "accepted_name",
    name: "name",

    common: "common_name",
    common_name: "common_name",
    vernacular: "common_name",
    vernacular_name: "common_name",

    synonym: "synonyms",
    synonyms: "synonyms",

    rank: "rank",
    domain: "domain",
    kingdom: "kingdom",
    phylum: "phylum",
    class: "class",
    order: "order",
    family: "family",
    tribe: "tribe",
    genus: "genus",
    species: "species",
    subspecies: "subspecies",
    variety: "variety",
    form: "form",
    clade: "clade",

    provider: "provider",
    source: "provider",
    provider_id: "provider_id",

    country: "country",
    nation: "country",
    continent: "continent",
    state: "state",
    province: "state",
    county: "county",
    city: "city",
    locality: "locality",
    location: "location",
    island: "island",
    ocean: "ocean",
    sea: "sea",
    river: "river",
    lake: "lake",

    habitat: "habitat",
    biome: "biome",
    ecosystem: "ecosystem",

    conservation: "conservation_status",
    conservation_status: "conservation_status",
    status: "conservation_status",
    iucn: "iucn_status",
    iucn_status: "iucn_status",

    author: "authority",
    authority: "authority",
    year: "year",

    hash: "hash",
    checksum: "checksum",
    sha1: "sha1",
    sha256: "sha256",
    sha384: "sha384",
    sha512: "sha512",
    md5: "md5",
    cid: "cid",
    uuid: "uuid",
    doi: "doi",

    taxid: "taxid",
    gbif: "gbif_id",
    ncbi: "ncbi_id",
    itis: "itis_id",
    worms: "worms_id",
    col: "col_id",
    inat: "inat_id",
    iucn_id: "iucn_id",
    eol: "eol_id",
    bold: "bold_id",
    wikidata: "wikidata_id",
    wikipedia: "wikipedia",

    genome: "genome",
    gene: "gene",
    accession: "accession",

    volume: "volume",
    release: "release",
    created: "created_at",
    updated: "updated_at",

    confidence: "confidence",
    overlap: "overlap",
    latitude: "latitude",
    longitude: "longitude",
    elevation: "elevation",
    depth: "depth",

    has: "has"
});

const DEFAULT_TEXT_FIELDS = Object.freeze([
    "speciedex_id",
    "scientific_name",
    "common_name",
    "name",
    "canonical_name",
    "accepted_name",
    "synonyms",
    "authority",
    "description",
    "keywords",
    "tags",
    "rank",
    "domain",
    "kingdom",
    "phylum",
    "class",
    "order",
    "family",
    "tribe",
    "genus",
    "species",
    "subspecies",
    "country",
    "state",
    "locality",
    "continent",
    "habitat",
    "biome",
    "ecosystem",
    "provider"
]);

const IDENTIFIER_PATTERNS = Object.freeze([
    ["sha1", /^[a-f0-9]{40}$/i],
    ["sha256", /^[a-f0-9]{64}$/i],
    ["sha384", /^[a-f0-9]{96}$/i],
    ["sha512", /^[a-f0-9]{128}$/i],
    ["md5", /^[a-f0-9]{32}$/i],
    [
        "uuid",
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    ],
    ["doi", /^10\.\d{4,9}\/[-._;()/:a-z0-9]+$/i],
    ["wikidata_id", /^Q\d+$/i],
    ["speciedex_id", /^(?:spx|speciedex)[-_:][a-z0-9._:-]+$/i]
]);

const state = {
    records: [],
    fields: [],
    exactIndexes: new Map(),
    tokenIndex: new Map(),
    prefixIndexes: new Map(),
    fullText: [],
    fieldCache: [],
    idField: "speciedex_id",
    idToIndex: new Map(),
    version: 0,
    builtAt: null,
    buildDurationMs: 0
};

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

function normalizeSearchText(value) {
    return normalizeText(value)
        .normalize("NFKD")
        .replace(/\p{M}+/gu, "")
        .toLowerCase();
}

function normalizeField(field) {
    const value = normalizeText(field)
        .toLowerCase()
        .replace(/-/g, "_");

    return FIELD_ALIASES[value] || value;
}

function normalizeBoolean(value, fallback = false) {
    if (typeof value === "boolean") {
        return value;
    }

    if (typeof value === "number") {
        return value !== 0;
    }

    const text = normalizeSearchText(value);

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

function uniqueFields(value) {
    return [
        ...new Set(
            asArray(value)
                .flatMap(item =>
                    typeof item === "string"
                        ? item.split(",")
                        : [item]
                )
                .map(normalizeField)
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
            "Search worker request cancelled.",
            "SEARCH_WORKER_CANCELLED",
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
            normalizeSearchText(
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
        case "build":
        case "index":
        case "rebuild":
            return buildIndex(payload, id);

        case "search":
        case "query":
            return search(payload, id);

        case "explain":
        case "parse":
            return parseQuery(
                payload.query ??
                payload.q ??
                "",
                payload
            );

        case "add":
        case "append":
            return addRecords(payload, id);

        case "update":
        case "upsert":
            return updateRecords(payload, id);

        case "remove":
        case "delete":
            return removeRecords(payload, id);

        case "fields":
            return {
                aliases: FIELD_ALIASES,
                defaultTextFields: [...DEFAULT_TEXT_FIELDS],
                indexedFields: [...state.fields],
                recordCount: state.records.length,
                idField: state.idField,
                version: state.version
            };

        case "clear":
        case "reset":
            clearIndex();

            return {
                cleared: true,
                version: state.version
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
                `Unsupported search operation: ${type || "(empty)"}`,
                "SEARCH_WORKER_UNSUPPORTED_OPERATION"
            );
    }
}

function status() {
    return {
        ready: true,
        worker: WORKER_NAME,
        workerVersion: WORKER_VERSION,
        records: state.records.length,
        fields: [...state.fields],
        indexes: state.exactIndexes.size,
        tokens: state.tokenIndex.size,
        prefixes: state.prefixIndexes.size,
        idField: state.idField,
        version: state.version,
        builtAt: state.builtAt,
        buildDurationMs: state.buildDurationMs,
        activeRequests: activeRequests.size,
        limits: {
            maxRecords: MAX_RECORDS,
            maxFields: MAX_FIELDS,
            defaultLimit: DEFAULT_LIMIT,
            maxLimit: MAX_LIMIT
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
        return candidate;
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
                return candidate[key];
            }
        }
    }

    return [];
}

async function buildIndex(payload = {}, id = null) {
    const startedAt = now();
    const records = extractRecords(payload);

    if (records.length > MAX_RECORDS) {
        throw createError(
            `Search index record limit exceeded: ${records.length} > ${MAX_RECORDS}.`,
            "SEARCH_WORKER_RECORD_LIMIT",
            "RangeError"
        );
    }

    const requestedFields = uniqueFields(payload.fields);
    const fields = requestedFields.length
        ? requestedFields
        : discoverFields(records);

    if (fields.length > MAX_FIELDS) {
        throw createError(
            `Search index field limit exceeded: ${fields.length} > ${MAX_FIELDS}.`,
            "SEARCH_WORKER_FIELD_LIMIT",
            "RangeError"
        );
    }

    state.records = [...records];
    state.fields = fields;
    state.idField = normalizeField(
        payload.idField ??
        payload.id_field ??
        "speciedex_id"
    );

    resetIndexStructures(records.length);

    const progressEnabled = normalizeBoolean(
        payload.progress,
        true
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
        indexRecord(records[index], index);

        if (
            progressEnabled &&
            index > 0 &&
            index % progressInterval === 0
        ) {
            postProgress(
                id,
                "build",
                index,
                records.length,
                {
                    tokens: state.tokenIndex.size
                }
            );
        }

        if (index > 0 && index % YIELD_INTERVAL === 0) {
            await yieldToWorker();
        }
    }

    state.version += 1;
    state.builtAt = new Date().toISOString();
    state.buildDurationMs = now() - startedAt;

    if (progressEnabled) {
        postProgress(
            id,
            "complete",
            records.length,
            records.length,
            {
                tokens: state.tokenIndex.size
            }
        );
    }

    return status();
}

function resetIndexStructures(recordCount = 0) {
    state.exactIndexes = new Map();
    state.tokenIndex = new Map();
    state.prefixIndexes = new Map();
    state.fullText = new Array(recordCount);
    state.fieldCache = new Array(recordCount);
    state.idToIndex = new Map();

    for (const field of state.fields) {
        state.exactIndexes.set(field, new Map());
        state.prefixIndexes.set(field, new Map());
    }
}

function clearIndex() {
    state.records = [];
    state.fields = [];
    resetIndexStructures(0);
    state.idField = "speciedex_id";
    state.version += 1;
    state.builtAt = null;
    state.buildDurationMs = 0;
}

function discoverFields(records) {
    const fields = new Set(DEFAULT_TEXT_FIELDS);

    for (const record of records) {
        collectFieldPaths(record, "", fields);

        if (fields.size >= MAX_FIELDS) {
            break;
        }
    }

    return [...fields]
        .map(normalizeField)
        .filter(Boolean)
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

function indexRecord(record, index) {
    const fullTextParts = [];
    const cache = new Map();

    const idValue = fieldValues(
        record,
        state.idField
    )[0];

    const idKey = canonicalKey(idValue);

    if (idKey !== null) {
        state.idToIndex.set(idKey, index);
    }

    for (const field of state.fields) {
        const values = fieldValues(record, field);
        cache.set(field, values);

        const exactIndex = state.exactIndexes.get(field);
        const prefixIndex = state.prefixIndexes.get(field);

        for (const value of values) {
            const normalized = normalizeSearchText(value);

            if (!normalized) {
                continue;
            }

            fullTextParts.push(normalized);
            addSetIndex(exactIndex, normalized, index);

            for (const token of tokenizeValue(normalized)) {
                addSetIndex(state.tokenIndex, token, index);

                for (const prefix of prefixesFor(token)) {
                    addSetIndex(prefixIndex, prefix, index);
                }
            }
        }
    }

    state.fullText[index] = fullTextParts.join(" ");
    state.fieldCache[index] = cache;
}

function addSetIndex(index, key, recordIndex) {
    let values = index.get(key);

    if (!values) {
        values = new Set();
        index.set(key, values);
    }

    values.add(recordIndex);
}

function prefixesFor(value) {
    const output = [];
    const maximum = Math.min(value.length, 64);

    for (let length = 1; length <= maximum; length += 1) {
        output.push(value.slice(0, length));
    }

    return output;
}

async function search(payload = {}, id = null) {
    const startedAt = now();
    const providedRecords = extractRecords(payload);
    const usingWorkerIndex =
        !providedRecords.length ||
        payload.records === undefined;

    const records = usingWorkerIndex
        ? state.records
        : providedRecords;

    if (records.length > MAX_RECORDS) {
        throw createError(
            `Search record limit exceeded: ${records.length} > ${MAX_RECORDS}.`,
            "SEARCH_WORKER_RECORD_LIMIT",
            "RangeError"
        );
    }

    const requestedFields = uniqueFields(payload.fields);
    const fields = requestedFields.length
        ? requestedFields
        : (
            usingWorkerIndex && state.fields.length
                ? state.fields
                : discoverFields(records)
        );

    const plan =
        payload.plan &&
        typeof payload.plan === "object"
            ? normalizePlan(payload.plan)
            : parseQuery(
                payload.query ??
                payload.q ??
                payload.term ??
                "",
                payload
            );

    const candidateIndexes = usingWorkerIndex
        ? getCandidateIndexes(plan)
        : null;

    const indexes = candidateIndexes ??
        Array.from(
            { length: records.length },
            (_value, index) => index
        );

    const matches = [];
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

    for (let cursor = 0; cursor < indexes.length; cursor += 1) {
        assertActive(id);

        const index = indexes[cursor];
        const record = records[index];

        if (
            evaluateRecord(
                record,
                plan.expression,
                plan.fuzzy,
                fields,
                index,
                usingWorkerIndex
            )
        ) {
            matches.push({
                record,
                score: scoreRecord(
                    record,
                    plan.expression,
                    plan.fuzzy,
                    fields,
                    index,
                    usingWorkerIndex,
                    payload.weights
                ),
                index
            });
        }

        if (
            progressEnabled &&
            cursor > 0 &&
            cursor % progressInterval === 0
        ) {
            postProgress(
                id,
                "search",
                cursor,
                indexes.length,
                {
                    matched: matches.length
                }
            );
        }

        if (cursor > 0 && cursor % YIELD_INTERVAL === 0) {
            await yieldToWorker();
        }
    }

    const sortRules = normalizeSort(
        payload.sort ??
        plan.sort,
        payload.order ??
        plan.order
    );

    if (sortRules.length) {
        matches.sort((left, right) => {
            for (const rule of sortRules) {
                const compared = compareRecords(
                    left.record,
                    right.record,
                    rule.field,
                    rule.order
                );

                if (compared !== 0) {
                    return compared;
                }
            }

            return right.score - left.score ||
                left.index - right.index;
        });
    } else {
        matches.sort((left, right) =>
            right.score - left.score ||
            left.index - right.index
        );
    }

    const total = matches.length;
    const requestedAll = normalizeBoolean(
        payload.all ??
        payload.returnAll ??
        payload.return_all,
        false
    );

    const explicitOffset =
        payload.offset !== undefined ||
        plan.offsetExplicit === true;

    const effectiveOffset = explicitOffset
        ? plan.offset
        : (plan.page - 1) * plan.limit;

    const selected = requestedAll
        ? matches
        : matches.slice(
            effectiveOffset,
            effectiveOffset + plan.limit
        );

    const facetScope = normalizeSearchText(
        payload.facetsScope ??
        payload.facets_scope ??
        "matches"
    );

    const facetRecords = facetScope === "page"
        ? selected.map(item => item.record)
        : matches.map(item => item.record);

    const result = {
        source:
            usingWorkerIndex
                ? "worker-index"
                : "worker-records",
        query: plan.raw,
        plan:
            normalizeBoolean(
                payload.includePlan ??
                payload.include_plan,
                true
            )
                ? plan
                : undefined,
        total,
        matched: total,
        returned: selected.length,
        offset: requestedAll ? 0 : effectiveOffset,
        limit: requestedAll ? total : plan.limit,
        page: requestedAll
            ? 1
            : Math.floor(effectiveOffset / plan.limit) + 1,
        pages: requestedAll
            ? (total > 0 ? 1 : 0)
            : Math.ceil(total / plan.limit),
        hasPrevious:
            !requestedAll &&
            effectiveOffset > 0,
        hasNext:
            !requestedAll &&
            effectiveOffset + selected.length < total,
        records: selected.map(item =>
            projectRecord(
                item.record,
                payload.select ??
                payload.projection
            )
        ),
        facets: buildFacets(
            facetRecords,
            payload.facets,
            payload.facetLimit ??
            payload.facet_limit
        ),
        elapsed_ms: now() - startedAt,
        index_version: state.version,
        candidates: indexes.length,
        workerVersion: WORKER_VERSION
    };

    if (normalizeBoolean(
        payload.includeScores ??
        payload.include_scores,
        false
    )) {
        result.scores = selected.map(item => ({
            index: item.index,
            score: item.score
        }));
    }

    if (normalizeBoolean(
        payload.includeIndexes ??
        payload.include_indexes,
        false
    )) {
        result.indexes = selected.map(item => item.index);
    }

    return result;
}

function normalizePlan(plan = {}) {
    const explicitOffset =
        plan.offset !== undefined &&
        plan.offset !== null;

    return {
        raw: normalizeText(plan.raw ?? plan.query ?? ""),
        expression: normalizeExpression(
            plan.expression ??
            clausesToExpression(
                Array.isArray(plan.clauses)
                    ? plan.clauses
                    : []
            )
        ),
        clauses:
            Array.isArray(plan.clauses)
                ? plan.clauses
                : [],
        limit: clampInteger(
            plan.limit ??
            plan.perPage ??
            plan.per_page,
            DEFAULT_LIMIT,
            1,
            MAX_LIMIT
        ),
        offset: clampInteger(
            plan.offset,
            0,
            0,
            Number.MAX_SAFE_INTEGER
        ),
        offsetExplicit: explicitOffset,
        page: clampInteger(
            plan.page,
            1,
            1,
            Number.MAX_SAFE_INTEGER
        ),
        sort: plan.sort ?? null,
        order: normalizeOrder(plan.order ?? "asc"),
        fuzzy: normalizeBoolean(plan.fuzzy, true),
        explain: normalizeBoolean(plan.explain, false)
    };
}

function parseQuery(input, options = {}) {
    const raw = normalizeText(input);
    const tokens = tokenize(raw);
    const parser = new QueryParser(tokens);
    const expression = parser.parseExpression();

    if (parser.hasMore()) {
        throw createError(
            `Unexpected query token: ${parser.peek()}`,
            "SEARCH_WORKER_QUERY_SYNTAX"
        );
    }

    const clauses = [];
    collectClauses(expression, clauses);

    return normalizePlan({
        raw,
        expression,
        clauses,
        limit:
            options.limit ??
            options.perPage ??
            options.per_page ??
            DEFAULT_LIMIT,
        offset:
            options.offset,
        page:
            options.page ??
            1,
        sort:
            options.sort ??
            null,
        order:
            options.order ??
            "asc",
        fuzzy:
            options.fuzzy,
        explain:
            options.explain
    });
}

class QueryParser {
    constructor(tokens) {
        this.tokens = tokens;
        this.position = 0;
    }

    hasMore() {
        return this.position < this.tokens.length;
    }

    peek() {
        return this.tokens[this.position];
    }

    consume() {
        return this.tokens[this.position++];
    }

    match(value) {
        if (
            String(this.peek() || "").toUpperCase() === value
        ) {
            this.position += 1;
            return true;
        }

        return false;
    }

    parseExpression() {
        if (!this.tokens.length) {
            return { type: "all" };
        }

        return this.parseOr();
    }

    parseOr() {
        let left = this.parseAnd();

        while (this.match("OR") || this.match("||")) {
            left = {
                type: "or",
                left,
                right: this.parseAnd()
            };
        }

        return left;
    }

    parseAnd() {
        let left = this.parseUnary();

        while (this.hasMore()) {
            const next = String(this.peek()).toUpperCase();

            if (
                next === "OR" ||
                next === "||" ||
                next === ")"
            ) {
                break;
            }

            this.match("AND");
            this.match("&&");

            left = {
                type: "and",
                left,
                right: this.parseUnary()
            };
        }

        return left;
    }

    parseUnary() {
        if (this.match("NOT") || this.match("!")) {
            return {
                type: "not",
                value: this.parseUnary()
            };
        }

        const token = this.peek();

        if (
            typeof token === "string" &&
            token.startsWith("-") &&
            token.length > 1
        ) {
            this.consume();

            return {
                type: "not",
                value: parseTerm(token.slice(1))
            };
        }

        if (this.match("(")) {
            const expression = this.parseOr();

            if (!this.match(")")) {
                throw createError(
                    "Unclosed query parenthesis.",
                    "SEARCH_WORKER_QUERY_SYNTAX"
                );
            }

            return expression;
        }

        if (!this.hasMore()) {
            throw createError(
                "Incomplete search expression.",
                "SEARCH_WORKER_QUERY_SYNTAX"
            );
        }

        return parseTerm(this.consume());
    }
}

function parseTerm(token) {
    const source = String(token);

    const range = source.match(
        /^([a-zA-Z_][a-zA-Z0-9_.-]*):\[(.+)\s+TO\s+(.+)\]$/i
    );

    if (range) {
        return {
            type: "range",
            field: normalizeField(range[1]),
            lower: parseValue(range[2]),
            upper: parseValue(range[3]),
            inclusive: true
        };
    }

    const comparison = source.match(
        /^([a-zA-Z_][a-zA-Z0-9_.-]*)(>=|<=|!=|=|>|<|:)(.+)$/
    );

    if (comparison) {
        return {
            type: "term",
            field: normalizeField(comparison[1]),
            operator:
                comparison[2] === ":"
                    ? "contains"
                    : comparison[2],
            value: parseValue(comparison[3])
        };
    }

    const raw = unquote(token);
    const identifier = detectIdentifier(raw);

    if (identifier) {
        return {
            type: "term",
            field: identifier.field,
            operator: "=",
            value: parseValue(identifier.value),
            inferred: true
        };
    }

    return {
        type: "text",
        fields: [...DEFAULT_TEXT_FIELDS],
        operator: "contains",
        value: parseValue(token)
    };
}

function parseValue(value) {
    const raw = unquote(value);

    return {
        raw,
        normalized: normalizeSearchText(raw),
        regex: parseRegex(raw),
        wildcard: raw.includes("*") || raw.includes("?"),
        number:
            raw !== "" &&
            Number.isFinite(Number(raw))
                ? Number(raw)
                : null,
        boolean:
            /^(true|false)$/i.test(raw)
                ? raw.toLowerCase() === "true"
                : null,
        null:
            /^(null|none)$/i.test(raw)
    };
}

function parseRegex(value) {
    const match = normalizeText(value).match(
        /^\/((?:\\.|[^/])+)\/([dgimsuvy]*)$/
    );

    if (!match) {
        return null;
    }

    try {
        return new RegExp(
            match[1],
            sanitizeRegexFlags(match[2])
        );
    } catch (_error) {
        throw createError(
            `Invalid regular expression: ${value}`,
            "SEARCH_WORKER_INVALID_REGEX"
        );
    }
}

function sanitizeRegexFlags(flags) {
    return [
        ...new Set(
            normalizeText(flags)
                .replace(/[gy]/g, "")
                .split("")
                .filter(flag =>
                    "dimsuv".includes(flag)
                )
        )
    ].join("");
}

function detectIdentifier(value) {
    const candidate = normalizeText(value);

    for (const [field, pattern] of IDENTIFIER_PATTERNS) {
        if (pattern.test(candidate)) {
            return {
                field,
                value: candidate
            };
        }
    }

    return null;
}

function normalizeExpression(expression) {
    if (
        !expression ||
        typeof expression !== "object"
    ) {
        return { type: "all" };
    }

    return expression;
}

function clausesToExpression(clauses) {
    if (!clauses.length) {
        return { type: "all" };
    }

    let expression = null;

    for (const clause of clauses) {
        const term = { ...clause };
        delete term.join;
        delete term.negated;

        const value = clause.negated
            ? {
                type: "not",
                value: term
            }
            : term;

        if (!expression) {
            expression = value;
            continue;
        }

        expression = {
            type:
                String(clause.join).toUpperCase() === "OR"
                    ? "or"
                    : "and",
            left: expression,
            right: value
        };
    }

    return expression;
}

function collectClauses(expression, output) {
    if (!expression) {
        return output;
    }

    if (
        ["term", "text", "range"].includes(expression.type)
    ) {
        output.push(expression);
        return output;
    }

    if (expression.type === "not") {
        collectClauses(expression.value, output);
        return output;
    }

    collectClauses(expression.left, output);
    collectClauses(expression.right, output);

    return output;
}

function getCandidateIndexes(plan) {
    const candidates = candidateSetForExpression(
        plan.expression
    );

    return candidates
        ? [...candidates].sort((left, right) => left - right)
        : null;
}

function candidateSetForExpression(expression) {
    if (!expression) {
        return null;
    }

    if (
        expression.type === "term" &&
        ["=", "contains"].includes(expression.operator) &&
        !expression.value.regex
    ) {
        if (
            expression.operator === "=" &&
            !expression.value.wildcard
        ) {
            const index = state.exactIndexes.get(
                expression.field
            );

            const values = index?.get(
                expression.value.normalized
            );

            return values
                ? new Set(values)
                : new Set();
        }

        if (
            expression.operator === "contains" &&
            !expression.value.wildcard
        ) {
            const tokens = tokenizeValue(
                expression.value.normalized
            );

            const sets = tokens
                .map(token => state.tokenIndex.get(token))
                .filter(Boolean);

            if (!sets.length) {
                return null;
            }

            let result = new Set(sets[0]);

            for (let index = 1; index < sets.length; index += 1) {
                result = intersectSets(result, sets[index]);
            }

            return result;
        }
    }

    if (expression.type === "and") {
        const left = candidateSetForExpression(expression.left);
        const right = candidateSetForExpression(expression.right);

        if (!left) {
            return right;
        }

        if (!right) {
            return left;
        }

        return intersectSets(left, right);
    }

    if (expression.type === "or") {
        const left = candidateSetForExpression(expression.left);
        const right = candidateSetForExpression(expression.right);

        if (!left || !right) {
            return null;
        }

        return new Set([...left, ...right]);
    }

    return null;
}

function intersectSets(left, right) {
    const smaller =
        left.size <= right.size
            ? left
            : right;

    const larger =
        smaller === left
            ? right
            : left;

    return new Set(
        [...smaller].filter(value => larger.has(value))
    );
}

function evaluateRecord(
    record,
    expression,
    fuzzy,
    fields,
    index,
    indexed
) {
    if (!expression) {
        return true;
    }

    switch (expression.type) {
        case "all":
            return true;

        case "and":
            return (
                evaluateRecord(
                    record,
                    expression.left,
                    fuzzy,
                    fields,
                    index,
                    indexed
                ) &&
                evaluateRecord(
                    record,
                    expression.right,
                    fuzzy,
                    fields,
                    index,
                    indexed
                )
            );

        case "or":
            return (
                evaluateRecord(
                    record,
                    expression.left,
                    fuzzy,
                    fields,
                    index,
                    indexed
                ) ||
                evaluateRecord(
                    record,
                    expression.right,
                    fuzzy,
                    fields,
                    index,
                    indexed
                )
            );

        case "not":
            return !evaluateRecord(
                record,
                expression.value,
                fuzzy,
                fields,
                index,
                indexed
            );

        case "term":
        case "text":
            return evaluateLeaf(
                record,
                expression,
                fuzzy,
                fields,
                index,
                indexed
            );

        case "range":
            return evaluateRange(record, expression);

        default:
            return false;
    }
}

function evaluateRange(record, clause) {
    return fieldValues(record, clause.field).some(value => {
        const lower = compareComparable(
            value,
            clause.lower.raw
        );

        const upper = compareComparable(
            value,
            clause.upper.raw
        );

        return clause.inclusive
            ? lower >= 0 && upper <= 0
            : lower > 0 && upper < 0;
    });
}

function evaluateLeaf(
    record,
    clause,
    fuzzy,
    fields,
    index,
    indexed
) {
    if (clause.type === "text") {
        if (
            indexed &&
            state.fullText[index] &&
            !clause.value.regex &&
            !clause.value.wildcard
        ) {
            return compareText(
                state.fullText[index],
                clause.value.raw,
                fuzzy
            );
        }

        const selectedFields =
            clause.fields?.length
                ? clause.fields
                : fields;

        return selectedFields.some(field =>
            fieldValues(record, field).some(value =>
                compareScalar(value, clause, fuzzy)
            )
        );
    }

    if (clause.field === "has") {
        const requested = normalizeField(
            clause.value.raw
        );

        return fieldValues(record, requested).some(value =>
            value !== null &&
            value !== undefined &&
            value !== "" &&
            !(Array.isArray(value) && value.length === 0)
        );
    }

    return fieldValues(record, clause.field).some(value =>
        compareScalar(value, clause, fuzzy)
    );
}

function compareScalar(candidate, clause, fuzzy = true) {
    const value = clause.value;
    const operator = clause.operator;
    const candidateText = normalizeText(candidate);
    const queryText = normalizeText(value.raw);

    if (value.regex) {
        value.regex.lastIndex = 0;
        return value.regex.test(candidateText);
    }

    if (value.wildcard) {
        return wildcardRegex(queryText).test(candidateText);
    }

    if (
        value.null &&
        ["=", "!="].includes(operator)
    ) {
        const empty =
            candidate === null ||
            candidate === undefined;

        return operator === "="
            ? empty
            : !empty;
    }

    if (
        value.boolean !== null &&
        ["=", "!="].includes(operator)
    ) {
        const candidateBoolean = normalizeBoolean(
            candidate,
            false
        );

        return operator === "="
            ? candidateBoolean === value.boolean
            : candidateBoolean !== value.boolean;
    }

    if (
        [">", ">=", "<", "<=", "=", "!="].includes(operator) &&
        value.number !== null &&
        Number.isFinite(Number(candidate))
    ) {
        return compareNumbers(
            Number(candidate),
            value.number,
            operator
        );
    }

    const left = normalizeSearchText(candidateText);
    const right = normalizeSearchText(queryText);

    if (operator === "=") {
        return left === right;
    }

    if (operator === "!=") {
        return left !== right;
    }

    if (operator === "contains") {
        return compareText(left, right, fuzzy);
    }

    if ([">", ">=", "<", "<="].includes(operator)) {
        const comparison = compareComparable(left, right);

        return compareNumbers(
            comparison,
            0,
            operator
        );
    }

    return false;
}

function compareNumbers(left, right, operator) {
    switch (operator) {
        case ">":
            return left > right;
        case ">=":
            return left >= right;
        case "<":
            return left < right;
        case "<=":
            return left <= right;
        case "=":
            return left === right;
        case "!=":
            return left !== right;
        default:
            return false;
    }
}

function compareComparable(left, right) {
    if (
        normalizeText(left) !== "" &&
        normalizeText(right) !== "" &&
        Number.isFinite(Number(left)) &&
        Number.isFinite(Number(right))
    ) {
        return Number(left) - Number(right);
    }

    const leftDate = parseDate(left);
    const rightDate = parseDate(right);

    if (
        leftDate !== null &&
        rightDate !== null
    ) {
        return leftDate - rightDate;
    }

    return normalizeText(left).localeCompare(
        normalizeText(right),
        undefined,
        {
            numeric: true,
            sensitivity: "base"
        }
    );
}

function parseDate(value) {
    if (
        value instanceof Date &&
        Number.isFinite(value.getTime())
    ) {
        return value.getTime();
    }

    if (typeof value !== "string") {
        return null;
    }

    const candidate = value.trim();

    if (
        !/^\d{4}-\d{2}-\d{2}/.test(candidate) &&
        !/[T:\-\/]/.test(candidate)
    ) {
        return null;
    }

    const parsed = Date.parse(candidate);

    return Number.isFinite(parsed)
        ? parsed
        : null;
}

function compareText(candidate, query, fuzzy) {
    const left = normalizeSearchText(candidate);
    const right = normalizeSearchText(query);

    if (!right) {
        return true;
    }

    if (left.includes(right)) {
        return true;
    }

    if (!fuzzy || right.length < 4) {
        return false;
    }

    const words = tokenizeValue(left);
    const threshold = right.length <= 6
        ? 1
        : 2;

    return words.some(word =>
        Math.abs(word.length - right.length) <= threshold &&
        levenshtein(word, right, threshold) <= threshold
    );
}

function scoreRecord(
    record,
    expression,
    fuzzy,
    fields,
    index,
    indexed,
    weights
) {
    const leaves = [];
    collectPositiveLeaves(expression, leaves, false);

    let score = 0;

    for (const clause of leaves) {
        const targetFields =
            clause.type === "text"
                ? (clause.fields || fields)
                : [clause.field];

        for (const field of targetFields) {
            const values =
                indexed
                    ? state.fieldCache[index]?.get(field) ??
                      fieldValues(record, field)
                    : fieldValues(record, field);

            for (const value of values) {
                const candidate = normalizeSearchText(value);
                const query = normalizeSearchText(
                    clause.value?.raw ??
                    clause.lower?.raw ??
                    ""
                );

                if (!query) {
                    continue;
                }

                const weight = fieldWeight(field, weights);

                if (candidate === query) {
                    score += weight * 20;
                } else if (candidate.startsWith(query)) {
                    score += weight * 12;
                } else if (candidate.includes(query)) {
                    score += weight * 6;
                } else if (
                    compareText(candidate, query, fuzzy)
                ) {
                    score += weight * 2;
                }
            }
        }
    }

    return score;
}

function collectPositiveLeaves(expression, output, negated) {
    if (!expression) {
        return;
    }

    if (expression.type === "not") {
        collectPositiveLeaves(
            expression.value,
            output,
            !negated
        );
        return;
    }

    if (
        expression.type === "and" ||
        expression.type === "or"
    ) {
        collectPositiveLeaves(expression.left, output, negated);
        collectPositiveLeaves(expression.right, output, negated);
        return;
    }

    if (
        !negated &&
        ["term", "text", "range"].includes(expression.type)
    ) {
        output.push(expression);
    }
}

function fieldWeight(field, weights) {
    const normalized = normalizeField(field);

    if (
        weights &&
        typeof weights === "object" &&
        Number.isFinite(Number(weights[normalized]))
    ) {
        return Number(weights[normalized]);
    }

    if (
        normalized === "speciedex_id" ||
        normalized.endsWith("_id") ||
        [
            "uuid",
            "sha1",
            "sha256",
            "sha384",
            "sha512",
            "md5",
            "doi"
        ].includes(normalized)
    ) {
        return 10;
    }

    if (
        [
            "scientific_name",
            "canonical_name",
            "accepted_name"
        ].includes(normalized)
    ) {
        return 9;
    }

    if (
        [
            "common_name",
            "vernacular_name"
        ].includes(normalized)
    ) {
        return 7;
    }

    if (
        normalized.includes("synonym") ||
        normalized.includes("alias")
    ) {
        return 6;
    }

    if (
        [
            "domain",
            "kingdom",
            "phylum",
            "class",
            "order",
            "family",
            "tribe",
            "genus",
            "species",
            "subspecies",
            "rank"
        ].includes(normalized)
    ) {
        return 5;
    }

    if (
        normalized.includes("provider") ||
        normalized.includes("source")
    ) {
        return 2;
    }

    return 1;
}

function normalizeSort(sort, fallbackOrder = "asc") {
    if (!sort) {
        return [];
    }

    if (typeof sort === "string") {
        return sort
            .split(",")
            .map(normalizeText)
            .filter(Boolean)
            .map(token => {
                const descending = token.startsWith("-");
                const ascending = token.startsWith("+");
                const field = descending || ascending
                    ? token.slice(1)
                    : token;

                return {
                    field: normalizeField(field),
                    order: descending
                        ? "desc"
                        : normalizeOrder(fallbackOrder)
                };
            })
            .filter(rule => rule.field);
    }

    if (Array.isArray(sort)) {
        return sort.flatMap(item =>
            normalizeSort(item, fallbackOrder)
        );
    }

    if (typeof sort === "object") {
        if (sort.field || sort.path || sort.key) {
            return [{
                field: normalizeField(
                    sort.field ??
                    sort.path ??
                    sort.key
                ),
                order: normalizeOrder(
                    sort.order ??
                    sort.direction ??
                    fallbackOrder
                )
            }].filter(rule => rule.field);
        }

        return Object.entries(sort)
            .map(([field, order]) => ({
                field: normalizeField(field),
                order: normalizeOrder(order)
            }))
            .filter(rule => rule.field);
    }

    return [];
}

function normalizeOrder(value) {
    return normalizeSearchText(value) === "desc" ||
        Number(value) === -1
        ? "desc"
        : "asc";
}

function compareRecords(left, right, field, order) {
    const a = fieldValues(left, field)[0];
    const b = fieldValues(right, field)[0];
    const direction = normalizeOrder(order) === "desc"
        ? -1
        : 1;

    if (a === b) {
        return 0;
    }

    if (a === undefined || a === null) {
        return 1;
    }

    if (b === undefined || b === null) {
        return -1;
    }

    return compareComparable(a, b) * direction;
}

function buildFacets(records, requested, facetLimit = 100) {
    const fields = uniqueFields(requested);

    if (!fields.length) {
        return {};
    }

    const limit = clampInteger(
        facetLimit,
        100,
        1,
        1000
    );

    const facets = {};

    for (const field of fields) {
        const counts = new Map();

        for (const record of records) {
            const seen = new Set();

            for (const value of fieldValues(record, field)) {
                const facet = facetKey(value);

                if (!facet || seen.has(facet)) {
                    continue;
                }

                seen.add(facet);
                counts.set(
                    facet,
                    (counts.get(facet) || 0) + 1
                );
            }
        }

        facets[field] = [...counts.entries()]
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
            .slice(0, limit)
            .map(([value, count]) => ({
                value,
                count
            }));
    }

    return facets;
}

function projectRecord(record, select) {
    const fields = uniqueFields(select);

    if (!fields.length) {
        return record;
    }

    const output = {};

    for (const field of fields) {
        const values = fieldValues(record, field);

        setPath(
            output,
            field,
            values.length <= 1
                ? values[0] ?? null
                : values
        );
    }

    return output;
}

function tokenizePath(path) {
    return normalizeField(path)
        .replace(/\[["']?([^"'[\]]+)["']?\]/g, ".$1")
        .split(".")
        .map(normalizeText)
        .filter(Boolean);
}

function fieldValues(record, field) {
    const normalized = normalizeField(field);

    if (
        !record ||
        typeof record !== "object"
    ) {
        return [];
    }

    if (normalized === "name") {
        return flatten([
            record.scientific_name,
            record.scientificName,
            record.common_name,
            record.commonName,
            record.canonical_name,
            record.canonicalName,
            record.accepted_name,
            record.acceptedName,
            record.name
        ]);
    }

    if (normalized === "location") {
        return flatten([
            record.continent,
            record.country,
            record.state,
            record.province,
            record.county,
            record.city,
            record.locality,
            record.island,
            record.ocean,
            record.sea,
            record.river,
            record.lake,
            record.location
        ]);
    }

    if (normalized === "scientific_name") {
        return flatten([
            record.scientific_name,
            record.scientificName,
            record.canonical_name,
            record.canonicalName,
            record.accepted_name,
            record.acceptedName
        ]);
    }

    if (normalized === "common_name") {
        return flatten([
            record.common_name,
            record.commonName,
            record.vernacular_name,
            record.vernacularName,
            record.preferred_common_name,
            record.preferredCommonName
        ]);
    }

    if (normalized === "speciedex_id") {
        return flatten([
            record.speciedex_id,
            record.speciedexId,
            record.speciedex_key,
            record.speciedexKey,
            record.canonical_id,
            record.canonicalId,
            record.id,
            record.key
        ]);
    }

    const parts = tokenizePath(normalized);

    if (!parts.length) {
        return [];
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

function setPath(target, path, value) {
    const parts = tokenizePath(path);

    if (!parts.length) {
        return;
    }

    let cursor = target;

    for (let index = 0; index < parts.length - 1; index += 1) {
        const part = parts[index];

        if (
            !cursor[part] ||
            typeof cursor[part] !== "object" ||
            Array.isArray(cursor[part])
        ) {
            cursor[part] = {};
        }

        cursor = cursor[part];
    }

    cursor[parts.at(-1)] = value;
}

function unquote(value) {
    const source = normalizeText(value);

    if (
        source.length >= 2 &&
        (
            (
                source.startsWith('"') &&
                source.endsWith('"')
            ) ||
            (
                source.startsWith("'") &&
                source.endsWith("'")
            )
        )
    ) {
        return source.slice(1, -1)
            .replace(/\\(["'\\])/g, "$1");
    }

    return source;
}

function tokenize(input) {
    const tokens = [];
    let current = "";
    let quote = null;
    let escaped = false;
    let regex = false;
    let squareDepth = 0;
    let parenthesisDepth = 0;

    const pushCurrent = () => {
        if (current) {
            tokens.push(current);
            current = "";
        }
    };

    for (let index = 0; index < input.length; index += 1) {
        const character = input[index];

        if (escaped) {
            current += character;
            escaped = false;
            continue;
        }

        if (character === "\\") {
            current += character;
            escaped = true;
            continue;
        }

        if (quote) {
            current += character;

            if (character === quote) {
                quote = null;
            }

            continue;
        }

        if (regex) {
            current += character;

            if (
                character === "/" &&
                input[index - 1] !== "\\"
            ) {
                regex = false;

                while (
                    /[dgimsuvy]/.test(input[index + 1] || "")
                ) {
                    current += input[++index];
                }
            }

            continue;
        }

        if (character === '"' || character === "'") {
            quote = character;
            current += character;
            continue;
        }

        if (character === "/" && !current) {
            regex = true;
            current += character;
            continue;
        }

        if (character === "[") {
            squareDepth += 1;
            current += character;
            continue;
        }

        if (character === "]") {
            squareDepth -= 1;
            current += character;

            if (squareDepth < 0) {
                throw createError(
                    "Unexpected closing range bracket.",
                    "SEARCH_WORKER_QUERY_SYNTAX"
                );
            }

            continue;
        }

        if (
            squareDepth === 0 &&
            (character === "(" || character === ")")
        ) {
            pushCurrent();
            tokens.push(character);

            parenthesisDepth +=
                character === "("
                    ? 1
                    : -1;

            if (parenthesisDepth < 0) {
                throw createError(
                    "Unexpected closing parenthesis.",
                    "SEARCH_WORKER_QUERY_SYNTAX"
                );
            }

            continue;
        }

        if (
            squareDepth === 0 &&
            /\s/.test(character)
        ) {
            pushCurrent();
            continue;
        }

        current += character;
    }

    if (quote) {
        throw createError(
            "Unclosed quoted string.",
            "SEARCH_WORKER_QUERY_SYNTAX"
        );
    }

    if (regex) {
        throw createError(
            "Unclosed regular expression.",
            "SEARCH_WORKER_QUERY_SYNTAX"
        );
    }

    if (parenthesisDepth !== 0) {
        throw createError(
            "Unclosed query parenthesis.",
            "SEARCH_WORKER_QUERY_SYNTAX"
        );
    }

    if (squareDepth !== 0) {
        throw createError(
            "Unclosed query range.",
            "SEARCH_WORKER_QUERY_SYNTAX"
        );
    }

    pushCurrent();
    return tokens;
}

function wildcardRegex(value) {
    const escaped = value
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".");

    return new RegExp(`^${escaped}$`, "i");
}

function tokenizeValue(value) {
    return [
        ...new Set(
            normalizeSearchText(value)
                .split(/[^\p{L}\p{N}._:-]+/u)
                .filter(Boolean)
        )
    ];
}

function canonicalKey(value) {
    if (value === null || value === undefined) {
        return null;
    }

    if (typeof value === "object") {
        try {
            return stableStringify(value);
        } catch (_error) {
            return String(value);
        }
    }

    return normalizeSearchText(value);
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

async function addRecords(payload = {}, id = null) {
    const incoming = extractRecords(payload);

    if (state.records.length + incoming.length > MAX_RECORDS) {
        throw createError(
            "Search record limit exceeded.",
            "SEARCH_WORKER_RECORD_LIMIT",
            "RangeError"
        );
    }

    const start = state.records.length;
    state.records.push(...incoming);
    state.fullText.length = state.records.length;
    state.fieldCache.length = state.records.length;

    for (let index = 0; index < incoming.length; index += 1) {
        assertActive(id);
        indexRecord(incoming[index], start + index);

        if (index > 0 && index % YIELD_INTERVAL === 0) {
            await yieldToWorker();
        }
    }

    state.version += 1;
    state.builtAt = new Date().toISOString();

    return {
        added: incoming.length,
        records: state.records.length,
        version: state.version
    };
}

async function updateRecords(payload = {}, id = null) {
    const incoming = extractRecords(payload);
    const idField = normalizeField(
        payload.idField ??
        payload.id_field ??
        state.idField
    );

    const replace = normalizeBoolean(
        payload.replace,
        false
    );

    const addMissing = normalizeBoolean(
        payload.addMissing ??
        payload.add_missing,
        true
    );

    let updated = 0;
    let added = 0;
    let skipped = 0;

    for (let index = 0; index < incoming.length; index += 1) {
        assertActive(id);

        const record = incoming[index];
        const idValue = fieldValues(record, idField)[0];
        const idKey = canonicalKey(idValue);

        let targetIndex;

        if (idField === state.idField) {
            targetIndex = state.idToIndex.get(idKey);
        } else {
            targetIndex = state.records.findIndex(existing =>
                fieldValues(existing, idField).some(value =>
                    canonicalKey(value) === idKey
                )
            );
        }

        if (
            targetIndex !== undefined &&
            targetIndex !== -1
        ) {
            state.records[targetIndex] = replace
                ? record
                : {
                    ...state.records[targetIndex],
                    ...record
                };

            updated += 1;
        } else if (addMissing) {
            state.records.push(record);
            added += 1;
        } else {
            skipped += 1;
        }

        if (index > 0 && index % YIELD_INTERVAL === 0) {
            await yieldToWorker();
        }
    }

    await rebuildCurrentIndex(id, payload.progress);

    return {
        updated,
        added,
        skipped,
        records: state.records.length,
        version: state.version
    };
}

async function removeRecords(payload = {}, id = null) {
    const idField = normalizeField(
        payload.idField ??
        payload.id_field ??
        state.idField
    );

    const ids = asArray(
        payload.ids ??
        payload.id ??
        payload.value
    ).filter(value =>
        value !== undefined &&
        value !== null
    );

    const keys = new Set(ids.map(canonicalKey));
    const retained = [];
    let removed = 0;

    for (let index = 0; index < state.records.length; index += 1) {
        assertActive(id);

        const record = state.records[index];
        const values = fieldValues(record, idField);
        const remove = values.some(value =>
            keys.has(canonicalKey(value))
        );

        if (remove) {
            removed += 1;
        } else {
            retained.push(record);
        }

        if (index > 0 && index % YIELD_INTERVAL === 0) {
            await yieldToWorker();
        }
    }

    state.records = retained;
    await rebuildCurrentIndex(id, payload.progress);

    return {
        removed,
        records: state.records.length,
        version: state.version
    };
}

async function rebuildCurrentIndex(id, progress = false) {
    const startedAt = now();
    const records = state.records;
    resetIndexStructures(records.length);

    for (let index = 0; index < records.length; index += 1) {
        assertActive(id);
        indexRecord(records[index], index);

        if (
            normalizeBoolean(progress, false) &&
            index > 0 &&
            index % DEFAULT_PROGRESS_INTERVAL === 0
        ) {
            postProgress(
                id,
                "rebuild",
                index,
                records.length
            );
        }

        if (index > 0 && index % YIELD_INTERVAL === 0) {
            await yieldToWorker();
        }
    }

    state.version += 1;
    state.builtAt = new Date().toISOString();
    state.buildDurationMs = now() - startedAt;
}

function levenshtein(left, right, maximum = Infinity) {
    const a = normalizeSearchText(left);
    const b = normalizeSearchText(right);

    if (a === b) {
        return 0;
    }

    if (!a.length) {
        return b.length;
    }

    if (!b.length) {
        return a.length;
    }

    if (Math.abs(a.length - b.length) > maximum) {
        return maximum + 1;
    }

    const previous = new Uint32Array(a.length + 1);
    const current = new Uint32Array(a.length + 1);

    for (let column = 0; column <= a.length; column += 1) {
        previous[column] = column;
    }

    for (let row = 1; row <= b.length; row += 1) {
        current[0] = row;
        let rowMinimum = current[0];

        for (let column = 1; column <= a.length; column += 1) {
            const substitution =
                previous[column - 1] +
                (
                    b[row - 1] === a[column - 1]
                        ? 0
                        : 1
                );

            current[column] = Math.min(
                substitution,
                current[column - 1] + 1,
                previous[column] + 1
            );

            rowMinimum = Math.min(
                rowMinimum,
                current[column]
            );
        }

        if (rowMinimum > maximum) {
            return maximum + 1;
        }

        previous.set(current);
    }

    return previous[a.length];
}
