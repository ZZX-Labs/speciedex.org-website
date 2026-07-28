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
    const VERSION = "2.2.0";

    const RENDERER_SYMBOL =
        Symbol.for("speciedex.terminal.table.renderer");

    const INSTANCE_SYMBOL =
        Symbol.for("speciedex.terminal.table.instance");

    const DEFAULT_PAGE_SIZE = 25;
    const DEFAULT_MAX_ROWS = 5000;
    const DEFAULT_EMPTY_TEXT = "No records.";
    const DEFAULT_NULL_TEXT = "—";
    const DEFAULT_FILTER_DEBOUNCE = 120;
    const DEFAULT_MAX_SELECTION = 10000;

    const activeDispatches = new WeakMap();

    function isObject(value) {
        return (
            value !== null &&
            typeof value === "object" &&
            !Array.isArray(value)
        );
    }

    function isElement(value) {
        return Boolean(
            value &&
            value.nodeType === 1 &&
            typeof value.querySelector === "function"
        );
    }

    function isNode(value) {
        return Boolean(
            value &&
            typeof value.nodeType === "number"
        );
    }

    function clone(value, seen = new WeakMap()) {
        if (
            value === undefined ||
            value === null ||
            typeof value !== "object"
        ) {
            return value;
        }

        if (typeof structuredClone === "function") {
            try {
                return structuredClone(value);
            } catch (_error) {
                /* Continue with deterministic fallback. */
            }
        }

        if (seen.has(value)) {
            return seen.get(value);
        }

        if (value instanceof Date) {
            return new Date(value.getTime());
        }

        if (value instanceof RegExp) {
            return new RegExp(value.source, value.flags);
        }

        if (value instanceof Map) {
            const output = new Map();
            seen.set(value, output);

            for (const [key, item] of value.entries()) {
                output.set(
                    clone(key, seen),
                    clone(item, seen)
                );
            }

            return output;
        }

        if (value instanceof Set) {
            const output = new Set();
            seen.set(value, output);

            for (const item of value.values()) {
                output.add(clone(item, seen));
            }

            return output;
        }

        if (Array.isArray(value)) {
            const output = [];
            seen.set(value, output);

            for (const item of value) {
                output.push(clone(item, seen));
            }

            return output;
        }

        const output = {};
        seen.set(value, output);

        for (const [key, item] of Object.entries(value)) {
            if (
                key === "__proto__" ||
                key === "prototype" ||
                key === "constructor"
            ) {
                continue;
            }

            output[key] = clone(item, seen);
        }

        return output;
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
            String(value).trim().toLowerCase();

        if (
            ["1", "true", "yes", "on", "enabled"].includes(normalized)
        ) {
            return true;
        }

        if (
            ["0", "false", "no", "off", "disabled"].includes(normalized)
        ) {
            return false;
        }

        return fallback;
    }

    function parseNumber(
        value,
        fallback,
        minimum = -Infinity,
        maximum = Infinity
    ) {
        const number = Number(value);

        if (!Number.isFinite(number)) {
            return fallback;
        }

        return Math.min(maximum, Math.max(minimum, number));
    }

    function parseInteger(
        value,
        fallback,
        minimum = Number.MIN_SAFE_INTEGER,
        maximum = Number.MAX_SAFE_INTEGER
    ) {
        const number = Number.parseInt(value, 10);

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
            .replace(/\b\w/g, character => character.toUpperCase());
    }

    function safeDispatch(target, name, detail) {
        if (
            !target ||
            typeof target.dispatchEvent !== "function" ||
            !name
        ) {
            return false;
        }

        let names = activeDispatches.get(target);

        if (!names) {
            names = new Set();
            activeDispatches.set(target, names);
        }

        if (names.has(name)) {
            return false;
        }

        names.add(name);

        try {
            return target.dispatchEvent(
                new CustomEvent(name, { detail })
            );
        } catch (_error) {
            return false;
        } finally {
            names.delete(name);
        }
    }

    function stringifyValue(value, options = {}) {
        const nullText =
            options.nullText ?? DEFAULT_NULL_TEXT;

        if (value === null || value === undefined) {
            return nullText;
        }

        if (typeof value === "string") {
            return value;
        }

        if (
            typeof value === "number" ||
            typeof value === "bigint"
        ) {
            return String(value);
        }

        if (typeof value === "boolean") {
            return value ? "true" : "false";
        }

        if (value instanceof Date) {
            return Number.isNaN(value.getTime())
                ? String(value)
                : value.toISOString();
        }

        if (Array.isArray(value)) {
            if (options.joinArrays !== false) {
                return value
                    .map(item => stringifyValue(item, options))
                    .join(", ");
            }

            try {
                return JSON.stringify(value);
            } catch (_error) {
                return String(value);
            }
        }

        if (isObject(value)) {
            try {
                return options.prettyObjects
                    ? JSON.stringify(value, null, 2)
                    : JSON.stringify(value);
            } catch (_error) {
                return String(value);
            }
        }

        return String(value);
    }

    function parseComparableDate(value) {
        if (value instanceof Date) {
            const time = value.getTime();
            return Number.isFinite(time) ? time : NaN;
        }

        if (typeof value !== "string") {
            return NaN;
        }

        const trimmed = value.trim();

        if (
            !trimmed ||
            !(
                /^\d{4}-\d{2}-\d{2}/.test(trimmed) ||
                /^\d{1,2}\/\d{1,2}\/\d{4}/.test(trimmed)
            )
        ) {
            return NaN;
        }

        return Date.parse(trimmed);
    }

    function compareValues(left, right, direction = "asc") {
        const multiplier =
            direction === "desc" ? -1 : 1;

        if (Object.is(left, right)) {
            return 0;
        }

        if (left === null || left === undefined) {
            return 1 * multiplier;
        }

        if (right === null || right === undefined) {
            return -1 * multiplier;
        }

        if (
            typeof left === "number" &&
            typeof right === "number"
        ) {
            return (left - right) * multiplier;
        }

        if (
            typeof left === "bigint" &&
            typeof right === "bigint"
        ) {
            return (
                left < right ? -1 :
                left > right ? 1 :
                0
            ) * multiplier;
        }

        if (
            typeof left === "boolean" &&
            typeof right === "boolean"
        ) {
            return (
                left === right ? 0 :
                left ? 1 :
                -1
            ) * multiplier;
        }

        const leftDate = parseComparableDate(left);
        const rightDate = parseComparableDate(right);

        if (
            Number.isFinite(leftDate) &&
            Number.isFinite(rightDate)
        ) {
            return (leftDate - rightDate) * multiplier;
        }

        return String(left).localeCompare(
            String(right),
            undefined,
            {
                numeric: true,
                sensitivity: "base"
            }
        ) * multiplier;
    }

    function flattenObject(
        value,
        prefix = "",
        output = {},
        seen = new WeakSet(),
        depth = 0
    ) {
        if (
            !isObject(value) ||
            depth > 8
        ) {
            return output;
        }

        if (seen.has(value)) {
            return output;
        }

        seen.add(value);

        for (const [key, item] of Object.entries(value)) {
            const path = prefix
                ? `${prefix}.${key}`
                : key;

            if (isObject(item)) {
                flattenObject(
                    item,
                    path,
                    output,
                    seen,
                    depth + 1
                );
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
                    return options.flatten === true
                        ? flattenObject(row)
                        : { ...row };
                }

                if (Array.isArray(row)) {
                    const mapped = {};

                    row.forEach((value, columnIndex) => {
                        mapped[
                            `column_${columnIndex + 1}`
                        ] = value;
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
            return Array.from(data.entries())
                .map(([key, value]) => {
                    if (isObject(value)) {
                        return {
                            key,
                            ...(
                                options.flatten === true
                                    ? flattenObject(value)
                                    : value
                            )
                        };
                    }

                    return {
                        key,
                        value
                    };
                });
        }

        if (data instanceof Set) {
            return normalizeRows(
                Array.from(data.values()),
                options
            );
        }

        if (isObject(data)) {
            for (const key of [
                "rows",
                "data",
                "records",
                "results",
                "items",
                "species",
                "providers",
                "taxa",
                "entries"
            ]) {
                if (Array.isArray(data[key])) {
                    return normalizeRows(
                        data[key],
                        options
                    );
                }

                if (
                    isObject(data[key]) &&
                    options.unwrapObjects === true
                ) {
                    return normalizeRows(
                        data[key],
                        options
                    );
                }
            }

            if (options.objectMode === "entries") {
                return Object.entries(data)
                    .map(([key, value]) => ({
                        key,
                        value
                    }));
            }

            return [
                options.flatten === true
                    ? flattenObject(data)
                    : { ...data }
            ];
        }

        return [{ value: data }];
    }

    function normalizeColumn(column) {
        if (typeof column === "string") {
            const key = normalizeKey(column);

            return {
                key,
                label: titleCase(key),
                sortable: true,
                visible: true,
                align: null,
                formatter: null,
                className: "",
                width: null
            };
        }

        if (!isObject(column)) {
            return null;
        }

        const key =
            normalizeKey(column.key || column.name);

        if (!key) {
            return null;
        }

        return {
            ...column,
            key,
            label:
                column.label ||
                titleCase(key),
            sortable:
                column.sortable !== false,
            visible:
                column.visible !== false,
            align:
                column.align || null,
            formatter:
                typeof column.formatter === "function"
                    ? column.formatter
                    : null,
            className:
                column.className || "",
            width:
                column.width || null
        };
    }

    function inferColumns(rows, options = {}) {
        if (
            Array.isArray(options.columns) &&
            options.columns.length
        ) {
            return options.columns
                .map(normalizeColumn)
                .filter(Boolean);
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

        return keys.map(key =>
            normalizeColumn(key)
        );
    }

    function createElement(tagName, className, text) {
        const element =
            document.createElement(tagName);

        if (className) {
            element.className = className;
        }

        if (text !== undefined) {
            element.textContent = text;
        }

        return element;
    }

    function escapeCSVCell(value, delimiter, options) {
        const text = stringifyValue(value, {
            ...options,
            nullText:
                options.nullText ?? ""
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
    }

    class TableInstance extends EventTarget {
        constructor(renderer, data, options = {}) {
            super();

            this.renderer = renderer;
            this.options = { ...options };
            this.destroyed = false;

            this.state = {
                rows: [],
                filteredRows: [],
                columns: [],
                page: 1,
                pageSize: DEFAULT_PAGE_SIZE,
                sortKey: null,
                sortDirection: "asc",
                query: "",
                selected: new Set(),
                filterTimer: 0,
                renderGeneration: 0
            };

            this.elements = {
                container: null,
                header: null,
                controls: null,
                searchInput: null,
                exportButton: null,
                status: null,
                viewport: null,
                table: null,
                caption: null,
                thead: null,
                tbody: null,
                empty: null,
                footer: null,
                pagination: null,
                previousButton: null,
                pageLabel: null,
                nextButton: null,
                summary: null
            };

            this.bound = {
                searchInput: null,
                exportButton: null,
                previousButton: null,
                nextButton: null
            };

            this._buildShell();
            this.refresh(data, options, {
                initial: true
            });
        }

        assertActive() {
            if (this.destroyed) {
                throw new Error(
                    "Table instance has been destroyed."
                );
            }
        }

        _emit(type, detail = {}) {
            if (this.destroyed) {
                return null;
            }

            const event = {
                type,
                timestamp: new Date().toISOString(),
                instance: this,
                ...detail
            };

            safeDispatch(this, type, event);
            safeDispatch(
                this.elements.container,
                `terminal-table-${type}`,
                event
            );

            this.renderer?._emit?.(type, event);

            return event;
        }

        _buildShell() {
            const container = createElement(
                "div",
                "terminal-renderer terminal-renderer-table"
            );

            container.dataset.renderer = "table";
            container.setAttribute("role", "region");

            const header = createElement(
                "div",
                "terminal-table-header"
            );

            const controls = createElement(
                "div",
                "terminal-table-controls"
            );

            const status = createElement(
                "div",
                "terminal-table-status"
            );

            status.setAttribute("aria-live", "polite");
            status.setAttribute("aria-atomic", "true");

            const viewport = createElement(
                "div",
                "terminal-table-viewport"
            );

            viewport.tabIndex = 0;

            const table = document.createElement("table");
            table.className = "terminal-table";

            const thead = document.createElement("thead");
            const tbody = document.createElement("tbody");

            table.append(thead, tbody);
            viewport.appendChild(table);

            const empty = createElement(
                "div",
                "terminal-table-empty",
                DEFAULT_EMPTY_TEXT
            );

            empty.hidden = true;
            empty.setAttribute("role", "status");

            const footer = createElement(
                "div",
                "terminal-table-footer"
            );

            const pagination = createElement(
                "div",
                "terminal-table-pagination"
            );

            const summary = createElement(
                "div",
                "terminal-table-summary"
            );

            header.append(controls, status);
            footer.append(pagination, summary);
            container.append(
                header,
                viewport,
                empty,
                footer
            );

            this.elements = {
                ...this.elements,
                container,
                header,
                controls,
                status,
                viewport,
                table,
                thead,
                tbody,
                empty,
                footer,
                pagination,
                summary
            };

            container[INSTANCE_SYMBOL] = this;
            container.tableInstance = this;
            container.update = (...args) =>
                this.refresh(...args);
            container.setData = (...args) =>
                this.setData(...args);
            container.setRows = (...args) =>
                this.setRows(...args);
            container.ingest = (...args) =>
                this.ingest(...args);
            container.destroy = () =>
                this.destroy();

            this._syncHeaderText();
            this._syncControls();
        }

        _syncHeaderText() {
            const { header, controls, status } = this.elements;

            for (const element of header.querySelectorAll(
                ":scope > .terminal-table-title, :scope > .terminal-table-description"
            )) {
                element.remove();
            }

            if (this.options.title) {
                const heading = createElement(
                    "h3",
                    "terminal-table-title",
                    this.options.title
                );

                header.insertBefore(heading, controls);
            }

            if (this.options.description) {
                const description = createElement(
                    "p",
                    "terminal-table-description",
                    this.options.description
                );

                header.insertBefore(description, controls);
            }

            this.elements.container.setAttribute(
                "aria-label",
                this.options.ariaLabel ||
                this.options.title ||
                "Terminal table"
            );

            status.hidden =
                this.options.status === false;
        }

        _syncControls() {
            const { controls } = this.elements;
            controls.replaceChildren();

            this.elements.searchInput = null;
            this.elements.exportButton = null;

            if (
                this.options.searchable !== false &&
                this.state.rows.length
            ) {
                const searchLabel = createElement(
                    "label",
                    "terminal-table-search"
                );

                const searchText = createElement(
                    "span",
                    "terminal-table-search-label",
                    this.options.searchLabel || "Filter"
                );

                const input = document.createElement("input");
                input.type = "search";
                input.value = this.state.query;
                input.placeholder =
                    this.options.searchPlaceholder ||
                    "Filter rows…";
                input.autocomplete = "off";
                input.spellcheck = false;
                input.setAttribute(
                    "aria-label",
                    this.options.searchLabel ||
                    "Filter table"
                );

                input.addEventListener(
                    "input",
                    () => {
                        window.clearTimeout(
                            this.state.filterTimer
                        );

                        this.state.filterTimer =
                            window.setTimeout(
                                () => {
                                    this.state.filterTimer = 0;
                                    this.setFilter(input.value, {
                                        emit: true
                                    });
                                },
                                parseNumber(
                                    this.options.filterDebounce,
                                    DEFAULT_FILTER_DEBOUNCE,
                                    0,
                                    5000
                                )
                            );
                    }
                );

                searchLabel.append(searchText, input);
                controls.appendChild(searchLabel);
                this.elements.searchInput = input;
            }

            if (this.options.exportable === true) {
                const button = createElement(
                    "button",
                    "terminal-table-export",
                    this.options.exportLabel ||
                    "Export CSV"
                );

                button.type = "button";

                button.addEventListener("click", () => {
                    this.downloadCSV(
                        this.options.filename ||
                        "speciedex-table.csv"
                    );
                });

                controls.appendChild(button);
                this.elements.exportButton = button;
            }

            controls.hidden =
                controls.childNodes.length === 0;
        }

        _syncCaption() {
            const { table } = this.elements;
            const existing =
                table.querySelector(":scope > caption");

            if (existing) {
                existing.remove();
            }

            this.elements.caption = null;

            if (this.options.caption) {
                const caption =
                    document.createElement("caption");

                caption.textContent =
                    this.options.caption;

                table.insertBefore(
                    caption,
                    this.elements.thead
                );

                this.elements.caption = caption;
            }
        }

        _visibleColumns() {
            return this.state.columns
                .filter(column =>
                    column.visible !== false
                );
        }

        _pageCount() {
            return Math.max(
                1,
                Math.ceil(
                    this.state.filteredRows.length /
                    this.state.pageSize
                )
            );
        }

        _currentPageRows() {
            const start =
                (this.state.page - 1) *
                this.state.pageSize;

            return this.state.filteredRows
                .slice(
                    start,
                    start + this.state.pageSize
                );
        }

        _applyFilterAndSort() {
            const query =
                this.state.query
                    .trim()
                    .toLowerCase();

            const columns =
                this._visibleColumns();

            this.state.filteredRows =
                this.state.rows
                    .map((row, index) => ({
                        row,
                        index
                    }))
                    .filter(({ row }) => {
                        if (!query) {
                            return true;
                        }

                        return columns.some(column =>
                            stringifyValue(
                                row[column.key],
                                this.options
                            )
                                .toLowerCase()
                                .includes(query)
                        );
                    });

            if (this.state.sortKey) {
                const key = this.state.sortKey;
                const direction =
                    this.state.sortDirection;

                this.state.filteredRows.sort(
                    (left, right) => {
                        const compared = compareValues(
                            left.row[key],
                            right.row[key],
                            direction
                        );

                        if (compared !== 0) {
                            return compared;
                        }

                        return left.index - right.index;
                    }
                );
            }

            this.state.page = parseInteger(
                this.state.page,
                1,
                1,
                this._pageCount()
            );
        }

        _renderHead() {
            const { thead } = this.elements;
            thead.replaceChildren();

            const row = document.createElement("tr");

            if (this.options.selectable === true) {
                const th = document.createElement("th");
                th.scope = "col";
                th.className =
                    "terminal-table-selection-column";

                const checkbox =
                    document.createElement("input");

                checkbox.type = "checkbox";
                checkbox.setAttribute(
                    "aria-label",
                    "Select all visible rows"
                );

                const current =
                    this._currentPageRows();

                const selectedCount =
                    current.filter(item =>
                        this.state.selected.has(item.index)
                    ).length;

                checkbox.checked =
                    current.length > 0 &&
                    selectedCount === current.length;

                checkbox.indeterminate =
                    selectedCount > 0 &&
                    selectedCount < current.length;

                checkbox.addEventListener(
                    "change",
                    () => {
                        const limit = parseInteger(
                            this.options.maxSelection,
                            DEFAULT_MAX_SELECTION,
                            1,
                            1000000
                        );

                        for (const item of this._currentPageRows()) {
                            if (checkbox.checked) {
                                if (
                                    this.state.selected.size >=
                                    limit
                                ) {
                                    break;
                                }

                                this.state.selected.add(
                                    item.index
                                );
                            } else {
                                this.state.selected.delete(
                                    item.index
                                );
                            }
                        }

                        this._renderBody();
                        this._emitSelection();
                    }
                );

                th.appendChild(checkbox);
                row.appendChild(th);
            }

            for (const column of this._visibleColumns()) {
                const th = document.createElement("th");
                th.scope = "col";
                th.dataset.column = column.key;

                if (column.width) {
                    th.style.width =
                        String(column.width);
                }

                if (
                    column.sortable !== false &&
                    this.options.sortable !== false
                ) {
                    const button = createElement(
                        "button",
                        "terminal-table-sort",
                        column.label
                    );

                    button.type = "button";
                    button.dataset.column = column.key;

                    const active =
                        this.state.sortKey ===
                        column.key;

                    button.setAttribute(
                        "aria-sort",
                        active
                            ? (
                                this.state.sortDirection === "desc"
                                    ? "descending"
                                    : "ascending"
                            )
                            : "none"
                    );

                    button.classList.toggle(
                        "is-sorted",
                        active
                    );

                    button.classList.toggle(
                        "is-descending",
                        active &&
                        this.state.sortDirection === "desc"
                    );

                    button.addEventListener(
                        "click",
                        () => {
                            const direction =
                                this.state.sortKey ===
                                    column.key &&
                                this.state.sortDirection ===
                                    "asc"
                                    ? "desc"
                                    : "asc";

                            this.setSort(
                                column.key,
                                direction,
                                {
                                    emit: true
                                }
                            );
                        }
                    );

                    th.appendChild(button);
                } else {
                    th.textContent = column.label;
                }

                row.appendChild(th);
            }

            thead.appendChild(row);
        }

        _formatCell(value, column, row, rowIndex) {
            if (typeof column.formatter === "function") {
                try {
                    return column.formatter(
                        value,
                        row,
                        rowIndex,
                        column
                    );
                } catch (_error) {
                    return stringifyValue(
                        value,
                        this.options
                    );
                }
            }

            if (typeof this.options.formatter === "function") {
                try {
                    return this.options.formatter(
                        value,
                        column.key,
                        row,
                        rowIndex
                    );
                } catch (_error) {
                    return stringifyValue(
                        value,
                        this.options
                    );
                }
            }

            return stringifyValue(
                value,
                this.options
            );
        }

        _renderBody() {
            const {
                tbody,
                table,
                empty
            } = this.elements;

            tbody.replaceChildren();

            const pageRows =
                this._currentPageRows();

            const hasRows =
                pageRows.length > 0;

            table.hidden = !hasRows;
            empty.hidden = hasRows;
            empty.textContent =
                this.options.emptyText ||
                DEFAULT_EMPTY_TEXT;

            const columns =
                this._visibleColumns();

            for (const item of pageRows) {
                const tr =
                    document.createElement("tr");

                tr.dataset.rowIndex =
                    String(item.index);

                if (
                    typeof this.options.rowClassName ===
                    "function"
                ) {
                    const className =
                        this.options.rowClassName(
                            item.row,
                            item.index
                        );

                    if (className) {
                        tr.classList.add(
                            ...String(className)
                                .split(/\s+/)
                                .filter(Boolean)
                        );
                    }
                }

                if (this.options.selectable === true) {
                    const td =
                        document.createElement("td");

                    td.className =
                        "terminal-table-selection-cell";

                    const checkbox =
                        document.createElement("input");

                    checkbox.type = "checkbox";
                    checkbox.checked =
                        this.state.selected.has(
                            item.index
                        );

                    checkbox.setAttribute(
                        "aria-label",
                        `Select row ${item.index + 1}`
                    );

                    checkbox.addEventListener(
                        "change",
                        () => {
                            if (checkbox.checked) {
                                const limit =
                                    parseInteger(
                                        this.options.maxSelection,
                                        DEFAULT_MAX_SELECTION,
                                        1,
                                        1000000
                                    );

                                if (
                                    this.state.selected.size <
                                    limit
                                ) {
                                    this.state.selected.add(
                                        item.index
                                    );
                                } else {
                                    checkbox.checked = false;
                                }
                            } else {
                                this.state.selected.delete(
                                    item.index
                                );
                            }

                            this._renderHead();
                            this._emitSelection();
                        }
                    );

                    td.appendChild(checkbox);
                    tr.appendChild(td);
                }

                for (const column of columns) {
                    const td =
                        document.createElement("td");

                    td.dataset.column = column.key;

                    if (column.align) {
                        td.dataset.align =
                            column.align;
                    }

                    if (column.className) {
                        td.classList.add(
                            ...String(column.className)
                                .split(/\s+/)
                                .filter(Boolean)
                        );
                    }

                    const formatted =
                        this._formatCell(
                            item.row[column.key],
                            column,
                            item.row,
                            item.index
                        );

                    if (isNode(formatted)) {
                        td.appendChild(formatted);
                    } else {
                        td.textContent =
                            String(formatted ?? "");
                    }

                    tr.appendChild(td);
                }

                if (
                    typeof this.options.onRowClick ===
                    "function"
                ) {
                    tr.tabIndex = 0;
                    tr.classList.add("is-interactive");

                    const activate = () => {
                        this.options.onRowClick(
                            clone(item.row),
                            item.index,
                            tr
                        );
                    };

                    tr.addEventListener(
                        "click",
                        activate
                    );

                    tr.addEventListener(
                        "keydown",
                        event => {
                            if (
                                event.key === "Enter" ||
                                event.key === " "
                            ) {
                                event.preventDefault();
                                activate();
                                return;
                            }

                            if (
                                event.key !== "ArrowDown" &&
                                event.key !== "ArrowUp"
                            ) {
                                return;
                            }

                            event.preventDefault();

                            const rows = Array.from(
                                tbody.querySelectorAll("tr")
                            );

                            const current =
                                rows.indexOf(tr);

                            const next =
                                event.key === "ArrowDown"
                                    ? Math.min(
                                        rows.length - 1,
                                        current + 1
                                    )
                                    : Math.max(
                                        0,
                                        current - 1
                                    );

                            rows[next]?.focus();
                        }
                    );
                }

                tbody.appendChild(tr);
            }
        }

        _syncPagination() {
            const {
                pagination,
                footer,
                summary
            } = this.elements;

            pagination.replaceChildren();
            this.elements.previousButton = null;
            this.elements.pageLabel = null;
            this.elements.nextButton = null;

            const needsPagination =
                this.options.paginate !== false &&
                this.state.filteredRows.length >
                this.state.pageSize;

            if (needsPagination) {
                const previous = createElement(
                    "button",
                    "terminal-table-page-previous",
                    this.options.previousLabel ||
                    "Previous"
                );

                previous.type = "button";
                previous.disabled =
                    this.state.page <= 1;

                previous.addEventListener(
                    "click",
                    () => {
                        this.setPage(
                            this.state.page - 1
                        );
                    }
                );

                const label = createElement(
                    "span",
                    "terminal-table-page-label",
                    `Page ${this.state.page} of ${this._pageCount()}`
                );

                label.setAttribute(
                    "aria-live",
                    "polite"
                );

                const next = createElement(
                    "button",
                    "terminal-table-page-next",
                    this.options.nextLabel ||
                    "Next"
                );

                next.type = "button";
                next.disabled =
                    this.state.page >=
                    this._pageCount();

                next.addEventListener(
                    "click",
                    () => {
                        this.setPage(
                            this.state.page + 1
                        );
                    }
                );

                pagination.append(
                    previous,
                    label,
                    next
                );

                this.elements.previousButton = previous;
                this.elements.pageLabel = label;
                this.elements.nextButton = next;
            }

            pagination.hidden = !needsPagination;
            summary.hidden =
                this.options.summary === false;

            footer.hidden =
                !needsPagination &&
                this.options.summary === false;
        }

        _syncSummary() {
            const {
                summary,
                status,
                container
            } = this.elements;

            const visibleColumns =
                this._visibleColumns();

            const start =
                this.state.filteredRows.length
                    ? (
                        (this.state.page - 1) *
                        this.state.pageSize
                    ) + 1
                    : 0;

            const end = Math.min(
                this.state.page *
                this.state.pageSize,
                this.state.filteredRows.length
            );

            summary.textContent =
                `${start}–${end} of ${this.state.filteredRows.length}` +
                (
                    this.state.filteredRows.length !==
                    this.state.rows.length
                        ? ` filtered from ${this.state.rows.length}`
                        : ""
                );

            status.textContent =
                `${this.state.filteredRows.length} row` +
                (
                    this.state.filteredRows.length === 1
                        ? ""
                        : "s"
                ) +
                `, ${visibleColumns.length} column` +
                (
                    visibleColumns.length === 1
                        ? ""
                        : "s"
                );

            container.dataset.rows =
                String(this.state.rows.length);

            container.dataset.filteredRows =
                String(this.state.filteredRows.length);

            container.dataset.columns =
                String(this.state.columns.length);

            container.dataset.page =
                String(this.state.page);
        }

        _render() {
            this.assertActive();

            this._applyFilterAndSort();
            this._syncCaption();
            this._renderHead();
            this._renderBody();
            this._syncPagination();
            this._syncSummary();

            this.state.renderGeneration += 1;
        }

        _emitSelection() {
            const indexes =
                Array.from(this.state.selected)
                    .sort((left, right) =>
                        left - right
                    );

            const selected =
                indexes
                    .map(index =>
                        this.state.rows[index]
                    )
                    .filter(Boolean)
                    .map(clone);

            this.renderer.metrics.selections += 1;

            this._emit("selection", {
                selected,
                indexes
            });

            return selected;
        }

        refresh(
            data,
            nextOptions = {},
            internal = {}
        ) {
            this.assertActive();

            this.options = {
                ...this.options,
                ...nextOptions
            };

            const maxRows =
                parseInteger(
                    this.options.maxRows,
                    DEFAULT_MAX_ROWS,
                    1,
                    100000
                );

            const rows =
                normalizeRows(
                    data,
                    this.options
                ).slice(0, maxRows);

            this.state.rows = rows;
            this.state.columns =
                inferColumns(
                    rows,
                    this.options
                );

            this.state.pageSize =
                parseInteger(
                    this.options.pageSize,
                    DEFAULT_PAGE_SIZE,
                    1,
                    maxRows
                );

            if (
                nextOptions.sortKey !== undefined ||
                internal.initial === true
            ) {
                this.state.sortKey =
                    this.options.sortKey || null;
            }

            if (
                nextOptions.sortDirection !== undefined ||
                internal.initial === true
            ) {
                this.state.sortDirection =
                    this.options.sortDirection === "desc"
                        ? "desc"
                        : "asc";
            }

            if (this.options.preserveState !== true) {
                this.state.page = 1;
                this.state.query = "";
                this.state.selected.clear();
            } else {
                for (const index of Array.from(
                    this.state.selected
                )) {
                    if (index >= rows.length) {
                        this.state.selected.delete(index);
                    }
                }
            }

            this._syncHeaderText();
            this._syncControls();
            this._render();

            if (internal.initial !== true) {
                this.renderer.metrics.refreshes += 1;

                this._emit("refresh", {
                    rows: this.state.rows.length,
                    columns: this.state.columns.length
                });
            }

            return this.elements.container;
        }

        setData(data, options = {}) {
            return this.refresh(data, options);
        }

        setRows(data, options = {}) {
            return this.refresh(data, options);
        }

        ingest(data, options = {}) {
            if (options.append === true) {
                const additional =
                    normalizeRows(data, {
                        ...this.options,
                        ...options
                    });

                return this.refresh(
                    [
                        ...this.state.rows,
                        ...additional
                    ],
                    {
                        ...options,
                        preserveState: true
                    }
                );
            }

            return this.refresh(data, options);
        }

        setFilter(query = "", options = {}) {
            this.assertActive();

            this.state.query = String(query);
            this.state.page = 1;

            if (
                this.elements.searchInput &&
                this.elements.searchInput.value !==
                    this.state.query
            ) {
                this.elements.searchInput.value =
                    this.state.query;
            }

            this._render();

            this.renderer.metrics.filters += 1;

            if (options.emit !== false) {
                this._emit("filter", {
                    query: this.state.query,
                    matches:
                        this.state.filteredRows.length
                });
            }

            return this.state.filteredRows.length;
        }

        setSort(
            key,
            direction = "asc",
            options = {}
        ) {
            this.assertActive();

            const normalized =
                key ? normalizeKey(key) : null;

            if (
                normalized &&
                !this.state.columns.some(
                    column =>
                        column.key === normalized
                )
            ) {
                throw new Error(
                    `Unknown table column: ${normalized}`
                );
            }

            this.state.sortKey = normalized;
            this.state.sortDirection =
                direction === "desc"
                    ? "desc"
                    : "asc";
            this.state.page = 1;

            this._render();

            this.renderer.metrics.sorts += 1;

            const result = {
                key: this.state.sortKey,
                direction:
                    this.state.sortDirection
            };

            if (options.emit !== false) {
                this._emit("sort", result);
            }

            return result;
        }

        setPage(page) {
            this.assertActive();

            this.state.page = parseInteger(
                page,
                this.state.page,
                1,
                this._pageCount()
            );

            this._render();

            this._emit("page", {
                page: this.state.page,
                pageCount: this._pageCount()
            });

            return this.state.page;
        }

        getRows({ filtered = false } = {}) {
            this.assertActive();

            return (
                filtered
                    ? this.state.filteredRows
                        .map(item => item.row)
                    : this.state.rows
            ).map(clone);
        }

        getSelected() {
            this.assertActive();

            return Array.from(this.state.selected)
                .sort((left, right) => left - right)
                .map(index =>
                    this.state.rows[index]
                )
                .filter(Boolean)
                .map(clone);
        }

        toCSV(options = {}) {
            this.assertActive();

            const rows =
                options.filtered === false
                    ? this.state.rows
                    : this.state.filteredRows
                        .map(item => item.row);

            return this.renderer.toCSV(rows, {
                columns: this.state.columns,
                ...options
            });
        }

        downloadCSV(filename = "speciedex-table.csv") {
            this.assertActive();

            const csv = this.toCSV();
            const blob = new Blob(
                [csv],
                {
                    type:
                        "text/csv;charset=utf-8"
                }
            );

            const url =
                URL.createObjectURL(blob);

            const anchor =
                document.createElement("a");

            anchor.href = url;
            anchor.download = filename;
            anchor.style.display = "none";

            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();

            window.setTimeout(
                () => {
                    URL.revokeObjectURL(url);
                },
                1000
            );

            this.renderer.metrics.exports += 1;

            this._emit("export", {
                format: "csv",
                rows:
                    this.state.filteredRows.length,
                filename,
                csv
            });

            return csv;
        }

        status() {
            return {
                version: VERSION,
                rows: this.state.rows.length,
                filteredRows:
                    this.state.filteredRows.length,
                columns:
                    this.state.columns.length,
                page: this.state.page,
                pageCount:
                    this._pageCount(),
                pageSize:
                    this.state.pageSize,
                query: this.state.query,
                sortKey:
                    this.state.sortKey,
                sortDirection:
                    this.state.sortDirection,
                selected:
                    this.state.selected.size,
                renderGeneration:
                    this.state.renderGeneration,
                connected:
                    this.elements.container.isConnected,
                destroyed:
                    this.destroyed
            };
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            window.clearTimeout(
                this.state.filterTimer
            );

            this.state.selected.clear();
            this.destroyed = true;

            this.renderer?.instances?.delete(this);

            if (
                this.elements.container[
                    INSTANCE_SYMBOL
                ] === this
            ) {
                delete this.elements.container[
                    INSTANCE_SYMBOL
                ];
            }

            delete this.elements.container.tableInstance;
            delete this.elements.container.update;
            delete this.elements.container.setData;
            delete this.elements.container.setRows;
            delete this.elements.container.ingest;
            delete this.elements.container.destroy;

            this.elements.container.remove();

            this.renderer.metrics.destroyedInstances += 1;

            safeDispatch(
                this,
                "destroy",
                {
                    version: VERSION,
                    instance: this
                }
            );

            return true;
        }
    }

    class TableRenderer extends EventTarget {
        constructor(context = {}) {
            super();

            this.context =
                isObject(context)
                    ? context
                    : {};

            this.instances = new Set();
            this.destroyed = false;

            this.metrics = {
                renders: 0,
                refreshes: 0,
                filters: 0,
                sorts: 0,
                exports: 0,
                selections: 0,
                destroyedInstances: 0
            };
        }

        assertActive() {
            if (this.destroyed) {
                throw new Error(
                    "Table renderer has been destroyed."
                );
            }
        }

        _emit(type, detail = {}) {
            if (this.destroyed) {
                return null;
            }

            const event = {
                type,
                timestamp: new Date().toISOString(),
                renderer: this,
                ...detail
            };

            safeDispatch(this, type, event);

            try {
                this.context.events?.emit?.(
                    `table:${type}`,
                    event
                );
            } catch (_error) {
                /* Context event bus is optional. */
            }

            return event;
        }

        render(data, options = {}) {
            this.assertActive();

            const instance =
                new TableInstance(
                    this,
                    data,
                    options
                );

            this.instances.add(instance);
            this.metrics.renders += 1;

            this._emit("render", {
                rows:
                    instance.state.rows.length,
                columns:
                    instance.state.columns.length,
                element:
                    instance.elements.container,
                instance
            });

            return instance.elements.container;
        }

        mount(target, data, options = {}) {
            this.assertActive();

            const element =
                this.render(data, options);

            if (isElement(target)) {
                const previous =
                    target.querySelectorAll(
                        ":scope > .terminal-renderer-table"
                    );

                for (const old of previous) {
                    old[INSTANCE_SYMBOL]?.destroy?.();
                }

                target.replaceChildren(element);
            }

            return element;
        }

        activeInstance() {
            const root =
                this.context.root;

            const element =
                root?.querySelector?.(
                    ".terminal-renderer-table"
                ) ||
                document.querySelector(
                    ".terminal-renderer-table"
                );

            const direct =
                element?.[INSTANCE_SYMBOL] ||
                element?.tableInstance;

            if (
                direct &&
                !direct.destroyed
            ) {
                return direct;
            }

            const instances =
                Array.from(this.instances)
                    .filter(instance =>
                        !instance.destroyed
                    );

            return instances.length
                ? instances[instances.length - 1]
                : null;
        }

        status() {
            const active =
                this.activeInstance();

            return {
                version: VERSION,
                instances:
                    this.instances.size,
                destroyed:
                    this.destroyed,
                metrics: {
                    ...this.metrics
                },
                active:
                    active?.status?.() ||
                    null
            };
        }

        toCSV(data, options = {}) {
            const rows =
                normalizeRows(data, options);

            const columns =
                inferColumns(rows, options)
                    .filter(column =>
                        column.visible !== false
                    );

            const delimiter =
                typeof options.delimiter === "string" &&
                options.delimiter.length
                    ? options.delimiter
                    : ",";

            const newline =
                typeof options.newline === "string"
                    ? options.newline
                    : "\r\n";

            const lines = [];

            if (options.includeHeader !== false) {
                lines.push(
                    columns
                        .map(column =>
                            escapeCSVCell(
                                column.label,
                                delimiter,
                                options
                            )
                        )
                        .join(delimiter)
                );
            }

            for (const row of rows) {
                lines.push(
                    columns
                        .map(column =>
                            escapeCSVCell(
                                row[column.key],
                                delimiter,
                                options
                            )
                        )
                        .join(delimiter)
                );
            }

            return lines.join(newline);
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            for (const instance of Array.from(
                this.instances
            )) {
                instance.destroy();
            }

            this.instances.clear();

            const root = this.context.root;

            if (
                root &&
                root[RENDERER_SYMBOL] === this
            ) {
                delete root[RENDERER_SYMBOL];
            }

            this.destroyed = true;

            safeDispatch(
                this,
                "destroy",
                {
                    version: VERSION,
                    renderer: this
                }
            );

            return true;
        }
    }

    function render(data, options = {}) {
        const renderer =
            new TableRenderer({});

        const element =
            renderer.render(data, options);

        const instance =
            element[INSTANCE_SYMBOL];

        const originalDestroy =
            instance.destroy.bind(instance);

        instance.destroy = () => {
            const result = originalDestroy();
            renderer.destroy();
            return result;
        };

        element.destroy =
            instance.destroy;

        return element;
    }

    function initialize(context = {}) {
        const safeContext =
            isObject(context)
                ? context
                : {};

        const root =
            isElement(safeContext.root)
                ? safeContext.root
                : null;

        const existing =
            safeContext.tableRenderer instanceof
                TableRenderer
                ? safeContext.tableRenderer
                : root?.[RENDERER_SYMBOL];

        if (
            existing instanceof TableRenderer &&
            !existing.destroyed
        ) {
            safeContext.tableRenderer = existing;

            safeContext.registerRenderer?.(
                "table",
                existing
            );

            safeContext.registerVisualization?.(
                "table",
                existing
            );

            return existing;
        }

        const renderer =
            new TableRenderer(safeContext);

        if (root) {
            root[RENDERER_SYMBOL] =
                renderer;
        }

        safeContext.registerRenderer?.(
            "table",
            renderer
        );

        safeContext.registerVisualization?.(
            "table",
            renderer
        );

        safeContext.tableRenderer =
            renderer;

        safeDispatch(
            document,
            "speciedex:terminal-table-ready",
            {
                renderer,
                version: VERSION
            }
        );

        return renderer;
    }

    function resolveCommandContext(payload = {}) {
        return (
            payload.context ||
            payload.terminal?.context ||
            payload.app?.context ||
            payload
        );
    }

    function writeJSONResult(payload, value) {
        if (typeof payload.writeJSON === "function") {
            return payload.writeJSON(value);
        }

        if (typeof payload.write === "function") {
            return payload.write(
                JSON.stringify(value, null, 2)
            );
        }

        return value;
    }

    const commands = [
        {
            name: "table-status",
            category: "visualization",
            description:
                "Display table-renderer diagnostics.",
            usage: "table-status",

            handler: payload => {
                const context =
                    resolveCommandContext(payload);

                return writeJSONResult(
                    payload,
                    context.tableRenderer
                        ?.status?.() ||
                    null
                );
            }
        },

        {
            name: "table-filter",
            category: "visualization",
            description:
                "Filter the active table.",
            usage: "table-filter [query]",

            handler: payload => {
                const context =
                    resolveCommandContext(payload);

                const instance =
                    context.tableRenderer
                        ?.activeInstance?.();

                if (!instance) {
                    throw new Error(
                        "No active table renderer is available."
                    );
                }

                const args =
                    Array.isArray(payload.args)
                        ? payload.args
                        : [];

                const query = args.join(" ");

                return writeJSONResult(
                    payload,
                    {
                        query,
                        matches:
                            instance.setFilter(query)
                    }
                );
            }
        },

        {
            name: "table-sort",
            category: "visualization",
            description:
                "Sort the active table.",
            usage:
                "table-sort <column> [asc|desc]",

            handler: payload => {
                const context =
                    resolveCommandContext(payload);

                const instance =
                    context.tableRenderer
                        ?.activeInstance?.();

                if (!instance) {
                    throw new Error(
                        "No active table renderer is available."
                    );
                }

                const args =
                    Array.isArray(payload.args)
                        ? payload.args
                        : [];

                if (!args[0]) {
                    throw new Error(
                        "Usage: table-sort <column> [asc|desc]"
                    );
                }

                return writeJSONResult(
                    payload,
                    instance.setSort(
                        args[0],
                        args[1] || "asc"
                    )
                );
            }
        },

        {
            name: "table-page",
            category: "visualization",
            description:
                "Move the active table to a page.",
            usage:
                "table-page <number>",

            handler: payload => {
                const context =
                    resolveCommandContext(payload);

                const instance =
                    context.tableRenderer
                        ?.activeInstance?.();

                if (!instance) {
                    throw new Error(
                        "No active table renderer is available."
                    );
                }

                const args =
                    Array.isArray(payload.args)
                        ? payload.args
                        : [];

                return writeJSONResult(
                    payload,
                    {
                        page:
                            instance.setPage(args[0]),
                        status:
                            instance.status()
                    }
                );
            }
        },

        {
            name: "table-export",
            category: "visualization",
            description:
                "Export the active table as CSV.",
            usage:
                "table-export [filename]",

            handler: payload => {
                const context =
                    resolveCommandContext(payload);

                const instance =
                    context.tableRenderer
                        ?.activeInstance?.();

                if (!instance) {
                    throw new Error(
                        "No active table renderer is available."
                    );
                }

                const args =
                    Array.isArray(payload.args)
                        ? payload.args
                        : [];

                const filename =
                    args[0] ||
                    "speciedex-table.csv";

                instance.downloadCSV(filename);

                if (typeof payload.write === "function") {
                    return payload.write(
                        `Table exported to ${filename}.`,
                        "success"
                    );
                }

                return filename;
            }
        }
    ];

    const api = Object.freeze({
        name: MODULE_NAME,
        version: VERSION,
        RENDERER_SYMBOL,
        INSTANCE_SYMBOL,
        TableRenderer,
        TableInstance,
        normalizeRows,
        inferColumns,
        compareValues,
        stringifyValue,
        render,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalTable = api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules || {};

    window.SpeciedexTerminalModules[MODULE_NAME] =
        api;

    safeDispatch(
        document,
        "speciedex:terminal-module-available",
        {
            name: MODULE_NAME,
            module: api
        }
    );
})(window, document);
