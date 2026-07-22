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

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Volumes";
    const VERSION = "2.0.0";
    const SERVICE_NAME = "volumes";

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
        const parsed =
            Number.parseInt(value, 10);

        if (!Number.isFinite(parsed)) {
            return fallback;
        }

        return Math.min(
            maximum,
            Math.max(minimum, parsed)
        );
    }

    function normalizeText(value) {
        return String(value ?? "")
            .trim();
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
                value || "created_at"
            ).toLowerCase();

        const allowed = new Set([
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

        if (!allowed.has(normalized)) {
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
        const number =
            Number(value);

        return Number.isFinite(number)
            ? number
            : fallback;
    }

    function normalizeRecord(record, index = 0) {
        if (
            !record ||
            typeof record !== "object"
        ) {
            return {
                index,
                value: record
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

        if (bytes <= 0) {
            return "0 B";
        }

        const units = [
            "B",
            "KiB",
            "MiB",
            "GiB",
            "TiB",
            "PiB"
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
            undefined,
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
                        record.record_count,
                        0
                    ),
                0
            );

        const totalFiles =
            values.reduce(
                (sum, record) =>
                    sum +
                    numericValue(
                        record.file_count,
                        0
                    ),
                0
            );

        const totalBytes =
            values.reduce(
                (sum, record) =>
                    sum +
                    numericValue(
                        record.size_bytes,
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
        const groups = new Map();

        for (
            const record of
            Array.isArray(records)
                ? records
                : []
        ) {
            const value =
                normalizeText(
                    record[key] ??
                    "unknown"
                ) || "unknown";

            const current =
                groups.get(value) || {
                    key: value,
                    volumes: 0,
                    records: 0,
                    files: 0,
                    size_bytes: 0
                };

            current.volumes += 1;
            current.records +=
                numericValue(
                    record.record_count,
                    0
                );
            current.files +=
                numericValue(
                    record.file_count,
                    0
                );
            current.size_bytes +=
                numericValue(
                    record.size_bytes,
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
            .map(group => ({
                ...group,
                size:
                    formatBytes(
                        group.size_bytes
                    )
            }))
            .sort(
                (left, right) =>
                    right.size_bytes -
                    left.size_bytes
            );
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
                                Array.isArray(payload.volumes)
                                    ? payload.volumes
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

    class VolumesService extends EventTarget {
        constructor(context) {
            super();

            if (!context || typeof context !== "object") {
                throw new TypeError(
                    "A terminal context is required."
                );
            }

            this.context = context;
            this.destroyed = false;
        }

        ensureAvailable() {
            if (this.destroyed) {
                throw new Error(
                    "Volumes service has been destroyed."
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
                    `volumes:${name}`,
                    detail
                );
            } catch (_error) {
                /*
                ----------------------------------------------------------------
                Observer failures must not break volume requests.
                ----------------------------------------------------------------
                */
            }

            dispatch(
                this.context.root,
                `speciedex:terminal-volumes-${name}`,
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
                        "archive/volumes",
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
                    "A volume ID is required."
                );
            }

            const payload =
                await this.context.api.get(
                    `archive/volumes/${encodeURIComponent(normalizedId)}`,
                    {},
                    options
                );

            return normalizeRecord(
                payload,
                0
            );
        }

        async latest(parameters = {}, options = {}) {
            const result =
                await this.list(
                    {
                        ...parameters,
                        limit:
                            parameters.limit ??
                            1,
                        sort:
                            parameters.sort ??
                            "created_at",
                        direction:
                            parameters.direction ??
                            "desc"
                    },
                    options
                );

            return (
                result.records[0] ||
                null
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
                    )
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
            return {
                version: VERSION,
                endpoint:
                    "archive/volumes",
                service:
                    SERVICE_NAME,
                available:
                    Boolean(
                        this.context.api &&
                        typeof this.context.api.get ===
                        "function"
                    ),
                destroyed:
                    this.destroyed
            };
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

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
            VolumesService &&
            !existing.destroyed
        ) {
            context.volumes =
                existing;

            return existing;
        }

        if (
            context.volumes instanceof
            VolumesService &&
            !context.volumes.destroyed
        ) {
            return context.volumes;
        }

        const service =
            new VolumesService(
                context
            );

        context.volumes =
            service;

        context.registerService?.(
            SERVICE_NAME,
            service
        );

        context.registerService?.(
            "volume",
            service
        );

        dispatch(
            document,
            "speciedex:terminal-volumes-ready",
            {
                context,
                service
            }
        );

        return service;
    }

    function requireService(context) {
        const service =
            context?.volumes ||
            context?.services?.get?.(
                SERVICE_NAME
            );

        if (
            !(
                service instanceof
                VolumesService
            )
        ) {
            throw new Error(
                "Volumes service is unavailable."
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
                    "--release="
                )
            ) {
                parameters.release =
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
                    "--format="
                )
            ) {
                parameters.format =
                    argument.slice(9);
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
                    "--version="
                )
            ) {
                parameters.version =
                    argument.slice(10);
                continue;
            }

            if (
                argument.startsWith(
                    "--archive="
                )
            ) {
                parameters.archive =
                    argument.slice(10);
                continue;
            }

            if (
                argument.startsWith(
                    "--dataset="
                )
            ) {
                parameters.dataset =
                    argument.slice(10);
                continue;
            }

            if (
                argument.startsWith(
                    "--compression="
                )
            ) {
                parameters.compression =
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
            name: "volumes",
            aliases: [
                "volume-list"
            ],
            category: "archive",
            description:
                "List archive volumes and metadata.",
            usage:
                "volumes [query] [limit] [--provider=NAME] [--release=ID] [--status=STATUS] [--format=FORMAT] [--type=TYPE] [--version=VERSION] [--archive=NAME] [--dataset=NAME] [--compression=TYPE] [--from=DATE] [--to=DATE] [--sort=FIELD] [--direction=asc|desc] [--offset=N]",
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
            name: "volume",
            aliases: [
                "volume-get"
            ],
            category: "archive",
            description:
                "Retrieve one archive volume by ID.",
            usage:
                "volume <id>",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                if (!args[0]) {
                    throw new Error(
                        "A volume ID is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).get(
                        args[0]
                    )
                );
            }
        },
        {
            name: "volume-latest",
            aliases: [
                "latest-volume"
            ],
            category: "archive",
            description:
                "Display the most recently created archive volume.",
            usage:
                "volume-latest [filters]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).latest(
                        parseCommandArguments(
                            args
                        )
                    )
                )
        },
        {
            name: "volumes-summary",
            aliases: [
                "volume-summary"
            ],
            category: "archive",
            description:
                "Summarize archive volume records, files, and storage.",
            usage:
                "volumes-summary [filters]",
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
            name: "volumes-status",
            category: "archive",
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
        }
    ];

    const api = Object.freeze({
        name: MODULE_NAME,
        version: VERSION,
        serviceName:
            SERVICE_NAME,
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
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalVolumes =
        api;

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
            module: api
        }
    );
})(window, document);
