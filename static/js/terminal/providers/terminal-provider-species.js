/*
========================================================================
Speciedex.org
Terminal ProviderSpecies Module
========================================================================

Provider-associated species service for SpeciedexTerminal.

Provides:

    • Validated provider-species API requests
    • Provider, taxon, rank, status, kingdom, country, source, and date filters
    • Normalized species and taxonomic records
    • Provider, rank, status, kingdom, country, source, and conservation summaries
    • Single-species retrieval
    • Accepted, extinct, threatened, endemic, and provider-specific views
    • Lifecycle events, caching, and resilient service registration
    • Terminal command integration

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "ProviderSpecies";
    const VERSION = "2.0.0";
    const SERVICE_NAME = "provider-species";

    const DEFAULT_LIMIT = 50;
    const MIN_LIMIT = 1;
    const MAX_LIMIT = 1000;

    function dispatch(target, name, detail, options = {}) {
        if (
            !target ||
            typeof target.dispatchEvent !== "function"
        ) {
            return false;
        }

        try {
            return target.dispatchEvent(
                new CustomEvent(
                    name,
                    {
                        bubbles:
                            options.bubbles === true,
                        cancelable:
                            options.cancelable === true,
                        detail
                    }
                )
            );
        } catch (_error) {
            return false;
        }
    }

    function normalizeText(value) {
        return String(value ?? "").trim();
    }

    function clampInteger(value, fallback, minimum, maximum) {
        const parsed = Number.parseInt(value, 10);

        if (!Number.isFinite(parsed)) {
            return fallback;
        }

        return Math.min(
            maximum,
            Math.max(minimum, parsed)
        );
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
            throw new TypeError(
                `Invalid date value: ${value}`
            );
        }

        return new Date(timestamp).toISOString();
    }

    function normalizeSort(value) {
        const normalized = normalizeText(
            value || "scientific_name"
        ).toLowerCase();

        const allowed = new Set([
            "scientific_name",
            "canonical_name",
            "common_name",
            "provider",
            "rank",
            "status",
            "kingdom",
            "phylum",
            "class",
            "order",
            "family",
            "genus",
            "species",
            "conservation_status",
            "updated_at",
            "created_at",
            "id"
        ]);

        if (!allowed.has(normalized)) {
            throw new TypeError(
                `Unsupported provider-species sort field: ${value}`
            );
        }

        return normalized;
    }

    function normalizeDirection(value) {
        const normalized = normalizeText(
            value || "asc"
        ).toLowerCase();

        if (
            normalized !== "asc" &&
            normalized !== "desc"
        ) {
            throw new TypeError(
                `Unsupported sort direction: ${value}`
            );
        }

        return normalized;
    }

    function normalizeParameters(parameters = {}) {
        const source =
            parameters &&
            typeof parameters === "object"
                ? parameters
                : {};

        const normalized = {
            q: normalizeText(
                source.q ??
                source.query ??
                ""
            ),
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
            sort: normalizeSort(
                source.sort
            ),
            direction: normalizeDirection(
                source.direction ??
                source.order
            )
        };

        for (
            const key of
            [
                "provider",
                "provider_id",
                "taxon",
                "taxon_id",
                "species_id",
                "scientific_name",
                "canonical_name",
                "common_name",
                "rank",
                "status",
                "kingdom",
                "phylum",
                "class",
                "order",
                "family",
                "genus",
                "species",
                "country",
                "region",
                "source",
                "license",
                "conservation_status",
                "habitat",
                "environment",
                "category",
                "type"
            ]
        ) {
            if (
                source[key] !== undefined &&
                source[key] !== null &&
                source[key] !== ""
            ) {
                normalized[key] =
                    normalizeText(source[key]);
            }
        }

        for (
            const key of
            [
                "accepted",
                "extinct",
                "threatened",
                "endemic",
                "native",
                "introduced",
                "invasive",
                "verified",
                "active"
            ]
        ) {
            if (
                source[key] !== undefined &&
                source[key] !== null &&
                source[key] !== ""
            ) {
                const value = normalizeBoolean(
                    source[key],
                    null
                );

                if (value === null) {
                    throw new TypeError(
                        `Invalid ${key} value: ${source[key]}`
                    );
                }

                normalized[key] = value;
            }
        }

        const from =
            source.from ??
            source.since ??
            source.start;

        const to =
            source.to ??
            source.until ??
            source.end;

        if (
            from !== undefined &&
            from !== null &&
            from !== ""
        ) {
            normalized.from =
                normalizeDate(from);
        }

        if (
            to !== undefined &&
            to !== null &&
            to !== ""
        ) {
            normalized.to =
                normalizeDate(to);
        }

        if (
            normalized.from &&
            normalized.to &&
            Date.parse(normalized.from) >
            Date.parse(normalized.to)
        ) {
            throw new RangeError(
                "Provider-species start date must not be later than the end date."
            );
        }

        return normalized;
    }

    function normalizeStringArray(value) {
        if (Array.isArray(value)) {
            return [
                ...new Set(
                    value
                        .map(normalizeText)
                        .filter(Boolean)
                )
            ];
        }

        const text = normalizeText(value);

        return text
            ? [
                ...new Set(
                    text
                        .split(/[;,|]+/)
                        .map(normalizeText)
                        .filter(Boolean)
                )
            ]
            : [];
    }

    function normalizeTaxonomicStatus(value) {
        const normalized =
            normalizeText(
                value || "unknown"
            ).toLowerCase();

        const aliases = {
            valid: "accepted",
            current: "accepted",
            synonymized: "synonym",
            doubtful: "doubtful",
            uncertain: "unresolved",
            unaccepted: "synonym"
        };

        return aliases[normalized] || normalized;
    }

    function normalizeConservationStatus(value) {
        const normalized =
            normalizeText(value)
                .toUpperCase();

        const aliases = {
            "LEAST CONCERN": "LC",
            "NEAR THREATENED": "NT",
            "VULNERABLE": "VU",
            "ENDANGERED": "EN",
            "CRITICALLY ENDANGERED": "CR",
            "EXTINCT IN THE WILD": "EW",
            "EXTINCT": "EX",
            "DATA DEFICIENT": "DD",
            "NOT EVALUATED": "NE"
        };

        return aliases[normalized] || normalized;
    }

    function normalizeRecord(record, index = 0) {
        if (
            !record ||
            typeof record !== "object"
        ) {
            return {
                index,
                id:
                    normalizeText(record),
                provider: "",
                scientific_name:
                    normalizeText(record),
                canonical_name:
                    normalizeText(record),
                common_names: [],
                rank: "species",
                status: "unknown",
                accepted: false,
                extinct: false,
                threatened: false,
                endemic: false,
                native: false,
                introduced: false,
                invasive: false,
                verified: false,
                active: true,
                sources: [],
                countries: []
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

        const status = normalizeTaxonomicStatus(
            record.status ??
            record.taxonomic_status ??
            record.taxonomicStatus ??
            record.acceptance_status ??
            record.acceptanceStatus
        );

        const conservationStatus =
            normalizeConservationStatus(
                record.conservation_status ??
                record.conservationStatus ??
                record.iucn_status ??
                record.iucnStatus ??
                ""
            );

        const accepted =
            record.accepted === true ||
            [
                "accepted",
                "valid"
            ].includes(status);

        const extinct =
            record.extinct === true ||
            [
                "EX",
                "EW"
            ].includes(
                conservationStatus
            ) ||
            status === "extinct";

        const threatened =
            record.threatened === true ||
            [
                "VU",
                "EN",
                "CR",
                "EW"
            ].includes(
                conservationStatus
            );

        const active =
            record.active !== false &&
            record.deleted !== true &&
            ![
                "deleted",
                "inactive"
            ].includes(status);

        return {
            ...record,
            index:
                record.index ??
                index,
            id: normalizeText(
                record.id ??
                record.taxon_id ??
                record.taxonId ??
                record.species_id ??
                record.speciesId ??
                record.uuid ??
                `provider-species-${index + 1}`
            ),
            provider: normalizeText(
                record.provider ??
                record.provider_name ??
                record.providerName ??
                record.provider_id ??
                record.providerId ??
                ""
            ),
            provider_id: normalizeText(
                record.provider_id ??
                record.providerId ??
                record.provider ??
                ""
            ),
            scientific_name:
                scientificName,
            canonical_name:
                canonicalName,
            common_name: normalizeText(
                record.common_name ??
                record.commonName ??
                ""
            ),
            common_names: normalizeStringArray(
                record.common_names ??
                record.commonNames ??
                record.vernacular_names ??
                record.vernacularNames ??
                record.common_name ??
                record.commonName
            ),
            authorship: normalizeText(
                record.authorship ??
                record.scientific_name_authorship ??
                record.scientificNameAuthorship ??
                ""
            ),
            rank: normalizeText(
                record.rank ??
                record.taxon_rank ??
                record.taxonRank ??
                "species"
            ).toLowerCase(),
            status,
            accepted,
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
            kingdom: normalizeText(
                record.kingdom ??
                ""
            ),
            phylum: normalizeText(
                record.phylum ??
                ""
            ),
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
            family: normalizeText(
                record.family ??
                ""
            ),
            genus: normalizeText(
                record.genus ??
                ""
            ),
            species: normalizeText(
                record.species ??
                record.specific_epithet ??
                record.specificEpithet ??
                ""
            ),
            subspecies: normalizeText(
                record.subspecies ??
                record.infraspecific_epithet ??
                record.infraspecificEpithet ??
                ""
            ),
            conservation_status:
                conservationStatus,
            extinct,
            threatened,
            endemic:
                record.endemic === true ||
                record.is_endemic === true ||
                record.isEndemic === true,
            native:
                record.native === true ||
                record.is_native === true ||
                record.isNative === true,
            introduced:
                record.introduced === true ||
                record.is_introduced === true ||
                record.isIntroduced === true,
            invasive:
                record.invasive === true ||
                record.is_invasive === true ||
                record.isInvasive === true,
            verified:
                record.verified === true ||
                [
                    "verified",
                    "confirmed"
                ].includes(
                    normalizeText(
                        record.verification_status ??
                        record.verificationStatus
                    ).toLowerCase()
                ),
            active,
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
            habitats: normalizeStringArray(
                record.habitats ??
                record.habitat
            ),
            environments: normalizeStringArray(
                record.environments ??
                record.environment
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
            occurrence_count: Number.isFinite(
                Number(
                    record.occurrence_count ??
                    record.occurrenceCount
                )
            )
                ? Number(
                    record.occurrence_count ??
                    record.occurrenceCount
                )
                : null,
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
        const normalized =
            normalizeText(key) ||
            "unknown";

        map.set(
            normalized,
            (
                map.get(normalized) ||
                0
            ) + 1
        );
    }

    function mapToSortedObject(map) {
        return Object.fromEntries(
            [...map.entries()]
                .sort(
                    (left, right) =>
                        right[1] -
                        left[1] ||
                        left[0].localeCompare(
                            right[0]
                        )
                )
        );
    }

    function summarize(records) {
        const values =
            Array.isArray(records)
                ? records
                : [];

        const providers = new Map();
        const ranks = new Map();
        const statuses = new Map();
        const kingdoms = new Map();
        const phyla = new Map();
        const families = new Map();
        const countries = new Map();
        const sources = new Map();
        const conservationStatuses = new Map();
        const habitats = new Map();

        let occurrenceCount = 0;

        for (const speciesRecord of values) {
            incrementMap(
                providers,
                speciesRecord.provider
            );

            incrementMap(
                ranks,
                speciesRecord.rank
            );

            incrementMap(
                statuses,
                speciesRecord.status
            );

            incrementMap(
                kingdoms,
                speciesRecord.kingdom
            );

            incrementMap(
                phyla,
                speciesRecord.phylum
            );

            incrementMap(
                families,
                speciesRecord.family
            );

            incrementMap(
                conservationStatuses,
                speciesRecord.conservation_status
            );

            for (
                const country of
                speciesRecord.countries || []
            ) {
                incrementMap(
                    countries,
                    country
                );
            }

            for (
                const source of
                speciesRecord.sources || []
            ) {
                incrementMap(
                    sources,
                    source
                );
            }

            for (
                const habitat of
                speciesRecord.habitats || []
            ) {
                incrementMap(
                    habitats,
                    habitat
                );
            }

            if (
                Number.isFinite(
                    speciesRecord.occurrence_count
                )
            ) {
                occurrenceCount +=
                    speciesRecord.occurrence_count;
            }
        }

        return {
            total:
                values.length,
            accepted:
                values.filter(
                    item =>
                        item.accepted
                ).length,
            extinct:
                values.filter(
                    item =>
                        item.extinct
                ).length,
            threatened:
                values.filter(
                    item =>
                        item.threatened
                ).length,
            endemic:
                values.filter(
                    item =>
                        item.endemic
                ).length,
            native:
                values.filter(
                    item =>
                        item.native
                ).length,
            introduced:
                values.filter(
                    item =>
                        item.introduced
                ).length,
            invasive:
                values.filter(
                    item =>
                        item.invasive
                ).length,
            verified:
                values.filter(
                    item =>
                        item.verified
                ).length,
            active:
                values.filter(
                    item =>
                        item.active
                ).length,
            occurrences:
                occurrenceCount,
            providers:
                mapToSortedObject(
                    providers
                ),
            ranks:
                mapToSortedObject(
                    ranks
                ),
            statuses:
                mapToSortedObject(
                    statuses
                ),
            kingdoms:
                mapToSortedObject(
                    kingdoms
                ),
            phyla:
                mapToSortedObject(
                    phyla
                ),
            families:
                mapToSortedObject(
                    families
                ),
            countries:
                mapToSortedObject(
                    countries
                ),
            sources:
                mapToSortedObject(
                    sources
                ),
            conservationStatuses:
                mapToSortedObject(
                    conservationStatuses
                ),
            habitats:
                mapToSortedObject(
                    habitats
                )
        };
    }

    function normalizeResponse(payload) {
        if (Array.isArray(payload)) {
            const records =
                payload.map(
                    normalizeRecord
                );

            return {
                records,
                total:
                    records.length,
                limit:
                    records.length,
                offset: 0,
                summary:
                    summarize(records),
                raw: payload
            };
        }

        if (
            payload &&
            typeof payload === "object"
        ) {
            const values =
                Array.isArray(payload.records)
                    ? payload.records
                    : (
                        Array.isArray(payload.items)
                            ? payload.items
                            : (
                                Array.isArray(payload.species)
                                    ? payload.species
                                    : (
                                        Array.isArray(payload.taxa)
                                            ? payload.taxa
                                            : []
                                    )
                            )
                    );

            const records =
                values.map(
                    normalizeRecord
                );

            return {
                records,
                total:
                    Number.isFinite(
                        Number(payload.total)
                    )
                        ? Number(payload.total)
                        : records.length,
                limit:
                    Number.isFinite(
                        Number(payload.limit)
                    )
                        ? Number(payload.limit)
                        : records.length,
                offset:
                    Number.isFinite(
                        Number(payload.offset)
                    )
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
            summary:
                summarize([]),
            raw: payload
        };
    }

    class ProviderSpeciesService extends EventTarget {
        constructor(context) {
            super();

            if (
                !context ||
                typeof context !== "object"
            ) {
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
                    "Provider-species service has been destroyed."
                );
            }

            if (
                !this.context.api ||
                typeof this.context.api.get !==
                "function"
            ) {
                throw new Error(
                    "Speciedex API client is unavailable."
                );
            }
        }

        emit(name, detail) {
            dispatch(
                this,
                name,
                detail
            );

            try {
                this.context.events?.emit?.(
                    `provider-species:${name}`,
                    detail
                );
            } catch (_error) {
                /*
                Observer failures must not break provider-species operations.
                */
            }

            dispatch(
                this.context.root,
                `speciedex:terminal-provider-species-${name}`,
                detail,
                {
                    bubbles: true
                }
            );
        }

        async list(parameters = {}, options = {}) {
            this.ensureAvailable();

            const normalized =
                normalizeParameters(
                    parameters
                );

            const startedAt =
                performance.now();

            this.emit(
                "request",
                {
                    operation:
                        "list",
                    parameters:
                        normalized
                }
            );

            try {
                const payload =
                    await this.context.api.get(
                        "providers/species",
                        normalized,
                        options
                    );

                const result =
                    normalizeResponse(
                        payload
                    );

                result.parameters =
                    normalized;

                result.duration =
                    performance.now() -
                    startedAt;

                this.cache =
                    result;

                this.cacheTimestamp =
                    Date.now();

                this.emit(
                    "complete",
                    result
                );

                return result;
            } catch (error) {
                this.emit(
                    "error",
                    {
                        operation:
                            "list",
                        error,
                        parameters:
                            normalized,
                        duration:
                            performance.now() -
                            startedAt
                    }
                );

                throw error;
            }
        }

        async get(id, options = {}) {
            this.ensureAvailable();

            const normalizedId =
                normalizeText(id);

            if (!normalizedId) {
                throw new TypeError(
                    "A species or taxon ID is required."
                );
            }

            try {
                const payload =
                    await this.context.api.get(
                        `providers/species/${encodeURIComponent(normalizedId)}`,
                        {},
                        options
                    );

                return normalizeRecord(
                    payload,
                    0
                );
            } catch (error) {
                const lower =
                    normalizedId.toLowerCase();

                const match =
                    this.cache?.records?.find(
                        item =>
                            item.id ===
                                normalizedId ||
                            item.scientific_name
                                .toLowerCase() ===
                                lower ||
                            item.canonical_name
                                .toLowerCase() ===
                                lower
                    );

                if (match) {
                    return match;
                }

                throw error;
            }
        }

        async accepted(parameters = {}, options = {}) {
            const result =
                await this.list(
                    {
                        ...parameters,
                        accepted: true
                    },
                    options
                );

            const records =
                result.records.filter(
                    item =>
                        item.accepted
                );

            return {
                ...result,
                records,
                summary:
                    summarize(records)
            };
        }

        async extinct(parameters = {}, options = {}) {
            const result =
                await this.list(
                    {
                        ...parameters,
                        extinct: true
                    },
                    options
                );

            const records =
                result.records.filter(
                    item =>
                        item.extinct
                );

            return {
                ...result,
                records,
                summary:
                    summarize(records)
            };
        }

        async threatened(parameters = {}, options = {}) {
            const result =
                await this.list(
                    {
                        ...parameters,
                        threatened: true
                    },
                    options
                );

            const records =
                result.records.filter(
                    item =>
                        item.threatened
                );

            return {
                ...result,
                records,
                summary:
                    summarize(records)
            };
        }

        async endemic(parameters = {}, options = {}) {
            const result =
                await this.list(
                    {
                        ...parameters,
                        endemic: true
                    },
                    options
                );

            const records =
                result.records.filter(
                    item =>
                        item.endemic
                );

            return {
                ...result,
                records,
                summary:
                    summarize(records)
            };
        }

        async byProvider(provider, parameters = {}, options = {}) {
            const normalizedProvider =
                normalizeText(provider);

            if (!normalizedProvider) {
                throw new TypeError(
                    "A provider ID or name is required."
                );
            }

            return this.list(
                {
                    ...parameters,
                    provider:
                        normalizedProvider
                },
                options
            );
        }

        async summary(parameters = {}, options = {}) {
            const result =
                await this.list(
                    {
                        ...parameters,
                        limit:
                            parameters.limit ??
                            MAX_LIMIT
                    },
                    options
                );

            return {
                parameters:
                    result.parameters,
                summary:
                    summarize(
                        result.records
                    ),
                species:
                    result.records
            };
        }

        status() {
            return {
                version: VERSION,
                endpoint:
                    "providers/species",
                service:
                    SERVICE_NAME,
                available:
                    Boolean(
                        this.context.api &&
                        typeof this.context.api.get ===
                        "function"
                    ),
                cached:
                    Boolean(this.cache),
                cacheAge:
                    this.cacheTimestamp
                        ? Date.now() -
                          this.cacheTimestamp
                        : null,
                destroyed:
                    this.destroyed
            };
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            this.cache = null;
            this.cacheTimestamp = 0;
            this.destroyed = true;

            dispatch(
                this,
                "destroy",
                {
                    timestamp:
                        new Date().toISOString()
                }
            );

            return true;
        }
    }

    function initialize(context) {
        const existing =
            context.services?.get?.(
                SERVICE_NAME
            );

        if (
            existing instanceof
            ProviderSpeciesService &&
            !existing.destroyed
        ) {
            context.providerSpecies =
                existing;

            return existing;
        }

        if (
            context.providerSpecies instanceof
            ProviderSpeciesService &&
            !context.providerSpecies.destroyed
        ) {
            return context.providerSpecies;
        }

        const service =
            new ProviderSpeciesService(
                context
            );

        context.providerSpecies =
            service;

        context.registerService?.(
            SERVICE_NAME,
            service
        );

        context.registerService?.(
            "providerSpecies",
            service
        );

        dispatch(
            document,
            "speciedex:terminal-provider-species-ready",
            {
                context,
                service
            }
        );

        return service;
    }

    function requireService(context) {
        const service =
            context?.providerSpecies ||
            context?.services?.get?.(
                SERVICE_NAME
            );

        if (
            !(
                service instanceof
                ProviderSpeciesService
            )
        ) {
            throw new Error(
                "Provider-species service is unavailable."
            );
        }

        return service;
    }

    function parseCommandArguments(args = []) {
        const parameters = {};
        const positional = [];

        for (const argument of args) {
            if (
                argument.startsWith(
                    "--limit="
                )
            ) {
                parameters.limit =
                    argument.slice(8);
                continue;
            }

            if (
                argument.startsWith(
                    "--offset="
                )
            ) {
                parameters.offset =
                    argument.slice(9);
                continue;
            }

            if (
                argument.startsWith(
                    "--provider="
                )
            ) {
                parameters.provider =
                    argument.slice(11);
                continue;
            }

            if (
                argument.startsWith(
                    "--taxon="
                )
            ) {
                parameters.taxon =
                    argument.slice(8);
                continue;
            }

            if (
                argument.startsWith(
                    "--scientific-name="
                )
            ) {
                parameters.scientific_name =
                    argument.slice(18);
                continue;
            }

            if (
                argument.startsWith(
                    "--canonical-name="
                )
            ) {
                parameters.canonical_name =
                    argument.slice(17);
                continue;
            }

            if (
                argument.startsWith(
                    "--common-name="
                )
            ) {
                parameters.common_name =
                    argument.slice(14);
                continue;
            }

            if (
                argument.startsWith(
                    "--rank="
                )
            ) {
                parameters.rank =
                    argument.slice(7);
                continue;
            }

            if (
                argument.startsWith(
                    "--status="
                )
            ) {
                parameters.status =
                    argument.slice(9);
                continue;
            }

            if (
                argument.startsWith(
                    "--kingdom="
                )
            ) {
                parameters.kingdom =
                    argument.slice(10);
                continue;
            }

            if (
                argument.startsWith(
                    "--phylum="
                )
            ) {
                parameters.phylum =
                    argument.slice(9);
                continue;
            }

            if (
                argument.startsWith(
                    "--class="
                )
            ) {
                parameters.class =
                    argument.slice(8);
                continue;
            }

            if (
                argument.startsWith(
                    "--order="
                )
            ) {
                parameters.order =
                    argument.slice(8);
                continue;
            }

            if (
                argument.startsWith(
                    "--family="
                )
            ) {
                parameters.family =
                    argument.slice(9);
                continue;
            }

            if (
                argument.startsWith(
                    "--genus="
                )
            ) {
                parameters.genus =
                    argument.slice(8);
                continue;
            }

            if (
                argument.startsWith(
                    "--species="
                )
            ) {
                parameters.species =
                    argument.slice(10);
                continue;
            }

            if (
                argument.startsWith(
                    "--country="
                )
            ) {
                parameters.country =
                    argument.slice(10);
                continue;
            }

            if (
                argument.startsWith(
                    "--region="
                )
            ) {
                parameters.region =
                    argument.slice(9);
                continue;
            }

            if (
                argument.startsWith(
                    "--source="
                )
            ) {
                parameters.source =
                    argument.slice(9);
                continue;
            }

            if (
                argument.startsWith(
                    "--license="
                )
            ) {
                parameters.license =
                    argument.slice(10);
                continue;
            }

            if (
                argument.startsWith(
                    "--conservation-status="
                )
            ) {
                parameters.conservation_status =
                    argument.slice(22);
                continue;
            }

            if (
                argument.startsWith(
                    "--habitat="
                )
            ) {
                parameters.habitat =
                    argument.slice(10);
                continue;
            }

            if (
                argument.startsWith(
                    "--environment="
                )
            ) {
                parameters.environment =
                    argument.slice(14);
                continue;
            }

            if (
                argument.startsWith(
                    "--accepted="
                )
            ) {
                parameters.accepted =
                    argument.slice(11);
                continue;
            }

            if (
                argument.startsWith(
                    "--extinct="
                )
            ) {
                parameters.extinct =
                    argument.slice(10);
                continue;
            }

            if (
                argument.startsWith(
                    "--threatened="
                )
            ) {
                parameters.threatened =
                    argument.slice(13);
                continue;
            }

            if (
                argument.startsWith(
                    "--endemic="
                )
            ) {
                parameters.endemic =
                    argument.slice(10);
                continue;
            }

            if (
                argument.startsWith(
                    "--native="
                )
            ) {
                parameters.native =
                    argument.slice(9);
                continue;
            }

            if (
                argument.startsWith(
                    "--introduced="
                )
            ) {
                parameters.introduced =
                    argument.slice(13);
                continue;
            }

            if (
                argument.startsWith(
                    "--invasive="
                )
            ) {
                parameters.invasive =
                    argument.slice(11);
                continue;
            }

            if (
                argument.startsWith(
                    "--verified="
                )
            ) {
                parameters.verified =
                    argument.slice(11);
                continue;
            }

            if (
                argument.startsWith(
                    "--active="
                )
            ) {
                parameters.active =
                    argument.slice(9);
                continue;
            }

            if (
                argument.startsWith(
                    "--from="
                )
            ) {
                parameters.from =
                    argument.slice(7);
                continue;
            }

            if (
                argument.startsWith(
                    "--to="
                )
            ) {
                parameters.to =
                    argument.slice(5);
                continue;
            }

            if (
                argument.startsWith(
                    "--sort="
                )
            ) {
                parameters.sort =
                    argument.slice(7);
                continue;
            }

            if (
                argument.startsWith(
                    "--direction="
                )
            ) {
                parameters.direction =
                    argument.slice(12);
                continue;
            }

            positional.push(argument);
        }

        if (positional.length) {
            parameters.q =
                positional[0];
        }

        if (
            positional[1] !==
            undefined
        ) {
            parameters.limit =
                positional[1];
        }

        return normalizeParameters(
            parameters
        );
    }

    function writeJSONValue(writeJSON, value) {
        if (
            typeof writeJSON ===
            "function"
        ) {
            return writeJSON(value);
        }

        return value;
    }

    const commands = [
        {
            name: "provider-species",
            aliases: [
                "providers-species"
            ],
            category: "providers",
            description:
                "List species associated with a provider.",
            usage:
                "provider-species [query] [limit] [--provider=ID] [--taxon=ID] [--scientific-name=NAME] [--canonical-name=NAME] [--common-name=NAME] [--rank=RANK] [--status=STATUS] [--kingdom=KINGDOM] [--phylum=PHYLUM] [--class=CLASS] [--order=ORDER] [--family=FAMILY] [--genus=GENUS] [--species=SPECIES] [--country=COUNTRY] [--region=REGION] [--source=SOURCE] [--license=LICENSE] [--conservation-status=STATUS] [--habitat=HABITAT] [--environment=ENVIRONMENT] [--accepted=true|false] [--extinct=true|false] [--threatened=true|false] [--endemic=true|false] [--native=true|false] [--introduced=true|false] [--invasive=true|false] [--verified=true|false] [--active=true|false] [--from=DATE] [--to=DATE] [--sort=FIELD] [--direction=asc|desc] [--offset=N]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                const result =
                    await requireService(
                        context
                    ).list(
                        parseCommandArguments(
                            args
                        )
                    );

                return writeJSONValue(
                    writeJSON,
                    result
                );
            }
        },
        {
            name: "provider-species-get",
            aliases: [
                "provider-taxon"
            ],
            category: "providers",
            description:
                "Retrieve one provider species or taxon record by ID or scientific name.",
            usage:
                "provider-species-get <id|scientific-name>",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                const id =
                    args.join(" ")
                        .trim();

                if (!id) {
                    throw new Error(
                        "A species ID or scientific name is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).get(id)
                );
            }
        },
        {
            name: "provider-species-accepted",
            aliases: [
                "accepted-provider-species"
            ],
            category: "providers",
            description:
                "List accepted provider species records.",
            usage:
                "provider-species-accepted [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).accepted(
                        parseCommandArguments(
                            args
                        )
                    )
                )
        },
        {
            name: "provider-species-extinct",
            aliases: [
                "extinct-provider-species"
            ],
            category: "providers",
            description:
                "List extinct provider species records.",
            usage:
                "provider-species-extinct [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).extinct(
                        parseCommandArguments(
                            args
                        )
                    )
                )
        },
        {
            name: "provider-species-threatened",
            aliases: [
                "threatened-provider-species"
            ],
            category: "providers",
            description:
                "List threatened provider species records.",
            usage:
                "provider-species-threatened [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).threatened(
                        parseCommandArguments(
                            args
                        )
                    )
                )
        },
        {
            name: "provider-species-endemic",
            aliases: [
                "endemic-provider-species"
            ],
            category: "providers",
            description:
                "List endemic provider species records.",
            usage:
                "provider-species-endemic [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).endemic(
                        parseCommandArguments(
                            args
                        )
                    )
                )
        },
        {
            name: "provider-species-summary",
            aliases: [
                "provider-taxa-summary"
            ],
            category: "providers",
            description:
                "Summarize provider species by provider, rank, status, kingdom, phylum, family, country, source, habitat, and conservation state.",
            usage:
                "provider-species-summary [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).summary(
                        parseCommandArguments(
                            args
                        )
                    )
                )
        },
        {
            name: "provider-species-status",
            category: "providers",
            description:
                "Show provider-species service status.",
            usage:
                "provider-species-status",
            handler: ({
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    requireService(
                        context
                    ).status()
                )
        }
    ];

    const api = Object.freeze({
        name: MODULE_NAME,
        version: VERSION,
        serviceName:
            SERVICE_NAME,
        ProviderSpeciesService,
        normalizeParameters,
        normalizeRecord,
        normalizeResponse,
        normalizeStringArray,
        normalizeTaxonomicStatus,
        normalizeConservationStatus,
        summarize,
        parseCommandArguments,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalProviderSpecies =
        api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules ||
        {};

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
