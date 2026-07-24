/*
========================================================================
Speciedex.org
Terminal Grid Renderer
========================================================================

Structured data-grid renderer for SpeciedexTerminal.

Provides:

    • Row and column normalization
    • Accessible table rendering
    • Client-side sorting and filtering
    • Pagination and result summaries
    • Safe value formatting
    • Renderer and service registration
    • Terminal command integration

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Grid";
    const VERSION = "2.1.0";

    const RENDERER_SYMBOL =
        Symbol.for(
            "speciedex.terminal.grid.renderer"
        );

    const INSTANCE_SYMBOL =
        Symbol.for(
            "speciedex.terminal.grid.instance"
        );

    const DEFAULT_PAGE_SIZE = 25;
    const MIN_PAGE_SIZE = 1;
    const MAX_PAGE_SIZE = 500;
    const DEFAULT_MAX_ROWS = 250000;
    const DEFAULT_MAX_COLUMNS = 512;
    const DEFAULT_FILTER_DEBOUNCE = 120;
    const DEFAULT_SELECTION_LIMIT = 10000;

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

    function isNode(
        value
    ) {
        return Boolean(
            value &&
            typeof value.nodeType ===
                "number"
        );
    }

    function rowIdentity(
        row,
        index
    ) {
        const candidate =
            row?.speciedex_id ??
            row?.speciedexId ??
            row?.id ??
            row?.key ??
            row?.uuid ??
            null;

        return candidate ===
            null ||
            candidate ===
                undefined ||
            String(
                candidate
            ).trim() ===
                ""
            ? `row:${index}`
            : String(
                candidate
            );
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

    function isPlainObject(value) {
        if (
            value === null ||
            typeof value !== "object"
        ) {
            return false;
        }

        const prototype =
            Object.getPrototypeOf(value);

        return (
            prototype === Object.prototype ||
            prototype === null
        );
    }

    function safeString(value) {
        if (
            value === null ||
            value === undefined
        ) {
            return "";
        }

        if (typeof value === "string") {
            return value;
        }

        if (
            typeof value === "number" ||
            typeof value === "boolean" ||
            typeof value === "bigint"
        ) {
            return String(value);
        }

        if (value instanceof Date) {
            return Number.isNaN(value.getTime())
                ? "Invalid Date"
                : value.toISOString();
        }

        try {
            return JSON.stringify(value);
        } catch (_error) {
            try {
                return String(value);
            } catch (_stringError) {
                return "[Unprintable value]";
            }
        }
    }

    function normalizeInput(
        data,
        options =
            {}
    ) {
        const maxRows =
            clampInteger(
                options.maxRows,
                DEFAULT_MAX_ROWS,
                1,
                5000000
            );
        if (typeof data === "string") {
            const trimmed = data.trim();

            if (!trimmed) {
                return [];
            }

            try {
                return normalizeInput(
                    JSON.parse(
                        trimmed
                    ),
                    options
                );
            } catch (_error) {
                return trimmed
                    .split(/\r?\n/)
                    .filter(Boolean)
                    .map((value, index) => ({
                        index: index + 1,
                        value
                    }));
            }
        }

        if (data instanceof Map) {
            return [...data.entries()].map(
                ([key, value]) => ({
                    key,
                    value
                })
            );
        }

        if (data instanceof Set) {
            return [...data.values()].map(
                (value, index) => ({
                    index: index + 1,
                    value
                })
            );
        }

        if (Array.isArray(data)) {
            return data
                .slice(
                    0,
                    maxRows
                )
                .map((row, index) => {
                if (isPlainObject(row)) {
                    return { ...row };
                }

                if (Array.isArray(row)) {
                    return Object.fromEntries(
                        row.map((value, columnIndex) => [
                            `column${columnIndex + 1}`,
                            value
                        ])
                    );
                }

                return {
                    index: index + 1,
                    value: row
                };
            });
        }

        if (
            isPlainObject(
                data
            )
        ) {
            for (
                const key of
                [
                    "records",
                    "rows",
                    "results",
                    "items",
                    "data",
                    "species",
                    "taxa"
                ]
            ) {
                if (
                    Array.isArray(
                        data[
                            key
                        ]
                    )
                ) {
                    return normalizeInput(
                        data[
                            key
                        ],
                        options
                    );
                }
            }

            return Object.entries(data)
                .slice(
                    0,
                    maxRows
                )
                .map(
                ([key, value]) => ({
                    key,
                    value
                })
            );
        }

        if (
            data === null ||
            data === undefined
        ) {
            return [];
        }

        return [
            {
                value: data
            }
        ];
    }

    function normalizeColumns(
        rows,
        columns =
            null,
        options =
            {}
    ) {
        const maxColumns =
            clampInteger(
                options.maxColumns,
                DEFAULT_MAX_COLUMNS,
                1,
                10000
            );
        if (
            Array.isArray(columns) &&
            columns.length
        ) {
            return columns
                .slice(
                    0,
                    maxColumns
                )
                .map(column => {
                if (typeof column === "string") {
                    return {
                        key: column,
                        label: column,
                        sortable: true
                    };
                }

                return {
                    key:
                        String(
                            column.key ??
                            column.name ??
                            column.label ??
                            ""
                        ),
                    label:
                        String(
                            column.label ??
                            column.name ??
                            column.key ??
                            ""
                        ),
                    sortable:
                        column.sortable !== false,
                    formatter:
                        typeof column.formatter === "function"
                            ? column.formatter
                            : null
                };
            }).filter(column => column.key);
        }

        const keys = [];
        const seen = new Set();

        for (const row of rows) {
            for (const key of Object.keys(row)) {
                if (!seen.has(key)) {
                    seen.add(key);
                    keys.push(key);
                }
            }
        }

        return keys
            .slice(
                0,
                maxColumns
            )
            .map(key => ({
            key,
            label: key,
            sortable: true,
            formatter: null
        }));
    }

    function compareValues(left, right) {
        if (
            left === null ||
            left === undefined
        ) {
            return (
                right === null ||
                right === undefined
            ) ? 0 : -1;
        }

        if (
            right === null ||
            right === undefined
        ) {
            return 1;
        }

        const leftNumber = Number(left);
        const rightNumber = Number(right);

        if (
            Number.isFinite(leftNumber) &&
            Number.isFinite(rightNumber)
        ) {
            return leftNumber - rightNumber;
        }

        const leftDate = Date.parse(left);
        const rightDate = Date.parse(right);

        if (
            Number.isFinite(leftDate) &&
            Number.isFinite(rightDate)
        ) {
            return leftDate - rightDate;
        }

        return safeString(left).localeCompare(
            safeString(right),
            undefined,
            {
                numeric: true,
                sensitivity: "base"
            }
        );
    }

    function filterRows(rows, query, columns) {
        const normalized =
            String(query || "")
                .trim()
                .toLowerCase();

        if (!normalized) {
            return [...rows];
        }

        return rows.filter(row =>
            columns.some(column =>
                safeString(
                    row[column.key]
                )
                    .toLowerCase()
                    .includes(normalized)
            )
        );
    }

    function normalizeSort(
        sort,
        key =
            "",
        direction =
            "asc"
    ) {
        if (
            Array.isArray(
                sort
            )
        ) {
            return sort
                .map(
                    item => ({
                        key:
                            String(
                                item?.key ||
                                item?.column ||
                                ""
                            ),
                        direction:
                            String(
                                item?.direction ||
                                "asc"
                            ).toLowerCase() ===
                                "desc"
                                ? "desc"
                                : "asc"
                    })
                )
                .filter(
                    item =>
                        item.key
                );
        }

        if (key) {
            return [
                {
                    key:
                        String(
                            key
                        ),
                    direction:
                        String(
                            direction
                        ).toLowerCase() ===
                            "desc"
                            ? "desc"
                            : "asc"
                }
            ];
        }

        return [];
    }

    function sortRows(
        rows,
        key,
        direction =
            "asc",
        sort =
            null
    ) {
        const descriptors =
            normalizeSort(
                sort,
                key,
                direction
            );

        if (
            !descriptors.length
        ) {
            return [
                ...rows
            ];
        }

        return rows
            .map(
                (
                    row,
                    index
                ) => ({
                    row,
                    index
                })
            )
            .sort(
                (
                    left,
                    right
                ) => {
                    for (
                        const descriptor of
                        descriptors
                    ) {
                        const comparison =
                            compareValues(
                                left.row[
                                    descriptor.key
                                ],
                                right.row[
                                    descriptor.key
                                ]
                            );

                        if (
                            comparison
                        ) {
                            return comparison *
                                (
                                    descriptor.direction ===
                                        "desc"
                                        ? -1
                                        : 1
                                );
                        }
                    }

                    return left.index -
                        right.index;
                }
            )
            .map(
                item =>
                    item.row
            );
    }

    class GridView extends EventTarget {
        constructor(
            data,
            options =
                {}
        ) {
            super();

            this.options = {
                ...options
            };

            this.maxRows =
                clampInteger(
                    options.maxRows,
                    DEFAULT_MAX_ROWS,
                    1,
                    5000000
                );

            this.maxColumns =
                clampInteger(
                    options.maxColumns,
                    DEFAULT_MAX_COLUMNS,
                    1,
                    10000
                );

            this.selectionLimit =
                clampInteger(
                    options.selectionLimit,
                    DEFAULT_SELECTION_LIMIT,
                    1,
                    1000000
                );

            this.rows =
                normalizeInput(
                    data,
                    {
                        maxRows:
                            this.maxRows
                    }
                );

            this.columns =
                normalizeColumns(
                    this.rows,
                    options.columns,
                    {
                        maxColumns:
                            this.maxColumns
                    }
                );

            this.options = {
                title:
                    options.title || "",
                filter:
                    options.filter || "",
                sortable:
                    options.sortable !== false,
                paginate:
                    options.paginate !== false,
                pageSize:
                    clampInteger(
                        options.pageSize,
                        DEFAULT_PAGE_SIZE,
                        MIN_PAGE_SIZE,
                        MAX_PAGE_SIZE
                    ),
                page:
                    clampInteger(
                        options.page,
                        1,
                        1,
                        Number.MAX_SAFE_INTEGER
                    ),
                sortKey:
                    options.sortKey || "",
                sortDirection:
                    String(
                        options.sortDirection ||
                        "asc"
                    ).toLowerCase() === "desc"
                        ? "desc"
                        : "asc",
                emptyMessage:
                    options.emptyMessage ||
                    "No grid rows available.",
                filterDebounce:
                    clampInteger(
                        options.filterDebounce,
                        DEFAULT_FILTER_DEBOUNCE,
                        0,
                        5000
                    ),
                selectable:
                    options.selectable !==
                    false,
                multiSelect:
                    options.multiSelect ===
                    true,
                maxRows:
                    this.maxRows,
                maxColumns:
                    this.maxColumns
            };

            this.root = null;
            this.table = null;
            this.summary = null;
            this.filterInput = null;
            this.pageLabel = null;
            this.previousButton = null;
            this.nextButton =
                null;

            this.destroyed =
                false;

            this.selected =
                new Set();

            this.abortController =
                new AbortController();

            this.filterTimer =
                null;

            this.metrics = {
                refreshes:
                    0,
                filters:
                    0,
                sorts:
                    0,
                selections:
                    0,
                exports:
                    0
            };
        }

        getProcessedRows() {
            const filtered =
                filterRows(
                    this.rows,
                    this.options.filter,
                    this.columns
                );

            const sorted =
                sortRows(
                    filtered,
                    this.options.sortKey,
                    this.options.sortDirection,
                    this.options.sort
                );

            return {
                filtered,
                sorted
            };
        }

        getPageState() {
            const {
                sorted
            } = this.getProcessedRows();

            const totalRows =
                sorted.length;

            const pageSize =
                this.options.paginate
                    ? this.options.pageSize
                    : Math.max(
                        totalRows,
                        1
                    );

            const totalPages =
                Math.max(
                    1,
                    Math.ceil(
                        totalRows /
                        pageSize
                    )
                );

            const page =
                Math.min(
                    totalPages,
                    Math.max(
                        1,
                        this.options.page
                    )
                );

            this.options.page = page;

            const start =
                (page - 1) *
                pageSize;

            const end =
                Math.min(
                    totalRows,
                    start + pageSize
                );

            return {
                totalRows,
                totalPages,
                page,
                pageSize,
                start,
                end,
                rows:
                    sorted.slice(
                        start,
                        end
                    )
            };
        }

        setFilter(query) {
            this.options.filter =
                String(query || "");

            this.options.page = 1;
            this.refresh();

            return this.options.filter;
        }

        setSort(key, direction = null) {
            if (
                !this.columns.some(
                    column =>
                        column.key === key &&
                        column.sortable
                )
            ) {
                return false;
            }

            if (
                this.options.sortKey === key &&
                direction === null
            ) {
                this.options.sortDirection =
                    this.options.sortDirection === "asc"
                        ? "desc"
                        : "asc";
            } else {
                this.options.sortKey = key;
                this.options.sortDirection =
                    String(
                        direction || "asc"
                    ).toLowerCase() === "desc"
                        ? "desc"
                        : "asc";
            }

            this.options.page = 1;
            this.refresh();

            return true;
        }

        setPage(page) {
            this.options.page =
                clampInteger(
                    page,
                    this.options.page,
                    1,
                    Number.MAX_SAFE_INTEGER
                );

            this.refresh();

            return this.options.page;
        }

        setPageSize(pageSize) {
            this.options.pageSize =
                clampInteger(
                    pageSize,
                    this.options.pageSize,
                    MIN_PAGE_SIZE,
                    MAX_PAGE_SIZE
                );

            this.options.page = 1;
            this.refresh();

            return this.options.pageSize;
        }

        setData(
            data,
            options =
                {}
        ) {
            this.rows =
                normalizeInput(
                    data,
                    {
                        maxRows:
                            options.maxRows ||
                            this.maxRows
                    }
                );

            this.columns =
                normalizeColumns(
                    this.rows,
                    options.columns ||
                    this.columns,
                    {
                        maxColumns:
                            options.maxColumns ||
                            this.maxColumns
                    }
                );

            this.selected.clear();

            this.options.page =
                1;

            this.refresh();

            return this.rows.length;
        }

        setColumns(
            columns
        ) {
            this.columns =
                normalizeColumns(
                    this.rows,
                    columns,
                    {
                        maxColumns:
                            this.maxColumns
                    }
                );

            this.refresh();

            return this.columns.map(
                column =>
                    column.key
            );
        }

        appendRows(
            rows
        ) {
            const incoming =
                normalizeInput(
                    rows,
                    {
                        maxRows:
                            this.maxRows
                    }
                );

            this.rows = [
                ...this.rows,
                ...incoming
            ].slice(
                -this.maxRows
            );

            this.columns =
                normalizeColumns(
                    this.rows,
                    this.columns,
                    {
                        maxColumns:
                            this.maxColumns
                    }
                );

            this.refresh();

            return incoming.length;
        }

        removeRows(
            predicate
        ) {
            const before =
                this.rows.length;

            if (
                typeof predicate ===
                    "function"
            ) {
                this.rows =
                    this.rows.filter(
                        (
                            row,
                            index
                        ) =>
                            !predicate(
                                row,
                                index
                            )
                    );
            } else {
                const ids =
                    new Set(
                        Array.isArray(
                            predicate
                        )
                            ? predicate.map(
                                String
                            )
                            : [
                                String(
                                    predicate
                                )
                            ]
                    );

                this.rows =
                    this.rows.filter(
                        (
                            row,
                            index
                        ) =>
                            !ids.has(
                                rowIdentity(
                                    row,
                                    index
                                )
                            )
                    );
            }

            this.selected.clear();

            this.refresh();

            return before -
                this.rows.length;
        }

        clear() {
            const count =
                this.rows.length;

            this.rows =
                [];

            this.selected.clear();

            this.refresh();

            return count;
        }

        getSelectedRows() {
            return Array.from(
                this.selected
            )
                .map(
                    id =>
                        this.rows.find(
                            (
                                row,
                                index
                            ) =>
                                rowIdentity(
                                    row,
                                    index
                                ) ===
                                id
                        )
                )
                .filter(
                    Boolean
                )
                .map(
                    clone
                );
        }

        build() {
            const container =
                document.createElement(
                    "section"
                );

            container.className =
                "terminal-renderer terminal-renderer-grid";
            container.dataset.renderer =
                "grid";

            if (this.options.title) {
                const heading =
                    document.createElement(
                        "h3"
                    );

                heading.textContent =
                    this.options.title;

                container.appendChild(
                    heading
                );
            }

            const toolbar =
                document.createElement(
                    "div"
                );

            toolbar.className =
                "terminal-grid-toolbar";

            const filterLabel =
                document.createElement(
                    "label"
                );

            filterLabel.className =
                "terminal-grid-filter-label";
            filterLabel.textContent =
                "Filter ";

            const filterInput =
                document.createElement(
                    "input"
                );

            filterInput.type = "search";
            filterInput.value =
                this.options.filter;
            filterInput.placeholder =
                "Filter rows";
            filterInput.setAttribute(
                "aria-label",
                "Filter grid rows"
            );

            filterInput.addEventListener(
                "input",
                () => {
                    window.clearTimeout(
                        this.filterTimer
                    );

                    this.filterTimer =
                        window.setTimeout(
                            () => {
                                this.filterTimer =
                                    null;

                                this.setFilter(
                                    filterInput.value
                                );

                                this.metrics.filters +=
                                    1;
                            },
                            this.options.filterDebounce
                        );
                },
                {
                    signal:
                        this.abortController.signal
                }
            );

            filterLabel.appendChild(
                filterInput
            );

            toolbar.appendChild(
                filterLabel
            );

            const summary =
                document.createElement(
                    "span"
                );

            summary.className =
                "terminal-grid-summary";

            toolbar.appendChild(
                summary
            );

            container.appendChild(
                toolbar
            );

            const tableWrapper =
                document.createElement(
                    "div"
                );

            tableWrapper.className =
                "terminal-grid-table-wrapper";

            const table =
                document.createElement(
                    "table"
                );

            table.className =
                "terminal-grid-table";

            tableWrapper.appendChild(
                table
            );

            container.appendChild(
                tableWrapper
            );

            const pagination =
                document.createElement(
                    "div"
                );

            pagination.className =
                "terminal-grid-pagination";

            const previousButton =
                document.createElement(
                    "button"
                );

            previousButton.type =
                "button";
            previousButton.textContent =
                "Previous";

            previousButton.addEventListener(
                "click",
                () =>
                    this.setPage(
                        this.options.page -
                            1
                    ),
                {
                    signal:
                        this.abortController.signal
                }
            );

            const pageLabel =
                document.createElement(
                    "span"
                );

            pageLabel.className =
                "terminal-grid-page-label";

            const nextButton =
                document.createElement(
                    "button"
                );

            nextButton.type =
                "button";
            nextButton.textContent =
                "Next";

            nextButton.addEventListener(
                "click",
                () =>
                    this.setPage(
                        this.options.page +
                            1
                    ),
                {
                    signal:
                        this.abortController.signal
                }
            );

            pagination.append(
                previousButton,
                pageLabel,
                nextButton
            );

            container.appendChild(
                pagination
            );

            this.root = container;
            this.table = table;
            this.summary = summary;
            this.filterInput = filterInput;
            this.pageLabel = pageLabel;
            this.previousButton =
                previousButton;
            this.nextButton =
                nextButton;

            this.refresh();

            return container;
        }

        renderHeader() {
            const thead =
                document.createElement(
                    "thead"
                );

            const row =
                document.createElement(
                    "tr"
                );

            for (
                const column of
                this.columns
            ) {
                const th =
                    document.createElement(
                        "th"
                    );

                th.scope = "col";

                if (
                    this.options.sortable &&
                    column.sortable
                ) {
                    const button =
                        document.createElement(
                            "button"
                        );

                    button.type =
                        "button";
                    button.className =
                        "terminal-grid-sort";
                    button.dataset.column =
                        column.key;

                    const active =
                        this.options.sortKey ===
                        column.key;

                    button.textContent =
                        active
                            ? `${column.label} ${this.options.sortDirection === "asc" ? "▲" : "▼"}`
                            : column.label;

                    button.setAttribute(
                        "aria-sort",
                        active
                            ? (
                                this.options.sortDirection ===
                                "asc"
                                    ? "ascending"
                                    : "descending"
                            )
                            : "none"
                    );

                    button.addEventListener(
                        "click",
                        () => {
                            this.setSort(
                                column.key
                            );

                            this.metrics.sorts +=
                                1;
                        },
                        {
                            signal:
                                this.abortController.signal
                        }
                    );

                    th.appendChild(
                        button
                    );
                } else {
                    th.textContent =
                        column.label;
                }

                row.appendChild(th);
            }

            thead.appendChild(row);
            return thead;
        }

        renderBody(
            rows,
            pageStart =
                0
        ) {
            const tbody =
                document.createElement(
                    "tbody"
                );

            if (!rows.length) {
                const row =
                    document.createElement(
                        "tr"
                    );

                const cell =
                    document.createElement(
                        "td"
                    );

                cell.colSpan =
                    Math.max(
                        1,
                        this.columns.length
                    );

                cell.className =
                    "terminal-grid-empty";
                cell.textContent =
                    this.options.emptyMessage;

                row.appendChild(cell);
                tbody.appendChild(row);

                return tbody;
            }

            for (
                const [
                    pageIndex,
                    rowData
                ] of rows.entries()
            ) {
                const row =
                    document.createElement(
                        "tr"
                    );

                const absoluteIndex =
                    pageStart +
                    pageIndex;

                const identity =
                    rowIdentity(
                        rowData,
                        absoluteIndex
                    );

                row.dataset.rowId =
                    identity;

                row.tabIndex =
                    pageIndex ===
                        0
                        ? 0
                        : -1;

                row.setAttribute(
                    "aria-selected",
                    this.selected.has(
                        identity
                    )
                        ? "true"
                        : "false"
                );

                const select =
                    event => {
                        if (
                            !this.options.selectable
                        ) {
                            return;
                        }

                        if (
                            !this.options.multiSelect ||
                            !(
                                event?.ctrlKey ||
                                event?.metaKey
                            )
                        ) {
                            this.selected.clear();
                        }

                        if (
                            this.selected.has(
                                identity
                            )
                        ) {
                            this.selected.delete(
                                identity
                            );
                        } else if (
                            this.selected.size <
                            this.selectionLimit
                        ) {
                            this.selected.add(
                                identity
                            );
                        }

                        this.metrics.selections +=
                            1;

                        this.refresh();

                        dispatch(
                            this,
                            "selection",
                            {
                                ids:
                                    [
                                        ...this.selected
                                    ],
                                rows:
                                    this.getSelectedRows()
                            }
                        );
                    };

                row.addEventListener(
                    "click",
                    select,
                    {
                        signal:
                            this.abortController.signal
                    }
                );

                row.addEventListener(
                    "keydown",
                    event => {
                        if (
                            event.key ===
                                "Enter" ||
                            event.key ===
                                " "
                        ) {
                            event.preventDefault();

                            select(
                                event
                            );

                            return;
                        }

                        if (
                            ![
                                "ArrowDown",
                                "ArrowUp",
                                "Home",
                                "End"
                            ].includes(
                                event.key
                            )
                        ) {
                            return;
                        }

                        event.preventDefault();

                        const rows =
                            Array.from(
                                tbody.querySelectorAll(
                                    "tr[data-row-id]"
                                )
                            );

                        const current =
                            rows.indexOf(
                                row
                            );

                        const next =
                            event.key ===
                                "Home"
                                ? 0
                                : event.key ===
                                    "End"
                                    ? rows.length -
                                        1
                                    : event.key ===
                                        "ArrowDown"
                                        ? Math.min(
                                            rows.length -
                                                1,
                                            current +
                                                1
                                        )
                                        : Math.max(
                                            0,
                                            current -
                                                1
                                        );

                        rows[
                            next
                        ]?.focus();
                    },
                    {
                        signal:
                            this.abortController.signal
                    }
                );

                for (
                    const column of
                    this.columns
                ) {
                    const cell =
                        document.createElement(
                            "td"
                        );

                    const value =
                        rowData[
                            column.key
                        ];

                    const formatted =
                        column.formatter
                            ? column.formatter(
                                value,
                                rowData,
                                column
                            )
                            : safeString(value);

                    if (
                        isNode(
                            formatted
                        )
                    ) {
                        cell.appendChild(
                            formatted
                        );
                    } else {
                        cell.textContent =
                            safeString(
                                formatted
                            );
                    }

                    row.appendChild(cell);
                }

                tbody.appendChild(row);
            }

            return tbody;
        }

        refresh() {
            if (
                this.destroyed ||
                !this.table
            ) {
                return;
            }

            const state =
                this.getPageState();

            this.table.replaceChildren(
                this.renderHeader(),
                this.renderBody(
                    state.rows,
                    state.start
                )
            );

            this.root.dataset.rowCount =
                String(
                    this.rows.length
                );

            this.root.dataset.filteredCount =
                String(
                    state.totalRows
                );

            this.summary.textContent =
                state.totalRows
                    ? `Showing ${state.start + 1}-${state.end} of ${state.totalRows}`
                    : "Showing 0 rows";

            this.pageLabel.textContent =
                `Page ${state.page} of ${state.totalPages}`;

            this.previousButton.disabled =
                state.page <= 1;

            this.nextButton.disabled =
                state.page >=
                state.totalPages;

            this.previousButton.hidden =
                !this.options.paginate;

            this.nextButton.hidden =
                !this.options.paginate;

            this.pageLabel.hidden =
                !this.options.paginate;

            this.metrics.refreshes +=
                1;

            dispatch(
                this,
                "change",
                {
                    ...state,
                    filter:
                        this.options.filter,
                    sortKey:
                        this.options.sortKey,
                    sortDirection:
                        this.options.sortDirection
                }
            );
        }

        status() {
            const state =
                this.getPageState();

            return {
                version: VERSION,
                rows:
                    this.rows.length,
                filteredRows:
                    state.totalRows,
                columns:
                    this.columns.map(
                        column => column.key
                    ),
                page:
                    state.page,
                totalPages:
                    state.totalPages,
                pageSize:
                    state.pageSize,
                filter:
                    this.options.filter,
                sortKey:
                    this.options.sortKey || null,
                sortDirection:
                    this.options.sortDirection,
                selected:
                    this.selected.size,
                maxRows:
                    this.maxRows,
                maxColumns:
                    this.maxColumns,
                metrics: {
                    ...this.metrics
                },
                destroyed:
                    this.destroyed
            };
        }
        toJSON(
            options =
                {}
        ) {
            const data =
                options.selection ===
                    true
                    ? this.getSelectedRows()
                    : options.filtered ===
                        true
                        ? this.getProcessedRows().
                            sorted
                        : this.rows;

            this.metrics.exports +=
                1;

            return JSON.stringify(
                data,
                null,
                options.compact ===
                    true
                    ? 0
                    : 2
            );
        }

        toCSV(
            options =
                {}
        ) {
            const data =
                options.selection ===
                    true
                    ? this.getSelectedRows()
                    : options.filtered ===
                        true
                        ? this.getProcessedRows().
                            sorted
                        : this.rows;

            const headers =
                this.columns.map(
                    column =>
                        column.key
                );

            const cell =
                value =>
                    `"${safeString(value).replace(/"/g, '""')}"`;

            this.metrics.exports +=
                1;

            return [
                headers.map(
                    cell
                ).join(
                    ","
                ),
                ...data.map(
                    row =>
                        headers.map(
                            key =>
                                cell(
                                    row[
                                        key
                                    ]
                                )
                        ).join(
                            ","
                        )
                )
            ].join(
                "\r\n"
            );
        }

        destroy() {
            if (
                this.destroyed
            ) {
                return false;
            }

            window.clearTimeout(
                this.filterTimer
            );

            this.abortController.abort();

            this.selected.clear();

            this.destroyed =
                true;

            this.root?.remove?.();

            dispatch(
                this,
                "destroy",
                {
                    version:
                        VERSION
                }
            );

            return true;
        }

    }

    class GridRenderer extends EventTarget {
        constructor(
            context =
                {}
        ) {
            super();

            this.context =
                context;

            this.instances =
                new Set();

            this.destroyed =
                false;

            this.metrics = {
                renders:
                    0,
                destroyedInstances:
                    0
            };
        }

        render(
            data,
            options =
                {}
        ) {
            if (
                this.destroyed
            ) {
                throw new Error(
                    "Grid renderer has been destroyed."
                );
            }

            const grid =
                new GridView(
                    data,
                    options
                );

            const node =
                grid.build();

            const instance = {
                element:
                    node,
                view:
                    grid,
                refresh:
                    (
                        nextData =
                            grid.rows,
                        nextOptions =
                            {}
                    ) =>
                        grid.setData(
                            nextData,
                            nextOptions
                        ),
                setData:
                    (
                        nextData,
                        nextOptions =
                            {}
                    ) =>
                        grid.setData(
                            nextData,
                            nextOptions
                        ),
                appendRows:
                    rows =>
                        grid.appendRows(
                            rows
                        ),
                removeRows:
                    predicate =>
                        grid.removeRows(
                            predicate
                        ),
                clear:
                    () =>
                        grid.clear(),
                status:
                    () =>
                        grid.status(),
                getSelectedRows:
                    () =>
                        grid.getSelectedRows(),
                toJSON:
                    options =>
                        grid.toJSON(
                            options
                        ),
                toCSV:
                    options =>
                        grid.toCSV(
                            options
                        ),
                destroy:
                    () => {
                        if (
                            !this.instances.has(
                                instance
                            )
                        ) {
                            return false;
                        }

                        this.instances.delete(
                            instance
                        );

                        delete node[
                            INSTANCE_SYMBOL
                        ];

                        this.metrics.destroyedInstances +=
                            1;

                        return grid.destroy();
                    }
            };

            node[
                INSTANCE_SYMBOL
            ] =
                instance;

            node.gridView =
                grid;

            node.gridInstance =
                instance;

            node.update =
                instance.refresh;

            node.setData =
                instance.setData;

            node.appendRows =
                instance.appendRows;

            node.destroy =
                instance.destroy;

            this.instances.add(
                instance
            );

            this.metrics.renders +=
                1;

            return node;
        }

        activeInstance() {
            const element =
                this.context.root?.
                    querySelector?.(
                        ".terminal-renderer-grid"
                    ) ||
                document.querySelector(
                    ".terminal-renderer-grid"
                );

            return (
                element?.[
                    INSTANCE_SYMBOL
                ] ||
                element?.
                    gridInstance ||
                Array.from(
                    this.instances
                ).at(
                    -1
                ) ||
                null
            );
        }

        mount(
            target,
            data,
            options =
                {}
        ) {
            const element =
                this.render(
                    data,
                    options
                );

            if (
                isElement(
                    target
                )
            ) {
                target.replaceChildren(
                    element
                );
            }

            return element;
        }

        status() {
            return {
                version:
                    VERSION,
                instances:
                    this.instances.size,
                metrics: {
                    ...this.metrics
                },
                active:
                    this.activeInstance?.
                        ()?.
                        status?.() ||
                    null,
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

            for (
                const instance of
                Array.from(
                    this.instances
                )
            ) {
                instance.destroy();
            }

            this.instances.clear();

            if (
                this.context.root?.[
                    RENDERER_SYMBOL
                ] ===
                    this
            ) {
                delete this.context.root[
                    RENDERER_SYMBOL
                ];
            }

            this.destroyed =
                true;

            return true;
        }
    }

    function render(
        data,
        options =
            {}
    ) {
        return new GridRenderer(
            {}
        ).render(
            data,
            options
        );
    }

    function initialize(
        context
    ) {
        const root =
            context.root;

        const existing =
            context.gridRenderer instanceof
                GridRenderer
                ? context.gridRenderer
                : root?.[
                    RENDERER_SYMBOL
                ];

        if (
            existing instanceof
                GridRenderer &&
            !existing.destroyed
        ) {
            context.gridRenderer =
                existing;

            context.registerRenderer?.(
                "grid",
                existing
            );

            context.registerRenderer?.(
                "data-grid",
                existing
            );

            return existing;
        }

        const renderer =
            new GridRenderer(
                context
            );

        root[
            RENDERER_SYMBOL
        ] =
            renderer;

        context.registerRenderer?.(
            "grid",
            renderer
        );

        context.registerRenderer?.(
            "data-grid",
            renderer
        );

        context.registerVisualization?.(
            "grid",
            renderer
        );

        context.gridRenderer =
            renderer;

        context.registerService?.(
            "grid",
            renderer
        );

        dispatch(
            document,
            "speciedex:terminal-grid-ready",
            {
                context,
                renderer,
                version:
                    VERSION
            }
        );

        return renderer;
    }

    function parseCommandData(args) {
        const options = {
            title: "",
            pageSize:
                DEFAULT_PAGE_SIZE,
            sortKey: "",
            sortDirection:
                "asc",
            filter:
                "",
            maxRows:
                DEFAULT_MAX_ROWS,
            maxColumns:
                DEFAULT_MAX_COLUMNS,
            selectable:
                true,
            multiSelect:
                false
        };

        const values = [];

        for (const argument of args) {
            if (
                argument.startsWith(
                    "--title="
                )
            ) {
                options.title =
                    argument.slice(8);
                continue;
            }

            if (
                argument.startsWith(
                    "--page-size="
                )
            ) {
                options.pageSize =
                    argument.slice(12);
                continue;
            }

            if (
                argument.startsWith(
                    "--sort="
                )
            ) {
                const [
                    key,
                    direction
                ] =
                    argument
                        .slice(7)
                        .split(":");

                options.sortKey =
                    key || "";
                options.sortDirection =
                    direction || "asc";
                continue;
            }

            if (
                argument.startsWith(
                    "--filter="
                )
            ) {
                options.filter =
                    argument.slice(9);
                continue;
            }

            if (
                argument.startsWith(
                    "--max-rows="
                )
            ) {
                options.maxRows =
                    argument.slice(
                        11
                    );

                continue;
            }

            if (
                argument.startsWith(
                    "--max-columns="
                )
            ) {
                options.maxColumns =
                    argument.slice(
                        14
                    );

                continue;
            }

            if (
                argument ===
                "--multi-select"
            ) {
                options.multiSelect =
                    true;

                continue;
            }

            if (
                argument ===
                "--no-select"
            ) {
                options.selectable =
                    false;

                continue;
            }

            values.push(argument);
        }

        if (!values.length) {
            return {
                data: [],
                options
            };
        }

        const joined =
            values.join(" ");

        try {
            return {
                data:
                    JSON.parse(
                        joined
                    ),
                options
            };
        } catch (_error) {
            return {
                data:
                    values.map(
                        (value, index) => {
                            const separator =
                                value.indexOf("=");

                            if (
                                separator >= 0
                            ) {
                                return {
                                    key:
                                        value.slice(
                                            0,
                                            separator
                                        ),
                                    value:
                                        value.slice(
                                            separator + 1
                                        )
                                };
                            }

                            return {
                                index:
                                    index + 1,
                                value
                            };
                        }
                    ),
                options
            };
        }
    }

    const commands = [
        {
            name: "grid",
            aliases: [
                "datagrid"
            ],
            category: "visualization",
            description:
                "Render an interactive data grid.",
            usage:
                "grid <JSON or values> [--title=Title] [--page-size=25] [--sort=column:asc] [--filter=text]",
            handler: ({
                args = [],
                context,
                write,
                writeNode
            }) => {
                const renderer =
                    context.gridRenderer ||
                    initialize(context);

                const {
                    data,
                    options
                } =
                    parseCommandData(
                        args
                    );

                let source =
                    data;

                const literalArgs =
                    args.filter(
                        argument =>
                            !argument.startsWith(
                                "--"
                            )
                    );

                if (
                    literalArgs.length ===
                        1 &&
                    Array.isArray(
                        data
                    ) &&
                    data.length ===
                        1 &&
                    data[
                        0
                    ]?.value ===
                        literalArgs[
                            0
                        ]
                ) {
                    const library =
                        context.library ||
                        context.services?.get?.(
                            "library"
                        );

                    const collection =
                        library?.get?.(
                            literalArgs[
                                0
                            ]
                        );

                    if (
                        collection !==
                            undefined &&
                        collection !==
                            null
                    ) {
                        source =
                            collection;
                    }
                }

                const node =
                    renderer.render(
                        source,
                        options
                    );

                if (
                    typeof writeNode ===
                    "function"
                ) {
                    return writeNode(node);
                }

                if (
                    typeof context.writeNode ===
                    "function"
                ) {
                    return context.writeNode(
                        node
                    );
                }

                if (
                    typeof write ===
                    "function"
                ) {
                    return write(
                        `Rendered ${node.dataset.filteredCount || 0} grid rows.`,
                        "success"
                    );
                }

                return node;
            }
        },
        {
            name:
                "grid-filter",

            category:
                "visualization",

            description:
                "Filter the active grid.",

            usage:
                "grid-filter [query]",

            handler: ({
                args = [],
                context,
                writeJSON
            }) => {
                const instance =
                    (
                        context.gridRenderer ||
                        initialize(
                            context
                        )
                    ).activeInstance();

                if (!instance) {
                    throw new Error(
                        "No active grid renderer is available."
                    );
                }

                const query =
                    args.join(
                        " "
                    );

                instance.view.setFilter(
                    query
                );

                const status =
                    instance.status();

                return typeof writeJSON ===
                    "function"
                        ? writeJSON(
                            status
                        )
                        : status;
            }
        },

        {
            name:
                "grid-sort",

            category:
                "visualization",

            description:
                "Sort the active grid.",

            usage:
                "grid-sort <column> [asc|desc]",

            handler: ({
                args = [],
                context,
                writeJSON
            }) => {
                const instance =
                    (
                        context.gridRenderer ||
                        initialize(
                            context
                        )
                    ).activeInstance();

                if (!instance) {
                    throw new Error(
                        "No active grid renderer is available."
                    );
                }

                if (!args[0]) {
                    throw new Error(
                        "Usage: grid-sort <column> [asc|desc]"
                    );
                }

                instance.view.setSort(
                    args[0],
                    args[1] ||
                    "asc"
                );

                const status =
                    instance.status();

                return typeof writeJSON ===
                    "function"
                        ? writeJSON(
                            status
                        )
                        : status;
            }
        },

        {
            name:
                "grid-export",

            category:
                "visualization",

            description:
                "Export the active grid as CSV or JSON.",

            usage:
                "grid-export <csv|json> [filename] [--selection] [--filtered]",

            handler: ({
                args = [],
                context,
                write
            }) => {
                const instance =
                    (
                        context.gridRenderer ||
                        initialize(
                            context
                        )
                    ).activeInstance();

                if (!instance) {
                    throw new Error(
                        "No active grid renderer is available."
                    );
                }

                const format =
                    String(
                        args[0] ||
                        "csv"
                    ).toLowerCase();

                const filename =
                    args[1] ||
                    `speciedex-grid.${format === "json" ? "json" : "csv"}`;

                const options = {
                    selection:
                        args.includes(
                            "--selection"
                        ),
                    filtered:
                        args.includes(
                            "--filtered"
                        )
                };

                const content =
                    format ===
                        "json"
                        ? instance.toJSON(
                            options
                        )
                        : instance.toCSV(
                            options
                        );

                const exporter =
                    context.exporter ||
                    context.services?.get?.(
                        "export"
                    );

                const result =
                    exporter
                        ? exporter.text(
                            content,
                            filename,
                            format ===
                                "json"
                                ? "application/json;charset=utf-8"
                                : "text/csv;charset=utf-8",
                            {
                                format
                            }
                        )
                        : (() => {
                            const blob =
                                new Blob(
                                    [
                                        content
                                    ],
                                    {
                                        type:
                                            format ===
                                                "json"
                                                ? "application/json;charset=utf-8"
                                                : "text/csv;charset=utf-8"
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

                            return {
                                filename
                            };
                        })();

                return typeof write ===
                    "function"
                        ? write(
                            `Grid exported to ${result.filename || filename}.`,
                            "success"
                        )
                        : result;
            }
        },

        {
            name: "grid-status",
            category: "visualization",
            description:
                "Show grid-renderer status.",
            usage:
                "grid-status",
            handler: ({
                context,
                writeJSON
            }) => {
                const renderer =
                    context.gridRenderer ||
                    initialize(context);

                const status = {
                    name:
                        MODULE_NAME,
                    ...renderer.status(),
                    defaultPageSize:
                        DEFAULT_PAGE_SIZE,
                    maximumPageSize:
                        MAX_PAGE_SIZE,
                    limits: {
                        rows:
                            DEFAULT_MAX_ROWS,
                        columns:
                            DEFAULT_MAX_COLUMNS,
                        selection:
                            DEFAULT_SELECTION_LIMIT
                    }
                };

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
        RENDERER_SYMBOL,
        INSTANCE_SYMBOL,
        GridRenderer,
        GridView,
        clone,
        rowIdentity,
        normalizeInput,
        normalizeColumns,
        compareValues,
        filterRows,
        sortRows,
        render,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalGrid =
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
