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
        "2.2.0";

    const REGISTRY_SYMBOL =
        Symbol.for(
            "speciedex.terminal.lists.registry"
        );

    const CONTROLLER_SYMBOL =
        Symbol.for(
            "speciedex.terminal.lists.controller"
        );

    const RESERVED_KEYS =
        new Set([
            "__proto__",
            "prototype",
            "constructor"
        ]);

    const activeDispatches =
        new WeakMap();

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
                4,

            selectable:
                true,

            multiSelect:
                false,

            wrapNavigation:
                true,

            maximumRecords:
                25000,

            sortField:
                null,

            sortDirection:
                "ascending",

            filter:
                null
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

    function isObject(value) {
        return (
            value !== null &&
            typeof value === "object" &&
            !Array.isArray(value)
        );
    }

    function parseBoolean(value, fallback = false) {
        if (typeof value === "boolean") {
            return value;
        }

        if (
            value === undefined ||
            value === null ||
            value === ""
        ) {
            return fallback;
        }

        const normalized =
            String(value)
                .trim()
                .toLowerCase();

        if (
            ["1", "true", "yes", "on", "enabled"].includes(
                normalized
            )
        ) {
            return true;
        }

        if (
            ["0", "false", "no", "off", "disabled"].includes(
                normalized
            )
        ) {
            return false;
        }

        return fallback;
    }

    function nowISO(value = Date.now()) {
        const date =
            value instanceof Date
                ? value
                : new Date(value);

        return Number.isFinite(date.getTime())
            ? date.toISOString()
            : new Date().toISOString();
    }

    function safeStringify(value, compact = false) {
        const seen =
            new WeakSet();

        return JSON.stringify(
            value,
            (_key, item) => {
                if (
                    item &&
                    typeof item === "object"
                ) {
                    if (seen.has(item)) {
                        return "[Circular]";
                    }

                    seen.add(item);
                }

                if (typeof item === "bigint") {
                    return String(item);
                }

                return item;
            },
            compact ? 0 : 2
        );
    }

    function dispatch(target, name, detail, options = {}) {
        if (
            !target ||
            typeof target.dispatchEvent !== "function" ||
            !name
        ) {
            return false;
        }

        let names =
            activeDispatches.get(target);

        if (!names) {
            names = new Set();
            activeDispatches.set(
                target,
                names
            );
        }

        if (names.has(name)) {
            return false;
        }

        names.add(name);

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
        } finally {
            names.delete(name);
        }
    }

    function isElement(
        value
    ) {
        return Boolean(
            value &&
            value.nodeType ===
                1 &&
            typeof value.querySelector ===
                "function"
        );
    }

    function registry() {
        window[
            REGISTRY_SYMBOL
        ] =
            window[
                REGISTRY_SYMBOL
            ] ||
            new Set();

        return window[
            REGISTRY_SYMBOL
        ];
    }

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

    function normalizeArray(
        value,
        maximumRecords =
            DEFAULT_OPTIONS.maximumRecords
    ) {
        let records;

        if (Array.isArray(value)) {
            records = value;
        } else if (
            Array.isArray(
                value?.records
            )
        ) {
            records = value.records;
        } else if (
            Array.isArray(
                value?.results
            )
        ) {
            records = value.results;
        } else if (
            Array.isArray(
                value?.items
            )
        ) {
            records = value.items;
        } else if (
            value === null ||
            value === undefined
        ) {
            records = [];
        } else if (
            value &&
            typeof value === "object"
        ) {
            records =
                Object.entries(value)
                    .filter(
                        ([key]) =>
                            !RESERVED_KEYS.has(key)
                    )
                    .map(
                        ([key, item]) => ({
                            key,
                            value: item
                        })
                    );
        } else {
            records = [value];
        }

        const limit =
            clampInteger(
                maximumRecords,
                DEFAULT_OPTIONS.maximumRecords,
                1,
                1000000
            );

        return records.slice(
            0,
            limit
        );
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
            return safeStringify(
                value,
                true
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
            typeof record !== "object"
        ) {
            return undefined;
        }

        return String(path)
            .split(".")
            .reduce(
                (current, key) => {
                    if (
                        current === null ||
                        current === undefined ||
                        RESERVED_KEYS.has(key)
                    ) {
                        return undefined;
                    }

                    return current[key];
                },
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

    function compareValues(
        left,
        right,
        direction =
            "ascending"
    ) {
        const multiplier =
            String(
                direction
            ).toLowerCase() ===
                "descending"
                ? -1
                : 1;

        const leftNumber =
            Number(
                left
            );

        const rightNumber =
            Number(
                right
            );

        if (
            Number.isFinite(
                leftNumber
            ) &&
            Number.isFinite(
                rightNumber
            )
        ) {
            return (
                leftNumber -
                rightNumber
            ) *
            multiplier;
        }

        return normalizeText(
            left
        ).localeCompare(
            normalizeText(
                right
            ),
            undefined,
            {
                numeric:
                    true,
                sensitivity:
                    "base"
            }
        ) *
        multiplier;
    }

    function recordMatches(
        record,
        query
    ) {
        const needle =
            normalizeText(
                query
            )
                .trim()
                .toLowerCase();

        if (!needle) {
            return true;
        }

        return normalizeText(
            record
        )
            .toLowerCase()
            .includes(
                needle
            );
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
                !isElement(
                    container
                )
            ) {
                throw new TypeError(
                    "ListController requires a container Element."
                );
            }

            const existing =
                container[
                    CONTROLLER_SYMBOL
                ];

            if (
                existing instanceof
                    ListController &&
                !existing.destroyed
            ) {
                existing.update(
                    data,
                    options
                );

                return existing;
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
                    ),

                selectable:
                    parseBoolean(
                        options.selectable,
                        DEFAULT_OPTIONS.selectable
                    ),

                multiSelect:
                    parseBoolean(
                        options.multiSelect,
                        DEFAULT_OPTIONS.multiSelect
                    ),

                wrapNavigation:
                    parseBoolean(
                        options.wrapNavigation,
                        DEFAULT_OPTIONS.wrapNavigation
                    ),

                maximumRecords:
                    clampInteger(
                        options.maximumRecords,
                        DEFAULT_OPTIONS.maximumRecords,
                        1,
                        1000000
                    ),

                sortField:
                    options.sortField ||
                    DEFAULT_OPTIONS.sortField,

                sortDirection:
                    String(
                        options.sortDirection ||
                        DEFAULT_OPTIONS.sortDirection
                    ).toLowerCase() ===
                        "descending"
                        ? "descending"
                        : "ascending",

                filter:
                    options.filter ??
                    DEFAULT_OPTIONS.filter,

                interactive:
                    parseBoolean(
                        options.interactive,
                        DEFAULT_OPTIONS.interactive
                    ),

                nested:
                    parseBoolean(
                        options.nested,
                        DEFAULT_OPTIONS.nested
                    ),

                maximumDepth:
                    clampInteger(
                        options.maximumDepth,
                        DEFAULT_OPTIONS.maximumDepth,
                        0,
                        32
                    )
            };

            this.data =
                normalizeArray(
                    data,
                    this.options.maximumRecords
                );

            this.ready =
                true;

            this.destroyed =
                false;

            this.watchers =
                new Set();

            this.emitting =
                false;

            this.selected =
                new Set();

            this.focusedIndex =
                -1;

            this.nestedControllers =
                new Set();

            this.abortController =
                typeof AbortController ===
                    "function"
                    ? new AbortController()
                    : null;

            this.boundListeners =
                [];

            this.container[
                CONTROLLER_SYMBOL
            ] =
                this;

            registry().add(
                this
            );

            this.render();
        }

        emit(name, detail = {}) {
            if (
                this.destroyed &&
                name !== "destroy"
            ) {
                return false;
            }

            if (this.emitting) {
                return false;
            }

            this.emitting = true;

            try {
                dispatch(
                    this,
                    name,
                    detail
                );

                for (
                    const watcher
                    of Array.from(
                        this.watchers
                    )
                ) {
                    try {
                        watcher(
                            {
                                type: name,
                                timestamp:
                                    nowISO(),
                                detail
                            },
                            this
                        );
                    } catch (_error) {
                        /* Watcher failures are isolated. */
                    }
                }

                return true;
            } finally {
                this.emitting = false;
            }
        }

        watch(callback, options = {}) {
            this.assertActive();

            if (typeof callback !== "function") {
                throw new TypeError(
                    "List watcher must be a function."
                );
            }

            this.watchers.add(callback);

            if (options.immediate === true) {
                callback(
                    {
                        type: "initial",
                        timestamp:
                            nowISO(),
                        status:
                            this.status()
                    },
                    this
                );
            }

            return () =>
                this.watchers.delete(
                    callback
                );
        }

        addManagedListener(
            target,
            name,
            handler,
            options = {}
        ) {
            if (
                !target ||
                typeof target.addEventListener !==
                    "function"
            ) {
                return false;
            }

            const listenerOptions = {
                ...options
            };

            if (this.abortController?.signal) {
                listenerOptions.signal =
                    this.abortController.signal;
            }

            try {
                target.addEventListener(
                    name,
                    handler,
                    listenerOptions
                );

                return true;
            } catch (_error) {
                const capture =
                    options.capture === true;

                target.addEventListener(
                    name,
                    handler,
                    capture
                );

                this.boundListeners.push(
                    () =>
                        target.removeEventListener(
                            name,
                            handler,
                            capture
                        )
                );

                return true;
            }
        }

        assertActive() {
            if (
                this.destroyed
            ) {
                throw new Error(
                    "ListController has been destroyed."
                );
            }
        }

        get viewData() {
            let records =
                [
                    ...this.data
                ];

            if (
                this.options.filter
            ) {
                records =
                    records.filter(
                        record =>
                            typeof this.options.filter ===
                                "function"
                                ? Boolean(
                                    this.options.filter(
                                        record
                                    )
                                )
                                : recordMatches(
                                    record,
                                    this.options.filter
                                )
                    );
            }

            if (
                this.options.sortField
            ) {
                const field =
                    this.options.sortField;

                records.sort(
                    (
                        left,
                        right
                    ) =>
                        compareValues(
                            getPath(
                                left,
                                field
                            ),
                            getPath(
                                right,
                                field
                            ),
                            this.options.sortDirection
                        )
                );
            }

            return records;
        }

        /*
        ======================================================================
        Paging
        ======================================================================
        */

        get total() {
            return this.viewData.length;
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
            this.assertActive();

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
                        value,
                        this.options.maximumRecords
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
                            Math.max(
                                0,
                                this.options.maximumDepth -
                                depth
                            )
                    }
                );

            nested.controller =
                controller;

            this.nestedControllers.add(
                controller
            );

            controller.addEventListener(
                "destroy",
                () => {
                    this.nestedControllers.delete(
                        controller
                    );
                },
                {
                    once:
                        true
                }
            );

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
                    -1;

                item.setAttribute(
                    "role",
                    "option"
                );
            }

            item.setAttribute(
                "aria-selected",
                String(
                    this.selected.has(
                        index
                    )
                )
            );

            item.classList.toggle(
                "is-selected",
                this.selected.has(
                    index
                )
            );

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

            this.addManagedListener(
                item,
                "click",
                event => {
                    this.select(
                        index,
                        {
                            additive:
                                this.options.multiSelect &&
                                (
                                    event.ctrlKey ||
                                    event.metaKey
                                ),
                            range:
                                this.options.multiSelect &&
                                event.shiftKey
                        }
                    );
                }
            );

            this.addManagedListener(
                item,
                "keydown",
                event => {
                    if (
                        event.key ===
                            "Enter" ||
                        event.key ===
                            " "
                    ) {
                        event.preventDefault();

                        this.select(
                            index,
                            {
                                additive:
                                    this.options.multiSelect &&
                                    (
                                        event.ctrlKey ||
                                        event.metaKey
                                    ),
                                range:
                                    this.options.multiSelect &&
                                    event.shiftKey
                            }
                        );

                        return;
                    }

                    if (
                        event.key ===
                            "ArrowDown" ||
                        event.key ===
                            "ArrowRight"
                    ) {
                        event.preventDefault();

                        this.focusItem(
                            index +
                            1
                        );

                        return;
                    }

                    if (
                        event.key ===
                            "ArrowUp" ||
                        event.key ===
                            "ArrowLeft"
                    ) {
                        event.preventDefault();

                        this.focusItem(
                            index -
                            1
                        );

                        return;
                    }

                    if (
                        event.key ===
                            "Home"
                    ) {
                        event.preventDefault();

                        this.focusItem(
                            this.offset
                        );

                        return;
                    }

                    if (
                        event.key ===
                            "End"
                    ) {
                        event.preventDefault();

                        this.focusItem(
                            Math.min(
                                this.total -
                                1,
                                this.offset +
                                this.options.pageSize -
                                1
                            )
                        );
                    }
                }
            );

            return item;
        }

        select(
            index,
            options = {}
        ) {
            this.assertActive();

            const maximum =
                this.total -
                1;

            if (
                index <
                    0 ||
                index >
                    maximum
            ) {
                return null;
            }

            if (
                !this.options.selectable
            ) {
                return null;
            }

            if (
                this.options.multiSelect &&
                parseBoolean(
                    options.range,
                    false
                ) &&
                this.focusedIndex >=
                    0
            ) {
                const start =
                    Math.min(
                        this.focusedIndex,
                        index
                    );

                const end =
                    Math.max(
                        this.focusedIndex,
                        index
                    );

                if (
                    !options.additive
                ) {
                    this.selected.clear();
                }

                for (
                    let current =
                        start;
                    current <=
                        end;
                    current +=
                        1
                ) {
                    this.selected.add(
                        current
                    );
                }
            } else if (
                this.options.multiSelect &&
                parseBoolean(
                    options.additive,
                    false
                )
            ) {
                if (
                    this.selected.has(
                        index
                    )
                ) {
                    this.selected.delete(
                        index
                    );
                } else {
                    this.selected.add(
                        index
                    );
                }
            } else {
                this.selected.clear();
                this.selected.add(
                    index
                );
            }

            this.focusedIndex =
                index;

            this.syncSelectionState();

            const record =
                this.viewData[
                    index
                ];

            const detail = {
                record,
                index,
                selected:
                    [
                        ...this.selected
                    ],
                records:
                    [
                        ...this.selected
                    ].map(
                        selectedIndex =>
                            this.viewData[
                                selectedIndex
                            ]
                    )
            };

            this.emit(
                "select",
                detail
            );

            return detail;
        }

        clearSelection() {
            const count =
                this.selected.size;

            this.selected.clear();
            this.syncSelectionState();

            return count;
        }

        syncSelectionState() {
            for (
                const item of
                this.container.querySelectorAll(
                    "[data-index]"
                )
            ) {
                const index =
                    Number(
                        item.dataset.index
                    );

                const selected =
                    this.selected.has(
                        index
                    );

                item.classList.toggle(
                    "is-selected",
                    selected
                );

                item.setAttribute(
                    "aria-selected",
                    String(
                        selected
                    )
                );

                item.tabIndex =
                    index ===
                        this.focusedIndex ||
                    (
                        this.focusedIndex <
                            0 &&
                        index ===
                            this.offset
                    )
                        ? 0
                        : -1;
            }
        }

        focusItem(
            index
        ) {
            if (!this.total) {
                this.focusedIndex = -1;
                return -1;
            }

            const minimum =
                this.offset;

            const maximum =
                Math.min(
                    this.total -
                    1,
                    this.offset +
                    this.options.pageSize -
                    1
                );

            let next =
                index;

            if (
                next <
                    minimum
            ) {
                next =
                    this.options.wrapNavigation
                        ? maximum
                        : minimum;
            }

            if (
                next >
                    maximum
            ) {
                next =
                    this.options.wrapNavigation
                        ? minimum
                        : maximum;
            }

            this.focusedIndex =
                next;

            this.syncSelectionState();

            const item =
                this.container.querySelector(
                    `[data-index="${next}"]`
                );

            if (item?.focus) {
                try {
                    item.focus({
                        preventScroll: true
                    });
                } catch (_error) {
                    item.focus();
                }
            }

            return next;
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

            this.addManagedListener(
                previous,
                "click",
                () =>
                    this.previousPage(),
                {
                    signal:
                        this.abortController.signal
                }
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

            this.addManagedListener(
                next,
                "click",
                () =>
                    this.nextPage(),
                {
                    signal:
                        this.abortController.signal
                }
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

            const viewData =
                this.viewData;

            this.options.page =
                clampInteger(
                    this.options.page,
                    1,
                    1,
                    Math.max(
                        1,
                        Math.ceil(
                            viewData.length /
                            this.options.pageSize
                        )
                    )
                );

            if (!viewData.length) {
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

            if (
                this.options.interactive
            ) {
                list.setAttribute(
                    "role",
                    "listbox"
                );

                list.setAttribute(
                    "aria-multiselectable",
                    String(
                        this.options.multiSelect
                    )
                );
            }

            list.className =
                `terminal-list terminal-list-${this.options.type}`;

            const pageRecords =
                viewData.slice(
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

            if (
                this.focusedIndex <
                    this.offset ||
                this.focusedIndex >=
                    this.offset +
                    pageRecords.length
            ) {
                this.focusedIndex =
                    pageRecords.length
                        ? this.offset
                        : -1;
            }

            this.syncSelectionState();

            const pagination =
                this.createPagination();

            if (pagination) {
                this.container.appendChild(
                    pagination
                );
            }

            this.emit(
                "render",
                {
                    total:
                        this.total,
                    page:
                        this.options.page,
                    pageCount:
                        this.pageCount
                }
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
            this.assertActive();

            const maximumRecords =
                clampInteger(
                    options.maximumRecords,
                    this.options.maximumRecords,
                    1,
                    1000000
                );

            this.data =
                normalizeArray(
                    data,
                    maximumRecords
                );

            this.options = {
                ...this.options,
                ...options,
                type:
                    normalizeType(
                        options.type ||
                        this.options.type
                    ),
                page:
                    clampInteger(
                        options.page,
                        this.options.page,
                        1,
                        Number.MAX_SAFE_INTEGER
                    ),
                pageSize:
                    clampInteger(
                        options.pageSize,
                        this.options.pageSize,
                        1,
                        1000
                    ),
                start:
                    clampInteger(
                        options.start,
                        this.options.start,
                        1,
                        Number.MAX_SAFE_INTEGER
                    ),
                maximumRecords,
                maximumDepth:
                    clampInteger(
                        options.maximumDepth,
                        this.options.maximumDepth,
                        0,
                        32
                    ),
                metadataFields:
                    options.metadataFields !==
                        undefined
                        ? parseFields(
                            options.metadataFields
                        )
                        : this.options.metadataFields,
                selectable:
                    options.selectable !==
                        undefined
                        ? parseBoolean(
                            options.selectable,
                            this.options.selectable
                        )
                        : this.options.selectable,
                multiSelect:
                    options.multiSelect !==
                        undefined
                        ? parseBoolean(
                            options.multiSelect,
                            this.options.multiSelect
                        )
                        : this.options.multiSelect,
                interactive:
                    options.interactive !==
                        undefined
                        ? parseBoolean(
                            options.interactive,
                            this.options.interactive
                        )
                        : this.options.interactive,
                nested:
                    options.nested !==
                        undefined
                        ? parseBoolean(
                            options.nested,
                            this.options.nested
                        )
                        : this.options.nested,
                wrapNavigation:
                    options.wrapNavigation !==
                        undefined
                        ? parseBoolean(
                            options.wrapNavigation,
                            this.options.wrapNavigation
                        )
                        : this.options.wrapNavigation,
                sortField:
                    options.sortField !==
                        undefined
                        ? options.sortField
                        : this.options.sortField,
                sortDirection:
                    options.sortDirection !==
                        undefined
                        ? String(
                            options.sortDirection
                        ).toLowerCase() ===
                            "descending"
                            ? "descending"
                            : "ascending"
                        : this.options.sortDirection,
                filter:
                    options.filter !==
                        undefined
                        ? options.filter
                        : this.options.filter
            };

            const maximumIndex =
                Math.max(
                    -1,
                    this.viewData.length - 1
                );

            for (
                const selectedIndex
                of Array.from(
                    this.selected
                )
            ) {
                if (
                    selectedIndex < 0 ||
                    selectedIndex > maximumIndex
                ) {
                    this.selected.delete(
                        selectedIndex
                    );
                }
            }

            if (
                this.focusedIndex >
                maximumIndex
            ) {
                this.focusedIndex =
                    maximumIndex;
            }

            this.options.page =
                clampInteger(
                    this.options.page,
                    1,
                    1,
                    this.pageCount
                );

            this.render();

            this.emit(
                "update",
                {
                    total:
                        this.total,
                    options: {
                        ...this.options
                    }
                }
            );

            return this;
        }

        setData(
            data,
            options = {}
        ) {
            return this.update(
                data,
                options
            );
        }

        setRecords(
            records,
            options = {}
        ) {
            return this.update(
                records,
                options
            );
        }

        loadRecords(
            records,
            options = {}
        ) {
            return this.update(
                records,
                options
            );
        }

        ingest(
            records,
            options = {}
        ) {
            return this.update(
                records,
                options
            );
        }

        filter(
            query
        ) {
            this.options.filter =
                query;

            this.options.page =
                1;

            this.render();

            return this.total;
        }

        sort(
            field,
            direction =
                "ascending"
        ) {
            this.options.sortField =
                field ||
                null;

            this.options.sortDirection =
                String(
                    direction
                ).toLowerCase() ===
                    "descending"
                    ? "descending"
                    : "ascending";

            this.render();

            return {
                field:
                    this.options.sortField,
                direction:
                    this.options.sortDirection
            };
        }

        toText() {
            return this.viewData
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
                    "csv"
            ) {
                const rows =
                    this.viewData.map(
                        (
                            record,
                            index
                        ) => [
                            index +
                                1,
                            resolveLabel(
                                record,
                                this.options,
                                index
                            ),
                            normalizeText(
                                resolveValue(
                                    record,
                                    this.options
                                )
                            )
                        ]
                    );

                const escape =
                    value =>
                        `"${String(value ?? "").replace(/"/g, '""')}"`;

                return {
                    format:
                        "csv",
                    mime:
                        "text/csv",
                    extension:
                        "csv",
                    content:
                        [
                            [
                                "Index",
                                "Label",
                                "Value"
                            ],
                            ...rows
                        ]
                            .map(
                                row =>
                                    row.map(
                                        escape
                                    ).join(
                                        ","
                                    )
                            )
                            .join(
                                "\n"
                            )
                };
            }

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
                    safeStringify(
                        {
                            version:
                                VERSION,
                            generatedAt:
                                nowISO(),
                            options: {
                                ...this.options,
                                filter:
                                    typeof this.options.filter ===
                                        "function"
                                        ? "[Function]"
                                        : this.options.filter
                            },
                            records:
                                this.viewData
                        }
                    )
            };
        }

        status() {
            return {
                version:
                    VERSION,
                ready:
                    this.ready,
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
                    this.options.nested,

                selectable:
                    this.options.selectable,

                multiSelect:
                    this.options.multiSelect,

                selected:
                    this.selected.size,

                focusedIndex:
                    this.focusedIndex,

                filter:
                    typeof this.options.filter ===
                        "string"
                        ? this.options.filter
                        : Boolean(
                            this.options.filter
                        ),

                sortField:
                    this.options.sortField,

                sortDirection:
                    this.options.sortDirection,

                nestedControllers:
                    this.nestedControllers.size,

                destroyed:
                    this.destroyed
            };
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            for (
                const controller of
                Array.from(
                    this.nestedControllers
                )
            ) {
                controller.destroy?.();
            }

            this.nestedControllers.clear();

            try {
                this.abortController?.abort?.();
            } catch (_error) {
                /* Continue teardown. */
            }

            for (
                const dispose
                of this.boundListeners.splice(0)
            ) {
                try {
                    dispose();
                } catch (_error) {
                    /* Continue teardown. */
                }
            }

            this.selected.clear();

            this.emit(
                "destroy",
                {
                    version:
                        VERSION
                }
            );

            this.watchers.clear();

            registry().delete(
                this
            );

            if (
                this.container[
                    CONTROLLER_SYMBOL
                ] ===
                    this
            ) {
                delete this.container[
                    CONTROLLER_SYMBOL
                ];
            }

            this.container.replaceChildren();

            this.ready =
                false;

            this.destroyed =
                true;

            return true;
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
            isElement(
                target
            )
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

        container.setData =
            container.update;

        container.setRecords =
            container.update;

        container.loadRecords =
            container.update;

        container.ingest =
            container.update;

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
        context = {}
    ) {
        const safeContext =
            isObject(context)
                ? context
                : {};

        if (
            safeContext.listRenderer?.
                Controller ===
                    ListController
        ) {
            return safeContext.listRenderer;
        }

        const renderer = {
            version:
                VERSION,
            render,
            mount,
            registry,
            Controller:
                ListController,
            types:
                LIST_TYPES,
            setRecords(
                records,
                options = {}
            ) {
                const controllers =
                    Array.from(
                        registry()
                    ).filter(
                        controller =>
                            !controller.destroyed
                    );

                for (
                    const controller of
                    controllers
                ) {
                    controller.setRecords(
                        records,
                        options
                    );
                }

                return controllers.length;
            },
            setData(
                data,
                options = {}
            ) {
                return this.setRecords(
                    data,
                    options
                );
            },
            loadRecords(
                records,
                options = {}
            ) {
                return this.setRecords(
                    records,
                    options
                );
            },
            ingest(
                records,
                options = {}
            ) {
                return this.setRecords(
                    records,
                    options
                );
            },
            status() {
                const controllers =
                    Array.from(
                        registry()
                    ).filter(
                        controller =>
                            !controller.destroyed
                    );

                return {
                    version:
                        VERSION,
                    controllers:
                        controllers.length,
                    lists:
                        controllers.map(
                            controller =>
                                controller.status()
                        )
                };
            }
        };

        safeContext.registerRenderer?.(
            "list",
            renderer
        );

        safeContext.registerRenderer?.(
            "lists",
            renderer
        );

        safeContext.registerVisualization?.(
            "list",
            renderer
        );

        safeContext.registerService?.(
            "lists",
            renderer
        );

        safeContext.listRenderer =
            renderer;

        safeContext.lists =
            renderer;

        dispatch(
            document,
            "speciedex:terminal-lists-ready",
            {
                context:
                    safeContext,
                renderer,
                version:
                    VERSION
            }
        );

        return renderer;
    }

    /*
    ==========================================================================
    Commands
    ==========================================================================
    */

    function activeList(
        context = {}
    ) {
        const safeContext =
            isObject(context)
                ? context
                : {};

        return (
            safeContext.root?.
                querySelector?.(
                    ".terminal-renderer-list"
                )?.
                controller ||
            Array.from(
                registry()
            )
                .reverse()
                .find(
                    controller =>
                        !controller.destroyed
                ) ||
            null
        );
    }

    function resolveCommandContext(payload = {}) {
        return (
            payload.context ||
            payload.terminal?.context ||
            payload.app?.context ||
            payload
        );
    }

    function requireRenderer(context) {
        const safeContext =
            isObject(context)
                ? context
                : {};

        return (
            safeContext.listRenderer ||
            safeContext.lists ||
            safeContext.services?.get?.(
                "lists"
            ) ||
            initialize(safeContext)
        );
    }

    function writeResult(payload, value, type = "data") {
        if (
            typeof payload.writeJSON ===
                "function" &&
            typeof value !== "string"
        ) {
            return payload.writeJSON(value);
        }

        if (typeof payload.write === "function") {
            return payload.write(
                typeof value === "string"
                    ? value
                    : safeStringify(value),
                type
            );
        }

        if (typeof payload.writeLine === "function") {
            return payload.writeLine(
                typeof value === "string"
                    ? value
                    : safeStringify(value)
            );
        }

        return value;
    }

    const commands =
        [
            {
                name: "list",
                aliases: [
                    "lists"
                ],
                category: "visualization",
                description:
                    "Render a library collection as a structured list.",
                usage:
                    "list [collection] [--type unordered|ordered|definition] [--limit N]",
                handler: async payload => {
                    const context =
                        resolveCommandContext(payload);

                    const args =
                        Array.isArray(payload.args)
                            ? payload.args
                            : [];

                    const parsed =
                        isObject(payload.parsed)
                            ? payload.parsed
                            : {
                                flags: {},
                                options: {}
                            };

                    requireRenderer(context);

                    const collection =
                        args[0] ||
                        "records";

                    const library =
                        context.library ||
                        context.services?.get?.(
                            "library"
                        );

                    const value =
                        library?.get?.(
                            collection
                        );

                    const resolved =
                        value &&
                        typeof value.then ===
                            "function"
                            ? await value
                            : value;

                    const records =
                        normalizeArray(
                            resolved,
                            DEFAULT_OPTIONS.maximumRecords
                        );

                    const limit =
                        clampInteger(
                            parsed.options?.limit,
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
                                parsed.options?.type ||
                                (
                                    parsed.flags?.ordered
                                        ? "ordered"
                                        : parsed.flags?.definition
                                            ? "definition"
                                            : "unordered"
                                ),
                            pageSize:
                                clampInteger(
                                    parsed.options?.pageSize ||
                                    parsed.options?.["page-size"],
                                    DEFAULT_OPTIONS.pageSize,
                                    1,
                                    1000
                                ),
                            labelField:
                                parsed.options?.label ||
                                DEFAULT_OPTIONS.labelField,
                            valueField:
                                parsed.options?.value ||
                                null,
                            badgeField:
                                parsed.options?.badge ||
                                null,
                            metadataFields:
                                parseFields(
                                    parsed.options?.metadata
                                ),
                            selectable:
                                !parseBoolean(
                                    parsed.flags?.["no-select"],
                                    false
                                ),
                            multiSelect:
                                parseBoolean(
                                    parsed.flags?.multi,
                                    false
                                ),
                            sortField:
                                parsed.options?.sort ||
                                null,
                            sortDirection:
                                parsed.options?.direction ||
                                "ascending",
                            filter:
                                parsed.options?.filter ||
                                null
                        }
                    );
                }
            },

            {
                name: "list-status",
                category: "visualization",
                description:
                    "Display list-renderer availability and active state.",
                usage:
                    "list-status",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    const renderer =
                        requireRenderer(context);

                    const active =
                        activeList(context);

                    return writeResult(
                        payload,
                        {
                            version:
                                VERSION,
                            available:
                                true,
                            types:
                                LIST_TYPES,
                            active:
                                Boolean(active),
                            status:
                                active?.status?.() ||
                                null,
                            renderer:
                                renderer.status?.() ||
                                null
                        }
                    );
                }
            },

            {
                name: "list-filter",
                category: "visualization",
                description:
                    "Filter the active list renderer.",
                usage:
                    "list-filter [query]",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    const args =
                        Array.isArray(payload.args)
                            ? payload.args
                            : [];

                    const active =
                        activeList(context);

                    if (!active) {
                        throw new Error(
                            "No active list renderer is available."
                        );
                    }

                    const query =
                        args.join(" ");

                    const total =
                        active.filter(query);

                    return writeResult(
                        payload,
                        `List filter: ${query || "cleared"} · ${total} record${total === 1 ? "" : "s"}`,
                        "success"
                    );
                }
            },

            {
                name: "list-sort",
                category: "visualization",
                description:
                    "Sort the active list renderer.",
                usage:
                    "list-sort <field> [ascending|descending]",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    const args =
                        Array.isArray(payload.args)
                            ? payload.args
                            : [];

                    const active =
                        activeList(context);

                    if (!active) {
                        throw new Error(
                            "No active list renderer is available."
                        );
                    }

                    if (!args[0]) {
                        throw new Error(
                            "Usage: list-sort <field> [ascending|descending]"
                        );
                    }

                    return writeResult(
                        payload,
                        active.sort(
                            args[0],
                            args[1] ||
                            "ascending"
                        )
                    );
                }
            },

            {
                name: "list-page",
                category: "visualization",
                description:
                    "Move the active list renderer to a page.",
                usage:
                    "list-page <number>",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    const args =
                        Array.isArray(payload.args)
                            ? payload.args
                            : [];

                    const active =
                        activeList(context);

                    if (!active) {
                        throw new Error(
                            "No active list renderer is available."
                        );
                    }

                    const page =
                        active.page(
                            args[0]
                        );

                    return writeResult(
                        payload,
                        `List page: ${page} of ${active.pageCount}`,
                        "success"
                    );
                }
            },

            {
                name: "list-export",
                category: "visualization",
                description:
                    "Export the active list renderer.",
                usage:
                    "list-export [json|text|csv] [filename]",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    const args =
                        Array.isArray(payload.args)
                            ? payload.args
                            : [];

                    const active =
                        activeList(context);

                    if (!active) {
                        throw new Error(
                            "No active list renderer is available."
                        );
                    }

                    const format =
                        args[0] ||
                        "json";

                    const exported =
                        active.export(format);

                    const filename =
                        args[1] ||
                        `speciedex-list.${exported.extension}`;

                    const exporter =
                        context.exporter ||
                        context.services?.get?.(
                            "export"
                        ) ||
                        context.services?.get?.(
                            "exporter"
                        );

                    if (
                        exporter &&
                        typeof exporter.download ===
                            "function"
                    ) {
                        exporter.download(
                            exported.content,
                            filename,
                            exported.mime
                        );
                    } else {
                        if (
                            typeof URL?.createObjectURL !==
                                "function"
                        ) {
                            throw new Error(
                                "Browser download URLs are unavailable."
                            );
                        }

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

                        (document.body ||
                            document.documentElement)
                            .appendChild(anchor);

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
                    }

                    return writeResult(
                        payload,
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
            REGISTRY_SYMBOL,
            CONTROLLER_SYMBOL,
            ListController,

            isElement,
            registry,
            normalizeType,
            normalizeArray,
            normalizeText,
            getPath,
            resolveLabel,
            resolveValue,
            parseFields,
            compareValues,
            recordMatches,
            parseBoolean,
            safeStringify,
            dispatch,
            resolveCommandContext,

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

    dispatch(
        document,
        "speciedex:terminal-module-available",
        {
            name:
                MODULE_NAME,
            module:
                api
        }
    );
})(window, document);
