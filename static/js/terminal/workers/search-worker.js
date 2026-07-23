/*
========================================================================
Speciedex.org
Search Worker
========================================================================

High-performance worker-side search engine for SpeciedexTerminal.

Supports:

    • Reusable in-worker indexes
    • Raw query strings and normalized query plans
    • Quoted phrases, fields, comparisons, wildcards, and regular expressions
    • Boolean AND, OR, and NOT expressions with parentheses
    • Scientific names, vernacular names, taxonomy, geography, and identifiers
    • Fuzzy matching and deterministic relevance scoring
    • Sorting, offsets, pages, limits, facets, and projected fields
    • Request cancellation and progress events
    • Safe worker error serialization

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

"use strict";

const WORKER_VERSION = "3.0.0";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;
const MAX_RECORDS = 1000000;
const PROGRESS_INTERVAL = 5000;

const FIELD_ALIASES = Object.freeze({
    id: "speciedex_id",
    key: "speciedex_id",
    sid: "speciedex_id",
    speciedex: "speciedex_id",
    speciedex_id: "speciedex_id",

    scientific: "scientific_name",
    scientific_name: "scientific_name",
    canonical: "scientific_name",
    accepted: "scientific_name",
    accepted_name: "accepted_name",
    canonical_name: "canonical_name",
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
    fullText: [],
    version: 0,
    builtAt: null,
    activeRequests: new Map()
};

function normalizeText(value) {
    return String(value ?? "").trim();
}

function normalizeField(field) {
    const key = normalizeText(field)
        .toLowerCase()
        .replace(/-/g, "_");

    return FIELD_ALIASES[key] || key;
}

function clampInteger(value, fallback, minimum, maximum) {
    const parsed = Number.parseInt(value, 10);

    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.min(maximum, Math.max(minimum, parsed));
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
        state.activeRequests.get(id)?.cancelled
    ) {
        const error = new Error("Search request cancelled.");
        error.name = "AbortError";
        error.code = "SEARCH_CANCELLED";
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

        if (state.activeRequests.has(targetId)) {
            state.activeRequests.get(targetId).cancelled = true;
        }

        respond(id, {
            cancelled: true,
            targetId
        });

        return;
    }

    state.activeRequests.set(id, {
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
        state.activeRequests.delete(id);
    }
});

async function handle(type, payload, id) {
    switch (type) {
        case "build":
        case "index":
            return buildIndex(payload, id);

        case "search":
            return search(payload, id);

        case "explain":
            return parseQuery(
                payload.query || "",
                payload
            );

        case "fields":
            return {
                aliases: FIELD_ALIASES,
                defaultTextFields:
                    [...DEFAULT_TEXT_FIELDS],
                indexedFields:
                    [...state.fields],
                recordCount:
                    state.records.length,
                version:
                    state.version
            };

        case "clear":
            clearIndex();

            return {
                cleared: true,
                version:
                    state.version
            };

        case "status":
            return status();

        case "ping":
            return {
                pong: true,
                version:
                    WORKER_VERSION
            };

        default:
            throw new Error(
                `Unsupported search operation: ${type || "(empty)"}`
            );
    }
}

function status() {
    return {
        ready: true,
        workerVersion:
            WORKER_VERSION,
        records:
            state.records.length,
        fields:
            state.fields.length,
        indexes:
            state.exactIndexes.size,
        version:
            state.version,
        builtAt:
            state.builtAt
    };
}

async function buildIndex(payload = {}, id = null) {
    const records =
        Array.isArray(payload.records)
            ? payload.records
            : [];

    if (records.length > MAX_RECORDS) {
        throw new RangeError(
            `Search index record limit exceeded: ${records.length} > ${MAX_RECORDS}.`
        );
    }

    const fields =
        Array.isArray(payload.fields) &&
        payload.fields.length
            ? [
                ...new Set(
                    payload.fields.map(
                        normalizeField
                    )
                )
            ]
            : discoverFields(records);

    state.records = records;
    state.fields = fields;
    state.exactIndexes = new Map();
    state.fullText = new Array(records.length);

    for (const field of fields) {
        state.exactIndexes.set(
            field,
            new Map()
        );
    }

    for (
        let index = 0;
        index < records.length;
        index += 1
    ) {
        assertNotCancelled(id);

        const record =
            records[index];

        const fullTextParts = [];

        for (const field of fields) {
            const values =
                fieldValues(record, field);

            const indexMap =
                state.exactIndexes.get(field);

            for (const value of values) {
                const normalized =
                    normalizeText(value)
                        .toLowerCase();

                if (!normalized) {
                    continue;
                }

                fullTextParts.push(normalized);

                let indexes =
                    indexMap.get(normalized);

                if (!indexes) {
                    indexes = [];
                    indexMap.set(
                        normalized,
                        indexes
                    );
                }

                indexes.push(index);
            }
        }

        state.fullText[index] =
            fullTextParts.join(" ");

        if (
            payload.progress !== false &&
            index > 0 &&
            index % PROGRESS_INTERVAL === 0
        ) {
            post("progress", id, {
                phase: "build",
                completed: index,
                total:
                    records.length
            });

            await Promise.resolve();
        }
    }

    state.version += 1;
    state.builtAt =
        new Date().toISOString();

    return {
        records:
            state.records.length,
        fields:
            [...state.fields],
        indexes:
            state.exactIndexes.size,
        version:
            state.version,
        builtAt:
            state.builtAt
    };
}

function clearIndex() {
    state.records = [];
    state.fields = [];
    state.exactIndexes = new Map();
    state.fullText = [];
    state.version += 1;
    state.builtAt = null;
}

async function search(payload = {}, id = null) {
    const started =
        performance.now();

    const usingWorkerIndex =
        !Array.isArray(payload.records);

    const records =
        usingWorkerIndex
            ? state.records
            : payload.records;

    const fields =
        Array.isArray(payload.fields) &&
        payload.fields.length
            ? [
                ...new Set(
                    payload.fields.map(
                        normalizeField
                    )
                )
            ]
            : (
                usingWorkerIndex &&
                state.fields.length
                    ? state.fields
                    : discoverFields(records)
            );

    const plan =
        payload.plan &&
        typeof payload.plan === "object"
            ? normalizePlan(payload.plan)
            : parseQuery(
                payload.query || "",
                payload
            );

    const candidateIndexes =
        usingWorkerIndex
            ? getCandidateIndexes(plan)
            : null;

    const matches = [];

    const indexes =
        candidateIndexes ||
        Array.from(
            {
                length:
                    records.length
            },
            (_value, index) =>
                index
        );

    for (
        let cursor = 0;
        cursor < indexes.length;
        cursor += 1
    ) {
        assertNotCancelled(id);

        const index =
            indexes[cursor];

        const record =
            records[index];

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
                score:
                    scoreRecord(
                        record,
                        plan.expression,
                        plan.fuzzy,
                        fields,
                        index,
                        usingWorkerIndex
                    ),
                index
            });
        }

        if (
            payload.progress === true &&
            cursor > 0 &&
            cursor % PROGRESS_INTERVAL === 0
        ) {
            post("progress", id, {
                phase: "search",
                completed: cursor,
                total:
                    indexes.length
            });

            await Promise.resolve();
        }
    }

    if (plan.sort) {
        matches.sort(
            (left, right) =>
                compareRecords(
                    left.record,
                    right.record,
                    plan.sort,
                    plan.order
                ) ||
                left.index -
                right.index
        );
    } else {
        matches.sort(
            (left, right) =>
                right.score -
                left.score ||
                left.index -
                right.index
        );
    }

    const total =
        matches.length;

    const offset =
        plan.offset > 0
            ? plan.offset
            : (
                (plan.page - 1) *
                plan.limit
            );

    const selected =
        matches.slice(
            offset,
            offset + plan.limit
        );

    const facetRecords =
        payload.facetsScope === "page"
            ? selected.map(
                item => item.record
            )
            : matches.map(
                item => item.record
            );

    return {
        source:
            usingWorkerIndex
                ? "worker-index"
                : "worker-records",
        query:
            plan.raw,
        plan:
            payload.includePlan === false
                ? undefined
                : plan,
        total,
        offset,
        limit:
            plan.limit,
        page:
            plan.page,
        pages:
            plan.limit > 0
                ? Math.ceil(
                    total /
                    plan.limit
                )
                : 1,
        records:
            selected.map(item =>
                projectRecord(
                    item.record,
                    payload.select
                )
            ),
        scores:
            payload.includeScores
                ? selected.map(item => ({
                    index:
                        item.index,
                    score:
                        item.score
                }))
                : undefined,
        facets:
            buildFacets(
                facetRecords,
                payload.facets,
                payload.facetLimit
            ),
        elapsed_ms:
            performance.now() -
            started,
        index_version:
            state.version,
        candidates:
            indexes.length
    };
}

function discoverFields(records) {
    const fields =
        new Set(
            DEFAULT_TEXT_FIELDS
        );

    for (const record of records) {
        if (
            !record ||
            typeof record !== "object"
        ) {
            continue;
        }

        for (const key of Object.keys(record)) {
            fields.add(
                normalizeField(key)
            );
        }
    }

    return [...fields];
}

function normalizePlan(plan = {}) {
    return {
        raw:
            normalizeText(
                plan.raw || ""
            ),
        expression:
            normalizeExpression(
                plan.expression ||
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
        limit:
            clampInteger(
                plan.limit,
                DEFAULT_LIMIT,
                1,
                MAX_LIMIT
            ),
        offset:
            clampInteger(
                plan.offset,
                0,
                0,
                Number.MAX_SAFE_INTEGER
            ),
        page:
            clampInteger(
                plan.page,
                1,
                1,
                Number.MAX_SAFE_INTEGER
            ),
        sort:
            plan.sort
                ? normalizeField(
                    plan.sort
                )
                : null,
        order:
            String(
                plan.order || "asc"
            ).toLowerCase() === "desc"
                ? "desc"
                : "asc",
        fuzzy:
            plan.fuzzy !== false,
        explain:
            plan.explain === true
    };
}

function parseQuery(input, options = {}) {
    const raw =
        normalizeText(input);

    const tokens =
        tokenize(raw);

    const parser =
        new QueryParser(tokens);

    const expression =
        parser.parseExpression();

    if (parser.hasMore()) {
        throw new Error(
            `Unexpected query token: ${parser.peek()}`
        );
    }

    const clauses = [];
    collectClauses(
        expression,
        clauses
    );

    return normalizePlan({
        raw,
        expression,
        clauses,
        limit:
            options.limit ??
            DEFAULT_LIMIT,
        offset:
            options.offset ??
            0,
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
            options.fuzzy !== false,
        explain:
            options.explain === true
    });
}

class QueryParser {
    constructor(tokens) {
        this.tokens = tokens;
        this.position = 0;
    }

    hasMore() {
        return (
            this.position <
            this.tokens.length
        );
    }

    peek() {
        return this.tokens[
            this.position
        ];
    }

    consume() {
        return this.tokens[
            this.position++
        ];
    }

    match(value) {
        if (
            String(this.peek() || "")
                .toUpperCase() === value
        ) {
            this.position += 1;
            return true;
        }

        return false;
    }

    parseExpression() {
        if (!this.tokens.length) {
            return {
                type: "all"
            };
        }

        return this.parseOr();
    }

    parseOr() {
        let left =
            this.parseAnd();

        while (this.match("OR")) {
            left = {
                type: "or",
                left,
                right:
                    this.parseAnd()
            };
        }

        return left;
    }

    parseAnd() {
        let left =
            this.parseUnary();

        while (this.hasMore()) {
            const next =
                String(
                    this.peek()
                ).toUpperCase();

            if (
                next === "OR" ||
                next === ")"
            ) {
                break;
            }

            this.match("AND");

            left = {
                type: "and",
                left,
                right:
                    this.parseUnary()
            };
        }

        return left;
    }

    parseUnary() {
        if (this.match("NOT")) {
            return {
                type: "not",
                value:
                    this.parseUnary()
            };
        }

        const token =
            this.peek();

        if (
            typeof token === "string" &&
            token.startsWith("-") &&
            token.length > 1
        ) {
            this.consume();

            return {
                type: "not",
                value:
                    parseTerm(
                        token.slice(1)
                    )
            };
        }

        if (this.match("(")) {
            const expression =
                this.parseOr();

            if (!this.match(")")) {
                throw new Error(
                    "Unclosed query parenthesis."
                );
            }

            return expression;
        }

        if (!this.hasMore()) {
            throw new Error(
                "Incomplete search expression."
            );
        }

        return parseTerm(
            this.consume()
        );
    }
}

function parseTerm(token) {
    const comparison =
        String(token).match(
            /^([a-zA-Z_][a-zA-Z0-9_-]*)(>=|<=|!=|=|>|<|:)(.+)$/
        );

    if (comparison) {
        return {
            type: "term",
            field:
                normalizeField(
                    comparison[1]
                ),
            operator:
                comparison[2] === ":"
                    ? "contains"
                    : comparison[2],
            value:
                parseValue(
                    comparison[3]
                )
        };
    }

    const raw =
        unquote(token);

    const identifier =
        detectIdentifier(raw);

    if (identifier) {
        return {
            type: "term",
            field:
                identifier.field,
            operator: "=",
            value:
                parseValue(
                    identifier.value
                ),
            inferred: true
        };
    }

    return {
        type: "text",
        fields:
            [...DEFAULT_TEXT_FIELDS],
        operator: "contains",
        value:
            parseValue(token)
    };
}

function parseValue(value) {
    const raw =
        unquote(value);

    return {
        raw,
        regex:
            parseRegex(raw),
        wildcard:
            raw.includes("*") ||
            raw.includes("?"),
        number:
            raw !== "" &&
            Number.isFinite(
                Number(raw)
            )
                ? Number(raw)
                : null,
        boolean:
            /^(true|false)$/i.test(raw)
                ? raw.toLowerCase() ===
                  "true"
                : null
    };
}

function parseRegex(value) {
    const match =
        normalizeText(value).match(
            /^\/((?:\\.|[^/])+)\/([gimsuy]*)$/
        );

    if (!match) {
        return null;
    }

    try {
        return new RegExp(
            match[1],
            match[2]
                .replace(/g/g, "")
        );
    } catch (_error) {
        throw new Error(
            `Invalid regular expression: ${value}`
        );
    }
}

function detectIdentifier(value) {
    const text =
        normalizeText(value);

    for (
        const [
            field,
            pattern
        ] of IDENTIFIER_PATTERNS
    ) {
        if (pattern.test(text)) {
            return {
                field,
                value: text
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
        return {
            type: "all"
        };
    }

    return expression;
}

function clausesToExpression(clauses) {
    if (!clauses.length) {
        return {
            type: "all"
        };
    }

    let expression = null;

    for (const clause of clauses) {
        const term = {
            ...clause
        };

        delete term.join;
        delete term.negated;

        const value =
            clause.negated
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
                clause.join === "OR"
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
        expression.type === "term" ||
        expression.type === "text"
    ) {
        output.push(expression);
        return output;
    }

    if (expression.type === "not") {
        collectClauses(
            expression.value,
            output
        );

        return output;
    }

    collectClauses(
        expression.left,
        output
    );

    collectClauses(
        expression.right,
        output
    );

    return output;
}

function getCandidateIndexes(plan) {
    const candidates =
        candidateSetForExpression(
            plan.expression
        );

    if (!candidates) {
        return null;
    }

    return [...candidates].sort(
        (left, right) =>
            left - right
    );
}

function candidateSetForExpression(expression) {
    if (!expression) {
        return null;
    }

    if (
        expression.type === "term" &&
        expression.operator === "=" &&
        !expression.value.regex &&
        !expression.value.wildcard
    ) {
        const index =
            state.exactIndexes.get(
                expression.field
            );

        if (!index) {
            return null;
        }

        const values =
            index.get(
                normalizeText(
                    expression.value.raw
                ).toLowerCase()
            );

        return new Set(
            values || []
        );
    }

    if (expression.type === "and") {
        const left =
            candidateSetForExpression(
                expression.left
            );

        const right =
            candidateSetForExpression(
                expression.right
            );

        if (!left) {
            return right;
        }

        if (!right) {
            return left;
        }

        return intersectSets(
            left,
            right
        );
    }

    if (expression.type === "or") {
        const left =
            candidateSetForExpression(
                expression.left
            );

        const right =
            candidateSetForExpression(
                expression.right
            );

        if (!left || !right) {
            return null;
        }

        return new Set([
            ...left,
            ...right
        ]);
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
        [...smaller].filter(
            value => larger.has(value)
        )
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

        default:
            return false;
    }
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

        return selectedFields.some(
            field =>
                fieldValues(
                    record,
                    field
                ).some(
                    value =>
                        compareScalar(
                            value,
                            clause,
                            fuzzy
                        )
                )
        );
    }

    if (clause.field === "has") {
        const requested =
            normalizeField(
                clause.value.raw
            );

        return fieldValues(
            record,
            requested
        ).some(
            value =>
                value !== null &&
                value !== undefined &&
                value !== "" &&
                !(
                    Array.isArray(value) &&
                    value.length === 0
                )
        );
    }

    return fieldValues(
        record,
        clause.field
    ).some(
        value =>
            compareScalar(
                value,
                clause,
                fuzzy
            )
    );
}

function compareScalar(candidate, clause, fuzzy = true) {
    const value =
        clause.value;

    const operator =
        clause.operator;

    const candidateText =
        normalizeText(candidate);

    const queryText =
        normalizeText(value.raw);

    if (value.regex) {
        value.regex.lastIndex = 0;

        return value.regex.test(
            candidateText
        );
    }

    if (value.wildcard) {
        return wildcardRegex(
            queryText
        ).test(candidateText);
    }

    if (
        value.boolean !== null &&
        (
            operator === "=" ||
            operator === "!="
        )
    ) {
        const candidateBoolean =
            String(candidate)
                .toLowerCase() ===
            "true";

        return operator === "="
            ? candidateBoolean ===
              value.boolean
            : candidateBoolean !==
              value.boolean;
    }

    if (
        [">", ">=", "<", "<=", "=", "!="]
            .includes(operator) &&
        value.number !== null &&
        Number.isFinite(
            Number(candidate)
        )
    ) {
        return compareNumbers(
            Number(candidate),
            value.number,
            operator
        );
    }

    const left =
        candidateText.toLowerCase();

    const right =
        queryText.toLowerCase();

    if (operator === "=") {
        return left === right;
    }

    if (operator === "!=") {
        return left !== right;
    }

    if (operator === "contains") {
        return compareText(
            left,
            right,
            fuzzy
        );
    }

    if (
        [">", ">=", "<", "<="]
            .includes(operator)
    ) {
        const comparison =
            left.localeCompare(
                right,
                undefined,
                {
                    numeric: true,
                    sensitivity: "base"
                }
            );

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

function compareText(candidate, query, fuzzy) {
    const left =
        normalizeText(candidate)
            .toLowerCase();

    const right =
        normalizeText(query)
            .toLowerCase();

    if (!right) {
        return true;
    }

    if (left.includes(right)) {
        return true;
    }

    if (
        !fuzzy ||
        right.length < 4
    ) {
        return false;
    }

    const words =
        left.split(
            /[^a-z0-9._:-]+/i
        ).filter(Boolean);

    const threshold =
        right.length <= 6
            ? 1
            : 2;

    return words.some(
        word =>
            Math.abs(
                word.length -
                right.length
            ) <= threshold &&
            levenshtein(
                word,
                right
            ) <= threshold
    );
}

function scoreRecord(
    record,
    expression,
    fuzzy,
    fields,
    index,
    indexed
) {
    const leaves = [];

    collectPositiveLeaves(
        expression,
        leaves,
        false
    );

    let score = 0;

    for (const clause of leaves) {
        const targetFields =
            clause.type === "text"
                ? (
                    clause.fields ||
                    fields
                )
                : [
                    clause.field
                ];

        for (const field of targetFields) {
            for (
                const value of
                fieldValues(
                    record,
                    field
                )
            ) {
                const candidate =
                    normalizeText(value)
                        .toLowerCase();

                const query =
                    normalizeText(
                        clause.value.raw
                    ).toLowerCase();

                if (!query) {
                    continue;
                }

                if (candidate === query) {
                    score +=
                        fieldWeight(field) *
                        10;
                } else if (
                    candidate.startsWith(
                        query
                    )
                ) {
                    score +=
                        fieldWeight(field) *
                        6;
                } else if (
                    candidate.includes(
                        query
                    )
                ) {
                    score +=
                        fieldWeight(field) *
                        3;
                } else if (
                    compareText(
                        candidate,
                        query,
                        fuzzy
                    )
                ) {
                    score +=
                        fieldWeight(field);
                }
            }
        }
    }

    return score;
}

function collectPositiveLeaves(
    expression,
    output,
    negated
) {
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
        collectPositiveLeaves(
            expression.left,
            output,
            negated
        );

        collectPositiveLeaves(
            expression.right,
            output,
            negated
        );

        return;
    }

    if (
        !negated &&
        (
            expression.type === "term" ||
            expression.type === "text"
        )
    ) {
        output.push(expression);
    }
}

function fieldWeight(field) {
    const normalized =
        normalizeField(field);

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
        return 8;
    }

    if (
        normalized ===
        "scientific_name"
    ) {
        return 7;
    }

    if (
        normalized ===
        "common_name"
    ) {
        return 6;
    }

    if (
        [
            "genus",
            "species",
            "family",
            "order",
            "class",
            "phylum",
            "kingdom"
        ].includes(normalized)
    ) {
        return 4;
    }

    return 1;
}

function compareRecords(left, right, field, order) {
    const a =
        fieldValues(
            left,
            field
        )[0];

    const b =
        fieldValues(
            right,
            field
        )[0];

    const direction =
        order === "desc"
            ? -1
            : 1;

    if (a === b) {
        return 0;
    }

    if (
        a === undefined ||
        a === null
    ) {
        return 1;
    }

    if (
        b === undefined ||
        b === null
    ) {
        return -1;
    }

    if (
        Number.isFinite(Number(a)) &&
        Number.isFinite(Number(b))
    ) {
        return (
            Number(a) -
            Number(b)
        ) * direction;
    }

    const aDate =
        Date.parse(a);

    const bDate =
        Date.parse(b);

    if (
        Number.isFinite(aDate) &&
        Number.isFinite(bDate)
    ) {
        return (
            aDate -
            bDate
        ) * direction;
    }

    return String(a)
        .localeCompare(
            String(b),
            undefined,
            {
                numeric: true,
                sensitivity: "base"
            }
        ) * direction;
}

function buildFacets(records, requested, facetLimit = 100) {
    const fields =
        Array.isArray(requested)
            ? [
                ...new Set(
                    requested.map(
                        normalizeField
                    )
                )
            ]
            : [];

    if (!fields.length) {
        return {};
    }

    const limit =
        clampInteger(
            facetLimit,
            100,
            1,
            1000
        );

    const facets = {};

    for (const field of fields) {
        const counts =
            new Map();

        for (const record of records) {
            const seen =
                new Set();

            for (
                const value of
                fieldValues(
                    record,
                    field
                )
            ) {
                const key =
                    normalizeText(value);

                if (
                    !key ||
                    seen.has(key)
                ) {
                    continue;
                }

                seen.add(key);

                counts.set(
                    key,
                    (
                        counts.get(key) ||
                        0
                    ) + 1
                );
            }
        }

        facets[field] =
            [...counts.entries()]
                .sort(
                    (left, right) =>
                        right[1] -
                        left[1] ||
                        left[0].localeCompare(
                            right[0]
                        )
                )
                .slice(0, limit)
                .map(
                    ([
                        value,
                        count
                    ]) => ({
                        value,
                        count
                    })
                );
    }

    return facets;
}

function projectRecord(record, select) {
    if (
        !Array.isArray(select) ||
        !select.length
    ) {
        return record;
    }

    const output = {};

    for (const field of select) {
        const normalized =
            normalizeField(field);

        const values =
            fieldValues(
                record,
                normalized
            );

        output[normalized] =
            values.length <= 1
                ? values[0] ?? null
                : values;
    }

    return output;
}

function fieldValues(record, field) {
    const normalized =
        normalizeField(field);

    if (
        !record ||
        typeof record !== "object"
    ) {
        return [];
    }

    const direct =
        record[normalized];

    if (direct !== undefined) {
        return flatten(direct);
    }

    const camel =
        normalized.replace(
            /_([a-z])/g,
            (_match, character) =>
                character.toUpperCase()
        );

    if (
        record[camel] !==
        undefined
    ) {
        return flatten(
            record[camel]
        );
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

    if (
        normalized ===
        "scientific_name"
    ) {
        return flatten([
            record.scientific_name,
            record.scientificName,
            record.canonical_name,
            record.canonicalName,
            record.accepted_name,
            record.acceptedName
        ]);
    }

    if (
        normalized ===
        "common_name"
    ) {
        return flatten([
            record.common_name,
            record.commonName,
            record.vernacular_name,
            record.vernacularName,
            record.preferred_common_name,
            record.preferredCommonName
        ]);
    }

    if (
        normalized ===
        "speciedex_id"
    ) {
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

    return [];
}

function flatten(value, output = []) {
    if (
        value === undefined ||
        value === null
    ) {
        return output;
    }

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
        for (
            const item of
            Object.values(value)
        ) {
            flatten(item, output);
        }

        return output;
    }

    output.push(value);
    return output;
}

function unquote(value) {
    const text =
        normalizeText(value);

    if (
        text.length >= 2 &&
        (
            (
                text.startsWith('"') &&
                text.endsWith('"')
            ) ||
            (
                text.startsWith("'") &&
                text.endsWith("'")
            )
        )
    ) {
        return text.slice(1, -1)
            .replace(/\\(["'\\])/g, "$1");
    }

    return text;
}

function tokenize(input) {
    const tokens = [];
    let current = "";
    let quote = null;
    let escaped = false;
    let regex = false;
    let parenthesisDepth = 0;

    const pushCurrent = () => {
        if (current) {
            tokens.push(current);
            current = "";
        }
    };

    for (
        let index = 0;
        index < input.length;
        index += 1
    ) {
        const character =
            input[index];

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
                    /[gimsuy]/.test(
                        input[index + 1] ||
                        ""
                    )
                ) {
                    current +=
                        input[++index];
                }
            }

            continue;
        }

        if (
            character === '"' ||
            character === "'"
        ) {
            quote = character;
            current += character;
            continue;
        }

        if (
            character === "/" &&
            !current
        ) {
            regex = true;
            current += character;
            continue;
        }

        if (
            character === "(" ||
            character === ")"
        ) {
            pushCurrent();
            tokens.push(character);

            parenthesisDepth +=
                character === "("
                    ? 1
                    : -1;

            if (parenthesisDepth < 0) {
                throw new Error(
                    "Unexpected closing parenthesis."
                );
            }

            continue;
        }

        if (/\s/.test(character)) {
            pushCurrent();
            continue;
        }

        current += character;
    }

    if (quote) {
        throw new Error(
            "Unclosed quoted string."
        );
    }

    if (regex) {
        throw new Error(
            "Unclosed regular expression."
        );
    }

    if (parenthesisDepth !== 0) {
        throw new Error(
            "Unclosed query parenthesis."
        );
    }

    pushCurrent();

    return tokens;
}

function wildcardRegex(value) {
    const escaped =
        value
            .replace(
                /[.+^${}()|[\]\\]/g,
                "\\$&"
            )
            .replace(/\*/g, ".*")
            .replace(/\?/g, ".");

    return new RegExp(
        `^${escaped}$`,
        "i"
    );
}

function levenshtein(left, right) {
    const a =
        String(left).toLowerCase();

    const b =
        String(right).toLowerCase();

    if (a === b) {
        return 0;
    }

    if (!a.length) {
        return b.length;
    }

    if (!b.length) {
        return a.length;
    }

    const previous =
        new Uint32Array(
            a.length + 1
        );

    const current =
        new Uint32Array(
            a.length + 1
        );

    for (
        let column = 0;
        column <= a.length;
        column += 1
    ) {
        previous[column] =
            column;
    }

    for (
        let row = 1;
        row <= b.length;
        row += 1
    ) {
        current[0] = row;

        for (
            let column = 1;
            column <= a.length;
            column += 1
        ) {
            const substitution =
                previous[
                    column - 1
                ] +
                (
                    b[row - 1] ===
                    a[column - 1]
                        ? 0
                        : 1
                );

            current[column] =
                Math.min(
                    substitution,
                    current[
                        column - 1
                    ] + 1,
                    previous[column] + 1
                );
        }

        previous.set(current);
    }

    return previous[a.length];
}
