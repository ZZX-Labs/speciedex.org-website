/*
========================================================================
Speciedex.org
Terminal Clades Module
========================================================================

Taxonomic clade search and hierarchy service for SpeciedexTerminal.

Provides:

    • Validated clade API requests
    • Name, parent, ancestor, descendant, lineage, rank, status,
      provider, source, geography, and date filters
    • Normalized clade records
    • Parent, child, ancestor, descendant, lineage, and synonym helpers
    • Accepted, synonym, deprecated, supported, monophyletic,
      paraphyletic, polyphyletic, active, and verified views
    • Rank, status, parent, provider, source, geography, and topology summaries
    • Lifecycle events, caching, and resilient service registration
    • Terminal command integration

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Clades";
    const VERSION = "2.0.0";
    const SERVICE_NAME = "clades";

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
            "parent_clade",
            "depth",
            "child_count",
            "descendant_count",
            "species_count",
            "provider",
            "updated_at",
            "created_at",
            "id"
        ]);

        if (!allowed.has(normalized)) {
            throw new TypeError(
                `Unsupported clades sort field: ${value}`
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
            "clade",
            "clade_id",
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
            "parent",
            "parent_id",
            "parent_clade",
            "parent_clade_id",
            "ancestor",
            "ancestor_id",
            "descendant",
            "descendant_id",
            "kingdom",
            "phylum",
            "class",
            "order",
            "family",
            "genus",
            "provider",
            "source",
            "license",
            "country",
            "region",
            "continent",
            "topology",
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
            "monophyletic",
            "paraphyletic",
            "polyphyletic",
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
            ["min_depth", source.min_depth ?? source.minDepth],
            ["max_depth", source.max_depth ?? source.maxDepth],
            ["min_children", source.min_children ?? source.minChildren],
            ["max_children", source.max_children ?? source.maxChildren],
            ["min_descendants", source.min_descendants ?? source.minDescendants],
            ["max_descendants", source.max_descendants ?? source.maxDescendants],
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
                ["min_depth", "max_depth", "depth"],
                ["min_children", "max_children", "child count"],
                ["min_descendants", "max_descendants", "descendant count"],
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
                "Clades start date must not be later than the end date."
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

    function normalizeRelations(value, fallbackRank = "clade") {
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
                                item.clade_id ??
                                item.cladeId ??
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
                            depth: Number.isFinite(Number(item.depth))
                                ? Number(item.depth)
                                : null,
                            index
                        };
                    }

                    return {
                        id: "",
                        rank: fallbackRank,
                        scientific_name: normalizeText(item),
                        status: "accepted",
                        depth: null,
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
            depth: null,
            index
        }));
    }

    function normalizeLineage(record) {
        const explicit = Array.isArray(record.lineage)
            ? record.lineage
            : (
                Array.isArray(record.ancestors)
                    ? record.ancestors
                    : (
                        Array.isArray(record.classification)
                            ? record.classification
                            : null
                    )
            );

        if (explicit) {
            return normalizeRelations(explicit, "clade");
        }

        const lineage = [];
        const values = [
            ["domain", record.domain],
            ["kingdom", record.kingdom],
            ["phylum", record.phylum],
            ["class", record.class ?? record.class_name ?? record.className],
            ["order", record.order ?? record.order_name ?? record.orderName],
            ["family", record.family],
            ["genus", record.genus],
            [
                normalizeKey(
                    record.rank ??
                    record.taxon_rank ??
                    record.taxonRank ??
                    "clade"
                ) || "clade",
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
                    depth: lineage.length,
                    index: lineage.length
                });
            }
        }

        return lineage;
    }

    function inferTopology(record, status) {
        const explicit = normalizeKey(
            record.topology ??
            record.clade_type ??
            record.cladeType ??
            ""
        );

        if (explicit) {
            return explicit;
        }

        if (record.monophyletic === true) {
            return "monophyletic";
        }

        if (record.paraphyletic === true) {
            return "paraphyletic";
        }

        if (record.polyphyletic === true) {
            return "polyphyletic";
        }

        if (status === "accepted") {
            return "monophyletic";
        }

        return "unknown";
    }

    function normalizeRecord(record, index = 0) {
        if (!record || typeof record !== "object") {
            const name = normalizeText(record);

            return {
                index,
                id: name || `clade-${index + 1}`,
                scientific_name: name,
                canonical_name: name,
                name,
                authorship: "",
                rank: "clade",
                status: "unknown",
                accepted: false,
                synonym: false,
                deprecated: false,
                supported: true,
                verified: false,
                active: true,
                topology: "unknown",
                monophyletic: false,
                paraphyletic: false,
                polyphyletic: false,
                parent_clade: "",
                parent_clade_id: "",
                root: true,
                leaf: true,
                depth: 0,
                child_count: 0,
                descendant_count: 0,
                species_count: 0,
                children: [],
                descendants: [],
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
            "clade"
        ) || "clade";

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

        const topology = inferTopology(record, status);
        const children = normalizeRelations(
            record.children ??
            record.child_clades ??
            record.childClades,
            "clade"
        );
        const descendants = normalizeRelations(
            record.descendants ??
            record.descendant_clades ??
            record.descendantClades,
            "clade"
        );

        const parentClade = normalizeText(
            record.parent_clade ??
            record.parentClade ??
            record.parent ??
            ""
        );

        const childCount = Number.isFinite(Number(
            record.child_count ??
            record.childCount
        ))
            ? Number(
                record.child_count ??
                record.childCount
            )
            : children.length;

        const descendantCount = Number.isFinite(Number(
            record.descendant_count ??
            record.descendantCount
        ))
            ? Number(
                record.descendant_count ??
                record.descendantCount
            )
            : descendants.length;

        return {
            ...record,
            index: record.index ?? index,
            id: normalizeText(
                record.id ??
                record.clade_id ??
                record.cladeId ??
                record.taxon_id ??
                record.taxonId ??
                record.uuid ??
                `clade-${index + 1}`
            ),
            clade_id: normalizeText(
                record.clade_id ??
                record.cladeId ??
                record.taxon_id ??
                record.taxonId ??
                record.id ??
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
            topology,
            monophyletic: topology === "monophyletic",
            paraphyletic: topology === "paraphyletic",
            polyphyletic: topology === "polyphyletic",
            parent_clade: parentClade,
            parent_clade_id: normalizeText(
                record.parent_clade_id ??
                record.parentCladeId ??
                record.parent_id ??
                record.parentId ??
                ""
            ),
            root:
                record.root === true ||
                record.is_root === true ||
                record.isRoot === true ||
                !parentClade,
            leaf:
                record.leaf === true ||
                record.is_leaf === true ||
                record.isLeaf === true ||
                childCount === 0,
            depth: Number.isFinite(Number(
                record.depth ??
                record.level
            ))
                ? Number(
                    record.depth ??
                    record.level
                )
                : 0,
            child_count: childCount,
            descendant_count: descendantCount,
            species_count: Number.isFinite(Number(
                record.species_count ??
                record.speciesCount
            ))
                ? Number(
                    record.species_count ??
                    record.speciesCount
                )
                : 0,
            children,
            descendants,
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
            family: normalizeText(record.family ?? ""),
            genus: normalizeText(record.genus ?? ""),
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
            topologies: new Map(),
            parents: new Map(),
            kingdoms: new Map(),
            phyla: new Map(),
            classes: new Map(),
            orders: new Map(),
            families: new Map(),
            genera: new Map(),
            providers: new Map(),
            sources: new Map(),
            countries: new Map(),
            regions: new Map(),
            continents: new Map(),
            categories: new Map(),
            types: new Map()
        };

        let childCount = 0;
        let descendantCount = 0;
        let speciesCount = 0;
        let synonymCount = 0;

        for (const item of values) {
            incrementMap(maps.ranks, item.rank);
            incrementMap(maps.statuses, item.status);
            incrementMap(maps.topologies, item.topology);
            incrementMap(maps.parents, item.parent_clade);
            incrementMap(maps.kingdoms, item.kingdom);
            incrementMap(maps.phyla, item.phylum);
            incrementMap(maps.classes, item.class);
            incrementMap(maps.orders, item.order);
            incrementMap(maps.families, item.family);
            incrementMap(maps.genera, item.genus);
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

            childCount += item.child_count || 0;
            descendantCount += item.descendant_count || 0;
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
            monophyletic: values.filter(item => item.monophyletic).length,
            paraphyletic: values.filter(item => item.paraphyletic).length,
            polyphyletic: values.filter(item => item.polyphyletic).length,
            children: childCount,
            descendants: descendantCount,
            species: speciesCount,
            ranks: mapToSortedObject(maps.ranks),
            statuses: mapToSortedObject(maps.statuses),
            topologies: mapToSortedObject(maps.topologies),
            parents: mapToSortedObject(maps.parents),
            kingdoms: mapToSortedObject(maps.kingdoms),
            phyla: mapToSortedObject(maps.phyla),
            classes: mapToSortedObject(maps.classes),
            orders: mapToSortedObject(maps.orders),
            families: mapToSortedObject(maps.families),
            genera: mapToSortedObject(maps.genera),
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
                            Array.isArray(payload.clades)
                                ? payload.clades
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

    function findClade(records, value) {
        const target = normalizeText(value);
        const lower = target.toLowerCase();

        return records.find(item =>
            item.id === target ||
            item.clade_id === target ||
            item.scientific_name.toLowerCase() === lower ||
            item.canonical_name.toLowerCase() === lower ||
            item.name.toLowerCase() === lower
        ) || null;
    }

    function buildHierarchy(records) {
        const nodes = new Map(
            records.map(item => [
                item.id || item.clade_id || item.scientific_name,
                {
                    ...item,
                    children: []
                }
            ])
        );

        const byName = new Map(
            [...nodes.values()].map(item => [
                item.scientific_name.toLowerCase(),
                item
            ])
        );

        const roots = [];

        for (const node of nodes.values()) {
            const parent =
                (
                    node.parent_clade_id &&
                    nodes.get(node.parent_clade_id)
                ) ||
                (
                    node.parent_clade &&
                    byName.get(node.parent_clade.toLowerCase())
                ) ||
                null;

            if (parent) {
                parent.children.push(node);
            } else {
                roots.push(node);
            }
        }

        return {
            roots,
            nodes: Object.fromEntries(nodes)
        };
    }

    class CladesService extends EventTarget {
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
                    "Clades service has been destroyed."
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
                    `clades:${name}`,
                    detail
                );
            } catch (_error) {
                /*
                Observer failures must not break clade operations.
                */
            }

            dispatch(
                this.context.root,
                `speciedex:terminal-clades-${name}`,
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
                    "taxa/clades",
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
                    "A clade ID or name is required."
                );
            }

            try {
                const payload = await this.context.api.get(
                    `taxa/clades/${encodeURIComponent(normalizedId)}`,
                    {},
                    options
                );

                return normalizeRecord(payload, 0);
            } catch (error) {
                const match = findClade(
                    this.cache?.records || [],
                    normalizedId
                );

                if (match) {
                    return match;
                }

                throw error;
            }
        }

        async children(id, parameters = {}, options = {}) {
            const normalizedId = normalizeText(id);

            if (!normalizedId) {
                throw new TypeError(
                    "A parent clade ID or name is required."
                );
            }

            const result = await this.list({
                ...parameters,
                parent: normalizedId
            }, options);

            const lower = normalizedId.toLowerCase();

            const records = result.records.filter(item =>
                item.parent_clade_id === normalizedId ||
                item.parent_clade.toLowerCase() === lower
            );

            return {
                ...result,
                parent: normalizedId,
                records,
                summary: summarize(records)
            };
        }

        async descendants(id, parameters = {}, options = {}) {
            const normalizedId = normalizeText(id);

            if (!normalizedId) {
                throw new TypeError(
                    "A clade ID or name is required."
                );
            }

            const record = await this.get(normalizedId, options);

            if (record.descendants.length) {
                return {
                    id: record.id,
                    scientific_name: record.scientific_name,
                    descendants: record.descendants,
                    descendant_count: record.descendant_count
                };
            }

            const result = await this.list({
                ...parameters,
                ancestor: normalizedId,
                limit: parameters.limit ?? MAX_LIMIT
            }, options);

            return {
                id: record.id,
                scientific_name: record.scientific_name,
                descendants: result.records,
                descendant_count: result.records.length
            };
        }

        async lineage(id, options = {}) {
            const record = await this.get(id, options);

            return {
                id: record.id,
                scientific_name: record.scientific_name,
                rank: record.rank,
                parent_clade: record.parent_clade,
                parent_clade_id: record.parent_clade_id,
                lineage: record.lineage
            };
        }

        async hierarchy(parameters = {}, options = {}) {
            const result = await this.list({
                ...parameters,
                limit: parameters.limit ?? MAX_LIMIT
            }, options);

            return {
                parameters: result.parameters,
                hierarchy: buildHierarchy(result.records),
                summary: summarize(result.records)
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

        monophyletic(parameters = {}, options = {}) {
            return this.filtered("monophyletic", parameters, options);
        }

        paraphyletic(parameters = {}, options = {}) {
            return this.filtered("paraphyletic", parameters, options);
        }

        polyphyletic(parameters = {}, options = {}) {
            return this.filtered("polyphyletic", parameters, options);
        }

        async summary(parameters = {}, options = {}) {
            const result = await this.list({
                ...parameters,
                limit: parameters.limit ?? MAX_LIMIT
            }, options);

            return {
                parameters: result.parameters,
                summary: summarize(result.records),
                clades: result.records
            };
        }

        status() {
            return {
                version: VERSION,
                endpoint: "taxa/clades",
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
            existing instanceof CladesService &&
            !existing.destroyed
        ) {
            context.clades = existing;
            return existing;
        }

        if (
            context.clades instanceof CladesService &&
            !context.clades.destroyed
        ) {
            return context.clades;
        }

        const service = new CladesService(context);

        context.clades = service;

        context.registerService?.(
            SERVICE_NAME,
            service
        );

        context.registerService?.(
            "taxa-clades",
            service
        );

        dispatch(
            document,
            "speciedex:terminal-clades-ready",
            {
                context,
                service
            }
        );

        return service;
    }

    function requireService(context) {
        const service =
            context?.clades ||
            context?.services?.get?.(SERVICE_NAME);

        if (!(service instanceof CladesService)) {
            throw new Error(
                "Clades service is unavailable."
            );
        }

        return service;
    }

    function parseCommandArguments(args = []) {
        const parameters = {};
        const positional = [];

        const textFlags = {
            "--clade=": "clade",
            "--clade-id=": "clade_id",
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
            "--parent=": "parent",
            "--parent-id=": "parent_id",
            "--parent-clade=": "parent_clade",
            "--parent-clade-id=": "parent_clade_id",
            "--ancestor=": "ancestor",
            "--ancestor-id=": "ancestor_id",
            "--descendant=": "descendant",
            "--descendant-id=": "descendant_id",
            "--kingdom=": "kingdom",
            "--phylum=": "phylum",
            "--class=": "class",
            "--order=": "order",
            "--family=": "family",
            "--genus=": "genus",
            "--provider=": "provider",
            "--source=": "source",
            "--license=": "license",
            "--country=": "country",
            "--region=": "region",
            "--continent=": "continent",
            "--topology=": "topology",
            "--category=": "category",
            "--type=": "type",
            "--from=": "from",
            "--to=": "to",
            "--sort=": "sort",
            "--direction=": "direction",
            "--limit=": "limit",
            "--offset=": "offset",
            "--min-depth=": "min_depth",
            "--max-depth=": "max_depth",
            "--min-children=": "min_children",
            "--max-children=": "max_children",
            "--min-descendants=": "min_descendants",
            "--max-descendants=": "max_descendants",
            "--min-species=": "min_species",
            "--max-species=": "max_species"
        };

        const booleanFlags = {
            "--accepted=": "accepted",
            "--synonym=": "synonym",
            "--deprecated=": "deprecated",
            "--supported=": "supported",
            "--monophyletic=": "monophyletic",
            "--paraphyletic=": "paraphyletic",
            "--polyphyletic=": "polyphyletic",
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
            name: "clades",
            aliases: [
                "taxa-clades"
            ],
            category: "taxonomy",
            description:
                "Search taxonomic clades.",
            usage:
                "clades [query] [limit] [--parent-clade=NAME] [--ancestor=NAME] [--descendant=NAME] [--rank=RANK] [--status=STATUS] [--topology=TYPE] [--provider=PROVIDER] [--accepted=true|false] [--synonym=true|false] [--deprecated=true|false] [--supported=true|false] [--monophyletic=true|false] [--paraphyletic=true|false] [--polyphyletic=true|false] [--root=true|false] [--leaf=true|false] [--min-depth=N] [--max-depth=N] [--min-children=N] [--max-children=N] [--min-descendants=N] [--max-descendants=N] [--min-species=N] [--max-species=N] [--from=DATE] [--to=DATE] [--sort=FIELD] [--direction=asc|desc] [--offset=N]",
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
            name: "clade",
            aliases: [
                "clade-get"
            ],
            category: "taxonomy",
            description:
                "Retrieve one clade by ID or name.",
            usage:
                "clade <id|name>",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error(
                        "A clade ID or name is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).get(id)
                );
            }
        },
        {
            name: "clade-children",
            category: "taxonomy",
            description:
                "List direct child clades.",
            usage:
                "clade-children <id|name> [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                if (!args.length) {
                    throw new Error(
                        "A parent clade ID or name is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).children(
                        args[0],
                        parseCommandArguments(args.slice(1))
                    )
                );
            }
        },
        {
            name: "clade-descendants",
            category: "taxonomy",
            description:
                "List all known descendant clades.",
            usage:
                "clade-descendants <id|name> [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                if (!args.length) {
                    throw new Error(
                        "A clade ID or name is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).descendants(
                        args[0],
                        parseCommandArguments(args.slice(1))
                    )
                );
            }
        },
        {
            name: "clade-lineage",
            category: "taxonomy",
            description:
                "Show normalized ancestor lineage for one clade.",
            usage:
                "clade-lineage <id|name>",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error(
                        "A clade ID or name is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).lineage(id)
                );
            }
        },
        {
            name: "clades-hierarchy",
            aliases: [
                "clade-hierarchy"
            ],
            category: "taxonomy",
            description:
                "Build the parent-child clade hierarchy.",
            usage:
                "clades-hierarchy [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).hierarchy(
                        parseCommandArguments(args)
                    )
                )
        },
        {
            name: "clade-synonym-list",
            category: "taxonomy",
            description:
                "Show accepted-name and synonym information for one clade.",
            usage:
                "clade-synonym-list <id|name>",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error(
                        "A clade ID or name is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).synonymList(id)
                );
            }
        },
        filteredCommand(
            "clades-accepted",
            ["accepted-clades"],
            "List accepted clade records.",
            "accepted"
        ),
        filteredCommand(
            "clades-synonyms",
            ["synonym-clades"],
            "List synonym clades or records carrying synonym names.",
            "synonyms"
        ),
        filteredCommand(
            "clades-deprecated",
            ["deprecated-clades"],
            "List deprecated clade records.",
            "deprecated"
        ),
        filteredCommand(
            "clades-supported",
            ["supported-clades"],
            "List supported clade records.",
            "supported"
        ),
        filteredCommand(
            "clades-monophyletic",
            ["monophyletic-clades"],
            "List monophyletic clades.",
            "monophyletic"
        ),
        filteredCommand(
            "clades-paraphyletic",
            ["paraphyletic-clades"],
            "List paraphyletic clades.",
            "paraphyletic"
        ),
        filteredCommand(
            "clades-polyphyletic",
            ["polyphyletic-clades"],
            "List polyphyletic clades.",
            "polyphyletic"
        ),
        {
            name: "clades-summary",
            aliases: [
                "clade-summary"
            ],
            category: "taxonomy",
            description:
                "Summarize clades by rank, status, topology, parent, lineage, provider, source, geography, child count, descendant count, and species count.",
            usage:
                "clades-summary [filters]",
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
            name: "clades-status",
            category: "taxonomy",
            description:
                "Show clades service status.",
            usage:
                "clades-status",
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
        CladesService,
        normalizeParameters,
        normalizeRecord,
        normalizeResponse,
        normalizeStringArray,
        normalizeTaxonomicStatus,
        normalizeSynonyms,
        normalizeRelations,
        normalizeLineage,
        inferTopology,
        findClade,
        buildHierarchy,
        summarize,
        parseCommandArguments,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalClades = api;

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
