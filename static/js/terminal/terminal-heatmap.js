/*
========================================================================
Speciedex.org
Terminal Heatmap Renderer
========================================================================

Structured heatmap renderer for SpeciedexTerminal.

Provides:

    • Matrix, row-object, and point-list normalization
    • Accessible heatmap cells and labels
    • Linear, logarithmic, and quantile scaling
    • Automatic legends and range summaries
    • Safe value formatting
    • Renderer and service registration
    • Terminal command integration

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Heatmap";
    const VERSION = "2.1.0";

    const RENDERER_SYMBOL =
        Symbol.for(
            "speciedex.terminal.heatmap.renderer"
        );

    const INSTANCE_SYMBOL =
        Symbol.for(
            "speciedex.terminal.heatmap.instance"
        );

    const DEFAULT_CELL_SIZE = 32;
    const MIN_CELL_SIZE = 12;
    const MAX_CELL_SIZE = 96;
    const DEFAULT_MAX_ROWS = 2000;
    const DEFAULT_MAX_COLUMNS = 2000;
    const DEFAULT_MAX_CELLS = 250000;
    const DEFAULT_QUANTILE_BUCKETS = 5;

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

    function clampNumber(value, fallback, minimum, maximum) {
        const parsed = Number(value);

        if (!Number.isFinite(parsed)) {
            return fallback;
        }

        return Math.min(
            maximum,
            Math.max(minimum, parsed)
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

    function finiteNumber(value) {
        const number = Number(value);
        return Number.isFinite(number)
            ? number
            : null;
    }

    function normalizeMatrix(
        data,
        options =
            {},
        seen =
            new WeakSet()
    ) {
        const maxRows =
            clampNumber(
                options.maxRows,
                DEFAULT_MAX_ROWS,
                1,
                100000
            );

        const maxColumns =
            clampNumber(
                options.maxColumns,
                DEFAULT_MAX_COLUMNS,
                1,
                100000
            );

        if (
            data &&
            typeof data ===
                "object"
        ) {
            if (
                seen.has(
                    data
                )
            ) {
                return {
                    rows:
                        [],
                    rowLabels:
                        [],
                    columnLabels:
                        [],
                    truncated:
                        true
                };
            }

            seen.add(
                data
            );
        }
        if (typeof data === "string") {
            const trimmed = data.trim();

            if (!trimmed) {
                return {
                    rows: [],
                    rowLabels: [],
                    columnLabels: []
                };
            }

            try {
                return normalizeMatrix(
                    JSON.parse(trimmed),
                    options,
                    seen
                );
            } catch (_error) {
                const rows =
                    trimmed
                        .split(/\r?\n/)
                        .filter(Boolean)
                        .map(line =>
                            line
                                .trim()
                                .split(/[\s,;]+/)
                                .filter(Boolean)
                                .map(value =>
                                    finiteNumber(value)
                                )
                        );

                return normalizeMatrix(
                    rows,
                    options,
                    seen
                );
            }
        }

        if (Array.isArray(data)) {
            if (
                data.every(row =>
                    Array.isArray(row)
                )
            ) {
                const rows =
                    data
                        .slice(
                            0,
                            maxRows
                        )
                        .map(
                            row =>
                                row
                                    .slice(
                                        0,
                                        maxColumns
                                    )
                                    .map(
                                        value =>
                                            finiteNumber(
                                                value
                                            )
                                    )
                        );

                const maxColumns =
                    rows.reduce(
                        (maximum, row) =>
                            Math.max(
                                maximum,
                                row.length
                            ),
                        0
                    );

                return {
                    truncated:
                        data.length >
                            maxRows ||
                        rows.some(
                            (
                                row,
                                index
                            ) =>
                                data[
                                    index
                                ]?.length >
                                maxColumns
                        ),
                    rows:
                        rows.map(row => [
                            ...row,
                            ...Array(
                                Math.max(
                                    0,
                                    maxColumns - row.length
                                )
                            ).fill(null)
                        ]),
                    rowLabels:
                        rows.map(
                            (_row, index) =>
                                String(index + 1)
                        ),
                    columnLabels:
                        Array.from(
                            {
                                length:
                                    maxColumns
                            },
                            (_value, index) =>
                                String(index + 1)
                        )
                };
            }

            if (
                data.every(item =>
                    item &&
                    typeof item === "object" &&
                    (
                        "row" in item ||
                        "y" in item
                    ) &&
                    (
                        "column" in item ||
                        "x" in item
                    ) &&
                    "value" in item
                )
            ) {
                const limited =
                    data.slice(
                        0,
                        Math.min(
                            data.length,
                            maxRows *
                                maxColumns
                        )
                    );

                const rowLabels =
                    [
                        ...new Set(
                            limited.map(item =>
                                safeString(
                                    item.row ??
                                    item.y
                                )
                            )
                        )
                    ].slice(
                        0,
                        maxColumns
                    );

                const columnLabels =
                    [
                        ...new Set(
                            limited.map(item =>
                                safeString(
                                    item.column ??
                                    item.x
                                )
                            )
                        )
                    ];

                const rowIndex =
                    new Map(
                        rowLabels.map(
                            (label, index) => [
                                label,
                                index
                            ]
                        )
                    );

                const columnIndex =
                    new Map(
                        columnLabels.map(
                            (label, index) => [
                                label,
                                index
                            ]
                        )
                    );

                const rows =
                    Array.from(
                        {
                            length:
                                rowLabels.length
                        },
                        () =>
                            Array(
                                columnLabels.length
                            ).fill(null)
                    );

                for (
                    const item of
                    limited
                ) {
                    const row =
                        rowIndex.get(
                            safeString(
                                item.row ??
                                item.y
                            )
                        );

                    const column =
                        columnIndex.get(
                            safeString(
                                item.column ??
                                item.x
                            )
                        );

                    rows[row][column] =
                        finiteNumber(
                            item.value
                        );
                }

                return {
                    rows,
                    rowLabels,
                    columnLabels
                };
            }

            if (
                data.every(item =>
                    item &&
                    typeof item === "object"
                )
            ) {
                const limited =
                    data.slice(
                        0,
                        maxRows
                    );

                const columnLabels =
                    [
                        ...new Set(
                            limited.flatMap(item =>
                                Object.keys(item).filter(
                                    key =>
                                        ![
                                            "label",
                                            "name",
                                            "row"
                                        ].includes(key)
                                )
                            )
                        )
                    ];

                const rowLabels =
                    limited.map(
                        (item, index) =>
                            safeString(
                                item.label ??
                                item.name ??
                                item.row ??
                                index + 1
                            )
                    );

                const rows =
                    limited.map(item =>
                        columnLabels.map(
                            key =>
                                finiteNumber(
                                    item[key]
                                )
                        )
                    );

                return {
                    rows,
                    rowLabels,
                    columnLabels
                };
            }
        }

        if (
            data &&
            typeof data === "object"
        ) {
            if (
                Array.isArray(data.rows)
            ) {
                const normalized =
                    normalizeMatrix(
                        data.rows
                    );

                return {
                    rows:
                        normalized.rows,
                    rowLabels:
                        Array.isArray(
                            data.rowLabels
                        )
                            ? data.rowLabels.map(
                                safeString
                            )
                            : normalized.rowLabels,
                    columnLabels:
                        Array.isArray(
                            data.columnLabels
                        )
                            ? data.columnLabels.map(
                                safeString
                            )
                            : normalized.columnLabels
                };
            }

            return normalizeMatrix(
                Object.entries(data).map(
                    ([label, value]) => ({
                        label,
                        value
                    })
                )
            );
        }

        return {
            rows: [],
            rowLabels: [],
            columnLabels: []
        };
    }

    function flattenValues(matrix) {
        return matrix.rows
            .flat()
            .filter(value =>
                Number.isFinite(value)
            );
    }

    function calculateRange(values, options = {}) {
        const minimum =
            Number.isFinite(
                Number(options.min)
            )
                ? Number(options.min)
                : (
                    values.length
                        ? Math.min(...values)
                        : 0
                );

        const maximum =
            Number.isFinite(
                Number(options.max)
            )
                ? Number(options.max)
                : (
                    values.length
                        ? Math.max(...values)
                        : 0
                );

        const lower =
            Math.min(
                minimum,
                maximum
            );

        const upper =
            Math.max(
                minimum,
                maximum
            );

        return {
            minimum:
                lower,
            maximum:
                upper,
            span:
                upper -
                lower
        };
    }

    function quantileThresholds(values, buckets = 5) {
        if (!values.length) {
            return [];
        }

        const sorted =
            [...values].sort(
                (left, right) =>
                    left - right
            );

        const thresholds = [];

        for (
            let index = 1;
            index < buckets;
            index += 1
        ) {
            const position =
                (
                    sorted.length - 1
                ) *
                (
                    index / buckets
                );

            const lower =
                Math.floor(position);

            const upper =
                Math.ceil(position);

            const value =
                lower === upper
                    ? sorted[lower]
                    : sorted[lower] +
                      (
                          sorted[upper] -
                          sorted[lower]
                      ) *
                      (
                          position - lower
                      );

            thresholds.push(value);
        }

        return thresholds;
    }

    function scaleValue(value, range, options = {}) {
        if (!Number.isFinite(value)) {
            return null;
        }

        const mode =
            String(
                options.scale || "linear"
            ).toLowerCase();

        if (
            range.maximum ===
            range.minimum
        ) {
            return 1;
        }

        if (
            mode ===
                "log"
        ) {
            const shift =
                range.minimum <=
                    0
                    ? 1 -
                        range.minimum
                    : 0;

            const minimum =
                Math.max(
                    Number.EPSILON,
                    range.minimum +
                    shift
                );

            const maximum =
                Math.max(
                    minimum +
                    Number.EPSILON,
                    range.maximum +
                    shift
                );

            const normalizedValue =
                Math.max(
                    minimum,
                    value +
                    shift
                );

            return (
                Math.log(
                    normalizedValue
                ) -
                Math.log(
                    minimum
                )
            ) / (
                Math.log(
                    maximum
                ) -
                Math.log(
                    minimum
                )
            );
        }

        if (mode === "quantile") {
            const thresholds =
                options.thresholds || [];

            let bucket = 0;

            while (
                bucket <
                    thresholds.length &&
                value >
                    thresholds[bucket]
            ) {
                bucket += 1;
            }

            return thresholds.length
                ? bucket /
                    (
                        thresholds.length
                    )
                : 1;
        }

        return (
            value -
            range.minimum
        ) / (
            range.maximum -
            range.minimum
        );
    }

    function formatValue(value, formatter = null) {
        if (!Number.isFinite(value)) {
            return "";
        }

        if (
            typeof formatter ===
            "function"
        ) {
            return safeString(
                formatter(value)
            );
        }

        return Number.isInteger(value)
            ? String(value)
            : value.toLocaleString(
                undefined,
                {
                    maximumFractionDigits: 4
                }
            );
    }

    function renderLegend(range, options = {}) {
        const legend =
            document.createElement(
                "div"
            );

        legend.className =
            "terminal-heatmap-legend";

        const minimum =
            document.createElement(
                "span"
            );

        minimum.className =
            "terminal-heatmap-legend-min";
        minimum.textContent =
            formatValue(
                range.minimum,
                options.formatter
            );

        const scale =
            document.createElement(
                "span"
            );

        scale.className =
            "terminal-heatmap-legend-scale";
        scale.setAttribute(
            "aria-hidden",
            "true"
        );

        const maximum =
            document.createElement(
                "span"
            );

        maximum.className =
            "terminal-heatmap-legend-max";
        maximum.textContent =
            formatValue(
                range.maximum,
                options.formatter
            );

        legend.append(
            minimum,
            scale,
            maximum
        );

        return legend;
    }

    function buildHeatmapElement(
        data,
        options = {}
    ) {
        const matrix =
            normalizeMatrix(
                data,
                options
            );

        const values =
            flattenValues(
                matrix
            );

        const maximumCells =
            clampNumber(
                options.maxCells,
                DEFAULT_MAX_CELLS,
                1,
                10000000
            );

        const totalCells =
            matrix.rows.length *
            matrix.columnLabels.length;

        if (
            totalCells >
            maximumCells
        ) {
            throw new RangeError(
                `Heatmap contains ${totalCells} cells; maximum is ${maximumCells}.`
            );
        }

        const range =
            calculateRange(
                values,
                options
            );

        const scaleMode =
            String(
                options.scale || "linear"
            ).toLowerCase();

        const thresholds =
            scaleMode === "quantile"
                ? quantileThresholds(
                    values,
                    clampNumber(
                        options.buckets,
                        5,
                        2,
                        12
                    )
                )
                : [];

        const cellSize =
            clampNumber(
                options.cellSize,
                DEFAULT_CELL_SIZE,
                MIN_CELL_SIZE,
                MAX_CELL_SIZE
            );

        const container =
            document.createElement(
                "section"
            );

        container.className =
            "terminal-renderer terminal-renderer-heatmap";
        container.dataset.renderer =
            "heatmap";
        container.dataset.rows =
            String(
                matrix.rows.length
            );
        container.dataset.columns =
            String(
                matrix.columnLabels.length
            );
        container.dataset.scale =
            scaleMode;

        if (options.title) {
            const heading =
                document.createElement(
                    "h3"
                );

            heading.textContent =
                options.title;

            container.appendChild(
                heading
            );
        }

        if (
            !matrix.rows.length ||
            !matrix.columnLabels.length
        ) {
            const empty =
                document.createElement(
                    "p"
                );

            empty.className =
                "terminal-renderer-empty";
            empty.textContent =
                options.emptyMessage ||
                "No heatmap data available.";

            container.appendChild(empty);
            return container;
        }

        const summary =
            document.createElement(
                "p"
            );

        summary.className =
            "terminal-heatmap-summary";
        summary.textContent =
            `${matrix.rows.length} row${matrix.rows.length === 1 ? "" : "s"}, ${matrix.columnLabels.length} column${matrix.columnLabels.length === 1 ? "" : "s"}, range ${formatValue(range.minimum, options.formatter)} to ${formatValue(range.maximum, options.formatter)}`;

        container.appendChild(
            summary
        );

        container.appendChild(
            renderLegend(
                range,
                options
            )
        );

        const wrapper =
            document.createElement(
                "div"
            );

        wrapper.className =
            "terminal-heatmap-wrapper";

        const table =
            document.createElement(
                "table"
            );

        table.className =
            "terminal-heatmap-table";

        const caption =
            document.createElement(
                "caption"
            );

        caption.textContent =
            options.caption ||
            options.title ||
            "Heatmap data";

        table.appendChild(caption);

        const thead =
            document.createElement(
                "thead"
            );

        const headerRow =
            document.createElement(
                "tr"
            );

        const corner =
            document.createElement(
                "th"
            );

        corner.scope = "col";
        corner.textContent =
            options.rowHeaderLabel || "";

        headerRow.appendChild(corner);

        for (
            const label of
            matrix.columnLabels
        ) {
            const th =
                document.createElement(
                    "th"
                );

            th.scope = "col";
            th.textContent =
                safeString(label);

            headerRow.appendChild(th);
        }

        thead.appendChild(headerRow);
        table.appendChild(thead);

        const tbody =
            document.createElement(
                "tbody"
            );

        matrix.rows.forEach(
            (row, rowIndex) => {
                const tr =
                    document.createElement(
                        "tr"
                    );

                const rowHeader =
                    document.createElement(
                        "th"
                    );

                rowHeader.scope =
                    "row";
                rowHeader.textContent =
                    safeString(
                        matrix.rowLabels[
                            rowIndex
                        ] ??
                        rowIndex + 1
                    );

                tr.appendChild(
                    rowHeader
                );

                row.forEach(
                    (value, columnIndex) => {
                        const td =
                            document.createElement(
                                "td"
                            );

                        td.className =
                            "terminal-heatmap-cell";

                        td.tabIndex =
                            rowIndex ===
                                0 &&
                            columnIndex ===
                                0
                                ? 0
                                : -1;

                        td.dataset.row =
                            String(
                                rowIndex
                            );

                        td.dataset.column =
                            String(
                                columnIndex
                            );
                        td.style.width =
                            `${cellSize}px`;
                        td.style.height =
                            `${cellSize}px`;

                        const intensity =
                            scaleValue(
                                value,
                                range,
                                {
                                    scale:
                                        scaleMode,
                                    thresholds
                                }
                            );

                        if (intensity === null) {
                            td.classList.add(
                                "terminal-heatmap-cell-empty"
                            );

                            td.setAttribute(
                                "aria-label",
                                `${matrix.rowLabels[rowIndex] ?? rowIndex + 1}, ${matrix.columnLabels[columnIndex] ?? columnIndex + 1}: no data`
                            );
                        } else {
                            td.style.setProperty(
                                "--terminal-heatmap-intensity",
                                String(
                                    Math.max(
                                        0,
                                        Math.min(
                                            1,
                                            intensity
                                        )
                                    )
                                )
                            );

                            td.dataset.value =
                                String(value);
                            td.dataset.intensity =
                                String(intensity);

                            const text =
                                document.createElement(
                                    "span"
                                );

                            text.className =
                                "terminal-heatmap-value";
                            text.textContent =
                                options.showValues === false
                                    ? ""
                                    : formatValue(
                                        value,
                                        options.formatter
                                    );

                            td.appendChild(text);

                            td.setAttribute(
                                "aria-label",
                                `${matrix.rowLabels[rowIndex] ?? rowIndex + 1}, ${matrix.columnLabels[columnIndex] ?? columnIndex + 1}: ${formatValue(value, options.formatter)}`
                            );
                        }

                        const selectCell =
                            () => {
                                for (
                                    const cell of
                                    container.querySelectorAll(
                                        ".terminal-heatmap-cell[aria-selected='true']"
                                    )
                                ) {
                                    cell.setAttribute(
                                        "aria-selected",
                                        "false"
                                    );
                                }

                                td.setAttribute(
                                    "aria-selected",
                                    "true"
                                );

                                dispatch(
                                    container,
                                    "terminal-heatmap-select",
                                    {
                                        row:
                                            rowIndex,
                                        column:
                                            columnIndex,
                                        rowLabel:
                                            matrix.rowLabels[
                                                rowIndex
                                            ] ??
                                            rowIndex +
                                                1,
                                        columnLabel:
                                            matrix.columnLabels[
                                                columnIndex
                                            ] ??
                                            columnIndex +
                                                1,
                                        value,
                                        intensity
                                    }
                                );
                            };

                        td.addEventListener(
                            "click",
                            selectCell
                        );

                        td.addEventListener(
                            "keydown",
                            event => {
                                if (
                                    event.key ===
                                        "Enter" ||
                                    event.key ===
                                        " "
                                ) {
                                    event.preventDefault();
                                    selectCell();

                                    return;
                                }

                                const rowDelta =
                                    event.key ===
                                        "ArrowDown"
                                        ? 1
                                        : event.key ===
                                            "ArrowUp"
                                            ? -1
                                            : 0;

                                const columnDelta =
                                    event.key ===
                                        "ArrowRight"
                                        ? 1
                                        : event.key ===
                                            "ArrowLeft"
                                            ? -1
                                            : 0;

                                if (
                                    !rowDelta &&
                                    !columnDelta
                                ) {
                                    return;
                                }

                                event.preventDefault();

                                const nextRow =
                                    Math.max(
                                        0,
                                        Math.min(
                                            matrix.rows.length -
                                                1,
                                            rowIndex +
                                                rowDelta
                                        )
                                    );

                                const nextColumn =
                                    Math.max(
                                        0,
                                        Math.min(
                                            matrix.columnLabels.length -
                                                1,
                                            columnIndex +
                                                columnDelta
                                        )
                                    );

                                const next =
                                    container.querySelector(
                                        `[data-row="${nextRow}"][data-column="${nextColumn}"]`
                                    );

                                if (next) {
                                    td.tabIndex =
                                        -1;

                                    next.tabIndex =
                                        0;

                                    next.focus();
                                }
                            }
                        );

                        tr.appendChild(td);
                    }
                );

                tbody.appendChild(tr);
            }
        );

        table.appendChild(tbody);
        wrapper.appendChild(table);
        container.appendChild(wrapper);

        return container;
    }


    class HeatmapRenderer extends EventTarget {
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
                refreshes:
                    0,
                selections:
                    0,
                destroyedInstances:
                    0
            };
        }

        assertActive() {
            if (
                this.destroyed
            ) {
                throw new Error(
                    "Heatmap renderer has been destroyed."
                );
            }
        }

        render(
            data,
            options =
                {}
        ) {
            this.assertActive();

            const container =
                buildHeatmapElement(
                    data,
                    options
                );

            const state = {
                data:
                    clone(
                        data
                    ),
                options: {
                    ...options
                },
                destroyed:
                    false
            };

            const instance = {
                element:
                    container,

                state,

                refresh:
                    (
                        nextData =
                            state.data,
                        nextOptions =
                            {}
                    ) => {
                        if (
                            state.destroyed
                        ) {
                            return container;
                        }

                        state.data =
                            clone(
                                nextData
                            );

                        state.options = {
                            ...state.options,
                            ...nextOptions
                        };

                        const replacement =
                            buildHeatmapElement(
                                state.data,
                                state.options
                            );

                        container.replaceChildren(
                            ...replacement.childNodes
                        );

                        for (
                            const [
                                key,
                                value
                            ] of Object.entries(
                                replacement.dataset
                            )
                        ) {
                            container.dataset[
                                key
                            ] =
                                value;
                        }

                        this.metrics.refreshes +=
                            1;

                        dispatch(
                            container,
                            "terminal-heatmap-refresh",
                            instance.status()
                        );

                        return container;
                    },

                setData:
                    (
                        nextData,
                        nextOptions =
                            {}
                    ) =>
                        instance.refresh(
                            nextData,
                            nextOptions
                        ),

                status:
                    () => ({
                        version:
                            VERSION,
                        rows:
                            Number(
                                container.dataset.rows ||
                                0
                            ),
                        columns:
                            Number(
                                container.dataset.columns ||
                                0
                            ),
                        scale:
                            container.dataset.scale ||
                            "linear",
                        destroyed:
                            state.destroyed
                    }),

                destroy:
                    () => {
                        if (
                            state.destroyed
                        ) {
                            return false;
                        }

                        state.destroyed =
                            true;

                        this.instances.delete(
                            instance
                        );

                        if (
                            container[
                                INSTANCE_SYMBOL
                            ] ===
                                instance
                        ) {
                            delete container[
                                INSTANCE_SYMBOL
                            ];
                        }

                        container.remove();

                        this.metrics.destroyedInstances +=
                            1;

                        return true;
                    }
            };

            container[
                INSTANCE_SYMBOL
            ] =
                instance;

            container.heatmapInstance =
                instance;

            container.update =
                instance.refresh;

            container.setData =
                instance.setData;

            container.destroy =
                instance.destroy;

            container.addEventListener(
                "terminal-heatmap-select",
                () => {
                    this.metrics.selections +=
                        1;
                }
            );

            this.instances.add(
                instance
            );

            this.metrics.renders +=
                1;

            return container;
        }

        activeInstance() {
            const element =
                this.context.root?.
                    querySelector?.(
                        ".terminal-renderer-heatmap"
                    ) ||
                document.querySelector(
                    ".terminal-renderer-heatmap"
                );

            return (
                element?.[
                    INSTANCE_SYMBOL
                ] ||
                element?.
                    heatmapInstance ||
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

    function render(
        data,
        options =
            {}
    ) {
        const renderer =
            new HeatmapRenderer(
                {}
            );

        return renderer.render(
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
            context.heatmapRenderer instanceof
                HeatmapRenderer
                ? context.heatmapRenderer
                : root?.[
                    RENDERER_SYMBOL
                ];

        if (
            existing instanceof
                HeatmapRenderer &&
            !existing.destroyed
        ) {
            context.heatmapRenderer =
                existing;

            context.registerRenderer?.(
                "heatmap",
                existing
            );

            context.registerRenderer?.(
                "matrix-heatmap",
                existing
            );

            return existing;
        }

        const renderer =
            new HeatmapRenderer(
                context
            );

        root[
            RENDERER_SYMBOL
        ] =
            renderer;

        context.registerRenderer?.(
            "heatmap",
            renderer
        );

        context.registerRenderer?.(
            "matrix-heatmap",
            renderer
        );

        context.registerVisualization?.(
            "heatmap",
            renderer
        );

        context.heatmapRenderer =
            renderer;

        context.registerService?.(
            "heatmap",
            renderer
        );

        dispatch(
            document,
            "speciedex:terminal-heatmap-ready",
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
            scale: "linear",
            cellSize:
                DEFAULT_CELL_SIZE,
            showValues:
                true,
            maxRows:
                DEFAULT_MAX_ROWS,
            maxColumns:
                DEFAULT_MAX_COLUMNS,
            maxCells:
                DEFAULT_MAX_CELLS
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
                    "--scale="
                )
            ) {
                options.scale =
                    argument.slice(8);
                continue;
            }

            if (
                argument.startsWith(
                    "--cell-size="
                )
            ) {
                options.cellSize =
                    argument.slice(12);
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
                argument.startsWith(
                    "--max-cells="
                )
            ) {
                options.maxCells =
                    argument.slice(
                        12
                    );

                continue;
            }

            if (
                argument ===
                "--hide-values"
            ) {
                options.showValues =
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
                    JSON.parse(joined),
                options
            };
        } catch (_error) {
            return {
                data:
                    joined,
                options
            };
        }
    }

    const commands = [
        {
            name: "heatmap",
            aliases: [
                "hm"
            ],
            category: "visualization",
            description:
                "Render a numeric heatmap.",
            usage:
                "heatmap <JSON matrix|numeric rows|collection> [--scale=linear|log|quantile] [--cell-size=32] [--title=Title] [--hide-values]",
            handler: ({
                args = [],
                context,
                write,
                writeNode
            }) => {
                const renderer =
                    context.heatmapRenderer ||
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

                if (
                    typeof data ===
                        "string" &&
                    !/[\n\s,;\[\{]/.test(
                        data
                    )
                ) {
                    const library =
                        context.library ||
                        context.services?.get?.(
                            "library"
                        );

                    try {
                        const collection =
                            library?.get?.(
                                data
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
                    } catch (_error) {
                        /* Use the literal command data. */
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
                        `Rendered ${node.dataset.rows || 0} heatmap rows and ${node.dataset.columns || 0} columns.`,
                        "success"
                    );
                }

                return node;
            }
        },
        {
            name:
                "heatmap-status",

            category:
                "visualization",

            description:
                "Show heatmap-renderer status.",

            usage:
                "heatmap-status",

            handler: ({
                context,
                writeJSON
            }) => {
                const renderer =
                    context.heatmapRenderer ||
                    initialize(
                        context
                    );

                const status = {
                    ...renderer.status(),
                    name:
                        MODULE_NAME,
                    scales: [
                        "linear",
                        "log",
                        "quantile"
                    ],
                    defaultCellSize:
                        DEFAULT_CELL_SIZE,
                    limits: {
                        rows:
                            DEFAULT_MAX_ROWS,
                        columns:
                            DEFAULT_MAX_COLUMNS,
                        cells:
                            DEFAULT_MAX_CELLS
                    }
                };

                return typeof writeJSON ===
                    "function"
                        ? writeJSON(
                            status
                        )
                        : status;
            }
        }
    ];

    const api = Object.freeze({
        name:
            MODULE_NAME,
        version:
            VERSION,
        RENDERER_SYMBOL,
        INSTANCE_SYMBOL,
        HeatmapRenderer,
        clone,
        normalizeMatrix,
        flattenValues,
        calculateRange,
        quantileThresholds,
        scaleValue,
        formatValue,
        renderLegend,
        buildHeatmapElement,
        render,
        initialize,
        mount:
            initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalHeatmap =
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
