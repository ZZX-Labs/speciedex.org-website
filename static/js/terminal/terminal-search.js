/*
========================================================================
Speciedex.org
SpeciedexTerminal Search Engine and Search Commands
========================================================================

Provides the shared query parser, query planner, local evaluator, API client
integration, worker integration, output formatting, and search commands.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/
(function (window, document) {
    "use strict";

    const MODULE_NAME = "Search";
    const VERSION = "2.1.0";
    const DEFAULT_LIMIT = 50;
    const MAX_LIMIT = 1000;
    const MAX_WORKER_RECORDS = 250000;
    const DEFAULT_FUZZY_THRESHOLD = 2;
    const DEFAULT_CACHE_TTL = 5 * 60 * 1000;
    const DEFAULT_HISTORY_LIMIT = 250;
    const DEFAULT_SAVED_LIMIT = 100;
    const DEFAULT_STREAM_BATCH = 25;
    const SEARCH_STORAGE_PREFIX = "speciedex-terminal:search:";

    const FIELD_ALIASES = Object.freeze({
        id: "speciedex_id",
        key: "speciedex_id",
        sid: "speciedex_id",
        speciedex: "speciedex_id",
        speciedex_id: "speciedex_id",
        hash: "hash",
        checksum: "checksum",
        sha256: "sha256",
        sha512: "sha512",
        md5: "md5",
        cid: "cid",
        uuid: "uuid",
        taxid: "taxid",
        scientific: "scientific_name",
        scientific_name: "scientific_name",
        canonical: "scientific_name",
        name: "name",
        common: "common_name",
        common_name: "common_name",
        vernacular: "common_name",
        synonym: "synonyms",
        synonyms: "synonyms",
        rank: "rank",
        domain: "domain",
        kingdom: "kingdom",
        phylum: "phylum",
        class: "class",
        order: "order",
        family: "family",
        tribe: "tribe",
        genus: "genus",
        species: "species",
        subspecies: "subspecies",
        variety: "variety",
        form: "form",
        clade: "clade",
        provider: "provider",
        source: "provider",
        provider_id: "provider_id",
        country: "country",
        nation: "country",
        continent: "continent",
        state: "state",
        province: "state",
        county: "county",
        city: "city",
        locality: "locality",
        location: "location",
        island: "island",
        ocean: "ocean",
        sea: "sea",
        river: "river",
        lake: "lake",
        biome: "biome",
        habitat: "habitat",
        ecosystem: "ecosystem",
        conservation: "conservation_status",
        status: "conservation_status",
        iucn: "iucn_status",
        year: "year",
        author: "authority",
        authority: "authority",
        doi: "doi",
        gbif: "gbif_id",
        ncbi: "ncbi_id",
        itis: "itis_id",
        worms: "worms_id",
        col: "col_id",
        inat: "inat_id",
        iucn_id: "iucn_id",
        eol: "eol_id",
        bold: "bold_id",
        wikidata: "wikidata_id",
        wikipedia: "wikipedia",
        genome: "genome",
        gene: "gene",
        accession: "accession",
        volume: "volume",
        release: "release",
        updated: "updated_at",
        created: "created_at",
        confidence: "confidence",
        overlap: "overlap",
        latitude: "latitude",
        longitude: "longitude",
        elevation: "elevation",
        depth: "depth",
        accepted: "accepted",
        extinct: "extinct",
        invasive: "invasive",
        endemic: "endemic",
        marine: "marine",
        freshwater: "freshwater",
        terrestrial: "terrestrial",
        fossil: "fossil",
        image: "image",
        audio: "audio",
        has: "has"
    });

    const DEFAULT_TEXT_FIELDS = Object.freeze([
        "scientific_name",
        "common_name",
        "name",
        "canonical_name",
        "accepted_name",
        "synonyms",
        "authority",
        "description",
        "keywords",
        "tags",
        "country",
        "state",
        "locality",
        "continent",
        "habitat",
        "biome",
        "ecosystem",
        "provider",
        "speciedex_id"
    ]);

    const ID_PATTERNS = Object.freeze([
        ["sha256", /^[a-f0-9]{64}$/i],
        ["sha512", /^[a-f0-9]{128}$/i],
        ["md5", /^[a-f0-9]{32}$/i],
        ["uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i],
        ["doi", /^10\.\d{4,9}\/[-._;()/:a-z0-9]+$/i],
        ["wikidata_id", /^Q\d+$/i],
        ["speciedex_id", /^(?:spx|speciedex)[-_:][a-z0-9._:-]+$/i],
        ["bitcoin", /^(?:bc1|[13])[a-zA-HJ-NP-Z0-9]{20,}$/]
    ]);

    function normalizeText(value) {
        return String(value ?? "").trim();
    }

    function normalizeField(field) {
        const key = normalizeText(field).toLowerCase().replace(/-/g, "_");
        return FIELD_ALIASES[key] || key;
    }

    function tokenize(input) {
        const tokens = [];
        let current = "";
        let quote = null;
        let escaped = false;
        let regex = false;

        for (let index = 0; index < input.length; index += 1) {
            const character = input[index];

            if (escaped) {
                current += character;
                escaped = false;
                continue;
            }

            if (character === "\\") {
                current += character;
                escaped = true;
                continue;
            }

            if (quote) {
                current += character;

                if (character === quote) {
                    quote = null;
                }

                continue;
            }

            if (regex) {
                current += character;

                if (character === "/" && input[index - 1] !== "\\") {
                    regex = false;

                    while (/[gimsuy]/.test(input[index + 1] || "")) {
                        current += input[++index];
                    }
                }

                continue;
            }

            if (character === '"' || character === "'") {
                quote = character;
                current += character;
                continue;
            }

            if (character === "/" && !current) {
                regex = true;
                current += character;
                continue;
            }

            if (/\s/.test(character)) {
                if (current) {
                    tokens.push(current);
                    current = "";
                }

                continue;
            }

            current += character;
        }

        if (quote) {
            throw new Error("Unterminated quoted search value.");
        }

        if (regex) {
            throw new Error("Unterminated regular expression.");
        }

        if (escaped) {
            current += "\\";
        }

        if (current) {
            tokens.push(current);
        }

        return tokens;
    }

    function unquote(value) {
        const text = normalizeText(value);

        if (
            text.length >= 2 &&
            ((text.startsWith('"') && text.endsWith('"')) ||
             (text.startsWith("'") && text.endsWith("'")))
        ) {
            return text.slice(1, -1);
        }

        return text;
    }

    function parseRegex(value) {
        const match = normalizeText(value).match(/^\/(.*)\/([dgimsuvy]*)$/);

        if (!match) {
            return null;
        }

        try {
            return new RegExp(match[1], match[2]);
        } catch (error) {
            throw new Error(`Invalid regular expression: ${value}`);
        }
    }

    function detectIdentifier(value) {
        const text = normalizeText(value);

        for (const [field, pattern] of ID_PATTERNS) {
            if (pattern.test(text)) {
                return { field, value: text };
            }
        }

        return null;
    }

    function parseGeo(value) {
        const text = normalizeText(value);
        const pair = text.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);

        if (!pair) {
            return null;
        }

        const latitude = Number(pair[1]);
        const longitude = Number(pair[2]);

        if (
            latitude < -90 ||
            latitude > 90 ||
            longitude < -180 ||
            longitude > 180
        ) {
            return null;
        }

        return { latitude, longitude };
    }

    function parseBooleanValue(value) {
        const text = normalizeText(value).toLowerCase();

        if (["true", "yes", "1", "on"].includes(text)) {
            return true;
        }

        if (["false", "no", "0", "off"].includes(text)) {
            return false;
        }

        return null;
    }

    function parseDateValue(value) {
        const text = normalizeText(value);

        if (!text) {
            return null;
        }

        const timestamp = Date.parse(text);

        return Number.isFinite(timestamp)
            ? timestamp
            : null;
    }

    function parseValue(value) {
        const raw = unquote(value);
        const regex = parseRegex(raw);
        const geo = parseGeo(raw);

        return {
            raw,
            regex,
            geo,
            wildcard: raw.includes("*") || raw.includes("?"),
            number:
                raw !== "" &&
                Number.isFinite(Number(raw))
                    ? Number(raw)
                    : null,
            boolean:
                parseBooleanValue(raw),
            date:
                parseDateValue(raw)
        };
    }

    function parseTerm(token, negated = false) {
        const comparison = token.match(
            /^([a-zA-Z_][a-zA-Z0-9_-]*)(>=|<=|!=|=|>|<|:)(.+)$/
        );

        if (comparison) {
            const field = normalizeField(comparison[1]);
            const operator = comparison[2] === ":" ? "contains" : comparison[2];

            return {
                type: "term",
                field,
                operator,
                value: parseValue(comparison[3]),
                negated
            };
        }

        const identifier = detectIdentifier(unquote(token));

        if (identifier) {
            return {
                type: "term",
                field: identifier.field,
                operator: "=",
                value: parseValue(identifier.value),
                negated,
                inferred: true
            };
        }

        return {
            type: "text",
            fields: DEFAULT_TEXT_FIELDS,
            operator: "contains",
            value: parseValue(token),
            negated
        };
    }

    function parseQuery(input, options = {}) {
        const tokens = tokenize(normalizeText(input));
        const clauses = [];
        let join = "AND";
        let negated = false;

        for (let index = 0; index < tokens.length; index += 1) {
            const token = tokens[index];
            const upper = token.toUpperCase();

            if (upper === "AND" || upper === "OR") {
                join = upper;
                continue;
            }

            if (upper === "NOT") {
                negated = !negated;
                continue;
            }

            if (token.startsWith("--")) {
                continue;
            }

            if (token.startsWith("-") && token.length > 1) {
                clauses.push({
                    join,
                    ...parseTerm(token.slice(1), true)
                });
                join = "AND";
                continue;
            }

            clauses.push({
                join,
                ...parseTerm(token, negated)
            });

            join = "AND";
            negated = false;
        }

        return {
            raw: normalizeText(input),
            clauses,
            limit: Math.max(
                1,
                Math.min(MAX_LIMIT, Number(options.limit) || DEFAULT_LIMIT)
            ),
            offset: Math.max(0, Number(options.offset) || 0),
            page: Math.max(1, Number(options.page) || 1),
            sort: options.sort || null,
            order: String(options.order || "asc").toLowerCase() === "desc"
                ? "desc"
                : "asc",
            output: options.output || "table",
            fuzzy: options.fuzzy !== false,
            explain: options.explain === true
        };
    }

    function flatten(value) {
        if (Array.isArray(value)) {
            return value.flatMap(flatten);
        }

        if (value && typeof value === "object") {
            return Object.values(value).flatMap(flatten);
        }

        return [value];
    }

    function fieldValues(record, field) {
        const direct = record?.[field];

        if (direct !== undefined) {
            return flatten(direct);
        }

        const camel = field.replace(/_([a-z])/g, (_, character) =>
            character.toUpperCase()
        );

        if (record?.[camel] !== undefined) {
            return flatten(record[camel]);
        }

        if (field === "name") {
            return flatten([
                record?.scientific_name,
                record?.scientificName,
                record?.common_name,
                record?.commonName,
                record?.canonical_name,
                record?.canonicalName
            ]);
        }

        if (field === "location") {
            return flatten([
                record?.continent,
                record?.country,
                record?.state,
                record?.province,
                record?.county,
                record?.city,
                record?.locality,
                record?.island,
                record?.ocean,
                record?.sea,
                record?.river,
                record?.lake
            ]);
        }

        return [];
    }

    function normalizeRecord(record) {
        if (!record || typeof record !== "object") {
            return {};
        }

        return record;
    }

    function scoreField(field, exact = false) {
        const priorities = {
            speciedex_id: 120,
            scientific_name: 100,
            accepted_name: 95,
            canonical_name: 90,
            common_name: 80,
            synonyms: 70,
            provider_id: 65,
            taxid: 65,
            gbif_id: 65,
            ncbi_id: 65,
            itis_id: 65,
            worms_id: 65,
            col_id: 65,
            iucn_id: 65,
            wikidata_id: 65,
            provider: 50,
            rank: 45,
            country: 40,
            locality: 35,
            habitat: 30,
            description: 20
        };

        const base = priorities[field] || 10;
        return exact ? base + 40 : base;
    }

    function wildcardRegex(value) {
        const escaped = value
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, ".*")
            .replace(/\?/g, ".");

        return new RegExp(`^${escaped}$`, "i");
    }

    function levenshtein(left, right) {
        const a = left.toLowerCase();
        const b = right.toLowerCase();
        const matrix = Array.from(
            { length: b.length + 1 },
            (_, row) => [row]
        );

        for (let column = 0; column <= a.length; column += 1) {
            matrix[0][column] = column;
        }

        for (let row = 1; row <= b.length; row += 1) {
            for (let column = 1; column <= a.length; column += 1) {
                matrix[row][column] =
                    b[row - 1] === a[column - 1]
                        ? matrix[row - 1][column - 1]
                        : Math.min(
                            matrix[row - 1][column - 1] + 1,
                            matrix[row][column - 1] + 1,
                            matrix[row - 1][column] + 1
                        );
            }
        }

        return matrix[b.length][a.length];
    }

    function compareScalar(candidate, clause, fuzzy = true) {
        const value = clause.value;
        const operator = clause.operator;
        const candidateText = normalizeText(candidate);
        const queryText = normalizeText(value.raw);

        if (value.regex) {
            value.regex.lastIndex = 0;
            return value.regex.test(candidateText);
        }

        if (value.wildcard) {
            return wildcardRegex(queryText).test(candidateText);
        }

        if (
            value.boolean !== null &&
            ["=", "!="].includes(operator)
        ) {
            const left =
                typeof candidate === "boolean"
                    ? candidate
                    : parseBooleanValue(candidate);

            if (left !== null) {
                return operator === "="
                    ? left === value.boolean
                    : left !== value.boolean;
            }
        }

        if (
            [">", ">=", "<", "<=", "=", "!="].includes(operator) &&
            value.number !== null &&
            Number.isFinite(Number(candidate))
        ) {
            const left = Number(candidate);
            const right = value.number;

            if (operator === ">") return left > right;
            if (operator === ">=") return left >= right;
            if (operator === "<") return left < right;
            if (operator === "<=") return left <= right;
            if (operator === "=") return left === right;
            if (operator === "!=") return left !== right;
        }

        if (
            [">", ">=", "<", "<=", "=", "!="].includes(operator) &&
            value.date !== null
        ) {
            const left = parseDateValue(candidate);

            if (left !== null) {
                if (operator === ">") return left > value.date;
                if (operator === ">=") return left >= value.date;
                if (operator === "<") return left < value.date;
                if (operator === "<=") return left <= value.date;
                if (operator === "=") return left === value.date;
                if (operator === "!=") return left !== value.date;
            }
        }

        const left = candidateText.toLowerCase();
        const right = queryText.toLowerCase();

        if (operator === "=") {
            return left === right;
        }

        if (operator === "!=") {
            return left !== right;
        }

        if (operator === "contains") {
            if (left.includes(right)) {
                return true;
            }

            if (
                fuzzy &&
                right.length >= 4 &&
                Math.abs(left.length - right.length) <= 3
            ) {
                const threshold = right.length <= 6 ? 1 : 2;
                return levenshtein(left, right) <= threshold;
            }
        }

        return false;
    }

    function evaluateClause(record, clause, fuzzy = true) {
        if (clause.type === "text") {
            const matched = clause.fields.some(field =>
                fieldValues(record, field).some(value =>
                    compareScalar(value, clause, fuzzy)
                )
            );

            return clause.negated ? !matched : matched;
        }

        if (clause.field === "has") {
            const requested = clause.value.raw.replace(/-/g, "_");
            const matched = fieldValues(record, requested).some(value =>
                value !== null &&
                value !== undefined &&
                value !== "" &&
                !(Array.isArray(value) && value.length === 0)
            );

            return clause.negated ? !matched : matched;
        }

        const matched = fieldValues(record, clause.field).some(value =>
            compareScalar(value, clause, fuzzy)
        );

        return clause.negated ? !matched : matched;
    }

    function scoreClause(record, clause, fuzzy = true) {
        const fields =
            clause.type === "text"
                ? clause.fields
                : [clause.field];

        let best = 0;

        for (const field of fields) {
            const values = fieldValues(record, field);

            for (const candidate of values) {
                if (!compareScalar(candidate, clause, fuzzy)) {
                    continue;
                }

                const exact =
                    normalizeText(candidate).toLowerCase() ===
                    normalizeText(clause.value.raw).toLowerCase();

                best = Math.max(
                    best,
                    scoreField(field, exact)
                );
            }
        }

        return clause.negated
            ? best === 0 ? 1 : 0
            : best;
    }

    function scoreRecord(record, plan) {
        let total = 0;

        for (const clause of plan.clauses) {
            const matched =
                evaluateClause(record, clause, plan.fuzzy);

            if (!matched && clause.join !== "OR") {
                return 0;
            }

            if (matched) {
                total += scoreClause(
                    record,
                    clause,
                    plan.fuzzy
                );
            }
        }

        const accepted =
            record?.accepted === true ||
            record?.taxonomic_status === "accepted" ||
            record?.status === "accepted";

        if (accepted) {
            total += 15;
        }

        const confidence = Number(
            record?.confidence ??
            record?.score ??
            0
        );

        if (Number.isFinite(confidence)) {
            total += Math.max(
                0,
                Math.min(10, confidence * 10)
            );
        }

        return total;
    }

    function evaluateRecord(record, plan) {
        if (!plan.clauses.length) {
            return true;
        }

        let result = null;

        for (const clause of plan.clauses) {
            const matched = evaluateClause(record, clause, plan.fuzzy);

            if (result === null) {
                result = matched;
            } else if (clause.join === "OR") {
                result = result || matched;
            } else {
                result = result && matched;
            }
        }

        return Boolean(result);
    }

    function compareRecords(left, right, field, order) {
        const a = fieldValues(left, field)[0];
        const b = fieldValues(right, field)[0];
        const direction = order === "desc" ? -1 : 1;

        if (a === b) return 0;
        if (a === undefined || a === null) return 1;
        if (b === undefined || b === null) return -1;

        if (Number.isFinite(Number(a)) && Number.isFinite(Number(b))) {
            return (Number(a) - Number(b)) * direction;
        }

        return String(a).localeCompare(String(b), undefined, {
            numeric: true,
            sensitivity: "base"
        }) * direction;
    }


    function haversineKilometers(latitudeA, longitudeA, latitudeB, longitudeB) {
        const radians = value => value * Math.PI / 180;
        const earthRadius = 6371.0088;
        const deltaLatitude = radians(latitudeB - latitudeA);
        const deltaLongitude = radians(longitudeB - longitudeA);
        const a =
            Math.sin(deltaLatitude / 2) ** 2 +
            Math.cos(radians(latitudeA)) *
            Math.cos(radians(latitudeB)) *
            Math.sin(deltaLongitude / 2) ** 2;

        return 2 * earthRadius * Math.asin(Math.min(1, Math.sqrt(a)));
    }

    function recordCoordinates(record) {
        const latitude = Number(
            record?.latitude ??
            record?.decimalLatitude ??
            record?.lat
        );

        const longitude = Number(
            record?.longitude ??
            record?.decimalLongitude ??
            record?.lon ??
            record?.lng
        );

        if (
            !Number.isFinite(latitude) ||
            !Number.isFinite(longitude) ||
            latitude < -90 ||
            latitude > 90 ||
            longitude < -180 ||
            longitude > 180
        ) {
            return null;
        }

        return { latitude, longitude };
    }

    function parseBoundingBox(value) {
        const parts = String(value || "")
            .split(",")
            .map(Number);

        if (
            parts.length !== 4 ||
            parts.some(part => !Number.isFinite(part))
        ) {
            return null;
        }

        const [south, west, north, east] = parts;

        if (
            south < -90 ||
            north > 90 ||
            west < -180 ||
            east > 180 ||
            south > north
        ) {
            return null;
        }

        return { south, west, north, east };
    }

    function parseRadius(value) {
        const match = String(value || "").trim().match(
            /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?)(?:km)?$/i
        );

        if (!match) {
            return null;
        }

        const latitude = Number(match[1]);
        const longitude = Number(match[2]);
        const kilometers = Number(match[3]);

        if (
            latitude < -90 ||
            latitude > 90 ||
            longitude < -180 ||
            longitude > 180 ||
            kilometers <= 0
        ) {
            return null;
        }

        return { latitude, longitude, kilometers };
    }

    function applyGeographicFilters(records, options = {}) {
        const boundingBox = parseBoundingBox(options.bbox);
        const radius = parseRadius(options.radius);

        if (!boundingBox && !radius) {
            return records;
        }

        return records.filter(record => {
            const coordinates = recordCoordinates(record);

            if (!coordinates) {
                return false;
            }

            if (boundingBox) {
                const longitudeMatches =
                    boundingBox.west <= boundingBox.east
                        ? coordinates.longitude >= boundingBox.west &&
                          coordinates.longitude <= boundingBox.east
                        : coordinates.longitude >= boundingBox.west ||
                          coordinates.longitude <= boundingBox.east;

                if (
                    coordinates.latitude < boundingBox.south ||
                    coordinates.latitude > boundingBox.north ||
                    !longitudeMatches
                ) {
                    return false;
                }
            }

            if (radius) {
                const distance = haversineKilometers(
                    radius.latitude,
                    radius.longitude,
                    coordinates.latitude,
                    coordinates.longitude
                );

                if (distance > radius.kilometers) {
                    return false;
                }
            }

            return true;
        });
    }

    function buildFacets(records, fields = []) {
        const selectedFields = fields.length
            ? fields
            : [
                "rank",
                "kingdom",
                "phylum",
                "class",
                "order",
                "family",
                "genus",
                "provider",
                "country",
                "conservation_status"
            ];

        const facets = {};

        for (const field of selectedFields) {
            const counts = new Map();

            for (const record of records) {
                for (const value of fieldValues(record, field)) {
                    const normalized = normalizeText(value);

                    if (!normalized) {
                        continue;
                    }

                    counts.set(
                        normalized,
                        (counts.get(normalized) || 0) + 1
                    );
                }
            }

            facets[field] = [...counts.entries()]
                .sort((left, right) =>
                    right[1] - left[1] ||
                    left[0].localeCompare(right[0])
                )
                .slice(0, 100)
                .map(([value, count]) => ({
                    value,
                    count
                }));
        }

        return facets;
    }

    function safeSearchStorage() {
        try {
            const key = "__speciedex_search_probe__";
            window.localStorage.setItem(key, key);
            window.localStorage.removeItem(key);
            return window.localStorage;
        } catch (error) {
            return null;
        }
    }

    function stableSearchKey(query, options = {}) {
        const normalized = {
            query: normalizeText(query),
            collection: options.collection || "records",
            limit: Number(options.limit) || DEFAULT_LIMIT,
            offset: Number(options.offset) || 0,
            page: Number(options.page) || 1,
            sort: options.sort || null,
            order: options.order || "asc",
            fuzzy: options.fuzzy !== false,
            bbox: options.bbox || null,
            radius: options.radius || null
        };

        return JSON.stringify(normalized);
    }

    class SearchService {
        constructor(context) {
            this.context = context;
            this.defaultCollection = "records";
            this.lastQuery = null;
            this.lastResult = null;
            this.queryCount = 0;
            this.cache = new Map();
            this.cacheTTL = DEFAULT_CACHE_TTL;
            this.history = [];
            this.saved = new Map();
            this.activeController = null;
            this.storage = safeSearchStorage();
            this.storageKey =
                `${SEARCH_STORAGE_PREFIX}${
                    context.root?.dataset.terminalInstance || "default"
                }`;
            this.restore();
        }

        async search(query, options = {}) {
            const normalizedQuery = normalizeText(query);

            if (!normalizedQuery) {
                throw new Error("A search query is required.");
            }

            this.cancel("superseded");

            const controller = new AbortController();
            this.activeController = controller;

            const plan = parseQuery(normalizedQuery, options);
            const collection =
                options.collection ||
                this.defaultCollection;
            const cacheKey = stableSearchKey(normalizedQuery, options);
            const cached = this.cache.get(cacheKey);

            if (
                options.cache !== false &&
                cached &&
                Date.now() - cached.timestamp <= this.cacheTTL
            ) {
                const payload = {
                    ...cached.payload,
                    cached: true,
                    query_id:
                        `search:${Date.now()}:${++this.queryCount}`
                };

                this.lastQuery = normalizedQuery;
                this.lastResult = payload;
                this.recordHistory(payload);
                this.emitResults(payload, options);
                return payload;
            }

            const started = performance.now();
            this.context.loading?.begin?.(
                `search:${this.queryCount + 1}`,
                `Search: ${normalizedQuery}`
            );

            this.context.progress?.begin?.(
                `search:${this.queryCount + 1}`,
                `Search: ${normalizedQuery}`,
                {
                    indeterminate: true,
                    description: `Searching ${collection}.`
                }
            );

            try {
                let records =
                    options.records ||
                    this.context.library?.get?.(collection) ||
                    [];

                let result;
                let source = "local";

                if (controller.signal.aborted) {
                    throw new DOMException("Search cancelled.", "AbortError");
                }

                if (Array.isArray(records) && records.length) {
                    records = applyGeographicFilters(records, options);
                    result = await this.searchLocal(
                        records,
                        plan,
                        controller.signal
                    );
                } else if (
                    this.context.api &&
                    options.localOnly !== true
                ) {
                    source = "api";
                    result = await this.searchAPI(
                        plan,
                        controller.signal,
                        options
                    );
                } else {
                    result = {
                        records: [],
                        total: 0,
                        source: "empty"
                    };
                }

                const payload = {
                    query: normalizedQuery,
                    plan,
                    source: result.source || source,
                    total: result.total ?? result.records?.length ?? 0,
                    records: result.records || [],
                    facets:
                        result.facets ||
                        buildFacets(
                            result.allRecords || result.records || [],
                            options.facetFields || []
                        ),
                    elapsed_ms:
                        result.elapsed_ms ||
                        performance.now() - started,
                    offset:
                        plan.offset ||
                        (plan.page - 1) * plan.limit,
                    limit: plan.limit,
                    page: plan.page,
                    pages:
                        Math.max(
                            1,
                            Math.ceil(
                                (result.total ?? result.records?.length ?? 0) /
                                plan.limit
                            )
                        ),
                    cached: false,
                    query_id:
                        `search:${Date.now()}:${++this.queryCount}`
                };

                this.lastQuery = normalizedQuery;
                this.lastResult = payload;
                this.recordHistory(payload);

                if (options.cache !== false) {
                    this.cache.set(cacheKey, {
                        timestamp: Date.now(),
                        payload
                    });
                }

                this.pruneCache();
                this.emitResults(payload, options);

                this.context.progress?.complete?.(
                    `search:${this.queryCount}`,
                    payload
                );

                this.context.loading?.end?.(
                    `search:${this.queryCount}`,
                    payload
                );

                return payload;
            } catch (error) {
                this.context.progress?.fail?.(
                    `search:${this.queryCount + 1}`,
                    error
                );

                this.context.loading?.fail?.(
                    `search:${this.queryCount + 1}`,
                    error
                );

                if (error?.name === "AbortError") {
                    this.context.events?.emit?.("search:cancelled", {
                        query: normalizedQuery,
                        reason: controller.signal.reason || "cancelled"
                    });
                }

                throw error;
            } finally {
                if (this.activeController === controller) {
                    this.activeController = null;
                }
            }
        }

        async searchLocal(records, plan, signal = null) {
            const started = performance.now();
            let filtered;

            if (signal?.aborted) {
                throw new DOMException("Search cancelled.", "AbortError");
            }

            const workerCompatible =
                records.length <= MAX_WORKER_RECORDS &&
                this.context.workers?.has?.("search") &&
                plan.clauses.every(clause =>
                    clause.type === "text" &&
                    !clause.negated &&
                    clause.join === "AND" &&
                    !clause.value.regex &&
                    !clause.value.wildcard
                );

            if (workerCompatible) {
                try {
                    const query = plan.clauses
                        .map(clause => clause.value.raw)
                        .join(" ");

                    filtered = await this.context.workers.request(
                        "search",
                        "search",
                        {
                            query,
                            records,
                            fields: DEFAULT_TEXT_FIELDS,
                            limit: MAX_LIMIT
                        }
                    );
                } catch (error) {
                    filtered = records.filter(record =>
                        evaluateRecord(record, plan)
                    );
                }
            } else {
                filtered = records.filter(record =>
                    evaluateRecord(record, plan)
                );
            }

            let ranked = filtered.map(record => ({
                record: normalizeRecord(record),
                relevance: scoreRecord(record, plan)
            }));

            if (plan.sort) {
                ranked.sort((left, right) =>
                    compareRecords(
                        left.record,
                        right.record,
                        normalizeField(plan.sort),
                        plan.order
                    )
                );
            } else {
                ranked.sort((left, right) =>
                    right.relevance - left.relevance
                );
            }

            const total = ranked.length;
            const offset =
                plan.offset ||
                (plan.page - 1) * plan.limit;

            const allRecords = ranked.map(item => ({
                ...item.record,
                _search_relevance: item.relevance
            }));

            return {
                source: workerCompatible ? "worker/local" : "local",
                total,
                allRecords,
                records: allRecords.slice(
                    offset,
                    offset + plan.limit
                ),
                facets: buildFacets(allRecords),
                elapsed_ms: performance.now() - started
            };
        }

        async searchAPI(plan, signal = null, options = {}) {
            if (signal?.aborted) {
                throw new DOMException("Search cancelled.", "AbortError");
            }

            const response = await this.context.api.get("search", {
                q: plan.raw,
                limit: plan.limit,
                offset:
                    plan.offset ||
                    (plan.page - 1) * plan.limit,
                sort: plan.sort,
                order: plan.order,
                fuzzy: plan.fuzzy ? "1" : "0",
                explain: plan.explain ? "1" : "0"
            });

            if (Array.isArray(response)) {
                return {
                    source: "api",
                    records: response,
                    total: response.length
                };
            }

            return {
                source: "api",
                records:
                    response.records ||
                    response.results ||
                    response.items ||
                    [],
                total:
                    response.total ??
                    response.count ??
                    response.records?.length ??
                    response.results?.length ??
                    0,
                facets: response.facets || {},
                elapsed_ms: response.elapsed_ms || response.elapsed || 0
            };
        }


        cancel(reason = "cancelled") {
            if (!this.activeController) {
                return false;
            }

            this.activeController.abort(reason);
            this.activeController = null;
            return true;
        }

        pruneCache() {
            const now = Date.now();

            for (const [key, entry] of this.cache) {
                if (now - entry.timestamp > this.cacheTTL) {
                    this.cache.delete(key);
                }
            }

            while (this.cache.size > 100) {
                const first = this.cache.keys().next().value;
                this.cache.delete(first);
            }
        }

        clearCache() {
            const count = this.cache.size;
            this.cache.clear();
            return count;
        }

        recordHistory(payload) {
            this.history.push({
                id: payload.query_id,
                query: payload.query,
                timestamp: new Date().toISOString(),
                total: payload.total,
                elapsed_ms: payload.elapsed_ms,
                source: payload.source,
                collection: payload.plan?.collection || null,
                options: {
                    limit: payload.limit,
                    page: payload.page,
                    offset: payload.offset
                }
            });

            this.history = this.history.slice(-DEFAULT_HISTORY_LIMIT);
            this.persist();
        }

        save(name, query, options = {}) {
            const key = normalizeText(name).toLowerCase();

            if (!key) {
                throw new Error("Saved-search name is required.");
            }

            if (
                !this.saved.has(key) &&
                this.saved.size >= DEFAULT_SAVED_LIMIT
            ) {
                throw new Error(
                    `Saved-search limit reached (${DEFAULT_SAVED_LIMIT}).`
                );
            }

            const entry = {
                name: key,
                query: normalizeText(query),
                options: { ...options },
                createdAt:
                    this.saved.get(key)?.createdAt ||
                    new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };

            if (!entry.query) {
                throw new Error("Saved-search query is required.");
            }

            this.saved.set(key, entry);
            this.persist();
            return entry;
        }

        removeSaved(name) {
            const removed = this.saved.delete(
                normalizeText(name).toLowerCase()
            );

            this.persist();
            return removed;
        }

        listSaved() {
            return [...this.saved.values()]
                .sort((left, right) =>
                    left.name.localeCompare(right.name)
                );
        }

        async runSaved(name, overrides = {}) {
            const entry = this.saved.get(
                normalizeText(name).toLowerCase()
            );

            if (!entry) {
                throw new Error(`Unknown saved search: ${name}`);
            }

            return this.search(
                entry.query,
                {
                    ...entry.options,
                    ...overrides
                }
            );
        }

        persist() {
            if (!this.storage) {
                return false;
            }

            try {
                this.storage.setItem(
                    this.storageKey,
                    JSON.stringify({
                        version: VERSION,
                        history: this.history,
                        saved: [...this.saved.values()]
                    })
                );

                return true;
            } catch (error) {
                return false;
            }
        }

        restore() {
            if (!this.storage) {
                return false;
            }

            try {
                const payload = JSON.parse(
                    this.storage.getItem(this.storageKey) || "null"
                );

                if (!payload) {
                    return false;
                }

                this.history = Array.isArray(payload.history)
                    ? payload.history.slice(-DEFAULT_HISTORY_LIMIT)
                    : [];

                this.saved = new Map(
                    (Array.isArray(payload.saved) ? payload.saved : [])
                        .slice(-DEFAULT_SAVED_LIMIT)
                        .map(entry => [
                            normalizeText(entry.name).toLowerCase(),
                            entry
                        ])
                );

                return true;
            } catch (error) {
                return false;
            }
        }

        clearHistory() {
            const count = this.history.length;
            this.history = [];
            this.persist();
            return count;
        }

        emitResults(payload, options = {}) {
            document.dispatchEvent(
                new CustomEvent("speciedex:terminal-search-results", {
                    detail: payload
                })
            );

            this.context.root?.dispatchEvent?.(
                new CustomEvent("speciedex:terminal-search-results", {
                    bubbles: true,
                    detail: payload
                })
            );

            this.context.events?.emit?.("search:results", payload);
            this.context.emit?.("search:results", payload);

            const batchSize = Math.max(
                1,
                Number(options.streamBatch) || DEFAULT_STREAM_BATCH
            );

            payload.records.forEach((record, index) => {
                const detail = {
                    source: "search",
                    query: payload.query,
                    queryId: payload.query_id,
                    index,
                    speciedexId:
                        record.speciedex_id ??
                        record.speciedexId ??
                        record.id ??
                        record.key ??
                        "",
                    scientificName:
                        record.scientific_name ??
                        record.scientificName ??
                        record.canonical_name ??
                        record.name ??
                        "",
                    commonName:
                        record.common_name ??
                        record.commonName ??
                        record.vernacular_name ??
                        "",
                    provider:
                        record.provider ??
                        record.source ??
                        "",
                    record
                };

                document.dispatchEvent(
                    new CustomEvent(
                        "speciedex:terminal-splash-record",
                        { detail }
                    )
                );

                this.context.events?.emit?.(
                    "search:record",
                    detail
                );

                if (
                    index > 0 &&
                    index % batchSize === 0
                ) {
                    this.context.events?.emit?.(
                        "search:stream",
                        {
                            queryId: payload.query_id,
                            processed: index,
                            total: payload.records.length
                        }
                    );
                }
            });

            this.context.recent?.record?.(
                "search",
                payload.query,
                {
                    query: payload.query,
                    resultCount: payload.total,
                    duration: payload.elapsed_ms,
                    success: true,
                    metadata: {
                        source: payload.source,
                        queryId: payload.query_id
                    }
                }
            );
        }

        async scanLast(options = {}) {
            if (!this.lastResult) {
                throw new Error("No search result is available to scan.");
            }

            if (!this.context.scan?.run) {
                throw new Error("Scan service is unavailable.");
            }

            return this.context.scan.run({
                ...options,
                records: this.lastResult.records,
                source: `search:${this.lastResult.query}`,
                type: "search",
                label: `Scan search results: ${this.lastResult.query}`
            });
        }

        async rebuildIndex(collection = this.defaultCollection, fields = []) {
            const records = this.context.library?.get?.(collection) || [];

            if (!this.context.index?.build) {
                throw new Error("Search index service is unavailable.");
            }

            const count = this.context.index.build(records, fields);
            this.clearCache();

            return {
                collection,
                records: count,
                fields:
                    fields.length
                        ? fields
                        : this.context.index.fields || []
            };
        }

        facets() {
            return this.lastResult?.facets || {};
        }

        explain(query, options = {}) {
            return parseQuery(query, {
                ...options,
                explain: true
            });
        }

        fields() {
            return {
                aliases: FIELD_ALIASES,
                defaultTextFields: DEFAULT_TEXT_FIELDS,
                identifierPatterns: ID_PATTERNS.map(([field, pattern]) => ({
                    field,
                    pattern: pattern.source
                }))
            };
        }

        status() {
            return {
                version: VERSION,
                defaultCollection: this.defaultCollection,
                queries: this.queryCount,
                lastQuery: this.lastQuery,
                lastTotal: this.lastResult?.total ?? null,
                workerAvailable:
                    Boolean(this.context.workers?.has?.("search")),
                apiAvailable:
                    Boolean(this.context.api),
                active:
                    Boolean(this.activeController),
                cacheEntries:
                    this.cache.size,
                cacheTTL:
                    this.cacheTTL,
                history:
                    this.history.length,
                saved:
                    this.saved.size,
                lastPages:
                    this.lastResult?.pages ?? null
            };
        }
    }

    function outputSearchResult(payload, helpers, output = "table") {
        const {
            write,
            writeJSON,
            writeTable,
            context
        } = helpers;

        if (output === "json") {
            return writeJSON(payload);
        }

        if (output === "map") {
            const renderer =
                context.visualizations?.get?.("range-map") ||
                context.renderers?.get?.("map");

            if (renderer?.render) {
                return renderer.render(payload.records, {
                    title: `Search: ${payload.query}`
                });
            }
        }

        if (output === "tree") {
            const renderer =
                context.visualizations?.get?.("taxonomy-tree") ||
                context.renderers?.get?.("tree");

            if (renderer?.render) {
                return renderer.render(payload.records, {
                    title: `Search: ${payload.query}`
                });
            }
        }

        if (output === "wordcloud") {
            const renderer =
                context.visualizations?.get?.("wordcloud");

            if (renderer?.render) {
                return renderer.render(payload.records, {
                    title: `Search: ${payload.query}`
                });
            }
        }

        const rows = payload.records.map(record => [
            record.speciedex_id ??
                record.speciedexId ??
                record.id ??
                record.key ??
                "",
            record.scientific_name ??
                record.scientificName ??
                record.canonical_name ??
                record.name ??
                "",
            record.common_name ??
                record.commonName ??
                record.vernacular_name ??
                "",
            record.rank ?? "",
            record.country ??
                record.location ??
                "",
            record.provider ??
                record.source ??
                "",
            record._search_relevance ?? ""
        ]);

        if (!rows.length) {
            return write(
                `No records matched "${payload.query}".`,
                "warning"
            );
        }

        writeTable(
            [
                "Speciedex ID",
                "Scientific Name",
                "Common Name",
                "Rank",
                "Location",
                "Provider",
                "Relevance"
            ],
            rows
        );

        return write(
            `${payload.total.toLocaleString()} matching record(s); ` +
            `${payload.records.length.toLocaleString()} displayed; ` +
            `source=${payload.source}; ` +
            `elapsed=${Number(payload.elapsed_ms || 0).toFixed(2)}ms`,
            "info"
        );
    }

    function commandOptions(parsed) {
        return {
            limit:
                parsed.options.limit ??
                parsed.flags.l ??
                DEFAULT_LIMIT,
            offset:
                parsed.options.offset ??
                0,
            page:
                parsed.options.page ??
                1,
            sort:
                parsed.options.sort ??
                null,
            order:
                parsed.options.order ??
                (parsed.flags.desc ? "desc" : "asc"),
            output:
                parsed.options.output ??
                (
                    parsed.flags.json ? "json" :
                    parsed.flags.map ? "map" :
                    parsed.flags.tree ? "tree" :
                    parsed.flags.wordcloud ? "wordcloud" :
                    "table"
                ),
            collection:
                parsed.options.collection ??
                "records",
            fuzzy:
                parsed.flags.exact !== true &&
                parsed.options.fuzzy !== "false",
            localOnly:
                parsed.flags.local === true,
            explain:
                parsed.flags.explain === true,
            bbox:
                parsed.options.bbox ?? null,
            radius:
                parsed.options.radius ?? null,
            cache:
                parsed.flags["no-cache"] !== true,
            streamBatch:
                parsed.options["stream-batch"] ?? DEFAULT_STREAM_BATCH
        };
    }

    function initialize(context) {
        if (context.search instanceof SearchService) {
            return context.search;
        }

        const service = new SearchService(context);

        context.search = service;
        context.registerService?.("search", service);

        return service;
    }

    const commands = [
        {
            name: "search",
            aliases: ["find", "lookup", "query"],
            category: "search",
            description:
                "Search all indexed species, taxonomy, provider, archive, genetic, geographic, and identifier fields.",
            usage:
                "search <terms|field:value|field>=value> [--limit N] [--sort FIELD] [--json|--map|--tree]",
            completer: ({ tokens }) => {
                if (tokens.length <= 2) {
                    return Object.keys(FIELD_ALIASES)
                        .map(field => `${field}:`)
                        .sort();
                }

                return [];
            },
            handler: async helpers => {
                const {
                    args,
                    parsed,
                    context
                } = helpers;

                const query = args.join(" ");

                if (!query) {
                    throw new Error(
                        "A search query is required. Enter `search-help` for examples."
                    );
                }

                const options = commandOptions(parsed);
                const result = await context.search.search(query, options);

                return outputSearchResult(
                    result,
                    helpers,
                    options.output
                );
            }
        },
        {
            name: "search-help",
            category: "search",
            description:
                "Display search syntax, fields, operators, and examples.",
            usage: "search-help",
            handler: ({ write }) => write([
                "Speciedex Search",
                "",
                "Free text:",
                '  search "Panthera tigris"',
                "  search Bengal tiger",
                "",
                "Fields:",
                "  search id:spx-animalia-000001",
                "  search scientific:Panthera",
                '  search common:"snow leopard"',
                "  search country:India habitat:forest",
                "  search provider:gbif rank:species",
                "  search sha256:<hash>",
                "  search gbif:2435099",
                "  search wikidata:Q19939",
                "",
                "Logic and comparison:",
                "  search tiger AND India",
                "  search tiger OR lion",
                "  search tiger NOT extinct",
                "  search year>=1900 confidence>=0.95",
                "",
                "Patterns:",
                "  search panth*",
                "  search /^Panthera\\s/i",
                "",
                "Output:",
                "  search tiger --json",
                "  search tiger --map",
                "  search Panthera --tree",
                "  search forest --wordcloud",
                "",
                "Pagination and sorting:",
                "  search tiger --limit 100 --page 2",
                "  search tiger --sort scientific_name --order asc"
            ].join("\n"), "output", {
                preformatted: true
            })
        },
        {
            name: "search-fields",
            category: "search",
            description:
                "List recognized search fields, aliases, and identifier patterns.",
            usage: "search-fields",
            handler: ({ context, writeJSON }) =>
                writeJSON(context.search.fields())
        },
        {
            name: "search-status",
            category: "search",
            description:
                "Display search service, worker, API, and last-query status.",
            usage: "search-status",
            handler: ({ context, writeJSON }) =>
                writeJSON(context.search.status())
        },
        {
            name: "search-last",
            category: "search",
            description:
                "Display the most recent search result payload.",
            usage: "search-last",
            handler: ({ context, writeJSON }) => {
                if (!context.search.lastResult) {
                    throw new Error("No search has been executed in this session.");
                }

                return writeJSON(context.search.lastResult);
            }
        },
        {
            name: "search-explain",
            category: "search",
            description:
                "Parse a query and display the resulting search plan.",
            usage: "search-explain <query>",
            handler: ({ args, context, writeJSON }) => {
                const query = args.join(" ");

                if (!query) {
                    throw new Error("A search query is required.");
                }

                return writeJSON(
                    context.search.explain(query)
                );
            }
        },
        {
            name: "search-cancel",
            category: "search",
            description: "Cancel the active search.",
            usage: "search-cancel",
            handler: ({ context, write }) =>
                write(
                    context.search.cancel("command")
                        ? "Active search cancelled."
                        : "No active search.",
                    context.search.activeController
                        ? "success"
                        : "warning"
                )
        },
        {
            name: "search-history",
            category: "search",
            description: "Display recent searches.",
            usage: "search-history [count]",
            handler: ({ args, context, writeJSON }) => {
                const count = Math.max(
                    1,
                    Math.min(
                        DEFAULT_HISTORY_LIMIT,
                        Number(args[0]) || 25
                    )
                );

                return writeJSON(
                    context.search.history.slice(-count).reverse()
                );
            }
        },
        {
            name: "search-history-clear",
            category: "search",
            description: "Clear saved search history.",
            usage: "search-history-clear",
            handler: ({ context, write }) => {
                const count = context.search.clearHistory();

                return write(
                    `Cleared ${count} search history entr${count === 1 ? "y" : "ies"}.`,
                    "success"
                );
            }
        },
        {
            name: "search-save",
            category: "search",
            description: "Save a named search.",
            usage: "search-save <name> <query>",
            handler: ({ args, context, writeJSON }) => {
                const name = args.shift();
                const query = args.join(" ");

                if (!name || !query) {
                    throw new Error(
                        "Usage: search-save <name> <query>"
                    );
                }

                return writeJSON(
                    context.search.save(name, query)
                );
            }
        },
        {
            name: "search-saved",
            category: "search",
            description: "List saved searches.",
            usage: "search-saved",
            handler: ({ context, writeJSON }) =>
                writeJSON(context.search.listSaved())
        },
        {
            name: "search-run",
            category: "search",
            description: "Run a saved search.",
            usage: "search-run <name>",
            handler: async helpers => {
                const { args, context } = helpers;

                if (!args[0]) {
                    throw new Error("A saved-search name is required.");
                }

                const result = await context.search.runSaved(args[0]);

                return outputSearchResult(
                    result,
                    helpers,
                    "table"
                );
            }
        },
        {
            name: "search-remove",
            category: "search",
            description: "Remove a saved search.",
            usage: "search-remove <name>",
            handler: ({ args, context, write }) => {
                const removed = context.search.removeSaved(args[0]);

                return write(
                    removed
                        ? `Saved search removed: ${args[0]}`
                        : `Saved search not found: ${args[0]}`,
                    removed ? "success" : "warning"
                );
            }
        },
        {
            name: "search-facets",
            category: "search",
            description: "Display facets from the most recent search.",
            usage: "search-facets [field]",
            handler: ({ args, context, writeJSON }) => {
                const facets = context.search.facets();

                return writeJSON(
                    args[0]
                        ? facets[normalizeField(args[0])] || []
                        : facets
                );
            }
        },
        {
            name: "search-next",
            category: "search",
            description: "Run the next page of the most recent search.",
            usage: "search-next",
            handler: async helpers => {
                const { context } = helpers;
                const last = context.search.lastResult;

                if (!last) {
                    throw new Error("No previous search is available.");
                }

                const page = Math.min(
                    last.pages,
                    last.page + 1
                );

                const result = await context.search.search(
                    last.query,
                    {
                        limit: last.limit,
                        page,
                        collection:
                            last.plan?.collection ||
                            context.search.defaultCollection
                    }
                );

                return outputSearchResult(
                    result,
                    helpers,
                    "table"
                );
            }
        },
        {
            name: "search-prev",
            category: "search",
            description: "Run the previous page of the most recent search.",
            usage: "search-prev",
            handler: async helpers => {
                const { context } = helpers;
                const last = context.search.lastResult;

                if (!last) {
                    throw new Error("No previous search is available.");
                }

                const result = await context.search.search(
                    last.query,
                    {
                        limit: last.limit,
                        page: Math.max(1, last.page - 1),
                        collection:
                            last.plan?.collection ||
                            context.search.defaultCollection
                    }
                );

                return outputSearchResult(
                    result,
                    helpers,
                    "table"
                );
            }
        },
        {
            name: "search-scan",
            category: "search",
            description: "Scan the most recent search results for anomalies.",
            usage: "search-scan",
            handler: async ({ context, writeJSON }) =>
                writeJSON(
                    await context.search.scanLast()
                )
        },
        {
            name: "search-index",
            category: "search",
            description: "Rebuild the local search index.",
            usage: "search-index [collection]",
            handler: async ({ args, context, writeJSON }) =>
                writeJSON(
                    await context.search.rebuildIndex(
                        args[0] || "records"
                    )
                )
        },
        {
            name: "search-cache-clear",
            category: "search",
            description: "Clear the search-result cache.",
            usage: "search-cache-clear",
            handler: ({ context, write }) => {
                const count = context.search.clearCache();

                return write(
                    `Cleared ${count} cached search entr${count === 1 ? "y" : "ies"}.`,
                    "success"
                );
            }
        },
        {
            name: "search-export",
            category: "search",
            description: "Export the most recent search as JSON.",
            usage: "search-export [filename]",
            handler: ({ args, context, write }) => {
                if (!context.search.lastResult) {
                    throw new Error("No search result is available.");
                }

                const filename =
                    args[0] ||
                    "speciedex-search-results.json";

                const blob = new Blob(
                    [
                        JSON.stringify(
                            context.search.lastResult,
                            null,
                            2
                        )
                    ],
                    {
                        type: "application/json"
                    }
                );

                const url = URL.createObjectURL(blob);
                const anchor = document.createElement("a");

                anchor.href = url;
                anchor.download = filename;
                anchor.click();

                window.setTimeout(
                    () => URL.revokeObjectURL(url),
                    1000
                );

                return write(
                    `Search results exported to ${filename}.`,
                    "success"
                );
            }
        }
    ];

    const api = Object.freeze({
        name: MODULE_NAME,
        version: VERSION,
        SearchService,
        parseQuery,
        evaluateRecord,
        scoreRecord,
        normalizeField,
        detectIdentifier,
        haversineKilometers,
        recordCoordinates,
        parseBoundingBox,
        parseRadius,
        applyGeographicFilters,
        buildFacets,
        stableSearchKey,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalSearch = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
