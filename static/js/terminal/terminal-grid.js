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
    const VERSION = "2.0.0";

    const DEFAULT_PAGE_SIZE = 25;
    const MIN_PAGE_SIZE = 1;
    const MAX_PAGE_SIZE = 500;

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

    function normalizeInput(data) {
        if (typeof data === "string") {
            const trimmed = data.trim();

            if (!trimmed) {
                return [];
            }

            try {
                return normalizeInput(
                    JSON.parse(trimmed)
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
            return data.map((row, index) => {
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

        if (isPlainObject(data)) {
            return Object.entries(data).map(
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

    function normalizeColumns(rows, columns = null) {
        if (
            Array.isArray(columns) &&
            columns.length
        ) {
            return columns.map(column => {
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

        return keys.map(key => ({
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

    function sortRows(rows, key, direction = "asc") {
        if (!key) {
            return [...rows];
        }

        const multiplier =
            String(direction).toLowerCase() === "desc"
                ? -1
                : 1;

        return [...rows].sort((left, right) =>
            compareValues(
                left[key],
                right[key]
            ) * multiplier
        );
    }

    class GridView extends EventTarget {
        constructor(data, options = {}) {
            super();

            this.rows =
                normalizeInput(data);

            this.columns =
                normalizeColumns(
                    this.rows,
                    options.columns
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
                    "No grid rows available."
            };

            this.root = null;
            this.table = null;
            this.summary = null;
            this.filterInput = null;
            this.pageLabel = null;
            this.previousButton = null;
            this.nextButton = null;
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
                    this.options.sortDirection
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
                () =>
                    this.setFilter(
                        filterInput.value
                    )
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
                        this.options.page - 1
                    )
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
                        this.options.page + 1
                    )
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
                        () =>
                            this.setSort(
                                column.key
                            )
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

        renderBody(rows) {
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

            for (const rowData of rows) {
                const row =
                    document.createElement(
                        "tr"
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
                        formatted instanceof
                        Node
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
            if (!this.table) {
                return;
            }

            const state =
                this.getPageState();

            this.table.replaceChildren(
                this.renderHeader(),
                this.renderBody(
                    state.rows
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
                    this.options.sortDirection
            };
        }
    }

    function render(data, options = {}) {
        const grid =
            new GridView(
                data,
                options
            );

        const node =
            grid.build();

        node.gridView = grid;

        return node;
    }

    function initialize(context) {
        if (
            context.gridRenderer &&
            context.gridRenderer.version ===
            VERSION
        ) {
            return context.gridRenderer;
        }

        const renderer =
            Object.freeze({
                name: MODULE_NAME,
                version: VERSION,
                render,
                normalizeInput,
                normalizeColumns,
                filterRows,
                sortRows,
                GridView
            });

        context.registerRenderer?.(
            "grid",
            renderer
        );

        context.registerRenderer?.(
            "data-grid",
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
                renderer
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
            filter: ""
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

                const node =
                    renderer.render(
                        data,
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
                        renderer.name,
                    version:
                        renderer.version,
                    defaultPageSize:
                        DEFAULT_PAGE_SIZE,
                    maximumPageSize:
                        MAX_PAGE_SIZE
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
        version: VERSION,
        GridView,
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
