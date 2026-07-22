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
    const VERSION = "2.0.0";

    const MIME_TYPES = Object.freeze({
        json: "application/json;charset=utf-8",
        csv: "text/csv;charset=utf-8",
        text: "text/plain;charset=utf-8",
        txt: "text/plain;charset=utf-8",
        markdown: "text/markdown;charset=utf-8",
        md: "text/markdown;charset=utf-8",
        html: "text/html;charset=utf-8"
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
            html: "html"
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

    function stableSerialize(value, seen = new WeakSet()) {
        if (
            value === null ||
            value === undefined
        ) {
            return value;
        }

        if (typeof value === "bigint") {
            return value.toString();
        }

        if (typeof value === "function") {
            return `[Function ${value.name || "anonymous"}]`;
        }

        if (typeof value === "symbol") {
            return value.toString();
        }

        if (typeof value !== "object") {
            return value;
        }

        if (seen.has(value)) {
            return "[Circular]";
        }

        seen.add(value);

        if (value instanceof Date) {
            return Number.isNaN(value.getTime())
                ? "Invalid Date"
                : value.toISOString();
        }

        if (value instanceof Error) {
            return {
                name: value.name,
                message: value.message,
                stack: value.stack || null
            };
        }

        if (Array.isArray(value)) {
            return value.map(item =>
                stableSerialize(item, seen)
            );
        }

        if (value instanceof Map) {
            return Object.fromEntries(
                [...value.entries()].map(
                    ([key, item]) => [
                        String(key),
                        stableSerialize(item, seen)
                    ]
                )
            );
        }

        if (value instanceof Set) {
            return [...value.values()].map(
                item => stableSerialize(item, seen)
            );
        }

        const output = {};

        for (
            const key of
            Object.keys(value).sort()
        ) {
            try {
                output[key] =
                    stableSerialize(
                        value[key],
                        seen
                    );
            } catch (error) {
                output[key] =
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

    function csvCell(value) {
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

        return `"${text.replace(/"/g, '""')}"`;
    }

    function toCSV(rows, options = {}) {
        const values =
            Array.isArray(rows)
                ? rows
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
                        .map(csvCell)
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
                csvCell("value"),
                ...values.map(csvCell)
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
                .map(csvCell)
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
                            csvCell(row[key])
                        )
                        .join(delimiter)
                );
            } else if (Array.isArray(row)) {
                lines.push(
                    row
                        .map(csvCell)
                        .join(delimiter)
                );
            } else {
                lines.push(
                    csvCell(row)
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

    function triggerDownload(filename, content, type, options = {}) {
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

        const url =
            URL.createObjectURL(blob);

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
                1000
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
        constructor(context) {
            super();

            this.context = context;
            this.destroyed = false;
        }

        ensureAvailable() {
            if (this.destroyed) {
                throw new Error(
                    "Export service has been destroyed."
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
                    `export:${name}`,
                    detail
                );
            } catch (_error) {
                /*
                ----------------------------------------------------------------
                Export completion must not fail because an observer failed.
                ----------------------------------------------------------------
                */
            }

            dispatch(
                this.context.root,
                `speciedex:terminal-export-${name}`,
                detail,
                {
                    bubbles: true
                }
            );
        }

        download(
            filename,
            content,
            type,
            options = {}
        ) {
            this.ensureAvailable();

            const result =
                triggerDownload(
                    filename,
                    content,
                    type,
                    options
                );

            this.emit(
                "complete",
                result
            );

            return result;
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
                    options
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

            if (normalized === "csv") {
                return toCSV(
                    data,
                    options
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

            if (normalized === "csv") {
                return this.csv(
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

        status() {
            return {
                version: VERSION,
                formats: [
                    "json",
                    "csv",
                    "text",
                    "markdown",
                    "html"
                ],
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
        if (
            context.exporter instanceof
            ExportService &&
            !context.exporter.destroyed
        ) {
            return context.exporter;
        }

        const service =
            new ExportService(context);

        context.exporter = service;

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
                exporter: service
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

    function getCollection(
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

            return result ?? [];
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
            handler: ({
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
                    getCollection(
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
                        filename
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
        version: VERSION,
        MIME_TYPES,
        ExportService,
        normalizeFormat,
        extensionFor,
        sanitizeFilename,
        stableSerialize,
        toJSON,
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
