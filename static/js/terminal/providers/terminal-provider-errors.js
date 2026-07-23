/*
========================================================================
Speciedex.org
Terminal ProviderErrors Module
========================================================================

Provider ingestion and validation error service for SpeciedexTerminal.

Provides:

    • Validated provider-error API requests
    • Provider, severity, stage, code, status, source, retry, and date filters
    • Normalized provider error and diagnostic records
    • Severity, stage, provider, code, source, and retry summaries
    • Single-error retrieval
    • Active, retryable, fatal, and validation-error views
    • Lifecycle events, caching, and resilient service registration
    • Terminal command integration

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "ProviderErrors";
    const VERSION = "2.0.0";
    const SERVICE_NAME = "provider-errors";

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
            value || "occurred_at"
        ).toLowerCase();

        const allowed = new Set([
            "occurred_at",
            "created_at",
            "updated_at",
            "provider",
            "severity",
            "stage",
            "code",
            "status",
            "retry_count",
            "source",
            "id"
        ]);

        if (!allowed.has(normalized)) {
            throw new TypeError(
                `Unsupported provider-error sort field: ${value}`
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
                "severity",
                "stage",
                "code",
                "status",
                "source",
                "field",
                "record",
                "record_id",
                "job",
                "job_id",
                "run",
                "run_id",
                "error",
                "error_id",
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
                "active",
                "resolved",
                "retryable",
                "fatal",
                "validation"
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

        const minimumRetries =
            source.minRetries ??
            source.min_retries;

        const maximumRetries =
            source.maxRetries ??
            source.max_retries;

        if (
            minimumRetries !== undefined &&
            minimumRetries !== null &&
            minimumRetries !== ""
        ) {
            normalized.min_retries =
                clampInteger(
                    minimumRetries,
                    0,
                    0,
                    Number.MAX_SAFE_INTEGER
                );
        }

        if (
            maximumRetries !== undefined &&
            maximumRetries !== null &&
            maximumRetries !== ""
        ) {
            normalized.max_retries =
                clampInteger(
                    maximumRetries,
                    Number.MAX_SAFE_INTEGER,
                    0,
                    Number.MAX_SAFE_INTEGER
                );
        }

        if (
            normalized.min_retries !== undefined &&
            normalized.max_retries !== undefined &&
            normalized.min_retries >
            normalized.max_retries
        ) {
            throw new RangeError(
                "Minimum retries must not exceed maximum retries."
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
                "Provider-error start date must not be later than the end date."
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

    function normalizeSeverity(value, fallback = "error") {
        const normalized = normalizeText(
            value || fallback
        ).toLowerCase();

        const aliases = {
            warn: "warning",
            critical: "fatal",
            severe: "fatal",
            informational: "info"
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
                severity: "error",
                stage: "unknown",
                code: "",
                message:
                    normalizeText(record),
                status: "active",
                active: true,
                resolved: false,
                retryable: false,
                fatal: false,
                validation: false,
                retry_count: 0,
                sources: []
            };
        }

        const severity = normalizeSeverity(
            record.severity ??
            record.level ??
            record.priority ??
            "error"
        );

        const status = normalizeText(
            record.status ??
            (
                record.resolved === true
                    ? "resolved"
                    : "active"
            )
        ).toLowerCase();

        const resolved =
            record.resolved === true ||
            [
                "resolved",
                "closed",
                "dismissed",
                "ignored"
            ].includes(status);

        const active =
            record.active !== false &&
            !resolved &&
            ![
                "inactive",
                "deleted"
            ].includes(status);

        const fatal =
            record.fatal === true ||
            severity === "fatal";

        const retryable =
            record.retryable === true ||
            record.can_retry === true ||
            record.canRetry === true;

        const stage = normalizeText(
            record.stage ??
            record.phase ??
            record.operation ??
            record.pipeline_stage ??
            record.pipelineStage ??
            "unknown"
        ).toLowerCase();

        const validation =
            record.validation === true ||
            stage === "validation" ||
            normalizeText(
                record.category
            ).toLowerCase() === "validation";

        return {
            ...record,
            index:
                record.index ??
                index,
            id: normalizeText(
                record.id ??
                record.error_id ??
                record.errorId ??
                record.uuid ??
                `provider-error-${index + 1}`
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
            severity,
            stage,
            code: normalizeText(
                record.code ??
                record.error_code ??
                record.errorCode ??
                record.name ??
                ""
            ),
            type: normalizeText(
                record.type ??
                record.error_type ??
                record.errorType ??
                ""
            ),
            category: normalizeText(
                record.category ??
                ""
            ),
            message: normalizeText(
                record.message ??
                record.error ??
                record.detail ??
                record.description ??
                ""
            ),
            details:
                record.details ??
                record.context ??
                record.metadata ??
                null,
            status,
            active,
            resolved,
            retryable,
            fatal,
            validation,
            retry_count: numericValue(
                record.retry_count ??
                record.retryCount ??
                record.retries,
                0
            ),
            max_retries: numericValue(
                record.max_retries ??
                record.maxRetries,
                0
            ),
            record_id: normalizeText(
                record.record_id ??
                record.recordId ??
                record.entity_id ??
                record.entityId ??
                ""
            ),
            job_id: normalizeText(
                record.job_id ??
                record.jobId ??
                ""
            ),
            run_id: normalizeText(
                record.run_id ??
                record.runId ??
                record.execution_id ??
                record.executionId ??
                ""
            ),
            field: normalizeText(
                record.field ??
                record.property ??
                record.attribute ??
                ""
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
            stack: normalizeText(
                record.stack ??
                record.stack_trace ??
                record.stackTrace ??
                ""
            ),
            occurred_at:
                record.occurred_at ??
                record.occurredAt ??
                record.timestamp ??
                record.created_at ??
                record.createdAt ??
                "",
            created_at:
                record.created_at ??
                record.createdAt ??
                "",
            updated_at:
                record.updated_at ??
                record.updatedAt ??
                record.last_updated ??
                record.lastUpdated ??
                "",
            resolved_at:
                record.resolved_at ??
                record.resolvedAt ??
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
        const severities = new Map();
        const stages = new Map();
        const codes = new Map();
        const statuses = new Map();
        const sources = new Map();
        const categories = new Map();
        const types = new Map();

        let retryCount = 0;

        for (const errorRecord of values) {
            incrementMap(
                providers,
                errorRecord.provider
            );

            incrementMap(
                severities,
                errorRecord.severity
            );

            incrementMap(
                stages,
                errorRecord.stage
            );

            incrementMap(
                codes,
                errorRecord.code
            );

            incrementMap(
                statuses,
                errorRecord.status
            );

            incrementMap(
                categories,
                errorRecord.category
            );

            incrementMap(
                types,
                errorRecord.type
            );

            for (
                const source of
                errorRecord.sources || []
            ) {
                incrementMap(
                    sources,
                    source
                );
            }

            retryCount += numericValue(
                errorRecord.retry_count,
                0
            );
        }

        return {
            total:
                values.length,
            active:
                values.filter(
                    item =>
                        item.active
                ).length,
            resolved:
                values.filter(
                    item =>
                        item.resolved
                ).length,
            retryable:
                values.filter(
                    item =>
                        item.retryable
                ).length,
            fatal:
                values.filter(
                    item =>
                        item.fatal
                ).length,
            validation:
                values.filter(
                    item =>
                        item.validation
                ).length,
            retries:
                retryCount,
            providers:
                mapToSortedObject(
                    providers
                ),
            severities:
                mapToSortedObject(
                    severities
                ),
            stages:
                mapToSortedObject(
                    stages
                ),
            codes:
                mapToSortedObject(
                    codes
                ),
            statuses:
                mapToSortedObject(
                    statuses
                ),
            sources:
                mapToSortedObject(
                    sources
                ),
            categories:
                mapToSortedObject(
                    categories
                ),
            types:
                mapToSortedObject(
                    types
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
                                Array.isArray(payload.errors)
                                    ? payload.errors
                                    : []
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

    class ProviderErrorsService extends EventTarget {
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
                    "Provider-errors service has been destroyed."
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
                    `provider-errors:${name}`,
                    detail
                );
            } catch (_error) {
                /*
                Observer failures must not break provider-error operations.
                */
            }

            dispatch(
                this.context.root,
                `speciedex:terminal-provider-errors-${name}`,
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
                        "providers/errors",
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
                    "A provider-error ID is required."
                );
            }

            try {
                const payload =
                    await this.context.api.get(
                        `providers/errors/${encodeURIComponent(normalizedId)}`,
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
                            normalizedId
                    );

                if (match) {
                    return match;
                }

                throw error;
            }
        }

        async active(parameters = {}, options = {}) {
            const result =
                await this.list(
                    {
                        ...parameters,
                        active: true,
                        resolved: false
                    },
                    options
                );

            const records =
                result.records.filter(
                    item =>
                        item.active &&
                        !item.resolved
                );

            return {
                ...result,
                records,
                summary:
                    summarize(records)
            };
        }

        async retryable(parameters = {}, options = {}) {
            const result =
                await this.list(
                    {
                        ...parameters,
                        retryable: true
                    },
                    options
                );

            const records =
                result.records.filter(
                    item =>
                        item.retryable
                );

            return {
                ...result,
                records,
                summary:
                    summarize(records)
            };
        }

        async fatal(parameters = {}, options = {}) {
            const result =
                await this.list(
                    {
                        ...parameters,
                        fatal: true
                    },
                    options
                );

            const records =
                result.records.filter(
                    item =>
                        item.fatal
                );

            return {
                ...result,
                records,
                summary:
                    summarize(records)
            };
        }

        async validation(parameters = {}, options = {}) {
            const result =
                await this.list(
                    {
                        ...parameters,
                        validation: true
                    },
                    options
                );

            const records =
                result.records.filter(
                    item =>
                        item.validation
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
                errors:
                    result.records
            };
        }

        status() {
            return {
                version: VERSION,
                endpoint:
                    "providers/errors",
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
            ProviderErrorsService &&
            !existing.destroyed
        ) {
            context.providerErrors =
                existing;

            return existing;
        }

        if (
            context.providerErrors instanceof
            ProviderErrorsService &&
            !context.providerErrors.destroyed
        ) {
            return context.providerErrors;
        }

        const service =
            new ProviderErrorsService(
                context
            );

        context.providerErrors =
            service;

        context.registerService?.(
            SERVICE_NAME,
            service
        );

        context.registerService?.(
            "providerErrors",
            service
        );

        dispatch(
            document,
            "speciedex:terminal-provider-errors-ready",
            {
                context,
                service
            }
        );

        return service;
    }

    function requireService(context) {
        const service =
            context?.providerErrors ||
            context?.services?.get?.(
                SERVICE_NAME
            );

        if (
            !(
                service instanceof
                ProviderErrorsService
            )
        ) {
            throw new Error(
                "Provider-errors service is unavailable."
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
                    "--severity="
                )
            ) {
                parameters.severity =
                    argument.slice(11);
                continue;
            }

            if (
                argument.startsWith(
                    "--stage="
                )
            ) {
                parameters.stage =
                    argument.slice(8);
                continue;
            }

            if (
                argument.startsWith(
                    "--code="
                )
            ) {
                parameters.code =
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
                    "--source="
                )
            ) {
                parameters.source =
                    argument.slice(9);
                continue;
            }

            if (
                argument.startsWith(
                    "--field="
                )
            ) {
                parameters.field =
                    argument.slice(8);
                continue;
            }

            if (
                argument.startsWith(
                    "--record="
                )
            ) {
                parameters.record =
                    argument.slice(9);
                continue;
            }

            if (
                argument.startsWith(
                    "--job="
                )
            ) {
                parameters.job =
                    argument.slice(6);
                continue;
            }

            if (
                argument.startsWith(
                    "--run="
                )
            ) {
                parameters.run =
                    argument.slice(6);
                continue;
            }

            if (
                argument.startsWith(
                    "--error="
                )
            ) {
                parameters.error =
                    argument.slice(8);
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
                    "--type="
                )
            ) {
                parameters.type =
                    argument.slice(7);
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
                    "--resolved="
                )
            ) {
                parameters.resolved =
                    argument.slice(11);
                continue;
            }

            if (
                argument.startsWith(
                    "--retryable="
                )
            ) {
                parameters.retryable =
                    argument.slice(12);
                continue;
            }

            if (
                argument.startsWith(
                    "--fatal="
                )
            ) {
                parameters.fatal =
                    argument.slice(8);
                continue;
            }

            if (
                argument.startsWith(
                    "--validation="
                )
            ) {
                parameters.validation =
                    argument.slice(13);
                continue;
            }

            if (
                argument.startsWith(
                    "--min-retries="
                )
            ) {
                parameters.min_retries =
                    argument.slice(14);
                continue;
            }

            if (
                argument.startsWith(
                    "--max-retries="
                )
            ) {
                parameters.max_retries =
                    argument.slice(14);
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
            name: "provider-errors",
            aliases: [
                "providers-errors"
            ],
            category: "providers",
            description:
                "Inspect provider ingestion and validation errors.",
            usage:
                "provider-errors [query] [limit] [--provider=ID] [--severity=LEVEL] [--stage=STAGE] [--code=CODE] [--status=STATUS] [--source=SOURCE] [--field=FIELD] [--record=ID] [--job=ID] [--run=ID] [--error=ID] [--category=CATEGORY] [--type=TYPE] [--active=true|false] [--resolved=true|false] [--retryable=true|false] [--fatal=true|false] [--validation=true|false] [--min-retries=N] [--max-retries=N] [--from=DATE] [--to=DATE] [--sort=FIELD] [--direction=asc|desc] [--offset=N]",
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
            name: "provider-error",
            aliases: [
                "provider-error-get"
            ],
            category: "providers",
            description:
                "Retrieve one provider error by ID.",
            usage:
                "provider-error <id>",
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
                        "A provider-error ID is required."
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
            name: "provider-errors-active",
            aliases: [
                "active-provider-errors"
            ],
            category: "providers",
            description:
                "List active unresolved provider errors.",
            usage:
                "provider-errors-active [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).active(
                        parseCommandArguments(
                            args
                        )
                    )
                )
        },
        {
            name: "provider-errors-retryable",
            aliases: [
                "retryable-provider-errors"
            ],
            category: "providers",
            description:
                "List provider errors eligible for retry.",
            usage:
                "provider-errors-retryable [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).retryable(
                        parseCommandArguments(
                            args
                        )
                    )
                )
        },
        {
            name: "provider-errors-fatal",
            aliases: [
                "fatal-provider-errors"
            ],
            category: "providers",
            description:
                "List fatal provider errors.",
            usage:
                "provider-errors-fatal [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).fatal(
                        parseCommandArguments(
                            args
                        )
                    )
                )
        },
        {
            name: "provider-validation-errors",
            aliases: [
                "provider-errors-validation"
            ],
            category: "providers",
            description:
                "List provider validation errors.",
            usage:
                "provider-validation-errors [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).validation(
                        parseCommandArguments(
                            args
                        )
                    )
                )
        },
        {
            name: "provider-errors-summary",
            aliases: [
                "provider-error-summary"
            ],
            category: "providers",
            description:
                "Summarize provider errors by provider, severity, stage, code, source, status, category, and retry state.",
            usage:
                "provider-errors-summary [filters]",
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
            name: "provider-errors-status",
            category: "providers",
            description:
                "Show provider-errors service status.",
            usage:
                "provider-errors-status",
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
        ProviderErrorsService,
        normalizeParameters,
        normalizeRecord,
        normalizeResponse,
        normalizeSeverity,
        normalizeStringArray,
        summarize,
        parseCommandArguments,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalProviderErrors =
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
