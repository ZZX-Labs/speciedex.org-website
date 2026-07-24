/*
========================================================================
Speciedex.org
Terminal Kingdoms Module
========================================================================

Taxonomic kingdom and subkingdom search service for SpeciedexTerminal.

Provides validated API requests, normalized kingdom records, parent-domain
resolution, child-phylum helpers, lineage and synonym handling, status views,
summaries, caching, lifecycle events, resilient service registration, and
terminal command integration.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Kingdoms";
    const VERSION = "2.0.0";
    const SERVICE_NAME = "kingdoms";
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
            "domain",
            "kingdom",
            "subkingdom",
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
            throw new TypeError(`Unsupported kingdoms sort field: ${value}`);
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
            "kingdom", "kingdom_id", "subkingdom", "subkingdom_id",
            "superkingdom", "superkingdom_id", "taxon", "taxon_id",
            "scientific_name", "canonical_name", "name", "authorship",
            "rank", "status", "accepted_name", "accepted_id", "domain",
            "domain_id", "phylum", "phylum_id", "provider", "source",
            "license", "country", "region", "continent", "category", "type"
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
            ["min_phyla", "max_phyla", source.min_phyla ?? source.minPhyla, source.max_phyla ?? source.maxPhyla, "phylum count"],
            ["min_classes", "max_classes", source.min_classes ?? source.minClasses, source.max_classes ?? source.maxClasses, "class count"],
            ["min_orders", "max_orders", source.min_orders ?? source.minOrders, source.max_orders ?? source.maxOrders, "order count"],
            ["min_families", "max_families", source.min_families ?? source.minFamilies, source.max_families ?? source.maxFamilies, "family count"],
            ["min_genera", "max_genera", source.min_genera ?? source.minGenera, source.max_genera ?? source.maxGenera, "genus count"],
            ["min_species", "max_species", source.min_species ?? source.minSpecies, source.max_species ?? source.maxSpecies, "species count"]
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
                "Kingdoms start date must not be later than the end date."
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
            return normalizeRelations(record.lineage, "kingdom");
        }

        const lineage = [];
        const levels = [
            ["domain", record.domain],
            ["superkingdom", record.superkingdom],
            [key(record.rank ?? "kingdom") || "kingdom", record.scientific_name ?? record.scientificName ?? record.name]
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
            record.kingdom ??
            ""
        );

        const rank = key(
            record.rank ??
            record.taxon_rank ??
            record.taxonRank ??
            (record.subkingdom ? "subkingdom" : "kingdom")
        ) || "kingdom";

        const status = taxonomicStatus(
            record.status ??
            record.taxonomic_status ??
            record.taxonomicStatus ??
            record.acceptance_status ??
            record.acceptanceStatus
        );

        const phyla = normalizeRelations(
            record.phyla ??
            record.phylums ??
            record.child_phyla ??
            record.childPhyla,
            "phylum"
        );

        const subkingdoms = normalizeRelations(
            record.subkingdoms ??
            record.child_subkingdoms ??
            record.childSubkingdoms,
            "subkingdom"
        );

        const phylumCount = number(
            record.phylum_count ??
            record.phylumCount ??
            record.phyla_count ??
            record.phylaCount,
            phyla.length
        );

        const parentKingdom = text(
            record.parent_kingdom ??
            record.parentKingdom ??
            record.parent ??
            ""
        );

        return {
            ...record,
            index: record.index ?? index,
            id: text(
                record.id ??
                record.kingdom_id ??
                record.kingdomId ??
                record.subkingdom_id ??
                record.subkingdomId ??
                record.taxon_id ??
                record.taxonId ??
                record.uuid ??
                `kingdom-${index + 1}`
            ),
            kingdom_id: text(
                record.kingdom_id ??
                record.kingdomId ??
                record.taxon_id ??
                record.taxonId ??
                record.id ??
                ""
            ),
            subkingdom_id: text(
                record.subkingdom_id ??
                record.subkingdomId ??
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
            domain_id: text(
                record.domain_id ??
                record.domainId ??
                ""
            ),
            superkingdom: text(record.superkingdom ?? ""),
            superkingdom_id: text(
                record.superkingdom_id ??
                record.superkingdomId ??
                ""
            ),
            kingdom: text(
                record.kingdom ??
                (rank === "kingdom" ? scientificName : "")
            ),
            subkingdom: text(
                record.subkingdom ??
                (rank === "subkingdom" ? scientificName : "")
            ),
            parent_kingdom: parentKingdom,
            parent_kingdom_id: text(
                record.parent_kingdom_id ??
                record.parentKingdomId ??
                record.parent_id ??
                record.parentId ??
                ""
            ),
            root: record.root === true ||
                record.is_root === true ||
                record.isRoot === true ||
                !parentKingdom,
            leaf: record.leaf === true ||
                record.is_leaf === true ||
                record.isLeaf === true ||
                (phylumCount === 0 && subkingdoms.length === 0),
            subkingdoms,
            phyla,
            phylum_count: phylumCount,
            class_count: number(
                record.class_count ??
                record.classCount
            ),
            order_count: number(
                record.order_count ??
                record.orderCount
            ),
            family_count: number(
                record.family_count ??
                record.familyCount
            ),
            genus_count: number(
                record.genus_count ??
                record.genusCount
            ),
            species_count: number(
                record.species_count ??
                record.speciesCount
            ),
            synonyms: normalizeRelations(
                record.synonyms ??
                record.synonym_names ??
                record.synonymNames,
                "kingdom"
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
                "ranks", "statuses", "domains", "superkingdoms", "kingdoms",
                "subkingdoms", "phyla", "providers", "sources", "countries",
                "regions", "continents", "categories", "types"
            ].map(name => [name, new Map()])
        );

        let phylumCount = 0;
        let classCount = 0;
        let orderCount = 0;
        let familyCount = 0;
        let genusCount = 0;
        let speciesCount = 0;
        let synonymCount = 0;

        for (const item of values) {
            increment(maps.ranks, item.rank);
            increment(maps.statuses, item.status);
            increment(maps.domains, item.domain);
            increment(maps.superkingdoms, item.superkingdom);
            increment(maps.kingdoms, item.kingdom);
            increment(maps.subkingdoms, item.subkingdom);
            increment(maps.providers, item.provider);
            increment(maps.sources, item.source);
            increment(maps.categories, item.category);
            increment(maps.types, item.type);

            item.phyla.forEach(value => increment(maps.phyla, value.scientific_name));
            item.countries.forEach(value => increment(maps.countries, value));
            item.regions.forEach(value => increment(maps.regions, value));
            item.continents.forEach(value => increment(maps.continents, value));

            phylumCount += item.phylum_count;
            classCount += item.class_count;
            orderCount += item.order_count;
            familyCount += item.family_count;
            genusCount += item.genus_count;
            speciesCount += item.species_count;
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
            phyla: phylumCount,
            classes: classCount,
            orders: orderCount,
            families: familyCount,
            genera: genusCount,
            species: speciesCount,
            ranks: sortedObject(maps.ranks),
            statuses: sortedObject(maps.statuses),
            domains: sortedObject(maps.domains),
            superkingdoms: sortedObject(maps.superkingdoms),
            kingdoms: sortedObject(maps.kingdoms),
            subkingdoms: sortedObject(maps.subkingdoms),
            childPhyla: sortedObject(maps.phyla),
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
                                        Array.isArray(payload.kingdoms)
                                            ? payload.kingdoms
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

    function findKingdom(records, value) {
        const target = text(value);
        const lower = target.toLowerCase();

        return records.find(item =>
            item.id === target ||
            item.kingdom_id === target ||
            item.subkingdom_id === target ||
            item.scientific_name.toLowerCase() === lower ||
            item.canonical_name.toLowerCase() === lower ||
            item.name.toLowerCase() === lower
        ) || null;
    }

    class KingdomsService extends EventTarget {
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
                throw new Error("Kingdoms service has been destroyed.");
            }

            if (!this.context.api || typeof this.context.api.get !== "function") {
                throw new Error("Speciedex API client is unavailable.");
            }
        }

        dispatch(name, detail) {
            emit(this, name, detail);

            try {
                this.context.events?.emit?.(`kingdoms:${name}`, detail);
            } catch (_error) {
                /* Observer failures must not interrupt kingdom operations. */
            }

            emit(
                this.context.root,
                `speciedex:terminal-kingdoms-${name}`,
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
                    "taxa/kingdoms",
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
                throw new TypeError("A kingdom or subkingdom ID or name is required.");
            }

            try {
                const payload = await this.context.api.get(
                    `taxa/kingdoms/${encodeURIComponent(normalizedId)}`,
                    {},
                    options
                );

                return normalizeRecord(payload, 0);
            } catch (error) {
                const match = findKingdom(this.cache?.records || [], normalizedId);

                if (match) {
                    return match;
                }

                throw error;
            }
        }

        async byDomain(domain, parameters = {}, options = {}) {
            const normalizedDomain = text(domain);

            if (!normalizedDomain) {
                throw new TypeError("A domain ID or name is required.");
            }

            const result = await this.list({
                ...parameters,
                domain: normalizedDomain
            }, options);

            const lower = normalizedDomain.toLowerCase();
            const records = result.records.filter(item =>
                item.domain_id === normalizedDomain ||
                item.domain.toLowerCase() === lower
            );

            return {
                ...result,
                domain: normalizedDomain,
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
                subkingdoms: record.subkingdoms,
                phyla: record.phyla,
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
                domain: record.domain,
                domain_id: record.domain_id,
                superkingdom: record.superkingdom,
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
                kingdoms: result.records
            };
        }

        status() {
            return {
                version: VERSION,
                endpoint: "taxa/kingdoms",
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

        if (existing instanceof KingdomsService && !existing.destroyed) {
            context.kingdoms = existing;
            return existing;
        }

        if (
            context.kingdoms instanceof KingdomsService &&
            !context.kingdoms.destroyed
        ) {
            return context.kingdoms;
        }

        const service = new KingdomsService(context);

        context.kingdoms = service;
        context.registerService?.(SERVICE_NAME, service);
        context.registerService?.("taxa-kingdoms", service);

        emit(document, "speciedex:terminal-kingdoms-ready", {
            context,
            service
        });

        return service;
    }

    function requireService(context) {
        const service =
            context?.kingdoms ||
            context?.services?.get?.(SERVICE_NAME);

        if (!(service instanceof KingdomsService)) {
            throw new Error("Kingdoms service is unavailable.");
        }

        return service;
    }

    function parseCommandArguments(args = []) {
        const parameters = {};
        const positional = [];

        const flags = {
            "--kingdom=": "kingdom",
            "--kingdom-id=": "kingdom_id",
            "--subkingdom=": "subkingdom",
            "--subkingdom-id=": "subkingdom_id",
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
            "--domain=": "domain",
            "--domain-id=": "domain_id",
            "--phylum=": "phylum",
            "--phylum-id=": "phylum_id",
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
            "--max-species=": "max_species",
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
            name: "kingdoms",
            aliases: ["taxa-kingdoms"],
            category: "taxonomy",
            description: "Search taxonomic kingdoms.",
            usage:
                "kingdoms [query] [limit] [--kingdom=NAME] [--subkingdom=NAME] [--domain=NAME] [--phylum=NAME] [--rank=RANK] [--status=STATUS] [--provider=PROVIDER] [--accepted=true|false] [--synonym=true|false] [--deprecated=true|false] [--supported=true|false] [--verified=true|false] [--active=true|false] [--root=true|false] [--leaf=true|false] [--min-phyla=N] [--max-phyla=N] [--min-classes=N] [--max-classes=N] [--min-orders=N] [--max-orders=N] [--min-families=N] [--max-families=N] [--min-genera=N] [--max-genera=N] [--min-species=N] [--max-species=N] [--from=DATE] [--to=DATE] [--sort=FIELD] [--direction=asc|desc] [--offset=N]",
            handler: async ({ args = [], context, writeJSON }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).list(
                        parseCommandArguments(args)
                    )
                )
        },
        {
            name: "kingdom",
            aliases: ["kingdom-get"],
            category: "taxonomy",
            description: "Retrieve one kingdom or subkingdom by ID or name.",
            usage: "kingdom <id|name>",
            handler: async ({ args = [], context, writeJSON }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error("A kingdom or subkingdom ID or name is required.");
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).get(id)
                );
            }
        },
        {
            name: "kingdoms-by-domain",
            aliases: ["domain-kingdoms"],
            category: "taxonomy",
            description: "List kingdoms belonging to one domain.",
            usage: "kingdoms-by-domain <domain-id|domain-name> [filters]",
            handler: async ({ args = [], context, writeJSON }) => {
                if (!args.length) {
                    throw new Error("A domain ID or name is required.");
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).byDomain(
                        args[0],
                        parseCommandArguments(args.slice(1))
                    )
                );
            }
        },
        {
            name: "kingdom-children",
            category: "taxonomy",
            description: "Show child subkingdoms and phyla for one kingdom.",
            usage: "kingdom-children <id|name>",
            handler: async ({ args = [], context, writeJSON }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error("A kingdom or subkingdom ID or name is required.");
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).children(id)
                );
            }
        },
        {
            name: "kingdom-lineage",
            category: "taxonomy",
            description: "Show normalized lineage for one kingdom-level taxon.",
            usage: "kingdom-lineage <id|name>",
            handler: async ({ args = [], context, writeJSON }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error("A kingdom or subkingdom ID or name is required.");
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).lineage(id)
                );
            }
        },
        {
            name: "kingdom-synonym-list",
            category: "taxonomy",
            description: "Show accepted-name and synonym information for one kingdom.",
            usage: "kingdom-synonym-list <id|name>",
            handler: async ({ args = [], context, writeJSON }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error("A kingdom or subkingdom ID or name is required.");
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).synonymList(id)
                );
            }
        },
        filteredCommand(
            "kingdoms-accepted",
            ["accepted-kingdoms"],
            "List accepted kingdom records.",
            "accepted"
        ),
        filteredCommand(
            "kingdoms-synonyms",
            ["synonym-kingdoms"],
            "List synonym kingdoms or records carrying synonym names.",
            "synonyms"
        ),
        filteredCommand(
            "kingdoms-deprecated",
            ["deprecated-kingdoms"],
            "List deprecated kingdom records.",
            "deprecated"
        ),
        filteredCommand(
            "kingdoms-supported",
            ["supported-kingdoms"],
            "List supported kingdom records.",
            "supported"
        ),
        {
            name: "kingdoms-summary",
            aliases: ["kingdom-summary"],
            category: "taxonomy",
            description:
                "Summarize kingdoms by rank, status, domain, superkingdom, kingdom, subkingdom, child phylum, provider, source, geography, and descendant counts.",
            usage: "kingdoms-summary [filters]",
            handler: async ({ args = [], context, writeJSON }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).summary(
                        parseCommandArguments(args)
                    )
                )
        },
        {
            name: "kingdoms-status",
            category: "taxonomy",
            description: "Show kingdoms service status.",
            usage: "kingdoms-status",
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
        KingdomsService,
        normalizeParameters,
        normalizeRecord,
        normalizeResponse,
        normalizeStringArray: stringArray,
        normalizeTaxonomicStatus: taxonomicStatus,
        normalizeRelations,
        normalizeLineage,
        findKingdom,
        summarize,
        parseCommandArguments,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalKingdoms = api;
    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    emit(document, "speciedex:terminal-module-available", {
        name: MODULE_NAME,
        module: api
    });
})(window, document);
