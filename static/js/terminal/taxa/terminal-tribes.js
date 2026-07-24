/*
========================================================================
Speciedex.org
Terminal Tribes Module
========================================================================

Taxonomic tribe search and lineage service for SpeciedexTerminal.

Provides:

    • Validated tribe and subtribe API requests
    • Name, parent family, child genus, lineage, provider, source,
      status, geography, and date filters
    • Normalized tribe records
    • Parent-family, subtribe, genus, lineage, and synonym helpers
    • Accepted, synonym, deprecated, supported, active, and verified views
    • Family, tribe, subtribe, genus, status, provider, source,
      geography, and lineage summaries
    • Lifecycle events, caching, and resilient service registration
    • Terminal command integration

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Tribes";
    const VERSION = "2.0.0";
    const SERVICE_NAME = "tribes";

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
            "family",
            "subfamily",
            "tribe",
            "subtribe",
            "genus_count",
            "species_count",
            "provider",
            "updated_at",
            "created_at",
            "id"
        ]);

        if (!allowed.has(normalized)) {
            throw new TypeError(`Unsupported tribes sort field: ${value}`);
        }

        return normalized;
    }

    function normalizeDirection(value) {
        const normalized = normalizeText(value || "asc").toLowerCase();

        if (normalized !== "asc" && normalized !== "desc") {
            throw new TypeError(`Unsupported sort direction: ${value}`);
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
            "tribe",
            "tribe_id",
            "subtribe",
            "subtribe_id",
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
            "phylum",
            "class",
            "order",
            "superfamily",
            "family",
            "family_id",
            "subfamily",
            "subfamily_id",
            "genus",
            "genus_id",
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
            "active"
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

        const minGenera = source.min_genera ?? source.minGenera;
        const maxGenera = source.max_genera ?? source.maxGenera;
        const minSpecies = source.min_species ?? source.minSpecies;
        const maxSpecies = source.max_species ?? source.maxSpecies;

        for (
            const [key, value] of
            [
                ["min_genera", minGenera],
                ["max_genera", maxGenera],
                ["min_species", minSpecies],
                ["max_species", maxSpecies]
            ]
        ) {
            if (value !== undefined && value !== null && value !== "") {
                normalized[key] = clampInteger(
                    value,
                    0,
                    0,
                    Number.MAX_SAFE_INTEGER
                );
            }
        }

        if (
            normalized.min_genera !== undefined &&
            normalized.max_genera !== undefined &&
            normalized.min_genera > normalized.max_genera
        ) {
            throw new RangeError(
                "Minimum genus count must not exceed maximum genus count."
            );
        }

        if (
            normalized.min_species !== undefined &&
            normalized.max_species !== undefined &&
            normalized.min_species > normalized.max_species
        ) {
            throw new RangeError(
                "Minimum species count must not exceed maximum species count."
            );
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
            Date.parse(normalized.from) > Date.parse(normalized.to)
        ) {
            throw new RangeError(
                "Tribes start date must not be later than the end date."
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

    function normalizeChildren(value, rank) {
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
                                rank
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
                        rank,
                        scientific_name: normalizeText(item),
                        status: "accepted",
                        index
                    };
                })
                .filter(item => item.scientific_name);
        }

        return normalizeStringArray(value).map((name, index) => ({
            id: "",
            rank,
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
            return explicit
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
                                ""
                            ),
                            scientific_name: normalizeText(
                                item.scientific_name ??
                                item.scientificName ??
                                item.name ??
                                ""
                            ),
                            index
                        };
                    }

                    return {
                        id: "",
                        rank: "",
                        scientific_name: normalizeText(item),
                        index
                    };
                })
                .filter(item => item.scientific_name);
        }

        const lineage = [];
        const values = [
            ["domain", record.domain],
            ["kingdom", record.kingdom],
            ["phylum", record.phylum],
            ["class", record.class ?? record.class_name ?? record.className],
            ["order", record.order ?? record.order_name ?? record.orderName],
            ["superfamily", record.superfamily],
            ["family", record.family],
            ["subfamily", record.subfamily],
            ["tribe", record.tribe ?? record.scientific_name ?? record.name],
            ["subtribe", record.subtribe]
        ];

        for (const [rank, value] of values) {
            const scientificName = normalizeText(value);

            if (scientificName) {
                lineage.push({
                    id: "",
                    rank,
                    scientific_name: scientificName,
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
                id: name || `tribe-${index + 1}`,
                scientific_name: name,
                canonical_name: name,
                name,
                authorship: "",
                rank: "tribe",
                status: "unknown",
                accepted: false,
                synonym: false,
                deprecated: false,
                supported: true,
                verified: false,
                active: true,
                family: "",
                family_id: "",
                subfamily: "",
                subfamily_id: "",
                tribe: name,
                subtribe: "",
                genera: [],
                subtribes: [],
                synonyms: [],
                lineage: [],
                providers: [],
                sources: [],
                countries: [],
                regions: [],
                continents: [],
                genus_count: 0,
                species_count: 0
            };
        }

        const scientificName = normalizeText(
            record.scientific_name ??
            record.scientificName ??
            record.name ??
            record.canonical_name ??
            record.canonicalName ??
            record.tribe ??
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
                record.subtribe
                    ? "subtribe"
                    : "tribe"
            )
        ) || "tribe";

        const status = normalizeTaxonomicStatus(
            record.status ??
            record.taxonomic_status ??
            record.taxonomicStatus ??
            record.acceptance_status ??
            record.acceptanceStatus
        );

        const accepted = record.accepted === true ||
            ["accepted", "valid"].includes(status);

        const synonym = record.synonym === true ||
            record.is_synonym === true ||
            record.isSynonym === true ||
            status === "synonym";

        const deprecated = record.deprecated === true ||
            status === "deprecated";

        const active = record.active !== false &&
            record.deleted !== true &&
            !["inactive", "deleted", "retired"].includes(status);

        const genera = normalizeChildren(
            record.genera ??
            record.child_genera ??
            record.childGenera,
            "genus"
        );

        const subtribes = normalizeChildren(
            record.subtribes ??
            record.child_subtribes ??
            record.childSubtribes,
            "subtribe"
        );

        return {
            ...record,
            index: record.index ?? index,
            id: normalizeText(
                record.id ??
                record.tribe_id ??
                record.tribeId ??
                record.subtribe_id ??
                record.subtribeId ??
                record.taxon_id ??
                record.taxonId ??
                record.uuid ??
                `tribe-${index + 1}`
            ),
            tribe_id: normalizeText(
                record.tribe_id ??
                record.tribeId ??
                record.taxon_id ??
                record.taxonId ??
                record.id ??
                ""
            ),
            subtribe_id: normalizeText(
                record.subtribe_id ??
                record.subtribeId ??
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
            supported: record.supported !== false &&
                !["unsupported", "disabled"].includes(status),
            verified: record.verified === true ||
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
            class: normalizeText(
                record.class ??
                record.class_name ??
                record.className ??
                ""
            ),
            order: normalizeText(
                record.order ??
                record.order_name ??
                record.orderName ??
                ""
            ),
            superfamily: normalizeText(record.superfamily ?? ""),
            family: normalizeText(record.family ?? ""),
            family_id: normalizeText(
                record.family_id ??
                record.familyId ??
                ""
            ),
            subfamily: normalizeText(record.subfamily ?? ""),
            subfamily_id: normalizeText(
                record.subfamily_id ??
                record.subfamilyId ??
                ""
            ),
            tribe: normalizeText(
                record.tribe ??
                (
                    rank === "tribe"
                        ? scientificName
                        : ""
                )
            ),
            subtribe: normalizeText(
                record.subtribe ??
                (
                    rank === "subtribe"
                        ? scientificName
                        : ""
                )
            ),
            parent_tribe: normalizeText(
                record.parent_tribe ??
                record.parentTribe ??
                ""
            ),
            parent_tribe_id: normalizeText(
                record.parent_tribe_id ??
                record.parentTribeId ??
                ""
            ),
            genera,
            subtribes,
            genus_count: Number.isFinite(Number(
                record.genus_count ??
                record.genusCount ??
                record.genera_count ??
                record.generaCount
            ))
                ? Number(
                    record.genus_count ??
                    record.genusCount ??
                    record.genera_count ??
                    record.generaCount
                )
                : genera.length,
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
                tribe: record.tribe ?? scientificName
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
            families: new Map(),
            subfamilies: new Map(),
            tribes: new Map(),
            subtribes: new Map(),
            providers: new Map(),
            sources: new Map(),
            countries: new Map(),
            regions: new Map(),
            continents: new Map(),
            categories: new Map(),
            types: new Map()
        };

        let genusCount = 0;
        let speciesCount = 0;
        let synonymCount = 0;

        for (const item of values) {
            incrementMap(maps.ranks, item.rank);
            incrementMap(maps.statuses, item.status);
            incrementMap(maps.families, item.family);
            incrementMap(maps.subfamilies, item.subfamily);
            incrementMap(maps.tribes, item.tribe);
            incrementMap(maps.subtribes, item.subtribe);
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
            genera: genusCount,
            species: speciesCount,
            ranks: mapToSortedObject(maps.ranks),
            statuses: mapToSortedObject(maps.statuses),
            families: mapToSortedObject(maps.families),
            subfamilies: mapToSortedObject(maps.subfamilies),
            tribes: mapToSortedObject(maps.tribes),
            subtribes: mapToSortedObject(maps.subtribes),
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
                            Array.isArray(payload.tribes)
                                ? payload.tribes
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
                next: payload.next ?? payload.nextPage ?? null,
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

    function findTribe(records, value) {
        const target = normalizeText(value);
        const lower = target.toLowerCase();

        return records.find(item =>
            item.id === target ||
            item.tribe_id === target ||
            item.subtribe_id === target ||
            item.scientific_name.toLowerCase() === lower ||
            item.canonical_name.toLowerCase() === lower ||
            item.name.toLowerCase() === lower
        ) || null;
    }

    class TribesService extends EventTarget {
        constructor(context) {
            super();

            if (!context || typeof context !== "object") {
                throw new TypeError("A terminal context is required.");
            }

            this.context = context;
            this.destroyed = false;
            this.cache = null;
            this.cacheTimestamp = 0;
        }

        ensureAvailable() {
            if (this.destroyed) {
                throw new Error("Tribes service has been destroyed.");
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
                    `tribes:${name}`,
                    detail
                );
            } catch (_error) {
                /*
                Observer failures must not break tribe operations.
                */
            }

            dispatch(
                this.context.root,
                `speciedex:terminal-tribes-${name}`,
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
                    "taxa/tribes",
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
                    "A tribe or subtribe ID or name is required."
                );
            }

            try {
                const payload = await this.context.api.get(
                    `taxa/tribes/${encodeURIComponent(normalizedId)}`,
                    {},
                    options
                );

                return normalizeRecord(payload, 0);
            } catch (error) {
                const match = findTribe(
                    this.cache?.records || [],
                    normalizedId
                );

                if (match) {
                    return match;
                }

                throw error;
            }
        }

        async byFamily(family, parameters = {}, options = {}) {
            const normalizedFamily = normalizeText(family);

            if (!normalizedFamily) {
                throw new TypeError(
                    "A family ID or name is required."
                );
            }

            const result = await this.list({
                ...parameters,
                family: normalizedFamily
            }, options);

            const lower = normalizedFamily.toLowerCase();

            const records = result.records.filter(item =>
                item.family.toLowerCase() === lower ||
                item.family_id === normalizedFamily
            );

            return {
                ...result,
                family: normalizedFamily,
                records,
                summary: summarize(records)
            };
        }

        async byGenus(genus, parameters = {}, options = {}) {
            const normalizedGenus = normalizeText(genus);

            if (!normalizedGenus) {
                throw new TypeError(
                    "A genus ID or name is required."
                );
            }

            const result = await this.list({
                ...parameters,
                genus: normalizedGenus
            }, options);

            const lower = normalizedGenus.toLowerCase();

            const records = result.records.filter(item =>
                item.genera.some(child =>
                    child.id === normalizedGenus ||
                    child.scientific_name.toLowerCase() === lower
                )
            );

            return {
                ...result,
                genus: normalizedGenus,
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
                subtribes: record.subtribes,
                genera: record.genera,
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
                family: record.family,
                subfamily: record.subfamily,
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
                tribes: result.records
            };
        }

        status() {
            return {
                version: VERSION,
                endpoint: "taxa/tribes",
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
            existing instanceof TribesService &&
            !existing.destroyed
        ) {
            context.tribes = existing;
            return existing;
        }

        if (
            context.tribes instanceof TribesService &&
            !context.tribes.destroyed
        ) {
            return context.tribes;
        }

        const service = new TribesService(context);

        context.tribes = service;

        context.registerService?.(
            SERVICE_NAME,
            service
        );

        context.registerService?.(
            "taxa-tribes",
            service
        );

        dispatch(
            document,
            "speciedex:terminal-tribes-ready",
            {
                context,
                service
            }
        );

        return service;
    }

    function requireService(context) {
        const service = context?.tribes ||
            context?.services?.get?.(SERVICE_NAME);

        if (!(service instanceof TribesService)) {
            throw new Error("Tribes service is unavailable.");
        }

        return service;
    }

    function parseCommandArguments(args = []) {
        const parameters = {};
        const positional = [];

        const textFlags = {
            "--tribe=": "tribe",
            "--tribe-id=": "tribe_id",
            "--subtribe=": "subtribe",
            "--subtribe-id=": "subtribe_id",
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
            "--phylum=": "phylum",
            "--class=": "class",
            "--order=": "order",
            "--superfamily=": "superfamily",
            "--family=": "family",
            "--family-id=": "family_id",
            "--subfamily=": "subfamily",
            "--subfamily-id=": "subfamily_id",
            "--genus=": "genus",
            "--genus-id=": "genus_id",
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
            "--active=": "active"
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
            handler: async ({ args = [], context, writeJSON }) =>
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
            name: "tribes",
            aliases: [
                "taxa-tribes"
            ],
            category: "taxonomy",
            description:
                "Search taxonomic tribes.",
            usage:
                "tribes [query] [limit] [--tribe=NAME] [--subtribe=NAME] [--family=NAME] [--subfamily=NAME] [--genus=NAME] [--status=STATUS] [--provider=PROVIDER] [--source=SOURCE] [--accepted=true|false] [--synonym=true|false] [--deprecated=true|false] [--supported=true|false] [--verified=true|false] [--active=true|false] [--min-genera=N] [--max-genera=N] [--min-species=N] [--max-species=N] [--from=DATE] [--to=DATE] [--sort=FIELD] [--direction=asc|desc] [--offset=N]",
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
            name: "tribe",
            aliases: [
                "tribe-get"
            ],
            category: "taxonomy",
            description:
                "Retrieve one tribe or subtribe record by ID or name.",
            usage:
                "tribe <id|name>",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error(
                        "A tribe or subtribe ID or name is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).get(id)
                );
            }
        },
        {
            name: "tribes-by-family",
            aliases: [
                "family-tribes"
            ],
            category: "taxonomy",
            description:
                "List tribes belonging to one family.",
            usage:
                "tribes-by-family <family-id|family-name> [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                if (!args.length) {
                    throw new Error(
                        "A family ID or name is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).byFamily(
                        args[0],
                        parseCommandArguments(args.slice(1))
                    )
                );
            }
        },
        {
            name: "tribes-by-genus",
            aliases: [
                "genus-tribes"
            ],
            category: "taxonomy",
            description:
                "Find tribe records containing one genus.",
            usage:
                "tribes-by-genus <genus-id|genus-name> [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                if (!args.length) {
                    throw new Error(
                        "A genus ID or name is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).byGenus(
                        args[0],
                        parseCommandArguments(args.slice(1))
                    )
                );
            }
        },
        {
            name: "tribe-children",
            category: "taxonomy",
            description:
                "Show child subtribes and genera for one tribe.",
            usage:
                "tribe-children <id|name>",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error(
                        "A tribe ID or name is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).children(id)
                );
            }
        },
        {
            name: "tribe-lineage",
            category: "taxonomy",
            description:
                "Show normalized lineage for one tribe or subtribe.",
            usage:
                "tribe-lineage <id|name>",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error(
                        "A tribe or subtribe ID or name is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).lineage(id)
                );
            }
        },
        {
            name: "tribe-synonym-list",
            category: "taxonomy",
            description:
                "Show accepted-name and synonym information for one tribe.",
            usage:
                "tribe-synonym-list <id|name>",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error(
                        "A tribe ID or name is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).synonymList(id)
                );
            }
        },
        filteredCommand(
            "tribes-accepted",
            ["accepted-tribes"],
            "List accepted tribe records.",
            "accepted"
        ),
        filteredCommand(
            "tribes-synonyms",
            ["synonym-tribes"],
            "List synonym tribe records or records carrying synonym names.",
            "synonyms"
        ),
        filteredCommand(
            "tribes-deprecated",
            ["deprecated-tribes"],
            "List deprecated tribe records.",
            "deprecated"
        ),
        filteredCommand(
            "tribes-supported",
            ["supported-tribes"],
            "List supported tribe records.",
            "supported"
        ),
        {
            name: "tribes-summary",
            aliases: [
                "tribe-summary"
            ],
            category: "taxonomy",
            description:
                "Summarize tribes by family, subfamily, tribe, subtribe, status, provider, source, geography, genus count, and species count.",
            usage:
                "tribes-summary [filters]",
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
            name: "tribes-status",
            category: "taxonomy",
            description:
                "Show tribes service status.",
            usage:
                "tribes-status",
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
        TribesService,
        normalizeParameters,
        normalizeRecord,
        normalizeResponse,
        normalizeStringArray,
        normalizeTaxonomicStatus,
        normalizeSynonyms,
        normalizeChildren,
        normalizeLineage,
        findTribe,
        summarize,
        parseCommandArguments,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalTribes = api;

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
