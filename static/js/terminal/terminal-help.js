/*
========================================================================
Speciedex.org
Terminal Help System
========================================================================

Structured help service for SpeciedexTerminal.

Provides:

    • Named help topics with metadata and aliases
    • Topic search and category indexing
    • Command discovery and command-specific help
    • Safe text rendering
    • Import and export support
    • Lifecycle events and service registration
    • Terminal command integration

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Help";
    const VERSION = "2.1.0";

    const HELP_SYMBOL =
        Symbol.for(
            "speciedex.terminal.help.service"
        );

    const DEFAULT_MAX_TOPICS =
        5000;

    const DEFAULT_MAX_IMPORT_TOPICS =
        5000;

    const DEFAULT_MAX_SEARCH_RESULTS =
        100;

    const RESERVED_NAMES =
        new Set([
            "__proto__",
            "prototype",
            "constructor"
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

    function clone(
        value,
        seen =
            new WeakMap()
    ) {
        if (
            value ===
                null ||
            value ===
                undefined ||
            typeof value !==
                "object"
        ) {
            return value;
        }

        if (
            typeof structuredClone ===
                "function"
        ) {
            try {
                return structuredClone(
                    value
                );
            } catch (_error) {
                /* Continue with deterministic fallback. */
            }
        }

        if (
            seen.has(
                value
            )
        ) {
            return seen.get(
                value
            );
        }

        if (
            value instanceof
                Date
        ) {
            return new Date(
                value.getTime()
            );
        }

        if (
            Array.isArray(
                value
            )
        ) {
            const output =
                [];

            seen.set(
                value,
                output
            );

            for (
                const item of
                value
            ) {
                output.push(
                    clone(
                        item,
                        seen
                    )
                );
            }

            return output;
        }

        const output =
            {};

        seen.set(
            value,
            output
        );

        for (
            const [
                key,
                item
            ] of Object.entries(
                value
            )
        ) {
            if (
                RESERVED_NAMES.has(
                    key
                )
            ) {
                continue;
            }

            output[
                key
            ] =
                clone(
                    item,
                    seen
                );
        }

        return output;
    }

    function normalizeName(value) {
        const normalized =
            String(
                value ??
                ""
            )
                .trim()
                .toLowerCase()
                .replace(
                    /\s+/g,
                    "-"
                );

        return RESERVED_NAMES.has(
            normalized
        )
            ? ""
            : normalized;
    }

    function normalizeAliases(value) {
        const aliases =
            Array.isArray(value)
                ? value
                : (
                    value === undefined ||
                    value === null
                        ? []
                        : [value]
                );

        return [
            ...new Set(
                aliases
                    .map(normalizeName)
                    .filter(Boolean)
            )
        ];
    }

    function normalizeContent(content) {
        if (Array.isArray(content)) {
            return content
                .map(item => String(item ?? ""))
                .join("\n");
        }

        if (
            content === null ||
            content === undefined
        ) {
            return "";
        }

        if (typeof content === "string") {
            return content;
        }

        try {
            return JSON.stringify(
                content,
                null,
                2
            );
        } catch (_error) {
            return String(content);
        }
    }

    function normalizeTopic(topic, content = "", options = {}) {
        if (
            topic &&
            typeof topic === "object" &&
            !Array.isArray(topic)
        ) {
            options = {
                ...topic,
                ...options
            };

            content =
                topic.content ??
                content;

            topic =
                topic.name ??
                topic.topic ??
                topic.id;
        }

        const name =
            normalizeName(topic);

        if (!name) {
            throw new TypeError(
                "A help topic name is required."
            );
        }

        const title =
            String(
                options.title ||
                name
                    .split("-")
                    .map(part =>
                        part
                            ? part[0].toUpperCase() +
                              part.slice(1)
                            : ""
                    )
                    .join(" ")
            );

        return {
            name,
            title,
            category:
                normalizeName(
                    options.category ||
                    "general"
                ),
            content:
                normalizeContent(content),
            aliases:
                normalizeAliases(
                    options.aliases
                ),
            keywords:
                normalizeAliases(
                    options.keywords
                ),
            hidden:
                options.hidden === true,
            order:
                Number.isFinite(
                    Number(options.order)
                )
                    ? Number(options.order)
                    : 0,
            metadata:
                options.metadata &&
                typeof options.metadata ===
                    "object"
                    ? clone(
                        options.metadata
                    )
                    : {}
        };
    }

    function formatTopic(topic) {
        const lines = [
            topic.title,
            "=".repeat(
                Math.max(
                    3,
                    topic.title.length
                )
            ),
            "",
            topic.content
        ];

        if (topic.aliases.length) {
            lines.push(
                "",
                `Aliases: ${topic.aliases.join(", ")}`
            );
        }

        return lines.join("\n");
    }

    function resolveCommandRegistry(
        context
    ) {
        const candidates = [
            context?.commands,
            context?.commandRegistry,
            context?.router?.commands,
            context?.router?.registry,
            context?.console?.commands,
            context?.app?.commands,
            context?.services?.get?.(
                "router"
            )?.commands,
            window.SpeciedexTerminalCommands,
            window.SpeciedexTerminal?.
                commands
        ];

        const registry =
            new Map();

        function addCommand(
            name,
            command
        ) {
            if (
                !command ||
                typeof command !==
                    "object"
            ) {
                return;
            }

            const normalized =
                normalizeName(
                    command.name ||
                    name
                );

            if (!normalized) {
                return;
            }

            registry.set(
                normalized,
                command
            );
        }

        for (
            const candidate of
            candidates
        ) {
            if (
                candidate instanceof
                    Map
            ) {
                for (
                    const [
                        name,
                        command
                    ] of candidate
                ) {
                    addCommand(
                        name,
                        command
                    );
                }

                continue;
            }

            if (
                Array.isArray(
                    candidate
                )
            ) {
                for (
                    const command of
                    candidate
                ) {
                    addCommand(
                        command?.name,
                        command
                    );
                }

                continue;
            }

            if (
                candidate &&
                typeof candidate ===
                    "object"
            ) {
                for (
                    const [
                        name,
                        command
                    ] of Object.entries(
                        candidate
                    )
                ) {
                    addCommand(
                        name,
                        command
                    );
                }
            }
        }

        const modules =
            window.SpeciedexTerminalModules;

        if (
            modules &&
            typeof modules ===
                "object"
        ) {
            for (
                const module of
                Object.values(
                    modules
                )
            ) {
                if (
                    !Array.isArray(
                        module?.commands
                    )
                ) {
                    continue;
                }

                for (
                    const command of
                    module.commands
                ) {
                    addCommand(
                        command?.name,
                        command
                    );
                }
            }
        }

        return registry;
    }

    function normalizeCommand(command, fallbackName = "") {
        if (
            !command ||
            typeof command !== "object"
        ) {
            return null;
        }

        const name =
            normalizeName(
                command.name ||
                fallbackName
            );

        if (!name) {
            return null;
        }

        return {
            name,
            aliases:
                normalizeAliases(
                    command.aliases
                ),
            category:
                normalizeName(
                    command.category ||
                    "general"
                ),
            description:
                String(
                    command.description ||
                    ""
                ),
            usage:
                String(
                    command.usage ||
                    name
                )
        };
    }

    class HelpService extends EventTarget {
        constructor(
            context,
            options =
                {}
        ) {
            super();

            this.context =
                context;

            this.maxTopics =
                Number.isFinite(
                    Number(
                        options.maxTopics
                    )
                )
                    ? Math.max(
                        1,
                        Math.min(
                            100000,
                            Number(
                                options.maxTopics
                            )
                        )
                    )
                    : DEFAULT_MAX_TOPICS;

            this.maxImportTopics =
                Number.isFinite(
                    Number(
                        options.maxImportTopics
                    )
                )
                    ? Math.max(
                        1,
                        Math.min(
                            100000,
                            Number(
                                options.maxImportTopics
                            )
                        )
                    )
                    : DEFAULT_MAX_IMPORT_TOPICS;

            this.maxSearchResults =
                Number.isFinite(
                    Number(
                        options.maxSearchResults
                    )
                )
                    ? Math.max(
                        1,
                        Math.min(
                            10000,
                            Number(
                                options.maxSearchResults
                            )
                        )
                    )
                    : DEFAULT_MAX_SEARCH_RESULTS;

            this.topics =
                new Map();

            this.aliases =
                new Map();

            this.destroyed =
                false;

            this.emitting =
                false;

            this.commandCache =
                null;

            this.commandCacheSize =
                -1;

            this.metrics = {
                registered:
                    0,
                replaced:
                    0,
                unregistered:
                    0,
                searches:
                    0,
                commandLookups:
                    0,
                imports:
                    0,
                exports:
                    0,
                aliasConflicts:
                    0,
                showCalls:
                    0
            };
        }

        ensureAvailable() {
            if (this.destroyed) {
                throw new Error(
                    "Help service has been destroyed."
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
                        `help:${name}`,
                        detail
                    );
                } catch (_error) {
                    /* Observer failures must not break help. */
                }

                dispatch(
                    this.context.root,
                    `speciedex:terminal-help-${name}`,
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

        register(topic, content = "", options = {}) {
            this.ensureAvailable();

            const normalized =
                normalizeTopic(
                    topic,
                    content,
                    options
                );

            const existing =
                this.topics.get(
                    normalized.name
                );

            if (
                !existing &&
                this.topics.size >=
                    this.maxTopics
            ) {
                throw new RangeError(
                    `Help topic limit reached: ${this.maxTopics}`
                );
            }

            if (existing) {
                for (
                    const alias of
                    existing.aliases
                ) {
                    this.aliases.delete(alias);
                }
            }

            const aliases =
                [];

            for (
                const alias of
                normalized.aliases
            ) {
                const owner =
                    this.aliases.get(
                        alias
                    );

                if (
                    owner &&
                    owner !==
                        normalized.name
                ) {
                    this.metrics.aliasConflicts +=
                        1;

                    continue;
                }

                if (
                    this.topics.has(
                        alias
                    ) &&
                    alias !==
                        normalized.name
                ) {
                    this.metrics.aliasConflicts +=
                        1;

                    continue;
                }

                aliases.push(
                    alias
                );
            }

            normalized.aliases =
                aliases;

            this.topics.set(
                normalized.name,
                normalized
            );

            for (
                const alias of
                normalized.aliases
            ) {
                this.aliases.set(
                    alias,
                    normalized.name
                );
            }

            this.commandCache =
                null;

            if (existing) {
                this.metrics.replaced +=
                    1;
            } else {
                this.metrics.registered +=
                    1;
            }

            const detail = {
                topic:
                    clone(
                        normalized
                    )
            };

            this.emit(
                "register",
                detail
            );

            return clone(
                normalized
            );
        }

        registerMany(topics) {
            const registered = [];

            if (Array.isArray(topics)) {
                for (const topic of topics) {
                    registered.push(
                        this.register(topic)
                    );
                }

                return registered;
            }

            if (
                topics &&
                typeof topics === "object"
            ) {
                for (
                    const [
                        name,
                        value
                    ] of Object.entries(topics)
                ) {
                    if (
                        value &&
                        typeof value === "object" &&
                        !Array.isArray(value)
                    ) {
                        registered.push(
                            this.register({
                                name,
                                ...value
                            })
                        );
                    } else {
                        registered.push(
                            this.register(
                                name,
                                value
                            )
                        );
                    }
                }
            }

            return registered;
        }

        unregister(name) {
            this.ensureAvailable();

            const normalized =
                normalizeName(name);

            const canonical =
                this.aliases.get(
                    normalized
                ) || normalized;

            const topic =
                this.topics.get(
                    canonical
                );

            if (!topic) {
                return false;
            }

            for (
                const alias of
                topic.aliases
            ) {
                this.aliases.delete(alias);
            }

            this.topics.delete(
                canonical
            );

            this.metrics.unregistered +=
                1;

            this.emit(
                "unregister",
                {
                    topic:
                        clone(
                            topic
                        )
                }
            );

            return true;
        }

        has(name) {
            const normalized =
                normalizeName(name);

            return (
                this.topics.has(normalized) ||
                this.aliases.has(normalized)
            );
        }

        get(name) {
            this.ensureAvailable();

            const normalized =
                normalizeName(name);

            const canonical =
                this.aliases.get(
                    normalized
                ) || normalized;

            const topic =
                this.topics.get(
                    canonical
                ) ||
                null;

            return topic
                ? clone(
                    topic
                )
                : null;
        }

        list(options = {}) {
            this.ensureAvailable();

            const category =
                options.category
                    ? normalizeName(
                        options.category
                    )
                    : null;

            const includeHidden =
                options.includeHidden === true;

            return [
                ...this.topics.values()
            ]
                .filter(topic =>
                    (
                        includeHidden ||
                        !topic.hidden
                    ) &&
                    (
                        !category ||
                        topic.category ===
                        category
                    )
                )
                .sort((left, right) =>
                    left.order -
                    right.order ||
                    left.title.localeCompare(
                        right.title
                    )
                )
                .map(
                    clone
                );
        }

        categories() {
            return [
                ...new Set(
                    this.list()
                        .map(topic =>
                            topic.category
                        )
                )
            ].sort();
        }

        search(query, options = {}) {
            this.ensureAvailable();

            this.metrics.searches +=
                1;

            const normalized =
                String(query || "")
                    .trim()
                    .toLowerCase();

            if (!normalized) {
                return this.list(options);
            }

            const terms =
                normalized
                    .split(/\s+/)
                    .filter(Boolean);

            return this.list(options)
                .map(topic => {
                    const haystack = [
                        topic.name,
                        topic.title,
                        topic.category,
                        topic.content,
                        ...topic.aliases,
                        ...topic.keywords
                    ]
                        .join(" ")
                        .toLowerCase();

                    const score =
                        terms.reduce(
                            (total, term) => {
                                if (
                                    topic.name === term ||
                                    topic.aliases.includes(
                                        term
                                    )
                                ) {
                                    return total + 20;
                                }

                                if (
                                    topic.title
                                        .toLowerCase()
                                        .includes(term)
                                ) {
                                    return total + 10;
                                }

                                if (
                                    topic.keywords.some(
                                        keyword =>
                                            keyword.includes(
                                                term
                                            )
                                    )
                                ) {
                                    return total + 8;
                                }

                                if (
                                    haystack.includes(term)
                                ) {
                                    return total + 2;
                                }

                                return total;
                            },
                            0
                        );

                    return {
                        topic,
                        score
                    };
                })
                .filter(result =>
                    result.score > 0
                )
                .sort((left, right) =>
                    right.score -
                    left.score ||
                    left.topic.title.localeCompare(
                        right.topic.title
                    )
                )
                .map(result =>
                    result.topic
                )
                .slice(
                    0,
                    Number.isFinite(
                        Number(
                            options.limit
                        )
                    )
                        ? Math.max(
                            1,
                            Math.min(
                                this.maxSearchResults,
                                Number(
                                    options.limit
                                )
                            )
                        )
                        : this.maxSearchResults
                );
        }

        getCommands(
            options =
                {}
        ) {
            const registry =
                resolveCommandRegistry(
                    this.context
                );

            if (
                options.refresh !==
                    true &&
                this.commandCache &&
                this.commandCacheSize ===
                    registry.size
            ) {
                return this.commandCache.map(
                    clone
                );
            }

            const commands =
                [
                    ...registry.entries()
                ]
                    .map(
                        (
                            [
                                name,
                                command
                            ]
                        ) =>
                            normalizeCommand(
                                command,
                                name
                            )
                    )
                    .filter(
                        Boolean
                    )
                    .sort(
                        (
                            left,
                            right
                        ) =>
                            left.category.localeCompare(
                                right.category
                            ) ||
                            left.name.localeCompare(
                                right.name
                            )
                    );

            this.commandCache =
                commands;

            this.commandCacheSize =
                registry.size;

            return commands.map(
                clone
            );
        }

        refreshCommands() {
            this.commandCache =
                null;

            this.commandCacheSize =
                -1;

            return this.getCommands({
                refresh:
                    true
            });
        }

        findCommand(name) {
            this.metrics.commandLookups +=
                1;

            const normalized =
                normalizeName(name);

            return (
                this.getCommands().find(
                    command =>
                        command.name ===
                            normalized ||
                        command.aliases.includes(
                            normalized
                        )
                ) || null
            );
        }

        commandHelp(name) {
            const command =
                this.findCommand(name);

            if (!command) {
                return null;
            }

            const lines = [
                command.name,
                "=".repeat(
                    Math.max(
                        3,
                        command.name.length
                    )
                ),
                "",
                command.description ||
                "No description available.",
                "",
                `Usage: ${command.usage}`,
                `Category: ${command.category}`
            ];

            if (command.aliases.length) {
                lines.push(
                    `Aliases: ${command.aliases.join(", ")}`
                );
            }

            return lines.join("\n");
        }

        show(
            name =
                null,
            options =
                {}
        ) {
            this.ensureAvailable();

            this.metrics.showCalls +=
                1;

            const write =
                options.write ||
                this.context.write ||
                this.context.console?.write ||
                null;

            let output;

            if (
                !name
            ) {
                output = [
                    "SpeciedexTerminal Help",
                    "======================",
                    "",
                    "Use `commands` to list available commands.",
                    "Use `help <command>` for command usage.",
                    "Use `topics` to list help topics.",
                    "Use `topic <name>` to display a topic."
                ].join(
                    "\n"
                );
            } else {
                const command =
                    this.commandHelp(
                        name
                    );

                if (command) {
                    output =
                        command;
                } else {
                    const topic =
                        this.get(
                            name
                        );

                    output =
                        topic
                            ? formatTopic(
                                topic
                            )
                            : null;
                }
            }

            if (
                output ===
                    null
            ) {
                throw new Error(
                    `Unknown help topic or command: ${name}`
                );
            }

            if (
                typeof write ===
                    "function"
            ) {
                return write(
                    output,
                    "output",
                    {
                        preformatted:
                            true
                    }
                );
            }

            return output;
        }

        commandIndex(category = null) {
            const normalizedCategory =
                category
                    ? normalizeName(category)
                    : null;

            const commands =
                this.getCommands()
                    .filter(command =>
                        !normalizedCategory ||
                        command.category ===
                        normalizedCategory
                    );

            const groups = new Map();

            for (const command of commands) {
                const collection =
                    groups.get(
                        command.category
                    ) || [];

                collection.push(command);
                groups.set(
                    command.category,
                    collection
                );
            }

            const lines = [];

            for (
                const [
                    group,
                    entries
                ] of groups
            ) {
                lines.push(
                    group.toUpperCase()
                );

                for (
                    const command of
                    entries
                ) {
                    lines.push(
                        `  ${command.name.padEnd(24)} ${command.description}`
                    );
                }

                lines.push("");
            }

            return (
                lines.join("\n").trim() ||
                "No commands available."
            );
        }

        export() {
            this.ensureAvailable();

            this.metrics.exports +=
                1;

            return {
                version: VERSION,
                generatedAt:
                    new Date().toISOString(),
                topics:
                    this.list({
                        includeHidden: true
                    })
            };
        }

        import(data, options = {}) {
            this.ensureAvailable();

            const source =
                typeof data === "string"
                    ? JSON.parse(data)
                    : data;

            const topics =
                Array.isArray(source)
                    ? source
                    : (
                        Array.isArray(
                            source?.topics
                        )
                            ? source.topics
                            : []
                    );

            if (
                topics.length >
                this.maxImportTopics
            ) {
                throw new RangeError(
                    `Help import contains ${topics.length} topics; maximum is ${this.maxImportTopics}.`
                );
            }

            if (
                options.replace ===
                    true
            ) {
                this.clear();
            }

            const registered =
                this.registerMany(
                    topics
                );

            this.metrics.imports +=
                registered.length;

            this.emit(
                "import",
                {
                    imported:
                        registered.length
                }
            );

            return registered;
        }

        clear() {
            this.ensureAvailable();

            const count =
                this.topics.size;

            this.topics.clear();
            this.aliases.clear();

            this.commandCache =
                null;

            this.emit(
                "clear",
                {
                    count
                }
            );

            return count;
        }

        status() {
            return {
                version: VERSION,
                topics:
                    this.topics.size,
                aliases:
                    this.aliases.size,
                categories:
                    this.categories(),
                commands:
                    this.getCommands().length,
                limits: {
                    topics:
                        this.maxTopics,
                    imports:
                        this.maxImportTopics,
                    searchResults:
                        this.maxSearchResults
                },
                metrics: {
                    ...this.metrics
                },
                destroyed:
                    this.destroyed
            };
        }

        destroy() {
            if (
                this.destroyed
            ) {
                return false;
            }

            const count =
                this.topics.size;

            this.emit(
                "destroy",
                {
                    timestamp:
                        new Date().toISOString(),
                    version:
                        VERSION,
                    topics:
                        count
                }
            );

            this.topics.clear();
            this.aliases.clear();
            this.commandCache =
                null;

            if (
                this.context.root?.[
                    HELP_SYMBOL
                ] ===
                    this
            ) {
                delete this.context.root[
                    HELP_SYMBOL
                ];
            }

            this.destroyed =
                true;

            return true;
        }

    }

    function registerDefaultTopics(service) {
        service.register(
            "syntax",
            [
                "Commands support quoted arguments, short flags, long flags,",
                "and key=value options where implemented.",
                "",
                "Use `help <command>` for command-specific usage.",
                "Use `commands` to display the command index."
            ],
            {
                title:
                    "Command Syntax",
                category:
                    "terminal",
                aliases: [
                    "command-syntax"
                ],
                keywords: [
                    "arguments",
                    "flags",
                    "options",
                    "quotes"
                ],
                order: 10
            }
        );

        service.register(
            "taxonomy",
            [
                "Use species, genera, families, ranks, or taxonomy commands.",
                "Taxonomic data can be rendered as tables, trees, graphs,",
                "charts, grids, matrices, and specialized visualizations."
            ],
            {
                category: "data",
                keywords: [
                    "species",
                    "genera",
                    "families",
                    "ranks"
                ],
                order: 20
            }
        );

        service.register(
            "providers",
            [
                "Use providers and provider-* commands to inspect configured",
                "data providers, health, latency, overlap, statistics,",
                "documentation, errors, and assertions."
            ],
            {
                category: "data",
                keywords: [
                    "provider",
                    "health",
                    "latency",
                    "statistics"
                ],
                order: 30
            }
        );

        service.register(
            "archive",
            [
                "Use archive, volumes, manifests, releases, checksums,",
                "source assertions, synonyms, and conflict commands to inspect",
                "the Speciedex archival data model."
            ],
            {
                category: "data",
                keywords: [
                    "volumes",
                    "manifests",
                    "releases",
                    "checksums"
                ],
                order: 40
            }
        );

        service.register(
            "visualizations",
            [
                "Visualization commands include chart, graph, grid, heatmap,",
                "matrix, map, timeline, tree, globe, constellation,",
                "forcegraph, radial, sankey, streamgraph, wordcloud, and more.",
                "",
                "Use `help <command>` for command-specific syntax."
            ],
            {
                category:
                    "visualization",
                aliases: [
                    "visualization",
                    "viz"
                ],
                order: 50
            }
        );

        service.register(
            "shortcuts",
            [
                "Up/Down: navigate command history",
                "Tab: command completion where supported",
                "Ctrl+L: clear terminal output",
                "Escape: close menus and dialogs",
                "Enter: execute the current command"
            ],
            {
                category:
                    "terminal",
                aliases: [
                    "keys",
                    "keyboard"
                ],
                order: 60
            }
        );
    }

    function initialize(
        context
    ) {
        const root =
            context.root;

        const existing =
            context.help instanceof
                HelpService
                ? context.help
                : context.services?.get?.(
                    "help"
                ) ||
                root?.[
                    HELP_SYMBOL
                ];

        if (
            existing instanceof
                HelpService &&
            !existing.destroyed
        ) {
            context.help =
                existing;

            context.registerService?.(
                "help",
                existing
            );

            existing.refreshCommands();

            return existing;
        }

        const dataset =
            root?.
                dataset ||
            {};

        const service =
            new HelpService(
                context,
                {
                    maxTopics:
                        dataset.terminalHelpMaxTopics,

                    maxImportTopics:
                        dataset.terminalHelpMaxImportTopics,

                    maxSearchResults:
                        dataset.terminalHelpMaxSearchResults
                }
            );

        registerDefaultTopics(
            service
        );

        root[
            HELP_SYMBOL
        ] =
            service;

        context.help =
            service;

        context.registerService?.(
            "help",
            service
        );

        dispatch(
            document,
            "speciedex:terminal-help-ready",
            {
                context,
                help:
                    service,
                version:
                    VERSION
            }
        );

        return service;
    }

    function requireHelp(context) {
        if (
            !(
                context?.help instanceof
                HelpService
            )
        ) {
            throw new Error(
                "Terminal help service is unavailable."
            );
        }

        return context.help;
    }

    function writeText(
        write,
        text,
        type = "output"
    ) {
        if (typeof write === "function") {
            return write(
                text,
                type,
                {
                    preformatted: true
                }
            );
        }

        return text;
    }

    function writeJSONValue(
        writeJSON,
        value
    ) {
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
            name: "help",
            aliases: [
                "?",
                "man"
            ],
            category: "help",
            description:
                "Display command help or a named help topic.",
            usage:
                "help [command|topic]",
            handler: ({
                args = [],
                context,
                write
            }) => {
                const service =
                    requireHelp(context);

                const name =
                    args.join(
                        " "
                    );

                if (!name) {
                    return service.show(
                        null,
                        {
                            write
                        }
                    );
                }

                const commandHelp =
                    service.commandHelp(
                        name
                    );

                if (commandHelp) {
                    return writeText(
                        write,
                        commandHelp
                    );
                }

                const topic =
                    service.get(name);

                if (topic) {
                    return writeText(
                        write,
                        formatTopic(topic)
                    );
                }

                const matches =
                    service.search(name);

                if (matches.length) {
                    return writeText(
                        write,
                        [
                            `No exact help entry for "${name}".`,
                            "",
                            "Possible matches:",
                            ...matches
                                .slice(0, 10)
                                .map(topic =>
                                    `  ${topic.name.padEnd(24)} ${topic.title}`
                                )
                        ].join("\n"),
                        "warning"
                    );
                }

                throw new Error(
                    `Unknown help topic or command: ${name}`
                );
            }
        },
        {
            name: "topic",
            aliases: [
                "help-topic"
            ],
            category: "help",
            description:
                "Display a named help topic.",
            usage:
                "topic <name>",
            handler: ({
                args = [],
                context,
                write
            }) => {
                const service =
                    requireHelp(context);

                const name =
                    args.join(
                        " "
                    );

                if (!name) {
                    return writeText(
                        write,
                        service
                            .list()
                            .map(topic =>
                                `${topic.name.padEnd(24)} ${topic.title}`
                            )
                            .join("\n")
                    );
                }

                const topic =
                    service.get(name);

                if (!topic) {
                    throw new Error(
                        `Unknown help topic: ${name}`
                    );
                }

                return writeText(
                    write,
                    formatTopic(topic)
                );
            }
        },
        {
            name: "topics",
            aliases: [
                "help-topics"
            ],
            category: "help",
            description:
                "List or search help topics.",
            usage:
                "topics [search terms]",
            handler: ({
                args = [],
                context,
                write
            }) => {
                const service =
                    requireHelp(context);

                const topics =
                    args.length
                        ? service.search(
                            args.join(" ")
                        )
                        : service.list();

                return writeText(
                    write,
                    topics.length
                        ? topics
                            .map(topic =>
                                `${topic.name.padEnd(24)} ${topic.title}`
                            )
                            .join("\n")
                        : "No help topics matched."
                );
            }
        },
        {
            name: "commands",
            aliases: [
                "command-list"
            ],
            category: "help",
            description:
                "Display the terminal command index.",
            usage:
                "commands [category]",
            handler: ({
                args = [],
                context,
                write
            }) => {
                const service =
                    requireHelp(context);

                return writeText(
                    write,
                    service.commandIndex(
                        args[0] || null
                    )
                );
            }
        },
        {
            name:
                "help-refresh",

            category:
                "help",

            description:
                "Refresh command discovery for the help system.",

            usage:
                "help-refresh",

            handler: ({
                context,
                writeJSON
            }) => {
                const service =
                    requireHelp(
                        context
                    );

                return writeJSONValue(
                    writeJSON,
                    {
                        commands:
                            service.refreshCommands().
                                length,
                        status:
                            service.status()
                    }
                );
            }
        },

        {
            name:
                "help-export",

            category:
                "help",

            description:
                "Export all help topics as JSON.",

            usage:
                "help-export [filename]",

            handler: ({
                args = [],
                context,
                write
            }) => {
                const service =
                    requireHelp(
                        context
                    );

                const filename =
                    args[0] ||
                    "speciedex-terminal-help.json";

                const payload =
                    JSON.stringify(
                        service.export(),
                        null,
                        2
                    );

                const blob =
                    new Blob(
                        [
                            payload
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

                anchor.href =
                    url;

                anchor.download =
                    filename;

                anchor.click();

                window.setTimeout(
                    () =>
                        URL.revokeObjectURL(
                            url
                        ),
                    1000
                );

                return writeText(
                    write,
                    `Help topics exported to ${filename}.`,
                    "success"
                );
            }
        },

        {
            name:
                "help-import",

            category:
                "help",

            description:
                "Import help topics from JSON.",

            usage:
                "help-import <json> [--replace]",

            handler: ({
                args = [],
                context,
                writeJSON
            }) => {
                if (
                    !args.length
                ) {
                    throw new Error(
                        "Help import JSON is required."
                    );
                }

                const replace =
                    args.includes(
                        "--replace"
                    );

                const payload =
                    args
                        .filter(
                            argument =>
                                argument !==
                                "--replace"
                        )
                        .join(
                            " "
                        );

                const service =
                    requireHelp(
                        context
                    );

                return writeJSONValue(
                    writeJSON,
                    {
                        imported:
                            service.import(
                                payload,
                                {
                                    replace
                                }
                            ).length,
                        status:
                            service.status()
                    }
                );
            }
        },

        {
            name: "help-status",
            category: "help",
            description:
                "Show help-service status.",
            usage:
                "help-status",
            handler: ({
                context,
                writeJSON
            }) =>
                writeJSONValue(
                    writeJSON,
                    requireHelp(
                        context
                    ).status()
                )
        }
    ];

    const api = Object.freeze({
        name: MODULE_NAME,
        version:
            VERSION,
        HELP_SYMBOL,
        HelpService,
        clone,
        normalizeName,
        normalizeAliases,
        normalizeContent,
        normalizeTopic,
        formatTopic,
        resolveCommandRegistry,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalHelp =
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
