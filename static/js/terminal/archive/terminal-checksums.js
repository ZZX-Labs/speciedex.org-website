/*
========================================================================
Speciedex.org
Terminal Checksums Module
========================================================================

Archive checksum and integrity service for SpeciedexTerminal.

Provides:

    • Validated checksum-list API requests
    • Algorithm, status, provider, path, and date filters
    • Browser-side digest generation and verification
    • Normalized checksum responses
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

    const MODULE_NAME = "checksums";
    const LEGACY_MODULE_NAME = "Checksums";
    const VERSION = "2.1.0";

    const ENDPOINT = "archive/checksums";
    const SERVICE_NAME = "checksums";
    const SERVICE_ALIAS = "checksum";

    const DEFAULT_LIMIT = 50;
    const MIN_LIMIT = 1;
    const MAX_LIMIT = 1000;

    const SUPPORTED_ALGORITHMS = Object.freeze([
        "SHA-1",
        "SHA-256",
        "SHA-384",
        "SHA-512"
    ]);

    const DIGEST_LENGTHS = Object.freeze({
        "SHA-1": 40,
        "SHA-256": 64,
        "SHA-384": 96,
        "SHA-512": 128
    });

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

    function normalizeAlgorithm(value, allowEmpty = true) {
        const text =
            normalizeText(value);

        if (!text && allowEmpty) {
            return "";
        }

        const normalized =
            text
                .toUpperCase()
                .replace(/\s+/gu, "")
                .replace(/_/gu, "-")
                .replace(/^SHA(\d+)$/u, "SHA-$1");

        if (
            !SUPPORTED_ALGORITHMS.includes(
                normalized
            )
        ) {
            throw new TypeError(
                `Unsupported checksum algorithm: ${value}`
            );
        }

        return normalized;
    }

    function normalizeHex(value) {
        const normalized =
            normalizeText(value)
                .toLowerCase()
                .replace(/^0x/u, "")
                .replace(/\s+/gu, "");

        if (
            normalized &&
            !/^[0-9a-f]+$/u.test(normalized)
        ) {
            throw new TypeError(
                `Invalid hexadecimal checksum: ${value}`
            );
        }

        return normalized;
    }

    function validateDigestLength(value, algorithm) {
        const normalizedAlgorithm =
            normalizeAlgorithm(
                algorithm,
                false
            );

        const normalizedDigest =
            normalizeHex(value);

        const expectedLength =
            DIGEST_LENGTHS[
                normalizedAlgorithm
            ];

        if (
            normalizedDigest.length !==
            expectedLength
        ) {
            throw new RangeError(
                `${normalizedAlgorithm} checksums must contain ${expectedLength} hexadecimal characters.`
            );
        }

        return normalizedDigest;
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
                )
        };

        const algorithm =
            source.algorithm ??
            source.alg;

        if (
            algorithm !== undefined &&
            algorithm !== null &&
            algorithm !== ""
        ) {
            normalized.algorithm =
                normalizeAlgorithm(
                    algorithm,
                    false
                );
        }

        for (
            const key of [
                "status",
                "provider",
                "path",
                "volume",
                "release"
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
                "Checksum start date must not be later than the end date."
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

        const rawAlgorithm =
            record.algorithm ??
            record.alg ??
            "";

        const algorithm =
            rawAlgorithm
                ? normalizeAlgorithm(
                    rawAlgorithm,
                    false
                )
                : "";

        const checksum =
            normalizeHex(
                record.checksum ??
                record.digest ??
                record.hash ??
                ""
            );

        return {
            ...record,
            index:
                record.index ??
                index,
            algorithm,
            checksum
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
                        : Array.isArray(payload.checksums)
                            ? payload.checksums
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

    async function toArrayBuffer(value) {
        if (value instanceof ArrayBuffer) {
            return value;
        }

        if (ArrayBuffer.isView(value)) {
            return value.buffer.slice(
                value.byteOffset,
                value.byteOffset +
                    value.byteLength
            );
        }

        if (
            typeof window.Blob === "function" &&
            value instanceof window.Blob
        ) {
            if (
                typeof value.arrayBuffer ===
                "function"
            ) {
                return value.arrayBuffer();
            }

            return new Promise(
                (resolve, reject) => {
                    const reader =
                        new window.FileReader();

                    reader.onerror =
                        () => reject(
                            reader.error ||
                            new Error(
                                "Unable to read checksum input."
                            )
                        );

                    reader.onload =
                        () => resolve(
                            reader.result
                        );

                    reader.readAsArrayBuffer(
                        value
                    );
                }
            );
        }

        if (typeof value === "string") {
            if (
                typeof window.TextEncoder !==
                "function"
            ) {
                throw new Error(
                    "TextEncoder is unavailable."
                );
            }

            return new window.TextEncoder()
                .encode(value)
                .buffer;
        }

        throw new TypeError(
            "Checksum input must be a string, Blob, ArrayBuffer, or typed array."
        );
    }

    function bufferToHex(buffer) {
        return Array.from(
            new Uint8Array(buffer),
            (byte) =>
                byte
                    .toString(16)
                    .padStart(2, "0")
        ).join("");
    }

    async function digest(
        value,
        algorithm = "SHA-256"
    ) {
        const normalizedAlgorithm =
            normalizeAlgorithm(
                algorithm,
                false
            );

        if (
            !window.crypto?.subtle ||
            typeof window.crypto.subtle.digest !==
                "function"
        ) {
            throw new Error(
                "Web Crypto digest support is unavailable."
            );
        }

        const buffer =
            await toArrayBuffer(value);

        const hash =
            await window.crypto.subtle.digest(
                normalizedAlgorithm,
                buffer
            );

        return bufferToHex(hash);
    }

    async function verify(
        value,
        expected,
        algorithm = "SHA-256"
    ) {
        const normalizedAlgorithm =
            normalizeAlgorithm(
                algorithm,
                false
            );

        const normalizedExpected =
            validateDigestLength(
                expected,
                normalizedAlgorithm
            );

        const actual =
            await digest(
                value,
                normalizedAlgorithm
            );

        return {
            algorithm:
                normalizedAlgorithm,
            expected:
                normalizedExpected,
            actual,
            valid:
                actual ===
                normalizedExpected
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

    class ChecksumsService extends EventTarget {
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
                    "Checksums service has been destroyed."
                );
            }
        }

        ensureAPI() {
            this.ensureAvailable();

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
                    `checksums:${name}`,
                    detail
                );
            } catch (_error) {
                /*
                Observer failures must not break checksum operations.
                */
            }

            dispatch(
                this.context.root ||
                    document,
                `speciedex:terminal-checksums-${name}`,
                detail,
                {
                    bubbles: true,
                    composed: true
                }
            );
        }

        async list(parameters = {}, options = {}) {
            this.ensureAPI();

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
                const detail = {
                    error,
                    endpoint:
                        ENDPOINT,
                    parameters:
                        normalized,
                    duration:
                        now() -
                        startedAt,
                    aborted:
                        error?.name ===
                        "AbortError"
                };

                this.emit(
                    "error",
                    detail
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

        async digest(
            value,
            algorithm = "SHA-256"
        ) {
            this.ensureAvailable();

            const startedAt =
                now();

            try {
                const checksum =
                    await digest(
                        value,
                        algorithm
                    );

                const result = {
                    algorithm:
                        normalizeAlgorithm(
                            algorithm,
                            false
                        ),
                    checksum,
                    duration:
                        now() -
                        startedAt
                };

                this.emit(
                    "digest",
                    result
                );

                return checksum;
            } catch (error) {
                this.emit(
                    "digest-error",
                    {
                        error,
                        algorithm,
                        duration:
                            now() -
                            startedAt
                    }
                );

                throw error;
            }
        }

        async verify(
            value,
            expected,
            algorithm = "SHA-256"
        ) {
            this.ensureAvailable();

            const startedAt =
                now();

            const result =
                await verify(
                    value,
                    expected,
                    algorithm
                );

            result.duration =
                now() -
                startedAt;

            this.emit(
                "verify",
                result
            );

            return result;
        }

        async verifyFile(
            file,
            expected,
            algorithm = "SHA-256"
        ) {
            this.ensureAvailable();

            const isFile =
                typeof window.File ===
                    "function" &&
                file instanceof window.File;

            const isBlob =
                typeof window.Blob ===
                    "function" &&
                file instanceof window.Blob;

            if (!isFile && !isBlob) {
                throw new TypeError(
                    "A File or Blob object is required."
                );
            }

            const result =
                await this.verify(
                    file,
                    expected,
                    algorithm
                );

            return {
                ...result,
                file: {
                    name:
                        file.name ||
                        "",
                    size:
                        file.size,
                    type:
                        file.type ||
                        "application/octet-stream",
                    lastModified:
                        Number.isFinite(
                            file.lastModified
                        )
                            ? file.lastModified
                            : null
                }
            };
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
                algorithms:
                    [...SUPPORTED_ALGORITHMS],
                apiAvailable:
                    Boolean(
                        api &&
                        typeof api.get ===
                            "function"
                    ),
                cryptoAvailable:
                    Boolean(
                        window.crypto?.subtle &&
                        typeof window.crypto.subtle.digest ===
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
                this.context.checksums ===
                this
            ) {
                delete this.context.checksums;
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
                "speciedex:terminal-checksums-destroy",
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
            context?.checksums,
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
                    ChecksumsService &&
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
            context.checksums =
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
            new ChecksumsService(
                context
            );

        context.checksums =
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
            "speciedex:terminal-checksums-ready",
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
            "--algorithm": "algorithm",
            "--alg": "algorithm",
            "--status": "status",
            "--provider": "provider",
            "--path": "path",
            "--volume": "volume",
            "--release": "release",
            "--from": "from",
            "--to": "to",
            "--query": "q"
        };

        for (
            let index = 0;
            index < tokens.length;
            index += 1
        ) {
            const argument =
                tokens[index];

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
                            `Unsupported checksums option: ${key}`
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
                        `Unsupported checksums option: ${argument}`
                    );
                }

                const next =
                    tokens[index + 1];

                if (
                    next === undefined ||
                    next.startsWith("--")
                ) {
                    throw new TypeError(
                        `Missing value for checksums option: ${argument}`
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

    function extractTrailingAlgorithm(tokens) {
        const values =
            [...tokens];

        if (!values.length) {
            return {
                values,
                algorithm:
                    "SHA-256"
            };
        }

        const last =
            values[
                values.length - 1
            ];

        try {
            const algorithm =
                normalizeAlgorithm(
                    last,
                    false
                );

            values.pop();

            return {
                values,
                algorithm
            };
        } catch (_error) {
            return {
                values,
                algorithm:
                    "SHA-256"
            };
        }
    }

    const commands = Object.freeze([
        Object.freeze({
            name:
                "checksums",
            aliases: Object.freeze([
                "checksum-list"
            ]),
            category:
                "archive",
            description:
                "Inspect archive checksums and integrity records.",
            usage:
                "checksums [query] [limit] [--algorithm SHA-256] [--status STATUS] [--provider NAME] [--path PATH] [--volume ID] [--release ID] [--from DATE] [--to DATE] [--offset N]",
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
                "checksum",
            aliases: Object.freeze([
                "hash"
            ]),
            category:
                "archive",
            description:
                "Generate a checksum for text.",
            usage:
                "checksum <text> [algorithm]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                const tokens =
                    tokenizeArguments(args);

                if (!tokens.length) {
                    throw new Error(
                        "Text is required."
                    );
                }

                const {
                    values,
                    algorithm
                } =
                    extractTrailingAlgorithm(
                        tokens
                    );

                if (!values.length) {
                    throw new Error(
                        "Text is required."
                    );
                }

                const text =
                    values.join(" ");

                const checksum =
                    await requireService(
                        context
                    ).digest(
                        text,
                        algorithm
                    );

                return writeJSONValue(
                    writeJSON,
                    {
                        algorithm,
                        input:
                            text,
                        checksum
                    }
                );
            }
        }),
        Object.freeze({
            name:
                "checksum-verify",
            aliases: Object.freeze([
                "verify-checksum"
            ]),
            category:
                "archive",
            description:
                "Verify text against an expected checksum.",
            usage:
                "checksum-verify <expected> <text> [algorithm]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                const tokens =
                    tokenizeArguments(args);

                if (tokens.length < 2) {
                    throw new Error(
                        "An expected checksum and text are required."
                    );
                }

                const expected =
                    tokens[0];

                const {
                    values,
                    algorithm
                } =
                    extractTrailingAlgorithm(
                        tokens.slice(1)
                    );

                if (!values.length) {
                    throw new Error(
                        "Text is required."
                    );
                }

                const text =
                    values.join(" ");

                const result =
                    await requireService(
                        context
                    ).verify(
                        text,
                        expected,
                        algorithm
                    );

                return writeJSONValue(
                    writeJSON,
                    result
                );
            }
        }),
        Object.freeze({
            name:
                "checksums-status",
            category:
                "archive",
            description:
                "Show checksum-service status.",
            usage:
                "checksums-status",
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
        supportedAlgorithms:
            SUPPORTED_ALGORITHMS,
        digestLengths:
            DIGEST_LENGTHS,
        ChecksumsService,
        normalizeAlgorithm,
        normalizeHex,
        validateDigestLength,
        normalizeParameters,
        normalizeRecord,
        normalizeResponse,
        toArrayBuffer,
        bufferToHex,
        digest,
        verify,
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

    window.SpeciedexTerminalChecksums =
        api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules || {};

    window.SpeciedexTerminalModules[
        MODULE_NAME
    ] = api;

    /*
    --------------------------------------------------------------------
    Historical loader bridge. Canonical registration remains "checksums".
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
