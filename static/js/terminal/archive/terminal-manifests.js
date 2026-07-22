/*
========================================================================
Speciedex.org
Terminal Manifests Module
========================================================================

Archive manifest service for SpeciedexTerminal.

Provides:

    • Validated manifest-list API requests
    • Provider, release, volume, status, date, and pagination filters
    • Manifest retrieval and comparison helpers
    • Normalized manifest responses
    • Lifecycle events and service registration
    • Terminal command integration

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Manifests";
    const VERSION = "2.0.0";
    const SERVICE_NAME = "manifests";

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
            "volume",
            "status",
            "records",
            "files",
            "version"
        ]);

        if (!allowed.has(normalized)) {
            throw new TypeError(
                `Unsupported manifest sort field: ${value}`
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
                "volume",
                "status",
                "version",
                "format",
                "type"
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
                "Manifest start date must not be later than the end date."
            );
        }

        return normalized;
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
                    record.manifest_id ??
                    record.manifestId ??
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
            volume:
                normalizeText(
                    record.volume ??
                    record.volume_id ??
                    record.volumeId ??
                    ""
                ),
            version:
                normalizeText(
                    record.version ??
                    record.manifest_version ??
                    ""
                ),
            files,
            file_count:
                Number.isFinite(
                    Number(
                        record.file_count ??
                        record.fileCount
                    )
                )
                    ? Number(
                        record.file_count ??
                        record.fileCount
                    )
                    : files.length,
            record_count:
                Number.isFinite(
                    Number(
                        record.record_count ??
                        record.recordCount ??
                        record.records
                    )
                )
                    ? Number(
                        record.record_count ??
                        record.recordCount ??
                        record.records
                    )
                    : null
        };
    }

    function normalizeResponse(payload) {
        if (Array.isArray(payload)) {
            return {
                records:
                    payload.map(
                        normalizeRecord
                    ),
                total:
                    payload.length,
                limit:
                    payload.length,
                offset: 0,
                raw: payload
            };
        }

        if (
            payload &&
            typeof payload === "object"
        ) {
            const records =
                Array.isArray(payload.records)
                    ? payload.records
                    : (
                        Array.isArray(payload.items)
                            ? payload.items
                            : (
                                Array.isArray(payload.manifests)
                                    ? payload.manifests
                                    : []
                            )
                    );

            return {
                records:
                    records.map(
                        normalizeRecord
                    ),
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
            raw: payload
        };
    }

    function flattenObject(value, prefix = "", output = {}) {
        if (
            value === null ||
            value === undefined ||
            typeof value !== "object"
        ) {
            output[prefix || "value"] =
                value;

            return output;
        }

        if (Array.isArray(value)) {
            value.forEach(
                (item, index) =>
                    flattenObject(
                        item,
                        prefix
                            ? `${prefix}[${index}]`
                            : `[${index}]`,
                        output
                    )
            );

            return output;
        }

        for (
            const [
                key,
                item
            ] of Object.entries(value)
        ) {
            const path =
                prefix
                    ? `${prefix}.${key}`
                    : key;

            flattenObject(
                item,
                path,
                output
            );
        }

        return output;
    }

    function compareManifests(left, right) {
        const leftFlat =
            flattenObject(left);

        const rightFlat =
            flattenObject(right);

        const keys =
            [
                ...new Set([
                    ...Object.keys(leftFlat),
                    ...Object.keys(rightFlat)
                ])
            ].sort();

        const added = [];
        const removed = [];
        const changed = [];
        const unchanged = [];

        for (const key of keys) {
            const hasLeft =
                Object.prototype.hasOwnProperty.call(
                    leftFlat,
                    key
                );

            const hasRight =
                Object.prototype.hasOwnProperty.call(
                    rightFlat,
                    key
                );

            if (!hasLeft && hasRight) {
                added.push({
                    path: key,
                    value:
                        rightFlat[key]
                });

                continue;
            }

            if (hasLeft && !hasRight) {
                removed.push({
                    path: key,
                    value:
                        leftFlat[key]
                });

                continue;
            }

            const leftValue =
                JSON.stringify(
                    leftFlat[key]
                );

            const rightValue =
                JSON.stringify(
                    rightFlat[key]
                );

            if (
                leftValue !==
                rightValue
            ) {
                changed.push({
                    path: key,
                    before:
                        leftFlat[key],
                    after:
                        rightFlat[key]
                });
            } else {
                unchanged.push({
                    path: key,
                    value:
                        leftFlat[key]
                });
            }
        }

        return {
            added,
            removed,
            changed,
            unchanged,
            summary: {
                added:
                    added.length,
                removed:
                    removed.length,
                changed:
                    changed.length,
                unchanged:
                    unchanged.length
            }
        };
    }

    class ManifestsService extends EventTarget {
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
                    "Manifests service has been destroyed."
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
                    `manifests:${name}`,
                    detail
                );
            } catch (_error) {
                /*
                ----------------------------------------------------------------
                Observer failures must not break manifest requests.
                ----------------------------------------------------------------
                */
            }

            dispatch(
                this.context.root,
                `speciedex:terminal-manifests-${name}`,
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
                        "archive/manifests",
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
                    "A manifest ID is required."
                );
            }

            const startedAt =
                performance.now();

            this.emit(
                "request",
                {
                    operation:
                        "get",
                    id:
                        normalizedId
                }
            );

            try {
                const payload =
                    await this.context.api.get(
                        `archive/manifests/${encodeURIComponent(normalizedId)}`,
                        {},
                        options
                    );

                const manifest =
                    normalizeRecord(
                        payload,
                        0
                    );

                const result = {
                    manifest,
                    duration:
                        performance.now() -
                        startedAt
                };

                this.emit(
                    "complete",
                    result
                );

                return manifest;
            } catch (error) {
                this.emit(
                    "error",
                    {
                        operation:
                            "get",
                        id:
                            normalizedId,
                        error,
                        duration:
                            performance.now() -
                            startedAt
                    }
                );

                throw error;
            }
        }

        async compare(leftId, rightId, options = {}) {
            const [
                left,
                right
            ] =
                await Promise.all([
                    this.get(
                        leftId,
                        options
                    ),
                    this.get(
                        rightId,
                        options
                    )
                ]);

            const comparison =
                compareManifests(
                    left,
                    right
                );

            const result = {
                left,
                right,
                comparison
            };

            this.emit(
                "compare",
                result
            );

            return result;
        }

        async latest(limit = 10, options = {}) {
            return this.list(
                {
                    limit,
                    sort:
                        "created_at",
                    direction:
                        "desc"
                },
                options
            );
        }

        status() {
            return {
                version: VERSION,
                endpoint:
                    "archive/manifests",
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
            ManifestsService &&
            !existing.destroyed
        ) {
            context.manifests =
                existing;

            return existing;
        }

        if (
            context.manifests instanceof
            ManifestsService &&
            !context.manifests.destroyed
        ) {
            return context.manifests;
        }

        const service =
            new ManifestsService(
                context
            );

        context.manifests =
            service;

        context.registerService?.(
            SERVICE_NAME,
            service
        );

        context.registerService?.(
            "manifest",
            service
        );

        dispatch(
            document,
            "speciedex:terminal-manifests-ready",
            {
                context,
                service
            }
        );

        return service;
    }

    function requireService(context) {
        const service =
            context?.manifests ||
            context?.services?.get?.(
                SERVICE_NAME
            );

        if (
            !(
                service instanceof
                ManifestsService
            )
        ) {
            throw new Error(
                "Manifests service is unavailable."
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
                    "--volume="
                )
            ) {
                parameters.volume =
                    argument.slice(9);
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
                    "--version="
                )
            ) {
                parameters.version =
                    argument.slice(10);
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
            name: "manifests",
            aliases: [
                "manifest-list"
            ],
            category: "archive",
            description:
                "Inspect archive manifests.",
            usage:
                "manifests [query] [limit] [--provider=NAME] [--release=ID] [--volume=ID] [--status=STATUS] [--version=VERSION] [--format=FORMAT] [--type=TYPE] [--from=DATE] [--to=DATE] [--sort=FIELD] [--direction=asc|desc] [--offset=N]",
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
            name: "manifest",
            aliases: [
                "manifest-get"
            ],
            category: "archive",
            description:
                "Retrieve one archive manifest by ID.",
            usage:
                "manifest <id>",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                if (!args[0]) {
                    throw new Error(
                        "A manifest ID is required."
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
            name: "manifest-compare",
            aliases: [
                "compare-manifests"
            ],
            category: "archive",
            description:
                "Compare two archive manifests.",
            usage:
                "manifest-compare <left-id> <right-id>",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                if (
                    !args[0] ||
                    !args[1]
                ) {
                    throw new Error(
                        "Two manifest IDs are required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).compare(
                        args[0],
                        args[1]
                    )
                );
            }
        },
        {
            name: "manifests-latest",
            aliases: [
                "manifest-latest"
            ],
            category: "archive",
            description:
                "Display the most recent archive manifests.",
            usage:
                "manifests-latest [limit]",
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
                        args[0] || 10
                    )
                )
        },
        {
            name: "manifests-status",
            category: "archive",
            description:
                "Show manifest-service status.",
            usage:
                "manifests-status",
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
        ManifestsService,
        normalizeParameters,
        normalizeRecord,
        normalizeResponse,
        flattenObject,
        compareManifests,
        parseCommandArguments,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalManifests =
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
