/*
========================================================================
Speciedex.org
Terminal Domains Module
========================================================================

Taxonomic domain search and hierarchy service for SpeciedexTerminal.

Provides:

    • Validated domain and superkingdom API requests
    • Name, rank, status, child kingdom, provider, source, geography,
      descendant-count, and date filters
    • Normalized domain records
    • Child-kingdom, lineage, descendant, and synonym helpers
    • Accepted, synonym, deprecated, supported, active, and verified views
    • Rank, status, kingdom, provider, source, geography, and descendant summaries
    • Lifecycle events, caching, and resilient service registration
    • Terminal command integration

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Domains";
    const VERSION = "2.0.0";
    const SERVICE_NAME = "domains";

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
            "kingdom_count",
            "phylum_count",
            "class_count",
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
                `Unsupported domains sort field: ${value}`
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
            "domain",
            "domain_id",
            "superkingdom",
            "superkingdom_id",
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
            "kingdom",
            "kingdom_id",
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
            ["min_kingdoms", source.min_kingdoms ?? source.minKingdoms],
            ["max_kingdoms", source.max_kingdoms ?? source.maxKingdoms],
            ["min_phyla", source.min_phyla ?? source.minPhyla],
            ["max_phyla", source.max_phyla ?? source.maxPhyla],
            ["min_classes", source.min_classes ?? source.minClasses],
            ["max_classes", source.max_classes ?? source.maxClasses],
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
                ["min_kingdoms", "max_kingdoms", "kingdom count"],
                ["min_phyla", "max_phyla", "phylum count"],
                ["min_classes", "max_classes", "class count"],
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
                "Domains start date must not be later than the end date."
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

    function normalizeChildren(value, fallbackRank = "kingdom") {
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
            return normalizeChildren(explicit, "domain");
        }

        const scientificName = normalizeText(
            record.scientific_name ??
            record.scientificName ??
            record.name
        );

        return scientificName
            ? [{
                id: normalizeText(
                    record.id ??
                    record.domain_id ??
                    record.domainId ??
                    ""
                ),
                rank: normalizeKey(
                    record.rank ??
                    record.taxon_rank ??
                    record.taxonRank ??
                    "domain"
                ) || "domain",
                scientific_name: scientificName,
                status: normalizeTaxonomicStatus(
                    record.status ?? "accepted"
                ),
                index: 0
            }]
            : [];
    }

    function normalizeRecord(record, index = 0) {
        if (!record || typeof record !== "object") {
            const name = normalizeText(record);

            return {
                index,
                id: name || `domain-${index + 1}`,
                scientific_name: name,
                canonical_name: name,
                name,
                authorship: "",
                rank: "domain",
                status: "unknown",
                accepted: false,
                synonym: false,
                deprecated: false,
                supported: true,
                verified: false,
                active: true,
                root: true,
                leaf: true,
                kingdoms: [],
                kingdom_count: 0,
                phylum_count: 0,
                class_count: 0,
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
            record.domain ??
            record.superkingdom ??
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
                record.superkingdom
                    ? "superkingdom"
                    : "domain"
            )
        ) || "domain";

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

        const kingdoms = normalizeChildren(
            record.kingdoms ??
            record.child_kingdoms ??
            record.childKingdoms,
            "kingdom"
        );

        const kingdomCount = Number.isFinite(Number(
            record.kingdom_count ??
            record.kingdomCount ??
            record.kingdoms_count ??
            record.kingdomsCount
        ))
            ? Number(
                record.kingdom_count ??
                record.kingdomCount ??
                record.kingdoms_count ??
                record.kingdomsCount
            )
            : kingdoms.length;

        return {
            ...record,
            index: record.index ?? index,
            id: normalizeText(
                record.id ??
                record.domain_id ??
                record.domainId ??
                record.superkingdom_id ??
                record.superkingdomId ??
                record.taxon_id ??
                record.taxonId ??
                record.uuid ??
                `domain-${index + 1}`
            ),
            domain_id: normalizeText(
                record.domain_id ??
                record.domainId ??
                record.taxon_id ??
                record.taxonId ??
                record.id ??
                ""
            ),
            superkingdom_id: normalizeText(
                record.superkingdom_id ??
                record.superkingdomId ??
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
            domain: normalizeText(
                record.domain ??
                (
                    rank === "domain"
                        ? scientificName
                        : ""
                )
            ),
            superkingdom: normalizeText(
                record.superkingdom ??
                (
                    rank === "superkingdom"
                        ? scientificName
                        : ""
                )
            ),
            root: record.root !== false,
            leaf:
                record.leaf === true ||
                record.is_leaf === true ||
                record.isLeaf === true ||
                kingdomCount === 0,
            kingdoms,
            kingdom_count: kingdomCount,
            phylum_count: Number.isFinite(Number(
                record.phylum_count ??
                record.phylumCount
            ))
                ? Number(
                    record.phylum_count ??
                    record.phylumCount
                )
                : 0,
            class_count: Number.isFinite(Number(
                record.class_count ??
                record.classCount
            ))
                ? Number(
                    record.class_count ??
                    record.classCount
                )
                : 0,
            order_count: Number.isFinite(Number(
                record.order_count ??
                record.orderCount
            ))
                ? Number(
                    record.order_count ??
                    record.orderCount
                )
                : 0,
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
            domains: new Map(),
            superkingdoms: new Map(),
            kingdoms: new Map(),
            providers: new Map(),
            sources: new Map(),
            countries: new Map(),
            regions: new Map(),
            continents: new Map(),
            categories: new Map(),
            types: new Map()
        };

        let kingdomCount = 0;
        let phylumCount = 0;
        let classCount = 0;
        let orderCount = 0;
        let familyCount = 0;
        let genusCount = 0;
        let speciesCount = 0;
        let synonymCount = 0;

        for (const item of values) {
            incrementMap(maps.ranks, item.rank);
            incrementMap(maps.statuses, item.status);
            incrementMap(maps.domains, item.domain);
            incrementMap(maps.superkingdoms, item.superkingdom);
            incrementMap(maps.providers, item.provider);
            incrementMap(maps.sources, item.source);
            incrementMap(maps.categories, item.category);
            incrementMap(maps.types, item.type);

            for (const kingdom of item.kingdoms) {
                incrementMap(maps.kingdoms, kingdom.scientific_name);
            }

            for (const country of item.countries) {
                incrementMap(maps.countries, country);
            }

            for (const region of item.regions) {
                incrementMap(maps.regions, region);
            }

            for (const continent of item.continents) {
                incrementMap(maps.continents, continent);
            }

            kingdomCount += item.kingdom_count || 0;
            phylumCount += item.phylum_count || 0;
            classCount += item.class_count || 0;
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
            kingdoms: kingdomCount,
            phyla: phylumCount,
            classes: classCount,
            orders: orderCount,
            families: familyCount,
            genera: genusCount,
            species: speciesCount,
            ranks: mapToSortedObject(maps.ranks),
            statuses: mapToSortedObject(maps.statuses),
            domains: mapToSortedObject(maps.domains),
            superkingdoms: mapToSortedObject(maps.superkingdoms),
            childKingdoms: mapToSortedObject(maps.kingdoms),
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
                            Array.isArray(payload.domains)
                                ? payload.domains
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

    function findDomain(records, value) {
        const target = normalizeText(value);
        const lower = target.toLowerCase();

        return records.find(item =>
            item.id === target ||
            item.domain_id === target ||
            item.superkingdom_id === target ||
            item.scientific_name.toLowerCase() === lower ||
            item.canonical_name.toLowerCase() === lower ||
            item.name.toLowerCase() === lower
        ) || null;
    }

    class DomainsService extends EventTarget {
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
                    "Domains service has been destroyed."
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
                    `domains:${name}`,
                    detail
                );
            } catch (_error) {
                /*
                Observer failures must not break domain operations.
                */
            }

            dispatch(
                this.context.root,
                `speciedex:terminal-domains-${name}`,
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
                    "taxa/domains",
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
                    "A domain ID or name is required."
                );
            }

            try {
                const payload = await this.context.api.get(
                    `taxa/domains/${encodeURIComponent(normalizedId)}`,
                    {},
                    options
                );

                return normalizeRecord(payload, 0);
            } catch (error) {
                const match = findDomain(
                    this.cache?.records || [],
                    normalizedId
                );

                if (match) {
                    return match;
                }

                throw error;
            }
        }

        async children(id, options = {}) {
            const record = await this.get(id, options);

            return {
                id: record.id,
                scientific_name: record.scientific_name,
                rank: record.rank,
                kingdoms: record.kingdoms,
                kingdom_count: record.kingdom_count,
                phylum_count: record.phylum_count,
                class_count: record.class_count,
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
                domains: result.records
            };
        }

        status() {
            return {
                version: VERSION,
                endpoint: "taxa/domains",
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
            existing instanceof DomainsService &&
            !existing.destroyed
        ) {
            context.domains = existing;
            return existing;
        }

        if (
            context.domains instanceof DomainsService &&
            !context.domains.destroyed
        ) {
            return context.domains;
        }

        const service = new DomainsService(context);

        context.domains = service;

        context.registerService?.(
            SERVICE_NAME,
            service
        );

        context.registerService?.(
            "taxa-domains",
            service
        );

        dispatch(
            document,
            "speciedex:terminal-domains-ready",
            {
                context,
                service
            }
        );

        return service;
    }

    function requireService(context) {
        const service =
            context?.domains ||
            context?.services?.get?.(SERVICE_NAME);

        if (!(service instanceof DomainsService)) {
            throw new Error(
                "Domains service is unavailable."
            );
        }

        return service;
    }

    function parseCommandArguments(args = []) {
        const parameters = {};
        const positional = [];

        const textFlags = {
            "--domain=": "domain",
            "--domain-id=": "domain_id",
            "--superkingdom=": "superkingdom",
            "--superkingdom-id=": "superkingdom_id",
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
            "--kingdom=": "kingdom",
            "--kingdom-id=": "kingdom_id",
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
            "--min-kingdoms=": "min_kingdoms",
            "--max-kingdoms=": "max_kingdoms",
            "--min-phyla=": "min_phyla",
            "--max-phyla=": "max_phyla",
            "--min-classes=": "min_classes",
            "--max-classes=": "max_classes",
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
            name: "domains",
            aliases: [
                "taxa-domains"
            ],
            category: "taxonomy",
            description:
                "Search taxonomic domains.",
            usage:
                "domains [query] [limit] [--domain=NAME] [--superkingdom=NAME] [--kingdom=NAME] [--rank=RANK] [--status=STATUS] [--provider=PROVIDER] [--accepted=true|false] [--synonym=true|false] [--deprecated=true|false] [--supported=true|false] [--verified=true|false] [--active=true|false] [--root=true|false] [--leaf=true|false] [--min-kingdoms=N] [--max-kingdoms=N] [--min-phyla=N] [--max-phyla=N] [--min-classes=N] [--max-classes=N] [--min-orders=N] [--max-orders=N] [--min-families=N] [--max-families=N] [--min-genera=N] [--max-genera=N] [--min-species=N] [--max-species=N] [--from=DATE] [--to=DATE] [--sort=FIELD] [--direction=asc|desc] [--offset=N]",
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
            name: "domain",
            aliases: [
                "domain-get"
            ],
            category: "taxonomy",
            description:
                "Retrieve one domain or superkingdom by ID or name.",
            usage:
                "domain <id|name>",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error(
                        "A domain ID or name is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).get(id)
                );
            }
        },
        {
            name: "domain-children",
            category: "taxonomy",
            description:
                "Show child kingdoms and descendant counts for one domain.",
            usage:
                "domain-children <id|name>",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error(
                        "A domain ID or name is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).children(id)
                );
            }
        },
        {
            name: "domain-lineage",
            category: "taxonomy",
            description:
                "Show normalized lineage for one domain.",
            usage:
                "domain-lineage <id|name>",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error(
                        "A domain ID or name is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).lineage(id)
                );
            }
        },
        {
            name: "domain-synonym-list",
            category: "taxonomy",
            description:
                "Show accepted-name and synonym information for one domain.",
            usage:
                "domain-synonym-list <id|name>",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error(
                        "A domain ID or name is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).synonymList(id)
                );
            }
        },
        filteredCommand(
            "domains-accepted",
            ["accepted-domains"],
            "List accepted domain records.",
            "accepted"
        ),
        filteredCommand(
            "domains-synonyms",
            ["synonym-domains"],
            "List synonym domains or records carrying synonym names.",
            "synonyms"
        ),
        filteredCommand(
            "domains-deprecated",
            ["deprecated-domains"],
            "List deprecated domain records.",
            "deprecated"
        ),
        filteredCommand(
            "domains-supported",
            ["supported-domains"],
            "List supported domain records.",
            "supported"
        ),
        {
            name: "domains-summary",
            aliases: [
                "domain-summary"
            ],
            category: "taxonomy",
            description:
                "Summarize domains by rank, status, domain, superkingdom, child kingdom, provider, source, geography, and descendant counts.",
            usage:
                "domains-summary [filters]",
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
            name: "domains-status",
            category: "taxonomy",
            description:
                "Show domains service status.",
            usage:
                "domains-status",
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
        DomainsService,
        normalizeParameters,
        normalizeRecord,
        normalizeResponse,
        normalizeStringArray,
        normalizeTaxonomicStatus,
        normalizeSynonyms,
        normalizeChildren,
        normalizeLineage,
        findDomain,
        summarize,
        parseCommandArguments,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalDomains = api;

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
