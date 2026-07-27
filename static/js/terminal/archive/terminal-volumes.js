/*
========================================================================
Speciedex.org
Terminal Volumes Module
========================================================================

Archive-volume service for SpeciedexTerminal.

Provides:

    • Validated volume-list API requests
    • Provider, release, status, format, type, date, and pagination filters
    • Single-volume retrieval
    • Normalized volume metadata
    • Record, file, and storage-size summaries
    • Lifecycle events and service registration
    • Terminal command integration
    • Abort-signal propagation
    • Loader-safe, idempotent initialization
    • Canonical lowercase module registration

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "volumes";
    const LEGACY_MODULE_NAME = "Volumes";
    const VERSION = "2.1.0";

    const ENDPOINT = "archive/volumes";
    const SERVICE_NAME = "volumes";
    const SERVICE_ALIAS = "volume";

    const DEFAULT_LIMIT = 50;
    const MIN_LIMIT = 1;
    const MAX_LIMIT = 1000;

    const SORT_FIELDS = Object.freeze([
        "created_at",
        "updated_at",
        "provider",
        "release",
        "status",
        "records",
        "files",
        "size",
        "version",
        "name"
    ]);

    const SORT_FIELD_SET = new Set(SORT_FIELDS);

    function now() {
        if (
            window.performance &&
            typeof window.performance.now === "function"
        ) {
            return window.performance.now();
        }

        return Date.now();
    }

    function createEvent(name, detail, options = {}) {
        const settings = {
            bubbles:
                options.bubbles === true,
            cancelable:
                options.cancelable === true,
            composed:
                options.composed === true,
            detail
        };

        if (typeof window.CustomEvent === "function") {
            return new window.CustomEvent(
                name,
                settings
            );
        }

        const event =
            document.createEvent(
                "CustomEvent"
            );

        event.initCustomEvent(
            name,
            settings.bubbles,
            settings.cancelable,
            detail
        );

        return event;
    }

    function dispatch(target, name, detail, options = {}) {
        if (
            !target ||
            typeof target.dispatchEvent !== "function"
        ) {
            return false;
        }

        try {
            return target.dispatchEvent(
                createEvent(
                    name,
                    detail,
                    options
                )
            );
        } catch (_error) {
            return false;
        }
    }

    function isObject(value) {
        return Boolean(
            value &&
            typeof value === "object" &&
            !Array.isArray(value)
        );
    }

    function normalizeText(value) {
        return String(value ?? "")
            .trim();
    }

    function clampInteger(
        value,
        fallback,
        minimum,
        maximum
    ) {
        if (
            value === undefined ||
            value === null ||
            value === ""
        ) {
            return fallback;
        }

        const parsed =
            Number.parseInt(value, 10);

        if (!Number.isFinite(parsed)) {
            throw new TypeError(
                `Expected an integer value; received: ${value}`
            );
        }

        return Math.min(
            maximum,
            Math.max(minimum, parsed)
        );
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

        return new Date(timestamp)
            .toISOString();
    }

    function normalizeSort(value) {
        const normalized =
            normalizeText(
                value || "created_at"
            ).toLowerCase();

        if (!SORT_FIELD_SET.has(normalized)) {
            throw new TypeError(
                `Unsupported volume sort field: ${value}`
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
            isObject(parameters)
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
            const key of [
                "provider",
                "release",
                "status",
                "format",
                "type",
                "version",
                "archive",
                "dataset",
                "compression"
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
                "Volume start date must not be later than the end date."
            );
        }

        return normalized;
    }

    function numericValue(value, fallback = null) {
        if (
            value === undefined ||
            value === null ||
            value === ""
        ) {
            return fallback;
        }

        const number =
            Number(value);

        return Number.isFinite(number)
            ? number
            : fallback;
    }

    function normalizeRecord(record, index = 0) {
        if (!isObject(record)) {
            return {
                index,
                value:
                    record
            };
        }

        const files =
            Array.isArray(record.files)
                ? record.files
                : [];

        return {
            ...record,
            index:
                record.index ??
                index,
            id:
                normalizeText(
                    record.id ??
                    record.volume_id ??
                    record.volumeId ??
                    ""
                ),
            name:
                normalizeText(
                    record.name ??
                    record.label ??
                    record.id ??
                    ""
                ),
            provider:
                normalizeText(
                    record.provider ??
                    record.source ??
                    ""
                ),
            release:
                normalizeText(
                    record.release ??
                    record.release_id ??
                    record.releaseId ??
                    ""
                ),
            archive:
                normalizeText(
                    record.archive ??
                    record.collection ??
                    ""
                ),
            status:
                normalizeText(
                    record.status ??
                    ""
                ),
            format:
                normalizeText(
                    record.format ??
                    record.media_type ??
                    record.mediaType ??
                    ""
                ),
            type:
                normalizeText(
                    record.type ??
                    record.volume_type ??
                    record.volumeType ??
                    ""
                ),
            version:
                normalizeText(
                    record.version ??
                    ""
                ),
            compression:
                normalizeText(
                    record.compression ??
                    record.codec ??
                    ""
                ),
            record_count:
                numericValue(
                    record.record_count ??
                    record.recordCount ??
                    record.records
                ),
            file_count:
                numericValue(
                    record.file_count ??
                    record.fileCount ??
                    files.length
                ),
            size_bytes:
                numericValue(
                    record.size_bytes ??
                    record.sizeBytes ??
                    record.size
                ),
            files
        };
    }

    function formatBytes(value) {
        const bytes =
            numericValue(value, 0);

        if (
            !Number.isFinite(bytes) ||
            bytes <= 0
        ) {
            return "0 B";
        }

        const units = [
            "B",
            "KiB",
            "MiB",
            "GiB",
            "TiB",
            "PiB",
            "EiB"
        ];

        const exponent =
            Math.min(
                units.length - 1,
                Math.floor(
                    Math.log(bytes) /
                    Math.log(1024)
                )
            );

        const amount =
            bytes /
            Math.pow(
                1024,
                exponent
            );

        return `${amount.toLocaleString(
            "en-US",
            {
                maximumFractionDigits: 2
            }
        )} ${units[exponent]}`;
    }

    function summarize(records) {
        const values =
            Array.isArray(records)
                ? records
                : [];

        const totalRecords =
            values.reduce(
                (sum, record) =>
                    sum +
                    numericValue(
                        record?.record_count,
                        0
                    ),
                0
            );

        const totalFiles =
            values.reduce(
                (sum, record) =>
                    sum +
                    numericValue(
                        record?.file_count,
                        0
                    ),
                0
            );

        const totalBytes =
            values.reduce(
                (sum, record) =>
                    sum +
                    numericValue(
                        record?.size_bytes,
                        0
                    ),
                0
            );

        return {
            volumes:
                values.length,
            records:
                totalRecords,
            files:
                totalFiles,
            size_bytes:
                totalBytes,
            size:
                formatBytes(totalBytes),
            average_records:
                values.length
                    ? totalRecords /
                        values.length
                    : 0,
            average_files:
                values.length
                    ? totalFiles /
                        values.length
                    : 0,
            average_size_bytes:
                values.length
                    ? totalBytes /
                        values.length
                    : 0,
            average_size:
                formatBytes(
                    values.length
                        ? totalBytes /
                            values.length
                        : 0
                )
        };
    }

    function groupBy(records, key) {
        const normalizedKey =
            normalizeText(key);

        if (!normalizedKey) {
            throw new TypeError(
                "A grouping key is required."
            );
        }

        const groups = new Map();

        for (
            const record of
            Array.isArray(records)
                ? records
                : []
        ) {
            const value =
                normalizeText(
                    record?.[
                        normalizedKey
                    ] ??
                    "unknown"
                ) ||
                "unknown";

            const current =
                groups.get(value) || {
                    key:
                        value,
                    volumes:
                        0,
                    records:
                        0,
                    files:
                        0,
                    size_bytes:
                        0
                };

            current.volumes += 1;

            current.records +=
                numericValue(
                    record?.record_count,
                    0
                );

            current.files +=
                numericValue(
                    record?.file_count,
                    0
                );

            current.size_bytes +=
                numericValue(
                    record?.size_bytes,
                    0
                );

            groups.set(
                value,
                current
            );
        }

        return [
            ...groups.values()
        ]
            .map(
                (group) => ({
                    ...group,
                    size:
                        formatBytes(
                            group.size_bytes
                        )
                })
            )
            .sort(
                (left, right) =>
                    right.size_bytes -
                        left.size_bytes ||
                    right.records -
                        left.records ||
                    left.key.localeCompare(
                        right.key
                    )
            );
    }

    function normalizeResponse(payload, parameters = {}) {
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
                    parameters.limit ??
                    records.length,
                offset:
                    parameters.offset ??
                    0,
                summary:
                    summarize(records),
                next: null,
                previous: null,
                parameters,
                raw: payload
            };
        }

        if (isObject(payload)) {
            const values =
                Array.isArray(payload.records)
                    ? payload.records
                    : Array.isArray(payload.items)
                        ? payload.items
                        : Array.isArray(payload.volumes)
                            ? payload.volumes
                            : Array.isArray(payload.data)
                                ? payload.data
                                : [];

            const records =
                values.map(
                    normalizeRecord
                );

            const calculatedSummary =
                summarize(records);

            const summary =
                isObject(payload.summary)
                    ? {
                        ...calculatedSummary,
                        ...payload.summary
                    }
                    : calculatedSummary;

            const numericTotal =
                Number(payload.total);

            const numericLimit =
                Number(payload.limit);

            const numericOffset =
                Number(payload.offset);

            return {
                records,
                total:
                    Number.isFinite(numericTotal)
                        ? numericTotal
                        : records.length,
                limit:
                    Number.isFinite(numericLimit)
                        ? numericLimit
                        : parameters.limit ??
                            records.length,
                offset:
                    Number.isFinite(numericOffset)
                        ? numericOffset
                        : parameters.offset ??
                            0,
                summary,
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
                parameters,
                raw: payload
            };
        }

        return {
            records: [],
            total: 0,
            limit:
                parameters.limit ??
                0,
            offset:
                parameters.offset ??
                0,
            summary:
                summarize([]),
            next: null,
            previous: null,
            parameters,
            raw: payload
        };
    }

    function resolveAPI(context) {
        const candidates = [
            context?.api,
            context?.services?.get?.("api"),
            context?.services?.get?.("terminal-api"),
            window.SpeciedexTerminalAPIInstance
        ];

        for (const candidate of candidates) {
            if (
                candidate &&
                typeof candidate.get === "function"
            ) {
                return candidate;
            }
        }

        return null;
    }

    function registerService(context, name, service) {
        let registered = false;

        if (
            typeof context?.registerService ===
            "function"
        ) {
            try {
                context.registerService(
                    name,
                    service
                );

                registered = true;
            } catch (_error) {
                /*
                Continue with direct registry insertion.
                */
            }
        }

        if (
            context?.services &&
            typeof context.services.set ===
                "function"
        ) {
            try {
                context.services.set(
                    name,
                    service
                );

                registered = true;
            } catch (_error) {
                /*
                Ignore custom registry failures.
                */
            }
        }

        if (
            context?.services &&
            typeof context.services === "object" &&
            typeof context.services.set !==
                "function"
        ) {
            try {
                context.services[name] =
                    service;

                registered = true;
            } catch (_error) {
                /*
                Ignore immutable registries.
                */
            }
        }

        return registered;
    }

    function unregisterService(context, name, service) {
        if (
            typeof context?.unregisterService ===
            "function"
        ) {
            try {
                context.unregisterService(
                    name,
                    service
                );
            } catch (_error) {
                /*
                Continue with registry cleanup.
                */
            }
        }

        if (
            context?.services &&
            typeof context.services.get ===
                "function" &&
            typeof context.services.delete ===
                "function"
        ) {
            try {
                if (
                    context.services.get(name) ===
                    service
                ) {
                    context.services.delete(name);
                }
            } catch (_error) {
                /*
                Ignore registry cleanup failures.
                */
            }
        }

        if (
            context?.services &&
            typeof context.services === "object" &&
            typeof context.services.get !==
                "function"
        ) {
            try {
                if (
                    context.services[name] ===
                    service
                ) {
                    delete context.services[name];
                }
            } catch (_error) {
                /*
                Ignore immutable registries.
                */
            }
        }
    }

    class VolumesService extends EventTarget {
        constructor(context) {
            super();

            if (!isObject(context)) {
                throw new TypeError(
                    "A terminal context is required."
                );
            }

            this.context = context;
            this.api = resolveAPI(context);
            this.destroyed = false;
            this.activeRequests = 0;
        }

        ensureAvailable() {
            if (this.destroyed) {
                throw new Error(
                    "Volumes service has been destroyed."
                );
            }

            if (
                !this.api ||
                typeof this.api.get !== "function"
            ) {
                this.api =
                    resolveAPI(this.context);
            }

            if (
                !this.api ||
                typeof this.api.get !== "function"
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
                    `volumes:${name}`,
                    detail
                );
            } catch (_error) {
                /*
                Observer failures must not break volume requests.
                */
            }

            dispatch(
                this.context.root ||
                    document,
                `speciedex:terminal-volumes-${name}`,
                detail,
                {
                    bubbles: true,
                    composed: true
                }
            );
        }

        async list(parameters = {}, options = {}) {
            this.ensureAvailable();

            const normalized =
                normalizeParameters(
                    parameters
                );

            const requestOptions =
                isObject(options)
                    ? options
                    : {};

            const startedAt =
                now();

            this.activeRequests += 1;

            this.emit(
                "request",
                {
                    operation:
                        "list",
                    endpoint:
                        ENDPOINT,
                    parameters:
                        normalized,
                    activeRequests:
                        this.activeRequests
                }
            );

            try {
                const payload =
                    await this.api.get(
                        ENDPOINT,
                        normalized,
                        requestOptions
                    );

                const result =
                    normalizeResponse(
                        payload,
                        normalized
                    );

                result.endpoint =
                    ENDPOINT;

                result.duration =
                    now() -
                    startedAt;

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
                        endpoint:
                            ENDPOINT,
                        error,
                        parameters:
                            normalized,
                        duration:
                            now() -
                            startedAt,
                        aborted:
                            error?.name ===
                            "AbortError"
                    }
                );

                throw error;
            } finally {
                this.activeRequests =
                    Math.max(
                        0,
                        this.activeRequests - 1
                    );
            }
        }

        async get(id, options = {}) {
            this.ensureAvailable();

            const normalizedId =
                normalizeText(id);

            if (!normalizedId) {
                throw new TypeError(
                    "A volume ID is required."
                );
            }

            const endpoint =
                `${ENDPOINT}/${encodeURIComponent(normalizedId)}`;

            const requestOptions =
                isObject(options)
                    ? options
                    : {};

            const startedAt =
                now();

            this.activeRequests += 1;

            this.emit(
                "request",
                {
                    operation:
                        "get",
                    endpoint,
                    id:
                        normalizedId,
                    activeRequests:
                        this.activeRequests
                }
            );

            try {
                const payload =
                    await this.api.get(
                        endpoint,
                        {},
                        requestOptions
                    );

                const source =
                    isObject(payload?.volume)
                        ? payload.volume
                        : isObject(payload?.data)
                            ? payload.data
                            : payload;

                const volume =
                    normalizeRecord(
                        source,
                        0
                    );

                this.emit(
                    "complete",
                    {
                        operation:
                            "get",
                        endpoint,
                        volume,
                        duration:
                            now() -
                            startedAt
                    }
                );

                return volume;
            } catch (error) {
                this.emit(
                    "error",
                    {
                        operation:
                            "get",
                        endpoint,
                        id:
                            normalizedId,
                        error,
                        duration:
                            now() -
                            startedAt,
                        aborted:
                            error?.name ===
                            "AbortError"
                    }
                );

                throw error;
            } finally {
                this.activeRequests =
                    Math.max(
                        0,
                        this.activeRequests - 1
                    );
            }
        }

        async latest(parameters = {}, options = {}) {
            const source =
                isObject(parameters)
                    ? parameters
                    : {};

            const result =
                await this.list(
                    {
                        ...source,
                        limit:
                            source.limit ??
                            1,
                        sort:
                            source.sort ??
                            "created_at",
                        direction:
                            source.direction ??
                            source.order ??
                            "desc"
                    },
                    options
                );

            return result.records[0] ||
                null;
        }

        async summary(parameters = {}, options = {}) {
            const source =
                isObject(parameters)
                    ? parameters
                    : {};

            const result =
                await this.list(
                    {
                        ...source,
                        limit:
                            source.limit ??
                            MAX_LIMIT
                    },
                    options
                );

            return {
                endpoint:
                    ENDPOINT,
                parameters:
                    result.parameters,
                summary:
                    summarize(
                        result.records
                    ),
                byProvider:
                    groupBy(
                        result.records,
                        "provider"
                    ),
                byRelease:
                    groupBy(
                        result.records,
                        "release"
                    ),
                byFormat:
                    groupBy(
                        result.records,
                        "format"
                    ),
                byStatus:
                    groupBy(
                        result.records,
                        "status"
                    ),
                duration:
                    result.duration
            };
        }

        async byProvider(
            provider,
            parameters = {},
            options = {}
        ) {
            const normalizedProvider =
                normalizeText(provider);

            if (!normalizedProvider) {
                throw new TypeError(
                    "A provider name is required."
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

        status() {
            const api =
                resolveAPI(
                    this.context
                );

            return {
                module:
                    MODULE_NAME,
                version:
                    VERSION,
                endpoint:
                    ENDPOINT,
                service:
                    SERVICE_NAME,
                sortFields:
                    [...SORT_FIELDS],
                available:
                    Boolean(
                        api &&
                        typeof api.get ===
                            "function"
                    ),
                activeRequests:
                    this.activeRequests,
                destroyed:
                    this.destroyed
            };
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            this.destroyed = true;

            unregisterService(
                this.context,
                SERVICE_NAME,
                this
            );

            unregisterService(
                this.context,
                SERVICE_ALIAS,
                this
            );

            if (
                this.context.volumes ===
                this
            ) {
                delete this.context.volumes;
            }

            const detail = {
                timestamp:
                    new Date().toISOString()
            };

            dispatch(
                this,
                "destroy",
                detail
            );

            dispatch(
                this.context.root ||
                    document,
                "speciedex:terminal-volumes-destroy",
                detail,
                {
                    bubbles: true,
                    composed: true
                }
            );

            return true;
        }
    }

    function findExistingService(context) {
        const candidates = [
            context?.volumes,
            context?.services?.get?.(
                SERVICE_NAME
            ),
            context?.services?.get?.(
                SERVICE_ALIAS
            ),
            context?.services?.[
                SERVICE_NAME
            ],
            context?.services?.[
                SERVICE_ALIAS
            ]
        ];

        for (const candidate of candidates) {
            if (
                candidate instanceof
                    VolumesService &&
                !candidate.destroyed
            ) {
                return candidate;
            }
        }

        return null;
    }

    function initialize(context) {
        if (!isObject(context)) {
            throw new TypeError(
                "A terminal context is required."
            );
        }

        const existing =
            findExistingService(
                context
            );

        if (existing) {
            context.volumes =
                existing;

            registerService(
                context,
                SERVICE_NAME,
                existing
            );

            registerService(
                context,
                SERVICE_ALIAS,
                existing
            );

            return existing;
        }

        const service =
            new VolumesService(
                context
            );

        context.volumes =
            service;

        registerService(
            context,
            SERVICE_NAME,
            service
        );

        registerService(
            context,
            SERVICE_ALIAS,
            service
        );

        const detail = {
            context,
            service,
            module:
                MODULE_NAME,
            version:
                VERSION
        };

        dispatch(
            document,
            "speciedex:terminal-volumes-ready",
            detail
        );

        dispatch(
            context.root ||
                document,
            "speciedex:terminal-service-ready",
            {
                name:
                    SERVICE_NAME,
                service,
                module:
                    MODULE_NAME
            },
            {
                bubbles: true,
                composed: true
            }
        );

        return service;
    }

    function requireService(context) {
        const service =
            findExistingService(
                context
            );

        if (service) {
            return service;
        }

        return initialize(context);
    }

    function tokenizeArguments(args) {
        if (Array.isArray(args)) {
            return args.map(
                (value) =>
                    String(value)
            );
        }

        if (typeof args === "string") {
            return args
                .trim()
                .split(/\s+/u)
                .filter(Boolean);
        }

        return [];
    }

    function parseCommandArguments(args = []) {
        const tokens =
            tokenizeArguments(args);

        const parameters = {};
        const positional = [];

        const optionMap = {
            "--limit": "limit",
            "--offset": "offset",
            "--provider": "provider",
            "--release": "release",
            "--status": "status",
            "--format": "format",
            "--type": "type",
            "--version": "version",
            "--archive": "archive",
            "--dataset": "dataset",
            "--compression": "compression",
            "--from": "from",
            "--to": "to",
            "--sort": "sort",
            "--direction": "direction",
            "--order": "direction",
            "--query": "q"
        };

        for (
            let index = 0;
            index < tokens.length;
            index += 1
        ) {
            const argument =
                tokens[index];

            if (
                argument === "--asc" ||
                argument === "-a"
            ) {
                parameters.direction =
                    "asc";
                continue;
            }

            if (
                argument === "--desc" ||
                argument === "-d"
            ) {
                parameters.direction =
                    "desc";
                continue;
            }

            if (argument.startsWith("--")) {
                const equalsIndex =
                    argument.indexOf("=");

                if (equalsIndex > 2) {
                    const key =
                        argument.slice(
                            0,
                            equalsIndex
                        );

                    const mapped =
                        optionMap[key];

                    if (!mapped) {
                        throw new TypeError(
                            `Unsupported volumes option: ${key}`
                        );
                    }

                    parameters[mapped] =
                        argument.slice(
                            equalsIndex + 1
                        );

                    continue;
                }

                const mapped =
                    optionMap[argument];

                if (!mapped) {
                    throw new TypeError(
                        `Unsupported volumes option: ${argument}`
                    );
                }

                const next =
                    tokens[index + 1];

                if (
                    next === undefined ||
                    next.startsWith("--")
                ) {
                    throw new TypeError(
                        `Missing value for volumes option: ${argument}`
                    );
                }

                parameters[mapped] =
                    next;

                index += 1;
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

        if (positional.length > 2) {
            parameters.q =
                positional
                    .slice(
                        0,
                        -1
                    )
                    .join(" ");

            parameters.limit =
                positional[
                    positional.length - 1
                ];
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

    const commands = Object.freeze([
        Object.freeze({
            name:
                "volumes",
            aliases: Object.freeze([
                "volume-list"
            ]),
            category:
                "archive",
            description:
                "List archive volumes and metadata.",
            usage:
                "volumes [query] [limit] [--provider NAME] [--release ID] [--status STATUS] [--format FORMAT] [--type TYPE] [--version VERSION] [--archive NAME] [--dataset NAME] [--compression TYPE] [--from DATE] [--to DATE] [--sort FIELD] [--direction asc|desc] [--offset N]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) => {
                const parameters =
                    parseCommandArguments(
                        args
                    );

                const result =
                    await requireService(
                        context
                    ).list(
                        parameters,
                        signal
                            ? { signal }
                            : {}
                    );

                return writeJSONValue(
                    writeJSON,
                    result
                );
            }
        }),
        Object.freeze({
            name:
                "volume",
            aliases: Object.freeze([
                "volume-get"
            ]),
            category:
                "archive",
            description:
                "Retrieve one archive volume by ID.",
            usage:
                "volume <id>",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) => {
                const tokens =
                    tokenizeArguments(args);

                if (!tokens[0]) {
                    throw new Error(
                        "A volume ID is required."
                    );
                }

                const result =
                    await requireService(
                        context
                    ).get(
                        tokens[0],
                        signal
                            ? { signal }
                            : {}
                    );

                return writeJSONValue(
                    writeJSON,
                    result
                );
            }
        }),
        Object.freeze({
            name:
                "volume-latest",
            aliases: Object.freeze([
                "latest-volume"
            ]),
            category:
                "archive",
            description:
                "Display the most recently created archive volume.",
            usage:
                "volume-latest [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) => {
                const parameters =
                    parseCommandArguments(
                        args
                    );

                const result =
                    await requireService(
                        context
                    ).latest(
                        parameters,
                        signal
                            ? { signal }
                            : {}
                    );

                return writeJSONValue(
                    writeJSON,
                    result
                );
            }
        }),
        Object.freeze({
            name:
                "volumes-summary",
            aliases: Object.freeze([
                "volume-summary"
            ]),
            category:
                "archive",
            description:
                "Summarize archive volume records, files, and storage.",
            usage:
                "volumes-summary [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) => {
                const parameters =
                    parseCommandArguments(
                        args
                    );

                const result =
                    await requireService(
                        context
                    ).summary(
                        parameters,
                        signal
                            ? { signal }
                            : {}
                    );

                return writeJSONValue(
                    writeJSON,
                    result
                );
            }
        }),
        Object.freeze({
            name:
                "volumes-status",
            category:
                "archive",
            description:
                "Show volume-service status.",
            usage:
                "volumes-status",
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
        })
    ]);

    const api = Object.freeze({
        name:
            MODULE_NAME,
        legacyName:
            LEGACY_MODULE_NAME,
        version:
            VERSION,
        endpoint:
            ENDPOINT,
        serviceName:
            SERVICE_NAME,
        serviceAlias:
            SERVICE_ALIAS,
        sortFields:
            SORT_FIELDS,
        VolumesService,
        normalizeParameters,
        normalizeRecord,
        normalizeResponse,
        numericValue,
        formatBytes,
        summarize,
        groupBy,
        parseCommandArguments,
        initialize,
        mount:
            initialize,
        init:
            initialize,
        setup:
            initialize,
        commands
    });

    window.SpeciedexTerminalVolumes =
        api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules || {};

    window.SpeciedexTerminalModules[
        MODULE_NAME
    ] = api;

    /*
    --------------------------------------------------------------------
    Historical loader bridge. Canonical registration remains "volumes".
    --------------------------------------------------------------------
    */
    window.SpeciedexTerminalModules[
        LEGACY_MODULE_NAME
    ] = api;

    dispatch(
        document,
        "speciedex:terminal-module-available",
        {
            name:
                MODULE_NAME,
            legacyName:
                LEGACY_MODULE_NAME,
            module:
                api
        }
    );
})(window, document);
