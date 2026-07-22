/*
========================================================================
Speciedex.org
Terminal Import Module
========================================================================

Structured import service for SpeciedexTerminal.

Provides:

    • JSON, JSONL, NDJSON, CSV, TSV, and plain-text imports
    • Robust quoted-field parsing
    • Multiple-file imports
    • File-size and record-count limits
    • Safe library writes
    • Drag-and-drop support
    • Lifecycle events and service registration
    • Terminal command integration

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Import";
    const VERSION = "2.0.0";

    const DEFAULT_MAX_FILE_SIZE = 25 * 1024 * 1024;
    const DEFAULT_MAX_RECORDS = 250000;
    const ACCEPTED_EXTENSIONS = Object.freeze([
        ".json",
        ".jsonl",
        ".ndjson",
        ".csv",
        ".tsv",
        ".txt"
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

    function extensionOf(filename) {
        const match =
            String(filename || "")
                .toLowerCase()
                .match(/(\.[^.]+)$/);

        return match
            ? match[1]
            : "";
    }

    function normalizeCollectionName(value) {
        const normalized =
            String(value || "records")
                .trim()
                .replace(/[^\w.-]+/g, "-")
                .replace(/-+/g, "-")
                .replace(/^-|-$/g, "");

        return normalized || "records";
    }

    function parseDelimited(text, delimiter = ",") {
        const rows = [];
        let row = [];
        let field = "";
        let quoted = false;

        for (
            let index = 0;
            index < text.length;
            index += 1
        ) {
            const character =
                text[index];

            if (quoted) {
                if (character === '"') {
                    if (
                        text[index + 1] ===
                        '"'
                    ) {
                        field += '"';
                        index += 1;
                    } else {
                        quoted = false;
                    }
                } else {
                    field += character;
                }

                continue;
            }

            if (character === '"') {
                quoted = true;
                continue;
            }

            if (character === delimiter) {
                row.push(field);
                field = "";
                continue;
            }

            if (character === "\n") {
                row.push(field);
                rows.push(row);

                row = [];
                field = "";
                continue;
            }

            if (
                character === "\r" &&
                text[index + 1] === "\n"
            ) {
                continue;
            }

            if (character === "\r") {
                row.push(field);
                rows.push(row);

                row = [];
                field = "";
                continue;
            }

            field += character;
        }

        if (
            field.length ||
            row.length
        ) {
            row.push(field);
            rows.push(row);
        }

        return rows;
    }

    function rowsToObjects(rows) {
        if (!rows.length) {
            return [];
        }

        const headers =
            rows[0].map(
                (value, index) => {
                    const normalized =
                        String(value || "")
                            .trim();

                    return (
                        normalized ||
                        `column${index + 1}`
                    );
                }
            );

        const seen = new Map();

        const uniqueHeaders =
            headers.map(header => {
                const count =
                    seen.get(header) || 0;

                seen.set(
                    header,
                    count + 1
                );

                return count
                    ? `${header}_${count + 1}`
                    : header;
            });

        return rows
            .slice(1)
            .filter(row =>
                row.some(value =>
                    String(value || "")
                        .trim()
                )
            )
            .map(row =>
                Object.fromEntries(
                    uniqueHeaders.map(
                        (header, index) => [
                            header,
                            row[index] ?? ""
                        ]
                    )
                )
            );
    }

    function parseJSON(text) {
        const value =
            JSON.parse(text);

        return Array.isArray(value)
            ? value
            : [value];
    }

    function parseJSONLines(text) {
        const records = [];
        const lines =
            text.split(/\r?\n/);

        for (
            let index = 0;
            index < lines.length;
            index += 1
        ) {
            const line =
                lines[index].trim();

            if (!line) {
                continue;
            }

            try {
                records.push(
                    JSON.parse(line)
                );
            } catch (error) {
                throw new Error(
                    `Invalid JSON on line ${index + 1}: ${error.message}`
                );
            }
        }

        return records;
    }

    function parseText(text) {
        return text
            .split(/\r?\n/)
            .filter(line =>
                line.length
            )
            .map((value, index) => ({
                index: index + 1,
                value
            }));
    }

    function parseContent(text, extension) {
        const normalized =
            String(extension || "")
                .toLowerCase();

        if (normalized === ".json") {
            return parseJSON(text);
        }

        if (
            normalized === ".jsonl" ||
            normalized === ".ndjson"
        ) {
            return parseJSONLines(text);
        }

        if (normalized === ".csv") {
            return rowsToObjects(
                parseDelimited(
                    text,
                    ","
                )
            );
        }

        if (normalized === ".tsv") {
            return rowsToObjects(
                parseDelimited(
                    text,
                    "\t"
                )
            );
        }

        return parseText(text);
    }

    async function readFile(file, options = {}) {
        if (
            !(file instanceof File) &&
            !(
                file &&
                typeof file.text ===
                "function"
            )
        ) {
            throw new TypeError(
                "A File-compatible object is required."
            );
        }

        const maxFileSize =
            clampInteger(
                options.maxFileSize,
                DEFAULT_MAX_FILE_SIZE,
                1,
                Number.MAX_SAFE_INTEGER
            );

        const maxRecords =
            clampInteger(
                options.maxRecords,
                DEFAULT_MAX_RECORDS,
                1,
                Number.MAX_SAFE_INTEGER
            );

        if (
            Number.isFinite(file.size) &&
            file.size > maxFileSize
        ) {
            throw new Error(
                `File exceeds maximum size of ${maxFileSize} bytes: ${file.name || "unnamed file"}`
            );
        }

        const extension =
            extensionOf(
                file.name
            );

        if (
            extension &&
            !ACCEPTED_EXTENSIONS.includes(
                extension
            )
        ) {
            throw new Error(
                `Unsupported import file type: ${extension}`
            );
        }

        const text =
            await file.text();

        const records =
            parseContent(
                text,
                extension
            );

        if (
            records.length >
            maxRecords
        ) {
            throw new Error(
                `Import contains ${records.length} records; maximum is ${maxRecords}.`
            );
        }

        return {
            file: {
                name:
                    file.name ||
                    "unnamed",
                size:
                    Number(file.size) || 0,
                type:
                    file.type ||
                    "application/octet-stream",
                extension
            },
            records
        };
    }

    class ImportService extends EventTarget {
        constructor(context, options = {}) {
            super();

            if (!context || typeof context !== "object") {
                throw new TypeError(
                    "A terminal context is required."
                );
            }

            this.context = context;
            this.maxFileSize =
                clampInteger(
                    options.maxFileSize,
                    DEFAULT_MAX_FILE_SIZE,
                    1,
                    Number.MAX_SAFE_INTEGER
                );

            this.maxRecords =
                clampInteger(
                    options.maxRecords,
                    DEFAULT_MAX_RECORDS,
                    1,
                    Number.MAX_SAFE_INTEGER
                );

            this.dropTarget = null;
            this.dropHandlers = null;
            this.destroyed = false;
        }

        ensureAvailable() {
            if (this.destroyed) {
                throw new Error(
                    "Import service has been destroyed."
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
                    `import:${name}`,
                    detail
                );
            } catch (_error) {
                /*
                ----------------------------------------------------------------
                Observer failures must not break imports.
                ----------------------------------------------------------------
                */
            }

            dispatch(
                this.context.root,
                `speciedex:terminal-import-${name}`,
                detail,
                {
                    bubbles: true
                }
            );
        }

        async readFile(file, options = {}) {
            this.ensureAvailable();

            const result =
                await readFile(
                    file,
                    {
                        maxFileSize:
                            options.maxFileSize ||
                            this.maxFileSize,
                        maxRecords:
                            options.maxRecords ||
                            this.maxRecords
                    }
                );

            this.emit(
                "read",
                result
            );

            return result;
        }

        async readFiles(files, options = {}) {
            this.ensureAvailable();

            const values =
                Array.from(
                    files || []
                );

            const results = [];

            for (const file of values) {
                results.push(
                    await this.readFile(
                        file,
                        options
                    )
                );
            }

            return results;
        }

        setCollection(
            collection,
            records,
            options = {}
        ) {
            this.ensureAvailable();

            const name =
                normalizeCollectionName(
                    collection
                );

            const library =
                this.context.library;

            if (!library) {
                throw new Error(
                    "Terminal library service is unavailable."
                );
            }

            if (
                typeof library.set ===
                "function"
            ) {
                library.set(
                    name,
                    records,
                    options
                );
            } else {
                library[name] = records;
            }

            const detail = {
                collection: name,
                count:
                    Array.isArray(records)
                        ? records.length
                        : 0,
                records
            };

            this.emit(
                "stored",
                detail
            );

            return detail;
        }

        async importFile(
            file,
            collection = "records",
            options = {}
        ) {
            const result =
                await this.readFile(
                    file,
                    options
                );

            const stored =
                this.setCollection(
                    collection,
                    result.records,
                    options
                );

            const detail = {
                ...result,
                ...stored
            };

            this.emit(
                "complete",
                detail
            );

            return detail;
        }

        async importFiles(
            files,
            collection = "records",
            options = {}
        ) {
            const results =
                await this.readFiles(
                    files,
                    options
                );

            if (
                options.merge === false
            ) {
                return Promise.all(
                    results.map(
                        (result, index) =>
                            this.setCollection(
                                `${collection}-${index + 1}`,
                                result.records,
                                options
                            )
                    )
                );
            }

            const records =
                results.flatMap(
                    result =>
                        result.records
                );

            const stored =
                this.setCollection(
                    collection,
                    records,
                    options
                );

            const detail = {
                files:
                    results.map(
                        result =>
                            result.file
                    ),
                ...stored
            };

            this.emit(
                "complete",
                detail
            );

            return detail;
        }

        openPicker(options = {}) {
            this.ensureAvailable();

            return new Promise(
                (resolve, reject) => {
                    const input =
                        document.createElement(
                            "input"
                        );

                    input.type = "file";
                    input.accept =
                        options.accept ||
                        ACCEPTED_EXTENSIONS.join(",");
                    input.multiple =
                        options.multiple === true;

                    const cleanup = () => {
                        input.remove();
                    };

                    input.addEventListener(
                        "change",
                        async () => {
                            try {
                                const files =
                                    Array.from(
                                        input.files || []
                                    );

                                if (!files.length) {
                                    resolve(null);
                                    return;
                                }

                                const result =
                                    input.multiple
                                        ? await this.importFiles(
                                            files,
                                            options.collection,
                                            options
                                        )
                                        : await this.importFile(
                                            files[0],
                                            options.collection,
                                            options
                                        );

                                resolve(result);
                            } catch (error) {
                                this.emit(
                                    "error",
                                    {
                                        error
                                    }
                                );

                                reject(error);
                            } finally {
                                cleanup();
                            }
                        },
                        {
                            once: true
                        }
                    );

                    input.addEventListener(
                        "cancel",
                        () => {
                            cleanup();
                            resolve(null);
                        },
                        {
                            once: true
                        }
                    );

                    input.click();
                }
            );
        }

        attachDropTarget(
            target =
                this.context.root,
            options = {}
        ) {
            this.ensureAvailable();

            if (
                !target ||
                typeof target.addEventListener !==
                "function"
            ) {
                throw new TypeError(
                    "A valid drop target is required."
                );
            }

            this.detachDropTarget();

            const onDragOver = event => {
                event.preventDefault();
                event.dataTransfer.dropEffect =
                    "copy";

                target.classList?.add(
                    "terminal-import-dragover"
                );
            };

            const onDragLeave = () => {
                target.classList?.remove(
                    "terminal-import-dragover"
                );
            };

            const onDrop = async event => {
                event.preventDefault();

                target.classList?.remove(
                    "terminal-import-dragover"
                );

                const files =
                    Array.from(
                        event.dataTransfer?.files ||
                        []
                    );

                if (!files.length) {
                    return;
                }

                try {
                    await this.importFiles(
                        files,
                        options.collection ||
                        "records",
                        options
                    );
                } catch (error) {
                    this.emit(
                        "error",
                        {
                            error
                        }
                    );
                }
            };

            target.addEventListener(
                "dragover",
                onDragOver
            );

            target.addEventListener(
                "dragleave",
                onDragLeave
            );

            target.addEventListener(
                "drop",
                onDrop
            );

            this.dropTarget = target;
            this.dropHandlers = {
                onDragOver,
                onDragLeave,
                onDrop
            };

            return () =>
                this.detachDropTarget();
        }

        detachDropTarget() {
            if (
                !this.dropTarget ||
                !this.dropHandlers
            ) {
                return false;
            }

            this.dropTarget.removeEventListener(
                "dragover",
                this.dropHandlers.onDragOver
            );

            this.dropTarget.removeEventListener(
                "dragleave",
                this.dropHandlers.onDragLeave
            );

            this.dropTarget.removeEventListener(
                "drop",
                this.dropHandlers.onDrop
            );

            this.dropTarget.classList?.remove(
                "terminal-import-dragover"
            );

            this.dropTarget = null;
            this.dropHandlers = null;

            return true;
        }

        status() {
            return {
                version: VERSION,
                acceptedExtensions:
                    [...ACCEPTED_EXTENSIONS],
                maxFileSize:
                    this.maxFileSize,
                maxRecords:
                    this.maxRecords,
                dropTargetAttached:
                    Boolean(
                        this.dropTarget
                    ),
                destroyed:
                    this.destroyed
            };
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            this.detachDropTarget();
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
            context.importer instanceof
            ImportService &&
            !context.importer.destroyed
        ) {
            return context.importer;
        }

        const dataset =
            context.root?.dataset || {};

        const service =
            new ImportService(
                context,
                {
                    maxFileSize:
                        dataset.
                            terminalImportMaxFileSize,
                    maxRecords:
                        dataset.
                            terminalImportMaxRecords
                }
            );

        context.importer = service;

        context.registerService?.(
            "import",
            service
        );

        context.registerService?.(
            "importer",
            service
        );

        if (
            dataset.
                terminalImportDrop !==
            "false"
        ) {
            service.attachDropTarget(
                context.root,
                {
                    collection:
                        dataset.
                            terminalImportCollection ||
                        "records"
                }
            );
        }

        dispatch(
            document,
            "speciedex:terminal-import-ready",
            {
                context,
                importer: service
            }
        );

        return service;
    }

    function requireImporter(context) {
        if (
            !(
                context?.importer instanceof
                ImportService
            )
        ) {
            throw new Error(
                "Terminal import service is unavailable."
            );
        }

        return context.importer;
    }

    const commands = [
        {
            name: "import",
            aliases: [
                "load-file"
            ],
            category: "data",
            description:
                "Open a local file picker and import data.",
            usage:
                "import [collection] [--multiple]",
            handler: async ({
                args = [],
                context,
                write
            }) => {
                const importer =
                    requireImporter(context);

                const multiple =
                    args.includes(
                        "--multiple"
                    );

                const collection =
                    normalizeCollectionName(
                        args.find(
                            argument =>
                                !argument.startsWith(
                                    "--"
                                )
                        ) ||
                        "records"
                    );

                const result =
                    await importer.openPicker({
                        collection,
                        multiple
                    });

                if (!result) {
                    return typeof write ===
                        "function"
                            ? write(
                                "Import cancelled.",
                                "warning"
                            )
                            : null;
                }

                const count =
                    result.count ||
                    result.records?.length ||
                    0;

                return typeof write ===
                    "function"
                        ? write(
                            `Imported ${count} record${count === 1 ? "" : "s"} into ${collection}.`,
                            "success"
                        )
                        : result;
            }
        },
        {
            name: "import-status",
            category: "data",
            description:
                "Show terminal import-service status.",
            usage:
                "import-status",
            handler: ({
                context,
                writeJSON
            }) => {
                const status =
                    requireImporter(
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
        ACCEPTED_EXTENSIONS,
        ImportService,
        extensionOf,
        normalizeCollectionName,
        parseDelimited,
        rowsToObjects,
        parseJSON,
        parseJSONLines,
        parseText,
        parseContent,
        readFile,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalImport =
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
