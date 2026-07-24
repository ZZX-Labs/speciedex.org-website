/*
========================================================================
Speciedex.org
Terminal Genera Module
========================================================================

Taxonomic genus and subgenus search service for SpeciedexTerminal.

Provides validated API requests, normalized genus records, parent-family
resolution, child-species helpers, lineage and synonym handling, status
views, summaries, caching, lifecycle events, resilient service registration,
and terminal command integration.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Genera";
    const VERSION = "2.0.0";
    const SERVICE_NAME = "genera";
    const DEFAULT_LIMIT = 50;
    const MAX_LIMIT = 1000;

    function emit(target, name, detail, options = {}) {
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

    function text(value) {
        return String(value ?? "").trim();
    }

    function key(value) {
        return text(value)
            .toLowerCase()
            .replace(/[\s-]+/g, "_")
            .replace(/[^a-z0-9_]/g, "");
    }

    function integer(value, fallback, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
        const parsed = Number.parseInt(value, 10);

        return Number.isFinite(parsed)
            ? Math.min(maximum, Math.max(minimum, parsed))
            : fallback;
    }

    function number(value, fallback = 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function boolean(value, fallback = null) {
        if (typeof value === "boolean") {
            return value;
        }

        const normalized = text(value).toLowerCase();

        if (value === 1 || normalized === "1" || normalized === "true") {
            return true;
        }

        if (value === 0 || normalized === "0" || normalized === "false") {
            return false;
        }

        return fallback;
    }

    function isoDate(value) {
        const normalized = text(value);

        if (!normalized) {
            return "";
        }

        const timestamp = Date.parse(normalized);

        if (!Number.isFinite(timestamp)) {
            throw new TypeError(`Invalid date value: ${value}`);
        }

        return new Date(timestamp).toISOString();
    }

    function stringArray(value) {
        const values = Array.isArray(value)
            ? value
            : text(value).split(/[;,|]+/);

        return [...new Set(values.map(text).filter(Boolean))];
    }

    function taxonomicStatus(value) {
        const normalized = key(value || "unknown");

        return {
            valid: "accepted",
            current: "accepted",
            synonymized: "synonym",
            unaccepted: "synonym",
            uncertain: "unresolved",
            ambiguous: "unresolved",
            deleted: "inactive"
        }[normalized] || normalized;
    }

    function sortField(value) {
        const normalized = key(value || "scientific_name");
        const allowed = new Set([
            "scientific_name",
            "canonical_name",
            "name",
            "rank",
            "status",
            "family",
            "subfamily",
            "tribe",
            "genus",
            "subgenus",
            "species_count",
            "subspecies_count",
            "provider",
            "updated_at",
            "created_at",
            "id"
        ]);

        if (!allowed.has(normalized)) {
            throw new TypeError(`Unsupported genera sort field: ${value}`);
        }

        return normalized;
    }

    function direction(value) {
        const normalized = text(value || "asc").toLowerCase();

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
            q: text(source.q ?? source.query ?? ""),
            limit: integer(source.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
            offset: integer(source.offset, 0),
            sort: sortField(source.sort),
            direction: direction(source.direction ?? source.order)
        };

        const textFields = [
            "genus", "genus_id", "subgenus", "subgenus_id", "taxon",
            "taxon_id", "scientific_name", "canonical_name", "name",
            "authorship", "rank", "status", "accepted_name", "accepted_id",
            "domain", "kingdom", "phylum", "class", "order", "family",
            "family_id", "subfamily", "subfamily_id", "tribe", "tribe_id",
            "species", "species_id", "provider", "source", "license",
            "country", "region", "continent", "category", "type"
        ];

        for (const field of textFields) {
            if (source[field] !== undefined && source[field] !== null && source[field] !== "") {
                normalized[field] = text(source[field]);
            }
        }

        const booleanFields = [
            "accepted", "synonym", "deprecated", "supported",
            "verified", "active", "root", "leaf"
        ];

        for (const field of booleanFields) {
            if (source[field] !== undefined && source[field] !== null && source[field] !== "") {
                const parsed = boolean(source[field]);

                if (parsed === null) {
                    throw new TypeError(`Invalid ${field} value: ${source[field]}`);
                }

                normalized[field] = parsed;
            }
        }

        const ranges = [
            ["min_species", "max_species", source.min_species ?? source.minSpecies, source.max_species ?? source.maxSpecies, "species count"],
            ["min_subspecies", "max_subspecies", source.min_subspecies ?? source.minSubspecies, source.max_subspecies ?? source.maxSubspecies, "subspecies count"]
        ];

        for (const [minimumKey, maximumKey, minimumValue, maximumValue, label] of ranges) {
            if (minimumValue !== undefined && minimumValue !== null && minimumValue !== "") {
                normalized[minimumKey] = integer(minimumValue, 0);
            }

            if (maximumValue !== undefined && maximumValue !== null && maximumValue !== "") {
                normalized[maximumKey] = integer(maximumValue, Number.MAX_SAFE_INTEGER);
            }

            if (
                normalized[minimumKey] !== undefined &&
                normalized[maximumKey] !== undefined &&
                normalized[minimumKey] > normalized[maximumKey]
            ) {
                throw new RangeError(`Minimum ${label} must not exceed maximum ${label}.`);
            }
        }

        const from = source.from ?? source.since ?? source.start;
        const to = source.to ?? source.until ?? source.end;

        if (from !== undefined && from !== null && from !== "") {
            normalized.from = isoDate(from);
        }

        if (to !== undefined && to !== null && to !== "") {
            normalized.to = isoDate(to);
        }

        if (
            normalized.from &&
            normalized.to &&
            Date.parse(normalized.from) > Date.parse(normalized.to)
        ) {
            throw new RangeError(
                "Genera start date must not be later than the end date."
            );
        }

        return normalized;
    }

    function normalizeRelations(value, fallbackRank) {
        const values = Array.isArray(value)
            ? value
            : stringArray(value);

        return values.map((item, index) => {
            if (item && typeof item === "object") {
                return {
                    id: text(item.id ?? item.taxon_id ?? item.taxonId ?? ""),
                    rank: key(item.rank ?? item.taxon_rank ?? item.taxonRank ?? fallbackRank),
                    scientific_name: text(item.scientific_name ?? item.scientificName ?? item.name ?? ""),
                    authorship: text(
                        item.authorship ??
                        item.scientific_name_authorship ??
                        item.scientificNameAuthorship ??
                        ""
                    ),
                    status: taxonomicStatus(item.status ?? "accepted"),
                    source: text(item.source ?? ""),
                    index
                };
            }

            return {
                id: "",
                rank: fallbackRank,
                scientific_name: text(item),
                authorship: "",
                status: "accepted",
                source: "",
                index
            };
        }).filter(item => item.scientific_name);
    }

    function normalizeLineage(record) {
        if (Array.isArray(record.lineage)) {
            return normalizeRelations(record.lineage, "genus");
        }

        const lineage = [];
        const levels = [
            ["domain", record.domain],
            ["kingdom", record.kingdom],
            ["phylum", record.phylum],
            ["class", record.class ?? record.class_name ?? record.className],
            ["order", record.order ?? record.order_name ?? record.orderName],
            ["family", record.family],
            ["subfamily", record.subfamily],
            ["tribe", record.tribe],
            [key(record.rank ?? "genus") || "genus", record.scientific_name ?? record.scientificName ?? record.name]
        ];

        for (const [rank, value] of levels) {
            const name = text(value);

            if (name) {
                lineage.push({
                    id: "",
                    rank,
                    scientific_name: name,
                    authorship: "",
                    status: "accepted",
                    source: "",
                    index: lineage.length
                });
            }
        }

        return lineage;
    }

    function normalizeRecord(record, index = 0) {
        if (!record || typeof record !== "object") {
            record = { scientific_name: text(record) };
        }

        const scientificName = text(
            record.scientific_name ??
            record.scientificName ??
            record.name ??
            record.canonical_name ??
            record.canonicalName ??
            record.genus ??
            ""
        );

        const rank = key(
            record.rank ??
            record.taxon_rank ??
            record.taxonRank ??
            (record.subgenus ? "subgenus" : "genus")
        ) || "genus";

        const status = taxonomicStatus(
            record.status ??
            record.taxonomic_status ??
            record.taxonomicStatus ??
            record.acceptance_status ??
            record.acceptanceStatus
        );

        const species = normalizeRelations(
            record.species ??
            record.child_species ??
            record.childSpecies,
            "species"
        );

        const subgenera = normalizeRelations(
            record.subgenera ??
            record.child_subgenera ??
            record.childSubgenera,
            "subgenus"
        );

        const speciesCount = number(
            record.species_count ??
            record.speciesCount,
            species.length
        );

        const parentGenus = text(
            record.parent_genus ??
            record.parentGenus ??
            record.parent ??
            ""
        );

        return {
            ...record,
            index: record.index ?? index,
            id: text(
                record.id ??
                record.genus_id ??
                record.genusId ??
                record.subgenus_id ??
                record.subgenusId ??
                record.taxon_id ??
                record.taxonId ??
                record.uuid ??
                `genus-${index + 1}`
            ),
            genus_id: text(
                record.genus_id ??
                record.genusId ??
                record.taxon_id ??
                record.taxonId ??
                record.id ??
                ""
            ),
            subgenus_id: text(
                record.subgenus_id ??
                record.subgenusId ??
                ""
            ),
            scientific_name: scientificName,
            canonical_name: text(
                record.canonical_name ??
                record.canonicalName ??
                record.canonical ??
                scientificName
            ),
            name: text(record.name ?? scientificName),
            authorship: text(
                record.authorship ??
                record.scientific_name_authorship ??
                record.scientificNameAuthorship ??
                ""
            ),
            rank,
            status,
            accepted: record.accepted === true ||
                ["accepted", "valid"].includes(status),
            synonym: record.synonym === true ||
                record.is_synonym === true ||
                record.isSynonym === true ||
                status === "synonym",
            deprecated: record.deprecated === true ||
                status === "deprecated",
            supported: record.supported !== false &&
                !["unsupported", "disabled"].includes(status),
            verified: record.verified === true ||
                ["verified", "confirmed"].includes(
                    key(
                        record.verification_status ??
                        record.verificationStatus
                    )
                ),
            active: record.active !== false &&
                record.deleted !== true &&
                !["inactive", "deleted", "retired"].includes(status),
            accepted_name: text(
                record.accepted_name ??
                record.acceptedName ??
                ""
            ),
            accepted_id: text(
                record.accepted_id ??
                record.acceptedId ??
                record.accepted_taxon_id ??
                record.acceptedTaxonId ??
                ""
            ),
            domain: text(record.domain ?? ""),
            kingdom: text(record.kingdom ?? ""),
            phylum: text(record.phylum ?? ""),
            class: text(
                record.class ??
                record.class_name ??
                record.className ??
                ""
            ),
            order: text(
                record.order ??
                record.order_name ??
                record.orderName ??
                ""
            ),
            family: text(record.family ?? ""),
            family_id: text(
                record.family_id ??
                record.familyId ??
                ""
            ),
            subfamily: text(record.subfamily ?? ""),
            subfamily_id: text(
                record.subfamily_id ??
                record.subfamilyId ??
                ""
            ),
            tribe: text(record.tribe ?? ""),
            tribe_id: text(
                record.tribe_id ??
                record.tribeId ??
                ""
            ),
            genus: text(
                record.genus ??
                (rank === "genus" ? scientificName : "")
            ),
            subgenus: text(
                record.subgenus ??
                (rank === "subgenus" ? scientificName : "")
            ),
            parent_genus: parentGenus,
            parent_genus_id: text(
                record.parent_genus_id ??
                record.parentGenusId ??
                record.parent_id ??
                record.parentId ??
                ""
            ),
            root: record.root === true ||
                record.is_root === true ||
                record.isRoot === true ||
                !parentGenus,
            leaf: record.leaf === true ||
                record.is_leaf === true ||
                record.isLeaf === true ||
                (speciesCount === 0 && subgenera.length === 0),
            species,
            subgenera,
            species_count: speciesCount,
            subspecies_count: number(
                record.subspecies_count ??
                record.subspeciesCount
            ),
            synonyms: normalizeRelations(
                record.synonyms ??
                record.synonym_names ??
                record.synonymNames,
                "genus"
            ),
            lineage: normalizeLineage({
                ...record,
                scientific_name: scientificName,
                rank
            }),
            provider: text(
                record.provider ??
                record.provider_name ??
                record.providerName ??
                ""
            ),
            providers: stringArray(record.providers ?? record.provider),
            source: text(
                record.source ??
                record.source_name ??
                record.sourceName ??
                ""
            ),
            sources: stringArray(record.sources ?? record.source),
            license: text(record.license ?? record.licence ?? ""),
            countries: stringArray(
                record.countries ??
                record.country_codes ??
                record.countryCodes ??
                record.country
            ),
            regions: stringArray(record.regions ?? record.region),
            continents: stringArray(record.continents ?? record.continent),
            category: text(record.category ?? ""),
            type: text(record.type ?? ""),
            created_at: record.created_at ?? record.createdAt ?? "",
            updated_at:
                record.updated_at ??
                record.updatedAt ??
                record.last_updated ??
                record.lastUpdated ??
                ""
        };
    }

    function increment(map, value) {
        const normalized = text(value) || "unknown";
        map.set(normalized, (map.get(normalized) || 0) + 1);
    }

    function sortedObject(map) {
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
        const maps = Object.fromEntries(
            [
                "ranks", "statuses", "families", "subfamilies", "tribes",
                "genera", "subgenera", "species", "providers", "sources",
                "countries", "regions", "continents", "categories", "types"
            ].map(name => [name, new Map()])
        );

        let speciesCount = 0;
        let subspeciesCount = 0;
        let synonymCount = 0;

        for (const item of values) {
            increment(maps.ranks, item.rank);
            increment(maps.statuses, item.status);
            increment(maps.families, item.family);
            increment(maps.subfamilies, item.subfamily);
            increment(maps.tribes, item.tribe);
            increment(maps.genera, item.genus);
            increment(maps.subgenera, item.subgenus);
            increment(maps.providers, item.provider);
            increment(maps.sources, item.source);
            increment(maps.categories, item.category);
            increment(maps.types, item.type);

            item.species.forEach(value => increment(maps.species, value.scientific_name));
            item.countries.forEach(value => increment(maps.countries, value));
            item.regions.forEach(value => increment(maps.regions, value));
            item.continents.forEach(value => increment(maps.continents, value));

            speciesCount += item.species_count;
            subspeciesCount += item.subspecies_count;
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
            species: speciesCount,
            subspecies: subspeciesCount,
            ranks: sortedObject(maps.ranks),
            statuses: sortedObject(maps.statuses),
            families: sortedObject(maps.families),
            subfamilies: sortedObject(maps.subfamilies),
            tribes: sortedObject(maps.tribes),
            genera: sortedObject(maps.genera),
            subgenera: sortedObject(maps.subgenera),
            childSpecies: sortedObject(maps.species),
            providers: sortedObject(maps.providers),
            sources: sortedObject(maps.sources),
            countries: sortedObject(maps.countries),
            regions: sortedObject(maps.regions),
            continents: sortedObject(maps.continents),
            categories: sortedObject(maps.categories),
            types: sortedObject(maps.types)
        };
    }

    function normalizeResponse(payload) {
        const source = Array.isArray(payload)
            ? payload
            : (
                payload && typeof payload === "object"
                    ? (
                        Array.isArray(payload.records)
                            ? payload.records
                            : (
                                Array.isArray(payload.items)
                                    ? payload.items
                                    : (
                                        Array.isArray(payload.genera)
                                            ? payload.genera
                                            : (
                                                Array.isArray(payload.taxa)
                                                    ? payload.taxa
                                                    : []
                                            )
                                    )
                            )
                    )
                    : []
            );

        const records = source.map(normalizeRecord);

        return {
            records,
            total: Number.isFinite(Number(payload?.total))
                ? Number(payload.total)
                : records.length,
            limit: Number.isFinite(Number(payload?.limit))
                ? Number(payload.limit)
                : records.length,
            offset: Number.isFinite(Number(payload?.offset))
                ? Number(payload.offset)
                : 0,
            summary: payload?.summary && typeof payload.summary === "object"
                ? { ...summarize(records), ...payload.summary }
                : summarize(records),
            next: payload?.next ?? payload?.nextPage ?? null,
            previous: payload?.previous ?? payload?.previousPage ?? null,
            raw: payload
        };
    }

    function findGenus(records, value) {
        const target = text(value);
        const lower = target.toLowerCase();

        return records.find(item =>
            item.id === target ||
            item.genus_id === target ||
            item.subgenus_id === target ||
            item.scientific_name.toLowerCase() === lower ||
            item.canonical_name.toLowerCase() === lower ||
            item.name.toLowerCase() === lower
        ) || null;
    }

    class GeneraService extends EventTarget {
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
                throw new Error("Genera service has been destroyed.");
            }

            if (!this.context.api || typeof this.context.api.get !== "function") {
                throw new Error("Speciedex API client is unavailable.");
            }
        }

        dispatch(name, detail) {
            emit(this, name, detail);

            try {
                this.context.events?.emit?.(`genera:${name}`, detail);
            } catch (_error) {
                /* Observer failures must not interrupt genus operations. */
            }

            emit(
                this.context.root,
                `speciedex:terminal-genera-${name}`,
                detail,
                { bubbles: true }
            );
        }

        async list(parameters = {}, options = {}) {
            this.ensureAvailable();

            const normalized = normalizeParameters(parameters);
            const startedAt = performance.now();

            this.dispatch("request", {
                operation: "list",
                parameters: normalized
            });

            try {
                const payload = await this.context.api.get(
                    "taxa/genera",
                    normalized,
                    options
                );

                const result = normalizeResponse(payload);
                result.parameters = normalized;
                result.duration = performance.now() - startedAt;

                this.cache = result;
                this.cacheTimestamp = Date.now();

                this.dispatch("complete", result);
                return result;
            } catch (error) {
                this.dispatch("error", {
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

            const normalizedId = text(id);

            if (!normalizedId) {
                throw new TypeError("A genus or subgenus ID or name is required.");
            }

            try {
                const payload = await this.context.api.get(
                    `taxa/genera/${encodeURIComponent(normalizedId)}`,
                    {},
                    options
                );

                return normalizeRecord(payload, 0);
            } catch (error) {
                const match = findGenus(this.cache?.records || [], normalizedId);

                if (match) {
                    return match;
                }

                throw error;
            }
        }

        async byFamily(family, parameters = {}, options = {}) {
            const normalizedFamily = text(family);

            if (!normalizedFamily) {
                throw new TypeError("A family ID or name is required.");
            }

            const result = await this.list({
                ...parameters,
                family: normalizedFamily
            }, options);

            const lower = normalizedFamily.toLowerCase();
            const records = result.records.filter(item =>
                item.family_id === normalizedFamily ||
                item.family.toLowerCase() === lower
            );

            return {
                ...result,
                family: normalizedFamily,
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
                subgenera: record.subgenera,
                species: record.species,
                species_count: record.species_count,
                subspecies_count: record.subspecies_count
            };
        }

        async lineage(id, options = {}) {
            const record = await this.get(id, options);

            return {
                id: record.id,
                scientific_name: record.scientific_name,
                rank: record.rank,
                family: record.family,
                family_id: record.family_id,
                subfamily: record.subfamily,
                tribe: record.tribe,
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

            const records = result.records.filter(item =>
                flag === "synonym"
                    ? item.synonym || item.synonyms.length > 0
                    : Boolean(item[flag])
            );

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
                genera: result.records
            };
        }

        status() {
            return {
                version: VERSION,
                endpoint: "taxa/genera",
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

            emit(this, "destroy", {
                timestamp: new Date().toISOString()
            });

            return true;
        }
    }

    function initialize(context) {
        const existing = context.services?.get?.(SERVICE_NAME);

        if (existing instanceof GeneraService && !existing.destroyed) {
            context.genera = existing;
            return existing;
        }

        if (
            context.genera instanceof GeneraService &&
            !context.genera.destroyed
        ) {
            return context.genera;
        }

        const service = new GeneraService(context);

        context.genera = service;
        context.registerService?.(SERVICE_NAME, service);
        context.registerService?.("taxa-genera", service);

        emit(document, "speciedex:terminal-genera-ready", {
            context,
            service
        });

        return service;
    }

    function requireService(context) {
        const service =
            context?.genera ||
            context?.services?.get?.(SERVICE_NAME);

        if (!(service instanceof GeneraService)) {
            throw new Error("Genera service is unavailable.");
        }

        return service;
    }

    function parseCommandArguments(args = []) {
        const parameters = {};
        const positional = [];

        const flags = {
            "--genus=": "genus",
            "--genus-id=": "genus_id",
            "--subgenus=": "subgenus",
            "--subgenus-id=": "subgenus_id",
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
            "--class=": "class",
            "--order=": "order",
            "--family=": "family",
            "--family-id=": "family_id",
            "--subfamily=": "subfamily",
            "--subfamily-id=": "subfamily_id",
            "--tribe=": "tribe",
            "--tribe-id=": "tribe_id",
            "--species=": "species",
            "--species-id=": "species_id",
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
            "--min-species=": "min_species",
            "--max-species=": "max_species",
            "--min-subspecies=": "min_subspecies",
            "--max-subspecies=": "max_subspecies",
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
            const match = Object.entries(flags).find(
                ([flag]) => argument.startsWith(flag)
            );

            if (match) {
                parameters[match[1]] = argument.slice(match[0].length);
            } else if (!argument.startsWith("--")) {
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
            name: "genera",
            aliases: ["taxa-genera"],
            category: "taxonomy",
            description: "Search taxonomic genera.",
            usage:
                "genera [query] [limit] [--genus=NAME] [--subgenus=NAME] [--family=NAME] [--subfamily=NAME] [--tribe=NAME] [--species=NAME] [--rank=RANK] [--status=STATUS] [--provider=PROVIDER] [--accepted=true|false] [--synonym=true|false] [--deprecated=true|false] [--supported=true|false] [--verified=true|false] [--active=true|false] [--root=true|false] [--leaf=true|false] [--min-species=N] [--max-species=N] [--min-subspecies=N] [--max-subspecies=N] [--from=DATE] [--to=DATE] [--sort=FIELD] [--direction=asc|desc] [--offset=N]",
            handler: async ({ args = [], context, writeJSON }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).list(
                        parseCommandArguments(args)
                    )
                )
        },
        {
            name: "genus",
            aliases: ["genus-get"],
            category: "taxonomy",
            description: "Retrieve one genus or subgenus by ID or name.",
            usage: "genus <id|name>",
            handler: async ({ args = [], context, writeJSON }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error("A genus or subgenus ID or name is required.");
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).get(id)
                );
            }
        },
        {
            name: "genera-by-family",
            aliases: ["family-genera"],
            category: "taxonomy",
            description: "List genera belonging to one family.",
            usage: "genera-by-family <family-id|family-name> [filters]",
            handler: async ({ args = [], context, writeJSON }) => {
                if (!args.length) {
                    throw new Error("A family ID or name is required.");
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
            name: "genus-children",
            category: "taxonomy",
            description: "Show child subgenera and species for one genus.",
            usage: "genus-children <id|name>",
            handler: async ({ args = [], context, writeJSON }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error("A genus or subgenus ID or name is required.");
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).children(id)
                );
            }
        },
        {
            name: "genus-lineage",
            category: "taxonomy",
            description: "Show normalized lineage for one genus-level taxon.",
            usage: "genus-lineage <id|name>",
            handler: async ({ args = [], context, writeJSON }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error("A genus or subgenus ID or name is required.");
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).lineage(id)
                );
            }
        },
        {
            name: "genus-synonym-list",
            category: "taxonomy",
            description: "Show accepted-name and synonym information for one genus.",
            usage: "genus-synonym-list <id|name>",
            handler: async ({ args = [], context, writeJSON }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error("A genus or subgenus ID or name is required.");
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).synonymList(id)
                );
            }
        },
        filteredCommand(
            "genera-accepted",
            ["accepted-genera"],
            "List accepted genus records.",
            "accepted"
        ),
        filteredCommand(
            "genera-synonyms",
            ["synonym-genera"],
            "List synonym genera or records carrying synonym names.",
            "synonyms"
        ),
        filteredCommand(
            "genera-deprecated",
            ["deprecated-genera"],
            "List deprecated genus records.",
            "deprecated"
        ),
        filteredCommand(
            "genera-supported",
            ["supported-genera"],
            "List supported genus records.",
            "supported"
        ),
        {
            name: "genera-summary",
            aliases: ["genus-summary"],
            category: "taxonomy",
            description:
                "Summarize genera by rank, status, family, subfamily, tribe, genus, subgenus, child species, provider, source, geography, and descendant counts.",
            usage: "genera-summary [filters]",
            handler: async ({ args = [], context, writeJSON }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).summary(
                        parseCommandArguments(args)
                    )
                )
        },
        {
            name: "genera-status",
            category: "taxonomy",
            description: "Show genera service status.",
            usage: "genera-status",
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
        GeneraService,
        normalizeParameters,
        normalizeRecord,
        normalizeResponse,
        normalizeStringArray: stringArray,
        normalizeTaxonomicStatus: taxonomicStatus,
        normalizeRelations,
        normalizeLineage,
        findGenus,
        summarize,
        parseCommandArguments,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalGenera = api;
    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    emit(document, "speciedex:terminal-module-available", {
        name: MODULE_NAME,
        module: api
    });
})(window, document);
