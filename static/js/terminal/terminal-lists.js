/*
========================================================================
Speciedex.org
Terminal Lists Renderer
========================================================================

Structured list renderer for SpeciedexTerminal.

Provides:

    • unordered lists
    • ordered lists
    • definition lists
    • nested records and collections
    • configurable label and value fields
    • badges and metadata
    • empty states
    • pagination
    • keyboard-focusable items
    • list updates
    • text and JSON export
    • terminal commands

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME =
        "Lists";

    const VERSION =
        "2.0.0";

    const DEFAULT_OPTIONS =
        Object.freeze({
            type:
                "unordered",

            page:
                1,

            pageSize:
                50,

            start:
                1,

            labelField:
                "name",

            valueField:
                null,

            descriptionField:
                "description",

            badgeField:
                null,

            metadataFields:
                [],

            emptyMessage:
                "No records are available.",

            interactive:
                true,

            nested:
                true,

            maximumDepth:
                4
        });

    const LIST_TYPES =
        Object.freeze([
            "unordered",
            "ordered",
            "definition"
        ]);

    /*
    ==========================================================================
    Utilities
    ==========================================================================
    */

    function normalizeType(value) {
        const type =
            String(
                value ?? ""
            )
                .trim()
                .toLowerCase();

        return LIST_TYPES.includes(
            type
        )
            ? type
            : "unordered";
    }

    function clampInteger(
        value,
        fallback,
        minimum,
        maximum
    ) {
        const parsed =
            Number.parseInt(
                value,
                10
            );

        if (!Number.isFinite(parsed)) {
            return fallback;
        }

        return Math.min(
            maximum,
            Math.max(
                minimum,
                parsed
            )
        );
    }

    function normalizeArray(value) {
        if (Array.isArray(value)) {
            return value;
        }

        if (
            value === null ||
            value === undefined
        ) {
            return [];
        }

        if (
            value &&
            typeof value ===
            "object"
        ) {
            return Object.entries(value).map(
                (
                    [
                        key,
                        item
                    ]
                ) => ({
                    key,
                    value:
                        item
                })
            );
        }

        return [
            value
        ];
    }

    function normalizeText(value) {
        if (
            value === null ||
            value === undefined
        ) {
            return "";
        }

        if (
            typeof value ===
            "string"
        ) {
            return value;
        }

        if (
            typeof value ===
            "number" ||
            typeof value ===
            "boolean" ||
            typeof value ===
            "bigint"
        ) {
            return String(value);
        }

        try {
            return JSON.stringify(
                value
            );
        } catch (error) {
            return String(value);
        }
    }

    function getPath(
        record,
        path
    ) {
        if (
            !path ||
            !record ||
            typeof record !==
            "object"
        ) {
            return undefined;
        }

        return String(path)
            .split(".")
            .reduce(
                (
                    current,
                    key
                ) =>
                    current ===
                        null ||
                    current ===
                        undefined
                        ? undefined
                        : current[
                            key
                        ],
                record
            );
    }

    function resolveLabel(
        record,
        options,
        index
    ) {
        if (
            record &&
            typeof record ===
            "object"
        ) {
            const candidates = [
                options.labelField,
                "label",
                "name",
                "scientific_name",
                "scientificName",
                "common_name",
                "commonName",
                "title",
                "key",
                "id"
            ];

            for (const field of candidates) {
                if (!field) {
                    continue;
                }

                const value =
                    getPath(
                        record,
                        field
                    );

                if (
                    value !==
                        undefined &&
                    value !==
                        null &&
                    String(value).trim()
                ) {
                    return normalizeText(
                        value
                    );
                }
            }
        }

        if (
            typeof record ===
            "string" ||
            typeof record ===
            "number" ||
            typeof record ===
            "boolean"
        ) {
            return normalizeText(
                record
            );
        }

        return `Item ${index + 1}`;
    }

    function resolveValue(
        record,
        options
    ) {
        if (
            options.valueField &&
            record &&
            typeof record ===
            "object"
        ) {
            return getPath(
                record,
                options.valueField
            );
        }

        if (
            record &&
            typeof record ===
            "object" &&
            "value" in record
        ) {
            return record.value;
        }

        return record;
    }

    function parseFields(value) {
        if (Array.isArray(value)) {
            return value
                .map(
                    String
                )
                .map(
                    field =>
                        field.trim()
                )
                .filter(Boolean);
        }

        if (!value) {
            return [];
        }

        return String(value)
            .split(",")
            .map(
                field =>
                    field.trim()
            )
            .filter(Boolean);
    }

    /*
    ==========================================================================
    List Controller
    ==========================================================================
    */

    class ListController
        extends EventTarget {
        constructor(
            container,
            data = [],
            options = {}
        ) {
            super();

            if (
                !(container instanceof Element)
            ) {
                throw new TypeError(
                    "ListController requires a container Element."
                );
            }

            this.container =
                container;

            this.options = {
                ...DEFAULT_OPTIONS,
                ...options,
                type:
                    normalizeType(
                        options.type ||
                        DEFAULT_OPTIONS.type
                    ),
                page:
                    clampInteger(
                        options.page,
                        DEFAULT_OPTIONS.page,
                        1,
                        Number.MAX_SAFE_INTEGER
                    ),
                pageSize:
                    clampInteger(
                        options.pageSize,
                        DEFAULT_OPTIONS.pageSize,
                        1,
                        1000
                    ),
                start:
                    clampInteger(
                        options.start,
                        DEFAULT_OPTIONS.start,
                        1,
                        Number.MAX_SAFE_INTEGER
                    ),
                metadataFields:
                    parseFields(
                        options.metadataFields
                    )
            };

            this.data =
                normalizeArray(
                    data
                );

            this.destroyed =
                false;

            this.render();
        }

        /*
        ======================================================================
        Paging
        ======================================================================
        */

        get total() {
            return this.data.length;
        }

        get pageCount() {
            return Math.max(
                1,
                Math.ceil(
                    this.total /
                    this.options.pageSize
                )
            );
        }

        get offset() {
            return (
                this.options.page -
                1
            ) *
            this.options.pageSize;
        }

        page(
            page
        ) {
            this.options.page =
                clampInteger(
                    page,
                    1,
                    1,
                    this.pageCount
                );

            this.render();

            return this.options.page;
        }

        nextPage() {
            return this.page(
                this.options.page +
                1
            );
        }

        previousPage() {
            return this.page(
                this.options.page -
                1
            );
        }

        /*
        ======================================================================
        Rendering
        ======================================================================
        */

        createListElement() {
            if (
                this.options.type ===
                "ordered"
            ) {
                const list =
                    document.createElement(
                        "ol"
                    );

                list.start =
                    this.options.start +
                    this.offset;

                return list;
            }

            if (
                this.options.type ===
                "definition"
            ) {
                return document.createElement(
                    "dl"
                );
            }

            return document.createElement(
                "ul"
            );
        }

        createMetadata(
            record
        ) {
            if (
                !record ||
                typeof record !==
                "object" ||
                !this.options.metadataFields.length
            ) {
                return null;
            }

            const metadata =
                document.createElement(
                    "span"
                );

            metadata.className =
                "terminal-list-metadata";

            let count =
                0;

            for (
                const field of
                this.options.metadataFields
            ) {
                const value =
                    getPath(
                        record,
                        field
                    );

                if (
                    value ===
                        undefined ||
                    value ===
                        null ||
                    value ===
                        ""
                ) {
                    continue;
                }

                const item =
                    document.createElement(
                        "span"
                    );

                item.className =
                    "terminal-list-metadata-item";

                item.dataset.field =
                    field;

                item.textContent =
                    `${field}: ${normalizeText(value)}`;

                metadata.appendChild(
                    item
                );

                count +=
                    1;
            }

            return count
                ? metadata
                : null;
        }

        createBadge(
            record
        ) {
            if (
                !this.options.badgeField ||
                !record ||
                typeof record !==
                "object"
            ) {
                return null;
            }

            const value =
                getPath(
                    record,
                    this.options.badgeField
                );

            if (
                value ===
                    undefined ||
                value ===
                    null ||
                value ===
                    ""
            ) {
                return null;
            }

            const badge =
                document.createElement(
                    "span"
                );

            badge.className =
                "terminal-list-badge";

            badge.textContent =
                normalizeText(
                    value
                );

            badge.dataset.value =
                normalizeText(
                    value
                );

            return badge;
        }

        createNestedList(
            value,
            depth
        ) {
            if (
                !this.options.nested ||
                depth >=
                    this.options.maximumDepth
            ) {
                return null;
            }

            if (
                !Array.isArray(value) &&
                !(
                    value &&
                    typeof value ===
                    "object"
                )
            ) {
                return null;
            }

            const nested =
                document.createElement(
                    "div"
                );

            nested.className =
                "terminal-list-nested";

            const controller =
                new ListController(
                    nested,
                    normalizeArray(
                        value
                    ),
                    {
                        ...this.options,
                        page:
                            1,
                        pageSize:
                            Math.max(
                                1,
                                normalizeArray(
                                    value
                                ).length
                            ),
                        type:
                            "unordered",
                        maximumDepth:
                            this.options.maximumDepth -
                            depth
                    }
                );

            nested.controller =
                controller;

            return nested;
        }

        createListItem(
            record,
            index,
            depth = 0
        ) {
            const item =
                document.createElement(
                    "li"
                );

            item.className =
                "terminal-list-item";

            item.dataset.index =
                String(
                    index
                );

            if (
                this.options.interactive
            ) {
                item.tabIndex =
                    0;
            }

            const header =
                document.createElement(
                    "div"
                );

            header.className =
                "terminal-list-item-header";

            const label =
                document.createElement(
                    "span"
                );

            label.className =
                "terminal-list-label";

            label.textContent =
                resolveLabel(
                    record,
                    this.options,
                    index
                );

            header.appendChild(
                label
            );

            const badge =
                this.createBadge(
                    record
                );

            if (badge) {
                header.appendChild(
                    badge
                );
            }

            item.appendChild(
                header
            );

            if (
                record &&
                typeof record ===
                    "object"
            ) {
                const description =
                    getPath(
                        record,
                        this.options.descriptionField
                    );

                if (
                    description !==
                        undefined &&
                    description !==
                        null &&
                    description !==
                        ""
                ) {
                    const paragraph =
                        document.createElement(
                            "p"
                        );

                    paragraph.className =
                        "terminal-list-description";

                    paragraph.textContent =
                        normalizeText(
                            description
                        );

                    item.appendChild(
                        paragraph
                    );
                }
            }

            const metadata =
                this.createMetadata(
                    record
                );

            if (metadata) {
                item.appendChild(
                    metadata
                );
            }

            const value =
                resolveValue(
                    record,
                    this.options
                );

            const nested =
                this.createNestedList(
                    value,
                    depth +
                    1
                );

            if (nested) {
                item.appendChild(
                    nested
                );
            } else if (
                this.options.valueField &&
                value !==
                    undefined &&
                value !==
                    null
            ) {
                const content =
                    document.createElement(
                        "span"
                    );

                content.className =
                    "terminal-list-value";

                content.textContent =
                    normalizeText(
                        value
                    );

                item.appendChild(
                    content
                );
            }

            item.addEventListener(
                "click",
                () => {
                    this.dispatchEvent(
                        new CustomEvent(
                            "select",
                            {
                                detail: {
                                    record,
                                    index
                                }
                            }
                        )
                    );
                }
            );

            item.addEventListener(
                "keydown",
                event => {
                    if (
                        event.key ===
                            "Enter" ||
                        event.key ===
                            " "
                    ) {
                        event.preventDefault();

                        item.click();
                    }
                }
            );

            return item;
        }

        createDefinitionItem(
            record,
            index
        ) {
            const fragment =
                document.createDocumentFragment();

            const term =
                document.createElement(
                    "dt"
                );

            term.className =
                "terminal-list-term";

            term.textContent =
                resolveLabel(
                    record,
                    this.options,
                    index
                );

            const definition =
                document.createElement(
                    "dd"
                );

            definition.className =
                "terminal-list-definition";

            const value =
                resolveValue(
                    record,
                    this.options
                );

            definition.textContent =
                normalizeText(
                    value
                );

            fragment.append(
                term,
                definition
            );

            return fragment;
        }

        createPagination() {
            if (
                this.pageCount <=
                1
            ) {
                return null;
            }

            const navigation =
                document.createElement(
                    "nav"
                );

            navigation.className =
                "terminal-list-pagination";

            navigation.setAttribute(
                "aria-label",
                "List pagination"
            );

            const previous =
                document.createElement(
                    "button"
                );

            previous.type =
                "button";

            previous.textContent =
                "Previous";

            previous.disabled =
                this.options.page <=
                1;

            previous.addEventListener(
                "click",
                () =>
                    this.previousPage()
            );

            const status =
                document.createElement(
                    "span"
                );

            status.className =
                "terminal-list-page-status";

            status.textContent =
                `Page ${this.options.page} of ${this.pageCount}`;

            const next =
                document.createElement(
                    "button"
                );

            next.type =
                "button";

            next.textContent =
                "Next";

            next.disabled =
                this.options.page >=
                this.pageCount;

            next.addEventListener(
                "click",
                () =>
                    this.nextPage()
            );

            navigation.append(
                previous,
                status,
                next
            );

            return navigation;
        }

        render() {
            if (this.destroyed) {
                return;
            }

            this.container.replaceChildren();

            if (
                !this.data.length
            ) {
                const empty =
                    document.createElement(
                        "div"
                    );

                empty.className =
                    "terminal-list-empty";

                empty.textContent =
                    this.options.emptyMessage;

                this.container.appendChild(
                    empty
                );

                return;
            }

            const list =
                this.createListElement();

            list.className =
                `terminal-list terminal-list-${this.options.type}`;

            const pageRecords =
                this.data.slice(
                    this.offset,
                    this.offset +
                    this.options.pageSize
                );

            pageRecords.forEach(
                (
                    record,
                    localIndex
                ) => {
                    const index =
                        this.offset +
                        localIndex;

                    if (
                        this.options.type ===
                        "definition"
                    ) {
                        list.appendChild(
                            this.createDefinitionItem(
                                record,
                                index
                            )
                        );
                    } else {
                        list.appendChild(
                            this.createListItem(
                                record,
                                index
                            )
                        );
                    }
                }
            );

            this.container.appendChild(
                list
            );

            const pagination =
                this.createPagination();

            if (pagination) {
                this.container.appendChild(
                    pagination
                );
            }

            this.dispatchEvent(
                new CustomEvent(
                    "render",
                    {
                        detail: {
                            total:
                                this.total,
                            page:
                                this.options.page,
                            pageCount:
                                this.pageCount
                        }
                    }
                )
            );
        }

        /*
        ======================================================================
        Updates and Export
        ======================================================================
        */

        update(
            data = this.data,
            options = {}
        ) {
            this.data =
                normalizeArray(
                    data
                );

            this.options = {
                ...this.options,
                ...options,
                type:
                    normalizeType(
                        options.type ||
                        this.options.type
                    ),
                metadataFields:
                    options.metadataFields !==
                    undefined
                        ? parseFields(
                            options.metadataFields
                        )
                        : this.options.metadataFields
            };

            this.options.page =
                clampInteger(
                    this.options.page,
                    1,
                    1,
                    this.pageCount
                );

            this.render();

            return this;
        }

        toText() {
            return this.data
                .map(
                    (
                        record,
                        index
                    ) =>
                        `${index + 1}. ${resolveLabel(
                            record,
                            this.options,
                            index
                        )}`
                )
                .join("\n");
        }

        export(
            format =
                "json"
        ) {
            const normalized =
                String(
                    format ?? "json"
                )
                    .trim()
                    .toLowerCase();

            if (
                normalized ===
                "text" ||
                normalized ===
                "txt"
            ) {
                return {
                    format:
                        "text",
                    mime:
                        "text/plain",
                    extension:
                        "txt",
                    content:
                        this.toText()
                };
            }

            return {
                format:
                    "json",
                mime:
                    "application/json",
                extension:
                    "json",
                content:
                    JSON.stringify(
                        {
                            version:
                                VERSION,
                            generatedAt:
                                new Date().toISOString(),
                            options:
                                this.options,
                            records:
                                this.data
                        },
                        null,
                        2
                    )
            };
        }

        status() {
            return {
                version:
                    VERSION,
                type:
                    this.options.type,
                total:
                    this.total,
                page:
                    this.options.page,
                pageSize:
                    this.options.pageSize,
                pageCount:
                    this.pageCount,
                interactive:
                    this.options.interactive,
                nested:
                    this.options.nested
            };
        }

        destroy() {
            if (this.destroyed) {
                return;
            }

            for (
                const nested of
                this.container.querySelectorAll(
                    ".terminal-list-nested"
                )
            ) {
                nested.controller?.
                    destroy?.();
            }

            this.container.replaceChildren();

            this.destroyed =
                true;

            this.dispatchEvent(
                new CustomEvent(
                    "destroy"
                )
            );
        }
    }

    /*
    ==========================================================================
    Renderer
    ==========================================================================
    */

    function mount(
        target,
        data = [],
        options = {}
    ) {
        const container =
            target instanceof
            Element
                ? target
                : document.createElement(
                    "div"
                );

        return new ListController(
            container,
            data,
            options
        );
    }

    function render(
        data,
        options = {}
    ) {
        const container =
            document.createElement(
                "section"
            );

        container.className =
            "terminal-renderer terminal-renderer-list";

        container.dataset.renderer =
            "list";

        if (options.title) {
            const heading =
                document.createElement(
                    "h3"
                );

            heading.className =
                "terminal-renderer-title";

            heading.textContent =
                options.title;

            container.appendChild(
                heading
            );
        }

        const body =
            document.createElement(
                "div"
            );

        body.className =
            "terminal-list-container";

        container.appendChild(
            body
        );

        const controller =
            new ListController(
                body,
                data,
                options
            );

        container.controller =
            controller;

        container.update =
            (
                nextData,
                nextOptions
            ) =>
                controller.update(
                    nextData,
                    nextOptions
                );

        container.destroy =
            () =>
                controller.destroy();

        return container;
    }

    /*
    ==========================================================================
    Initialization
    ==========================================================================
    */

    function initialize(
        context
    ) {
        if (
            context.listRenderer?.
                Controller ===
            ListController
        ) {
            return context.listRenderer;
        }

        const renderer = {
            render,
            mount,
            Controller:
                ListController,
            types:
                LIST_TYPES
        };

        context.registerRenderer?.(
            "list",
            renderer
        );

        context.registerRenderer?.(
            "lists",
            renderer
        );

        context.listRenderer =
            renderer;

        context.lists =
            renderer;

        return renderer;
    }

    /*
    ==========================================================================
    Commands
    ==========================================================================
    */

    const commands =
        [
            {
                name:
                    "list",

                aliases:
                    [
                        "lists"
                    ],

                category:
                    "visualization",

                description:
                    "Render a library collection as a structured list.",

                usage:
                    "list [collection] [--type unordered|ordered|definition] [--limit N]",

                handler: ({
                    args,
                    parsed,
                    context
                }) => {
                    const collection =
                        args[0] ||
                        "records";

                    const records =
                        context.library?.get?.(
                            collection
                        ) ||
                        [];

                    const limit =
                        clampInteger(
                            parsed.options.limit,
                            records.length ||
                            DEFAULT_OPTIONS.pageSize,
                            1,
                            1000
                        );

                    return render(
                        records.slice(
                            0,
                            limit
                        ),
                        {
                            title:
                                `List: ${collection}`,
                            type:
                                parsed.options.type ||
                                (
                                    parsed.flags.ordered
                                        ? "ordered"
                                        : parsed.flags.definition
                                            ? "definition"
                                            : "unordered"
                                ),
                            pageSize:
                                clampInteger(
                                    parsed.options.pageSize ||
                                    parsed.options["page-size"],
                                    DEFAULT_OPTIONS.pageSize,
                                    1,
                                    1000
                                ),
                            labelField:
                                parsed.options.label ||
                                DEFAULT_OPTIONS.labelField,
                            valueField:
                                parsed.options.value ||
                                null,
                            badgeField:
                                parsed.options.badge ||
                                null,
                            metadataFields:
                                parseFields(
                                    parsed.options.metadata
                                )
                        }
                    );
                }
            },

            {
                name:
                    "list-status",

                category:
                    "visualization",

                description:
                    "Display list-renderer availability and active state.",

                usage:
                    "list-status",

                handler: ({
                    context,
                    writeJSON
                }) => {
                    const active =
                        context.root?.
                            querySelector?.(
                                ".terminal-renderer-list"
                            )?.
                            controller ||
                        null;

                    return writeJSON({
                        version:
                            VERSION,
                        available:
                            true,
                        types:
                            LIST_TYPES,
                        active:
                            Boolean(
                                active
                            ),
                        status:
                            active?.
                                status?.() ||
                            null
                    });
                }
            },

            {
                name:
                    "list-export",

                category:
                    "visualization",

                description:
                    "Export the active list renderer.",

                usage:
                    "list-export [json|text] [filename]",

                handler: ({
                    args,
                    context,
                    write
                }) => {
                    const active =
                        context.root?.
                            querySelector?.(
                                ".terminal-renderer-list"
                            )?.
                            controller ||
                        null;

                    if (!active) {
                        throw new Error(
                            "No active list renderer is available."
                        );
                    }

                    const format =
                        args[0] ||
                        "json";

                    const exported =
                        active.export(
                            format
                        );

                    const filename =
                        args[1] ||
                        `speciedex-list.${exported.extension}`;

                    const blob =
                        new Blob(
                            [
                                exported.content
                            ],
                            {
                                type:
                                    exported.mime
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

                    return write(
                        `List exported to ${filename}.`,
                        "success"
                    );
                }
            }
        ];

    /*
    ==========================================================================
    Public Module API
    ==========================================================================
    */

    const api =
        Object.freeze({
            name:
                MODULE_NAME,

            version:
                VERSION,

            LIST_TYPES,
            DEFAULT_OPTIONS,
            ListController,

            normalizeType,
            normalizeArray,
            normalizeText,
            getPath,
            resolveLabel,
            resolveValue,
            parseFields,

            render,
            mount,

            initialize,
            init:
                initialize,
            setup:
                initialize,

            commands
        });

    window.SpeciedexTerminalLists =
        api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules ||
        {};

    window.SpeciedexTerminalModules[
        MODULE_NAME
    ] = api;

    document.dispatchEvent(
        new CustomEvent(
            "speciedex:terminal-module-available",
            {
                detail: {
                    name:
                        MODULE_NAME,

                    module:
                        api
                }
            }
        )
    );
})(window, document);
