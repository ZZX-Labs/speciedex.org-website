/*
========================================================================
Speciedex.org
Terminal Families Module
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Families";
    const VERSION = "2.0.0";
    const SERVICE_NAME = "families";
    const DEFAULT_LIMIT = 50;
    const MAX_LIMIT = 1000;

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

    function date(value) {
        const normalized = text(value);

        if (!normalized) {
            return "";
        }

        const parsed = Date.parse(normalized);

        if (!Number.isFinite(parsed)) {
            throw new TypeError(`Invalid date value: ${value}`);
        }

        return new Date(parsed).toISOString();
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
            "scientific_name", "canonical_name", "name", "rank", "status",
            "order", "superfamily", "family", "subfamily", "tribe_count",
            "genus_count", "species_count", "provider", "updated_at",
            "created_at", "id"
        ]);

        if (!allowed.has(normalized)) {
            throw new TypeError(`Unsupported families sort field: ${value}`);
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
            "family", "family_id", "superfamily", "superfamily_id",
            "subfamily", "subfamily_id", "taxon", "taxon_id",
            "scientific_name", "canonical_name", "name", "authorship",
            "rank", "status", "accepted_name", "accepted_id", "domain",
            "kingdom", "phylum", "class", "order", "order_id", "suborder",
            "suborder_id", "tribe", "tribe_id", "genus", "genus_id",
            "provider", "source", "license", "country", "region",
            "continent", "category", "type"
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
            ["min_tribes", "max_tribes", source.min_tribes ?? source.minTribes, source.max_tribes ?? source.maxTribes, "tribe count"],
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
            normalized.from = date(from);
        }

        if (to !== undefined && to !== null && to !== "") {
            normalized.to = date(to);
        }

        if (normalized.from && normalized.to && Date.parse(normalized.from) > Date.parse(normalized.to)) {
            throw new RangeError("Families start date must not be later than the end date.");
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
                    status: taxonomicStatus(item.status ?? "accepted"),
                    index
                };
            }

            return {
                id: "",
                rank: fallbackRank,
                scientific_name: text(item),
                status: "accepted",
                index
            };
        }).filter(item => item.scientific_name);
    }

    function normalizeSynonyms(value) {
        return normalizeRelations(value, "family").map(item => ({
            ...item,
            authorship: text(item.authorship ?? ""),
            source: text(item.source ?? ""),
            status: item.status || "synonym"
        }));
    }

    function normalizeLineage(record) {
        if (Array.isArray(record.lineage)) {
            return normalizeRelations(record.lineage, "family");
        }

        const lineage = [];
        const levels = [
            ["domain", record.domain],
            ["kingdom", record.kingdom],
            ["phylum", record.phylum],
            ["class", record.class ?? record.class_name ?? record.className],
            ["order", record.order ?? record.order_name ?? record.orderName],
            ["suborder", record.suborder],
            ["superfamily", record.superfamily],
            [key(record.rank ?? "family") || "family", record.scientific_name ?? record.scientificName ?? record.name]
        ];

        for (const [rank, value] of levels) {
            const name = text(value);

            if (name) {
                lineage.push({
                    id: "",
                    rank,
                    scientific_name: name,
                    status: "accepted",
                    index: lineage.length
                });
            }
        }

        return lineage;
    }

    function number(value, fallback = 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
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
            record.family ??
            ""
        );

        const rank = key(
            record.rank ??
            record.taxon_rank ??
            record.taxonRank ??
            (record.subfamily ? "subfamily" : (record.superfamily ? "superfamily" : "family"))
        ) || "family";

        const status = taxonomicStatus(
            record.status ??
            record.taxonomic_status ??
            record.taxonomicStatus ??
            record.acceptance_status ??
            record.acceptanceStatus
        );

        const subfamilies = normalizeRelations(
            record.subfamilies ?? record.child_subfamilies ?? record.childSubfamilies,
            "subfamily"
        );

        const tribes = normalizeRelations(
            record.tribes ?? record.child_tribes ?? record.childTribes,
            "tribe"
        );

        const genera = normalizeRelations(
            record.genera ?? record.child_genera ?? record.childGenera,
            "genus"
        );

        const tribeCount = number(
            record.tribe_count ??
            record.tribeCount ??
            record.tribes_count ??
            record.tribesCount,
            tribes.length
        );

        const genusCount = number(
            record.genus_count ??
            record.genusCount ??
            record.genera_count ??
            record.generaCount,
            genera.length
        );

        const parentFamily = text(
            record.parent_family ??
            record.parentFamily ??
            record.parent ??
            ""
        );

        return {
            ...record,
            index: record.index ?? index,
            id: text(
                record.id ??
                record.family_id ??
                record.familyId ??
                record.superfamily_id ??
                record.superfamilyId ??
                record.subfamily_id ??
                record.subfamilyId ??
                record.taxon_id ??
                record.taxonId ??
                record.uuid ??
                `family-${index + 1}`
            ),
            family_id: text(record.family_id ?? record.familyId ?? record.taxon_id ?? record.taxonId ?? record.id ?? ""),
            superfamily_id: text(record.superfamily_id ?? record.superfamilyId ?? ""),
            subfamily_id: text(record.subfamily_id ?? record.subfamilyId ?? ""),
            scientific_name: scientificName,
            canonical_name: text(record.canonical_name ?? record.canonicalName ?? record.canonical ?? scientificName),
            name: text(record.name ?? scientificName),
            authorship: text(record.authorship ?? record.scientific_name_authorship ?? record.scientificNameAuthorship ?? ""),
            rank,
            status,
            accepted: record.accepted === true || ["accepted", "valid"].includes(status),
            synonym: record.synonym === true || record.is_synonym === true || record.isSynonym === true || status === "synonym",
            deprecated: record.deprecated === true || status === "deprecated",
            supported: record.supported !== false && !["unsupported", "disabled"].includes(status),
            verified: record.verified === true || ["verified", "confirmed"].includes(
                key(record.verification_status ?? record.verificationStatus)
            ),
            active: record.active !== false && record.deleted !== true && !["inactive", "deleted", "retired"].includes(status),
            accepted_name: text(record.accepted_name ?? record.acceptedName ?? ""),
            accepted_id: text(record.accepted_id ?? record.acceptedId ?? record.accepted_taxon_id ?? record.acceptedTaxonId ?? ""),
            domain: text(record.domain ?? ""),
            kingdom: text(record.kingdom ?? ""),
            phylum: text(record.phylum ?? ""),
            class: text(record.class ?? record.class_name ?? record.className ?? ""),
            order: text(record.order ?? record.order_name ?? record.orderName ?? ""),
            order_id: text(record.order_id ?? record.orderId ?? ""),
            suborder: text(record.suborder ?? ""),
            suborder_id: text(record.suborder_id ?? record.suborderId ?? ""),
            superfamily: text(record.superfamily ?? (rank === "superfamily" ? scientificName : "")),
            family: text(record.family ?? (rank === "family" ? scientificName : "")),
            subfamily: text(record.subfamily ?? (rank === "subfamily" ? scientificName : "")),
            parent_family: parentFamily,
            parent_family_id: text(record.parent_family_id ?? record.parentFamilyId ?? record.parent_id ?? record.parentId ?? ""),
            root: record.root === true || record.is_root === true || record.isRoot === true || !parentFamily,
            leaf: record.leaf === true || record.is_leaf === true || record.isLeaf === true || (
                subfamilies.length === 0 && tribeCount === 0 && genusCount === 0
            ),
            subfamilies,
            tribes,
            genera,
            tribe_count: tribeCount,
            genus_count: genusCount,
            species_count: number(record.species_count ?? record.speciesCount),
            synonyms: normalizeSynonyms(record.synonyms ?? record.synonym_names ?? record.synonymNames),
            lineage: normalizeLineage({ ...record, scientific_name: scientificName, rank }),
            provider: text(record.provider ?? record.provider_name ?? record.providerName ?? ""),
            providers: stringArray(record.providers ?? record.provider),
            source: text(record.source ?? record.source_name ?? record.sourceName ?? ""),
            sources: stringArray(record.sources ?? record.source),
            license: text(record.license ?? record.licence ?? ""),
            countries: stringArray(record.countries ?? record.country_codes ?? record.countryCodes ?? record.country),
            regions: stringArray(record.regions ?? record.region),
            continents: stringArray(record.continents ?? record.continent),
            category: text(record.category ?? ""),
            type: text(record.type ?? ""),
            created_at: record.created_at ?? record.createdAt ?? "",
            updated_at: record.updated_at ?? record.updatedAt ?? record.last_updated ?? record.lastUpdated ?? ""
        };
    }

    function increment(map, value) {
        const normalized = text(value) || "unknown";
        map.set(normalized, (map.get(normalized) || 0) + 1);
    }

    function sortedObject(map) {
        return Object.fromEntries(
            [...map.entries()].sort(
                (left, right) => right[1] - left[1] || left[0].localeCompare(right[0])
            )
        );
    }

    function summarize(records) {
        const values = Array.isArray(records) ? records : [];
        const maps = Object.fromEntries(
            ["ranks", "statuses", "orders", "suborders", "superfamilies", "families",
             "subfamilies", "tribes", "genera", "providers", "sources", "countries",
             "regions", "continents", "categories", "types"].map(name => [name, new Map()])
        );

        let tribeCount = 0;
        let genusCount = 0;
        let speciesCount = 0;
        let synonymCount = 0;

        for (const item of values) {
            increment(maps.ranks, item.rank);
            increment(maps.statuses, item.status);
            increment(maps.orders, item.order);
            increment(maps.suborders, item.suborder);
            increment(maps.superfamilies, item.superfamily);
            increment(maps.families, item.family);
            increment(maps.subfamilies, item.subfamily);
            increment(maps.providers, item.provider);
            increment(maps.sources, item.source);
            increment(maps.categories, item.category);
            increment(maps.types, item.type);

            item.tribes.forEach(value => increment(maps.tribes, value.scientific_name));
            item.genera.forEach(value => increment(maps.genera, value.scientific_name));
            item.countries.forEach(value => increment(maps.countries, value));
            item.regions.forEach(value => increment(maps.regions, value));
            item.continents.forEach(value => increment(maps.continents, value));

            tribeCount += item.tribe_count;
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
            tribes: tribeCount,
            genera: genusCount,
            species: speciesCount,
            ranks: sortedObject(maps.ranks),
            statuses: sortedObject(maps.statuses),
            orders: sortedObject(maps.orders),
            suborders: sortedObject(maps.suborders),
            superfamilies: sortedObject(maps.superfamilies),
            families: sortedObject(maps.families),
            subfamilies: sortedObject(maps.subfamilies),
            childTribes: sortedObject(maps.tribes),
            childGenera: sortedObject(maps.genera),
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
                                        Array.isArray(payload.families)
                                            ? payload.families
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

    function findFamily(records, value) {
        const target = text(value);
        const lower = target.toLowerCase();

        return records.find(item =>
            item.id === target ||
            item.family_id === target ||
            item.superfamily_id === target ||
            item.subfamily_id === target ||
            item.scientific_name.toLowerCase() === lower ||
            item.canonical_name.toLowerCase() === lower ||
            item.name.toLowerCase() === lower
        ) || null;
    }

    class FamiliesService extends EventTarget {
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
                throw new Error("Families service has been destroyed.");
            }

            if (!this.context.api || typeof this.context.api.get !== "function") {
                throw new Error("Speciedex API client is unavailable.");
            }
        }

        emit(name, detail) {
            dispatch(this, name, detail);

            try {
                this.context.events?.emit?.(`families:${name}`, detail);
            } catch (_error) {
                /* Observer failures must not interrupt family operations. */
            }

            dispatch(
                this.context.root,
                `speciedex:terminal-families-${name}`,
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
                    "taxa/families",
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

            const normalizedId = text(id);

            if (!normalizedId) {
                throw new TypeError("A family ID or name is required.");
            }

            try {
                const payload = await this.context.api.get(
                    `taxa/families/${encodeURIComponent(normalizedId)}`,
                    {},
                    options
                );

                return normalizeRecord(payload, 0);
            } catch (error) {
                const match = findFamily(this.cache?.records || [], normalizedId);

                if (match) {
                    return match;
                }

                throw error;
            }
        }

        async byOrder(order, parameters = {}, options = {}) {
            const normalizedOrder = text(order);

            if (!normalizedOrder) {
                throw new TypeError("An order ID or name is required.");
            }

            const result = await this.list({
                ...parameters,
                order: normalizedOrder
            }, options);

            const lower = normalizedOrder.toLowerCase();
            const records = result.records.filter(item =>
                item.order_id === normalizedOrder ||
                item.order.toLowerCase() === lower
            );

            return {
                ...result,
                order: normalizedOrder,
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
                subfamilies: record.subfamilies,
                tribes: record.tribes,
                genera: record.genera,
                tribe_count: record.tribe_count,
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
                order: record.order,
                order_id: record.order_id,
                suborder: record.suborder,
                superfamily: record.superfamily,
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
                families: result.records
            };
        }

        status() {
            return {
                version: VERSION,
                endpoint: "taxa/families",
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

        if (existing instanceof FamiliesService && !existing.destroyed) {
            context.families = existing;
            return existing;
        }

        if (
            context.families instanceof FamiliesService &&
            !context.families.destroyed
        ) {
            return context.families;
        }

        const service = new FamiliesService(context);

        context.families = service;
        context.registerService?.(SERVICE_NAME, service);
        context.registerService?.("taxa-families", service);

        dispatch(document, "speciedex:terminal-families-ready", {
            context,
            service
        });

        return service;
    }

    function requireService(context) {
        const service =
            context?.families ||
            context?.services?.get?.(SERVICE_NAME);

        if (!(service instanceof FamiliesService)) {
            throw new Error("Families service is unavailable.");
        }

        return service;
    }

    function parseCommandArguments(args = []) {
        const parameters = {};
        const positional = [];

        const flags = {
            "--family=": "family",
            "--family-id=": "family_id",
            "--superfamily=": "superfamily",
            "--superfamily-id=": "superfamily_id",
            "--subfamily=": "subfamily",
            "--subfamily-id=": "subfamily_id",
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
            "--order-id=": "order_id",
            "--suborder=": "suborder",
            "--suborder-id=": "suborder_id",
            "--tribe=": "tribe",
            "--tribe-id=": "tribe_id",
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
            "--min-tribes=": "min_tribes",
            "--max-tribes=": "max_tribes",
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
            name: "families",
            aliases: ["taxa-families"],
            category: "taxonomy",
            description: "Search taxonomic families.",
            usage:
                "families [query] [limit] [--family=NAME] [--superfamily=NAME] [--subfamily=NAME] [--order=NAME] [--tribe=NAME] [--genus=NAME] [--rank=RANK] [--status=STATUS] [--provider=PROVIDER] [--accepted=true|false] [--synonym=true|false] [--deprecated=true|false] [--supported=true|false] [--verified=true|false] [--active=true|false] [--root=true|false] [--leaf=true|false] [--min-tribes=N] [--max-tribes=N] [--min-genera=N] [--max-genera=N] [--min-species=N] [--max-species=N] [--from=DATE] [--to=DATE] [--sort=FIELD] [--direction=asc|desc] [--offset=N]",
            handler: async ({ args = [], context, writeJSON }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).list(
                        parseCommandArguments(args)
                    )
                )
        },
        {
            name: "family",
            aliases: ["family-get"],
            category: "taxonomy",
            description: "Retrieve one family-level taxon by ID or name.",
            usage: "family <id|name>",
            handler: async ({ args = [], context, writeJSON }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error("A family ID or name is required.");
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).get(id)
                );
            }
        },
        {
            name: "families-by-order",
            aliases: ["order-families"],
            category: "taxonomy",
            description: "List families belonging to one order.",
            usage: "families-by-order <order-id|order-name> [filters]",
            handler: async ({ args = [], context, writeJSON }) => {
                if (!args.length) {
                    throw new Error("An order ID or name is required.");
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).byOrder(
                        args[0],
                        parseCommandArguments(args.slice(1))
                    )
                );
            }
        },
        {
            name: "family-children",
            category: "taxonomy",
            description: "Show child subfamilies, tribes, and genera for one family.",
            usage: "family-children <id|name>",
            handler: async ({ args = [], context, writeJSON }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error("A family ID or name is required.");
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).children(id)
                );
            }
        },
        {
            name: "family-lineage",
            category: "taxonomy",
            description: "Show normalized lineage for one family-level taxon.",
            usage: "family-lineage <id|name>",
            handler: async ({ args = [], context, writeJSON }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error("A family ID or name is required.");
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).lineage(id)
                );
            }
        },
        {
            name: "family-synonym-list",
            category: "taxonomy",
            description: "Show accepted-name and synonym information for one family.",
            usage: "family-synonym-list <id|name>",
            handler: async ({ args = [], context, writeJSON }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error("A family ID or name is required.");
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).synonymList(id)
                );
            }
        },
        filteredCommand(
            "families-accepted",
            ["accepted-families"],
            "List accepted family records.",
            "accepted"
        ),
        filteredCommand(
            "families-synonyms",
            ["synonym-families"],
            "List synonym families or records carrying synonym names.",
            "synonyms"
        ),
        filteredCommand(
            "families-deprecated",
            ["deprecated-families"],
            "List deprecated family records.",
            "deprecated"
        ),
        filteredCommand(
            "families-supported",
            ["supported-families"],
            "List supported family records.",
            "supported"
        ),
        {
            name: "families-summary",
            aliases: ["family-summary"],
            category: "taxonomy",
            description:
                "Summarize families by rank, status, order, superfamily, family, subfamily, child tribe, child genus, provider, source, geography, and descendant counts.",
            usage: "families-summary [filters]",
            handler: async ({ args = [], context, writeJSON }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).summary(
                        parseCommandArguments(args)
                    )
                )
        },
        {
            name: "families-status",
            category: "taxonomy",
            description: "Show families service status.",
            usage: "families-status",
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
        FamiliesService,
        normalizeParameters,
        normalizeRecord,
        normalizeResponse,
        normalizeStringArray: stringArray,
        normalizeTaxonomicStatus: taxonomicStatus,
        normalizeSynonyms,
        normalizeChildren: normalizeRelations,
        normalizeLineage,
        findFamily,
        summarize,
        parseCommandArguments,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalFamilies = api;
    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    dispatch(document, "speciedex:terminal-module-available", {
        name: MODULE_NAME,
        module: api
    });
})(window, document);
