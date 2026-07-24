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
    const VERSION = "2.1.0";

    const IMPORT_SYMBOL =
        Symbol.for(
            "speciedex.terminal.import.service"
        );

    const DEFAULT_MAX_FILE_SIZE =
        25 *
        1024 *
        1024;

    const DEFAULT_MAX_RECORDS =
        250000;

    const DEFAULT_MAX_FILES =
        128;

    const DEFAULT_HISTORY_LIMIT =
        250;

    const DEFAULT_READ_CONCURRENCY =
        4;
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

    function isAbortError(
        error
    ) {
        return Boolean(
            error &&
            (
                error.name ===
                    "AbortError" ||
                error.code ===
                    20
            )
        );
    }

    function throwIfAborted(
        signal,
        message =
            "Import cancelled."
    ) {
        if (
            signal?.aborted
        ) {
            throw new DOMException(
                message,
                "AbortError"
            );
        }
    }

    function yieldToMainThread() {
        return new Promise(
            resolve => {
                if (
                    typeof window.requestIdleCallback ===
                        "function"
                ) {
                    window.requestIdleCallback(
                        () =>
                            resolve(),
                        {
                            timeout:
                                50
                        }
                    );

                    return;
                }

                window.setTimeout(
                    resolve,
                    0
                );
            }
        );
    }

    function arrayFromPayload(
        payload
    ) {
        if (
            Array.isArray(
                payload
            )
        ) {
            return payload;
        }

        if (
            !payload ||
            typeof payload !==
                "object"
        ) {
            return [];
        }

        for (
            const key of
            [
                "records",
                "results",
                "items",
                "data",
                "species",
                "taxa"
            ]
        ) {
            if (
                Array.isArray(
                    payload[
                        key
                    ]
                )
            ) {
                return payload[
                    key
                ];
            }
        }

        return [
            payload
        ];
    }

    function recordIdentity(
        record,
        index =
            0
    ) {
        if (
            record &&
            typeof record ===
                "object"
        ) {
            const candidate =
                record.speciedex_id ??
                record.speciedexId ??
                record.id ??
                record.key ??
                record.uuid ??
                record.provider_id ??
                record.providerId ??
                null;

            if (
                candidate !==
                    null &&
                candidate !==
                    undefined &&
                String(
                    candidate
                ).trim()
            ) {
                return String(
                    candidate
                )
                    .trim()
                    .toLowerCase();
            }
        }

        let serialized;

        try {
            serialized =
                JSON.stringify(
                    record
                );
        } catch (_error) {
            serialized =
                String(
                    record
                );
        }

        return `record:${index}:${serialized}`;
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
            quoted
        ) {
            throw new Error(
                "Unterminated quoted field in delimited input."
            );
        }

        if (
            field.length ||
            row.length
        ) {
            row.push(
                field
            );

            rows.push(
                row
            );
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

    function stripBOM(
        text
    ) {
        return String(
            text ??
            ""
        ).replace(
            /^\uFEFF/,
            ""
        );
    }

    function parseJSON(
        text
    ) {
        const value =
            JSON.parse(
                stripBOM(
                    text
                )
            );

        return arrayFromPayload(
            value
        );
    }

    function parseJSONLines(text) {
        const records = [];
        const lines =
            stripBOM(
                text
            ).split(
                /\r?\n/
            );

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
        return stripBOM(
            text
        )
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

    async function readFile(
        file,
        options =
            {}
    ) {
        throwIfAborted(
            options.signal
        );

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

        throwIfAborted(
            options.signal
        );

        const inferredExtension =
            extension ||
            (
                file.type ===
                    "application/json"
                    ? ".json"
                    : file.type ===
                        "text/csv"
                        ? ".csv"
                        : file.type ===
                            "text/tab-separated-values"
                            ? ".tsv"
                            : ".txt"
            );

        const records =
            parseContent(
                text,
                inferredExtension
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
                extension:
                    inferredExtension
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

            this.maxFiles =
                clampInteger(
                    options.maxFiles,
                    DEFAULT_MAX_FILES,
                    1,
                    10000
                );

            this.historyLimit =
                clampInteger(
                    options.historyLimit,
                    DEFAULT_HISTORY_LIMIT,
                    1,
                    10000
                );

            this.readConcurrency =
                clampInteger(
                    options.readConcurrency,
                    DEFAULT_READ_CONCURRENCY,
                    1,
                    64
                );

            this.defaultCollection =
                normalizeCollectionName(
                    options.defaultCollection ||
                    "records"
                );

            this.dropTarget = null;
            this.dropHandlers = null;
            this.destroyed = false;
            this.emitting = false;
            this.activeControllers =
                new Set();
            this.openPickers =
                new Set();
            this.history =
                [];
            this.metrics = {
                filesRead: 0,
                filesImported: 0,
                recordsRead: 0,
                recordsStored: 0,
                duplicateRecords: 0,
                failedFiles: 0,
                cancelled: 0,
                libraryWrites: 0,
                indexRefreshes: 0,
                dropImports: 0
            };
        }

        ensureAvailable() {
            if (this.destroyed) {
                throw new Error(
                    "Import service has been destroyed."
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
                        `import:${name}`,
                        detail
                    );
                } catch (_error) {
                    /* Observer failures must not break imports. */
                }

                dispatch(
                    this.context.root,
                    `speciedex:terminal-import-${name}`,
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

        createController(
            externalSignal =
                null
        ) {
            const controller =
                new AbortController();

            if (
                externalSignal
            ) {
                if (
                    externalSignal.aborted
                ) {
                    controller.abort(
                        externalSignal.reason
                    );
                } else {
                    externalSignal.addEventListener(
                        "abort",
                        () => {
                            try {
                                controller.abort(
                                    externalSignal.reason
                                );
                            } catch (_error) {
                                controller.abort();
                            }
                        },
                        {
                            once:
                                true
                        }
                    );
                }
            }

            this.activeControllers.add(
                controller
            );

            return controller;
        }

        releaseController(
            controller
        ) {
            this.activeControllers.delete(
                controller
            );
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

        async readFile(
            file,
            options =
                {}
        ) {
            this.ensureAvailable();

            const controller =
                this.createController(
                    options.signal
                );

            const loadingID =
                `import:${Date.now()}:${Math.random().toString(36).slice(2)}`;

            this.context.loading?.start?.(
                loadingID,
                {
                    label:
                        `Reading ${file?.name || "file"}`
                }
            );

            try {
                const result =
                    await readFile(
                        file,
                        {
                            maxFileSize:
                                options.maxFileSize ||
                                this.maxFileSize,
                            maxRecords:
                                options.maxRecords ||
                                this.maxRecords,
                            signal:
                                controller.signal
                        }
                    );

                this.metrics.filesRead +=
                    1;

                this.metrics.recordsRead +=
                    result.records.length;

                this.emit(
                    "read",
                    result
                );

                this.context.loading?.end?.(
                    loadingID
                );

                return result;
            } catch (error) {
                if (
                    isAbortError(
                        error
                    )
                ) {
                    this.metrics.cancelled +=
                        1;
                } else {
                    this.metrics.failedFiles +=
                        1;
                }

                this.context.loading?.fail?.(
                    loadingID,
                    error
                );

                throw error;
            } finally {
                this.releaseController(
                    controller
                );
            }
        }

        async readFiles(
            files,
            options =
                {}
        ) {
            this.ensureAvailable();

            const values =
                Array.from(
                    files ||
                    []
                );

            if (
                values.length >
                this.maxFiles
            ) {
                throw new RangeError(
                    `Import contains ${values.length} files; maximum is ${this.maxFiles}.`
                );
            }

            const results =
                new Array(
                    values.length
                );

            const failures =
                [];

            let cursor =
                0;

            const worker =
                async () => {
                    while (
                        cursor <
                        values.length
                    ) {
                        const index =
                            cursor;

                        cursor +=
                            1;

                        try {
                            results[
                                index
                            ] =
                                await this.readFile(
                                    values[
                                        index
                                    ],
                                    options
                                );
                        } catch (error) {
                            failures.push({
                                index,
                                file:
                                    values[
                                        index
                                    ]?.name ||
                                    `file-${index + 1}`,
                                error
                            });

                            if (
                                options.continueOnError !==
                                    true
                            ) {
                                throw error;
                            }
                        }

                        await yieldToMainThread();
                    }
                };

            const workers =
                Array.from(
                    {
                        length:
                            Math.min(
                                this.readConcurrency,
                                values.length
                            )
                    },
                    () =>
                        worker()
                );

            await Promise.all(
                workers
            );

            const successful =
                results.filter(
                    Boolean
                );

            if (
                failures.length
            ) {
                this.emit(
                    "partial",
                    {
                        successful:
                            successful.length,
                        failed:
                            failures.map(
                                failure => ({
                                    index:
                                        failure.index,
                                    file:
                                        failure.file,
                                    message:
                                        failure.error.message
                                })
                            )
                    }
                );
            }

            return successful;
        }

        async setCollection(
            collection,
            records,
            options =
                {}
        ) {
            this.ensureAvailable();

            const name =
                normalizeCollectionName(
                    collection ||
                    this.defaultCollection
                );

            const library =
                this.context.library ||
                this.context.services?.get?.(
                    "library"
                );

            if (!library) {
                throw new Error(
                    "Terminal library service is unavailable."
                );
            }

            const incoming =
                arrayFromPayload(
                    records
                );

            let output =
                incoming;

            if (
                options.append ===
                    true ||
                options.merge ===
                    true
            ) {
                const current =
                    arrayFromPayload(
                        library.get?.(
                            name
                        )
                    );

                output = [
                    ...current,
                    ...incoming
                ];
            }

            if (
                options.dedupe !==
                false
            ) {
                const seen =
                    new Set();

                const unique =
                    [];

                for (
                    let index =
                        0;
                    index <
                        output.length;
                    index +=
                        1
                ) {
                    const record =
                        output[
                            index
                        ];

                    const identity =
                        recordIdentity(
                            record,
                            index
                        );

                    if (
                        seen.has(
                            identity
                        )
                    ) {
                        this.metrics.duplicateRecords +=
                            1;

                        continue;
                    }

                    seen.add(
                        identity
                    );

                    unique.push(
                        record
                    );
                }

                output =
                    unique;
            }

            if (
                output.length >
                this.maxRecords
            ) {
                throw new RangeError(
                    `Collection "${name}" would contain ${output.length} records; maximum is ${this.maxRecords}.`
                );
            }

            const write =
                () => {
                    if (
                        typeof library.set ===
                            "function"
                    ) {
                        return library.set(
                            name,
                            output,
                            {
                                ...options,
                                source:
                                    options.source ||
                                    "import",
                                description:
                                    options.description ||
                                    `Imported records for ${name}.`
                            }
                        );
                    }

                    library[
                        name
                    ] =
                        output;

                    return output;
                };

            if (
                typeof library.batch ===
                    "function"
            ) {
                await library.batch(
                    write
                );
            } else {
                await write();
            }

            this.metrics.libraryWrites +=
                1;

            this.metrics.recordsStored +=
                output.length;

            const detail = {
                collection:
                    name,
                count:
                    output.length,
                imported:
                    incoming.length,
                records:
                    output
            };

            this.emit(
                "stored",
                detail
            );

            const index =
                this.context.index ||
                this.context.services?.get?.(
                    "index"
                );

            if (
                options.rebuildIndex !==
                    false &&
                index &&
                (
                    typeof index.rebuild ===
                        "function" ||
                    typeof index.build ===
                        "function"
                )
            ) {
                window.setTimeout(
                    () => {
                        Promise.resolve(
                            typeof index.rebuild ===
                                "function"
                                ? index.rebuild(
                                    output,
                                    {
                                        source:
                                            "import",
                                        collection:
                                            name
                                    }
                                )
                                : index.build(
                                    output,
                                    [],
                                    {
                                        source:
                                            "import",
                                        collection:
                                            name
                                    }
                                )
                        ).then(
                            () => {
                                this.metrics.indexRefreshes +=
                                    1;
                            }
                        ).catch(
                            error => {
                                this.emit(
                                    "index-error",
                                    {
                                        collection:
                                            name,
                                        message:
                                            error.message
                                    }
                                );
                            }
                        );
                    },
                    0
                );
            }

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
                await this.setCollection(
                    collection,
                    result.records,
                    options
                );

            const detail = {
                ...result,
                ...stored
            };

            this.metrics.filesImported +=
                1;

            this.recordHistory({
                type:
                    "file",
                collection:
                    stored.collection,
                files: [
                    result.file
                ],
                count:
                    stored.count
            });

            this.emit(
                "complete",
                detail
            );

            return detail;
        }

        async importFiles(
            files,
            collection =
                "records",
            options =
                {}
        ) {
            this.ensureAvailable();

            const results =
                await this.readFiles(
                    files,
                    options
                );

            if (
                options.merge ===
                    false
            ) {
                const stored =
                    [];

                for (
                    let index =
                        0;
                    index <
                        results.length;
                    index +=
                        1
                ) {
                    stored.push(
                        await this.setCollection(
                            `${collection}-${index + 1}`,
                            results[
                                index
                            ].records,
                            {
                                ...options,
                                rebuildIndex:
                                    false
                            }
                        )
                    );
                }

                this.metrics.filesImported +=
                    results.length;

                this.recordHistory({
                    type:
                        "files-separate",
                    collection,
                    files:
                        results.map(
                            result =>
                                result.file
                        ),
                    count:
                        stored.reduce(
                            (
                                total,
                                item
                            ) =>
                                total +
                                item.count,
                            0
                        )
                });

                this.emit(
                    "complete",
                    {
                        files:
                            results.map(
                                result =>
                                    result.file
                            ),
                        collections:
                            stored
                    }
                );

                return stored;
            }

            const records =
                results.flatMap(
                    result =>
                        result.records
                );

            if (
                records.length >
                this.maxRecords
            ) {
                throw new RangeError(
                    `Combined import contains ${records.length} records; maximum is ${this.maxRecords}.`
                );
            }

            const stored =
                await this.setCollection(
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

            this.metrics.filesImported +=
                results.length;

            this.recordHistory({
                type:
                    "files-merged",
                collection:
                    stored.collection,
                files:
                    detail.files,
                count:
                    stored.count
            });

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

                    this.openPickers.add(
                        input
                    );

                    const cleanup =
                        () => {
                            this.openPickers.delete(
                                input
                            );

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

                    document.body.appendChild(
                        input
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
                    this.metrics.dropImports +=
                        1;

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
                maxFiles:
                    this.maxFiles,
                readConcurrency:
                    this.readConcurrency,
                defaultCollection:
                    this.defaultCollection,
                activeImports:
                    this.activeControllers.size,
                openPickers:
                    this.openPickers.size,
                history:
                    this.history.length,
                metrics: {
                    ...this.metrics
                },
                dropTargetAttached:
                    Boolean(
                        this.dropTarget
                    ),
                destroyed:
                    this.destroyed
            };
        }

        cancelAll(
            reason =
                "cancelled"
        ) {
            let cancelled =
                0;

            for (
                const controller of
                this.activeControllers
            ) {
                if (
                    !controller.signal.aborted
                ) {
                    try {
                        controller.abort(
                            reason
                        );
                    } catch (_error) {
                        controller.abort();
                    }

                    cancelled +=
                        1;
                }
            }

            this.activeControllers.clear();

            return cancelled;
        }

        destroy() {
            if (
                this.destroyed
            ) {
                return false;
            }

            this.cancelAll(
                "service-destroyed"
            );

            this.detachDropTarget();

            for (
                const input of
                this.openPickers
            ) {
                input.remove();
            }

            this.openPickers.clear();

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
                    IMPORT_SYMBOL
                ] ===
                    this
            ) {
                delete this.context.root[
                    IMPORT_SYMBOL
                ];
            }

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
            context.importer instanceof
                ImportService
                ? context.importer
                : context.services?.get?.(
                    "import"
                ) ||
                context.services?.get?.(
                    "importer"
                ) ||
                root?.[
                    IMPORT_SYMBOL
                ];

        if (
            existing instanceof
                ImportService &&
            !existing.destroyed
        ) {
            context.importer =
                existing;

            context.registerService?.(
                "import",
                existing
            );

            context.registerService?.(
                "importer",
                existing
            );

            return existing;
        }

        const dataset =
            root?.
                dataset ||
            {};

        const service =
            new ImportService(
                context,
                {
                    maxFileSize:
                        dataset.terminalImportMaxFileSize,

                    maxRecords:
                        dataset.terminalImportMaxRecords,

                    maxFiles:
                        dataset.terminalImportMaxFiles,

                    historyLimit:
                        dataset.terminalImportHistoryLimit,

                    readConcurrency:
                        dataset.terminalImportReadConcurrency,

                    defaultCollection:
                        dataset.terminalImportCollection ||
                        "records"
                }
            );

        root[
            IMPORT_SYMBOL
        ] =
            service;

        context.importer =
            service;

        context.registerService?.(
            "import",
            service
        );

        context.registerService?.(
            "importer",
            service
        );

        if (
            dataset.terminalImportDrop !==
            "false"
        ) {
            service.attachDropTarget(
                root,
                {
                    collection:
                        service.defaultCollection,
                    merge:
                        true,
                    append:
                        dataset.terminalImportAppend ===
                        "true",
                    dedupe:
                        dataset.terminalImportDedupe !==
                        "false"
                }
            );
        }

        dispatch(
            document,
            "speciedex:terminal-import-ready",
            {
                context,
                importer:
                    service,
                version:
                    VERSION
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
                "import [collection] [--multiple] [--append] [--no-dedupe] [--no-index]",
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
                        multiple,
                        append:
                            args.includes(
                                "--append"
                            ),
                        merge:
                            true,
                        dedupe:
                            !args.includes(
                                "--no-dedupe"
                            ),
                        rebuildIndex:
                            !args.includes(
                                "--no-index"
                            )
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
            name:
                "import-cancel",

            category:
                "data",

            description:
                "Cancel active file imports.",

            usage:
                "import-cancel",

            handler: ({
                context,
                writeJSON
            }) => {
                const importer =
                    requireImporter(
                        context
                    );

                return writeJSON({
                    cancelled:
                        importer.cancelAll(
                            "command"
                        ),
                    status:
                        importer.status()
                });
            }
        },

        {
            name:
                "import-history",

            category:
                "data",

            description:
                "Display recent import operations.",

            usage:
                "import-history [limit]",

            handler: ({
                args = [],
                context,
                writeJSON
            }) => {
                const importer =
                    requireImporter(
                        context
                    );

                const limit =
                    clampInteger(
                        args[0],
                        25,
                        1,
                        importer.historyLimit
                    );

                return writeJSON({
                    history:
                        importer.history.slice(
                            -limit
                        )
                });
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
        IMPORT_SYMBOL,
        ImportService,
        extensionOf,
        stripBOM,
        isAbortError,
        throwIfAborted,
        yieldToMainThread,
        arrayFromPayload,
        recordIdentity,
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
