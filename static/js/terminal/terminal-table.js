/*
========================================================================
Speciedex.org
Terminal Table Renderer
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Table";
    const DEFAULT_PAGE_SIZE = 25;
    const DEFAULT_MAX_ROWS = 5000;
    const DEFAULT_EMPTY_TEXT = "No records.";
    const DEFAULT_NULL_TEXT = "—";

    function isObject(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    function clone(value) {
        if (typeof structuredClone === "function") {
            try {
                return structuredClone(value);
            } catch (error) {
                /* Fall through. */
            }
        }

        if (value === undefined || value === null || typeof value !== "object") {
            return value;
        }

        try {
            return JSON.parse(JSON.stringify(value));
        } catch (error) {
            return value;
        }
    }

    function parseBoolean(value, fallback = false) {
        if (typeof value === "boolean") {
            return value;
        }

        if (value === undefined || value === null || value === "") {
            return fallback;
        }

        return ["1", "true", "yes", "on", "enabled"].includes(
            String(value).trim().toLowerCase()
        );
    }

    function parseNumber(value, fallback, minimum = -Infinity, maximum = Infinity) {
        const number = Number(value);

        if (!Number.isFinite(number)) {
            return fallback;
        }

        return Math.min(maximum, Math.max(minimum, number));
    }

    function normalizeKey(value) {
        return String(value ?? "")
            .trim()
            .replace(/\s+/g, " ");
    }

    function titleCase(value) {
        return normalizeKey(value)
            .replace(/[_-]+/g, " ")
            .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
            .replace(/\b\w/g, (character) => character.toUpperCase());
    }

    function safeDispatch(target, name, detail) {
        try {
            target.dispatchEvent(new CustomEvent(name, { detail }));
        } catch (error) {
            /* Renderer events must not interrupt rendering. */
        }
    }

    function stringifyValue(value, options = {}) {
        const nullText = options.nullText ?? DEFAULT_NULL_TEXT;

        if (value === null || value === undefined) {
            return nullText;
        }

        if (typeof value === "string") {
            return value;
        }

        if (typeof value === "number" || typeof value === "bigint") {
            return String(value);
        }

        if (typeof value === "boolean") {
            return value ? "true" : "false";
        }

        if (value instanceof Date) {
            return value.toISOString();
        }

        if (Array.isArray(value)) {
            if (options.joinArrays !== false) {
                return value.map((item) => stringifyValue(item, options)).join(", ");
            }
            return JSON.stringify(value);
        }

        if (isObject(value)) {
            try {
                return options.prettyObjects
                    ? JSON.stringify(value, null, 2)
                    : JSON.stringify(value);
            } catch (error) {
                return String(value);
            }
        }

        return String(value);
    }

    function compareValues(left, right, direction = "asc") {
        const multiplier = direction === "desc" ? -1 : 1;

        if (left === right) {
            return 0;
        }

        if (left === null || left === undefined) {
            return 1 * multiplier;
        }

        if (right === null || right === undefined) {
            return -1 * multiplier;
        }

        if (typeof left === "number" && typeof right === "number") {
            return (left - right) * multiplier;
        }

        if (typeof left === "boolean" && typeof right === "boolean") {
            return ((left === right ? 0 : left ? 1 : -1) * multiplier);
        }

        const leftDate = left instanceof Date ? left.getTime() : Date.parse(left);
        const rightDate = right instanceof Date ? right.getTime() : Date.parse(right);

        if (
            Number.isFinite(leftDate) &&
            Number.isFinite(rightDate) &&
            typeof left !== "number" &&
            typeof right !== "number"
        ) {
            return (leftDate - rightDate) * multiplier;
        }

        return String(left).localeCompare(String(right), undefined, {
            numeric: true,
            sensitivity: "base"
        }) * multiplier;
    }

    function flattenObject(value, prefix = "", output = {}) {
        if (!isObject(value)) {
            return output;
        }

        for (const [key, item] of Object.entries(value)) {
            const path = prefix ? `${prefix}.${key}` : key;

            if (isObject(item)) {
                flattenObject(item, path, output);
            } else {
                output[path] = item;
            }
        }

        return output;
    }

    function normalizeRows(data, options = {}) {
        if (data === null || data === undefined) {
            return [];
        }

        if (Array.isArray(data)) {
            return data.map((row, index) => {
                if (isObject(row)) {
                    return options.flatten === true ? flattenObject(row) : { ...row };
                }

                if (Array.isArray(row)) {
                    const mapped = {};
                    row.forEach((value, columnIndex) => {
                        mapped[`column_${columnIndex + 1}`] = value;
                    });
                    return mapped;
                }

                return {
                    value: row,
                    index
                };
            });
        }

        if (data instanceof Map) {
            return Array.from(data.entries()).map(([key, value]) => {
                if (isObject(value)) {
                    return {
                        key,
                        ...(options.flatten === true ? flattenObject(value) : value)
                    };
                }

                return {
                    key,
                    value
                };
            });
        }

        if (isObject(data)) {
            if (Array.isArray(data.rows)) {
                return normalizeRows(data.rows, options);
            }

            if (Array.isArray(data.data)) {
                return normalizeRows(data.data, options);
            }

            if (options.objectMode === "entries") {
                return Object.entries(data).map(([key, value]) => ({
                    key,
                    value
                }));
            }

            return [options.flatten === true ? flattenObject(data) : { ...data }];
        }

        return [{ value: data }];
    }

    function inferColumns(rows, options = {}) {
        if (Array.isArray(options.columns) && options.columns.length) {
            return options.columns.map((column) => {
                if (typeof column === "string") {
                    return {
                        key: column,
                        label: titleCase(column),
                        sortable: true,
                        visible: true
                    };
                }

                return {
                    key: normalizeKey(column.key || column.name),
                    label: column.label || titleCase(column.key || column.name),
                    sortable: column.sortable !== false,
                    visible: column.visible !== false,
                    align: column.align || null,
                    formatter: typeof column.formatter === "function"
                        ? column.formatter
                        : null,
                    className: column.className || "",
                    width: column.width || null
                };
            }).filter((column) => column.key);
        }

        const keys = [];
        const seen = new Set();

        for (const row of rows) {
            for (const key of Object.keys(row || {})) {
                if (!seen.has(key)) {
                    seen.add(key);
                    keys.push(key);
                }
            }
        }

        return keys.map((key) => ({
            key,
            label: titleCase(key),
            sortable: true,
            visible: true,
            align: null,
            formatter: null,
            className: "",
            width: null
        }));
    }

    function createElement(tagName, className, text) {
        const element = document.createElement(tagName);

        if (className) {
            element.className = className;
        }

        if (text !== undefined) {
            element.textContent = text;
        }

        return element;
    }

    class TableRenderer extends EventTarget {
        constructor(context = {}) {
            super();
            this.context = context;
            this.instances = new Set();
        }

        _emit(type, detail = {}) {
            const event = {
                type,
                timestamp: new Date().toISOString(),
                ...detail
            };

            safeDispatch(this, type, event);

            try {
                this.context.events?.emit?.(`table:${type}`, event);
            } catch (error) {
                /* Context event bus is optional. */
            }

            return event;
        }

        render(data, options = {}) {
            const rows = normalizeRows(data, options);
            const columns = inferColumns(rows, options);
            const maxRows = parseNumber(
                options.maxRows,
                DEFAULT_MAX_ROWS,
                1,
                100000
            );
            const pageSize = parseNumber(
                options.pageSize,
                DEFAULT_PAGE_SIZE,
                1,
                maxRows
            );
            const state = {
                rows: rows.slice(0, maxRows),
                filteredRows: rows.slice(0, maxRows),
                columns,
                page: 1,
                pageSize,
                sortKey: options.sortKey || null,
                sortDirection: options.sortDirection === "desc" ? "desc" : "asc",
                query: "",
                selected: new Set(),
                destroyed: false
            };

            const container = createElement(
                "div",
                "terminal-renderer terminal-renderer-table"
            );
            container.dataset.renderer = "table";
            container.dataset.rows = String(state.rows.length);
            container.dataset.columns = String(columns.length);
            container.setAttribute("role", "region");
            container.setAttribute(
                "aria-label",
                options.ariaLabel || options.title || "Terminal table"
            );

            const header = createElement("div", "terminal-table-header");

            if (options.title) {
                const heading = createElement(
                    "h3",
                    "terminal-table-title",
                    options.title
                );
                header.appendChild(heading);
            }

            if (options.description) {
                const description = createElement(
                    "p",
                    "terminal-table-description",
                    options.description
                );
                header.appendChild(description);
            }

            const controls = createElement("div", "terminal-table-controls");
            const status = createElement("div", "terminal-table-status");
            status.setAttribute("aria-live", "polite");

            let searchInput = null;

            if (options.searchable !== false && state.rows.length) {
                const searchLabel = createElement(
                    "label",
                    "terminal-table-search"
                );
                const searchText = createElement(
                    "span",
                    "terminal-table-search-label",
                    options.searchLabel || "Filter"
                );
                searchInput = document.createElement("input");
                searchInput.type = "search";
                searchInput.placeholder = options.searchPlaceholder || "Filter rows…";
                searchInput.autocomplete = "off";
                searchInput.spellcheck = false;
                searchInput.setAttribute("aria-label", options.searchLabel || "Filter table");
                searchLabel.append(searchText, searchInput);
                controls.appendChild(searchLabel);
            }

            if (options.exportable === true) {
                const exportButton = createElement(
                    "button",
                    "terminal-table-export",
                    options.exportLabel || "Export CSV"
                );
                exportButton.type = "button";
                controls.appendChild(exportButton);

                exportButton.addEventListener("click", () => {
                    const csv = this.toCSV(state.filteredRows, {
                        columns: state.columns,
                        includeHeader: true
                    });

                    this._emit("export", {
                        format: "csv",
                        rows: state.filteredRows.length,
                        csv
                    });

                    if (options.download !== false) {
                        const blob = new Blob([csv], {
                            type: "text/csv;charset=utf-8"
                        });
                        const url = URL.createObjectURL(blob);
                        const anchor = document.createElement("a");
                        anchor.href = url;
                        anchor.download = options.filename || "speciedex-table.csv";
                        document.body.appendChild(anchor);
                        anchor.click();
                        anchor.remove();
                        URL.revokeObjectURL(url);
                    }
                });
            }

            if (controls.childNodes.length) {
                header.appendChild(controls);
            }

            header.appendChild(status);
            container.appendChild(header);

            const viewport = createElement(
                "div",
                "terminal-table-viewport"
            );
            viewport.tabIndex = 0;

            const table = document.createElement("table");
            table.className = "terminal-table";
            table.setAttribute("role", "table");

            if (options.caption) {
                const caption = document.createElement("caption");
                caption.textContent = options.caption;
                table.appendChild(caption);
            }

            const thead = document.createElement("thead");
            const headRow = document.createElement("tr");
            const tbody = document.createElement("tbody");

            if (options.selectable === true) {
                const selectionHeader = document.createElement("th");
                selectionHeader.scope = "col";
                selectionHeader.className = "terminal-table-selection-column";

                const selectAll = document.createElement("input");
                selectAll.type = "checkbox";
                selectAll.setAttribute("aria-label", "Select all visible rows");
                selectionHeader.appendChild(selectAll);
                headRow.appendChild(selectionHeader);

                selectAll.addEventListener("change", () => {
                    const pageRows = currentPageRows();

                    for (const item of pageRows) {
                        if (selectAll.checked) {
                            state.selected.add(item.index);
                        } else {
                            state.selected.delete(item.index);
                        }
                    }

                    renderBody();
                    emitSelection();
                });
            }

            const visibleColumns = () => state.columns.filter((column) => column.visible !== false);

            for (const column of visibleColumns()) {
                const th = document.createElement("th");
                th.scope = "col";
                th.dataset.column = column.key;

                if (column.width) {
                    th.style.width = String(column.width);
                }

                if (column.sortable !== false && options.sortable !== false) {
                    const button = createElement(
                        "button",
                        "terminal-table-sort",
                        column.label
                    );
                    button.type = "button";
                    button.dataset.column = column.key;
                    button.setAttribute("aria-sort", "none");

                    button.addEventListener("click", () => {
                        if (state.sortKey === column.key) {
                            state.sortDirection =
                                state.sortDirection === "asc" ? "desc" : "asc";
                        } else {
                            state.sortKey = column.key;
                            state.sortDirection = "asc";
                        }

                        state.page = 1;
                        applyFilterAndSort();
                        updateSortIndicators();
                        renderBody();

                        this._emit("sort", {
                            key: state.sortKey,
                            direction: state.sortDirection
                        });
                    });

                    th.appendChild(button);
                } else {
                    th.textContent = column.label;
                }

                headRow.appendChild(th);
            }

            thead.appendChild(headRow);
            table.append(thead, tbody);
            viewport.appendChild(table);
            container.appendChild(viewport);

            const footer = createElement("div", "terminal-table-footer");
            const pagination = createElement("div", "terminal-table-pagination");
            let previousButton = null;
            let nextButton = null;
            let pageLabel = null;

            if (options.paginate !== false && state.rows.length > pageSize) {
                previousButton = createElement(
                    "button",
                    "terminal-table-page-previous",
                    options.previousLabel || "Previous"
                );
                previousButton.type = "button";

                pageLabel = createElement(
                    "span",
                    "terminal-table-page-label"
                );
                pageLabel.setAttribute("aria-live", "polite");

                nextButton = createElement(
                    "button",
                    "terminal-table-page-next",
                    options.nextLabel || "Next"
                );
                nextButton.type = "button";

                previousButton.addEventListener("click", () => {
                    if (state.page > 1) {
                        state.page -= 1;
                        renderBody();
                    }
                });

                nextButton.addEventListener("click", () => {
                    if (state.page < pageCount()) {
                        state.page += 1;
                        renderBody();
                    }
                });

                pagination.append(previousButton, pageLabel, nextButton);
                footer.appendChild(pagination);
            }

            if (options.summary !== false) {
                footer.appendChild(
                    createElement("div", "terminal-table-summary")
                );
            }

            if (footer.childNodes.length) {
                container.appendChild(footer);
            }

            const empty = createElement(
                "div",
                "terminal-table-empty",
                options.emptyText || DEFAULT_EMPTY_TEXT
            );
            empty.hidden = true;
            container.appendChild(empty);

            function pageCount() {
                return Math.max(
                    1,
                    Math.ceil(state.filteredRows.length / state.pageSize)
                );
            }

            function currentPageRows() {
                const start = (state.page - 1) * state.pageSize;
                return state.filteredRows.slice(start, start + state.pageSize);
            }

            function applyFilterAndSort() {
                const query = state.query.trim().toLowerCase();

                state.filteredRows = state.rows
                    .map((row, index) => ({ row, index }))
                    .filter(({ row }) => {
                        if (!query) {
                            return true;
                        }

                        return visibleColumns().some((column) => {
                            return stringifyValue(row[column.key], options)
                                .toLowerCase()
                                .includes(query);
                        });
                    });

                if (state.sortKey) {
                    state.filteredRows.sort((left, right) => {
                        return compareValues(
                            left.row[state.sortKey],
                            right.row[state.sortKey],
                            state.sortDirection
                        );
                    });
                }

                if (state.page > pageCount()) {
                    state.page = pageCount();
                }
            }

            function updateSortIndicators() {
                for (const button of headRow.querySelectorAll(".terminal-table-sort")) {
                    const active = button.dataset.column === state.sortKey;
                    button.setAttribute(
                        "aria-sort",
                        active
                            ? state.sortDirection === "asc"
                                ? "ascending"
                                : "descending"
                            : "none"
                    );
                    button.classList.toggle("is-sorted", active);
                    button.classList.toggle(
                        "is-descending",
                        active && state.sortDirection === "desc"
                    );
                }
            }

            function emitSelection() {
                const selectedRows = Array.from(state.selected)
                    .map((index) => state.rows[index])
                    .filter(Boolean)
                    .map(clone);

                safeDispatch(container, "terminal-table-selection", {
                    selected: selectedRows,
                    indexes: Array.from(state.selected)
                });
            }

            const formatCell = (value, column, row, rowIndex) => {
                if (typeof column.formatter === "function") {
                    try {
                        return column.formatter(value, row, rowIndex, column);
                    } catch (error) {
                        return stringifyValue(value, options);
                    }
                }

                if (typeof options.formatter === "function") {
                    try {
                        return options.formatter(
                            value,
                            column.key,
                            row,
                            rowIndex
                        );
                    } catch (error) {
                        return stringifyValue(value, options);
                    }
                }

                return stringifyValue(value, options);
            };

            function renderBody() {
                tbody.replaceChildren();

                const pageRows = currentPageRows();
                const hasRows = pageRows.length > 0;
                table.hidden = !hasRows;
                empty.hidden = hasRows;

                for (const item of pageRows) {
                    const tr = document.createElement("tr");
                    tr.dataset.rowIndex = String(item.index);

                    if (typeof options.rowClassName === "function") {
                        const rowClass = options.rowClassName(item.row, item.index);
                        if (rowClass) {
                            tr.classList.add(...String(rowClass).split(/\s+/).filter(Boolean));
                        }
                    }

                    if (options.selectable === true) {
                        const selectionCell = document.createElement("td");
                        selectionCell.className = "terminal-table-selection-cell";

                        const checkbox = document.createElement("input");
                        checkbox.type = "checkbox";
                        checkbox.checked = state.selected.has(item.index);
                        checkbox.setAttribute(
                            "aria-label",
                            `Select row ${item.index + 1}`
                        );

                        checkbox.addEventListener("change", () => {
                            if (checkbox.checked) {
                                state.selected.add(item.index);
                            } else {
                                state.selected.delete(item.index);
                            }
                            emitSelection();
                        });

                        selectionCell.appendChild(checkbox);
                        tr.appendChild(selectionCell);
                    }

                    for (const column of visibleColumns()) {
                        const td = document.createElement("td");
                        td.dataset.column = column.key;

                        if (column.align) {
                            td.dataset.align = column.align;
                        }

                        if (column.className) {
                            td.classList.add(
                                ...String(column.className).split(/\s+/).filter(Boolean)
                            );
                        }

                        const formatted = formatCell(
                            item.row[column.key],
                            column,
                            item.row,
                            item.index
                        );

                        if (formatted instanceof Node) {
                            td.appendChild(formatted);
                        } else {
                            td.textContent = String(formatted ?? "");
                        }

                        tr.appendChild(td);
                    }

                    if (typeof options.onRowClick === "function") {
                        tr.tabIndex = 0;
                        tr.classList.add("is-interactive");

                        const activate = () => {
                            options.onRowClick(
                                clone(item.row),
                                item.index,
                                tr
                            );
                        };

                        tr.addEventListener("click", activate);
                        tr.addEventListener("keydown", (event) => {
                            if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                activate();
                            }
                        });
                    }

                    tbody.appendChild(tr);
                }

                const totalPages = pageCount();

                if (pageLabel) {
                    pageLabel.textContent =
                        `Page ${state.page} of ${totalPages}`;
                }

                if (previousButton) {
                    previousButton.disabled = state.page <= 1;
                }

                if (nextButton) {
                    nextButton.disabled = state.page >= totalPages;
                }

                const summary = footer.querySelector(".terminal-table-summary");
                if (summary) {
                    const start = state.filteredRows.length
                        ? (state.page - 1) * state.pageSize + 1
                        : 0;
                    const end = Math.min(
                        state.page * state.pageSize,
                        state.filteredRows.length
                    );

                    summary.textContent =
                        `${start}–${end} of ${state.filteredRows.length}` +
                        (state.filteredRows.length !== state.rows.length
                            ? ` filtered from ${state.rows.length}`
                            : "");
                }

                status.textContent =
                    `${state.filteredRows.length} row` +
                    (state.filteredRows.length === 1 ? "" : "s") +
                    `, ${visibleColumns().length} column` +
                    (visibleColumns().length === 1 ? "" : "s");

                container.dataset.filteredRows = String(state.filteredRows.length);
                container.dataset.page = String(state.page);
            }

            if (searchInput) {
                searchInput.addEventListener("input", () => {
                    state.query = searchInput.value;
                    state.page = 1;
                    applyFilterAndSort();
                    renderBody();

                    this._emit("filter", {
                        query: state.query,
                        matches: state.filteredRows.length
                    });
                });
            }

            if (state.sortKey) {
                applyFilterAndSort();
                updateSortIndicators();
            }

            renderBody();

            const instance = {
                element: container,
                state,
                refresh: (nextData = data, nextOptions = {}) => {
                    if (state.destroyed) {
                        return container;
                    }

                    const nextRows = normalizeRows(nextData, {
                        ...options,
                        ...nextOptions
                    }).slice(0, maxRows);
                    state.rows = nextRows;
                    state.columns = inferColumns(nextRows, {
                        ...options,
                        ...nextOptions
                    });
                    state.page = 1;
                    applyFilterAndSort();
                    renderBody();
                    return container;
                },
                setFilter: (query = "") => {
                    state.query = String(query);
                    if (searchInput) {
                        searchInput.value = state.query;
                    }
                    state.page = 1;
                    applyFilterAndSort();
                    renderBody();
                    return state.filteredRows.length;
                },
                setSort: (key, direction = "asc") => {
                    state.sortKey = key || null;
                    state.sortDirection = direction === "desc" ? "desc" : "asc";
                    state.page = 1;
                    applyFilterAndSort();
                    updateSortIndicators();
                    renderBody();
                    return {
                        key: state.sortKey,
                        direction: state.sortDirection
                    };
                },
                getRows: ({ filtered = false } = {}) => {
                    return (filtered
                        ? state.filteredRows.map((item) => item.row)
                        : state.rows
                    ).map(clone);
                },
                getSelected: () => {
                    return Array.from(state.selected)
                        .map((index) => state.rows[index])
                        .filter(Boolean)
                        .map(clone);
                },
                toCSV: (csvOptions = {}) => {
                    const source = csvOptions.filtered === false
                        ? state.rows
                        : state.filteredRows.map((item) => item.row);

                    return this.toCSV(source, {
                        columns: state.columns,
                        ...csvOptions
                    });
                },
                destroy: () => {
                    if (state.destroyed) {
                        return false;
                    }

                    state.destroyed = true;
                    this.instances.delete(instance);
                    container.remove();
                    this._emit("destroy", {});
                    return true;
                }
            };

            container.tableInstance = instance;
            this.instances.add(instance);

            this._emit("render", {
                rows: state.rows.length,
                columns: columns.length,
                element: container
            });

            return container;
        }

        toCSV(data, options = {}) {
            const rows = normalizeRows(data, options);
            const columns = inferColumns(rows, options)
                .filter((column) => column.visible !== false);
            const delimiter = options.delimiter || ",";
            const newline = options.newline || "\r\n";

            const escape = (value) => {
                const text = stringifyValue(value, {
                    ...options,
                    nullText: options.nullText ?? ""
                });

                if (
                    text.includes(delimiter) ||
                    text.includes('"') ||
                    text.includes("\n") ||
                    text.includes("\r")
                ) {
                    return `"${text.replace(/"/g, '""')}"`;
                }

                return text;
            };

            const lines = [];

            if (options.includeHeader !== false) {
                lines.push(columns.map((column) => escape(column.label)).join(delimiter));
            }

            for (const row of rows) {
                lines.push(
                    columns.map((column) => escape(row[column.key])).join(delimiter)
                );
            }

            return lines.join(newline);
        }

        destroy() {
            for (const instance of Array.from(this.instances)) {
                instance.destroy();
            }

            this.instances.clear();
            return true;
        }
    }

    function render(data, options = {}) {
        const renderer = new TableRenderer({});
        return renderer.render(data, options);
    }

    function initialize(context = {}) {
        const renderer = new TableRenderer(context);
        context.registerRenderer?.("table", renderer);
        context.tableRenderer = renderer;

        safeDispatch(document, "speciedex:terminal-table-ready", {
            renderer
        });

        return renderer;
    }

    const commands = [];

    const api = Object.freeze({
        name: MODULE_NAME,
        TableRenderer,
        render,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalTable = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(
        new CustomEvent("speciedex:terminal-module-available", {
            detail: {
                name: MODULE_NAME,
                module: api
            }
        })
    );
})(window, document);
