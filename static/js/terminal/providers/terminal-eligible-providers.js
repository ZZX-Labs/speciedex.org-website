/*
========================================================================
Speciedex.org
Terminal EligibleProviders Module
========================================================================

Provider-ingestion eligibility service for SpeciedexTerminal.

Provides:

    • Validated eligible-provider API requests
    • Provider, status, capability, protocol, license, region, and pagination filters
    • Normalized provider eligibility records
    • Eligibility-reason, readiness, and capability summaries
    • Single-provider eligibility lookup
    • Lifecycle events and service registration
    • Terminal command integration

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "EligibleProviders";
    const VERSION = "2.0.0";
    const SERVICE_NAME = "eligible-providers";

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

    function normalizeText(value) {
        return String(value ?? "").trim();
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
            value || "priority"
        ).toLowerCase();

        const allowed = new Set([
            "priority",
            "name",
            "id",
            "status",
            "readiness",
            "latency",
            "errors",
            "records",
            "updated_at",
            "region"
        ]);

        if (!allowed.has(normalized)) {
            throw new TypeError(
                `Unsupported eligible-provider sort field: ${value}`
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
                "status",
                "capability",
                "protocol",
                "license",
                "region",
                "country",
                "type",
                "category",
                "reason"
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
                "enabled",
                "available",
                "eligible",
                "authenticated",
                "licensed"
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

        const minimumReadiness =
            source.minReadiness ??
            source.min_readiness;

        if (
            minimumReadiness !== undefined &&
            minimumReadiness !== null &&
            minimumReadiness !== ""
        ) {
            const readiness =
                Number(minimumReadiness);

            if (!Number.isFinite(readiness)) {
                throw new TypeError(
                    `Invalid minimum readiness value: ${minimumReadiness}`
                );
            }

            normalized.min_readiness =
                Math.min(
                    1,
                    Math.max(
                        0,
                        readiness > 1 &&
                        readiness <= 100
                            ? readiness / 100
                            : readiness
                    )
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
                "Eligible-provider start date must not be later than the end date."
            );
        }

        return normalized;
    }

    function numericValue(value, fallback = 0) {
        const number = Number(value);

        return Number.isFinite(number)
            ? number
            : fallback;
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

    function normalizeReadiness(value) {
        const number = Number(value);

        if (!Number.isFinite(number)) {
            return null;
        }

        return Math.min(
            1,
            Math.max(
                0,
                number > 1 &&
                number <= 100
                    ? number / 100
                    : number
            )
        );
    }

    function normalizeRecord(record, index = 0) {
        if (
            !record ||
            typeof record !== "object"
        ) {
            return {
                index,
                id: normalizeText(record),
                name: normalizeText(record),
                eligible: false,
                enabled: false,
                available: false,
                readiness: null,
                reasons: []
            };
        }

        const enabled =
            record.enabled !== false &&
            record.disabled !== true;

        const available =
            record.available !== false &&
            record.status !== "offline" &&
            record.status !== "down";

        const reasons = normalizeStringArray(
            record.reasons ??
            record.eligibility_reasons ??
            record.eligibilityReasons ??
            record.reason
        );

        const explicitEligibility =
            record.eligible ??
            record.is_eligible ??
            record.isEligible;

        const readiness = normalizeReadiness(
            record.readiness ??
            record.readiness_score ??
            record.readinessScore ??
            record.eligibility_score ??
            record.eligibilityScore
        );

        const eligible =
            explicitEligibility !== undefined
                ? Boolean(explicitEligibility)
                : (
                    enabled &&
                    available &&
                    reasons.length === 0
                );

        return {
            ...record,
            index:
                record.index ??
                index,
            id: normalizeText(
                record.id ??
                record.key ??
                record.slug ??
                record.name ??
                `provider-${index + 1}`
            ),
            name: normalizeText(
                record.name ??
                record.label ??
                record.id ??
                `Provider ${index + 1}`
            ),
            eligible,
            enabled,
            available,
            authenticated:
                record.authenticated === true ||
                record.authentication_valid === true ||
                record.authenticationValid === true,
            licensed:
                record.licensed !== false &&
                record.license_valid !== false &&
                record.licenseValid !== false,
            status: normalizeText(
                record.status ??
                (
                    eligible
                        ? "eligible"
                        : "ineligible"
                )
            ).toLowerCase(),
            readiness,
            reasons,
            priority: numericValue(
                record.priority,
                0
            ),
            latency: numericValue(
                record.latency ??
                record.latency_ms ??
                record.latencyMs,
                0
            ),
            errors: numericValue(
                record.errors ??
                record.error_count ??
                record.errorCount,
                0
            ),
            records: numericValue(
                record.records ??
                record.record_count ??
                record.recordCount,
                0
            ),
            capabilities: normalizeStringArray(
                record.capabilities ??
                record.features ??
                record.supports
            ),
            protocols: normalizeStringArray(
                record.protocols ??
                record.protocol ??
                record.transports
            ),
            region: normalizeText(
                record.region ??
                ""
            ),
            country: normalizeText(
                record.country ??
                ""
            ),
            type: normalizeText(
                record.type ??
                record.provider_type ??
                ""
            ),
            category: normalizeText(
                record.category ??
                ""
            ),
            license: normalizeText(
                record.license ??
                record.licence ??
                ""
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

        const eligible = values.filter(
            provider =>
                provider.eligible
        );

        const readinessValues =
            values
                .map(
                    provider =>
                        provider.readiness
                )
                .filter(
                    value =>
                        Number.isFinite(value)
                );

        const reasons = new Map();
        const capabilities = new Map();

        for (const provider of values) {
            for (
                const reason of
                provider.reasons || []
            ) {
                reasons.set(
                    reason,
                    (
                        reasons.get(reason) ||
                        0
                    ) + 1
                );
            }

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
        }

        return {
            total:
                values.length,
            eligible:
                eligible.length,
            ineligible:
                values.length -
                eligible.length,
            enabled:
                values.filter(
                    provider =>
                        provider.enabled
                ).length,
            available:
                values.filter(
                    provider =>
                        provider.available
                ).length,
            authenticated:
                values.filter(
                    provider =>
                        provider.authenticated
                ).length,
            licensed:
                values.filter(
                    provider =>
                        provider.licensed
                ).length,
            averageReadiness:
                readinessValues.length
                    ? readinessValues.reduce(
                        (sum, value) =>
                            sum + value,
                        0
                    ) /
                      readinessValues.length
                    : null,
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
            reasons:
                Object.fromEntries(
                    [...reasons.entries()]
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
                                Array.isArray(
                                    payload.providers
                                )
                                    ? payload.providers
                                    : (
                                        Array.isArray(
                                            payload.eligible
                                        )
                                            ? payload.eligible
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

    class EligibleProvidersService extends EventTarget {
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
                    "Eligible-providers service has been destroyed."
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
                    `eligible-providers:${name}`,
                    detail
                );
            } catch (_error) {
                /*
                Observer failures must not break provider operations.
                */
            }

            dispatch(
                this.context.root,
                `speciedex:terminal-eligible-providers-${name}`,
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
                        "providers/eligible",
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
                        `providers/eligible/${encodeURIComponent(normalizedId)}`,
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

        async ready(parameters = {}, options = {}) {
            const result =
                await this.list(
                    {
                        ...parameters,
                        eligible: true,
                        enabled: true,
                        available: true
                    },
                    options
                );

            const records =
                result.records.filter(
                    provider =>
                        provider.eligible &&
                        provider.enabled &&
                        provider.available
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
                    "providers/eligible",
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
            EligibleProvidersService &&
            !existing.destroyed
        ) {
            context.eligibleProviders =
                existing;

            return existing;
        }

        if (
            context.eligibleProviders instanceof
            EligibleProvidersService &&
            !context.eligibleProviders.destroyed
        ) {
            return context.eligibleProviders;
        }

        const service =
            new EligibleProvidersService(
                context
            );

        context.eligibleProviders =
            service;

        context.registerService?.(
            SERVICE_NAME,
            service
        );

        context.registerService?.(
            "eligibleProviders",
            service
        );

        dispatch(
            document,
            "speciedex:terminal-eligible-providers-ready",
            {
                context,
                service
            }
        );

        return service;
    }

    function requireService(context) {
        const service =
            context?.eligibleProviders ||
            context?.services?.get?.(
                SERVICE_NAME
            );

        if (
            !(
                service instanceof
                EligibleProvidersService
            )
        ) {
            throw new Error(
                "Eligible-providers service is unavailable."
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
                    "--license="
                )
            ) {
                parameters.license =
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
                    "--reason="
                )
            ) {
                parameters.reason =
                    argument.slice(9);
                continue;
            }

            if (
                argument.startsWith(
                    "--enabled="
                )
            ) {
                parameters.enabled =
                    argument.slice(10);
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
                    "--eligible="
                )
            ) {
                parameters.eligible =
                    argument.slice(11);
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
                    "--licensed="
                )
            ) {
                parameters.licensed =
                    argument.slice(11);
                continue;
            }

            if (
                argument.startsWith(
                    "--min-readiness="
                )
            ) {
                parameters.min_readiness =
                    argument.slice(16);
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
            name: "eligible-providers",
            aliases: [
                "provider-eligibility"
            ],
            category: "providers",
            description:
                "List providers eligible for ingestion.",
            usage:
                "eligible-providers [query] [limit] [--status=STATUS] [--capability=NAME] [--protocol=NAME] [--license=LICENSE] [--region=REGION] [--country=COUNTRY] [--type=TYPE] [--category=CATEGORY] [--reason=REASON] [--enabled=true|false] [--available=true|false] [--eligible=true|false] [--authenticated=true|false] [--licensed=true|false] [--min-readiness=N] [--from=DATE] [--to=DATE] [--sort=FIELD] [--direction=asc|desc] [--offset=N]",
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
            name: "eligible-provider",
            aliases: [
                "provider-eligibility-get"
            ],
            category: "providers",
            description:
                "Retrieve eligibility information for one provider.",
            usage:
                "eligible-provider <id|name>",
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
            name: "ingestion-ready-providers",
            aliases: [
                "ready-providers"
            ],
            category: "providers",
            description:
                "List enabled, available, and eligible providers ready for ingestion.",
            usage:
                "ingestion-ready-providers [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).ready(
                        parseCommandArguments(
                            args
                        )
                    )
                )
        },
        {
            name: "eligible-providers-summary",
            aliases: [
                "provider-eligibility-summary"
            ],
            category: "providers",
            description:
                "Summarize provider eligibility, readiness, reasons, and capabilities.",
            usage:
                "eligible-providers-summary [filters]",
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
            name: "eligible-providers-status",
            category: "providers",
            description:
                "Show eligible-provider service status.",
            usage:
                "eligible-providers-status",
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
        EligibleProvidersService,
        normalizeParameters,
        normalizeRecord,
        normalizeResponse,
        normalizeReadiness,
        normalizeStringArray,
        summarize,
        parseCommandArguments,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalEligibleProviders =
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
