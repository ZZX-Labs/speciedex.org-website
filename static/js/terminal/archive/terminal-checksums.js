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

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Checksums";
    const VERSION = "2.0.0";
    const SERVICE_NAME = "checksums";

    const DEFAULT_LIMIT = 50;
    const MIN_LIMIT = 1;
    const MAX_LIMIT = 1000;

    const SUPPORTED_ALGORITHMS = Object.freeze([
        "SHA-1",
        "SHA-256",
        "SHA-384",
        "SHA-512"
    ]);

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

    function normalizeAlgorithm(value, allowEmpty = true) {
        const text =
            normalizeText(value);

        if (!text && allowEmpty) {
            return "";
        }

        const normalized =
            text
                .toUpperCase()
                .replace(/_/g, "-")
                .replace(/^SHA(\d+)$/, "SHA-$1");

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
        return normalizeText(value)
            .toLowerCase()
            .replace(/^0x/, "")
            .replace(/\s+/g, "");
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
            const key of
            [
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
        if (
            !record ||
            typeof record !== "object"
        ) {
            return {
                index,
                value: record
            };
        }

        const algorithm =
            record.algorithm ??
            record.alg ??
            "";

        return {
            ...record,
            index:
                record.index ??
                index,
            algorithm:
                algorithm
                    ? normalizeAlgorithm(
                        algorithm,
                        false
                    )
                    : "",
            checksum:
                normalizeHex(
                    record.checksum ??
                    record.digest ??
                    record.hash ??
                    ""
                )
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
                                Array.isArray(payload.checksums)
                                    ? payload.checksums
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
            typeof Blob === "function" &&
            value instanceof Blob
        ) {
            return value.arrayBuffer();
        }

        if (typeof value === "string") {
            return new TextEncoder().encode(
                value
            ).buffer;
        }

        throw new TypeError(
            "Checksum input must be a string, Blob, ArrayBuffer, or typed array."
        );
    }

    function bufferToHex(buffer) {
        return [
            ...new Uint8Array(buffer)
        ]
            .map(byte =>
                byte
                    .toString(16)
                    .padStart(2, "0")
            )
            .join("");
    }

    async function digest(value, algorithm = "SHA-256") {
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

    async function verify(value, expected, algorithm = "SHA-256") {
        const actual =
            await digest(
                value,
                algorithm
            );

        const normalizedExpected =
            normalizeHex(expected);

        return {
            algorithm:
                normalizeAlgorithm(
                    algorithm,
                    false
                ),
            expected:
                normalizedExpected,
            actual,
            valid:
                actual ===
                normalizedExpected
        };
    }

    class ChecksumsService extends EventTarget {
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
                    "Checksums service has been destroyed."
                );
            }
        }

        ensureAPI() {
            this.ensureAvailable();

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
                    `checksums:${name}`,
                    detail
                );
            } catch (_error) {
                /*
                ----------------------------------------------------------------
                Observer failures must not break checksum operations.
                ----------------------------------------------------------------
                */
            }

            dispatch(
                this.context.root,
                `speciedex:terminal-checksums-${name}`,
                detail,
                {
                    bubbles: true
                }
            );
        }

        async list(parameters = {}, options = {}) {
            this.ensureAPI();

            const normalized =
                normalizeParameters(
                    parameters
                );

            const startedAt =
                performance.now();

            this.emit(
                "request",
                {
                    parameters: normalized
                }
            );

            try {
                const payload =
                    await this.context.api.get(
                        "archive/checksums",
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

        digest(value, algorithm = "SHA-256") {
            this.ensureAvailable();

            return digest(
                value,
                algorithm
            );
        }

        async verify(value, expected, algorithm = "SHA-256") {
            this.ensureAvailable();

            const result =
                await verify(
                    value,
                    expected,
                    algorithm
                );

            this.emit(
                "verify",
                result
            );

            return result;
        }

        async verifyFile(file, expected, algorithm = "SHA-256") {
            if (
                !(
                    typeof File === "function" &&
                    file instanceof File
                )
            ) {
                throw new TypeError(
                    "A File object is required."
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
                    name: file.name,
                    size: file.size,
                    type:
                        file.type ||
                        "application/octet-stream"
                }
            };
        }

        status() {
            return {
                version: VERSION,
                endpoint:
                    "archive/checksums",
                service:
                    SERVICE_NAME,
                algorithms:
                    [...SUPPORTED_ALGORITHMS],
                apiAvailable:
                    Boolean(
                        this.context.api &&
                        typeof this.context.api.get ===
                        "function"
                    ),
                cryptoAvailable:
                    Boolean(
                        window.crypto?.subtle &&
                        typeof window.crypto.subtle.digest ===
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
            ChecksumsService &&
            !existing.destroyed
        ) {
            context.checksums =
                existing;

            return existing;
        }

        if (
            context.checksums instanceof
            ChecksumsService &&
            !context.checksums.destroyed
        ) {
            return context.checksums;
        }

        const service =
            new ChecksumsService(
                context
            );

        context.checksums =
            service;

        context.registerService?.(
            SERVICE_NAME,
            service
        );

        context.registerService?.(
            "checksum",
            service
        );

        dispatch(
            document,
            "speciedex:terminal-checksums-ready",
            {
                context,
                service
            }
        );

        return service;
    }

    function requireService(context) {
        const service =
            context?.checksums ||
            context?.services?.get?.(
                SERVICE_NAME
            );

        if (
            !(
                service instanceof
                ChecksumsService
            )
        ) {
            throw new Error(
                "Checksums service is unavailable."
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
                    "--algorithm="
                )
            ) {
                parameters.algorithm =
                    argument.slice(12);
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
                    "--provider="
                )
            ) {
                parameters.provider =
                    argument.slice(11);
                continue;
            }

            if (
                argument.startsWith(
                    "--path="
                )
            ) {
                parameters.path =
                    argument.slice(7);
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
                    "--release="
                )
            ) {
                parameters.release =
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
            name: "checksums",
            aliases: [
                "checksum-list"
            ],
            category: "archive",
            description:
                "Inspect archive checksums and integrity records.",
            usage:
                "checksums [query] [limit] [--algorithm=SHA-256] [--status=STATUS] [--provider=NAME] [--path=PATH] [--volume=ID] [--release=ID] [--from=DATE] [--to=DATE] [--offset=N]",
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
            name: "checksum",
            aliases: [
                "hash"
            ],
            category: "archive",
            description:
                "Generate a checksum for text.",
            usage:
                "checksum <text> [algorithm]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                if (!args.length) {
                    throw new Error(
                        "Text is required."
                    );
                }

                const algorithm =
                    args.length > 1 &&
                    /^sha[-_]?\d+$/i.test(
                        args[
                            args.length - 1
                        ]
                    )
                        ? args.pop()
                        : "SHA-256";

                const text =
                    args.join(" ");

                const service =
                    requireService(context);

                const checksum =
                    await service.digest(
                        text,
                        algorithm
                    );

                return writeJSONValue(
                    writeJSON,
                    {
                        algorithm:
                            normalizeAlgorithm(
                                algorithm,
                                false
                            ),
                        input:
                            text,
                        checksum
                    }
                );
            }
        },
        {
            name: "checksum-verify",
            aliases: [
                "verify-checksum"
            ],
            category: "archive",
            description:
                "Verify text against an expected checksum.",
            usage:
                "checksum-verify <expected> <text> [algorithm]",
            handler: async ({
                args = [],
                context,
                writeJSON
            }) => {
                if (args.length < 2) {
                    throw new Error(
                        "An expected checksum and text are required."
                    );
                }

                const expected =
                    args.shift();

                const algorithm =
                    args.length > 1 &&
                    /^sha[-_]?\d+$/i.test(
                        args[
                            args.length - 1
                        ]
                    )
                        ? args.pop()
                        : "SHA-256";

                const text =
                    args.join(" ");

                return writeJSONValue(
                    writeJSON,
                    await requireService(
                        context
                    ).verify(
                        text,
                        expected,
                        algorithm
                    )
                );
            }
        },
        {
            name: "checksums-status",
            category: "archive",
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
        }
    ];

    const api = Object.freeze({
        name: MODULE_NAME,
        version: VERSION,
        serviceName:
            SERVICE_NAME,
        SUPPORTED_ALGORITHMS,
        ChecksumsService,
        normalizeAlgorithm,
        normalizeHex,
        normalizeParameters,
        normalizeRecord,
        normalizeResponse,
        toArrayBuffer,
        bufferToHex,
        digest,
        verify,
        parseCommandArguments,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalChecksums =
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
