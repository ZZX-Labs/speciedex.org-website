/*
========================================================================
Speciedex.org
Terminal ProviderDocumentation Module
========================================================================

Provider documentation metadata service for SpeciedexTerminal.

Provides:

    • Validated documentation API requests
    • Provider, type, format, language, version, license, and date filters
    • Normalized documentation metadata records
    • Provider, type, format, language, version, and license summaries
    • Single-document retrieval
    • Current, deprecated, and missing-documentation views
    • Lifecycle events, caching, and resilient service registration
    • Terminal command integration

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "ProviderDocumentation";
    const VERSION = "2.0.0";
    const SERVICE_NAME = "provider-documentation";

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
            value || "updated_at"
        ).toLowerCase();

        const allowed = new Set([
            "updated_at",
            "created_at",
            "provider",
            "title",
            "type",
            "format",
            "language",
            "version",
            "license",
            "status",
            "id"
        ]);

        if (!allowed.has(normalized)) {
            throw new TypeError(
                `Unsupported documentation sort field: ${value}`
            );
        }

        return normalized;
    }

    function normalizeDirection(value) {
        const normalized = normalizeText(
            value || "desc"
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
                "document",
                "document_id",
                "title",
                "type",
                "format",
                "language",
                "version",
                "license",
                "status",
                "category",
                "section",
                "topic"
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
                "current",
                "deprecated",
                "available",
                "official",
                "archived",
                "searchable"
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
                "Documentation start date must not be later than the end date."
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
                        .split(/[,\s]+/)
                        .map(normalizeText)
                        .filter(Boolean)
                )
            ]
            : [];
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
                title:
                    normalizeText(record),
                type: "documentation",
                format: "",
                language: "",
                version: "",
                license: "",
                status: "unknown",
                current: false,
                deprecated: false,
                available: false,
                official: false,
                archived: false,
                searchable: false,
                topics: [],
                sections: []
            };
        }

        const status = normalizeText(
            record.status ??
            (
                record.deprecated === true
                    ? "deprecated"
                    : "current"
            )
        ).toLowerCase();

        const deprecated =
            record.deprecated === true ||
            [
                "deprecated",
                "obsolete",
                "retired"
            ].includes(status);

        const archived =
            record.archived === true ||
            status === "archived";

        const available =
            record.available !== false &&
            record.missing !== true &&
            ![
                "missing",
                "unavailable"
            ].includes(status);

        const current =
            record.current !== undefined
                ? Boolean(record.current)
                : (
                    available &&
                    !deprecated &&
                    !archived
                );

        return {
            ...record,
            index:
                record.index ??
                index,
            id: normalizeText(
                record.id ??
                record.document_id ??
                record.documentId ??
                record.slug ??
                record.path ??
                `documentation-${index + 1}`
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
            title: normalizeText(
                record.title ??
                record.name ??
                record.label ??
                record.id ??
                `Documentation ${index + 1}`
            ),
            description: normalizeText(
                record.description ??
                record.summary ??
                ""
            ),
            type: normalizeText(
                record.type ??
                record.document_type ??
                record.documentType ??
                "documentation"
            ).toLowerCase(),
            format: normalizeText(
                record.format ??
                record.mime_type ??
                record.mimeType ??
                ""
            ).toLowerCase(),
            language: normalizeText(
                record.language ??
                record.locale ??
                ""
            ).toLowerCase(),
            version: normalizeText(
                record.version ??
                record.api_version ??
                record.apiVersion ??
                ""
            ),
            license: normalizeText(
                record.license ??
                record.licence ??
                ""
            ),
            status,
            current,
            deprecated,
            available,
            official:
                record.official === true ||
                record.is_official === true ||
                record.isOfficial === true,
            archived,
            searchable:
                record.searchable !== false &&
                record.indexed !== false,
            url: normalizeText(
                record.url ??
                record.href ??
                record.location ??
                ""
            ),
            path: normalizeText(
                record.path ??
                record.file ??
                record.filename ??
                ""
            ),
            category: normalizeText(
                record.category ??
                ""
            ),
            topics: normalizeStringArray(
                record.topics ??
                record.tags ??
                record.keywords
            ),
            sections: normalizeStringArray(
                record.sections ??
                record.headings
            ),
            checksum: normalizeText(
                record.checksum ??
                record.sha256 ??
                ""
            ),
            size:
                Number.isFinite(
                    Number(record.size)
                )
                    ? Number(record.size)
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
        const types = new Map();
        const formats = new Map();
        const languages = new Map();
        const versions = new Map();
        const licenses = new Map();
        const statuses = new Map();
        const topics = new Map();

        let totalSize = 0;

        for (const documentRecord of values) {
            incrementMap(
                providers,
                documentRecord.provider
            );

            incrementMap(
                types,
                documentRecord.type
            );

            incrementMap(
                formats,
                documentRecord.format
            );

            incrementMap(
                languages,
                documentRecord.language
            );

            incrementMap(
                versions,
                documentRecord.version
            );

            incrementMap(
                licenses,
                documentRecord.license
            );

            incrementMap(
                statuses,
                documentRecord.status
            );

            for (
                const topic of
                documentRecord.topics || []
            ) {
                incrementMap(
                    topics,
                    topic
                );
            }

            if (
                Number.isFinite(
                    documentRecord.size
                )
            ) {
                totalSize +=
                    documentRecord.size;
            }
        }

        return {
            total:
                values.length,
            current:
                values.filter(
                    item =>
                        item.current
                ).length,
            deprecated:
                values.filter(
                    item =>
                        item.deprecated
                ).length,
            available:
                values.filter(
                    item =>
                        item.available
                ).length,
            unavailable:
                values.filter(
                    item =>
                        !item.available
                ).length,
            official:
                values.filter(
                    item =>
                        item.official
                ).length,
            archived:
                values.filter(
                    item =>
                        item.archived
                ).length,
            searchable:
                values.filter(
                    item =>
                        item.searchable
                ).length,
            totalSize,
            providers:
                mapToSortedObject(
                    providers
                ),
            types:
                mapToSortedObject(
                    types
                ),
            formats:
                mapToSortedObject(
                    formats
                ),
            languages:
                mapToSortedObject(
                    languages
                ),
            versions:
                mapToSortedObject(
                    versions
                ),
            licenses:
                mapToSortedObject(
                    licenses
                ),
            statuses:
                mapToSortedObject(
                    statuses
                ),
            topics:
                mapToSortedObject(
                    topics
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
                                Array.isArray(payload.documentation)
                                    ? payload.documentation
                                    : (
                                        Array.isArray(payload.documents)
                                            ? payload.documents
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

    class ProviderDocumentationService extends EventTarget {
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
                    "Provider-documentation service has been destroyed."
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
                    `provider-documentation:${name}`,
                    detail
                );
            } catch (_error) {
                /*
                Observer failures must not break documentation operations.
                */
            }

            dispatch(
                this.context.root,
                `speciedex:terminal-provider-documentation-${name}`,
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
                        "providers/documentation",
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
                    "A documentation ID is required."
                );
            }

            try {
                const payload =
                    await this.context.api.get(
                        `providers/documentation/${encodeURIComponent(normalizedId)}`,
                        {},
                        options
                    );

                return normalizeRecord(
                    payload,
                    0
                );
            } catch (error) {
                const match =
                    this.cache?.records?.find(
                        item =>
                            item.id ===
                                normalizedId ||
                            item.title
                                .toLowerCase() ===
                            normalizedId
                                .toLowerCase()
                    );

                if (match) {
                    return match;
                }

                throw error;
            }
        }

        async current(parameters = {}, options = {}) {
            const result =
                await this.list(
                    {
                        ...parameters,
                        current: true,
                        deprecated: false,
                        available: true
                    },
                    options
                );

            const records =
                result.records.filter(
                    item =>
                        item.current &&
                        !item.deprecated &&
                        item.available
                );

            return {
                ...result,
                records,
                summary:
                    summarize(records)
            };
        }

        async deprecated(parameters = {}, options = {}) {
            const result =
                await this.list(
                    {
                        ...parameters,
                        deprecated: true
                    },
                    options
                );

            const records =
                result.records.filter(
                    item =>
                        item.deprecated
                );

            return {
                ...result,
                records,
                summary:
                    summarize(records)
            };
        }

        async missing(parameters = {}, options = {}) {
            const result =
                await this.list(
                    {
                        ...parameters,
                        available: false
                    },
                    options
                );

            const records =
                result.records.filter(
                    item =>
                        !item.available
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
                documentation:
                    result.records
            };
        }

        status() {
            return {
                version: VERSION,
                endpoint:
                    "providers/documentation",
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
            ProviderDocumentationService &&
            !existing.destroyed
        ) {
            context.providerDocumentation =
                existing;

            return existing;
        }

        if (
            context.providerDocumentation instanceof
            ProviderDocumentationService &&
            !context.providerDocumentation.destroyed
        ) {
            return context.providerDocumentation;
        }

        const service =
            new ProviderDocumentationService(
                context
            );

        context.providerDocumentation =
            service;

        context.registerService?.(
            SERVICE_NAME,
            service
        );

        context.registerService?.(
            "providerDocumentation",
            service
        );

        dispatch(
            document,
            "speciedex:terminal-provider-documentation-ready",
            {
                context,
                service
            }
        );

        return service;
    }

    function requireService(context) {
        const service =
            context?.providerDocumentation ||
            context?.services?.get?.(
                SERVICE_NAME
            );

        if (
            !(
                service instanceof
                ProviderDocumentationService
            )
        ) {
            throw new Error(
                "Provider-documentation service is unavailable."
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
                    "--document="
                )
            ) {
                parameters.document =
                    argument.slice(11);
                continue;
            }

            if (
                argument.startsWith(
                    "--title="
                )
            ) {
                parameters.title =
                    argument.slice(8);
                continue;
            }

            if (
                argument.startsWith(
                    "--type="
                )
            ) {
                parameters.type =
                    argument.slice(7);
                continue;
            }

            if (
                argument.startsWith(
                    "--format="
                )
            ) {
                parameters.format =
                    argument.slice(9);
                continue;
            }

            if (
                argument.startsWith(
                    "--language="
                )
            ) {
                parameters.language =
                    argument.slice(11);
                continue;
            }

            if (
                argument.startsWith(
                    "--version="
                )
            ) {
                parameters.version =
                    argument.slice(10);
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
                    "--status="
                )
            ) {
                parameters.status =
                    argument.slice(9);
                continue;
            }

            if (
                argument.startsWith(
                    "--category="
                )
            ) {
                parameters.category =
                    argument.slice(11);
                continue;
            }

            if (
                argument.startsWith(
                    "--section="
                )
            ) {
                parameters.section =
                    argument.slice(10);
                continue;
            }

            if (
                argument.startsWith(
                    "--topic="
                )
            ) {
                parameters.topic =
                    argument.slice(8);
                continue;
            }

            if (
                argument.startsWith(
                    "--current="
                )
            ) {
                parameters.current =
                    argument.slice(10);
                continue;
            }

            if (
                argument.startsWith(
                    "--deprecated="
                )
            ) {
                parameters.deprecated =
                    argument.slice(13);
                continue;
            }

            if (
                argument.startsWith(
                    "--available="
                )
            ) {
                parameters.available =
                    argument.slice(12);
                continue;
            }

            if (
                argument.startsWith(
                    "--official="
                )
            ) {
                parameters.official =
                    argument.slice(11);
                continue;
            }

            if (
                argument.startsWith(
                    "--archived="
                )
            ) {
                parameters.archived =
                    argument.slice(11);
                continue;
            }

            if (
                argument.startsWith(
                    "--searchable="
                )
            ) {
                parameters.searchable =
                    argument.slice(13);
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
            name: "provider-documentation",
            aliases: [
                "provider-docs"
            ],
            category: "providers",
            description:
                "Read provider documentation metadata.",
            usage:
                "provider-documentation [query] [limit] [--provider=ID] [--document=ID] [--title=TEXT] [--type=TYPE] [--format=FORMAT] [--language=LANG] [--version=VERSION] [--license=LICENSE] [--status=STATUS] [--category=CATEGORY] [--section=SECTION] [--topic=TOPIC] [--current=true|false] [--deprecated=true|false] [--available=true|false] [--official=true|false] [--archived=true|false] [--searchable=true|false] [--from=DATE] [--to=DATE] [--sort=FIELD] [--direction=asc|desc] [--offset=N]",
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
            name: "provider-document",
            aliases: [
                "provider-doc"
            ],
            category: "providers",
            description:
                "Retrieve one provider documentation record by ID or title.",
            usage:
                "provider-document <id|title>",
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
                        "A documentation ID or title is required."
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
            name: "provider-documentation-current",
            aliases: [
                "provider-docs-current"
            ],
            category: "providers",
            description:
                "List current and available provider documentation.",
            usage:
                "provider-documentation-current [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).current(
                        parseCommandArguments(
                            args
                        )
                    )
                )
        },
        {
            name: "provider-documentation-deprecated",
            aliases: [
                "provider-docs-deprecated"
            ],
            category: "providers",
            description:
                "List deprecated provider documentation.",
            usage:
                "provider-documentation-deprecated [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).deprecated(
                        parseCommandArguments(
                            args
                        )
                    )
                )
        },
        {
            name: "provider-documentation-missing",
            aliases: [
                "provider-docs-missing"
            ],
            category: "providers",
            description:
                "List unavailable or missing provider documentation.",
            usage:
                "provider-documentation-missing [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).missing(
                        parseCommandArguments(
                            args
                        )
                    )
                )
        },
        {
            name: "provider-documentation-summary",
            aliases: [
                "provider-docs-summary"
            ],
            category: "providers",
            description:
                "Summarize provider documentation by provider, type, format, language, version, license, status, and topic.",
            usage:
                "provider-documentation-summary [filters]",
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
            name: "provider-documentation-status",
            category: "providers",
            description:
                "Show provider-documentation service status.",
            usage:
                "provider-documentation-status",
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
        ProviderDocumentationService,
        normalizeParameters,
        normalizeRecord,
        normalizeResponse,
        normalizeStringArray,
        summarize,
        parseCommandArguments,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalProviderDocumentation =
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
