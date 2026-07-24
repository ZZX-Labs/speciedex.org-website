/*
========================================================================
Speciedex.org
Terminal Export Module
========================================================================

Structured export service for SpeciedexTerminal.

Provides:

    • JSON, CSV, text, Markdown, and HTML exports
    • Safe filename normalization
    • Robust CSV serialization
    • Browser download fallback
    • Collection export commands
    • Lifecycle events and service registration

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Export";
    const VERSION = "2.1.0";

    const EXPORT_SYMBOL =
        Symbol.for(
            "speciedex.terminal.export.service"
        );

    const DEFAULT_MAX_ROWS =
        1000000;

    const DEFAULT_MAX_BYTES =
        256 *
        1024 *
        1024;

    const DEFAULT_HISTORY_LIMIT =
        250;

    const DEFAULT_REVOKE_DELAY =
        30000;

    const MIME_TYPES = Object.freeze({
        json: "application/json;charset=utf-8",
        csv: "text/csv;charset=utf-8",
        text: "text/plain;charset=utf-8",
        txt: "text/plain;charset=utf-8",
        markdown: "text/markdown;charset=utf-8",
        md: "text/markdown;charset=utf-8",
        html: "text/html;charset=utf-8",
        jsonl: "application/x-ndjson;charset=utf-8",
        ndjson: "application/x-ndjson;charset=utf-8"
    });

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

    function normalizeFormat(format) {
        const value =
            String(format || "json")
                .trim()
                .toLowerCase();

        if (value === "txt") {
            return "text";
        }

        if (value === "md") {
            return "markdown";
        }

        if (
            value ===
                "ndjson"
        ) {
            return "jsonl";
        }

        return value;
    }

    function extensionFor(format) {
        const normalized =
            normalizeFormat(format);

        return {
            json: "json",
            csv: "csv",
            text: "txt",
            markdown: "md",
            html: "html",
            jsonl: "jsonl"
        }[normalized] || normalized;
    }

    function sanitizeFilename(filename, format = "json") {
        const extension =
            extensionFor(format);

        let value =
            String(
                filename ||
                `speciedex-export.${extension}`
            )
                .trim()
                .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
                .replace(/\s+/g, "-")
                .replace(/-+/g, "-")
                .replace(/^\.+/, "")
                .slice(0, 180);

        if (!value) {
            value =
                `speciedex-export.${extension}`;
        }

        if (
            extension &&
            !value
                .toLowerCase()
                .endsWith(`.${extension}`)
        ) {
            value += `.${extension}`;
        }

        return value;
    }

    function isPromiseLike(
        value
    ) {
        return Boolean(
            value &&
            typeof value.then ===
                "function"
        );
    }

    function formulaSafeText(
        value,
        options =
            {}
    ) {
        const text =
            String(
                value ??
                ""
            );

        if (
            options.formulaSafe ===
                false
        ) {
            return text;
        }

        return /^[=+\-@\t\r]/.test(
            text
        )
            ? `'${text}`
            : text;
    }

    function stableSerialize(
        value,
        seen =
            new WeakMap(),
        path =
            "$",
        depth =
            0
    ) {
        if (
            value ===
                null ||
            value ===
                undefined
        ) {
            return value;
        }

        if (
            depth >
            64
        ) {
            return "[Truncated]";
        }

        if (
            typeof value ===
                "bigint"
        ) {
            return value.toString();
        }

        if (
            typeof value ===
                "function"
        ) {
            return `[Function ${value.name || "anonymous"}]`;
        }

        if (
            typeof value ===
                "symbol"
        ) {
            return value.toString();
        }

        if (
            typeof value !==
                "object"
        ) {
            return value;
        }

        if (
            seen.has(
                value
            )
        ) {
            return `[Circular -> ${seen.get(value)}]`;
        }

        seen.set(
            value,
            path
        );

        if (
            value instanceof
                Date
        ) {
            return Number.isNaN(
                value.getTime()
            )
                ? "Invalid Date"
                : value.toISOString();
        }

        if (
            value instanceof
                Error
        ) {
            return {
                name:
                    value.name,
                message:
                    value.message,
                stack:
                    value.stack ||
                    null
            };
        }

        if (
            Array.isArray(
                value
            )
        ) {
            return value.map(
                (
                    item,
                    index
                ) =>
                    stableSerialize(
                        item,
                        seen,
                        `${path}[${index}]`,
                        depth +
                            1
                    )
            );
        }

        if (
            value instanceof
                Map
        ) {
            const output =
                {};

            for (
                const [
                    key,
                    item
                ] of value.entries()
            ) {
                const normalizedKey =
                    String(
                        key
                    );

                if (
                    [
                        "__proto__",
                        "prototype",
                        "constructor"
                    ].includes(
                        normalizedKey
                    )
                ) {
                    continue;
                }

                output[
                    normalizedKey
                ] =
                    stableSerialize(
                        item,
                        seen,
                        `${path}.${normalizedKey}`,
                        depth +
                            1
                    );
            }

            return output;
        }

        if (
            value instanceof
                Set
        ) {
            return [
                ...value.values()
            ].map(
                (
                    item,
                    index
                ) =>
                    stableSerialize(
                        item,
                        seen,
                        `${path}[${index}]`,
                        depth +
                            1
                    )
            );
        }

        const output =
            {};

        for (
            const key of
            Object.keys(
                value
            ).sort()
        ) {
            if (
                [
                    "__proto__",
                    "prototype",
                    "constructor"
                ].includes(
                    key
                )
            ) {
                continue;
            }

            try {
                output[
                    key
                ] =
                    stableSerialize(
                        value[
                            key
                        ],
                        seen,
                        `${path}.${key}`,
                        depth +
                            1
                    );
            } catch (error) {
                output[
                    key
                ] =
                    `[Unserializable: ${error?.message || error}]`;
            }
        }

        return output;
    }

    function toJSON(data, options = {}) {
        const space =
            Number.isInteger(options.space)
                ? options.space
                : 2;

        return JSON.stringify(
            stableSerialize(data),
            null,
            space
        );
    }

    function toJSONL(
        data,
        options =
            {}
    ) {
        const rows =
            Array.isArray(
                data
            )
                ? data
                : [
                    data
                ];

        return rows
            .slice(
                0,
                Number.isFinite(
                    Number(
                        options.maxRows
                    )
                )
                    ? Number(
                        options.maxRows
                    )
                    : DEFAULT_MAX_ROWS
            )
            .map(
                row =>
                    JSON.stringify(
                        stableSerialize(
                            row
                        )
                    )
            )
            .join(
                "\n"
            );
    }


    function collectHeaders(rows) {
        const headers = [];
        const seen = new Set();

        for (const row of rows) {
            if (
                row &&
                typeof row === "object" &&
                !Array.isArray(row)
            ) {
                for (
                    const key of
                    Object.keys(row)
                ) {
                    if (!seen.has(key)) {
                        seen.add(key);
                        headers.push(key);
                    }
                }
            }
        }

        return headers;
    }

    function csvCell(
        value,
        options =
            {}
    ) {
        let text;

        if (
            value === null ||
            value === undefined
        ) {
            text = "";
        } else if (
            typeof value === "object"
        ) {
            text = toJSON(value, {
                space: 0
            });
        } else {
            text = String(value);
        }

        text =
            formulaSafeText(
                text,
                options
            );

        return `"${text.replace(/"/g, '""')}"`;
    }

    function toCSV(rows, options = {}) {
        const values =
            Array.isArray(rows)
                ? rows.slice(
                    0,
                    Number.isFinite(
                        Number(
                            options.maxRows
                        )
                    )
                        ? Math.max(
                            0,
                            Number(
                                options.maxRows
                            )
                        )
                        : DEFAULT_MAX_ROWS
                )
                : [];

        const delimiter =
            String(
                options.delimiter || ","
            );

        const lineEnding =
            options.lineEnding || "\r\n";

        if (!values.length) {
            return "";
        }

        if (
            values.every(
                row => Array.isArray(row)
            )
        ) {
            return values
                .map(row =>
                    row
                        .map(value => csvCell(value, options))
                        .join(delimiter)
                )
                .join(lineEnding);
        }

        if (
            values.every(
                row =>
                    row === null ||
                    typeof row !== "object"
            )
        ) {
            return [
                csvCell("value", options),
                ...values.map(value => csvCell(value, options))
            ].join(lineEnding);
        }

        const headers =
            Array.isArray(options.headers) &&
            options.headers.length
                ? options.headers.map(String)
                : collectHeaders(values);

        if (!headers.length) {
            headers.push("value");
        }

        const lines = [
            headers
                .map(value => csvCell(value, options))
                .join(delimiter)
        ];

        for (const row of values) {
            if (
                row &&
                typeof row === "object" &&
                !Array.isArray(row)
            ) {
                lines.push(
                    headers
                        .map(key =>
                            csvCell(row[key], options)
                        )
                        .join(delimiter)
                );
            } else if (Array.isArray(row)) {
                lines.push(
                    row
                        .map(value => csvCell(value, options))
                        .join(delimiter)
                );
            } else {
                lines.push(
                    csvCell(row, options)
                );
            }
        }

        return lines.join(lineEnding);
    }

    function toText(value) {
        if (typeof value === "string") {
            return value;
        }

        if (
            value === null ||
            value === undefined
        ) {
            return String(value);
        }

        return toJSON(value);
    }

    function triggerDownload(
        filename,
        content,
        type,
        options =
            {}
    ) {
        const normalizedFilename =
            sanitizeFilename(
                filename,
                options.format || "text"
            );

        const parts = [];

        if (
            options.bom === true &&
            (
                type.includes("csv") ||
                type.includes("json") ||
                type.includes("text")
            )
        ) {
            parts.push("\uFEFF");
        }

        parts.push(content);

        const blob =
            new Blob(
                parts,
                {
                    type:
                        type ||
                        "application/octet-stream"
                }
            );

        const maxBytes =
            Number.isFinite(
                Number(
                    options.maxBytes
                )
            )
                ? Math.max(
                    1,
                    Number(
                        options.maxBytes
                    )
                )
                : DEFAULT_MAX_BYTES;

        if (
            blob.size >
            maxBytes
        ) {
            throw new RangeError(
                `Export size ${blob.size} bytes exceeds maximum ${maxBytes} bytes.`
            );
        }

        const url =
            URL.createObjectURL(
                blob
            );

        const anchor =
            document.createElement("a");

        anchor.href = url;
        anchor.download =
            normalizedFilename;
        anchor.hidden = true;

        document.body?.appendChild(anchor);

        try {
            anchor.click();
        } finally {
            anchor.remove();

            window.setTimeout(
                () =>
                    URL.revokeObjectURL(
                        url
                    ),
                Number.isFinite(
                    Number(
                        options.revokeDelay
                    )
                )
                    ? Math.max(
                        0,
                        Number(
                            options.revokeDelay
                        )
                    )
                    : DEFAULT_REVOKE_DELAY
            );
        }

        return {
            filename:
                normalizedFilename,
            bytes:
                blob.size,
            type:
                blob.type
        };
    }

    class ExportService extends EventTarget {
        constructor(
            context,
            options =
                {}
        ) {
            super();

            this.context =
                context;

            this.destroyed =
                false;

            this.emitting =
                false;

            this.maxRows =
                Number.isFinite(
                    Number(
                        options.maxRows
                    )
                )
                    ? Math.max(
                        1,
                        Number(
                            options.maxRows
                        )
                    )
                    : DEFAULT_MAX_ROWS;

            this.maxBytes =
                Number.isFinite(
                    Number(
                        options.maxBytes
                    )
                )
                    ? Math.max(
                        1,
                        Number(
                            options.maxBytes
                        )
                    )
                    : DEFAULT_MAX_BYTES;

            this.historyLimit =
                Number.isFinite(
                    Number(
                        options.historyLimit
                    )
                )
                    ? Math.max(
                        1,
                        Number(
                            options.historyLimit
                        )
                    )
                    : DEFAULT_HISTORY_LIMIT;

            this.history =
                [];

            this.metrics = {
                exports:
                    0,
                bytes:
                    0,
                failures:
                    0,
                json:
                    0,
                csv:
                    0,
                text:
                    0,
                markdown:
                    0,
                html:
                    0,
                jsonl:
                    0
            };
        }

        ensureAvailable() {
            if (this.destroyed) {
                throw new Error(
                    "Export service has been destroyed."
                );
            }
        }

        emit(
            name,
            detail
        ) {
            if (
                this.destroyed &&
                name !==
                    "destroy"
            ) {
                return false;
            }

            if (
                this.emitting
            ) {
                return false;
            }

            this.emitting =
                true;

            try {
                dispatch(
                    this,
                    name,
                    detail
                );

                try {
                    this.context.events?.emit?.(
                        `export:${name}`,
                        detail
                    );
                } catch (_error) {
                    /* Observer failures must not break exports. */
                }

                dispatch(
                    this.context.root,
                    `speciedex:terminal-export-${name}`,
                    detail,
                    {
                        bubbles:
                            true
                    }
                );

                return true;
            } finally {
                this.emitting =
                    false;
            }
        }

        recordHistory(
            entry
        ) {
            this.history.push({
                timestamp:
                    new Date().toISOString(),
                ...entry
            });

            while (
                this.history.length >
                this.historyLimit
            ) {
                this.history.shift();
            }
        }

        download(
            filename,
            content,
            type,
            options =
                {}
        ) {
            this.ensureAvailable();

            try {
                const result =
                    triggerDownload(
                        filename,
                        content,
                        type,
                        {
                            maxBytes:
                                this.maxBytes,
                            ...options
                        }
                    );

                this.metrics.exports +=
                    1;

                this.metrics.bytes +=
                    result.bytes;

                const format =
                    normalizeFormat(
                        options.format ||
                        "text"
                    );

                if (
                    format in
                    this.metrics
                ) {
                    this.metrics[
                        format
                    ] +=
                        1;
                }

                this.recordHistory({
                    filename:
                        result.filename,
                    bytes:
                        result.bytes,
                    type:
                        result.type,
                    format
                });

                this.emit(
                    "complete",
                    result
                );

                return result;
            } catch (error) {
                this.metrics.failures +=
                    1;

                this.emit(
                    "error",
                    {
                        filename,
                        message:
                            error.message
                    }
                );

                throw error;
            }
        }

        json(
            data,
            filename =
                "speciedex-export.json",
            options = {}
        ) {
            return this.download(
                filename,
                toJSON(
                    data,
                    options
                ),
                MIME_TYPES.json,
                {
                    ...options,
                    format: "json"
                }
            );
        }

        jsonl(
            data,
            filename =
                "speciedex-export.jsonl",
            options =
                {}
        ) {
            return this.download(
                filename,
                toJSONL(
                    data,
                    {
                        maxRows:
                            this.maxRows,
                        ...options
                    }
                ),
                MIME_TYPES.jsonl,
                {
                    ...options,
                    format:
                        "jsonl"
                }
            );
        }


        csv(
            rows,
            filename =
                "speciedex-export.csv",
            options = {}
        ) {
            return this.download(
                filename,
                toCSV(
                    rows,
                    {
                        maxRows:
                            this.maxRows,
                        ...options
                    }
                ),
                MIME_TYPES.csv,
                {
                    bom:
                        options.bom !== false,
                    ...options,
                    format: "csv"
                }
            );
        }

        text(
            text,
            filename =
                "speciedex-export.txt",
            type =
                MIME_TYPES.text,
            options = {}
        ) {
            return this.download(
                filename,
                String(text ?? ""),
                type,
                {
                    ...options,
                    format:
                        options.format ||
                        "text"
                }
            );
        }

        markdown(
            text,
            filename =
                "speciedex-export.md",
            options = {}
        ) {
            return this.text(
                text,
                filename,
                MIME_TYPES.markdown,
                {
                    ...options,
                    format: "markdown"
                }
            );
        }

        html(
            html,
            filename =
                "speciedex-export.html",
            options = {}
        ) {
            return this.text(
                html,
                filename,
                MIME_TYPES.html,
                {
                    ...options,
                    format: "html"
                }
            );
        }

        serialize(
            data,
            format,
            options = {}
        ) {
            const normalized =
                normalizeFormat(format);

            if (normalized === "json") {
                return toJSON(
                    data,
                    options
                );
            }

            if (
                normalized ===
                    "csv"
            ) {
                return toCSV(
                    data,
                    {
                        maxRows:
                            this.maxRows,
                        ...options
                    }
                );
            }

            if (
                normalized ===
                    "jsonl"
            ) {
                return toJSONL(
                    data,
                    {
                        maxRows:
                            this.maxRows,
                        ...options
                    }
                );
            }

            if (
                normalized === "text" ||
                normalized === "markdown" ||
                normalized === "html"
            ) {
                return toText(data);
            }

            throw new Error(
                `Unsupported export format: ${format}`
            );
        }

        export(
            data,
            format = "json",
            filename = "",
            options = {}
        ) {
            const normalized =
                normalizeFormat(format);

            const safeFilename =
                sanitizeFilename(
                    filename ||
                    `speciedex-export.${extensionFor(normalized)}`,
                    normalized
                );

            if (normalized === "json") {
                return this.json(
                    data,
                    safeFilename,
                    options
                );
            }

            if (
                normalized ===
                    "csv"
            ) {
                return this.csv(
                    data,
                    safeFilename,
                    options
                );
            }

            if (
                normalized ===
                    "jsonl"
            ) {
                return this.jsonl(
                    data,
                    safeFilename,
                    options
                );
            }


            if (normalized === "markdown") {
                return this.markdown(
                    toText(data),
                    safeFilename,
                    options
                );
            }

            if (normalized === "html") {
                return this.html(
                    toText(data),
                    safeFilename,
                    options
                );
            }

            if (normalized === "text") {
                return this.text(
                    toText(data),
                    safeFilename,
                    MIME_TYPES.text,
                    options
                );
            }

            throw new Error(
                `Unsupported export format: ${format}`
            );
        }

        async collection(
            collection,
            format =
                "json",
            filename =
                "",
            options =
                {}
        ) {
            this.ensureAvailable();

            const data =
                await getCollection(
                    this.context,
                    collection
                );

            return this.export(
                data,
                format,
                filename ||
                    `speciedex-${collection}.${extensionFor(format)}`,
                options
            );
        }


        status() {
            return {
                version: VERSION,
                formats: [
                    "json",
                    "jsonl",
                    "csv",
                    "text",
                    "markdown",
                    "html"
                ],
                limits: {
                    rows:
                        this.maxRows,
                    bytes:
                        this.maxBytes,
                    history:
                        this.historyLimit
                },
                history:
                    this.history.length,
                metrics: {
                    ...this.metrics
                },
                destroyed:
                    this.destroyed
            };
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            this.emit(
                "destroy",
                {
                    timestamp:
                        new Date().toISOString(),
                    version:
                        VERSION
                }
            );

            if (
                this.context.root?.[
                    EXPORT_SYMBOL
                ] ===
                    this
            ) {
                delete this.context.root[
                    EXPORT_SYMBOL
                ];
            }

            this.history =
                [];

            this.destroyed =
                true;

            return true;
        }
    }

    function initialize(
        context
    ) {
        const root =
            context.root;

        const existing =
            context.exporter instanceof
                ExportService
                ? context.exporter
                : context.services?.get?.(
                    "export"
                ) ||
                context.services?.get?.(
                    "exporter"
                ) ||
                root?.[
                    EXPORT_SYMBOL
                ];

        if (
            existing instanceof
                ExportService &&
            !existing.destroyed
        ) {
            context.exporter =
                existing;

            context.registerService?.(
                "export",
                existing
            );

            context.registerService?.(
                "exporter",
                existing
            );

            return existing;
        }

        const dataset =
            root?.
                dataset ||
            {};

        const service =
            new ExportService(
                context,
                {
                    maxRows:
                        dataset.terminalExportMaxRows,

                    maxBytes:
                        dataset.terminalExportMaxBytes,

                    historyLimit:
                        dataset.terminalExportHistoryLimit
                }
            );

        root[
            EXPORT_SYMBOL
        ] =
            service;

        context.exporter =
            service;

        context.registerService?.(
            "export",
            service
        );

        context.registerService?.(
            "exporter",
            service
        );

        dispatch(
            document,
            "speciedex:terminal-export-ready",
            {
                context,
                exporter:
                    service,
                version:
                    VERSION
            }
        );

        return service;
    }

    function requireExporter(context) {
        if (
            !(
                context?.exporter instanceof
                ExportService
            )
        ) {
            throw new Error(
                "Terminal export service is unavailable."
            );
        }

        return context.exporter;
    }

    async function getCollection(
        context,
        collection
    ) {
        if (!context?.library) {
            throw new Error(
                "Terminal library service is unavailable."
            );
        }

        if (
            typeof context.library.get ===
            "function"
        ) {
            const result =
                context.library.get(
                    collection
                );

            return (
                isPromiseLike(
                    result
                )
                    ? await result
                    : result
            ) ?? [];
        }

        if (
            collection in
            context.library
        ) {
            return (
                context.library[
                    collection
                ] ?? []
            );
        }

        throw new Error(
            `Unknown library collection: ${collection}`
        );
    }

    const commands = [
        {
            name: "export",
            aliases: [
                "save",
                "download"
            ],
            category: "data",
            description:
                "Export a library collection.",
            usage:
                "export <collection> [json|csv|text|markdown|html] [filename]",
            handler: async ({
                args = [],
                context,
                write
            }) => {
                const exporter =
                    requireExporter(context);

                const collection =
                    args[0] || "records";

                const format =
                    normalizeFormat(
                        args[1] || "json"
                    );

                const data =
                    await getCollection(
                        context,
                        collection
                    );

                const filename =
                    sanitizeFilename(
                        args[2] ||
                        `speciedex-${collection}.${extensionFor(format)}`,
                        format
                    );

                const result =
                    exporter.export(
                        data,
                        format,
                        filename,
                        {
                            bom:
                                !args.includes(
                                    "--no-bom"
                                ),
                            formulaSafe:
                                !args.includes(
                                    "--unsafe-csv"
                                )
                        }
                    );

                const count =
                    Array.isArray(data)
                        ? data.length
                        : (
                            data &&
                            typeof data ===
                            "object"
                                ? Object.keys(
                                    data
                                ).length
                                : 1
                        );

                return typeof write ===
                    "function"
                        ? write(
                            `Exported ${count} record${count === 1 ? "" : "s"} to ${result.filename}.`,
                            "success"
                        )
                        : result;
            }
        },
        {
            name:
                "export-history",

            category:
                "data",

            description:
                "Display recent export operations.",

            usage:
                "export-history [limit]",

            handler: ({
                args = [],
                context,
                writeJSON
            }) => {
                const exporter =
                    requireExporter(
                        context
                    );

                const limit =
                    Number.isFinite(
                        Number(
                            args[0]
                        )
                    )
                        ? Math.max(
                            1,
                            Math.min(
                                exporter.historyLimit,
                                Number(
                                    args[0]
                                )
                            )
                        )
                        : 25;

                const history =
                    exporter.history.slice(
                        -limit
                    );

                return typeof writeJSON ===
                    "function"
                        ? writeJSON({
                            history
                        })
                        : {
                            history
                        };
            }
        },

        {
            name: "export-status",
            category: "data",
            description:
                "Show terminal export-service status.",
            usage:
                "export-status",
            handler: ({
                context,
                writeJSON
            }) => {
                const status =
                    requireExporter(
                        context
                    ).status();

                return typeof writeJSON ===
                    "function"
                        ? writeJSON(status)
                        : status;
            }
        }
    ];

    const api = Object.freeze({
        name: MODULE_NAME,
        version:
            VERSION,
        EXPORT_SYMBOL,
        MIME_TYPES,
        ExportService,
        isPromiseLike,
        formulaSafeText,
        normalizeFormat,
        extensionFor,
        sanitizeFilename,
        stableSerialize,
        toJSON,
        toJSONL,
        toCSV,
        toText,
        triggerDownload,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalExport =
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
