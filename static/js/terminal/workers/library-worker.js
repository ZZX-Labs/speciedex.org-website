/*
========================================================================
Speciedex.org
Library Worker
========================================================================

High-performance worker-side collection storage for SpeciedexTerminal.

Supports:

    • Named in-memory collections
    • Set, get, append, merge, delete, rename, clear, and list operations
    • Filtering, sorting, pagination, projection, and statistics
    • Deduplication and collection cloning
    • Import and export helpers
    • Request cancellation and progress events
    • Structured worker responses and safe error serialization

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

"use strict";

const WORKER_VERSION = "2.0.0";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 10000;
const MAX_COLLECTIONS = 1000;
const MAX_RECORDS_PER_COLLECTION = 1000000;
const PROGRESS_INTERVAL = 5000;

const collections = new Map();
const activeRequests = new Map();

function normalizeText(value) {
    return String(value ?? "").trim();
}

function normalizeName(value) {
    const name = normalizeText(value);

    if (!name) {
        throw new TypeError(
            "A library collection name is required."
        );
    }

    if (
        name.includes("..") ||
        name.includes("\\") ||
        name.includes("/")
    ) {
        throw new TypeError(
            `Invalid library collection name: ${value}`
        );
    }

    return name;
}

function integer(value, fallback, minimum, maximum) {
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
                "Library worker request cancelled."
            );

        error.name = "AbortError";
        error.code =
            "LIBRARY_WORKER_CANCELLED";

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
        case "set":
            return setCollection(
                payload,
                id
            );

        case "get":
            return getCollection(
                payload,
                id
            );

        case "append":
            return appendCollection(
                payload,
                id
            );

        case "merge":
            return mergeCollection(
                payload,
                id
            );

        case "list":
            return listCollections(
                payload
            );

        case "has":
            return collections.has(
                normalizeName(
                    payload.name
                )
            );

        case "delete":
            return deleteCollection(
                payload
            );

        case "rename":
            return renameCollection(
                payload
            );

        case "clone":
            return cloneCollection(
                payload,
                id
            );

        case "clear":
            return clearCollections(
                payload
            );

        case "count":
            return countCollection(
                payload
            );

        case "stats":
            return collectionStats(
                payload
            );

        case "dedupe":
            return deduplicateCollection(
                payload,
                id
            );

        case "export":
            return exportCollection(
                payload
            );

        case "import":
            return importCollection(
                payload,
                id
            );

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
                `Unsupported library operation: ${type || "(empty)"}`
            );
    }
}

function createCollection(
    name,
    records = [],
    metadata = {}
) {
    return {
        name,
        records,
        metadata: {
            ...(
                metadata &&
                typeof metadata ===
                "object"
                    ? metadata
                    : {}
            )
        },
        createdAt:
            new Date().toISOString(),
        updatedAt:
            new Date().toISOString(),
        version: 1
    };
}

function requireCollection(name) {
    const normalized =
        normalizeName(name);

    const collection =
        collections.get(
            normalized
        );

    if (!collection) {
        throw new Error(
            `Unknown library collection: ${normalized}`
        );
    }

    return collection;
}

function ensureCapacity(
    records,
    name
) {
    if (
        records.length >
        MAX_RECORDS_PER_COLLECTION
    ) {
        throw new RangeError(
            `Collection "${name}" exceeds the maximum record count of ${MAX_RECORDS_PER_COLLECTION}.`
        );
    }
}

function touch(collection) {
    collection.updatedAt =
        new Date().toISOString();

    collection.version += 1;
}

async function cloneRecords(
    records,
    id = null,
    progressPhase = "copy"
) {
    const output =
        new Array(
            records.length
        );

    for (
        let index = 0;
        index < records.length;
        index += 1
    ) {
        assertActive(id);

        output[index] =
            records[index];

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
                        progressPhase,
                    completed:
                        index,
                    total:
                        records.length
                }
            );

            await Promise.resolve();
        }
    }

    return output;
}

async function setCollection(
    payload = {},
    id = null
) {
    const name =
        normalizeName(
            payload.name
        );

    const records =
        Array.isArray(
            payload.records
        )
            ? payload.records
            : [];

    ensureCapacity(
        records,
        name
    );

    if (
        !collections.has(name) &&
        collections.size >=
            MAX_COLLECTIONS
    ) {
        throw new RangeError(
            `Maximum collection count of ${MAX_COLLECTIONS} reached.`
        );
    }

    const copied =
        payload.copy === false
            ? records
            : await cloneRecords(
                records,
                id,
                "set"
            );

    const existing =
        collections.get(name);

    const collection =
        existing ||
        createCollection(
            name,
            []
        );

    collection.records =
        copied;

    collection.metadata = {
        ...collection.metadata,
        ...(
            payload.metadata &&
            typeof payload.metadata ===
            "object"
                ? payload.metadata
                : {}
        )
    };

    touch(collection);

    collections.set(
        name,
        collection
    );

    return describeCollection(
        collection
    );
}

async function getCollection(
    payload = {},
    id = null
) {
    const collection =
        requireCollection(
            payload.name
        );

    const filtered =
        await filterRecords(
            collection.records,
            payload,
            id
        );

    const sorted =
        sortRecords(
            filtered,
            payload.sort,
            payload.order
        );

    const offset =
        integer(
            payload.offset,
            0,
            0,
            Number.MAX_SAFE_INTEGER
        );

    const limit =
        integer(
            payload.limit,
            DEFAULT_LIMIT,
            1,
            MAX_LIMIT
        );

    const selected =
        payload.all === true
            ? sorted
            : sorted.slice(
                offset,
                offset + limit
            );

    return {
        name:
            collection.name,
        version:
            collection.version,
        total:
            filtered.length,
        offset:
            payload.all === true
                ? 0
                : offset,
        limit:
            payload.all === true
                ? filtered.length
                : limit,
        records:
            selected.map(
                record =>
                    projectRecord(
                        record,
                        payload.select
                    )
            ),
        metadata: {
            ...collection.metadata
        },
        createdAt:
            collection.createdAt,
        updatedAt:
            collection.updatedAt
    };
}

async function appendCollection(
    payload = {},
    id = null
) {
    const name =
        normalizeName(
            payload.name
        );

    const records =
        Array.isArray(
            payload.records
        )
            ? payload.records
            : [];

    let collection =
        collections.get(name);

    if (!collection) {
        collection =
            createCollection(
                name,
                []
            );

        collections.set(
            name,
            collection
        );
    }

    ensureCapacity(
        [
            ...collection.records,
            ...records
        ],
        name
    );

    const incoming =
        payload.copy === false
            ? records
            : await cloneRecords(
                records,
                id,
                "append"
            );

    collection.records.push(
        ...incoming
    );

    touch(collection);

    return describeCollection(
        collection
    );
}

async function mergeCollection(
    payload = {},
    id = null
) {
    const name =
        normalizeName(
            payload.name
        );

    const records =
        Array.isArray(
            payload.records
        )
            ? payload.records
            : [];

    const key =
        normalizeText(
            payload.key || "id"
        );

    let collection =
        collections.get(name);

    if (!collection) {
        collection =
            createCollection(
                name,
                []
            );

        collections.set(
            name,
            collection
        );
    }

    const map =
        new Map();

    for (
        let index = 0;
        index <
            collection.records.length;
        index += 1
    ) {
        const record =
            collection.records[index];

        map.set(
            canonicalKey(
                recordValue(
                    record,
                    key
                )
            ),
            record
        );
    }

    for (
        let index = 0;
        index < records.length;
        index += 1
    ) {
        assertActive(id);

        const record =
            records[index];

        const recordKey =
            canonicalKey(
                recordValue(
                    record,
                    key
                )
            );

        if (
            recordKey === null
        ) {
            continue;
        }

        if (
            payload.replace === false &&
            map.has(recordKey)
        ) {
            continue;
        }

        map.set(
            recordKey,
            record
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
                        "merge",
                    completed:
                        index,
                    total:
                        records.length
                }
            );

            await Promise.resolve();
        }
    }

    collection.records =
        [...map.values()];

    ensureCapacity(
        collection.records,
        name
    );

    touch(collection);

    return describeCollection(
        collection
    );
}

function listCollections(
    payload = {}
) {
    const query =
        normalizeText(
            payload.query
        ).toLowerCase();

    return [
        ...collections.values()
    ]
        .filter(collection =>
            !query ||
            collection.name
                .toLowerCase()
                .includes(query)
        )
        .map(
            describeCollection
        )
        .sort(
            (left, right) =>
                left.name.localeCompare(
                    right.name
                )
        );
}

function describeCollection(
    collection
) {
    return {
        name:
            collection.name,
        records:
            collection.records.length,
        version:
            collection.version,
        metadata: {
            ...collection.metadata
        },
        createdAt:
            collection.createdAt,
        updatedAt:
            collection.updatedAt
    };
}

function deleteCollection(
    payload = {}
) {
    const name =
        normalizeName(
            payload.name
        );

    return collections.delete(
        name
    );
}

function renameCollection(
    payload = {}
) {
    const from =
        normalizeName(
            payload.name ??
            payload.from
        );

    const to =
        normalizeName(
            payload.newName ??
            payload.to
        );

    if (
        from === to
    ) {
        return describeCollection(
            requireCollection(from)
        );
    }

    if (
        collections.has(to) &&
        payload.overwrite !== true
    ) {
        throw new Error(
            `Library collection already exists: ${to}`
        );
    }

    const collection =
        requireCollection(from);

    collections.delete(from);

    collection.name = to;
    touch(collection);

    collections.set(
        to,
        collection
    );

    return describeCollection(
        collection
    );
}

async function cloneCollection(
    payload = {},
    id = null
) {
    const source =
        requireCollection(
            payload.name ??
            payload.from
        );

    const targetName =
        normalizeName(
            payload.newName ??
            payload.to
        );

    if (
        collections.has(targetName) &&
        payload.overwrite !== true
    ) {
        throw new Error(
            `Library collection already exists: ${targetName}`
        );
    }

    const records =
        await cloneRecords(
            source.records,
            id,
            "clone"
        );

    const collection =
        createCollection(
            targetName,
            records,
            {
                ...source.metadata,
                clonedFrom:
                    source.name
            }
        );

    collections.set(
        targetName,
        collection
    );

    return describeCollection(
        collection
    );
}

function clearCollections(
    payload = {}
) {
    if (
        Array.isArray(
            payload.names
        )
    ) {
        let deleted = 0;

        for (
            const name of
            payload.names
        ) {
            if (
                collections.delete(
                    normalizeName(name)
                )
            ) {
                deleted += 1;
            }
        }

        return {
            deleted,
            remaining:
                collections.size
        };
    }

    const count =
        collections.size;

    collections.clear();

    return {
        deleted:
            count,
        remaining: 0
    };
}

function countCollection(
    payload = {}
) {
    return requireCollection(
        payload.name
    ).records.length;
}

function collectionStats(
    payload = {}
) {
    if (payload.name) {
        const collection =
            requireCollection(
                payload.name
            );

        return calculateStats(
            collection
        );
    }

    const values =
        [...collections.values()];

    return {
        collections:
            values.length,
        records:
            values.reduce(
                (sum, collection) =>
                    sum +
                    collection.records.length,
                0
            ),
        largest:
            values.length
                ? values
                    .map(
                        describeCollection
                    )
                    .sort(
                        (left, right) =>
                            right.records -
                            left.records
                    )[0]
                : null,
        updatedAt:
            values.length
                ? values
                    .map(
                        collection =>
                            collection.updatedAt
                    )
                    .sort()
                    .at(-1)
                : null
    };
}

function calculateStats(
    collection
) {
    const fields =
        new Set();

    let nullValues = 0;
    let scalarValues = 0;
    let objectValues = 0;
    let arrayValues = 0;

    for (
        const record of
        collection.records
    ) {
        if (
            record &&
            typeof record ===
            "object" &&
            !Array.isArray(record)
        ) {
            for (
                const [
                    key,
                    value
                ] of Object.entries(
                    record
                )
            ) {
                fields.add(key);

                if (
                    value === null ||
                    value === undefined
                ) {
                    nullValues += 1;
                } else if (
                    Array.isArray(value)
                ) {
                    arrayValues += 1;
                } else if (
                    typeof value ===
                    "object"
                ) {
                    objectValues += 1;
                } else {
                    scalarValues += 1;
                }
            }
        }
    }

    return {
        ...describeCollection(
            collection
        ),
        fields:
            [...fields].sort(),
        fieldCount:
            fields.size,
        values: {
            null:
                nullValues,
            scalar:
                scalarValues,
            object:
                objectValues,
            array:
                arrayValues
        }
    };
}

async function deduplicateCollection(
    payload = {},
    id = null
) {
    const collection =
        requireCollection(
            payload.name
        );

    const key =
        normalizeText(
            payload.key || "id"
        );

    const seen =
        new Set();

    const records = [];
    let removed = 0;

    for (
        let index = 0;
        index <
            collection.records.length;
        index += 1
    ) {
        assertActive(id);

        const record =
            collection.records[index];

        const value =
            canonicalKey(
                recordValue(
                    record,
                    key
                )
            );

        if (
            value !== null &&
            seen.has(value)
        ) {
            removed += 1;
            continue;
        }

        if (value !== null) {
            seen.add(value);
        }

        records.push(record);

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
                        "dedupe",
                    completed:
                        index,
                    total:
                        collection.records
                            .length
                }
            );

            await Promise.resolve();
        }
    }

    collection.records =
        records;

    touch(collection);

    return {
        ...describeCollection(
            collection
        ),
        removed,
        key
    };
}

function exportCollection(
    payload = {}
) {
    const collection =
        requireCollection(
            payload.name
        );

    return {
        format:
            "speciedex-library",
        version:
            WORKER_VERSION,
        exportedAt:
            new Date().toISOString(),
        collection: {
            name:
                collection.name,
            metadata: {
                ...collection.metadata
            },
            createdAt:
                collection.createdAt,
            updatedAt:
                collection.updatedAt,
            version:
                collection.version,
            records:
                collection.records
        }
    };
}

async function importCollection(
    payload = {},
    id = null
) {
    const source =
        payload.data ??
        payload.collection ??
        payload;

    const collectionData =
        source.collection &&
        typeof source.collection ===
        "object"
            ? source.collection
            : source;

    const name =
        normalizeName(
            payload.name ??
            collectionData.name
        );

    const records =
        Array.isArray(
            collectionData.records
        )
            ? collectionData.records
            : [];

    return setCollection(
        {
            name,
            records,
            metadata:
                collectionData.metadata,
            copy:
                payload.copy
        },
        id
    );
}

async function filterRecords(
    records,
    payload,
    id
) {
    const query =
        normalizeText(
            payload.query
        ).toLowerCase();

    const filter =
        payload.filter &&
        typeof payload.filter ===
        "object"
            ? payload.filter
            : null;

    if (
        !query &&
        !filter
    ) {
        return [...records];
    }

    const output = [];

    for (
        let index = 0;
        index < records.length;
        index += 1
    ) {
        assertActive(id);

        const record =
            records[index];

        if (
            query &&
            !recordContains(
                record,
                query
            )
        ) {
            continue;
        }

        if (
            filter &&
            !matchesFilter(
                record,
                filter
            )
        ) {
            continue;
        }

        output.push(record);

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
                        "filter",
                    completed:
                        index,
                    total:
                        records.length
                }
            );

            await Promise.resolve();
        }
    }

    return output;
}

function recordContains(
    record,
    query
) {
    if (
        record === null ||
        record === undefined
    ) {
        return false;
    }

    if (
        typeof record !== "object"
    ) {
        return String(record)
            .toLowerCase()
            .includes(query);
    }

    try {
        return JSON.stringify(record)
            .toLowerCase()
            .includes(query);
    } catch (_error) {
        return String(record)
            .toLowerCase()
            .includes(query);
    }
}

function matchesFilter(
    record,
    filter
) {
    for (
        const [
            field,
            expected
        ] of Object.entries(filter)
    ) {
        const actual =
            recordValue(
                record,
                field
            );

        if (
            Array.isArray(expected)
        ) {
            if (
                !expected.some(
                    value =>
                        compareValues(
                            actual,
                            value
                        )
                )
            ) {
                return false;
            }

            continue;
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
                "$contains" in expected &&
                !String(
                    actual ?? ""
                )
                    .toLowerCase()
                    .includes(
                        String(
                            expected.$contains
                        ).toLowerCase()
                    )
            ) {
                return false;
            }

            continue;
        }

        if (
            !compareValues(
                actual,
                expected
            )
        ) {
            return false;
        }
    }

    return true;
}

function compareValues(
    left,
    right
) {
    if (
        left === right
    ) {
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
        String(left)
            .toLowerCase() ===
        String(right)
            .toLowerCase()
    );
}

function sortRecords(
    records,
    field,
    order = "asc"
) {
    const normalizedField =
        normalizeText(field);

    if (!normalizedField) {
        return [...records];
    }

    const direction =
        String(order)
            .toLowerCase() ===
        "desc"
            ? -1
            : 1;

    return [...records].sort(
        (left, right) => {
            const a =
                recordValue(
                    left,
                    normalizedField
                );

            const b =
                recordValue(
                    right,
                    normalizedField
                );

            if (a === b) {
                return 0;
            }

            if (
                a === null ||
                a === undefined
            ) {
                return 1;
            }

            if (
                b === null ||
                b === undefined
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

            return String(a)
                .localeCompare(
                    String(b),
                    undefined,
                    {
                        numeric: true,
                        sensitivity:
                            "base"
                    }
                ) * direction;
        }
    );
}

function projectRecord(
    record,
    fields
) {
    if (
        !Array.isArray(fields) ||
        !fields.length
    ) {
        return record;
    }

    const output = {};

    for (
        const field of
        fields
    ) {
        output[field] =
            recordValue(
                record,
                field
            );
    }

    return output;
}

function recordValue(
    record,
    path
) {
    if (
        !record ||
        typeof record !== "object"
    ) {
        return undefined;
    }

    const parts =
        normalizeText(path)
            .split(".")
            .filter(Boolean);

    let value =
        record;

    for (const part of parts) {
        if (
            value === null ||
            value === undefined
        ) {
            return undefined;
        }

        value =
            value[part];
    }

    return value;
}

function canonicalKey(value) {
    if (
        value === null ||
        value === undefined
    ) {
        return null;
    }

    if (
        typeof value === "object"
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

function status() {
    const stats =
        collectionStats({});

    return {
        ready: true,
        workerVersion:
            WORKER_VERSION,
        ...stats,
        maximumCollections:
            MAX_COLLECTIONS,
        maximumRecordsPerCollection:
            MAX_RECORDS_PER_COLLECTION,
        activeRequests:
            activeRequests.size
    };
}
