/*
========================================================================
Speciedex.org
Terminal Orders Module
========================================================================

Taxonomic order and suborder search service for SpeciedexTerminal.

Provides validated API requests, normalized order records, parent-class
resolution, child-family helpers, lineage and synonym handling, status views,
summaries, caching, lifecycle events, resilient service registration, and
terminal command integration.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Orders";
    const VERSION = "2.0.0";
    const SERVICE_NAME = "orders";
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
            "class",
            "superorder",
            "order",
            "suborder",
            "family_count",
            "genus_count",
            "species_count",
            "provider",
            "updated_at",
            "created_at",
            "id"
        ]);

        if (!allowed.has(normalized)) {
            throw new TypeError(`Unsupported orders sort field: ${value}`);
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
            "order",
            "order_id",
            "superorder",
            "superorder_id",
            "suborder",
            "suborder_id",
            "infraorder",
            "infraorder_id",
            "parvorder",
            "parvorder_id",
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
            "class",
            "class_id",
            "subclass",
            "subclass_id",
            "family",
            "family_id",
            "provider",
            "source",
            "license",
            "country",
            "region",
            "continent",
            "category",
            "type"
        ];

        for (const field of textFields) {
            if (
                source[field] !== undefined &&
                source[field] !== null &&
                source[field] !== ""
            ) {
                normalized[field] = text(source[field]);
            }
        }

        const booleanFields = [
            "accepted",
            "synonym",
            "deprecated",
            "supported",
            "verified",
            "active",
            "root",
            "leaf"
        ];

        for (const field of booleanFields) {
            if (
                source[field] !== undefined &&
                source[field] !== null &&
                source[field] !== ""
            ) {
                const parsed = boolean(source[field]);

                if (parsed === null) {
                    throw new TypeError(
                        `Invalid ${field} value: ${source[field]}`
                    );
                }

                normalized[field] = parsed;
            }
        }

        const ranges = [
            ["min_families", "max_families", source.min_families ?? source.minFamilies, source.max_families ?? source.maxFamilies, "family count"],
            ["min_genera", "max_genera", source.min_genera ?? source.minGenera, source.max_genera ?? source.maxGenera, "genus count"],
            ["min_species", "max_species", source.min_species ?? source.minSpecies, source.max_species ?? source.maxSpecies, "species count"]
        ];

        for (const [minimumKey, maximumKey, minimumValue, maximumValue, label] of ranges) {
            if (
                minimumValue !== undefined &&
                minimumValue !== null &&
                minimumValue !== ""
            ) {
                normalized[minimumKey] = integer(minimumValue, 0);
            }

            if (
                maximumValue !== undefined &&
                maximumValue !== null &&
                maximumValue !== ""
            ) {
                normalized[maximumKey] = integer(
                    maximumValue,
                    Number.MAX_SAFE_INTEGER
                );
            }

            if (
                normalized[minimumKey] !== undefined &&
                normalized[maximumKey] !== undefined &&
                normalized[minimumKey] > normalized[maximumKey]
            ) {
                throw new RangeError(
                    `Minimum ${label} must not exceed maximum ${label}.`
                );
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
                "Orders start date must not be later than the end date."
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
                    id: text(
                        item.id ??
                        item.taxon_id ??
                        item.taxonId ??
                        ""
                    ),
                    rank: key(
                        item.rank ??
                        item.taxon_rank ??
                        item.taxonRank ??
                        fallbackRank
                    ),
                    scientific_name: text(
                        item.scientific_name ??
                        item.scientificName ??
                        item.name ??
                        ""
                    ),
                    authorship: text(
                        item.authorship ??
                        item.scientific_name_authorship ??
                        item.scientificNameAuthorship ??
                        ""
                    ),
                    status: taxonomicStatus(
                        item.status ?? "accepted"
                    ),
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
            return normalizeRelations(record.lineage, "order");
        }

        const lineage = [];
        const levels = [
            ["domain", record.domain],
            ["kingdom", record.kingdom],
            ["phylum", record.phylum],
            ["class", record.class ?? record.class_name ?? record.className],
            ["subclass", record.subclass],
            ["superorder", record.superorder],
            [
                key(record.rank ?? "order") || "order",
                record.scientific_name ??
                record.scientificName ??
                record.name
            ]
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
            record.order ??
            ""
        );

        const rank = key(
            record.rank ??
            record.taxon_rank ??
            record.taxonRank ??
            (
                record.parvorder
                    ? "parvorder"
                    : (
                        record.infraorder
                            ? "infraorder"
                            : (
                                record.suborder
                                    ? "suborder"
                                    : (
                                        record.superorder
                                            ? "superorder"
                                            : "order"
                                    )
                            )
                    )
            )
        ) || "order";

        const status = taxonomicStatus(
            record.status ??
            record.taxonomic_status ??
            record.taxonomicStatus ??
            record.acceptance_status ??
            record.acceptanceStatus
        );

        const families = normalizeRelations(
            record.families ??
            record.child_families ??
            record.childFamilies,
            "family"
        );

        const suborders = normalizeRelations(
            record.suborders ??
            record.child_suborders ??
            record.childSuborders,
            "suborder"
        );

        const familyCount = number(
            record.family_count ??
            record.familyCount ??
            record.families_count ??
            record.familiesCount,
            families.length
        );

        const parentOrder = text(
            record.parent_order ??
            record.parentOrder ??
            record.parent ??
            ""
        );

        return {
            ...record,
            index: record.index ?? index,
            id: text(
                record.id ??
                record.order_id ??
                record.orderId ??
                record.superorder_id ??
                record.superorderId ??
                record.suborder_id ??
                record.suborderId ??
                record.infraorder_id ??
                record.infraorderId ??
                record.parvorder_id ??
                record.parvorderId ??
                record.taxon_id ??
                record.taxonId ??
                record.uuid ??
                `order-${index + 1}`
            ),
            order_id: text(
                record.order_id ??
                record.orderId ??
                record.taxon_id ??
                record.taxonId ??
                record.id ??
                ""
            ),
            superorder_id: text(
                record.superorder_id ??
                record.superorderId ??
                ""
            ),
            suborder_id: text(
                record.suborder_id ??
                record.suborderId ??
                ""
            ),
            infraorder_id: text(
                record.infraorder_id ??
                record.infraorderId ??
                ""
            ),
            parvorder_id: text(
                record.parvorder_id ??
                record.parvorderId ??
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
            accepted:
                record.accepted === true ||
                ["accepted", "valid"].includes(status),
            synonym:
                record.synonym === true ||
                record.is_synonym === true ||
                record.isSynonym === true ||
                status === "synonym",
            deprecated:
                record.deprecated === true ||
                status === "deprecated",
            supported:
                record.supported !== false &&
                !["unsupported", "disabled"].includes(status),
            verified:
                record.verified === true ||
                ["verified", "confirmed"].includes(
                    key(
                        record.verification_status ??
                        record.verificationStatus
                    )
                ),
            active:
                record.active !== false &&
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
            class_id: text(
                record.class_id ??
                record.classId ??
                ""
            ),
            subclass: text(record.subclass ?? ""),
            subclass_id: text(
                record.subclass_id ??
                record.subclassId ??
                ""
            ),
            superorder: text(
                record.superorder ??
                (rank === "superorder" ? scientificName : "")
            ),
            order: text(
                record.order ??
                (rank === "order" ? scientificName : "")
            ),
            suborder: text(
                record.suborder ??
                (rank === "suborder" ? scientificName : "")
            ),
            infraorder: text(
                record.infraorder ??
                (rank === "infraorder" ? scientificName : "")
            ),
            parvorder: text(
                record.parvorder ??
                (rank === "parvorder" ? scientificName : "")
            ),
            parent_order: parentOrder,
            parent_order_id: text(
                record.parent_order_id ??
                record.parentOrderId ??
                record.parent_id ??
                record.parentId ??
                ""
            ),
            root:
                record.root === true ||
                record.is_root === true ||
                record.isRoot === true ||
                !parentOrder,
            leaf:
                record.leaf === true ||
                record.is_leaf === true ||
                record.isLeaf === true ||
                (
                    familyCount === 0 &&
                    suborders.length === 0
                ),
            suborders,
            families,
            family_count: familyCount,
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
                "order"
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
            providers: stringArray(
                record.providers ??
                record.provider
            ),
            source: text(
                record.source ??
                record.source_name ??
                record.sourceName ??
                ""
            ),
            sources: stringArray(
                record.sources ??
                record.source
            ),
            license: text(
                record.license ??
                record.licence ??
                ""
            ),
            countries: stringArray(
                record.countries ??
                record.country_codes ??
                record.countryCodes ??
                record.country
            ),
            regions: stringArray(
                record.regions ??
                record.region
            ),
            continents: stringArray(
                record.continents ??
                record.continent
            ),
            category: text(record.category ?? ""),
            type: text(record.type ?? ""),
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

    function increment(map, value) {
        const normalized = text(value) || "unknown";

        map.set(
            normalized,
            (map.get(normalized) || 0) + 1
        );
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
                "ranks",
                "statuses",
                "classes",
                "subclasses",
                "superorders",
                "orders",
                "suborders",
                "infraorders",
                "parvorders",
                "families",
                "providers",
                "sources",
                "countries",
                "regions",
                "continents",
                "categories",
                "types"
            ].map(name => [name, new Map()])
        );

        let familyCount = 0;
        let genusCount = 0;
        let speciesCount = 0;
        let synonymCount = 0;

        for (const item of values) {
            increment(maps.ranks, item.rank);
            increment(maps.statuses, item.status);
            increment(maps.classes, item.class);
            increment(maps.subclasses, item.subclass);
            increment(maps.superorders, item.superorder);
            increment(maps.orders, item.order);
            increment(maps.suborders, item.suborder);
            increment(maps.infraorders, item.infraorder);
            increment(maps.parvorders, item.parvorder);
            increment(maps.providers, item.provider);
            increment(maps.sources, item.source);
            increment(maps.categories, item.category);
            increment(maps.types, item.type);

            item.families.forEach(
                value => increment(
                    maps.families,
                    value.scientific_name
                )
            );

            item.countries.forEach(
                value => increment(maps.countries, value)
            );

            item.regions.forEach(
                value => increment(maps.regions, value)
            );

            item.continents.forEach(
                value => increment(maps.continents, value)
            );

            familyCount += item.family_count;
            genusCount += item.genus_count;
            speciesCount += item.species_count;
            synonymCount += item.synonyms.length;
        }

        return {
            total: values.length,
            accepted:
                values.filter(item => item.accepted).length,
            synonyms:
                values.filter(item => item.synonym).length,
            synonymNames: synonymCount,
            deprecated:
                values.filter(item => item.deprecated).length,
            supported:
                values.filter(item => item.supported).length,
            verified:
                values.filter(item => item.verified).length,
            active:
                values.filter(item => item.active).length,
            roots:
                values.filter(item => item.root).length,
            leaves:
                values.filter(item => item.leaf).length,
            families: familyCount,
            genera: genusCount,
            species: speciesCount,
            ranks: sortedObject(maps.ranks),
            statuses: sortedObject(maps.statuses),
            classes: sortedObject(maps.classes),
            subclasses: sortedObject(maps.subclasses),
            superorders: sortedObject(maps.superorders),
            orders: sortedObject(maps.orders),
            suborders: sortedObject(maps.suborders),
            infraorders: sortedObject(maps.infraorders),
            parvorders: sortedObject(maps.parvorders),
            childFamilies: sortedObject(maps.families),
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
                                        Array.isArray(payload.orders)
                                            ? payload.orders
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
            summary:
                payload?.summary &&
                typeof payload.summary === "object"
                    ? {
                        ...summarize(records),
                        ...payload.summary
                    }
                    : summarize(records),
            next:
                payload?.next ??
                payload?.nextPage ??
                null,
            previous:
                payload?.previous ??
                payload?.previousPage ??
                null,
            raw: payload
        };
    }

    function findOrder(records, value) {
        const target = text(value);
        const lower = target.toLowerCase();

        return records.find(item =>
            item.id === target ||
            item.order_id === target ||
            item.superorder_id === target ||
            item.suborder_id === target ||
            item.infraorder_id === target ||
            item.parvorder_id === target ||
            item.scientific_name.toLowerCase() === lower ||
            item.canonical_name.toLowerCase() === lower ||
            item.name.toLowerCase() === lower
        ) || null;
    }

    class OrdersService extends EventTarget {
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
                    "Orders service has been destroyed."
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
            emit(this, name, detail);

            try {
                this.context.events?.emit?.(
                    `orders:${name}`,
                    detail
                );
            } catch (_error) {
                /*
                Observer failures must not interrupt order operations.
                */
            }

            emit(
                this.context.root,
                `speciedex:terminal-orders-${name}`,
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
                    "taxa/orders",
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
                throw new TypeError(
                    "An order-level taxon ID or name is required."
                );
            }

            try {
                const payload = await this.context.api.get(
                    `taxa/orders/${encodeURIComponent(normalizedId)}`,
                    {},
                    options
                );

                return normalizeRecord(payload, 0);
            } catch (error) {
                const match = findOrder(
                    this.cache?.records || [],
                    normalizedId
                );

                if (match) {
                    return match;
                }

                throw error;
            }
        }

        async byClass(className, parameters = {}, options = {}) {
            const normalizedClass = text(className);

            if (!normalizedClass) {
                throw new TypeError(
                    "A class ID or name is required."
                );
            }

            const result = await this.list({
                ...parameters,
                class: normalizedClass
            }, options);

            const lower = normalizedClass.toLowerCase();

            const records = result.records.filter(item =>
                item.class_id === normalizedClass ||
                item.class.toLowerCase() === lower
            );

            return {
                ...result,
                class: normalizedClass,
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
                suborders: record.suborders,
                families: record.families,
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
                class: record.class,
                class_id: record.class_id,
                subclass: record.subclass,
                superorder: record.superorder,
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
            return this.filtered(
                "accepted",
                parameters,
                options
            );
        }

        synonyms(parameters = {}, options = {}) {
            return this.filtered(
                "synonym",
                parameters,
                options
            );
        }

        deprecated(parameters = {}, options = {}) {
            return this.filtered(
                "deprecated",
                parameters,
                options
            );
        }

        supported(parameters = {}, options = {}) {
            return this.filtered(
                "supported",
                parameters,
                options
            );
        }

        async summary(parameters = {}, options = {}) {
            const result = await this.list({
                ...parameters,
                limit: parameters.limit ?? MAX_LIMIT
            }, options);

            return {
                parameters: result.parameters,
                summary: summarize(result.records),
                orders: result.records
            };
        }

        status() {
            return {
                version: VERSION,
                endpoint: "taxa/orders",
                service: SERVICE_NAME,
                available: Boolean(
                    this.context.api &&
                    typeof this.context.api.get === "function"
                ),
                cached: Boolean(this.cache),
                cacheAge:
                    this.cacheTimestamp
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

        if (
            existing instanceof OrdersService &&
            !existing.destroyed
        ) {
            context.orders = existing;
            return existing;
        }

        if (
            context.orders instanceof OrdersService &&
            !context.orders.destroyed
        ) {
            return context.orders;
        }

        const service = new OrdersService(context);

        context.orders = service;

        context.registerService?.(
            SERVICE_NAME,
            service
        );

        context.registerService?.(
            "taxa-orders",
            service
        );

        emit(
            document,
            "speciedex:terminal-orders-ready",
            {
                context,
                service
            }
        );

        return service;
    }

    function requireService(context) {
        const service =
            context?.orders ||
            context?.services?.get?.(SERVICE_NAME);

        if (!(service instanceof OrdersService)) {
            throw new Error(
                "Orders service is unavailable."
            );
        }

        return service;
    }

    function parseCommandArguments(args = []) {
        const parameters = {};
        const positional = [];

        const flags = {
            "--order=": "order",
            "--order-id=": "order_id",
            "--superorder=": "superorder",
            "--superorder-id=": "superorder_id",
            "--suborder=": "suborder",
            "--suborder-id=": "suborder_id",
            "--infraorder=": "infraorder",
            "--infraorder-id=": "infraorder_id",
            "--parvorder=": "parvorder",
            "--parvorder-id=": "parvorder_id",
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
            "--class-id=": "class_id",
            "--subclass=": "subclass",
            "--subclass-id=": "subclass_id",
            "--family=": "family",
            "--family-id=": "family_id",
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
                parameters[match[1]] =
                    argument.slice(match[0].length);
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
            name: "orders",
            aliases: [
                "taxa-orders"
            ],
            category: "taxonomy",
            description:
                "Search taxonomic orders.",
            usage:
                "orders [query] [limit] [--order=NAME] [--superorder=NAME] [--suborder=NAME] [--infraorder=NAME] [--parvorder=NAME] [--class=NAME] [--family=NAME] [--rank=RANK] [--status=STATUS] [--provider=PROVIDER] [--accepted=true|false] [--synonym=true|false] [--deprecated=true|false] [--supported=true|false] [--verified=true|false] [--active=true|false] [--root=true|false] [--leaf=true|false] [--min-families=N] [--max-families=N] [--min-genera=N] [--max-genera=N] [--min-species=N] [--max-species=N] [--from=DATE] [--to=DATE] [--sort=FIELD] [--direction=asc|desc] [--offset=N]",
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
            name: "order",
            aliases: [
                "order-get"
            ],
            category: "taxonomy",
            description:
                "Retrieve one order-level taxon by ID or name.",
            usage:
                "order <id|name>",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error(
                        "An order-level taxon ID or name is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).get(id)
                );
            }
        },
        {
            name: "orders-by-class",
            aliases: [
                "class-orders"
            ],
            category: "taxonomy",
            description:
                "List orders belonging to one class.",
            usage:
                "orders-by-class <class-id|class-name> [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                if (!args.length) {
                    throw new Error(
                        "A class ID or name is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).byClass(
                        args[0],
                        parseCommandArguments(args.slice(1))
                    )
                );
            }
        },
        {
            name: "order-children",
            category: "taxonomy",
            description:
                "Show child suborders and families for one order.",
            usage:
                "order-children <id|name>",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error(
                        "An order-level taxon ID or name is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).children(id)
                );
            }
        },
        {
            name: "order-lineage",
            category: "taxonomy",
            description:
                "Show normalized lineage for one order-level taxon.",
            usage:
                "order-lineage <id|name>",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error(
                        "An order-level taxon ID or name is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).lineage(id)
                );
            }
        },
        {
            name: "order-synonym-list",
            category: "taxonomy",
            description:
                "Show accepted-name and synonym information for one order.",
            usage:
                "order-synonym-list <id|name>",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error(
                        "An order-level taxon ID or name is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).synonymList(id)
                );
            }
        },
        filteredCommand(
            "orders-accepted",
            ["accepted-orders"],
            "List accepted order records.",
            "accepted"
        ),
        filteredCommand(
            "orders-synonyms",
            ["synonym-orders"],
            "List synonym orders or records carrying synonym names.",
            "synonyms"
        ),
        filteredCommand(
            "orders-deprecated",
            ["deprecated-orders"],
            "List deprecated order records.",
            "deprecated"
        ),
        filteredCommand(
            "orders-supported",
            ["supported-orders"],
            "List supported order records.",
            "supported"
        ),
        {
            name: "orders-summary",
            aliases: [
                "order-summary"
            ],
            category: "taxonomy",
            description:
                "Summarize orders by rank, status, class, subclass, superorder, order, suborder, infraorder, parvorder, child family, provider, source, geography, and descendant counts.",
            usage:
                "orders-summary [filters]",
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
            name: "orders-status",
            category: "taxonomy",
            description:
                "Show orders service status.",
            usage:
                "orders-status",
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
        OrdersService,
        normalizeParameters,
        normalizeRecord,
        normalizeResponse,
        normalizeStringArray: stringArray,
        normalizeTaxonomicStatus: taxonomicStatus,
        normalizeRelations,
        normalizeLineage,
        findOrder,
        summarize,
        parseCommandArguments,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalOrders = api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules || {};

    window.SpeciedexTerminalModules[
        MODULE_NAME
    ] = api;

    emit(
        document,
        "speciedex:terminal-module-available",
        {
            name: MODULE_NAME,
            module: api
        }
    );
})(window, document);
