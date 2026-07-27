/*
========================================================================
Speciedex.org
Terminal ProviderSpecies Module
========================================================================

Provider-associated species and taxonomic-record service for
SpeciedexTerminal.

Provides:

    • Validated provider-species API requests
    • Provider, taxon, rank, status, lineage, geography, source, and date filters
    • Normalized species and taxonomic records
    • Provider, rank, status, lineage, geography, source, habitat, and conservation summaries
    • TTL response caching and inflight-request deduplication
    • AbortSignal-aware request lifecycle tracking
    • Single-species retrieval with cache fallback
    • Accepted, synonym, extinct, threatened, endemic, native, introduced,
      invasive, verified, active, and provider-specific views
    • Optional provider-worker duplicate, overlap, coverage, and health analysis
    • Idempotent service registration and safe teardown
    • Terminal command integration

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "ProviderSpecies";
    const VERSION = "3.0.0";
    const SERVICE_NAME = "provider-species";
    const WORKER_NAME = "provider";

    const DEFAULT_LIMIT = 50;
    const MIN_LIMIT = 1;
    const MAX_LIMIT = 1000;
    const DEFAULT_CACHE_TTL = 60000;
    const MAX_CACHE_ENTRIES = 128;

    const SORT_FIELDS = Object.freeze([
        "scientific_name",
        "canonical_name",
        "common_name",
        "provider",
        "provider_id",
        "rank",
        "status",
        "kingdom",
        "phylum",
        "class",
        "order",
        "family",
        "genus",
        "species",
        "subspecies",
        "conservation_status",
        "occurrence_count",
        "updated_at",
        "created_at",
        "id"
    ]);

    const FILTER_FIELDS = Object.freeze([
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
        "subspecies",
        "country",
        "region",
        "source",
        "license",
        "conservation_status",
        "habitat",
        "environment",
        "category",
        "type"
    ]);

    const BOOLEAN_FIELDS = Object.freeze([
        "accepted",
        "extinct",
        "threatened",
        "endemic",
        "native",
        "introduced",
        "invasive",
        "verified",
        "active"
    ]);

    function now() {
        return (
            window.performance &&
            typeof window.performance.now === "function"
        )
            ? window.performance.now()
            : Date.now();
    }

    function dispatch(target, name, detail, options = {}) {
        if (!target || typeof target.dispatchEvent !== "function") {
            return false;
        }

        try {
            return target.dispatchEvent(
                new CustomEvent(name, {
                    bubbles: options.bubbles === true,
                    cancelable: options.cancelable === true,
                    detail
                })
            );
        } catch (_error) {
            return false;
        }
    }

    function createError(message, code, name = "Error") {
        const error = new Error(message);
        error.name = name;
        error.code = code;
        return error;
    }

    function abortError(message = "Provider-species request aborted.") {
        return createError(
            message,
            "PROVIDER_SPECIES_ABORTED",
            "AbortError"
        );
    }

    function throwIfAborted(signal) {
        if (signal?.aborted) {
            throw signal.reason instanceof Error
                ? signal.reason
                : abortError();
        }
    }

    function normalizeText(value) {
        return String(value ?? "").trim();
    }

    function normalizeKey(value) {
        return normalizeText(value).toLowerCase();
    }

    function normalizeBoolean(value, fallback = null) {
        if (typeof value === "boolean") {
            return value;
        }

        if (typeof value === "number") {
            return value !== 0;
        }

        const normalized = normalizeKey(value);

        if (["true", "1", "yes", "on"].includes(normalized)) {
            return true;
        }

        if (["false", "0", "no", "off", ""].includes(normalized)) {
            return false;
        }

        return fallback;
    }

    function numericValue(value, fallback = 0) {
        const number = Number(value);
        return Number.isFinite(number) ? number : fallback;
    }

    function clampInteger(value, fallback, minimum, maximum) {
        const parsed = Number.parseInt(value, 10);

        if (!Number.isFinite(parsed)) {
            return fallback;
        }

        return Math.min(maximum, Math.max(minimum, parsed));
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
        const normalized = normalizeKey(
            value || "scientific_name"
        ).replace(/-/g, "_");

        if (!SORT_FIELDS.includes(normalized)) {
            throw new TypeError(
                `Unsupported provider-species sort field: ${value}`
            );
        }

        return normalized;
    }

    function normalizeDirection(value) {
        const normalized = normalizeKey(value || "asc");

        if (normalized !== "asc" && normalized !== "desc") {
            throw new TypeError(
                `Unsupported sort direction: ${value}`
            );
        }

        return normalized;
    }

    function normalizeStringArray(value) {
        if (Array.isArray(value)) {
            return [
                ...new Set(
                    value
                        .flatMap(item =>
                            typeof item === "string"
                                ? item.split(/[;,|]+/)
                                : [item]
                        )
                        .map(normalizeText)
                        .filter(Boolean)
                )
            ];
        }

        const text = normalizeText(value);

        if (!text) {
            return [];
        }

        return [
            ...new Set(
                text
                    .split(/[;,|]+/)
                    .map(normalizeText)
                    .filter(Boolean)
            )
        ];
    }

    function normalizeTaxonomicStatus(value) {
        const normalized = normalizeKey(value || "unknown");

        const aliases = {
            valid: "accepted",
            current: "accepted",
            canonical: "accepted",
            synonymized: "synonym",
            unaccepted: "synonym",
            uncertain: "unresolved",
            incertae_sedis: "unresolved",
            "incertae sedis": "unresolved"
        };

        return aliases[normalized] || normalized;
    }

    function normalizeConservationStatus(value) {
        const normalized = normalizeText(value)
            .toUpperCase()
            .replace(/\s+/g, " ");

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

    function normalizeParameters(parameters = {}) {
        const source =
            parameters && typeof parameters === "object"
                ? parameters
                : {};

        const normalized = {
            q: normalizeText(
                source.q ??
                source.query ??
                source.search ??
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
            sort: normalizeSort(source.sort),
            direction: normalizeDirection(
                source.direction ??
                source.order
            )
        };

        for (const field of FILTER_FIELDS) {
            const value = source[field];

            if (
                value !== undefined &&
                value !== null &&
                value !== ""
            ) {
                normalized[field] = normalizeText(value);
            }
        }

        for (const field of BOOLEAN_FIELDS) {
            const value = source[field];

            if (
                value === undefined ||
                value === null ||
                value === ""
            ) {
                continue;
            }

            const parsed = normalizeBoolean(value, null);

            if (parsed === null) {
                throw new TypeError(
                    `Invalid ${field} value: ${value}`
                );
            }

            normalized[field] = parsed;
        }

        const minimumOccurrences =
            source.minOccurrences ??
            source.min_occurrences ??
            source.minOccurrenceCount ??
            source.min_occurrence_count;

        const maximumOccurrences =
            source.maxOccurrences ??
            source.max_occurrences ??
            source.maxOccurrenceCount ??
            source.max_occurrence_count;

        if (
            minimumOccurrences !== undefined &&
            minimumOccurrences !== null &&
            minimumOccurrences !== ""
        ) {
            normalized.min_occurrences = clampInteger(
                minimumOccurrences,
                0,
                0,
                Number.MAX_SAFE_INTEGER
            );
        }

        if (
            maximumOccurrences !== undefined &&
            maximumOccurrences !== null &&
            maximumOccurrences !== ""
        ) {
            normalized.max_occurrences = clampInteger(
                maximumOccurrences,
                Number.MAX_SAFE_INTEGER,
                0,
                Number.MAX_SAFE_INTEGER
            );
        }

        if (
            normalized.min_occurrences !== undefined &&
            normalized.max_occurrences !== undefined &&
            normalized.min_occurrences >
            normalized.max_occurrences
        ) {
            throw new RangeError(
                "Minimum occurrence count must not exceed maximum occurrence count."
            );
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
            normalized.from = normalizeDate(from);
        }

        if (
            to !== undefined &&
            to !== null &&
            to !== ""
        ) {
            normalized.to = normalizeDate(to);
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

    function normalizeRecord(record, index = 0) {
        if (!record || typeof record !== "object") {
            const value = normalizeText(record);

            return {
                index,
                id: value,
                provider: "",
                provider_id: "",
                scientific_name: value,
                canonical_name: value,
                common_name: "",
                common_names: [],
                authorship: "",
                rank: "species",
                status: "unknown",
                accepted: false,
                accepted_name: "",
                accepted_id: "",
                kingdom: "",
                phylum: "",
                class: "",
                order: "",
                family: "",
                genus: "",
                species: "",
                subspecies: "",
                conservation_status: "",
                extinct: false,
                threatened: false,
                endemic: false,
                native: false,
                introduced: false,
                invasive: false,
                verified: false,
                active: true,
                countries: [],
                regions: [],
                habitats: [],
                environments: [],
                source: "",
                sources: [],
                license: "",
                occurrence_count: null,
                created_at: "",
                updated_at: ""
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
            normalizeBoolean(record.accepted, false) ||
            ["accepted", "valid", "canonical"].includes(status);

        const extinct =
            normalizeBoolean(record.extinct, false) ||
            ["EX", "EW"].includes(conservationStatus) ||
            status === "extinct";

        const threatened =
            normalizeBoolean(record.threatened, false) ||
            ["VU", "EN", "CR", "EW"].includes(
                conservationStatus
            );

        const active =
            normalizeBoolean(record.active, true) &&
            !normalizeBoolean(record.deleted, false) &&
            !["deleted", "inactive", "retired"].includes(status);

        const occurrenceCount =
            Number.isFinite(
                Number(
                    record.occurrence_count ??
                    record.occurrenceCount
                )
            )
                ? Math.max(
                    0,
                    Number(
                        record.occurrence_count ??
                        record.occurrenceCount
                    )
                )
                : null;

        return {
            ...record,
            index: record.index ?? index,
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
            scientific_name: scientificName,
            canonical_name: canonicalName,
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
            rank: normalizeKey(
                record.rank ??
                record.taxon_rank ??
                record.taxonRank ??
                "species"
            ),
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
            conservation_status: conservationStatus,
            extinct,
            threatened,
            endemic: normalizeBoolean(
                record.endemic ??
                record.is_endemic ??
                record.isEndemic,
                false
            ),
            native: normalizeBoolean(
                record.native ??
                record.is_native ??
                record.isNative,
                false
            ),
            introduced: normalizeBoolean(
                record.introduced ??
                record.is_introduced ??
                record.isIntroduced,
                false
            ),
            invasive: normalizeBoolean(
                record.invasive ??
                record.is_invasive ??
                record.isInvasive,
                false
            ),
            verified:
                normalizeBoolean(record.verified, false) ||
                ["verified", "confirmed"].includes(
                    normalizeKey(
                        record.verification_status ??
                        record.verificationStatus
                    )
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
            occurrence_count: occurrenceCount,
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

    function incrementMap(map, value) {
        const key = normalizeText(value) || "unknown";
        map.set(key, (map.get(key) || 0) + 1);
    }

    function sortedObject(map) {
        return Object.fromEntries(
            [...map.entries()].sort((left, right) =>
                right[1] - left[1] ||
                left[0].localeCompare(
                    right[0],
                    undefined,
                    {
                        numeric: true,
                        sensitivity: "base"
                    }
                )
            )
        );
    }

    function percentile(values, fraction) {
        const numbers = values
            .map(Number)
            .filter(Number.isFinite)
            .sort((left, right) => left - right);

        if (!numbers.length) {
            return null;
        }

        if (numbers.length === 1) {
            return numbers[0];
        }

        const position =
            (numbers.length - 1) * fraction;

        const lower = Math.floor(position);
        const upper = Math.ceil(position);

        if (lower === upper) {
            return numbers[lower];
        }

        const weight = position - lower;

        return (
            numbers[lower] * (1 - weight) +
            numbers[upper] * weight
        );
    }

    function occurrenceSummary(records) {
        const values = records
            .map(item => item.occurrence_count)
            .filter(Number.isFinite);

        if (!values.length) {
            return {
                count: 0,
                total: 0,
                minimum: null,
                maximum: null,
                average: null,
                median: null,
                p95: null
            };
        }

        const total = values.reduce(
            (sum, value) => sum + value,
            0
        );

        return {
            count: values.length,
            total,
            minimum: Math.min(...values),
            maximum: Math.max(...values),
            average: total / values.length,
            median: percentile(values, 0.5),
            p95: percentile(values, 0.95)
        };
    }

    function summarize(records) {
        const values = Array.isArray(records)
            ? records
            : [];

        const providers = new Map();
        const ranks = new Map();
        const statuses = new Map();
        const kingdoms = new Map();
        const phyla = new Map();
        const classes = new Map();
        const orders = new Map();
        const families = new Map();
        const genera = new Map();
        const countries = new Map();
        const regions = new Map();
        const sources = new Map();
        const licenses = new Map();
        const conservationStatuses = new Map();
        const habitats = new Map();
        const environments = new Map();

        for (const item of values) {
            incrementMap(providers, item.provider);
            incrementMap(ranks, item.rank);
            incrementMap(statuses, item.status);
            incrementMap(kingdoms, item.kingdom);
            incrementMap(phyla, item.phylum);
            incrementMap(classes, item.class);
            incrementMap(orders, item.order);
            incrementMap(families, item.family);
            incrementMap(genera, item.genus);
            incrementMap(conservationStatuses, item.conservation_status);
            incrementMap(licenses, item.license);

            for (const country of item.countries || []) {
                incrementMap(countries, country);
            }

            for (const region of item.regions || []) {
                incrementMap(regions, region);
            }

            for (const source of item.sources || []) {
                incrementMap(sources, source);
            }

            for (const habitat of item.habitats || []) {
                incrementMap(habitats, habitat);
            }

            for (const environment of item.environments || []) {
                incrementMap(environments, environment);
            }
        }

        const accepted = values.filter(
            item => item.accepted
        ).length;

        const verified = values.filter(
            item => item.verified
        ).length;

        const active = values.filter(
            item => item.active
        ).length;

        return {
            total: values.length,
            accepted,
            synonyms: values.filter(
                item => item.status === "synonym"
            ).length,
            unresolved: values.filter(
                item => item.status === "unresolved"
            ).length,
            doubtful: values.filter(
                item => item.status === "doubtful"
            ).length,
            extinct: values.filter(item => item.extinct).length,
            threatened: values.filter(item => item.threatened).length,
            endemic: values.filter(item => item.endemic).length,
            native: values.filter(item => item.native).length,
            introduced: values.filter(item => item.introduced).length,
            invasive: values.filter(item => item.invasive).length,
            verified,
            unverified: values.length - verified,
            active,
            inactive: values.length - active,
            acceptanceRate:
                values.length
                    ? accepted / values.length
                    : 0,
            verificationRate:
                values.length
                    ? verified / values.length
                    : 0,
            occurrences: occurrenceSummary(values),
            providers: sortedObject(providers),
            ranks: sortedObject(ranks),
            statuses: sortedObject(statuses),
            kingdoms: sortedObject(kingdoms),
            phyla: sortedObject(phyla),
            classes: sortedObject(classes),
            orders: sortedObject(orders),
            families: sortedObject(families),
            genera: sortedObject(genera),
            countries: sortedObject(countries),
            regions: sortedObject(regions),
            sources: sortedObject(sources),
            licenses: sortedObject(licenses),
            conservationStatuses:
                sortedObject(conservationStatuses),
            habitats: sortedObject(habitats),
            environments: sortedObject(environments)
        };
    }

    function enrichPagination(result) {
        const limit = Math.max(
            0,
            numericValue(result.limit, 0)
        );

        const offset = Math.max(
            0,
            numericValue(result.offset, 0)
        );

        const total = Math.max(
            0,
            numericValue(result.total, 0)
        );

        const returned = result.records.length;

        return {
            ...result,
            returned,
            page:
                limit > 0
                    ? Math.floor(offset / limit) + 1
                    : 1,
            pages:
                limit > 0
                    ? Math.ceil(total / limit)
                    : (total > 0 ? 1 : 0),
            hasPrevious: offset > 0,
            hasNext: offset + returned < total
        };
    }

    function normalizeResponse(payload) {
        if (Array.isArray(payload)) {
            const records = payload.map(normalizeRecord);

            return enrichPagination({
                records,
                total: records.length,
                limit: records.length,
                offset: 0,
                summary: summarize(records),
                raw: payload
            });
        }

        if (payload && typeof payload === "object") {
            const values =
                payload.records ??
                payload.items ??
                payload.species ??
                payload.taxa ??
                payload.results ??
                payload.rows ??
                payload.data ??
                [];

            const records = Array.isArray(values)
                ? values.map(normalizeRecord)
                : [];

            return enrichPagination({
                records,
                total:
                    Number.isFinite(Number(payload.total))
                        ? Number(payload.total)
                        : records.length,
                limit:
                    Number.isFinite(Number(payload.limit))
                        ? Number(payload.limit)
                        : records.length,
                offset:
                    Number.isFinite(Number(payload.offset))
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
                    payload.next_page ??
                    null,
                previous:
                    payload.previous ??
                    payload.previousPage ??
                    payload.previous_page ??
                    null,
                raw: payload
            });
        }

        return enrichPagination({
            records: [],
            total: 0,
            limit: 0,
            offset: 0,
            summary: summarize([]),
            raw: payload
        });
    }

    function stableStringify(value) {
        if (value === null || typeof value !== "object") {
            return JSON.stringify(value);
        }

        if (Array.isArray(value)) {
            return `[${value.map(stableStringify).join(",")}]`;
        }

        return `{${Object.keys(value)
            .sort()
            .map(key =>
                `${JSON.stringify(key)}:${stableStringify(value[key])}`
            )
            .join(",")}}`;
    }

    function cacheKey(parameters) {
        return stableStringify(parameters);
    }

    function clone(value) {
        if (typeof structuredClone === "function") {
            try {
                return structuredClone(value);
            } catch (_error) {
                /* Fall through. */
            }
        }

        return JSON.parse(JSON.stringify(value));
    }

    class ProviderSpeciesService extends EventTarget {
        constructor(context, options = {}) {
            super();

            if (!context || typeof context !== "object") {
                throw new TypeError(
                    "A terminal context is required."
                );
            }

            this.context = context;
            this.destroyed = false;
            this.cache = new Map();
            this.inflight = new Map();
            this.requests = new Map();
            this.sequence = 0;
            this.cacheTTL = clampInteger(
                options.cacheTTL ??
                options.cache_ttl,
                DEFAULT_CACHE_TTL,
                0,
                Number.MAX_SAFE_INTEGER
            );
            this.workerName = normalizeText(
                options.workerName ??
                options.worker_name ??
                WORKER_NAME
            );
        }

        ensureAvailable() {
            if (this.destroyed) {
                throw createError(
                    "Provider-species service has been destroyed.",
                    "PROVIDER_SPECIES_DESTROYED"
                );
            }

            if (
                !this.context.api ||
                typeof this.context.api.get !== "function"
            ) {
                throw createError(
                    "Speciedex API client is unavailable.",
                    "PROVIDER_SPECIES_API_UNAVAILABLE"
                );
            }
        }

        emit(name, detail) {
            dispatch(this, name, detail);

            try {
                this.context.events?.emit?.(
                    `provider-species:${name}`,
                    detail
                );
            } catch (_error) {
                /* Observer failures are isolated. */
            }

            dispatch(
                this.context.root,
                `speciedex:terminal-provider-species-${name}`,
                detail,
                { bubbles: true }
            );
        }

        createRequest(operation, detail = {}) {
            const id =
                `provider-species:${Date.now()}:${++this.sequence}`;

            const request = {
                id,
                operation,
                startedAt: now(),
                timestamp: new Date().toISOString(),
                ...detail
            };

            this.requests.set(id, request);
            return request;
        }

        finishRequest(request, result, error = null) {
            request.duration = now() - request.startedAt;
            request.completedAt = new Date().toISOString();
            request.error = error || null;
            request.result = result;
            this.requests.delete(request.id);
            return request;
        }

        getCached(parameters, options = {}) {
            const key = cacheKey(parameters);
            const entry = this.cache.get(key);

            if (!entry) {
                return null;
            }

            const ttl = clampInteger(
                options.cacheTTL ??
                options.cache_ttl,
                this.cacheTTL,
                0,
                Number.MAX_SAFE_INTEGER
            );

            if (
                ttl > 0 &&
                Date.now() - entry.timestamp > ttl
            ) {
                this.cache.delete(key);
                return null;
            }

            entry.hits += 1;
            entry.lastAccessed = Date.now();

            return clone(entry.value);
        }

        setCached(parameters, value) {
            const key = cacheKey(parameters);

            this.cache.set(key, {
                timestamp: Date.now(),
                lastAccessed: Date.now(),
                hits: 0,
                value: clone(value)
            });

            if (this.cache.size > MAX_CACHE_ENTRIES) {
                const oldest = [...this.cache.entries()]
                    .sort((left, right) =>
                        left[1].lastAccessed -
                        right[1].lastAccessed
                    )[0];

                if (oldest) {
                    this.cache.delete(oldest[0]);
                }
            }
        }

        clearCache() {
            const entries = this.cache.size;
            this.cache.clear();

            this.emit("cache-clear", {
                entries,
                timestamp: new Date().toISOString()
            });

            return entries;
        }

        async list(parameters = {}, options = {}) {
            this.ensureAvailable();

            const normalized = normalizeParameters(parameters);
            const signal = options.signal;
            const force = normalizeBoolean(
                options.force ??
                options.refresh,
                false
            );

            throwIfAborted(signal);

            if (!force) {
                const cached = this.getCached(
                    normalized,
                    options
                );

                if (cached) {
                    cached.cache = {
                        hit: true,
                        timestamp: new Date().toISOString()
                    };

                    this.emit("cache-hit", {
                        operation: "list",
                        parameters: normalized
                    });

                    return cached;
                }
            }

            const key = cacheKey(normalized);

            if (!force && this.inflight.has(key)) {
                return this.awaitWithSignal(
                    this.inflight.get(key),
                    signal
                );
            }

            const request = this.createRequest(
                "list",
                { parameters: normalized }
            );

            this.emit("request", {
                requestId: request.id,
                operation: "list",
                parameters: normalized
            });

            const operation = this.performList(
                normalized,
                options,
                request
            );

            this.inflight.set(key, operation);

            try {
                return await this.awaitWithSignal(
                    operation,
                    signal
                );
            } finally {
                if (this.inflight.get(key) === operation) {
                    this.inflight.delete(key);
                }
            }
        }

        async performList(normalized, options, request) {
            try {
                const payload = await this.context.api.get(
                    "providers/species",
                    normalized,
                    options
                );

                const result = normalizeResponse(payload);

                result.parameters = normalized;
                result.duration = now() - request.startedAt;
                result.cache = {
                    hit: false,
                    timestamp: new Date().toISOString()
                };

                this.setCached(normalized, result);
                this.finishRequest(request, result);

                this.emit("complete", {
                    requestId: request.id,
                    ...result
                });

                return result;
            } catch (error) {
                this.finishRequest(request, null, error);

                this.emit("error", {
                    requestId: request.id,
                    operation: "list",
                    error,
                    parameters: normalized,
                    duration: request.duration
                });

                throw error;
            }
        }

        awaitWithSignal(promise, signal) {
            if (!signal) {
                return promise;
            }

            throwIfAborted(signal);

            return new Promise((resolve, reject) => {
                const onAbort = () => {
                    reject(
                        signal.reason instanceof Error
                            ? signal.reason
                            : abortError()
                    );
                };

                signal.addEventListener(
                    "abort",
                    onAbort,
                    { once: true }
                );

                promise.then(
                    value => {
                        signal.removeEventListener(
                            "abort",
                            onAbort
                        );
                        resolve(value);
                    },
                    error => {
                        signal.removeEventListener(
                            "abort",
                            onAbort
                        );
                        reject(error);
                    }
                );
            });
        }

        async get(id, options = {}) {
            this.ensureAvailable();

            const normalizedId = normalizeText(id);

            if (!normalizedId) {
                throw new TypeError(
                    "A species or taxon ID is required."
                );
            }

            throwIfAborted(options.signal);

            const request = this.createRequest(
                "get",
                { taxon: normalizedId }
            );

            this.emit("request", {
                requestId: request.id,
                operation: "get",
                taxon: normalizedId
            });

            try {
                const payload = await this.context.api.get(
                    `providers/species/${encodeURIComponent(normalizedId)}`,
                    {},
                    options
                );

                const item = normalizeRecord(payload, 0);

                this.finishRequest(request, item);

                this.emit("complete", {
                    requestId: request.id,
                    operation: "get",
                    species: item
                });

                return item;
            } catch (error) {
                const match = this.findCachedSpecies(
                    normalizedId
                );

                if (match) {
                    this.finishRequest(request, match);

                    this.emit("fallback", {
                        requestId: request.id,
                        operation: "get",
                        species: match,
                        error
                    });

                    return match;
                }

                this.finishRequest(request, null, error);

                this.emit("error", {
                    requestId: request.id,
                    operation: "get",
                    taxon: normalizedId,
                    error
                });

                throw error;
            }
        }

        findCachedSpecies(id) {
            const normalizedId = normalizeKey(id);

            for (const entry of this.cache.values()) {
                const match = entry.value?.records?.find(
                    item =>
                        normalizeKey(item.id) === normalizedId ||
                        normalizeKey(item.scientific_name) === normalizedId ||
                        normalizeKey(item.canonical_name) === normalizedId
                );

                if (match) {
                    return clone(match);
                }
            }

            return null;
        }

        async accepted(parameters = {}, options = {}) {
            return this.filteredView(
                { ...parameters, accepted: true },
                item => item.accepted,
                options
            );
        }

        async synonyms(parameters = {}, options = {}) {
            return this.filteredView(
                { ...parameters, status: "synonym" },
                item => item.status === "synonym",
                options
            );
        }

        async extinct(parameters = {}, options = {}) {
            return this.filteredView(
                { ...parameters, extinct: true },
                item => item.extinct,
                options
            );
        }

        async threatened(parameters = {}, options = {}) {
            return this.filteredView(
                { ...parameters, threatened: true },
                item => item.threatened,
                options
            );
        }

        async endemic(parameters = {}, options = {}) {
            return this.filteredView(
                { ...parameters, endemic: true },
                item => item.endemic,
                options
            );
        }

        async native(parameters = {}, options = {}) {
            return this.filteredView(
                { ...parameters, native: true },
                item => item.native,
                options
            );
        }

        async introduced(parameters = {}, options = {}) {
            return this.filteredView(
                { ...parameters, introduced: true },
                item => item.introduced,
                options
            );
        }

        async invasive(parameters = {}, options = {}) {
            return this.filteredView(
                { ...parameters, invasive: true },
                item => item.invasive,
                options
            );
        }

        async verified(parameters = {}, options = {}) {
            return this.filteredView(
                { ...parameters, verified: true },
                item => item.verified,
                options
            );
        }

        async active(parameters = {}, options = {}) {
            return this.filteredView(
                { ...parameters, active: true },
                item => item.active,
                options
            );
        }

        async filteredView(parameters, predicate, options) {
            const result = await this.list(
                parameters,
                options
            );

            const records = result.records.filter(predicate);

            return {
                ...result,
                records,
                returned: records.length,
                summary: summarize(records)
            };
        }

        async byProvider(
            provider,
            parameters = {},
            options = {}
        ) {
            const normalizedProvider = normalizeText(provider);

            if (!normalizedProvider) {
                throw new TypeError(
                    "A provider ID or name is required."
                );
            }

            return this.list(
                {
                    ...parameters,
                    provider: normalizedProvider
                },
                options
            );
        }

        async summary(parameters = {}, options = {}) {
            const result = await this.list(
                {
                    ...parameters,
                    limit:
                        parameters.limit ??
                        MAX_LIMIT
                },
                options
            );

            return {
                parameters: result.parameters,
                summary: summarize(result.records),
                species: result.records,
                duration: result.duration,
                cache: result.cache
            };
        }

        async duplicates(parameters = {}, options = {}) {
            const result = await this.list(
                {
                    ...parameters,
                    limit:
                        parameters.limit ??
                        MAX_LIMIT
                },
                options
            );

            return this.callWorker(
                "duplicates",
                {
                    records: result.records,
                    fields: [
                        "canonical_name",
                        "rank",
                        "kingdom",
                        "family"
                    ]
                },
                options
            );
        }

        async overlap(parameters = {}, options = {}) {
            const result = await this.list(
                {
                    ...parameters,
                    limit:
                        parameters.limit ??
                        MAX_LIMIT
                },
                options
            );

            return this.callWorker(
                "overlap",
                {
                    records: result.records,
                    providerField: "provider_id",
                    identityFields: [
                        "canonical_name",
                        "rank"
                    ]
                },
                options
            );
        }

        async coverage(parameters = {}, options = {}) {
            const result = await this.list(
                {
                    ...parameters,
                    limit:
                        parameters.limit ??
                        MAX_LIMIT
                },
                options
            );

            return this.callWorker(
                "coverage",
                {
                    providers: summarizeByProvider(
                        result.records
                    )
                },
                options
            );
        }

        async health(parameters = {}, options = {}) {
            const result = await this.list(
                {
                    ...parameters,
                    limit:
                        parameters.limit ??
                        MAX_LIMIT
                },
                options
            );

            return this.callWorker(
                "health",
                {
                    providers: summarizeByProvider(
                        result.records
                    )
                },
                options
            );
        }

        async callWorker(type, payload, options = {}) {
            const workers =
                this.context.workers ??
                this.context.workerPool ??
                this.context.worker_pool;

            const candidates = [
                () => workers?.request?.(
                    this.workerName,
                    type,
                    payload,
                    options
                ),
                () => workers?.run?.(
                    this.workerName,
                    type,
                    payload,
                    options
                ),
                () => workers?.execute?.(
                    this.workerName,
                    type,
                    payload,
                    options
                ),
                () => workers?.call?.(
                    this.workerName,
                    type,
                    payload,
                    options
                ),
                () => this.context.services
                    ?.get?.("workers")
                    ?.request?.(
                        this.workerName,
                        type,
                        payload,
                        options
                    )
            ];

            for (const candidate of candidates) {
                try {
                    const result = candidate();

                    if (
                        result &&
                        typeof result.then === "function"
                    ) {
                        return await result;
                    }

                    if (result !== undefined) {
                        return result;
                    }
                } catch (error) {
                    if (error?.code === "WORKER_UNAVAILABLE") {
                        continue;
                    }

                    throw error;
                }
            }

            throw createError(
                "Provider worker service is unavailable.",
                "PROVIDER_SPECIES_WORKER_UNAVAILABLE"
            );
        }

        status() {
            return {
                version: VERSION,
                endpoint: "providers/species",
                service: SERVICE_NAME,
                worker: this.workerName,
                available: Boolean(
                    this.context.api &&
                    typeof this.context.api.get === "function"
                ),
                workerAvailable: Boolean(
                    this.context.workers ||
                    this.context.workerPool ||
                    this.context.worker_pool ||
                    this.context.services?.get?.("workers")
                ),
                cacheEntries: this.cache.size,
                cacheTTL: this.cacheTTL,
                inflight: this.inflight.size,
                activeRequests: this.requests.size,
                destroyed: this.destroyed
            };
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            const detail = {
                timestamp: new Date().toISOString(),
                cacheEntries: this.cache.size,
                inflight: this.inflight.size,
                activeRequests: this.requests.size
            };

            this.cache.clear();
            this.inflight.clear();
            this.requests.clear();
            this.destroyed = true;

            dispatch(this, "destroy", detail);

            try {
                this.context.unregisterService?.(
                    SERVICE_NAME
                );

                this.context.unregisterService?.(
                    "providerSpecies"
                );
            } catch (_error) {
                /* Teardown must remain safe. */
            }

            return true;
        }
    }

    function summarizeByProvider(records) {
        const providers = new Map();

        for (const item of records) {
            const key =
                item.provider_id ||
                item.provider ||
                "unknown";

            if (!providers.has(key)) {
                providers.set(key, {
                    id: key,
                    name: item.provider || key,
                    records: 0,
                    accepted: 0,
                    verified: 0,
                    active: 0,
                    threatened: 0,
                    extinct: 0,
                    occurrences: 0,
                    kingdoms: new Set(),
                    ranks: new Set()
                });
            }

            const provider = providers.get(key);

            provider.records += 1;

            if (item.accepted) {
                provider.accepted += 1;
            }

            if (item.verified) {
                provider.verified += 1;
            }

            if (item.active) {
                provider.active += 1;
            }

            if (item.threatened) {
                provider.threatened += 1;
            }

            if (item.extinct) {
                provider.extinct += 1;
            }

            if (Number.isFinite(item.occurrence_count)) {
                provider.occurrences += item.occurrence_count;
            }

            if (item.kingdom) {
                provider.kingdoms.add(item.kingdom);
            }

            if (item.rank) {
                provider.ranks.add(item.rank);
            }
        }

        return [...providers.values()].map(provider => ({
            ...provider,
            kingdoms: [...provider.kingdoms].sort(),
            ranks: [...provider.ranks].sort(),
            acceptanceRate:
                provider.records
                    ? provider.accepted /
                      provider.records
                    : 0,
            verificationRate:
                provider.records
                    ? provider.verified /
                      provider.records
                    : 0
        }));
    }

    function initialize(context, options = {}) {
        if (!context || typeof context !== "object") {
            throw new TypeError(
                "A terminal context is required."
            );
        }

        const existing =
            context.services?.get?.(SERVICE_NAME);

        if (
            existing instanceof ProviderSpeciesService &&
            !existing.destroyed
        ) {
            context.providerSpecies = existing;
            return existing;
        }

        if (
            context.providerSpecies instanceof ProviderSpeciesService &&
            !context.providerSpecies.destroyed
        ) {
            return context.providerSpecies;
        }

        const service = new ProviderSpeciesService(
            context,
            options
        );

        context.providerSpecies = service;

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
                service,
                version: VERSION
            }
        );

        return service;
    }

    function unmount(context) {
        const service =
            context?.providerSpecies ??
            context?.services?.get?.(SERVICE_NAME);

        if (!(service instanceof ProviderSpeciesService)) {
            return false;
        }

        const destroyed = service.destroy();

        if (context?.providerSpecies === service) {
            context.providerSpecies = null;
        }

        return destroyed;
    }

    function requireService(context) {
        const service =
            context?.providerSpecies ??
            context?.services?.get?.(SERVICE_NAME);

        if (!(service instanceof ProviderSpeciesService)) {
            throw createError(
                "Provider-species service is unavailable.",
                "PROVIDER_SPECIES_SERVICE_UNAVAILABLE"
            );
        }

        return service;
    }

    function parseCommandArguments(args = []) {
        const parameters = {};
        const positional = [];

        for (let index = 0; index < args.length; index += 1) {
            const argument = normalizeText(args[index]);

            if (!argument) {
                continue;
            }

            const booleanFlags = {
                "--accepted": ["accepted", true],
                "--unaccepted": ["accepted", false],
                "--extinct": ["extinct", true],
                "--extant": ["extinct", false],
                "--threatened": ["threatened", true],
                "--not-threatened": ["threatened", false],
                "--endemic": ["endemic", true],
                "--not-endemic": ["endemic", false],
                "--native": ["native", true],
                "--not-native": ["native", false],
                "--introduced": ["introduced", true],
                "--not-introduced": ["introduced", false],
                "--invasive": ["invasive", true],
                "--not-invasive": ["invasive", false],
                "--verified": ["verified", true],
                "--unverified": ["verified", false],
                "--active": ["active", true],
                "--inactive": ["active", false]
            };

            if (booleanFlags[argument]) {
                const [field, value] = booleanFlags[argument];
                parameters[field] = value;
                continue;
            }

            if (argument.startsWith("--")) {
                const equals = argument.indexOf("=");
                let name;
                let value;

                if (equals >= 0) {
                    name = argument.slice(2, equals);
                    value = argument.slice(equals + 1);
                } else {
                    name = argument.slice(2);
                    value = args[index + 1];

                    if (
                        value !== undefined &&
                        !String(value).startsWith("--")
                    ) {
                        index += 1;
                    } else {
                        value = "";
                    }
                }

                const normalizedName = name.replace(/-/g, "_");

                const aliases = {
                    query: "q",
                    order: "direction",
                    since: "from",
                    start: "from",
                    until: "to",
                    end: "to",
                    minoccurrences: "min_occurrences",
                    maxoccurrences: "max_occurrences",
                    minoccurrencecount: "min_occurrences",
                    maxoccurrencecount: "max_occurrences"
                };

                parameters[
                    aliases[normalizedName] ??
                    normalizedName
                ] = value;

                continue;
            }

            positional.push(argument);
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
        if (typeof writeJSON === "function") {
            return writeJSON(value);
        }

        return value;
    }

    function filteredCommand(
        name,
        aliases,
        description,
        method
    ) {
        return {
            name,
            aliases,
            category: "providers",
            description,
            usage: `${name} [filters]`,
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context)[method](
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        };
    }

    const commands = [
        {
            name: "provider-species",
            aliases: ["providers-species"],
            category: "providers",
            description:
                "List species associated with a provider.",
            usage:
                "provider-species [query] [limit] [--provider=ID] [--taxon=ID] [--scientific-name=NAME] [--canonical-name=NAME] [--common-name=NAME] [--rank=RANK] [--status=STATUS] [--kingdom=KINGDOM] [--phylum=PHYLUM] [--class=CLASS] [--order=ORDER] [--family=FAMILY] [--genus=GENUS] [--species=SPECIES] [--subspecies=SUBSPECIES] [--country=COUNTRY] [--region=REGION] [--source=SOURCE] [--license=LICENSE] [--conservation-status=STATUS] [--habitat=HABITAT] [--environment=ENVIRONMENT] [--accepted|--unaccepted] [--extinct|--extant] [--threatened|--not-threatened] [--endemic|--not-endemic] [--native|--not-native] [--introduced|--not-introduced] [--invasive|--not-invasive] [--verified|--unverified] [--active|--inactive] [--min-occurrences=N] [--max-occurrences=N] [--from=DATE] [--to=DATE] [--sort=FIELD] [--direction=asc|desc] [--offset=N]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).list(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "provider-species-get",
            aliases: ["provider-taxon"],
            category: "providers",
            description:
                "Retrieve one provider species or taxon record by ID or scientific name.",
            usage:
                "provider-species-get <id|scientific-name>",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) => {
                const id = args.join(" ").trim();

                if (!id) {
                    throw new Error(
                        "A species ID or scientific name is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(context).get(
                        id,
                        { signal }
                    )
                );
            }
        },
        filteredCommand(
            "provider-species-accepted",
            ["accepted-provider-species"],
            "List accepted provider species records.",
            "accepted"
        ),
        filteredCommand(
            "provider-species-synonyms",
            ["synonym-provider-species"],
            "List provider species synonym records.",
            "synonyms"
        ),
        filteredCommand(
            "provider-species-extinct",
            ["extinct-provider-species"],
            "List extinct provider species records.",
            "extinct"
        ),
        filteredCommand(
            "provider-species-threatened",
            ["threatened-provider-species"],
            "List threatened provider species records.",
            "threatened"
        ),
        filteredCommand(
            "provider-species-endemic",
            ["endemic-provider-species"],
            "List endemic provider species records.",
            "endemic"
        ),
        filteredCommand(
            "provider-species-native",
            ["native-provider-species"],
            "List native provider species records.",
            "native"
        ),
        filteredCommand(
            "provider-species-introduced",
            ["introduced-provider-species"],
            "List introduced provider species records.",
            "introduced"
        ),
        filteredCommand(
            "provider-species-invasive",
            ["invasive-provider-species"],
            "List invasive provider species records.",
            "invasive"
        ),
        {
            name: "provider-species-summary",
            aliases: ["provider-taxa-summary"],
            category: "providers",
            description:
                "Summarize provider species by provider, rank, status, lineage, geography, source, habitat, occurrence, and conservation state.",
            usage:
                "provider-species-summary [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).summary(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "provider-species-duplicates",
            aliases: ["provider-taxa-duplicates"],
            category: "providers",
            description:
                "Analyze duplicate provider species records using the provider worker.",
            usage:
                "provider-species-duplicates [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).duplicates(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "provider-species-overlap",
            aliases: ["provider-taxa-overlap"],
            category: "providers",
            description:
                "Analyze provider species overlap using the provider worker.",
            usage:
                "provider-species-overlap [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).overlap(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "provider-species-coverage",
            aliases: ["provider-taxa-coverage"],
            category: "providers",
            description:
                "Analyze provider species coverage using the provider worker.",
            usage:
                "provider-species-coverage [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(context).coverage(
                        parseCommandArguments(args),
                        { signal }
                    )
                )
        },
        {
            name: "provider-species-cache-clear",
            aliases: ["provider-taxa-cache-clear"],
            category: "providers",
            description:
                "Clear the provider-species response cache.",
            usage:
                "provider-species-cache-clear",
            handler: ({ context, writeJSON }) =>
                writeJSONValue(
                    writeJSON,
                    {
                        cleared:
                            requireService(context)
                                .clearCache()
                    }
                )
        },
        {
            name: "provider-species-status",
            category: "providers",
            description:
                "Show provider-species service status.",
            usage:
                "provider-species-status",
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
        workerName: WORKER_NAME,
        ProviderSpeciesService,
        normalizeParameters,
        normalizeRecord,
        normalizeResponse,
        normalizeStringArray,
        normalizeTaxonomicStatus,
        normalizeConservationStatus,
        occurrenceSummary,
        summarize,
        summarizeByProvider,
        parseCommandArguments,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        unmount,
        destroy: unmount,
        commands
    });

    window.SpeciedexTerminalProviderSpecies = api;

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
            module: api,
            version: VERSION
        }
    );
})(window, document);
