/*
========================================================================
Speciedex.org
Index Worker
========================================================================

High-performance worker-side index engine for SpeciedexTerminal.

Supports:

    • Persistent in-worker document indexes
    • Exact, prefix, contains, and fuzzy text lookup
    • Field-specific and global full-text search
    • Deterministic relevance scoring
    • Filtering, sorting, pagination, projection, and facets
    • Incremental add, update, remove, rebuild, and clear operations
    • Request cancellation and progress events
    • Structured worker responses and safe error serialization

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

"use strict";

const WORKER_VERSION = "2.0.0";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;
const MAX_DOCUMENTS = 1000000;
const MAX_FIELDS = 512;
const PROGRESS_INTERVAL = 5000;

const state = {
    documents: [],
    fields: [],
    idField: "id",
    exactIndexes: new Map(),
    tokenIndex: new Map(),
    documentTokens: [],
    version: 0,
    builtAt: null
};

const activeRequests = new Map();

function normalizeText(value) {
    return String(value ?? "").trim();
}

function normalizeField(value) {
    return normalizeText(value)
        .replace(/-/g, "_");
}

function clampInteger(value, fallback, minimum, maximum) {
    const parsed = Number.parseInt(value, 10);

    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.min(
        maximum,
        Math.max(minimum, parsed)
    );
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
    post(
        "response",
        id,
        error
            ? {
                error:
                    serializeError(error)
            }
            : {
                result
            }
    );
}

function assertActive(id) {
    if (
        id !== null &&
        activeRequests.get(id)?.cancelled
    ) {
        const error =
            new Error(
                "Index worker request cancelled."
            );

        error.name = "AbortError";
        error.code =
            "INDEX_WORKER_CANCELLED";

        throw error;
    }
}

self.addEventListener(
    "message",
    async event => {
        const message =
            event.data || {};

        const id =
            message.id ?? null;

        const type =
            normalizeText(
                message.type
            ).toLowerCase();

        if (type === "cancel") {
            const targetId =
                message.payload?.id ??
                message.targetId ??
                id;

            if (
                activeRequests.has(
                    targetId
                )
            ) {
                activeRequests.get(
                    targetId
                ).cancelled = true;
            }

            respond(
                id,
                {
                    cancelled: true,
                    targetId
                }
            );

            return;
        }

        activeRequests.set(
            id,
            {
                cancelled: false,
                startedAt:
                    performance.now()
            }
        );

        try {
            const result =
                await handle(
                    type,
                    message.payload || {},
                    id
                );

            respond(
                id,
                result
            );
        } catch (error) {
            respond(
                id,
                null,
                error
            );
        } finally {
            activeRequests.delete(id);
        }
    }
);

async function handle(
    type,
    payload,
    id
) {
    switch (type) {
        case "build":
        case "rebuild":
            return buildIndex(
                payload,
                id
            );

        case "search":
            return searchIndex(
                payload,
                id
            );

        case "get":
            return getDocument(
                payload
            );

        case "add":
            return addDocuments(
                payload,
                id
            );

        case "update":
            return updateDocuments(
                payload,
                id
            );

        case "remove":
        case "delete":
            return removeDocuments(
                payload,
                id
            );

        case "fields":
            return {
                fields:
                    [...state.fields],
                idField:
                    state.idField
            };

        case "facets":
            return buildFacets(
                state.documents,
                payload.fields,
                payload.limit
            );

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
                `Unsupported index operation: ${type || "(empty)"}`
            );
    }
}

function status() {
    return {
        ready: true,
        workerVersion:
            WORKER_VERSION,
        documents:
            state.documents.length,
        fields:
            [...state.fields],
        exactIndexes:
            state.exactIndexes.size,
        tokens:
            state.tokenIndex.size,
        idField:
            state.idField,
        version:
            state.version,
        builtAt:
            state.builtAt,
        activeRequests:
            activeRequests.size
    };
}

async function buildIndex(
    payload = {},
    id = null
) {
    const documents =
        Array.isArray(
            payload.records
        )
            ? payload.records
            : (
                Array.isArray(
                    payload.documents
                )
                    ? payload.documents
                    : []
            );

    if (
        documents.length >
        MAX_DOCUMENTS
    ) {
        throw new RangeError(
            `Index document limit exceeded: ${documents.length} > ${MAX_DOCUMENTS}.`
        );
    }

    const fields =
        Array.isArray(payload.fields) &&
        payload.fields.length
            ? [
                ...new Set(
                    payload.fields
                        .map(
                            normalizeField
                        )
                        .filter(Boolean)
                )
            ]
            : discoverFields(
                documents
            );

    if (
        fields.length >
        MAX_FIELDS
    ) {
        throw new RangeError(
            `Index field limit exceeded: ${fields.length} > ${MAX_FIELDS}.`
        );
    }

    state.documents =
        documents;

    state.fields =
        fields;

    state.idField =
        normalizeField(
            payload.idField ||
            payload.key ||
            "id"
        ) || "id";

    state.exactIndexes =
        new Map();

    state.tokenIndex =
        new Map();

    state.documentTokens =
        new Array(
            documents.length
        );

    for (const field of fields) {
        state.exactIndexes.set(
            field,
            new Map()
        );
    }

    for (
        let index = 0;
        index < documents.length;
        index += 1
    ) {
        assertActive(id);

        indexDocument(
            documents[index],
            index
        );

        if (
            payload.progress !== false &&
            index > 0 &&
            index %
                PROGRESS_INTERVAL ===
                0
        ) {
            post(
                "progress",
                id,
                {
                    phase:
                        "build",
                    completed:
                        index,
                    total:
                        documents.length
                }
            );

            await Promise.resolve();
        }
    }

    state.version += 1;
    state.builtAt =
        new Date().toISOString();

    return status();
}

function indexDocument(
    document,
    index
) {
    const documentTokenSet =
        new Set();

    for (const field of state.fields) {
        const values =
            fieldValues(
                document,
                field
            );

        const exactIndex =
            state.exactIndexes.get(
                field
            );

        for (const value of values) {
            const normalized =
                normalizeText(value)
                    .toLowerCase();

            if (!normalized) {
                continue;
            }

            let exactMatches =
                exactIndex.get(
                    normalized
                );

            if (!exactMatches) {
                exactMatches =
                    new Set();

                exactIndex.set(
                    normalized,
                    exactMatches
                );
            }

            exactMatches.add(index);

            for (
                const token of
                tokenizeValue(
                    normalized
                )
            ) {
                documentTokenSet.add(
                    token
                );

                let tokenMatches =
                    state.tokenIndex.get(
                        token
                    );

                if (!tokenMatches) {
                    tokenMatches =
                        new Set();

                    state.tokenIndex.set(
                        token,
                        tokenMatches
                    );
                }

                tokenMatches.add(index);
            }
        }
    }

    state.documentTokens[index] =
        documentTokenSet;
}

function clearIndex() {
    state.documents = [];
    state.fields = [];
    state.idField = "id";
    state.exactIndexes =
        new Map();
    state.tokenIndex =
        new Map();
    state.documentTokens = [];
    state.version += 1;
    state.builtAt = null;
}

function discoverFields(
    documents
) {
    const fields =
        new Set();

    for (const document of documents) {
        if (
            !document ||
            typeof document !==
                "object" ||
            Array.isArray(document)
        ) {
            continue;
        }

        for (
            const key of
            Object.keys(document)
        ) {
            fields.add(
                normalizeField(key)
            );
        }
    }

    return [...fields];
}

async function searchIndex(
    payload = {},
    id = null
) {
    const startedAt =
        performance.now();

    const query =
        normalizeText(
            payload.query
        );

    const limit =
        clampInteger(
            payload.limit,
            DEFAULT_LIMIT,
            1,
            MAX_LIMIT
        );

    const offset =
        clampInteger(
            payload.offset,
            0,
            0,
            Number.MAX_SAFE_INTEGER
        );

    const page =
        clampInteger(
            payload.page,
            1,
            1,
            Number.MAX_SAFE_INTEGER
        );

    const effectiveOffset =
        offset > 0
            ? offset
            : (
                page - 1
            ) * limit;

    const fields =
        Array.isArray(
            payload.fields
        ) &&
        payload.fields.length
            ? payload.fields
                .map(
                    normalizeField
                )
                .filter(Boolean)
            : state.fields;

    const filters =
        payload.filters &&
        typeof payload.filters ===
            "object"
            ? payload.filters
            : (
                payload.filter &&
                typeof payload.filter ===
                    "object"
                    ? payload.filter
                    : {}
            );

    const candidateIndexes =
        getCandidateIndexes(
            query,
            fields,
            payload
        );

    const matches = [];

    for (
        let cursor = 0;
        cursor <
            candidateIndexes.length;
        cursor += 1
    ) {
        assertActive(id);

        const index =
            candidateIndexes[cursor];

        const document =
            state.documents[index];

        if (
            !matchesFilters(
                document,
                filters
            )
        ) {
            continue;
        }

        const score =
            scoreDocument(
                document,
                query,
                fields,
                payload
            );

        if (
            query &&
            score <= 0
        ) {
            continue;
        }

        matches.push({
            document,
            index,
            score
        });

        if (
            payload.progress === true &&
            cursor > 0 &&
            cursor %
                PROGRESS_INTERVAL ===
                0
        ) {
            post(
                "progress",
                id,
                {
                    phase:
                        "search",
                    completed:
                        cursor,
                    total:
                        candidateIndexes.length
                }
            );

            await Promise.resolve();
        }
    }

    if (payload.sort) {
        matches.sort(
            (left, right) =>
                compareDocuments(
                    left.document,
                    right.document,
                    payload.sort,
                    payload.order
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

    const selected =
        matches.slice(
            effectiveOffset,
            effectiveOffset +
                limit
        );

    return {
        query,
        total,
        offset:
            effectiveOffset,
        limit,
        page:
            Math.floor(
                effectiveOffset /
                limit
            ) + 1,
        pages:
            Math.ceil(
                total / limit
            ),
        records:
            selected.map(
                match =>
                    projectDocument(
                        match.document,
                        payload.select
                    )
            ),
        scores:
            payload.includeScores ===
            true
                ? selected.map(
                    match => ({
                        index:
                            match.index,
                        score:
                            match.score
                    })
                )
                : undefined,
        facets:
            buildFacets(
                payload.facetsScope ===
                    "page"
                    ? selected.map(
                        match =>
                            match.document
                    )
                    : matches.map(
                        match =>
                            match.document
                    ),
                payload.facets,
                payload.facetLimit
            ),
        candidates:
            candidateIndexes.length,
        elapsed_ms:
            performance.now() -
            startedAt,
        index_version:
            state.version
    };
}

function getCandidateIndexes(
    query,
    fields,
    options
) {
    if (!query) {
        return Array.from(
            {
                length:
                    state.documents.length
            },
            (_value, index) =>
                index
        );
    }

    const normalizedQuery =
        query.toLowerCase();

    if (
        options.exact === true &&
        fields.length === 1
    ) {
        const exactIndex =
            state.exactIndexes.get(
                fields[0]
            );

        const matches =
            exactIndex?.get(
                normalizedQuery
            );

        return matches
            ? [...matches]
            : [];
    }

    const tokens =
        tokenizeValue(
            normalizedQuery
        );

    const tokenSets =
        tokens
            .map(
                token =>
                    state.tokenIndex.get(
                        token
                    )
            )
            .filter(Boolean);

    if (!tokenSets.length) {
        return Array.from(
            {
                length:
                    state.documents.length
            },
            (_value, index) =>
                index
        );
    }

    const mode =
        String(
            options.tokenMode ||
            "and"
        ).toLowerCase();

    if (mode === "or") {
        return [
            ...new Set(
                tokenSets.flatMap(
                    set =>
                        [...set]
                )
            )
        ];
    }

    let result =
        new Set(
            tokenSets[0]
        );

    for (
        let index = 1;
        index <
            tokenSets.length;
        index += 1
    ) {
        result =
            intersectSets(
                result,
                tokenSets[index]
            );
    }

    return [...result];
}

function scoreDocument(
    document,
    query,
    fields,
    options = {}
) {
    if (!query) {
        return 1;
    }

    const normalizedQuery =
        query.toLowerCase();

    const queryTokens =
        tokenizeValue(
            normalizedQuery
        );

    let score = 0;

    for (const field of fields) {
        const weight =
            fieldWeight(
                field,
                options.weights
            );

        for (
            const value of
            fieldValues(
                document,
                field
            )
        ) {
            const candidate =
                normalizeText(value)
                    .toLowerCase();

            if (!candidate) {
                continue;
            }

            if (
                candidate ===
                normalizedQuery
            ) {
                score +=
                    20 * weight;

                continue;
            }

            if (
                candidate.startsWith(
                    normalizedQuery
                )
            ) {
                score +=
                    12 * weight;
            }

            if (
                candidate.includes(
                    normalizedQuery
                )
            ) {
                score +=
                    8 * weight;
            }

            const candidateTokens =
                new Set(
                    tokenizeValue(
                        candidate
                    )
                );

            for (
                const token of
                queryTokens
            ) {
                if (
                    candidateTokens.has(
                        token
                    )
                ) {
                    score +=
                        3 * weight;
                } else if (
                    options.fuzzy !==
                        false &&
                    fuzzyTokenMatch(
                        candidateTokens,
                        token
                    )
                ) {
                    score += weight;
                }
            }
        }
    }

    return score;
}

function fieldWeight(
    field,
    weights
) {
    if (
        weights &&
        typeof weights ===
            "object" &&
        Number.isFinite(
            Number(
                weights[field]
            )
        )
    ) {
        return Number(
            weights[field]
        );
    }

    const normalized =
        normalizeField(field)
            .toLowerCase();

    if (
        normalized ===
            state.idField ||
        normalized.endsWith(
            "_id"
        )
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

function fuzzyTokenMatch(
    candidateTokens,
    queryToken
) {
    if (
        queryToken.length < 4
    ) {
        return false;
    }

    const threshold =
        queryToken.length <= 6
            ? 1
            : 2;

    for (
        const candidate of
        candidateTokens
    ) {
        if (
            Math.abs(
                candidate.length -
                queryToken.length
            ) > threshold
        ) {
            continue;
        }

        if (
            levenshtein(
                candidate,
                queryToken
            ) <= threshold
        ) {
            return true;
        }
    }

    return false;
}

function matchesFilters(
    document,
    filters
) {
    for (
        const [
            field,
            expected
        ] of Object.entries(
            filters
        )
    ) {
        const values =
            fieldValues(
                document,
                field
            );

        if (
            !values.some(
                value =>
                    matchFilterValue(
                        value,
                        expected
                    )
            )
        ) {
            return false;
        }
    }

    return true;
}

function matchFilterValue(
    actual,
    expected
) {
    if (
        Array.isArray(expected)
    ) {
        return expected.some(
            value =>
                compareValues(
                    actual,
                    value
                )
        );
    }

    if (
        expected &&
        typeof expected ===
            "object"
    ) {
        if (
            "$gt" in expected &&
            !(actual >
                expected.$gt)
        ) {
            return false;
        }

        if (
            "$gte" in expected &&
            !(actual >=
                expected.$gte)
        ) {
            return false;
        }

        if (
            "$lt" in expected &&
            !(actual <
                expected.$lt)
        ) {
            return false;
        }

        if (
            "$lte" in expected &&
            !(actual <=
                expected.$lte)
        ) {
            return false;
        }

        if (
            "$ne" in expected &&
            compareValues(
                actual,
                expected.$ne
            )
        ) {
            return false;
        }

        if (
            "$contains" in
                expected &&
            !normalizeText(actual)
                .toLowerCase()
                .includes(
                    normalizeText(
                        expected.$contains
                    ).toLowerCase()
                )
        ) {
            return false;
        }

        if (
            "$in" in expected &&
            Array.isArray(
                expected.$in
            ) &&
            !expected.$in.some(
                value =>
                    compareValues(
                        actual,
                        value
                    )
            )
        ) {
            return false;
        }

        return true;
    }

    return compareValues(
        actual,
        expected
    );
}

function compareValues(
    left,
    right
) {
    if (left === right) {
        return true;
    }

    if (
        left === null ||
        left === undefined ||
        right === null ||
        right === undefined
    ) {
        return false;
    }

    if (
        Number.isFinite(
            Number(left)
        ) &&
        Number.isFinite(
            Number(right)
        )
    ) {
        return (
            Number(left) ===
            Number(right)
        );
    }

    return (
        normalizeText(left)
            .toLowerCase() ===
        normalizeText(right)
            .toLowerCase()
    );
}

function compareDocuments(
    left,
    right,
    field,
    order = "asc"
) {
    const direction =
        String(order)
            .toLowerCase() ===
        "desc"
            ? -1
            : 1;

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
        Number.isFinite(
            Number(a)
        ) &&
        Number.isFinite(
            Number(b)
        )
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

    return normalizeText(a)
        .localeCompare(
            normalizeText(b),
            undefined,
            {
                numeric: true,
                sensitivity:
                    "base"
            }
        ) * direction;
}

function projectDocument(
    document,
    fields
) {
    if (
        !Array.isArray(fields) ||
        !fields.length
    ) {
        return document;
    }

    const output = {};

    for (const field of fields) {
        const values =
            fieldValues(
                document,
                field
            );

        output[field] =
            values.length <= 1
                ? values[0] ?? null
                : values;
    }

    return output;
}

function buildFacets(
    documents,
    requested,
    limit = 100
) {
    const fields =
        Array.isArray(requested)
            ? [
                ...new Set(
                    requested
                        .map(
                            normalizeField
                        )
                        .filter(Boolean)
                )
            ]
            : [];

    if (!fields.length) {
        return {};
    }

    const facetLimit =
        clampInteger(
            limit,
            100,
            1,
            1000
        );

    const facets = {};

    for (const field of fields) {
        const counts =
            new Map();

        for (
            const document of
            documents
        ) {
            const seen =
                new Set();

            for (
                const value of
                fieldValues(
                    document,
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
                        left[0]
                            .localeCompare(
                                right[0]
                            )
                )
                .slice(
                    0,
                    facetLimit
                )
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

function getDocument(
    payload = {}
) {
    const idField =
        normalizeField(
            payload.idField ||
            state.idField
        );

    const idValue =
        payload.id ??
        payload.value;

    if (
        idValue === undefined ||
        idValue === null
    ) {
        throw new TypeError(
            "A document identifier is required."
        );
    }

    const document =
        state.documents.find(
            record =>
                fieldValues(
                    record,
                    idField
                ).some(
                    value =>
                        compareValues(
                            value,
                            idValue
                        )
                )
        );

    return document || null;
}

async function addDocuments(
    payload = {},
    id = null
) {
    const incoming =
        Array.isArray(
            payload.records
        )
            ? payload.records
            : (
                Array.isArray(
                    payload.documents
                )
                    ? payload.documents
                    : []
            );

    if (
        state.documents.length +
        incoming.length >
        MAX_DOCUMENTS
    ) {
        throw new RangeError(
            "Index document limit exceeded."
        );
    }

    const start =
        state.documents.length;

    state.documents.push(
        ...incoming
    );

    state.documentTokens.length =
        state.documents.length;

    for (
        let index = 0;
        index < incoming.length;
        index += 1
    ) {
        assertActive(id);

        indexDocument(
            incoming[index],
            start + index
        );

        if (
            index > 0 &&
            index %
                PROGRESS_INTERVAL ===
                0
        ) {
            post(
                "progress",
                id,
                {
                    phase:
                        "add",
                    completed:
                        index,
                    total:
                        incoming.length
                }
            );

            await Promise.resolve();
        }
    }

    state.version += 1;

    return {
        added:
            incoming.length,
        documents:
            state.documents.length,
        version:
            state.version
    };
}

async function updateDocuments(
    payload = {},
    id = null
) {
    const incoming =
        Array.isArray(
            payload.records
        )
            ? payload.records
            : (
                Array.isArray(
                    payload.documents
                )
                    ? payload.documents
                    : []
            );

    const idField =
        normalizeField(
            payload.idField ||
            state.idField
        );

    const byId =
        new Map();

    for (
        let index = 0;
        index <
            state.documents.length;
        index += 1
    ) {
        const value =
            fieldValues(
                state.documents[index],
                idField
            )[0];

        if (
            value !== undefined &&
            value !== null
        ) {
            byId.set(
                canonicalKey(value),
                index
            );
        }
    }

    let updated = 0;
    let added = 0;

    for (
        let index = 0;
        index < incoming.length;
        index += 1
    ) {
        assertActive(id);

        const document =
            incoming[index];

        const value =
            fieldValues(
                document,
                idField
            )[0];

        const key =
            canonicalKey(value);

        if (
            key !== null &&
            byId.has(key)
        ) {
            const targetIndex =
                byId.get(key);

            state.documents[
                targetIndex
            ] =
                payload.replace ===
                true
                    ? document
                    : {
                        ...state.documents[
                            targetIndex
                        ],
                        ...document
                    };

            updated += 1;
        } else {
            state.documents.push(
                document
            );

            added += 1;
        }

        if (
            index > 0 &&
            index %
                PROGRESS_INTERVAL ===
                0
        ) {
            post(
                "progress",
                id,
                {
                    phase:
                        "update",
                    completed:
                        index,
                    total:
                        incoming.length
                }
            );

            await Promise.resolve();
        }
    }

    await rebuildCurrentIndex(
        id,
        payload.progress
    );

    return {
        updated,
        added,
        documents:
            state.documents.length,
        version:
            state.version
    };
}

async function removeDocuments(
    payload = {},
    id = null
) {
    const idField =
        normalizeField(
            payload.idField ||
            state.idField
        );

    const ids =
        Array.isArray(payload.ids)
            ? payload.ids
            : [
                payload.id ??
                payload.value
            ].filter(
                value =>
                    value !==
                        undefined &&
                    value !== null
            );

    const keys =
        new Set(
            ids.map(
                canonicalKey
            )
        );

    const retained = [];
    let removed = 0;

    for (
        let index = 0;
        index <
            state.documents.length;
        index += 1
    ) {
        assertActive(id);

        const document =
            state.documents[index];

        const value =
            fieldValues(
                document,
                idField
            )[0];

        if (
            keys.has(
                canonicalKey(value)
            )
        ) {
            removed += 1;
        } else {
            retained.push(document);
        }

        if (
            index > 0 &&
            index %
                PROGRESS_INTERVAL ===
                0
        ) {
            post(
                "progress",
                id,
                {
                    phase:
                        "remove",
                    completed:
                        index,
                    total:
                        state.documents.length
                }
            );

            await Promise.resolve();
        }
    }

    state.documents =
        retained;

    await rebuildCurrentIndex(
        id,
        payload.progress
    );

    return {
        removed,
        documents:
            state.documents.length,
        version:
            state.version
    };
}

async function rebuildCurrentIndex(
    id,
    progress
) {
    const documents =
        state.documents;

    const fields =
        state.fields;

    state.exactIndexes =
        new Map();

    state.tokenIndex =
        new Map();

    state.documentTokens =
        new Array(
            documents.length
        );

    for (const field of fields) {
        state.exactIndexes.set(
            field,
            new Map()
        );
    }

    for (
        let index = 0;
        index < documents.length;
        index += 1
    ) {
        assertActive(id);

        indexDocument(
            documents[index],
            index
        );

        if (
            progress === true &&
            index > 0 &&
            index %
                PROGRESS_INTERVAL ===
                0
        ) {
            post(
                "progress",
                id,
                {
                    phase:
                        "rebuild",
                    completed:
                        index,
                    total:
                        documents.length
                }
            );

            await Promise.resolve();
        }
    }

    state.version += 1;
    state.builtAt =
        new Date().toISOString();
}

function fieldValues(
    document,
    field
) {
    if (
        !document ||
        typeof document !==
            "object"
    ) {
        return [];
    }

    const normalized =
        normalizeField(field);

    if (
        document[normalized] !==
        undefined
    ) {
        return flatten(
            document[normalized]
        );
    }

    const camel =
        normalized.replace(
            /_([a-z])/g,
            (_match, character) =>
                character.toUpperCase()
        );

    if (
        document[camel] !==
        undefined
    ) {
        return flatten(
            document[camel]
        );
    }

    const parts =
        normalized
            .split(".")
            .filter(Boolean);

    if (parts.length > 1) {
        let value =
            document;

        for (const part of parts) {
            if (
                value === null ||
                value === undefined
            ) {
                return [];
            }

            value =
                value[part];
        }

        return flatten(value);
    }

    return [];
}

function flatten(
    value,
    output = []
) {
    if (
        value === undefined ||
        value === null
    ) {
        return output;
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            flatten(
                item,
                output
            );
        }

        return output;
    }

    if (
        value &&
        typeof value ===
            "object"
    ) {
        for (
            const item of
            Object.values(value)
        ) {
            flatten(
                item,
                output
            );
        }

        return output;
    }

    output.push(value);

    return output;
}

function tokenizeValue(value) {
    return [
        ...new Set(
            normalizeText(value)
                .toLowerCase()
                .split(
                    /[^a-z0-9._:-]+/i
                )
                .filter(Boolean)
        )
    ];
}

function intersectSets(
    left,
    right
) {
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
            value =>
                larger.has(value)
        )
    );
}

function canonicalKey(value) {
    if (
        value === null ||
        value === undefined
    ) {
        return null;
    }

    if (
        typeof value ===
        "object"
    ) {
        try {
            return JSON.stringify(
                value
            );
        } catch (_error) {
            return String(value);
        }
    }

    return String(value)
        .toLowerCase();
}

function levenshtein(
    left,
    right
) {
    const a =
        String(left)
            .toLowerCase();

    const b =
        String(right)
            .toLowerCase();

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
                    previous[column] +
                        1
                );
        }

        previous.set(current);
    }

    return previous[
        a.length
    ];
}
