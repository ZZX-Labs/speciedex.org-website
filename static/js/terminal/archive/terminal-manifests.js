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
    • Abort-signal propagation
    • Loader-safe, idempotent initialization
    • Canonical lowercase module registration

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "manifests";
    const LEGACY_MODULE_NAME = "Manifests";
    const VERSION = "2.1.0";

    const ENDPOINT = "archive/manifests";
    const SERVICE_NAME = "manifests";
    const SERVICE_ALIAS = "manifest";

    const DEFAULT_LIMIT = 50;
    const MIN_LIMIT = 1;
    const MAX_LIMIT = 1000;

    const SORT_FIELDS = Object.freeze([
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
        if (!isObject(record)) {
            return {
                index,
                value: record
            };
        }

        const files =
            Array.isArray(record.files)
                ? record.files
                : [];

        const rawFileCount =
            record.file_count ??
            record.fileCount;

        const rawRecordCount =
            record.record_count ??
            record.recordCount ??
            record.records;

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
                    Number(rawFileCount)
                )
                    ? Number(rawFileCount)
                    : files.length,
            record_count:
                Number.isFinite(
                    Number(rawRecordCount)
                )
                    ? Number(rawRecordCount)
                    : null
        };
    }

    function normalizeResponse(payload, parameters = {}) {
        if (Array.isArray(payload)) {
            return {
                records:
                    payload.map(
                        normalizeRecord
                    ),
                total:
                    payload.length,
                limit:
                    parameters.limit ??
                    payload.length,
                offset:
                    parameters.offset ??
                    0,
                next: null,
                previous: null,
                parameters,
                raw: payload
            };
        }

        if (isObject(payload)) {
            const records =
                Array.isArray(payload.records)
                    ? payload.records
                    : Array.isArray(payload.items)
                        ? payload.items
                        : Array.isArray(payload.manifests)
                            ? payload.manifests
                            : Array.isArray(payload.data)
                                ? payload.data
                                : [];

            const numericTotal =
                Number(payload.total);

            const numericLimit =
                Number(payload.limit);

            const numericOffset =
                Number(payload.offset);

            return {
                records:
                    records.map(
                        normalizeRecord
                    ),
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
            next: null,
            previous: null,
            parameters,
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
            if (!value.length) {
                output[prefix || "value"] = [];
                return output;
            }

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

        const entries =
            Object.entries(value);

        if (!entries.length) {
            output[prefix || "value"] = {};
            return output;
        }

        for (const [key, item] of entries) {
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

    function stableSerialize(value) {
        if (
            value === null ||
            typeof value !== "object"
        ) {
            return JSON.stringify(value);
        }

        if (Array.isArray(value)) {
            return `[${value
                .map(stableSerialize)
                .join(",")}]`;
        }

        const keys =
            Object.keys(value)
                .sort();

        return `{${keys
            .map(
                (key) =>
                    `${JSON.stringify(key)}:${stableSerialize(value[key])}`
            )
            .join(",")}}`;
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
                    path:
                        key,
                    value:
                        rightFlat[key]
                });

                continue;
            }

            if (hasLeft && !hasRight) {
                removed.push({
                    path:
                        key,
                    value:
                        leftFlat[key]
                });

                continue;
            }

            const leftValue =
                stableSerialize(
                    leftFlat[key]
                );

            const rightValue =
                stableSerialize(
                    rightFlat[key]
                );

            if (leftValue !== rightValue) {
                changed.push({
                    path:
                        key,
                    before:
                        leftFlat[key],
                    after:
                        rightFlat[key]
                });
            } else {
                unchanged.push({
                    path:
                        key,
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
            equal:
                added.length === 0 &&
                removed.length === 0 &&
                changed.length === 0,
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

    class ManifestsService extends EventTarget {
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
                    "Manifests service has been destroyed."
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
                    `manifests:${name}`,
                    detail
                );
            } catch (_error) {
                /*
                Observer failures must not break manifest requests.
                */
            }

            dispatch(
                this.context.root ||
                    document,
                `speciedex:terminal-manifests-${name}`,
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
                    "A manifest ID is required."
                );
            }

            const requestOptions =
                isObject(options)
                    ? options
                    : {};

            const endpoint =
                `${ENDPOINT}/${encodeURIComponent(normalizedId)}`;

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
                    isObject(payload?.manifest)
                        ? payload.manifest
                        : isObject(payload?.data)
                            ? payload.data
                            : payload;

                const manifest =
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
                        manifest,
                        duration:
                            now() -
                            startedAt
                    }
                );

                return manifest;
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

        async compare(
            leftId,
            rightId,
            options = {}
        ) {
            const normalizedLeftId =
                normalizeText(leftId);

            const normalizedRightId =
                normalizeText(rightId);

            if (
                !normalizedLeftId ||
                !normalizedRightId
            ) {
                throw new TypeError(
                    "Two manifest IDs are required."
                );
            }

            const [left, right] =
                await Promise.all([
                    this.get(
                        normalizedLeftId,
                        options
                    ),
                    this.get(
                        normalizedRightId,
                        options
                    )
                ]);

            const comparison =
                compareManifests(
                    left,
                    right
                );

            const result = {
                leftId:
                    normalizedLeftId,
                rightId:
                    normalizedRightId,
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
                this.context.manifests ===
                this
            ) {
                delete this.context.manifests;
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
                "speciedex:terminal-manifests-destroy",
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
            context?.manifests,
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
                    ManifestsService &&
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
            context.manifests =
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
            new ManifestsService(
                context
            );

        context.manifests =
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
            "speciedex:terminal-manifests-ready",
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
            "--volume": "volume",
            "--status": "status",
            "--version": "version",
            "--format": "format",
            "--type": "type",
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
                            `Unsupported manifests option: ${key}`
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
                        `Unsupported manifests option: ${argument}`
                    );
                }

                const next =
                    tokens[index + 1];

                if (
                    next === undefined ||
                    next.startsWith("--")
                ) {
                    throw new TypeError(
                        `Missing value for manifests option: ${argument}`
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
                "manifests",
            aliases: Object.freeze([
                "manifest-list"
            ]),
            category:
                "archive",
            description:
                "Inspect archive manifests.",
            usage:
                "manifests [query] [limit] [--provider NAME] [--release ID] [--volume ID] [--status STATUS] [--version VERSION] [--format FORMAT] [--type TYPE] [--from DATE] [--to DATE] [--sort FIELD] [--direction asc|desc] [--offset N]",
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
                "manifest",
            aliases: Object.freeze([
                "manifest-get"
            ]),
            category:
                "archive",
            description:
                "Retrieve one archive manifest by ID.",
            usage:
                "manifest <id>",
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
                        "A manifest ID is required."
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
                "manifest-compare",
            aliases: Object.freeze([
                "compare-manifests"
            ]),
            category:
                "archive",
            description:
                "Compare two archive manifests.",
            usage:
                "manifest-compare <left-id> <right-id>",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) => {
                const tokens =
                    tokenizeArguments(args);

                if (
                    !tokens[0] ||
                    !tokens[1]
                ) {
                    throw new Error(
                        "Two manifest IDs are required."
                    );
                }

                const result =
                    await requireService(
                        context
                    ).compare(
                        tokens[0],
                        tokens[1],
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
                "manifests-latest",
            aliases: Object.freeze([
                "manifest-latest"
            ]),
            category:
                "archive",
            description:
                "Display the most recent archive manifests.",
            usage:
                "manifests-latest [limit]",
            handler: async ({
                args = [],
                context,
                writeJSON,
                signal
            }) => {
                const tokens =
                    tokenizeArguments(args);

                const result =
                    await requireService(
                        context
                    ).latest(
                        tokens[0] ||
                        10,
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
                "manifests-status",
            category:
                "archive",
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
        ManifestsService,
        normalizeParameters,
        normalizeRecord,
        normalizeResponse,
        flattenObject,
        stableSerialize,
        compareManifests,
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

    window.SpeciedexTerminalManifests =
        api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules || {};

    window.SpeciedexTerminalModules[
        MODULE_NAME
    ] = api;

    /*
    --------------------------------------------------------------------
    Historical loader bridge. Canonical registration remains "manifests".
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
