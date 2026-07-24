/*
========================================================================
Speciedex.org
Terminal Classes Module
========================================================================

Taxonomic class search and lineage service for SpeciedexTerminal.

Provides:

    • Validated class API requests
    • Class, superclass, subclass, infraclass, parent phylum, child order,
      lineage, provider, source, status, geography, and date filters
    • Normalized class records
    • Parent-phylum, child-order, lineage, descendant, and synonym helpers
    • Accepted, synonym, deprecated, supported, active, and verified views
    • Rank, status, phylum, class, subclass, order, provider, source,
      geography, and descendant summaries
    • Lifecycle events, caching, and resilient service registration
    • Terminal command integration

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Classes";
    const VERSION = "2.0.0";
    const SERVICE_NAME = "classes";

    const DEFAULT_LIMIT = 50;
    const MIN_LIMIT = 1;
    const MAX_LIMIT = 1000;

    function dispatch(target, name, detail, options = {}) {
        if (!target || typeof target.dispatchEvent !== "function") {
            return false;
        }

        try {
            return target.dispatchEvent(new CustomEvent(name, {
                bubbles: options.bubbles === true,
                cancelable: options.cancelable === true,
                detail
            }));
        } catch (_error) {
            return false;
        }
    }

    function normalizeText(value) {
        return String(value ?? "").trim();
    }

    function normalizeKey(value) {
        return normalizeText(value)
            .toLowerCase()
            .replace(/[\s-]+/g, "_")
            .replace(/[^a-z0-9_]/g, "");
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

        if (
            value === 1 ||
            value === "1" ||
            String(value).toLowerCase() === "true"
        ) {
            return true;
        }

        if (
            value === 0 ||
            value === "0" ||
            String(value).toLowerCase() === "false"
        ) {
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

    function normalizeSort(value) {
        const normalized = normalizeKey(value || "scientific_name");

        const allowed = new Set([
            "scientific_name",
            "canonical_name",
            "name",
            "rank",
            "status",
            "phylum",
            "superclass",
            "class",
            "subclass",
            "infraclass",
            "order_count",
            "family_count",
            "genus_count",
            "species_count",
            "provider",
            "updated_at",
            "created_at",
            "id"
        ]);

        if (!allowed.has(normalized)) {
            throw new TypeError(
                `Unsupported classes sort field: ${value}`
            );
        }

        return normalized;
    }

    function normalizeDirection(value) {
        const normalized = normalizeText(value || "asc").toLowerCase();

        if (normalized !== "asc" && normalized !== "desc") {
            throw new TypeError(
                `Unsupported sort direction: ${value}`
            );
        }

        return normalized;
    }

    function normalizeParameters(parameters = {}) {
        const source = parameters && typeof parameters === "object"
            ? parameters
            : {};

        const normalized = {
            q: normalizeText(source.q ?? source.query ?? ""),
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
                source.direction ?? source.order
            )
        };

        const textKeys = [
            "class",
            "class_id",
            "superclass",
            "superclass_id",
            "subclass",
            "subclass_id",
            "infraclass",
            "infraclass_id",
            "taxon",
            "taxon_id",
            "scientific_name",
            "canonical_name",
            "name",
            "authorship",
            "rank",
            "status",
            "accepted_name",
            "accepted_id",
            "domain",
            "kingdom",
            "phylum",
            "phylum_id",
            "subphylum",
            "subphylum_id",
            "order",
            "order_id",
            "provider",
            "source",
            "license",
            "country",
            "region",
            "continent",
            "category",
            "type"
        ];

        for (const key of textKeys) {
            if (
                source[key] !== undefined &&
                source[key] !== null &&
                source[key] !== ""
            ) {
                normalized[key] = normalizeText(source[key]);
            }
        }

        const booleanKeys = [
            "accepted",
            "synonym",
            "deprecated",
            "supported",
            "verified",
            "active",
            "root",
            "leaf"
        ];

        for (const key of booleanKeys) {
            if (
                source[key] !== undefined &&
                source[key] !== null &&
                source[key] !== ""
            ) {
                const value = normalizeBoolean(source[key], null);

                if (value === null) {
                    throw new TypeError(
                        `Invalid ${key} value: ${source[key]}`
                    );
                }

                normalized[key] = value;
            }
        }

        const numericFields = [
            ["min_orders", source.min_orders ?? source.minOrders],
            ["max_orders", source.max_orders ?? source.maxOrders],
            ["min_families", source.min_families ?? source.minFamilies],
            ["max_families", source.max_families ?? source.maxFamilies],
            ["min_genera", source.min_genera ?? source.minGenera],
            ["max_genera", source.max_genera ?? source.maxGenera],
            ["min_species", source.min_species ?? source.minSpecies],
            ["max_species", source.max_species ?? source.maxSpecies]
        ];

        for (const [key, value] of numericFields) {
            if (
                value !== undefined &&
                value !== null &&
                value !== ""
            ) {
                normalized[key] = clampInteger(
                    value,
                    0,
                    0,
                    Number.MAX_SAFE_INTEGER
                );
            }
        }

        for (
            const [minimum, maximum, label] of
            [
                ["min_orders", "max_orders", "order count"],
                ["min_families", "max_families", "family count"],
                ["min_genera", "max_genera", "genus count"],
                ["min_species", "max_species", "species count"]
            ]
        ) {
            if (
                normalized[minimum] !== undefined &&
                normalized[maximum] !== undefined &&
                normalized[minimum] > normalized[maximum]
            ) {
                throw new RangeError(
                    `Minimum ${label} must not exceed maximum ${label}.`
                );
            }
        }

        const from = source.from ?? source.since ?? source.start;
        const to = source.to ?? source.until ?? source.end;

        if (from !== undefined && from !== null && from !== "") {
            normalized.from = normalizeDate(from);
        }

        if (to !== undefined && to !== null && to !== "") {
            normalized.to = normalizeDate(to);
        }

        if (
            normalized.from &&
            normalized.to &&
            Date.parse(normalized.from) >
            Date.parse(normalized.to)
        ) {
            throw new RangeError(
                "Classes start date must not be later than the end date."
            );
        }

        return normalized;
    }

    function normalizeStringArray(value) {
        if (Array.isArray(value)) {
            return [...new Set(
                value.map(normalizeText).filter(Boolean)
            )];
        }

        const text = normalizeText(value);

        if (!text) {
            return [];
        }

        return [...new Set(
            text
                .split(/[;,|]+/)
                .map(normalizeText)
                .filter(Boolean)
        )];
    }

    function normalizeTaxonomicStatus(value) {
        const normalized = normalizeKey(value || "unknown");
        const aliases = {
            valid: "accepted",
            current: "accepted",
            synonymized: "synonym",
            unaccepted: "synonym",
            doubtful: "doubtful",
            uncertain: "unresolved",
            ambiguous: "unresolved",
            deleted: "inactive"
        };

        return aliases[normalized] || normalized;
    }

    function normalizeSynonyms(value) {
        if (!value) {
            return [];
        }

        if (Array.isArray(value)) {
            return value
                .map((item, index) => {
                    if (item && typeof item === "object") {
                        return {
                            id: normalizeText(
                                item.id ??
                                item.taxon_id ??
                                item.taxonId ??
                                ""
                            ),
                            scientific_name: normalizeText(
                                item.scientific_name ??
                                item.scientificName ??
                                item.name ??
                                ""
                            ),
                            authorship: normalizeText(
                                item.authorship ??
                                item.scientific_name_authorship ??
                                item.scientificNameAuthorship ??
                                ""
                            ),
                            status: normalizeTaxonomicStatus(
                                item.status ?? "synonym"
                            ),
                            source: normalizeText(item.source ?? ""),
                            index
                        };
                    }

                    return {
                        id: "",
                        scientific_name: normalizeText(item),
                        authorship: "",
                        status: "synonym",
                        source: "",
                        index
                    };
                })
                .filter(item => item.scientific_name);
        }

        return normalizeStringArray(value).map((name, index) => ({
            id: "",
            scientific_name: name,
            authorship: "",
            status: "synonym",
            source: "",
            index
        }));
    }

    function normalizeChildren(value, fallbackRank = "order") {
        if (!value) {
            return [];
        }

        if (Array.isArray(value)) {
            return value
                .map((item, index) => {
                    if (item && typeof item === "object") {
                        return {
                            id: normalizeText(
                                item.id ??
                                item.taxon_id ??
                                item.taxonId ??
                                ""
                            ),
                            rank: normalizeKey(
                                item.rank ??
                                item.taxon_rank ??
                                item.taxonRank ??
                                fallbackRank
                            ),
                            scientific_name: normalizeText(
                                item.scientific_name ??
                                item.scientificName ??
                                item.name ??
                                ""
                            ),
                            status: normalizeTaxonomicStatus(
                                item.status ?? "accepted"
                            ),
                            index
                        };
                    }

                    return {
                        id: "",
                        rank: fallbackRank,
                        scientific_name: normalizeText(item),
                        status: "accepted",
                        index
                    };
                })
                .filter(item => item.scientific_name);
        }

        return normalizeStringArray(value).map((name, index) => ({
            id: "",
            rank: fallbackRank,
            scientific_name: name,
            status: "accepted",
            index
        }));
    }

    function normalizeLineage(record) {
        const explicit = Array.isArray(record.lineage)
            ? record.lineage
            : (
                Array.isArray(record.classification)
                    ? record.classification
                    : null
            );

        if (explicit) {
            return normalizeChildren(explicit, "class");
        }

        const lineage = [];
        const values = [
            ["domain", record.domain],
            ["kingdom", record.kingdom],
            ["phylum", record.phylum],
            ["subphylum", record.subphylum],
            ["superclass", record.superclass],
            [
                normalizeKey(
                    record.rank ??
                    record.taxon_rank ??
                    record.taxonRank ??
                    "class"
                ) || "class",
                record.scientific_name ??
                record.scientificName ??
                record.name
            ]
        ];

        for (const [rank, value] of values) {
            const scientificName = normalizeText(value);

            if (scientificName) {
                lineage.push({
                    id: "",
                    rank,
                    scientific_name: scientificName,
                    status: "accepted",
                    index: lineage.length
                });
            }
        }

        return lineage;
    }

    function normalizeRecord(record, index = 0) {
        if (!record || typeof record !== "object") {
            const name = normalizeText(record);

            return {
                index,
                id: name || `class-${index + 1}`,
                scientific_name: name,
                canonical_name: name,
                name,
                authorship: "",
                rank: "class",
                status: "unknown",
                accepted: false,
                synonym: false,
                deprecated: false,
                supported: true,
                verified: false,
                active: true,
                domain: "",
                kingdom: "",
                phylum: "",
                phylum_id: "",
                subphylum: "",
                superclass: "",
                class: name,
                subclass: "",
                infraclass: "",
                parent_class: "",
                parent_class_id: "",
                root: true,
                leaf: true,
                orders: [],
                subclasses: [],
                order_count: 0,
                family_count: 0,
                genus_count: 0,
                species_count: 0,
                synonyms: [],
                lineage: [],
                providers: [],
                sources: [],
                countries: [],
                regions: [],
                continents: []
            };
        }

        const scientificName = normalizeText(
            record.scientific_name ??
            record.scientificName ??
            record.name ??
            record.canonical_name ??
            record.canonicalName ??
            record.class ??
            ""
        );

        const canonicalName = normalizeText(
            record.canonical_name ??
            record.canonicalName ??
            record.canonical ??
            scientificName
        );

        const rank = normalizeKey(
            record.rank ??
            record.taxon_rank ??
            record.taxonRank ??
            (
                record.infraclass
                    ? "infraclass"
                    : (
                        record.subclass
                            ? "subclass"
                            : (
                                record.superclass
                                    ? "superclass"
                                    : "class"
                            )
                    )
            )
        ) || "class";

        const status = normalizeTaxonomicStatus(
            record.status ??
            record.taxonomic_status ??
            record.taxonomicStatus ??
            record.acceptance_status ??
            record.acceptanceStatus
        );

        const accepted =
            record.accepted === true ||
            ["accepted", "valid"].includes(status);

        const synonym =
            record.synonym === true ||
            record.is_synonym === true ||
            record.isSynonym === true ||
            status === "synonym";

        const deprecated =
            record.deprecated === true ||
            status === "deprecated";

        const active =
            record.active !== false &&
            record.deleted !== true &&
            !["inactive", "deleted", "retired"].includes(status);

        const orders = normalizeChildren(
            record.orders ??
            record.child_orders ??
            record.childOrders,
            "order"
        );

        const subclasses = normalizeChildren(
            record.subclasses ??
            record.child_subclasses ??
            record.childSubclasses,
            "subclass"
        );

        const orderCount = Number.isFinite(Number(
            record.order_count ??
            record.orderCount ??
            record.orders_count ??
            record.ordersCount
        ))
            ? Number(
                record.order_count ??
                record.orderCount ??
                record.orders_count ??
                record.ordersCount
            )
            : orders.length;

        return {
            ...record,
            index: record.index ?? index,
            id: normalizeText(
                record.id ??
                record.class_id ??
                record.classId ??
                record.superclass_id ??
                record.superclassId ??
                record.subclass_id ??
                record.subclassId ??
                record.infraclass_id ??
                record.infraclassId ??
                record.taxon_id ??
                record.taxonId ??
                record.uuid ??
                `class-${index + 1}`
            ),
            class_id: normalizeText(
                record.class_id ??
                record.classId ??
                record.taxon_id ??
                record.taxonId ??
                record.id ??
                ""
            ),
            superclass_id: normalizeText(
                record.superclass_id ??
                record.superclassId ??
                ""
            ),
            subclass_id: normalizeText(
                record.subclass_id ??
                record.subclassId ??
                ""
            ),
            infraclass_id: normalizeText(
                record.infraclass_id ??
                record.infraclassId ??
                ""
            ),
            scientific_name: scientificName,
            canonical_name: canonicalName,
            name: normalizeText(record.name ?? scientificName),
            authorship: normalizeText(
                record.authorship ??
                record.scientific_name_authorship ??
                record.scientificNameAuthorship ??
                ""
            ),
            rank,
            status,
            accepted,
            synonym,
            deprecated,
            supported:
                record.supported !== false &&
                !["unsupported", "disabled"].includes(status),
            verified:
                record.verified === true ||
                ["verified", "confirmed"].includes(
                    normalizeKey(
                        record.verification_status ??
                        record.verificationStatus
                    )
                ),
            active,
            accepted_name: normalizeText(
                record.accepted_name ??
                record.acceptedName ??
                ""
            ),
            accepted_id: normalizeText(
                record.accepted_id ??
                record.acceptedId ??
                record.accepted_taxon_id ??
                record.acceptedTaxonId ??
                ""
            ),
            domain: normalizeText(record.domain ?? ""),
            kingdom: normalizeText(record.kingdom ?? ""),
            phylum: normalizeText(record.phylum ?? ""),
            phylum_id: normalizeText(
                record.phylum_id ??
                record.phylumId ??
                ""
            ),
            subphylum: normalizeText(record.subphylum ?? ""),
            subphylum_id: normalizeText(
                record.subphylum_id ??
                record.subphylumId ??
                ""
            ),
            superclass: normalizeText(
                record.superclass ??
                (
                    rank === "superclass"
                        ? scientificName
                        : ""
                )
            ),
            class: normalizeText(
                record.class ??
                record.class_name ??
                record.className ??
                (
                    rank === "class"
                        ? scientificName
                        : ""
                )
            ),
            subclass: normalizeText(
                record.subclass ??
                (
                    rank === "subclass"
                        ? scientificName
                        : ""
                )
            ),
            infraclass: normalizeText(
                record.infraclass ??
                (
                    rank === "infraclass"
                        ? scientificName
                        : ""
                )
            ),
            parent_class: normalizeText(
                record.parent_class ??
                record.parentClass ??
                record.parent ??
                ""
            ),
            parent_class_id: normalizeText(
                record.parent_class_id ??
                record.parentClassId ??
                record.parent_id ??
                record.parentId ??
                ""
            ),
            root:
                record.root === true ||
                record.is_root === true ||
                record.isRoot === true ||
                !normalizeText(
                    record.parent_class ??
                    record.parentClass ??
                    record.parent
                ),
            leaf:
                record.leaf === true ||
                record.is_leaf === true ||
                record.isLeaf === true ||
                (
                    orderCount === 0 &&
                    subclasses.length === 0
                ),
            orders,
            subclasses,
            order_count: orderCount,
            family_count: Number.isFinite(Number(
                record.family_count ??
                record.familyCount
            ))
                ? Number(
                    record.family_count ??
                    record.familyCount
                )
                : 0,
            genus_count: Number.isFinite(Number(
                record.genus_count ??
                record.genusCount
            ))
                ? Number(
                    record.genus_count ??
                    record.genusCount
                )
                : 0,
            species_count: Number.isFinite(Number(
                record.species_count ??
                record.speciesCount
            ))
                ? Number(
                    record.species_count ??
                    record.speciesCount
                )
                : 0,
            synonyms: normalizeSynonyms(
                record.synonyms ??
                record.synonym_names ??
                record.synonymNames
            ),
            lineage: normalizeLineage({
                ...record,
                scientific_name: scientificName,
                rank
            }),
            provider: normalizeText(
                record.provider ??
                record.provider_name ??
                record.providerName ??
                ""
            ),
            providers: normalizeStringArray(
                record.providers ??
                record.provider
            ),
            source: normalizeText(
                record.source ??
                record.source_name ??
                record.sourceName ??
                ""
            ),
            sources: normalizeStringArray(
                record.sources ??
                record.source
            ),
            license: normalizeText(
                record.license ??
                record.licence ??
                ""
            ),
            countries: normalizeStringArray(
                record.countries ??
                record.country_codes ??
                record.countryCodes ??
                record.country
            ),
            regions: normalizeStringArray(
                record.regions ??
                record.region
            ),
            continents: normalizeStringArray(
                record.continents ??
                record.continent
            ),
            category: normalizeText(record.category ?? ""),
            type: normalizeText(record.type ?? ""),
            created_at:
                record.created_at ??
                record.createdAt ??
                "",
            updated_at:
                record.updated_at ??
                record.updatedAt ??
                record.last_updated ??
                record.lastUpdated ??
                ""
        };
    }

    function incrementMap(map, key) {
        const normalized = normalizeText(key) || "unknown";
        map.set(normalized, (map.get(normalized) || 0) + 1);
    }

    function mapToSortedObject(map) {
        return Object.fromEntries(
            [...map.entries()].sort(
                (left, right) =>
                    right[1] - left[1] ||
                    left[0].localeCompare(right[0])
            )
        );
    }

    function summarize(records) {
        const values = Array.isArray(records) ? records : [];

        const maps = {
            ranks: new Map(),
            statuses: new Map(),
            phyla: new Map(),
            subphyla: new Map(),
            superclasses: new Map(),
            classes: new Map(),
            subclasses: new Map(),
            infraclasses: new Map(),
            providers: new Map(),
            sources: new Map(),
            countries: new Map(),
            regions: new Map(),
            continents: new Map(),
            categories: new Map(),
            types: new Map()
        };

        let orderCount = 0;
        let familyCount = 0;
        let genusCount = 0;
        let speciesCount = 0;
        let synonymCount = 0;

        for (const item of values) {
            incrementMap(maps.ranks, item.rank);
            incrementMap(maps.statuses, item.status);
            incrementMap(maps.phyla, item.phylum);
            incrementMap(maps.subphyla, item.subphylum);
            incrementMap(maps.superclasses, item.superclass);
            incrementMap(maps.classes, item.class);
            incrementMap(maps.subclasses, item.subclass);
            incrementMap(maps.infraclasses, item.infraclass);
            incrementMap(maps.providers, item.provider);
            incrementMap(maps.sources, item.source);
            incrementMap(maps.categories, item.category);
            incrementMap(maps.types, item.type);

            for (const country of item.countries) {
                incrementMap(maps.countries, country);
            }

            for (const region of item.regions) {
                incrementMap(maps.regions, region);
            }

            for (const continent of item.continents) {
                incrementMap(maps.continents, continent);
            }

            orderCount += item.order_count || 0;
            familyCount += item.family_count || 0;
            genusCount += item.genus_count || 0;
            speciesCount += item.species_count || 0;
            synonymCount += item.synonyms.length;
        }

        return {
            total: values.length,
            accepted: values.filter(item => item.accepted).length,
            synonyms: values.filter(item => item.synonym).length,
            synonymNames: synonymCount,
            deprecated: values.filter(item => item.deprecated).length,
            supported: values.filter(item => item.supported).length,
            verified: values.filter(item => item.verified).length,
            active: values.filter(item => item.active).length,
            roots: values.filter(item => item.root).length,
            leaves: values.filter(item => item.leaf).length,
            orders: orderCount,
            families: familyCount,
            genera: genusCount,
            species: speciesCount,
            ranks: mapToSortedObject(maps.ranks),
            statuses: mapToSortedObject(maps.statuses),
            phyla: mapToSortedObject(maps.phyla),
            subphyla: mapToSortedObject(maps.subphyla),
            superclasses: mapToSortedObject(maps.superclasses),
            classes: mapToSortedObject(maps.classes),
            subclasses: mapToSortedObject(maps.subclasses),
            infraclasses: mapToSortedObject(maps.infraclasses),
            providers: mapToSortedObject(maps.providers),
            sources: mapToSortedObject(maps.sources),
            countries: mapToSortedObject(maps.countries),
            regions: mapToSortedObject(maps.regions),
            continents: mapToSortedObject(maps.continents),
            categories: mapToSortedObject(maps.categories),
            types: mapToSortedObject(maps.types)
        };
    }

    function normalizeResponse(payload) {
        if (Array.isArray(payload)) {
            const records = payload.map(normalizeRecord);

            return {
                records,
                total: records.length,
                limit: records.length,
                offset: 0,
                summary: summarize(records),
                raw: payload
            };
        }

        if (payload && typeof payload === "object") {
            const values = Array.isArray(payload.records)
                ? payload.records
                : (
                    Array.isArray(payload.items)
                        ? payload.items
                        : (
                            Array.isArray(payload.classes)
                                ? payload.classes
                                : (
                                    Array.isArray(payload.taxa)
                                        ? payload.taxa
                                        : []
                                )
                        )
                );

            const records = values.map(normalizeRecord);

            return {
                records,
                total: Number.isFinite(Number(payload.total))
                    ? Number(payload.total)
                    : records.length,
                limit: Number.isFinite(Number(payload.limit))
                    ? Number(payload.limit)
                    : records.length,
                offset: Number.isFinite(Number(payload.offset))
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
                    null,
                previous:
                    payload.previous ??
                    payload.previousPage ??
                    null,
                raw: payload
            };
        }

        return {
            records: [],
            total: 0,
            limit: 0,
            offset: 0,
            summary: summarize([]),
            raw: payload
        };
    }

    function findClass(records, value) {
        const target = normalizeText(value);
        const lower = target.toLowerCase();

        return records.find(item =>
            item.id === target ||
            item.class_id === target ||
            item.superclass_id === target ||
            item.subclass_id === target ||
            item.infraclass_id === target ||
            item.scientific_name.toLowerCase() === lower ||
            item.canonical_name.toLowerCase() === lower ||
            item.name.toLowerCase() === lower
        ) || null;
    }

    class ClassesService extends EventTarget {
        constructor(context) {
            super();

            if (!context || typeof context !== "object") {
                throw new TypeError(
                    "A terminal context is required."
                );
            }

            this.context = context;
            this.destroyed = false;
            this.cache = null;
            this.cacheTimestamp = 0;
        }

        ensureAvailable() {
            if (this.destroyed) {
                throw new Error(
                    "Classes service has been destroyed."
                );
            }

            if (
                !this.context.api ||
                typeof this.context.api.get !== "function"
            ) {
                throw new Error(
                    "Speciedex API client is unavailable."
                );
            }
        }

        emit(name, detail) {
            dispatch(this, name, detail);

            try {
                this.context.events?.emit?.(
                    `classes:${name}`,
                    detail
                );
            } catch (_error) {
                /*
                Observer failures must not break class operations.
                */
            }

            dispatch(
                this.context.root,
                `speciedex:terminal-classes-${name}`,
                detail,
                { bubbles: true }
            );
        }

        async list(parameters = {}, options = {}) {
            this.ensureAvailable();

            const normalized = normalizeParameters(parameters);
            const startedAt = performance.now();

            this.emit("request", {
                operation: "list",
                parameters: normalized
            });

            try {
                const payload = await this.context.api.get(
                    "taxa/classes",
                    normalized,
                    options
                );

                const result = normalizeResponse(payload);

                result.parameters = normalized;
                result.duration = performance.now() - startedAt;

                this.cache = result;
                this.cacheTimestamp = Date.now();

                this.emit("complete", result);

                return result;
            } catch (error) {
                this.emit("error", {
                    operation: "list",
                    error,
                    parameters: normalized,
                    duration: performance.now() - startedAt
                });

                throw error;
            }
        }

        async get(id, options = {}) {
            this.ensureAvailable();

            const normalizedId = normalizeText(id);

            if (!normalizedId) {
                throw new TypeError(
                    "A class ID or name is required."
                );
            }

            try {
                const payload = await this.context.api.get(
                    `taxa/classes/${encodeURIComponent(normalizedId)}`,
                    {},
                    options
                );

                return normalizeRecord(payload, 0);
            } catch (error) {
                const match = findClass(
                    this.cache?.records || [],
                    normalizedId
                );

                if (match) {
                    return match;
                }

                throw error;
            }
        }

        async byPhylum(phylum, parameters = {}, options = {}) {
            const normalizedPhylum = normalizeText(phylum);

            if (!normalizedPhylum) {
                throw new TypeError(
                    "A phylum ID or name is required."
                );
            }

            const result = await this.list({
                ...parameters,
                phylum: normalizedPhylum
            }, options);

            const lower = normalizedPhylum.toLowerCase();

            const records = result.records.filter(item =>
                item.phylum.toLowerCase() === lower ||
                item.phylum_id === normalizedPhylum
            );

            return {
                ...result,
                phylum: normalizedPhylum,
                records,
                summary: summarize(records)
            };
        }

        async children(id, options = {}) {
            const record = await this.get(id, options);

            return {
                id: record.id,
                scientific_name: record.scientific_name,
                rank: record.rank,
                subclasses: record.subclasses,
                orders: record.orders,
                order_count: record.order_count,
                family_count: record.family_count,
                genus_count: record.genus_count,
                species_count: record.species_count
            };
        }

        async lineage(id, options = {}) {
            const record = await this.get(id, options);

            return {
                id: record.id,
                scientific_name: record.scientific_name,
                rank: record.rank,
                phylum: record.phylum,
                phylum_id: record.phylum_id,
                subphylum: record.subphylum,
                lineage: record.lineage
            };
        }

        async synonymList(id, options = {}) {
            const record = await this.get(id, options);

            return {
                id: record.id,
                scientific_name: record.scientific_name,
                accepted: record.accepted,
                accepted_name: record.accepted_name,
                accepted_id: record.accepted_id,
                synonyms: record.synonyms
            };
        }

        async filtered(flag, parameters = {}, options = {}) {
            const result = await this.list({
                ...parameters,
                [flag]: true
            }, options);

            const records = result.records.filter(item => {
                if (flag === "synonym") {
                    return item.synonym || item.synonyms.length;
                }

                return Boolean(item[flag]);
            });

            return {
                ...result,
                records,
                summary: summarize(records)
            };
        }

        accepted(parameters = {}, options = {}) {
            return this.filtered("accepted", parameters, options);
        }

        synonyms(parameters = {}, options = {}) {
            return this.filtered("synonym", parameters, options);
        }

        deprecated(parameters = {}, options = {}) {
            return this.filtered("deprecated", parameters, options);
        }

        supported(parameters = {}, options = {}) {
            return this.filtered("supported", parameters, options);
        }

        async summary(parameters = {}, options = {}) {
            const result = await this.list({
                ...parameters,
                limit: parameters.limit ?? MAX_LIMIT
            }, options);

            return {
                parameters: result.parameters,
                summary: summarize(result.records),
                classes: result.records
            };
        }

        status() {
            return {
                version: VERSION,
                endpoint: "taxa/classes",
                service: SERVICE_NAME,
                available: Boolean(
                    this.context.api &&
                    typeof this.context.api.get === "function"
                ),
                cached: Boolean(this.cache),
                cacheAge: this.cacheTimestamp
                    ? Date.now() - this.cacheTimestamp
                    : null,
                destroyed: this.destroyed
            };
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            this.cache = null;
            this.cacheTimestamp = 0;
            this.destroyed = true;

            dispatch(this, "destroy", {
                timestamp: new Date().toISOString()
            });

            return true;
        }
    }

    function initialize(context) {
        const existing = context.services?.get?.(SERVICE_NAME);

        if (
            existing instanceof ClassesService &&
            !existing.destroyed
        ) {
            context.classes = existing;
            return existing;
        }

        if (
            context.classes instanceof ClassesService &&
            !context.classes.destroyed
        ) {
            return context.classes;
        }

        const service = new ClassesService(context);

        context.classes = service;

        context.registerService?.(
            SERVICE_NAME,
            service
        );

        context.registerService?.(
            "taxa-classes",
            service
        );

        dispatch(
            document,
            "speciedex:terminal-classes-ready",
            {
                context,
                service
            }
        );

        return service;
    }

    function requireService(context) {
        const service =
            context?.classes ||
            context?.services?.get?.(SERVICE_NAME);

        if (!(service instanceof ClassesService)) {
            throw new Error(
                "Classes service is unavailable."
            );
        }

        return service;
    }

    function parseCommandArguments(args = []) {
        const parameters = {};
        const positional = [];

        const textFlags = {
            "--class=": "class",
            "--class-id=": "class_id",
            "--superclass=": "superclass",
            "--superclass-id=": "superclass_id",
            "--subclass=": "subclass",
            "--subclass-id=": "subclass_id",
            "--infraclass=": "infraclass",
            "--infraclass-id=": "infraclass_id",
            "--taxon=": "taxon",
            "--taxon-id=": "taxon_id",
            "--scientific-name=": "scientific_name",
            "--canonical-name=": "canonical_name",
            "--name=": "name",
            "--authorship=": "authorship",
            "--rank=": "rank",
            "--status=": "status",
            "--accepted-name=": "accepted_name",
            "--accepted-id=": "accepted_id",
            "--domain=": "domain",
            "--kingdom=": "kingdom",
            "--phylum=": "phylum",
            "--phylum-id=": "phylum_id",
            "--subphylum=": "subphylum",
            "--subphylum-id=": "subphylum_id",
            "--order=": "order",
            "--order-id=": "order_id",
            "--provider=": "provider",
            "--source=": "source",
            "--license=": "license",
            "--country=": "country",
            "--region=": "region",
            "--continent=": "continent",
            "--category=": "category",
            "--type=": "type",
            "--from=": "from",
            "--to=": "to",
            "--sort=": "sort",
            "--direction=": "direction",
            "--limit=": "limit",
            "--offset=": "offset",
            "--min-orders=": "min_orders",
            "--max-orders=": "max_orders",
            "--min-families=": "min_families",
            "--max-families=": "max_families",
            "--min-genera=": "min_genera",
            "--max-genera=": "max_genera",
            "--min-species=": "min_species",
            "--max-species=": "max_species"
        };

        const booleanFlags = {
            "--accepted=": "accepted",
            "--synonym=": "synonym",
            "--deprecated=": "deprecated",
            "--supported=": "supported",
            "--verified=": "verified",
            "--active=": "active",
            "--root=": "root",
            "--leaf=": "leaf"
        };

        for (const argument of args) {
            let matched = false;

            for (const [flag, key] of Object.entries(textFlags)) {
                if (argument.startsWith(flag)) {
                    parameters[key] = argument.slice(flag.length);
                    matched = true;
                    break;
                }
            }

            if (matched) {
                continue;
            }

            for (const [flag, key] of Object.entries(booleanFlags)) {
                if (argument.startsWith(flag)) {
                    parameters[key] = argument.slice(flag.length);
                    matched = true;
                    break;
                }
            }

            if (!matched && !argument.startsWith("--")) {
                positional.push(argument);
            }
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
        return typeof writeJSON === "function"
            ? writeJSON(value)
            : value;
    }

    function filteredCommand(name, aliases, description, method) {
        return {
            name,
            aliases,
            category: "taxonomy",
            description,
            usage: `${name} [filters]`,
            handler: async ({
                args = [],
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context)[method](
                        parseCommandArguments(args)
                    )
                )
        };
    }

    const commands = [
        {
            name: "classes",
            aliases: [
                "taxa-classes"
            ],
            category: "taxonomy",
            description:
                "Search taxonomic classes.",
            usage:
                "classes [query] [limit] [--class=NAME] [--superclass=NAME] [--subclass=NAME] [--infraclass=NAME] [--phylum=NAME] [--order=NAME] [--rank=RANK] [--status=STATUS] [--provider=PROVIDER] [--accepted=true|false] [--synonym=true|false] [--deprecated=true|false] [--supported=true|false] [--verified=true|false] [--active=true|false] [--root=true|false] [--leaf=true|false] [--min-orders=N] [--max-orders=N] [--min-families=N] [--max-families=N] [--min-genera=N] [--max-genera=N] [--min-species=N] [--max-species=N] [--from=DATE] [--to=DATE] [--sort=FIELD] [--direction=asc|desc] [--offset=N]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).list(
                        parseCommandArguments(args)
                    )
                )
        },
        {
            name: "class",
            aliases: [
                "class-get"
            ],
            category: "taxonomy",
            description:
                "Retrieve one class-level taxon by ID or name.",
            usage:
                "class <id|name>",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error(
                        "A class ID or name is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).get(id)
                );
            }
        },
        {
            name: "classes-by-phylum",
            aliases: [
                "phylum-classes"
            ],
            category: "taxonomy",
            description:
                "List classes belonging to one phylum.",
            usage:
                "classes-by-phylum <phylum-id|phylum-name> [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                if (!args.length) {
                    throw new Error(
                        "A phylum ID or name is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).byPhylum(
                        args[0],
                        parseCommandArguments(args.slice(1))
                    )
                );
            }
        },
        {
            name: "class-children",
            category: "taxonomy",
            description:
                "Show child subclasses and orders for one class.",
            usage:
                "class-children <id|name>",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error(
                        "A class ID or name is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).children(id)
                );
            }
        },
        {
            name: "class-lineage",
            category: "taxonomy",
            description:
                "Show normalized lineage for one class-level taxon.",
            usage:
                "class-lineage <id|name>",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error(
                        "A class ID or name is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).lineage(id)
                );
            }
        },
        {
            name: "class-synonym-list",
            category: "taxonomy",
            description:
                "Show accepted-name and synonym information for one class.",
            usage:
                "class-synonym-list <id|name>",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error(
                        "A class ID or name is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).synonymList(id)
                );
            }
        },
        filteredCommand(
            "classes-accepted",
            ["accepted-classes"],
            "List accepted class records.",
            "accepted"
        ),
        filteredCommand(
            "classes-synonyms",
            ["synonym-classes"],
            "List synonym classes or records carrying synonym names.",
            "synonyms"
        ),
        filteredCommand(
            "classes-deprecated",
            ["deprecated-classes"],
            "List deprecated class records.",
            "deprecated"
        ),
        filteredCommand(
            "classes-supported",
            ["supported-classes"],
            "List supported class records.",
            "supported"
        ),
        {
            name: "classes-summary",
            aliases: [
                "class-summary"
            ],
            category: "taxonomy",
            description:
                "Summarize classes by rank, status, phylum, superclass, class, subclass, infraclass, provider, source, geography, order count, family count, genus count, and species count.",
            usage:
                "classes-summary [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).summary(
                        parseCommandArguments(args)
                    )
                )
        },
        {
            name: "classes-status",
            category: "taxonomy",
            description:
                "Show classes service status.",
            usage:
                "classes-status",
            handler: ({
                context,
                writeJSON
            }) =>
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
        ClassesService,
        normalizeParameters,
        normalizeRecord,
        normalizeResponse,
        normalizeStringArray,
        normalizeTaxonomicStatus,
        normalizeSynonyms,
        normalizeChildren,
        normalizeLineage,
        findClass,
        summarize,
        parseCommandArguments,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalClasses = api;

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
            module: api
        }
    );
})(window, document);
