/*
========================================================================
Speciedex.org
Terminal EnabledProviders Module
========================================================================

Enabled-provider registry service for SpeciedexTerminal.

Provides:

    • Validated enabled-provider API requests
    • Build, runtime, capability, protocol, region, and pagination filters
    • Normalized enabled-provider records
    • Build inclusion, availability, capability, and health summaries
    • Single-provider lookup
    • Lifecycle events, caching, and resilient service registration
    • Terminal command integration

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "EnabledProviders";
    const VERSION = "2.0.0";
    const SERVICE_NAME = "enabled-providers";

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
        const text =
            normalizeText(value);

        if (!text) {
            return "";
        }

        const timestamp =
            Date.parse(text);

        if (!Number.isFinite(timestamp)) {
            throw new TypeError(
                `Invalid date value: ${value}`
            );
        }

        return new Date(timestamp).toISOString();
    }

    function normalizeSort(value) {
        const normalized =
            normalizeText(
                value || "priority"
            ).toLowerCase();

        const allowed = new Set([
            "priority",
            "name",
            "id",
            "status",
            "available",
            "latency",
            "errors",
            "records",
            "updated_at",
            "region",
            "build"
        ]);

        if (!allowed.has(normalized)) {
            throw new TypeError(
                `Unsupported enabled-provider sort field: ${value}`
            );
        }

        return normalized;
    }

    function normalizeDirection(value) {
        const normalized =
            normalizeText(
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
            q:
                normalizeText(
                    source.q ??
                    source.query ??
                    ""
                ),
            limit:
                clampInteger(
                    source.limit,
                    DEFAULT_LIMIT,
                    MIN_LIMIT,
                    MAX_LIMIT
                ),
            offset:
                clampInteger(
                    source.offset,
                    0,
                    0,
                    Number.MAX_SAFE_INTEGER
                ),
            sort:
                normalizeSort(
                    source.sort
                ),
            direction:
                normalizeDirection(
                    source.direction ??
                    source.order
                )
        };

        for (
            const key of
            [
                "provider",
                "status",
                "capability",
                "protocol",
                "region",
                "country",
                "type",
                "category",
                "license",
                "build",
                "environment"
            ]
        ) {
            if (
                source[key] !== undefined &&
                source[key] !== null &&
                source[key] !== ""
            ) {
                normalized[key] =
                    normalizeText(
                        source[key]
                    );
            }
        }

        for (
            const key of
            [
                "available",
                "authenticated",
                "configured",
                "healthy"
            ]
        ) {
            if (
                source[key] !== undefined &&
                source[key] !== null &&
                source[key] !== ""
            ) {
                const value =
                    normalizeBoolean(
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
                "Enabled-provider start date must not be later than the end date."
            );
        }

        return normalized;
    }

    function numericValue(value, fallback = 0) {
        const number =
            Number(value);

        return Number.isFinite(number)
            ? number
            : fallback;
    }

    function normalizeStringArray(value) {
        if (Array.isArray(value)) {
            return [
                ...new Set(
                    value
                        .map(
                            normalizeText
                        )
                        .filter(Boolean)
                )
            ];
        }

        const text =
            normalizeText(value);

        if (!text) {
            return [];
        }

        return [
            ...new Set(
                text
                    .split(/[,\s]+/)
                    .map(
                        normalizeText
                    )
                    .filter(Boolean)
            )
        ];
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
                name:
                    normalizeText(record),
                enabled: true,
                configured: false,
                available: false,
                healthy: false,
                authenticated: false,
                status: "unknown",
                capabilities: [],
                protocols: []
            };
        }

        const enabled =
            record.enabled !== false &&
            record.disabled !== true;

        const configured =
            record.configured !== false &&
            record.configuration_valid !== false &&
            record.configurationValid !== false;

        const status =
            normalizeText(
                record.status ||
                (
                    enabled
                        ? "unknown"
                        : "disabled"
                )
            ).toLowerCase();

        const available =
            record.available !== undefined
                ? Boolean(record.available)
                : (
                    enabled &&
                    configured &&
                    ![
                        "offline",
                        "down",
                        "failed",
                        "error",
                        "disabled",
                        "unavailable"
                    ].includes(status)
                );

        const healthy =
            record.healthy !== undefined
                ? Boolean(record.healthy)
                : (
                    available &&
                    ![
                        "degraded",
                        "warning",
                        "failed",
                        "error"
                    ].includes(status)
                );

        return {
            ...record,
            index:
                record.index ??
                index,
            id:
                normalizeText(
                    record.id ??
                    record.key ??
                    record.slug ??
                    record.name ??
                    `provider-${index + 1}`
                ),
            name:
                normalizeText(
                    record.name ??
                    record.label ??
                    record.id ??
                    `Provider ${index + 1}`
                ),
            enabled,
            configured,
            available,
            healthy,
            authenticated:
                record.authenticated === true ||
                record.authentication_valid === true ||
                record.authenticationValid === true,
            status,
            priority:
                numericValue(
                    record.priority,
                    0
                ),
            latency:
                numericValue(
                    record.latency ??
                    record.latency_ms ??
                    record.latencyMs,
                    0
                ),
            errors:
                numericValue(
                    record.errors ??
                    record.error_count ??
                    record.errorCount,
                    0
                ),
            records:
                numericValue(
                    record.records ??
                    record.record_count ??
                    record.recordCount,
                    0
                ),
            build:
                normalizeText(
                    record.build ??
                    record.build_id ??
                    record.buildId ??
                    ""
                ),
            environment:
                normalizeText(
                    record.environment ??
                    ""
                ),
            region:
                normalizeText(
                    record.region ??
                    ""
                ),
            country:
                normalizeText(
                    record.country ??
                    ""
                ),
            type:
                normalizeText(
                    record.type ??
                    record.provider_type ??
                    ""
                ),
            category:
                normalizeText(
                    record.category ??
                    ""
                ),
            license:
                normalizeText(
                    record.license ??
                    record.licence ??
                    ""
                ),
            capabilities:
                normalizeStringArray(
                    record.capabilities ??
                    record.features ??
                    record.supports
                ),
            protocols:
                normalizeStringArray(
                    record.protocols ??
                    record.protocol ??
                    record.transports
                ),
            endpoints:
                Array.isArray(
                    record.endpoints
                )
                    ? record.endpoints
                    : (
                        record.endpoint
                            ? [record.endpoint]
                            : []
                    ),
            updated_at:
                record.updated_at ??
                record.updatedAt ??
                record.last_updated ??
                record.lastUpdated ??
                ""
        };
    }

    function summarize(records) {
        const values =
            Array.isArray(records)
                ? records
                : [];

        const latencies =
            values
                .map(
                    provider =>
                        numericValue(
                            provider.latency,
                            0
                        )
                )
                .filter(
                    value =>
                        value > 0
                );

        const statuses =
            new Map();

        const capabilities =
            new Map();

        const protocols =
            new Map();

        const builds =
            new Map();

        const environments =
            new Map();

        for (const provider of values) {
            statuses.set(
                provider.status ||
                "unknown",
                (
                    statuses.get(
                        provider.status ||
                        "unknown"
                    ) ||
                    0
                ) + 1
            );

            for (
                const capability of
                provider.capabilities || []
            ) {
                capabilities.set(
                    capability,
                    (
                        capabilities.get(
                            capability
                        ) ||
                        0
                    ) + 1
                );
            }

            for (
                const protocol of
                provider.protocols || []
            ) {
                protocols.set(
                    protocol,
                    (
                        protocols.get(
                            protocol
                        ) ||
                        0
                    ) + 1
                );
            }

            if (provider.build) {
                builds.set(
                    provider.build,
                    (
                        builds.get(
                            provider.build
                        ) ||
                        0
                    ) + 1
                );
            }

            if (provider.environment) {
                environments.set(
                    provider.environment,
                    (
                        environments.get(
                            provider.environment
                        ) ||
                        0
                    ) + 1
                );
            }
        }

        return {
            total:
                values.length,
            enabled:
                values.filter(
                    provider =>
                        provider.enabled
                ).length,
            configured:
                values.filter(
                    provider =>
                        provider.configured
                ).length,
            available:
                values.filter(
                    provider =>
                        provider.available
                ).length,
            healthy:
                values.filter(
                    provider =>
                        provider.healthy
                ).length,
            authenticated:
                values.filter(
                    provider =>
                        provider.authenticated
                ).length,
            unavailable:
                values.filter(
                    provider =>
                        !provider.available
                ).length,
            degraded:
                values.filter(
                    provider =>
                        provider.available &&
                        !provider.healthy
                ).length,
            records:
                values.reduce(
                    (sum, provider) =>
                        sum +
                        numericValue(
                            provider.records,
                            0
                        ),
                    0
                ),
            errors:
                values.reduce(
                    (sum, provider) =>
                        sum +
                        numericValue(
                            provider.errors,
                            0
                        ),
                    0
                ),
            averageLatency:
                latencies.length
                    ? latencies.reduce(
                        (sum, value) =>
                            sum + value,
                        0
                    ) /
                      latencies.length
                    : 0,
            minimumLatency:
                latencies.length
                    ? Math.min(
                        ...latencies
                    )
                    : 0,
            maximumLatency:
                latencies.length
                    ? Math.max(
                        ...latencies
                    )
                    : 0,
            statuses:
                Object.fromEntries(
                    [...statuses.entries()]
                        .sort(
                            (left, right) =>
                                right[1] -
                                left[1]
                        )
                ),
            capabilities:
                Object.fromEntries(
                    [...capabilities.entries()]
                        .sort(
                            (left, right) =>
                                right[1] -
                                left[1]
                        )
                ),
            protocols:
                Object.fromEntries(
                    [...protocols.entries()]
                        .sort(
                            (left, right) =>
                                right[1] -
                                left[1]
                        )
                ),
            builds:
                Object.fromEntries(
                    [...builds.entries()]
                        .sort(
                            (left, right) =>
                                right[1] -
                                left[1]
                        )
                ),
            environments:
                Object.fromEntries(
                    [...environments.entries()]
                        .sort(
                            (left, right) =>
                                right[1] -
                                left[1]
                        )
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
                                Array.isArray(payload.providers)
                                    ? payload.providers
                                    : (
                                        Array.isArray(payload.enabled)
                                            ? payload.enabled
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

    class EnabledProvidersService extends EventTarget {
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
                    "Enabled-providers service has been destroyed."
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
                    `enabled-providers:${name}`,
                    detail
                );
            } catch (_error) {
                /*
                Observer failures must not break provider operations.
                */
            }

            dispatch(
                this.context.root,
                `speciedex:terminal-enabled-providers-${name}`,
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
                        "providers/enabled",
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
                    "A provider ID or name is required."
                );
            }

            try {
                const payload =
                    await this.context.api.get(
                        `providers/enabled/${encodeURIComponent(normalizedId)}`,
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
                        provider =>
                            provider.id ===
                                normalizedId ||
                            provider.name
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

        async available(parameters = {}, options = {}) {
            const result =
                await this.list(
                    {
                        ...parameters,
                        available: true
                    },
                    options
                );

            const records =
                result.records.filter(
                    provider =>
                        provider.available
                );

            return {
                ...result,
                records,
                summary:
                    summarize(records)
            };
        }

        async healthy(parameters = {}, options = {}) {
            const result =
                await this.list(
                    {
                        ...parameters,
                        available: true,
                        healthy: true
                    },
                    options
                );

            const records =
                result.records.filter(
                    provider =>
                        provider.available &&
                        provider.healthy
                );

            return {
                ...result,
                records,
                summary:
                    summarize(records)
            };
        }

        async byCapability(capability, parameters = {}, options = {}) {
            const normalizedCapability =
                normalizeText(capability);

            if (!normalizedCapability) {
                throw new TypeError(
                    "A provider capability is required."
                );
            }

            return this.list(
                {
                    ...parameters,
                    capability:
                        normalizedCapability
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
                providers:
                    result.records
            };
        }

        status() {
            return {
                version: VERSION,
                endpoint:
                    "providers/enabled",
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
            EnabledProvidersService &&
            !existing.destroyed
        ) {
            context.enabledProviders =
                existing;

            return existing;
        }

        if (
            context.enabledProviders instanceof
            EnabledProvidersService &&
            !context.enabledProviders.destroyed
        ) {
            return context.enabledProviders;
        }

        const service =
            new EnabledProvidersService(
                context
            );

        context.enabledProviders =
            service;

        context.registerService?.(
            SERVICE_NAME,
            service
        );

        context.registerService?.(
            "enabledProviders",
            service
        );

        dispatch(
            document,
            "speciedex:terminal-enabled-providers-ready",
            {
                context,
                service
            }
        );

        return service;
    }

    function requireService(context) {
        const service =
            context?.enabledProviders ||
            context?.services?.get?.(
                SERVICE_NAME
            );

        if (
            !(
                service instanceof
                EnabledProvidersService
            )
        ) {
            throw new Error(
                "Enabled-providers service is unavailable."
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
                    "--status="
                )
            ) {
                parameters.status =
                    argument.slice(9);
                continue;
            }

            if (
                argument.startsWith(
                    "--capability="
                )
            ) {
                parameters.capability =
                    argument.slice(13);
                continue;
            }

            if (
                argument.startsWith(
                    "--protocol="
                )
            ) {
                parameters.protocol =
                    argument.slice(11);
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
                    "--country="
                )
            ) {
                parameters.country =
                    argument.slice(10);
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
                    "--category="
                )
            ) {
                parameters.category =
                    argument.slice(11);
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
                    "--build="
                )
            ) {
                parameters.build =
                    argument.slice(8);
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
                    "--available="
                )
            ) {
                parameters.available =
                    argument.slice(12);
                continue;
            }

            if (
                argument.startsWith(
                    "--authenticated="
                )
            ) {
                parameters.authenticated =
                    argument.slice(16);
                continue;
            }

            if (
                argument.startsWith(
                    "--configured="
                )
            ) {
                parameters.configured =
                    argument.slice(13);
                continue;
            }

            if (
                argument.startsWith(
                    "--healthy="
                )
            ) {
                parameters.healthy =
                    argument.slice(10);
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
            name: "enabled-providers",
            aliases: [
                "providers-enabled"
            ],
            category: "providers",
            description:
                "List providers enabled in the current build.",
            usage:
                "enabled-providers [query] [limit] [--status=STATUS] [--capability=NAME] [--protocol=NAME] [--region=REGION] [--country=COUNTRY] [--type=TYPE] [--category=CATEGORY] [--license=LICENSE] [--build=BUILD] [--environment=NAME] [--available=true|false] [--authenticated=true|false] [--configured=true|false] [--healthy=true|false] [--from=DATE] [--to=DATE] [--sort=FIELD] [--direction=asc|desc] [--offset=N]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                const parameters =
                    parseCommandArguments(
                        args
                    );

                const result =
                    await requireService(
                        context
                    ).list(
                        parameters
                    );

                return writeJSONValue(
                    writeJSON,
                    result
                );
            }
        },
        {
            name: "enabled-provider",
            aliases: [
                "provider-enabled"
            ],
            category: "providers",
            description:
                "Retrieve one enabled provider by ID or name.",
            usage:
                "enabled-provider <id|name>",
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
                        "A provider ID or name is required."
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
            name: "available-enabled-providers",
            aliases: [
                "enabled-providers-available"
            ],
            category: "providers",
            description:
                "List enabled providers currently available at runtime.",
            usage:
                "available-enabled-providers [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).available(
                        parseCommandArguments(
                            args
                        )
                    )
                )
        },
        {
            name: "healthy-enabled-providers",
            aliases: [
                "enabled-providers-healthy"
            ],
            category: "providers",
            description:
                "List enabled providers currently available and healthy.",
            usage:
                "healthy-enabled-providers [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).healthy(
                        parseCommandArguments(
                            args
                        )
                    )
                )
        },
        {
            name: "enabled-providers-summary",
            aliases: [
                "provider-build-summary"
            ],
            category: "providers",
            description:
                "Summarize enabled-provider build inclusion, runtime availability, health, capabilities, and protocols.",
            usage:
                "enabled-providers-summary [filters]",
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
            name: "enabled-providers-status",
            category: "providers",
            description:
                "Show enabled-provider service status.",
            usage:
                "enabled-providers-status",
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
        EnabledProvidersService,
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

    window.SpeciedexTerminalEnabledProviders =
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
