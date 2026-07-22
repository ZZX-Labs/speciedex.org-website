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
    const DEFAULT_LIMIT = 50;
    const MAX_LIMIT = 1000;

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
        depth: "depth"
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
        const match = normalizeText(value).match(/^\/(.+)\/([gimsuy]*)$/);

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

    function parseValue(value) {
        const raw = unquote(value);
        const regex = parseRegex(raw);
        const geo = parseGeo(raw);

        return {
            raw,
            regex,
            geo,
            wildcard: raw.includes("*") || raw.includes("?"),
            number: raw !== "" && Number.isFinite(Number(raw))
                ? Number(raw)
                : null
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

    class SearchService {
        constructor(context) {
            this.context = context;
            this.defaultCollection = "records";
        }

        async search(query, options = {}) {
            const plan = parseQuery(query, options);
            const collection =
                options.collection ||
                this.defaultCollection;

            let records =
                options.records ||
                this.context.library?.get?.(collection) ||
                [];

            let result;
            let source = "local";

            if (
                Array.isArray(records) &&
                records.length
            ) {
                result = await this.searchLocal(records, plan);
            } else if (
                this.context.api &&
                options.localOnly !== true
            ) {
                source = "api";
                result = await this.searchAPI(plan);
            } else {
                result = {
                    records: [],
                    total: 0,
                    source: "empty"
                };
            }

            const payload = {
                query,
                plan,
                source: result.source || source,
                total: result.total ?? result.records?.length ?? 0,
                records: result.records || [],
                facets: result.facets || {},
                elapsed_ms: result.elapsed_ms || 0
            };

            document.dispatchEvent(
                new CustomEvent("speciedex:terminal-search-results", {
                    detail: payload
                })
            );

            this.context.events?.emit?.("search:results", payload);

            return payload;
        }

        async searchLocal(records, plan) {
            const started = performance.now();
            let filtered;

            if (
                this.context.workers?.has?.("search") &&
                plan.clauses.every(clause =>
                    clause.type === "text" &&
                    !clause.negated &&
                    clause.join === "AND"
                )
            ) {
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

            if (plan.sort) {
                filtered.sort((left, right) =>
                    compareRecords(
                        left,
                        right,
                        normalizeField(plan.sort),
                        plan.order
                    )
                );
            }

            const total = filtered.length;
            const offset =
                plan.offset ||
                (plan.page - 1) * plan.limit;

            return {
                source: "local",
                total,
                records: filtered.slice(offset, offset + plan.limit),
                elapsed_ms: performance.now() - started
            };
        }

        async searchAPI(plan) {
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
                ""
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
                "Provider"
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
                !parsed.flags.exact,
            localOnly:
                parsed.flags.local === true,
            explain:
                parsed.flags.explain === true
        };
    }

    function initialize(context) {
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
        }
    ];

    const api = Object.freeze({
        name: MODULE_NAME,
        SearchService,
        parseQuery,
        evaluateRecord,
        normalizeField,
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
