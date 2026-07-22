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
    const VERSION = "2.0.0";

    const DEFAULT_CELL_SIZE = 32;
    const MIN_CELL_SIZE = 12;
    const MAX_CELL_SIZE = 96;

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

    function normalizeMatrix(data) {
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
                    JSON.parse(trimmed)
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

                return normalizeMatrix(rows);
            }
        }

        if (Array.isArray(data)) {
            if (
                data.every(row =>
                    Array.isArray(row)
                )
            ) {
                const rows =
                    data.map(row =>
                        row.map(value =>
                            finiteNumber(value)
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
                const rowLabels =
                    [
                        ...new Set(
                            data.map(item =>
                                safeString(
                                    item.row ??
                                    item.y
                                )
                            )
                        )
                    ];

                const columnLabels =
                    [
                        ...new Set(
                            data.map(item =>
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

                for (const item of data) {
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
                const columnLabels =
                    [
                        ...new Set(
                            data.flatMap(item =>
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
                    data.map(
                        (item, index) =>
                            safeString(
                                item.label ??
                                item.name ??
                                item.row ??
                                index + 1
                            )
                    );

                const rows =
                    data.map(item =>
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

        return {
            minimum,
            maximum,
            span:
                maximum - minimum
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

        if (mode === "log") {
            const minimum =
                Math.max(
                    Number.EPSILON,
                    range.minimum
                );

            const maximum =
                Math.max(
                    minimum,
                    range.maximum
                );

            const normalizedValue =
                Math.max(
                    minimum,
                    value
                );

            return (
                Math.log(normalizedValue) -
                Math.log(minimum)
            ) / (
                Math.log(maximum) -
                Math.log(minimum)
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

            return (
                thresholds.length
                    ? bucket /
                      thresholds.length
                    : 1
            );
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

    function render(data, options = {}) {
        const matrix =
            normalizeMatrix(data);

        const values =
            flattenValues(matrix);

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

    function initialize(context) {
        if (
            context.heatmapRenderer &&
            context.heatmapRenderer.version ===
            VERSION
        ) {
            return context.heatmapRenderer;
        }

        const renderer =
            Object.freeze({
                name: MODULE_NAME,
                version: VERSION,
                render,
                normalizeMatrix,
                calculateRange,
                scaleValue,
                quantileThresholds
            });

        context.registerRenderer?.(
            "heatmap",
            renderer
        );

        context.registerRenderer?.(
            "matrix-heatmap",
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
                renderer
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
            showValues: true
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
                "heatmap <JSON matrix or numeric rows> [--scale=linear|log|quantile] [--cell-size=32] [--title=Title] [--hide-values]",
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
                        `Rendered ${node.dataset.rows || 0} heatmap rows and ${node.dataset.columns || 0} columns.`,
                        "success"
                    );
                }

                return node;
            }
        },
        {
            name: "heatmap-status",
            category: "visualization",
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
                    initialize(context);

                const status = {
                    name:
                        renderer.name,
                    version:
                        renderer.version,
                    scales: [
                        "linear",
                        "log",
                        "quantile"
                    ],
                    defaultCellSize:
                        DEFAULT_CELL_SIZE
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
        normalizeMatrix,
        flattenValues,
        calculateRange,
        quantileThresholds,
        scaleValue,
        formatValue,
        renderLegend,
        render,
        initialize,
        mount: initialize,
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
