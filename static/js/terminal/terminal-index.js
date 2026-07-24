/*
========================================================================
Speciedex.org
Terminal Search Index
========================================================================

Reusable in-memory search index for SpeciedexTerminal.

Provides:

    • document storage
    • field discovery
    • normalized token indexing
    • exact-value indexing
    • prefix indexing
    • identifier indexing
    • weighted field scoring
    • document insertion, replacement, and removal
    • search result scoring and ranking
    • index statistics
    • index serialization
    • command-based inspection and rebuilding

This service is intentionally independent from the higher-level query parser in
terminal-search.js. The search module may use this index for accelerated lookup,
while retaining its own query language, API routing, and result formatting.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME =
        "Index";

    const VERSION =
        "2.1.0";

    const INDEX_SYMBOL =
        Symbol.for(
            "speciedex.terminal.index.service"
        );

    const DEFAULT_LIMIT =
        50;

    const MAX_LIMIT =
        1000;

    const DEFAULT_MAX_DOCUMENTS =
        500000;

    const DEFAULT_MAX_FIELDS =
        512;

    const DEFAULT_MAX_PREFIX_LENGTH =
        24;

    const DEFAULT_BUILD_BATCH =
        1000;

    const DEFAULT_SYNC_DEBOUNCE =
        100;

    const DEFAULT_COLLECTIONS =
        Object.freeze([
            "records",
            "canonical-records",
            "canonical",
            "species",
            "taxa"
        ]);

    const DEFAULT_IDENTIFIER_FIELDS =
        Object.freeze([
            "id",
            "key",
            "speciedex_id",
            "speciedexId",
            "provider_id",
            "providerId",
            "taxid",
            "gbif_id",
            "gbifId",
            "ncbi_id",
            "ncbiId",
            "itis_id",
            "itisId",
            "worms_id",
            "wormsId",
            "col_id",
            "colId",
            "iucn_id",
            "iucnId",
            "wikidata_id",
            "wikidataId",
            "uuid",
            "cid",
            "sha256",
            "sha512",
            "md5",
            "checksum",
            "hash"
        ]);

    const DEFAULT_FIELD_WEIGHTS =
        Object.freeze({
            speciedex_id:
                120,

            speciedexId:
                120,

            id:
                110,

            key:
                105,

            scientific_name:
                100,

            scientificName:
                100,

            canonical_name:
                95,

            canonicalName:
                95,

            accepted_name:
                95,

            acceptedName:
                95,

            common_name:
                85,

            commonName:
                85,

            vernacular_name:
                80,

            vernacularName:
                80,

            synonyms:
                75,

            genus:
                70,

            species:
                70,

            family:
                60,

            order:
                55,

            class:
                50,

            phylum:
                50,

            kingdom:
                50,

            domain:
                50,

            provider_id:
                65,

            providerId:
                65,

            provider:
                55,

            country:
                45,

            state:
                40,

            locality:
                40,

            location:
                40,

            habitat:
                35,

            biome:
                35,

            ecosystem:
                35,

            authority:
                30,

            tags:
                25,

            keywords:
                25,

            description:
                15
        });

    /*
    ==========================================================================
    Utilities
    ==========================================================================
    */

    function normalizeText(value) {
        return String(
            value ?? ""
        )
            .normalize("NFKC")
            .trim()
            .toLowerCase();
    }

    function normalizeToken(value) {
        return normalizeText(value)
            .replace(/[^\p{L}\p{N}_:.-]+/gu, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    function tokenizeValue(value) {
        const normalized =
            normalizeToken(
                value
            );

        if (!normalized) {
            return [];
        }

        const tokens =
            normalized
                .split(/\s+/)
                .filter(Boolean);

        const compact =
            normalized.replace(
                /\s+/g,
                ""
            );

        if (
            compact &&
            compact !== normalized
        ) {
            tokens.push(
                compact
            );
        }

        return [
            ...new Set(tokens)
        ];
    }

    function flatten(
        value,
        seen =
            new WeakSet(),
        depth =
            0
    ) {
        if (
            value ===
                null ||
            value ===
                undefined
        ) {
            return [];
        }

        if (
            depth >
            16
        ) {
            return [];
        }

        if (
            Array.isArray(
                value
            )
        ) {
            return value.flatMap(
                item =>
                    flatten(
                        item,
                        seen,
                        depth +
                            1
                    )
            );
        }

        if (
            value &&
            typeof value ===
                "object"
        ) {
            if (
                seen.has(
                    value
                )
            ) {
                return [];
            }

            seen.add(
                value
            );

            return Object.values(
                value
            ).flatMap(
                item =>
                    flatten(
                        item,
                        seen,
                        depth +
                            1
                    )
            );
        }

        return [
            value
        ];
    }

    function clampInteger(
        value,
        fallback,
        minimum,
        maximum
    ) {
        const parsed =
            Number.parseInt(
                value,
                10
            );

        if (!Number.isFinite(parsed)) {
            return fallback;
        }

        return Math.min(
            maximum,
            Math.max(
                minimum,
                parsed
            )
        );
    }

    function uniqueStrings(values) {
        return [
            ...new Set(
                values
                    .map(
                        value =>
                            String(
                                value
                            ).trim()
                    )
                    .filter(Boolean)
            )
        ];
    }

    function resolveDocumentID(
        record,
        index
    ) {
        const candidates = [
            record?.speciedex_id,
            record?.speciedexId,
            record?.id,
            record?.key,
            record?.uuid,
            record?.provider_id,
            record?.providerId
        ];

        for (const candidate of candidates) {
            const normalized =
                normalizeText(
                    candidate
                );

            if (normalized) {
                return normalized;
            }
        }

        return `document:${index}`;
    }

    function cloneRecord(
        record,
        seen =
            new WeakMap()
    ) {
        if (
            record ===
                null ||
            record ===
                undefined
        ) {
            return {};
        }

        if (
            typeof record !==
                "object"
        ) {
            return {
                value:
                    record
            };
        }

        if (
            typeof structuredClone ===
                "function"
        ) {
            try {
                return structuredClone(
                    record
                );
            } catch (_error) {
                /* Continue with deterministic fallback. */
            }
        }

        if (
            seen.has(
                record
            )
        ) {
            return seen.get(
                record
            );
        }

        if (
            Array.isArray(
                record
            )
        ) {
            const output =
                [];

            seen.set(
                record,
                output
            );

            for (
                const item of
                record
            ) {
                output.push(
                    typeof item ===
                        "object" &&
                    item !==
                        null
                        ? cloneRecord(
                            item,
                            seen
                        )
                        : item
                );
            }

            return output;
        }

        const output =
            {};

        seen.set(
            record,
            output
        );

        for (
            const [
                key,
                value
            ] of Object.entries(
                record
            )
        ) {
            if (
                [
                    "__proto__",
                    "prototype",
                    "constructor"
                ].includes(
                    key
                )
            ) {
                continue;
            }

            output[
                key
            ] =
                typeof value ===
                    "object" &&
                value !==
                    null
                    ? cloneRecord(
                        value,
                        seen
                    )
                    : value;
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

    function yieldToMainThread() {
        return new Promise(
            resolve => {
                if (
                    typeof window.requestIdleCallback ===
                        "function"
                ) {
                    window.requestIdleCallback(
                        () =>
                            resolve(),
                        {
                            timeout:
                                50
                        }
                    );

                    return;
                }

                window.setTimeout(
                    resolve,
                    0
                );
            }
        );
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
                "results",
                "items",
                "data",
                "species",
                "taxa",
                "documents"
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

    /*
    ==========================================================================
    Search Index
    ==========================================================================
    */

    class SearchIndex
        extends EventTarget {
        constructor(
            options = {}
        ) {
            super();

            this.options = {
                identifierFields:
                    uniqueStrings(
                        options.identifierFields ||
                        DEFAULT_IDENTIFIER_FIELDS
                    ),

                fieldWeights: {
                    ...DEFAULT_FIELD_WEIGHTS,
                    ...(options.fieldWeights || {})
                },

                includePrivateFields:
                    options.includePrivateFields ===
                    true,

                maximumDocuments:
                    clampInteger(
                        options.maximumDocuments,
                        DEFAULT_MAX_DOCUMENTS,
                        1,
                        5000000
                    ),

                maximumFields:
                    clampInteger(
                        options.maximumFields,
                        DEFAULT_MAX_FIELDS,
                        1,
                        10000
                    ),

                maximumPrefixLength:
                    clampInteger(
                        options.maximumPrefixLength,
                        DEFAULT_MAX_PREFIX_LENGTH,
                        1,
                        128
                    ),

                buildBatchSize:
                    clampInteger(
                        options.buildBatchSize,
                        DEFAULT_BUILD_BATCH,
                        1,
                        100000
                    ),

                syncDebounce:
                    clampInteger(
                        options.syncDebounce,
                        DEFAULT_SYNC_DEBOUNCE,
                        0,
                        10000
                    ),

                collections:
                    uniqueStrings(
                        options.collections ||
                        DEFAULT_COLLECTIONS
                    )
            };

            this.documents =
                [];

            this.documentMap =
                new Map();

            this.documentPositions =
                new Map();

            this.fields =
                [];

            this.inverted =
                new Map();

            this.exact =
                new Map();

            this.prefix =
                new Map();

            this.identifiers =
                new Map();

            this.documentTokens =
                new Map();

            this.built =
                false;

            this.builtAt =
                null;

            this.revision =
                0;

            this.destroyed =
                false;

            this.buildGeneration =
                0;

            this.building =
                false;

            this.pendingBuild =
                null;

            this.syncTimer =
                null;

            this.listenerDisposers =
                [];

            this.emitting =
                false;

            this.metrics = {
                builds:
                    0,
                incrementalBuilds:
                    0,
                cancelledBuilds:
                    0,
                failedBuilds:
                    0,
                added:
                    0,
                replaced:
                    0,
                removed:
                    0,
                searches:
                    0,
                librarySyncs:
                    0,
                ignoredLibraryEvents:
                    0
            };
        }

        assertActive() {
            if (
                this.destroyed
            ) {
                throw new Error(
                    "SearchIndex has been destroyed."
                );
            }
        }

        emit(
            type,
            detail =
                {}
        ) {
            if (
                this.destroyed &&
                type !==
                    "destroy"
            ) {
                return false;
            }

            if (
                this.emitting
            ) {
                return false;
            }

            this.emitting =
                true;

            try {
                this.dispatchEvent(
                    new CustomEvent(
                        type,
                        {
                            detail
                        }
                    )
                );

                return true;
            } finally {
                this.emitting =
                    false;
            }
        }

        /*
        ======================================================================
        Index Construction
        ======================================================================
        */

        discoverFields(
            records
        ) {
            const fields =
                new Set();

            for (const record of records) {
                if (
                    !record ||
                    typeof record !==
                    "object"
                ) {
                    continue;
                }

                for (
                    const field of
                    Object.keys(record)
                ) {
                    if (
                        !this.options.includePrivateFields &&
                        field.startsWith("_")
                    ) {
                        continue;
                    }

                    fields.add(
                        field
                    );

                    if (
                        fields.size >=
                        this.options.maximumFields
                    ) {
                        break;
                    }
                }
            }

            return [
                ...fields
            ].sort();
        }

        reset() {
            this.documents =
                [];

            this.documentMap.clear();
            this.documentPositions.clear();
            this.inverted.clear();
            this.exact.clear();
            this.prefix.clear();
            this.identifiers.clear();
            this.documentTokens.clear();

            this.fields =
                [];

            this.built =
                false;

            this.builtAt =
                null;

            this.revision +=
                1;

            this.emit(
                "reset",
                {
                    revision:
                        this.revision
                }
            );
        }

        async build(
            records,
            fields = [],
            options = {}
        ) {
            this.assertActive();

            const generation =
                ++this.buildGeneration;

            const source =
                arrayFromPayload(
                    records
                ).slice(
                    0,
                    this.options.maximumDocuments
                );

            const signal =
                options.signal ||
                null;

            this.building =
                true;

            this.pendingBuild = {
                generation,
                source:
                    options.source ||
                    "manual",
                collection:
                    options.collection ||
                    null,
                startedAt:
                    Date.now()
            };

            try {
                this.reset();

                this.fields =
                    fields.length
                        ? uniqueStrings(
                            fields
                        ).slice(
                            0,
                            this.options.maximumFields
                        )
                        : this.discoverFields(
                            source
                        );

                const batchSize =
                    this.options.buildBatchSize;

                for (
                    let offset =
                        0;
                    offset <
                        source.length;
                    offset +=
                        batchSize
                ) {
                    if (
                        signal?.aborted ||
                        generation !==
                            this.buildGeneration
                    ) {
                        throw new DOMException(
                            "Index build cancelled.",
                            "AbortError"
                        );
                    }

                    const end =
                        Math.min(
                            source.length,
                            offset +
                                batchSize
                        );

                    for (
                        let index =
                            offset;
                        index <
                            end;
                        index +=
                            1
                    ) {
                        this.add(
                            source[
                                index
                            ],
                            {
                                rebuild:
                                    false,
                                position:
                                    index,
                                silent:
                                    true
                            }
                        );
                    }

                    await yieldToMainThread();
                }

                if (
                    generation !==
                    this.buildGeneration
                ) {
                    throw new DOMException(
                        "Index build superseded.",
                        "AbortError"
                    );
                }

                this.built =
                    true;

                this.builtAt =
                    new Date().toISOString();

                this.revision +=
                    1;

                this.metrics.builds +=
                    1;

                const report =
                    this.stats();

                this.emit(
                    "build",
                    {
                        ...report,
                        source:
                            options.source ||
                            "manual",
                        collection:
                            options.collection ||
                            null
                    }
                );

                return report;
            } catch (error) {
                if (
                    isAbortError(
                        error
                    )
                ) {
                    this.metrics.cancelledBuilds +=
                        1;
                } else {
                    this.metrics.failedBuilds +=
                        1;
                }

                throw error;
            } finally {
                if (
                    this.pendingBuild?.
                        generation ===
                    generation
                ) {
                    this.pendingBuild =
                        null;

                    this.building =
                        false;
                }
            }
        }

        rebuild(
            records,
            options =
                {}
        ) {
            return this.build(
                records,
                options.fields ||
                [],
                options
            );
        }

        cancelBuild(
            reason =
                "cancelled"
        ) {
            if (
                !this.building
            ) {
                return false;
            }

            this.buildGeneration +=
                1;

            this.pendingBuild = {
                ...(
                    this.pendingBuild ||
                    {}
                ),
                cancelledAt:
                    Date.now(),
                reason
            };

            return true;
        }

        /*
        ======================================================================
        Document Mutation
        ======================================================================
        */

        add(
            record,
            options = {}
        ) {
            this.assertActive();

            const cloned =
                cloneRecord(
                    record
                );

            const position =
                Number.isInteger(
                    options.position
                )
                    ? options.position
                    : this.documents.length;

            const requestedID =
                resolveDocumentID(
                    cloned,
                    position
                );

            let documentID =
                requestedID;

            if (
                this.documentMap.has(
                    documentID
                )
            ) {
                const existing =
                    this.documentMap.get(
                        documentID
                    );

                if (
                    options.replace !==
                        false
                ) {
                    return this.replace(
                        documentID,
                        cloned,
                        {
                            silent:
                                options.silent
                        }
                    );
                }

                let duplicate =
                    2;

                while (
                    this.documentMap.has(
                        `${requestedID}:${duplicate}`
                    )
                ) {
                    duplicate +=
                        1;
                }

                documentID =
                    `${requestedID}:${duplicate}`;
            }

            this.documents.push(
                cloned
            );

            this.documentMap.set(
                documentID,
                cloned
            );

            this.documentPositions.set(
                documentID,
                this.documents.length -
                1
            );

            this.indexDocument(
                documentID,
                cloned
            );

            if (
                options.rebuild !==
                false
            ) {
                this.built =
                    true;

                this.builtAt =
                    new Date().toISOString();

                this.revision +=
                    1;
            }

            this.metrics.added +=
                1;

            if (
                options.silent !==
                    true
            ) {
                this.emit(
                    "add",
                    {
                        id:
                            documentID,
                        record:
                            cloned
                    }
                );
            }

            return documentID;
        }

        replace(
            documentID,
            record,
            options = {}
        ) {
            this.assertActive();
            const normalizedID =
                normalizeText(
                    documentID
                );

            if (
                !this.documentMap.has(
                    normalizedID
                )
            ) {
                return this.add(
                    record
                );
            }

            const position =
                this.documentPositions.get(
                    normalizedID
                );

            this.removeDocumentTokens(
                normalizedID
            );

            const cloned =
                cloneRecord(
                    record
                );

            this.documents[
                position
            ] = cloned;

            this.documentMap.set(
                normalizedID,
                cloned
            );

            this.indexDocument(
                normalizedID,
                cloned
            );

            this.builtAt =
                new Date().toISOString();

            this.revision +=
                1;

            this.metrics.replaced +=
                1;

            if (
                options.silent !==
                    true
            ) {
                this.emit(
                    "replace",
                    {
                        id:
                            normalizedID,
                        record:
                            cloned
                    }
                );
            }

            return normalizedID;
        }

        remove(
            documentID,
            options = {}
        ) {
            this.assertActive();

            const normalizedID =
                normalizeText(
                    documentID
                );

            if (
                !this.documentMap.has(
                    normalizedID
                )
            ) {
                return false;
            }

            const position =
                this.documentPositions.get(
                    normalizedID
                );

            this.removeDocumentTokens(
                normalizedID
            );

            this.documentMap.delete(
                normalizedID
            );

            this.documentPositions.delete(
                normalizedID
            );

            this.documents.splice(
                position,
                1
            );

            for (
                let index =
                    position;
                index <
                    this.documents.length;
                index +=
                    1
            ) {
                const record =
                    this.documents[
                        index
                    ];

                for (
                    const [
                        id,
                        mapped
                    ] of this.documentMap
                ) {
                    if (
                        mapped ===
                        record
                    ) {
                        this.documentPositions.set(
                            id,
                            index
                        );

                        break;
                    }
                }
            }

            this.builtAt =
                new Date().toISOString();

            this.revision +=
                1;

            this.metrics.removed +=
                1;

            if (
                options.silent !==
                    true
            ) {
                this.emit(
                    "remove",
                    {
                        id:
                            normalizedID
                    }
                );
            }

            return true;
        }

        /*
        ======================================================================
        Internal Indexing
        ======================================================================
        */

        ensureFieldMap(
            root,
            field
        ) {
            if (!root.has(field)) {
                root.set(
                    field,
                    new Map()
                );
            }

            return root.get(
                field
            );
        }

        ensurePosting(
            map,
            key
        ) {
            if (!map.has(key)) {
                map.set(
                    key,
                    new Set()
                );
            }

            return map.get(
                key
            );
        }

        indexDocument(
            documentID,
            record
        ) {
            const documentTokenRecords =
                [];

            for (const field of this.fields) {
                const values =
                    flatten(
                        record?.[
                            field
                        ]
                    );

                for (const value of values) {
                    const normalized =
                        normalizeText(
                            value
                        );

                    if (!normalized) {
                        continue;
                    }

                    const exactField =
                        this.ensureFieldMap(
                            this.exact,
                            field
                        );

                    this.ensurePosting(
                        exactField,
                        normalized
                    ).add(
                        documentID
                    );

                    documentTokenRecords.push({
                        type:
                            "exact",

                        field,

                        key:
                            normalized
                    });

                    const tokens =
                        tokenizeValue(
                            value
                        );

                    const invertedField =
                        this.ensureFieldMap(
                            this.inverted,
                            field
                        );

                    const prefixField =
                        this.ensureFieldMap(
                            this.prefix,
                            field
                        );

                    for (const token of tokens) {
                        this.ensurePosting(
                            invertedField,
                            token
                        ).add(
                            documentID
                        );

                        documentTokenRecords.push({
                            type:
                                "inverted",

                            field,

                            key:
                                token
                        });

                        const maximumPrefix =
                            Math.min(
                                token.length,
                                this.options.maximumPrefixLength
                            );

                        for (
                            let length = 1;
                            length <= maximumPrefix;
                            length += 1
                        ) {
                            const prefix =
                                token.slice(
                                    0,
                                    length
                                );

                            this.ensurePosting(
                                prefixField,
                                prefix
                            ).add(
                                documentID
                            );

                            documentTokenRecords.push({
                                type:
                                    "prefix",

                                field,

                                key:
                                    prefix
                            });
                        }
                    }

                    if (
                        this.options.identifierFields.includes(
                            field
                        )
                    ) {
                        this.ensurePosting(
                            this.identifiers,
                            normalized
                        ).add(
                            documentID
                        );

                        documentTokenRecords.push({
                            type:
                                "identifier",

                            field,

                            key:
                                normalized
                        });
                    }
                }
            }

            this.documentTokens.set(
                documentID,
                documentTokenRecords
            );
        }

        removeDocumentTokens(
            documentID
        ) {
            const records =
                this.documentTokens.get(
                    documentID
                ) ||
                [];

            for (const record of records) {
                let map;

                if (
                    record.type ===
                    "identifier"
                ) {
                    map =
                        this.identifiers;
                } else {
                    const root =
                        this[
                            record.type
                        ];

                    map =
                        root?.get(
                            record.field
                        );
                }

                const posting =
                    map?.get(
                        record.key
                    );

                if (!posting) {
                    continue;
                }

                posting.delete(
                    documentID
                );

                if (!posting.size) {
                    map.delete(
                        record.key
                    );
                }
            }

            this.documentTokens.delete(
                documentID
            );
        }

        /*
        ======================================================================
        Lookup
        ======================================================================
        */

        get(
            documentID
        ) {
            return (
                this.documentMap.get(
                    normalizeText(
                        documentID
                    )
                ) ||
                null
            );
        }

        has(
            documentID
        ) {
            return this.documentMap.has(
                normalizeText(
                    documentID
                )
            );
        }

        lookupIdentifier(
            identifier
        ) {
            const normalized =
                normalizeText(
                    identifier
                );

            const ids =
                this.identifiers.get(
                    normalized
                ) ||
                new Set();

            return [
                ...ids
            ]
                .map(
                    id =>
                        this.documentMap.get(
                            id
                        )
                )
                .filter(Boolean);
        }

        lookupExact(
            field,
            value
        ) {
            const normalizedField =
                String(
                    field ?? ""
                ).trim();

            const normalizedValue =
                normalizeText(
                    value
                );

            const ids =
                this.exact
                    .get(
                        normalizedField
                    )
                    ?.get(
                        normalizedValue
                    ) ||
                new Set();

            return [
                ...ids
            ]
                .map(
                    id =>
                        this.documentMap.get(
                            id
                        )
                )
                .filter(Boolean);
        }

        lookupPrefix(
            field,
            value
        ) {
            const normalizedField =
                String(
                    field ?? ""
                ).trim();

            const normalizedValue =
                normalizeText(
                    value
                );

            const ids =
                this.prefix
                    .get(
                        normalizedField
                    )
                    ?.get(
                        normalizedValue
                    ) ||
                new Set();

            return [
                ...ids
            ]
                .map(
                    id =>
                        this.documentMap.get(
                            id
                        )
                )
                .filter(Boolean);
        }

        /*
        ======================================================================
        Search
        ======================================================================
        */

        scoreDocument(
            documentID,
            terms,
            fields
        ) {
            let score =
                0;

            const matchedFields =
                new Set();

            for (const field of fields) {
                const weight =
                    this.options.fieldWeights[
                        field
                    ] ||
                    10;

                const exactField =
                    this.exact.get(
                        field
                    );

                const invertedField =
                    this.inverted.get(
                        field
                    );

                const prefixField =
                    this.prefix.get(
                        field
                    );

                for (const term of terms) {
                    if (
                        exactField
                            ?.get(
                                term
                            )
                            ?.has(
                                documentID
                            )
                    ) {
                        score +=
                            weight +
                            40;

                        matchedFields.add(
                            field
                        );

                        continue;
                    }

                    if (
                        invertedField
                            ?.get(
                                term
                            )
                            ?.has(
                                documentID
                            )
                    ) {
                        score +=
                            weight;

                        matchedFields.add(
                            field
                        );

                        continue;
                    }

                    if (
                        prefixField
                            ?.get(
                                term
                            )
                            ?.has(
                                documentID
                            )
                    ) {
                        score +=
                            Math.max(
                                1,
                                weight *
                                0.65
                            );

                        matchedFields.add(
                            field
                        );
                    }
                }
            }

            return {
                score,
                matchedFields:
                    [
                        ...matchedFields
                    ]
            };
        }

        search(
            query,
            options = {}
        ) {
            this.assertActive();

            const started =
                performance.now();

            const limit =
                clampInteger(
                    options.limit,
                    DEFAULT_LIMIT,
                    1,
                    MAX_LIMIT
                );

            const offset =
                clampInteger(
                    options.offset,
                    0,
                    0,
                    Number.MAX_SAFE_INTEGER
                );

            const fields =
                options.fields?.length
                    ? uniqueStrings(
                        options.fields
                    )
                    : this.fields;

            const terms =
                tokenizeValue(
                    query
                );

            if (!terms.length) {
                return {
                    query:
                        normalizeText(
                            query
                        ),

                    total:
                        this.documents.length,

                    records:
                        this.documents.slice(
                            offset,
                            offset +
                            limit
                        ),

                    elapsed_ms:
                        performance.now() -
                        started
                };
            }

            if (
                options.signal?.aborted
            ) {
                throw new DOMException(
                    "Index search cancelled.",
                    "AbortError"
                );
            }

            const candidateIDs =
                new Set();

            for (const field of fields) {
                const invertedField =
                    this.inverted.get(
                        field
                    );

                const prefixField =
                    this.prefix.get(
                        field
                    );

                const exactField =
                    this.exact.get(
                        field
                    );

                for (const term of terms) {
                    for (
                        const id of
                        exactField?.get(
                            term
                        ) ||
                        []
                    ) {
                        candidateIDs.add(
                            id
                        );
                    }

                    for (
                        const id of
                        invertedField?.get(
                            term
                        ) ||
                        []
                    ) {
                        candidateIDs.add(
                            id
                        );
                    }

                    if (
                        options.prefix !==
                        false
                    ) {
                        for (
                            const id of
                            prefixField?.get(
                                term
                            ) ||
                            []
                        ) {
                            candidateIDs.add(
                                id
                            );
                        }
                    }
                }
            }

            const ranked =
                [];

            for (
                const documentID of
                candidateIDs
            ) {
                const score =
                    this.scoreDocument(
                        documentID,
                        terms,
                        fields
                    );

                if (
                    score.score <=
                    0
                ) {
                    continue;
                }

                const record =
                    this.documentMap.get(
                        documentID
                    );

                if (!record) {
                    continue;
                }

                ranked.push({
                    id:
                        documentID,

                    record,

                    score:
                        score.score,

                    matchedFields:
                        score.matchedFields
                });
            }

            const filteredRanked =
                options.match ===
                    "all" &&
                terms.length >
                    1
                    ? ranked.filter(
                        item => {
                            const record =
                                item.record;

                            return terms.every(
                                term =>
                                    fields.some(
                                        field => {
                                            const values =
                                                flatten(
                                                    record?.[
                                                        field
                                                    ]
                                                );

                                            return values.some(
                                                value =>
                                                    normalizeToken(
                                                        value
                                                    ).includes(
                                                        term
                                                    )
                                            );
                                        }
                                    )
                            );
                        }
                    )
                    : ranked;

            filteredRanked.sort(
                (
                    left,
                    right
                ) =>
                    right.score -
                    left.score
            );

            this.metrics.searches +=
                1;

            const total =
                filteredRanked.length;

            const records =
                filteredRanked
                    .slice(
                        offset,
                        offset +
                        limit
                    )
                    .map(
                        item => ({
                            ...item.record,

                            _index_id:
                                item.id,

                            _index_score:
                                item.score,

                            _index_fields:
                                item.matchedFields
                        })
                    );

            return {
                query:
                    normalizeText(
                        query
                    ),

                total,

                offset,

                limit,

                records,

                elapsed_ms:
                    performance.now() -
                    started
            };
        }

        /*
        ======================================================================
        Statistics and Serialization
        ======================================================================
        */

        stats() {
            let tokenCount =
                0;

            let exactCount =
                0;

            let prefixCount =
                0;

            for (
                const fieldMap of
                this.inverted.values()
            ) {
                tokenCount +=
                    fieldMap.size;
            }

            for (
                const fieldMap of
                this.exact.values()
            ) {
                exactCount +=
                    fieldMap.size;
            }

            for (
                const fieldMap of
                this.prefix.values()
            ) {
                prefixCount +=
                    fieldMap.size;
            }

            return {
                version:
                    VERSION,

                built:
                    this.built,

                builtAt:
                    this.builtAt,

                revision:
                    this.revision,

                documents:
                    this.documents.length,

                fields:
                    this.fields.length,

                tokens:
                    tokenCount,

                exactValues:
                    exactCount,

                prefixes:
                    prefixCount,

                identifiers:
                    this.identifiers.size,

                building:
                    this.building,

                pendingBuild:
                    this.pendingBuild
                        ? {
                            ...this.pendingBuild
                        }
                        : null,

                limits: {
                    maximumDocuments:
                        this.options.maximumDocuments,
                    maximumFields:
                        this.options.maximumFields,
                    maximumPrefixLength:
                        this.options.maximumPrefixLength,
                    buildBatchSize:
                        this.options.buildBatchSize
                },

                metrics: {
                    ...this.metrics
                },

                destroyed:
                    this.destroyed
            };
        }

        export() {
            return {
                version:
                    VERSION,

                generatedAt:
                    new Date().toISOString(),

                fields:
                    [
                        ...this.fields
                    ],

                options: {
                    identifierFields:
                        [
                            ...this.options.identifierFields
                        ],

                    fieldWeights: {
                        ...this.options.fieldWeights
                    },

                    includePrivateFields:
                        this.options.includePrivateFields
                },

                documents:
                    this.documents.map(
                        cloneRecord
                    ),

                stats:
                    this.stats()
            };
        }

        import(
            payload
        ) {
            if (
                !payload ||
                typeof payload !==
                "object" ||
                !Array.isArray(
                    payload.documents
                )
            ) {
                throw new TypeError(
                    "Search index import requires an object with a documents array."
                );
            }

            if (
                payload.options &&
                typeof payload.options ===
                "object"
            ) {
                this.options = {
                    ...this.options,

                    ...payload.options,

                    fieldWeights: {
                        ...this.options.fieldWeights,
                        ...(payload.options.fieldWeights || {})
                    },

                    identifierFields:
                        uniqueStrings(
                            payload.options.identifierFields ||
                            this.options.identifierFields
                        )
                };
            }

            return this.build(
                payload.documents,
                payload.fields ||
                [],
                {
                    source:
                        "import"
                }
            );
        }

        destroy() {
            if (
                this.destroyed
            ) {
                return false;
            }

            this.cancelBuild(
                "destroyed"
            );

            window.clearTimeout(
                this.syncTimer
            );

            this.syncTimer =
                null;

            for (
                const dispose of
                this.listenerDisposers.splice(
                    0
                )
            ) {
                try {
                    dispose();
                } catch (_error) {
                    /* Continue teardown. */
                }
            }

            this.reset();

            this.emit(
                "destroy",
                {
                    version:
                        VERSION
                }
            );

            this.destroyed =
                true;

            return true;
        }
    }

    /*
    ==========================================================================
    Service Initialization
    ==========================================================================
    */

    function initialize(
        context
    ) {
        const root =
            context.root;

        const existing =
            context.index instanceof
                SearchIndex
                ? context.index
                : context.services?.get?.(
                    "index"
                ) ||
                root?.[
                    INDEX_SYMBOL
                ];

        if (
            existing instanceof
                SearchIndex &&
            !existing.destroyed
        ) {
            context.index =
                existing;

            context.registerService?.(
                "index",
                existing
            );

            return existing;
        }

        const dataset =
            root?.
                dataset ||
            {};

        const index =
            new SearchIndex({
                includePrivateFields:
                    dataset.terminalIndexPrivate ===
                    "true",

                maximumDocuments:
                    dataset.terminalIndexMaximumDocuments,

                maximumFields:
                    dataset.terminalIndexMaximumFields,

                maximumPrefixLength:
                    dataset.terminalIndexMaximumPrefixLength,

                buildBatchSize:
                    dataset.terminalIndexBuildBatch,

                syncDebounce:
                    dataset.terminalIndexSyncDebounce,

                collections:
                    dataset.terminalIndexCollections
                        ? String(
                            dataset.terminalIndexCollections
                        )
                            .split(
                                ","
                            )
                            .map(
                                value =>
                                    value.trim()
                            )
                            .filter(
                                Boolean
                            )
                        : DEFAULT_COLLECTIONS
            });

        root[
            INDEX_SYMBOL
        ] =
            index;

        context.index =
            index;

        context.registerService?.(
            "index",
            index
        );

        const library =
            context.library ||
            context.services?.get?.(
                "library"
            );

        function resolveRecords(
            preferred =
                null
        ) {
            const collections =
                preferred
                    ? [
                        preferred,
                        ...index.options.collections
                    ]
                    : index.options.collections;

            for (
                const collection of
                uniqueStrings(
                    collections
                )
            ) {
                try {
                    const value =
                        library?.get?.(
                            collection
                        );

                    const records =
                        arrayFromPayload(
                            value
                        );

                    if (
                        records.length
                    ) {
                        return {
                            collection,
                            records
                        };
                    }
                } catch (_error) {
                    /* Continue through aliases. */
                }
            }

            return {
                collection:
                    preferred ||
                    index.options.collections[
                        0
                    ] ||
                    "records",
                records:
                    []
            };
        }

        function scheduleBuild(
            preferredCollection =
                null,
            source =
                "library"
        ) {
            window.clearTimeout(
                index.syncTimer
            );

            index.syncTimer =
                window.setTimeout(
                    () => {
                        index.syncTimer =
                            null;

                        const resolved =
                            resolveRecords(
                                preferredCollection
                            );

                        if (
                            !resolved.records.length
                        ) {
                            index.metrics.ignoredLibraryEvents +=
                                1;

                            return;
                        }

                        index.metrics.librarySyncs +=
                            1;

                        index.build(
                            resolved.records,
                            [],
                            {
                                source,
                                collection:
                                    resolved.collection
                            }
                        ).catch(
                            error => {
                                if (
                                    !isAbortError(
                                        error
                                    )
                                ) {
                                    console.error(
                                        "[SpeciedexTerminalIndex] Library synchronization failed:",
                                        error
                                    );
                                }
                            }
                        );
                    },
                    index.options.syncDebounce
                );
        }

        const initial =
            resolveRecords();

        if (
            initial.records.length
        ) {
            scheduleBuild(
                initial.collection,
                "initial-library"
            );
        }

        const events =
            context.events;

        if (
            typeof events?.on ===
                "function"
        ) {
            const handler =
                detail => {
                    const collection =
                        detail?.collection ||
                        detail?.name ||
                        null;

                    if (
                        collection &&
                        !index.options.collections.includes(
                            collection
                        )
                    ) {
                        index.metrics.ignoredLibraryEvents +=
                            1;

                        return;
                    }

                    scheduleBuild(
                        collection,
                        "library-event"
                    );
                };

            const result =
                events.on(
                    "library:updated",
                    handler
                );

            if (
                typeof result ===
                    "function"
            ) {
                index.listenerDisposers.push(
                    result
                );
            }
        }

        const documentHandler =
            event => {
                const detail =
                    event?.detail ||
                    {};

                const collection =
                    detail.collection ||
                    detail.name ||
                    null;

                if (
                    collection &&
                    !index.options.collections.includes(
                        collection
                    )
                ) {
                    index.metrics.ignoredLibraryEvents +=
                        1;

                    return;
                }

                scheduleBuild(
                    collection,
                    "library-dom-event"
                );
            };

        document.addEventListener(
            "speciedex:terminal-library-updated",
            documentHandler
        );

        index.listenerDisposers.push(
            () =>
                document.removeEventListener(
                    "speciedex:terminal-library-updated",
                    documentHandler
                )
        );

        return index;
    }

    /*
    ==========================================================================
    Commands
    ==========================================================================
    */

    const commands =
        [
            {
                name:
                    "index",

                category:
                    "search",

                description:
                    "Display search-index status and statistics.",

                usage:
                    "index",

                handler: ({
                    context,
                    writeJSON
                }) =>
                    writeJSON(
                        context.index.stats()
                    )
            },

            {
                name:
                    "index-build",

                category:
                    "search",

                description:
                    "Build or rebuild the search index from a library collection.",

                usage:
                    "index-build [collection]",

                handler: async ({
                    args = [],
                    context,
                    writeJSON
                }) => {
                    const collection =
                        args[0] ||
                        "records";

                    const records =
                        context.library?.get?.(
                            collection
                        ) ||
                        [];

                    if (
                        !Array.isArray(records)
                    ) {
                        throw new Error(
                            `Library collection "${collection}" is not an array.`
                        );
                    }

                    return writeJSON(
                        await context.index.build(
                            records,
                            [],
                            {
                                source:
                                    "command",
                                collection
                            }
                        )
                    );
                }
            },

            {
                name:
                    "index-search",

                category:
                    "search",

                description:
                    "Search the local in-memory index directly.",

                usage:
                    "index-search <query> [--limit N] [--offset N]",

                handler: ({
                    args = [],
                    parsed = {
                        options:
                            {}
                    },
                    context,
                    writeJSON
                }) => {
                    const query =
                        args.join(
                            " "
                        );

                    if (!query) {
                        throw new Error(
                            "An index search query is required."
                        );
                    }

                    return writeJSON(
                        context.index.search(
                            query,
                            {
                                limit:
                                    parsed.options.limit,

                                offset:
                                    parsed.options.offset,

                                match:
                                    parsed.options.match ||
                                    "any",

                                fields:
                                    parsed.options.fields
                                        ? String(
                                            parsed.options.fields
                                        )
                                            .split(",")
                                            .map(
                                                field =>
                                                    field.trim()
                                            )
                                            .filter(Boolean)
                                        : []
                            }
                        )
                    );
                }
            },

            {
                name:
                    "index-get",

                category:
                    "search",

                description:
                    "Retrieve one indexed document by identifier.",

                usage:
                    "index-get <identifier>",

                handler: ({
                    args,
                    context,
                    writeJSON
                }) => {
                    const identifier =
                        args.join(
                            " "
                        );

                    if (!identifier) {
                        throw new Error(
                            "A document identifier is required."
                        );
                    }

                    const direct =
                        context.index.get(
                            identifier
                        );

                    const matches =
                        direct
                            ? [
                                direct
                            ]
                            : context.index.lookupIdentifier(
                                identifier
                            );

                    return writeJSON(
                        matches
                    );
                }
            },

            {
                name:
                    "index-fields",

                category:
                    "search",

                description:
                    "List fields currently indexed.",

                usage:
                    "index-fields",

                handler: ({
                    context,
                    writeJSON
                }) =>
                    writeJSON({
                        fields:
                            [
                                ...context.index.fields
                            ],

                        weights: {
                            ...context.index.options.fieldWeights
                        },

                        identifierFields:
                            [
                                ...context.index.options.identifierFields
                            ]
                    })
            },

            {
                name:
                    "index-cancel",

                category:
                    "search",

                description:
                    "Cancel the active index build.",

                usage:
                    "index-cancel",

                handler: ({
                    context,
                    writeJSON
                }) =>
                    writeJSON({
                        cancelled:
                            context.index.cancelBuild(
                                "command"
                            ),
                        status:
                            context.index.stats()
                    })
            },

            {
                name:
                    "index-export",

                category:
                    "search",

                description:
                    "Export the in-memory index as JSON.",

                usage:
                    "index-export [filename]",

                handler: ({
                    args = [],
                    context,
                    write
                }) => {
                    const filename =
                        args[0] ||
                        "speciedex-index.json";

                    const payload =
                        JSON.stringify(
                            context.index.export(),
                            null,
                            2
                        );

                    const blob =
                        new Blob(
                            [
                                payload
                            ],
                            {
                                type:
                                    "application/json"
                            }
                        );

                    const url =
                        URL.createObjectURL(
                            blob
                        );

                    const anchor =
                        document.createElement(
                            "a"
                        );

                    anchor.href =
                        url;

                    anchor.download =
                        filename;

                    anchor.click();

                    window.setTimeout(
                        () =>
                            URL.revokeObjectURL(
                                url
                            ),
                        1000
                    );

                    return write(
                        `Search index exported to ${filename}.`,
                        "success"
                    );
                }
            },

            {
                name:
                    "index-reset",

                category:
                    "search",

                description:
                    "Clear the in-memory search index.",

                usage:
                    "index-reset",

                handler: ({
                    context,
                    write
                }) => {
                    context.index.reset();

                    return write(
                        "Search index cleared.",
                        "success"
                    );
                }
            }
        ];

    /*
    ==========================================================================
    Public Module API
    ==========================================================================
    */

    const api =
        Object.freeze({
            name:
                MODULE_NAME,

            version:
                VERSION,

            INDEX_SYMBOL,
            SearchIndex,

            normalizeText,
            normalizeToken,
            tokenizeValue,
            flatten,
            arrayFromPayload,
            cloneRecord,
            isAbortError,
            yieldToMainThread,
            resolveDocumentID,

            initialize,
            mount:
                initialize,
            init:
                initialize,
            setup:
                initialize,

            commands
        });

    window.SpeciedexTerminalIndex =
        api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules ||
        {};

    window.SpeciedexTerminalModules[
        MODULE_NAME
    ] = api;

    document.dispatchEvent(
        new CustomEvent(
            "speciedex:terminal-module-available",
            {
                detail: {
                    name:
                        MODULE_NAME,

                    module:
                        api
                }
            }
        )
    );
})(window, document);
