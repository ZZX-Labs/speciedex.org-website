/*
========================================================================
Speciedex.org
Terminal History Utilities
========================================================================

Structured command-history service for SpeciedexTerminal.

Provides:

    • Durable command-history access
    • Deduplication and configurable limits
    • Previous/next navigation state
    • Search, filtering, import, and export
    • Safe persistence hooks
    • Lifecycle events and service registration
    • Terminal command integration

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "History";
    const VERSION = "2.0.0";

    const DEFAULT_LIMIT = 500;
    const MIN_LIMIT = 10;
    const MAX_LIMIT = 10000;

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

    function normalizeCommand(value) {
        return String(value ?? "")
            .replace(/\r\n?/g, "\n")
            .trim();
    }

    function nowISO() {
        return new Date().toISOString();
    }

    function createId() {
        try {
            if (
                window.crypto &&
                typeof window.crypto.randomUUID === "function"
            ) {
                return window.crypto.randomUUID();
            }
        } catch (_error) {
            /*
            ------------------------------------------------------------------
            Fall through to a local identifier.
            ------------------------------------------------------------------
            */
        }

        return [
            Date.now().toString(36),
            Math.random().toString(36).slice(2, 12)
        ].join("-");
    }

    function normalizeEntry(entry, index = 0) {
        if (typeof entry === "string") {
            const command =
                normalizeCommand(entry);

            return command
                ? {
                    id: createId(),
                    command,
                    timestamp: nowISO(),
                    source: "legacy",
                    metadata: {},
                    index
                }
                : null;
        }

        if (
            !entry ||
            typeof entry !== "object"
        ) {
            return null;
        }

        const command =
            normalizeCommand(
                entry.command ??
                entry.value ??
                entry.text
            );

        if (!command) {
            return null;
        }

        return {
            id:
                String(
                    entry.id ||
                    createId()
                ),
            command,
            timestamp:
                Number.isFinite(
                    Date.parse(entry.timestamp)
                )
                    ? new Date(
                        entry.timestamp
                    ).toISOString()
                    : nowISO(),
            source:
                String(
                    entry.source ||
                    "terminal"
                ),
            metadata:
                entry.metadata &&
                typeof entry.metadata === "object"
                    ? { ...entry.metadata }
                    : {},
            index
        };
    }

    class HistoryService extends EventTarget {
        constructor(context, options = {}) {
            super();

            if (!context || typeof context !== "object") {
                throw new TypeError(
                    "A terminal context is required."
                );
            }

            this.context = context;
            this.limit =
                clampInteger(
                    options.limit,
                    DEFAULT_LIMIT,
                    MIN_LIMIT,
                    MAX_LIMIT
                );

            this.dedupe =
                options.dedupe !== false;

            this.entries = [];
            this.position = 0;
            this.draft = "";
            this.destroyed = false;

            this.load();
        }

        ensureAvailable() {
            if (this.destroyed) {
                throw new Error(
                    "History service has been destroyed."
                );
            }
        }

        load() {
            const appHistory =
                Array.isArray(
                    this.context.app?.history
                )
                    ? this.context.app.history
                    : [];

            const storedHistory =
                this.context.storage?.get?.(
                    "history",
                    []
                );

            const source =
                appHistory.length
                    ? appHistory
                    : (
                        Array.isArray(
                            storedHistory
                        )
                            ? storedHistory
                            : []
                    );

            this.entries =
                source
                    .map(
                        (entry, index) =>
                            normalizeEntry(
                                entry,
                                index
                            )
                    )
                    .filter(Boolean)
                    .slice(-this.limit);

            this.position =
                this.entries.length;

            this.syncApp();

            return this.entries;
        }

        syncApp() {
            if (!this.context.app) {
                return;
            }

            this.context.app.history =
                this.entries.map(
                    entry =>
                        entry.command
                );

            this.context.app.historyIndex =
                this.position;
        }

        persist() {
            this.syncApp();

            try {
                this.context.app?.
                    persistHistory?.();
            } catch (_error) {
                /*
                ----------------------------------------------------------------
                Fall back to storage below.
                ----------------------------------------------------------------
                */
            }

            try {
                this.context.storage?.set?.(
                    "history",
                    this.entries
                );
            } catch (_error) {
                /*
                ----------------------------------------------------------------
                Persistence is best effort.
                ----------------------------------------------------------------
                */
            }

            return true;
        }

        emit(name, detail) {
            dispatch(
                this,
                name,
                detail
            );

            try {
                this.context.events?.emit?.(
                    `history:${name}`,
                    detail
                );
            } catch (_error) {
                /*
                ----------------------------------------------------------------
                Observer failures must not break history.
                ----------------------------------------------------------------
                */
            }

            dispatch(
                this.context.root,
                `speciedex:terminal-history-${name}`,
                detail,
                {
                    bubbles: true
                }
            );
        }

        add(command, options = {}) {
            this.ensureAvailable();

            const normalized =
                normalizeCommand(command);

            if (!normalized) {
                return null;
            }

            if (
                this.dedupe &&
                this.entries.length &&
                this.entries[
                    this.entries.length - 1
                ].command === normalized
            ) {
                this.position =
                    this.entries.length;

                this.draft = "";

                return this.entries[
                    this.entries.length - 1
                ];
            }

            const entry =
                normalizeEntry(
                    {
                        command: normalized,
                        timestamp:
                            options.timestamp ||
                            nowISO(),
                        source:
                            options.source ||
                            "terminal",
                        metadata:
                            options.metadata || {}
                    },
                    this.entries.length
                );

            this.entries.push(entry);

            if (
                this.entries.length >
                this.limit
            ) {
                this.entries.splice(
                    0,
                    this.entries.length -
                    this.limit
                );
            }

            this.position =
                this.entries.length;

            this.draft = "";

            if (options.persist !== false) {
                this.persist();
            }

            this.emit(
                "add",
                {
                    entry,
                    count:
                        this.entries.length
                }
            );

            return entry;
        }

        previous(currentValue = "") {
            this.ensureAvailable();

            if (!this.entries.length) {
                return null;
            }

            if (
                this.position ===
                this.entries.length
            ) {
                this.draft =
                    String(currentValue ?? "");
            }

            this.position =
                Math.max(
                    0,
                    this.position - 1
                );

            this.syncApp();

            const entry =
                this.entries[
                    this.position
                ] || null;

            this.emit(
                "navigate",
                {
                    direction:
                        "previous",
                    position:
                        this.position,
                    entry
                }
            );

            return entry?.command ?? null;
        }

        next() {
            this.ensureAvailable();

            if (!this.entries.length) {
                return this.draft;
            }

            if (
                this.position <
                this.entries.length
            ) {
                this.position += 1;
            }

            this.syncApp();

            const command =
                this.position >=
                this.entries.length
                    ? this.draft
                    : this.entries[
                        this.position
                    ]?.command ?? "";

            this.emit(
                "navigate",
                {
                    direction:
                        "next",
                    position:
                        this.position,
                    command
                }
            );

            return command;
        }

        resetNavigation(draft = "") {
            this.position =
                this.entries.length;

            this.draft =
                String(draft ?? "");

            this.syncApp();

            return this.position;
        }

        get(index) {
            this.ensureAvailable();

            const normalizedIndex =
                Number(index);

            if (
                !Number.isInteger(
                    normalizedIndex
                )
            ) {
                return null;
            }

            if (normalizedIndex < 0) {
                return (
                    this.entries[
                        this.entries.length +
                        normalizedIndex
                    ] || null
                );
            }

            return (
                this.entries[
                    normalizedIndex
                ] || null
            );
        }

        list(options = {}) {
            this.ensureAvailable();

            const contains =
                String(
                    options.contains || ""
                )
                    .trim()
                    .toLowerCase();

            const source =
                options.source
                    ? String(
                        options.source
                    )
                    : null;

            const since =
                options.since
                    ? Date.parse(
                        options.since
                    )
                    : Number.NaN;

            const until =
                options.until
                    ? Date.parse(
                        options.until
                    )
                    : Number.NaN;

            const limit =
                clampInteger(
                    options.limit,
                    100,
                    1,
                    this.limit
                );

            const filtered =
                this.entries.filter(entry => {
                    const timestamp =
                        Date.parse(
                            entry.timestamp
                        );

                    return (
                        (
                            !contains ||
                            entry.command
                                .toLowerCase()
                                .includes(
                                    contains
                                )
                        ) &&
                        (
                            !source ||
                            entry.source ===
                            source
                        ) &&
                        (
                            !Number.isFinite(
                                since
                            ) ||
                            timestamp >= since
                        ) &&
                        (
                            !Number.isFinite(
                                until
                            ) ||
                            timestamp <= until
                        )
                    );
                });

            const sliced =
                filtered.slice(-limit);

            return options.newestFirst === false
                ? sliced
                : [...sliced].reverse();
        }

        search(query, options = {}) {
            return this.list({
                ...options,
                contains: query
            });
        }

        remove(indexOrId) {
            this.ensureAvailable();

            let index = -1;

            if (
                Number.isInteger(
                    Number(indexOrId)
                )
            ) {
                index =
                    Number(indexOrId);

                if (index < 0) {
                    index =
                        this.entries.length +
                        index;
                }
            } else {
                index =
                    this.entries.findIndex(
                        entry =>
                            entry.id ===
                            String(indexOrId)
                    );
            }

            if (
                index < 0 ||
                index >=
                    this.entries.length
            ) {
                return null;
            }

            const [
                removed
            ] =
                this.entries.splice(
                    index,
                    1
                );

            this.position =
                Math.min(
                    this.position,
                    this.entries.length
                );

            this.persist();

            this.emit(
                "remove",
                {
                    entry: removed,
                    index
                }
            );

            return removed;
        }

        clear(options = {}) {
            this.ensureAvailable();

            const count =
                this.entries.length;

            this.entries.length = 0;
            this.position = 0;
            this.draft = "";

            if (options.persist !== false) {
                this.persist();
            } else {
                this.syncApp();
            }

            this.emit(
                "clear",
                {
                    count
                }
            );

            return count;
        }

        setLimit(limit) {
            this.ensureAvailable();

            this.limit =
                clampInteger(
                    limit,
                    this.limit,
                    MIN_LIMIT,
                    MAX_LIMIT
                );

            if (
                this.entries.length >
                this.limit
            ) {
                this.entries.splice(
                    0,
                    this.entries.length -
                    this.limit
                );
            }

            this.position =
                Math.min(
                    this.position,
                    this.entries.length
                );

            this.persist();

            return this.limit;
        }

        import(data, options = {}) {
            this.ensureAvailable();

            let source = data;

            if (typeof source === "string") {
                try {
                    source =
                        JSON.parse(source);
                } catch (_error) {
                    source =
                        source
                            .split(/\r?\n/)
                            .filter(Boolean);
                }
            }

            const values =
                Array.isArray(source)
                    ? source
                    : (
                        Array.isArray(
                            source?.history
                        )
                            ? source.history
                            : (
                                Array.isArray(
                                    source?.entries
                                )
                                    ? source.entries
                                    : []
                            )
                    );

            const imported =
                values
                    .map(
                        (entry, index) =>
                            normalizeEntry(
                                entry,
                                index
                            )
                    )
                    .filter(Boolean);

            if (
                options.replace === true
            ) {
                this.entries = [];
            }

            for (const entry of imported) {
                if (
                    this.dedupe &&
                    this.entries.some(
                        existing =>
                            existing.command ===
                                entry.command &&
                            existing.timestamp ===
                                entry.timestamp
                    )
                ) {
                    continue;
                }

                this.entries.push(entry);
            }

            this.entries =
                this.entries.slice(
                    -this.limit
                );

            this.position =
                this.entries.length;

            this.persist();

            this.emit(
                "import",
                {
                    imported:
                        imported.length,
                    count:
                        this.entries.length
                }
            );

            return imported.length;
        }

        export(options = {}) {
            this.ensureAvailable();

            const entries =
                options.commandsOnly === true
                    ? this.entries.map(
                        entry =>
                            entry.command
                    )
                    : this.entries.map(
                        entry => ({
                            ...entry,
                            metadata:
                                {
                                    ...entry.metadata
                                }
                        })
                    );

            return {
                version: VERSION,
                generatedAt:
                    nowISO(),
                limit:
                    this.limit,
                count:
                    this.entries.length,
                history:
                    entries
            };
        }

        status() {
            return {
                version: VERSION,
                count:
                    this.entries.length,
                limit:
                    this.limit,
                position:
                    this.position,
                dedupe:
                    this.dedupe,
                destroyed:
                    this.destroyed
            };
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            this.persist();
            this.destroyed = true;

            dispatch(
                this,
                "destroy",
                {
                    timestamp:
                        nowISO()
                }
            );

            return true;
        }
    }

    function initialize(context) {
        if (
            context.historyService instanceof
            HistoryService &&
            !context.historyService.destroyed
        ) {
            return context.historyService;
        }

        const dataset =
            context.root?.dataset || {};

        const service =
            new HistoryService(
                context,
                {
                    limit:
                        dataset.
                            terminalHistoryLimit,
                    dedupe:
                        dataset.
                            terminalHistoryDedupe !==
                        "false"
                }
            );

        context.historyService =
            service;

        context.registerService?.(
            "history",
            service
        );

        dispatch(
            document,
            "speciedex:terminal-history-ready",
            {
                context,
                history: service
            }
        );

        return service;
    }

    function requireHistory(context) {
        if (
            !(
                context?.historyService instanceof
                HistoryService
            )
        ) {
            throw new Error(
                "Terminal history service is unavailable."
            );
        }

        return context.historyService;
    }

    function writeText(write, message, type = "output") {
        if (typeof write === "function") {
            return write(
                message,
                type,
                {
                    preformatted: true
                }
            );
        }

        return message;
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
            name: "history",
            aliases: [
                "history-list"
            ],
            category: "system",
            description:
                "Display terminal command history.",
            usage:
                "history [limit] [search terms]",
            handler: ({
                args = [],
                context,
                write
            }) => {
                const service =
                    requireHistory(context);

                const first =
                    Number.parseInt(
                        args[0],
                        10
                    );

                const hasLimit =
                    Number.isFinite(first);

                const limit =
                    hasLimit
                        ? first
                        : 100;

                const contains =
                    args
                        .slice(
                            hasLimit
                                ? 1
                                : 0
                        )
                        .join(" ");

                const entries =
                    service.list({
                        limit,
                        contains,
                        newestFirst: false
                    });

                if (!entries.length) {
                    return writeText(
                        write,
                        "Command history is empty."
                    );
                }

                return writeText(
                    write,
                    entries
                        .map(
                            (entry, index) =>
                                `${String(index + 1).padStart(4)}  ${entry.command}`
                        )
                        .join("\n")
                );
            }
        },
        {
            name: "history-search",
            aliases: [
                "hgrep"
            ],
            category: "system",
            description:
                "Search terminal command history.",
            usage:
                "history-search <query> [limit]",
            handler: ({
                args = [],
                context,
                writeJSON
            }) => {
                const query =
                    args[0];

                if (!query) {
                    throw new Error(
                        "A history search query is required."
                    );
                }

                const result =
                    requireHistory(
                        context
                    ).search(
                        query,
                        {
                            limit:
                                args[1] || 100,
                            newestFirst:
                                true
                        }
                    );

                return writeJSONValue(
                    writeJSON,
                    result
                );
            }
        },
        {
            name: "history-clear",
            category: "system",
            description:
                "Clear terminal command history.",
            usage:
                "history-clear",
            handler: ({
                context,
                write
            }) => {
                const count =
                    requireHistory(
                        context
                    ).clear();

                return writeText(
                    write,
                    `Cleared ${count} command-history entr${count === 1 ? "y" : "ies"}.`,
                    "success"
                );
            }
        },
        {
            name: "history-remove",
            category: "system",
            description:
                "Remove one command-history entry by index or ID.",
            usage:
                "history-remove <index|id>",
            handler: ({
                args = [],
                context,
                write
            }) => {
                if (!args[0]) {
                    throw new Error(
                        "A history index or ID is required."
                    );
                }

                const removed =
                    requireHistory(
                        context
                    ).remove(
                        args[0]
                    );

                if (!removed) {
                    throw new Error(
                        `History entry not found: ${args[0]}`
                    );
                }

                return writeText(
                    write,
                    `Removed history entry: ${removed.command}`,
                    "success"
                );
            }
        },
        {
            name: "history-status",
            category: "system",
            description:
                "Show command-history service status.",
            usage:
                "history-status",
            handler: ({
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    requireHistory(
                        context
                    ).status()
                )
        },
        {
            name: "history-export",
            category: "system",
            description:
                "Export command history as JSON.",
            usage:
                "history-export [filename]",
            handler: ({
                args = [],
                context,
                write
            }) => {
                const service =
                    requireHistory(context);

                const filename =
                    args[0] ||
                    "speciedex-terminal-history.json";

                const payload =
                    service.export();

                if (
                    context.exporter &&
                    typeof context.exporter.json ===
                    "function"
                ) {
                    context.exporter.json(
                        payload,
                        filename
                    );
                } else {
                    const blob =
                        new Blob(
                            [
                                JSON.stringify(
                                    payload,
                                    null,
                                    2
                                )
                            ],
                            {
                                type:
                                    "application/json;charset=utf-8"
                            }
                        );

                    const url =
                        URL.createObjectURL(
                            blob
                        );

                    const anchor =
                        document.createElement(
                            "a"
                        );

                    anchor.href = url;
                    anchor.download =
                        filename;
                    anchor.hidden = true;

                    document.body?.
                        appendChild(anchor);

                    anchor.click();
                    anchor.remove();

                    window.setTimeout(
                        () =>
                            URL.revokeObjectURL(
                                url
                            ),
                        1000
                    );
                }

                return writeText(
                    write,
                    `Command history exported to ${filename}.`,
                    "success"
                );
            }
        }
    ];

    const api = Object.freeze({
        name: MODULE_NAME,
        version: VERSION,
        HistoryService,
        normalizeCommand,
        normalizeEntry,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalHistory =
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
