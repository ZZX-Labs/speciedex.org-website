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
    const VERSION = "2.0.0";

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

    function normalizeName(value) {
        return String(value ?? "")
            .trim()
            .toLowerCase()
            .replace(/\s+/g, "-");
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
                typeof options.metadata === "object"
                    ? { ...options.metadata }
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

    function resolveCommandRegistry(context) {
        const candidates = [
            context?.commands,
            context?.commandRegistry,
            context?.router?.commands,
            context?.console?.commands
        ];

        for (const candidate of candidates) {
            if (candidate instanceof Map) {
                return candidate;
            }

            if (Array.isArray(candidate)) {
                return new Map(
                    candidate
                        .filter(Boolean)
                        .map(command => [
                            normalizeName(
                                command.name
                            ),
                            command
                        ])
                );
            }

            if (
                candidate &&
                typeof candidate === "object"
            ) {
                return new Map(
                    Object.entries(candidate)
                );
            }
        }

        return new Map();
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
        constructor(context) {
            super();

            this.context = context;
            this.topics = new Map();
            this.aliases = new Map();
            this.destroyed = false;
        }

        ensureAvailable() {
            if (this.destroyed) {
                throw new Error(
                    "Help service has been destroyed."
                );
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

            if (existing) {
                for (
                    const alias of
                    existing.aliases
                ) {
                    this.aliases.delete(alias);
                }
            }

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

            const detail = {
                topic: normalized
            };

            dispatch(
                this,
                "register",
                detail
            );

            this.context.events?.emit?.(
                "help:register",
                detail
            );

            return normalized;
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

            dispatch(
                this,
                "unregister",
                {
                    topic
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

            return (
                this.topics.get(
                    canonical
                ) || null
            );
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
                );
        }

        getCommands() {
            const registry =
                resolveCommandRegistry(
                    this.context
                );

            return [
                ...registry.entries()
            ]
                .map(([name, command]) =>
                    normalizeCommand(
                        command,
                        name
                    )
                )
                .filter(Boolean)
                .sort((left, right) =>
                    left.category.localeCompare(
                        right.category
                    ) ||
                    left.name.localeCompare(
                        right.name
                    )
                );
        }

        findCommand(name) {
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
                options.replace === true
            ) {
                this.clear();
            }

            return this.registerMany(
                topics
            );
        }

        clear() {
            const count =
                this.topics.size;

            this.topics.clear();
            this.aliases.clear();

            dispatch(
                this,
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
                destroyed:
                    this.destroyed
            };
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            this.clear();
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

    function initialize(context) {
        if (
            context.help instanceof
            HelpService &&
            !context.help.destroyed
        ) {
            return context.help;
        }

        const service =
            new HelpService(context);

        registerDefaultTopics(
            service
        );

        context.help = service;

        context.registerService?.(
            "help",
            service
        );

        dispatch(
            document,
            "speciedex:terminal-help-ready",
            {
                context,
                help: service
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
                    args[0];

                if (!name) {
                    return writeText(
                        write,
                        [
                            "SpeciedexTerminal Help",
                            "======================",
                            "",
                            "Use `commands` to list available commands.",
                            "Use `help <command>` for command usage.",
                            "Use `topics` to list help topics.",
                            "Use `topic <name>` to display a topic."
                        ].join("\n")
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
                    args[0];

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
        version: VERSION,
        HelpService,
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
