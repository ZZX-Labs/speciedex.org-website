/*
========================================================================
Speciedex.org
Terminal Charts Renderer
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Charts";
    const VERSION = "2.1.0";

    const RENDERER_SYMBOL =
        Symbol.for(
            "speciedex.terminal.charts.renderer"
        );

    const INSTANCE_SYMBOL =
        Symbol.for(
            "speciedex.terminal.charts.instance"
        );
    const SVG_NS = "http://www.w3.org/2000/svg";
    const DEFAULT_WIDTH = 720;
    const DEFAULT_HEIGHT = 360;
    const DEFAULT_LIMIT = 100;
    const DEFAULT_MAX_SERIES = 32;
    const DEFAULT_MAX_POINTS = 10000;
    const DEFAULT_MAX_DIMENSION = 4096;
    const DEFAULT_METADATA_DEPTH = 12;
    const DEFAULT_TOOLTIP_DELAY = 40;

    const CHART_TYPES =
        new Set([
            "bar",
            "line",
            "area",
            "scatter"
        ]);

    function clone(
        value,
        seen =
            new WeakMap(),
        depth =
            0
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
            depth >
            DEFAULT_METADATA_DEPTH
        ) {
            return "[Truncated]";
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
                        seen,
                        depth +
                            1
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
                    seen,
                    depth +
                        1
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

    function isObject(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    function clamp(value, minimum, maximum) {
        return Math.min(maximum, Math.max(minimum, value));
    }

    function finiteNumber(value, fallback = 0) {
        const number = Number(value);
        return Number.isFinite(number) ? number : fallback;
    }

    function text(value) {
        return String(value ?? "").trim();
    }

    function titleCase(value) {
        return text(value)
            .replace(/[_-]+/g, " ")
            .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
            .replace(/\b\w/g, character => character.toUpperCase());
    }

    function createSVGElement(name, attributes = {}) {
        const element = document.createElementNS(SVG_NS, name);

        for (const [key, value] of Object.entries(attributes)) {
            if (value !== undefined && value !== null) {
                element.setAttribute(key, String(value));
            }
        }

        return element;
    }

    function dispatch(target, name, detail) {
        try {
            target.dispatchEvent(new CustomEvent(name, { detail }));
        } catch (error) {
            /* Chart events must never interrupt terminal rendering. */
        }
    }

    function normalizeOptions(options = {}) {
        const type = text(options.type || options.kind || "bar").toLowerCase();

        return {
            type: CHART_TYPES.has(type) ? type : "bar",
            title: text(options.title),
            description: text(options.description),
            labelKey: text(options.labelKey || options.xKey || "label"),
            valueKey: text(options.valueKey || options.yKey || "value"),
            seriesKey: text(options.seriesKey),
            width:
                clamp(
                    finiteNumber(
                        options.width,
                        DEFAULT_WIDTH
                    ),
                    320,
                    DEFAULT_MAX_DIMENSION
                ),

            height:
                clamp(
                    finiteNumber(
                        options.height,
                        DEFAULT_HEIGHT
                    ),
                    200,
                    DEFAULT_MAX_DIMENSION
                ),

            limit:
                clamp(
                    Math.floor(
                        finiteNumber(
                            options.limit,
                            DEFAULT_LIMIT
                        )
                    ),
                    1,
                    DEFAULT_MAX_POINTS
                ),

            maxSeries:
                clamp(
                    Math.floor(
                        finiteNumber(
                            options.maxSeries,
                            DEFAULT_MAX_SERIES
                        )
                    ),
                    1,
                    256
                ),

            maxPoints:
                clamp(
                    Math.floor(
                        finiteNumber(
                            options.maxPoints,
                            DEFAULT_MAX_POINTS
                        )
                    ),
                    1,
                    1000000
                ),
            showLegend: options.showLegend !== false,
            showTable: options.showTable !== false,
            showValues: options.showValues !== false,
            sort: text(options.sort || "none").toLowerCase(),
            emptyText: text(options.emptyText || "No chart data."),
            ariaLabel: text(options.ariaLabel),
            min: Number.isFinite(Number(options.min)) ? Number(options.min) : null,
            max:
                Number.isFinite(
                    Number(
                        options.max
                    )
                )
                    ? Number(
                        options.max
                    )
                    : null,

            stacked:
                options.stacked ===
                true,

            interactive:
                options.interactive !==
                false,

            tooltip:
                options.tooltip !==
                false,

            selectedIndex:
                Number.isFinite(
                    Number(
                        options.selectedIndex
                    )
                )
                    ? Math.max(
                        0,
                        Number(
                            options.selectedIndex
                        )
                    )
                    : null,

            valueFormatter:
                typeof options.valueFormatter ===
                    "function"
                    ? options.valueFormatter
                    : null,

            labelFormatter:
                typeof options.labelFormatter ===
                    "function"
                    ? options.labelFormatter
                    : null
        };
    }

    function rowFromValue(value, index, options) {
        if (isObject(value)) {
            const label = value[options.labelKey] ?? value.label ?? value.name ?? value.key ?? index + 1;
            const amount = value[options.valueKey] ?? value.value ?? value.count ?? value.total ?? 0;
            const series = options.seriesKey
                ? value[options.seriesKey]
                : value.series ?? value.group ?? "Series";

            return {
                label: text(label) || String(index + 1),
                value: finiteNumber(amount),
                series: text(series) || "Series",
                source: value
            };
        }

        if (Array.isArray(value)) {
            return {
                label: text(value[0]) || String(index + 1),
                value: finiteNumber(value[1]),
                series: text(value[2]) || "Series",
                source: value
            };
        }

        return {
            label: String(index + 1),
            value: finiteNumber(value),
            series: "Series",
            source: value
        };
    }

    function normalizeData(data, options = {}) {
        const normalizedOptions = normalizeOptions(options);
        let rows = [];

        if (data instanceof Map) {
            rows = Array.from(data.entries()).map(([label, value], index) =>
                rowFromValue([label, value], index, normalizedOptions)
            );
        } else if (Array.isArray(data)) {
            rows = data.map((value, index) =>
                rowFromValue(value, index, normalizedOptions)
            );
        } else if (isObject(data)) {
            if (
                Array.isArray(
                    data.records
                )
            ) {
                rows =
                    data.records.map(
                        (
                            value,
                            index
                        ) =>
                            rowFromValue(
                                value,
                                index,
                                normalizedOptions
                            )
                    );
            } else if (
                Array.isArray(
                    data.results
                )
            ) {
                rows =
                    data.results.map(
                        (
                            value,
                            index
                        ) =>
                            rowFromValue(
                                value,
                                index,
                                normalizedOptions
                            )
                    );
            } else if (Array.isArray(data.data)) {
                rows = data.data.map((value, index) =>
                    rowFromValue(value, index, normalizedOptions)
                );
            } else if (Array.isArray(data.items)) {
                rows = data.items.map((value, index) =>
                    rowFromValue(value, index, normalizedOptions)
                );
            } else {
                rows = Object.entries(data).map(([label, value], index) =>
                    rowFromValue([label, value], index, normalizedOptions)
                );
            }
        } else if (typeof data === "string") {
            const trimmed = data.trim();

            if (trimmed) {
                try {
                    return normalizeData(JSON.parse(trimmed), normalizedOptions);
                } catch (error) {
                    rows = trimmed.split(/\r?\n/).filter(Boolean).map((line, index) => {
                        const parts = line.split(/[,:\t]/);
                        return rowFromValue([parts.shift(), parts.join(":")], index, normalizedOptions);
                    });
                }
            }
        } else if (data !== undefined && data !== null) {
            rows = [rowFromValue(data, 0, normalizedOptions)];
        }

        rows =
            rows.slice(
                0,
                Math.min(
                    normalizedOptions.limit,
                    normalizedOptions.maxPoints
                )
            );

        const series =
            [
                ...new Set(
                    rows.map(
                        row =>
                            row.series
                    )
                )
            ].slice(
                0,
                normalizedOptions.maxSeries
            );

        const allowedSeries =
            new Set(
                series
            );

        rows =
            rows.filter(
                row =>
                    allowedSeries.has(
                        row.series
                    )
            );

        if (normalizedOptions.sort === "asc") {
            rows.sort((left, right) => left.value - right.value);
        } else if (normalizedOptions.sort === "desc") {
            rows.sort((left, right) => right.value - left.value);
        } else if (normalizedOptions.sort === "label") {
            rows.sort((left, right) => left.label.localeCompare(right.label, undefined, {
                numeric: true,
                sensitivity: "base"
            }));
        }

        return rows;
    }

    function bounds(rows, options) {
        const values = rows.map(row => row.value);
        let minimum = options.min ?? Math.min(0, ...values);
        let maximum = options.max ?? Math.max(0, ...values);

        if (!Number.isFinite(minimum)) minimum = 0;
        if (!Number.isFinite(maximum)) maximum = 1;
        if (minimum === maximum) {
            const padding = Math.abs(minimum || 1) * 0.1;
            minimum -= padding;
            maximum += padding;
        }

        return { minimum, maximum, range: maximum - minimum };
    }

    function appendTitle(container, options) {
        if (!options.title && !options.description) return;

        const header = document.createElement("header");
        header.className = "terminal-chart-header";

        if (options.title) {
            const heading = document.createElement("h3");
            heading.className = "terminal-chart-title";
            heading.textContent = options.title;
            header.appendChild(heading);
        }

        if (options.description) {
            const description = document.createElement("p");
            description.className = "terminal-chart-description";
            description.textContent = options.description;
            header.appendChild(description);
        }

        container.appendChild(header);
    }

    function appendAxis(svg, dimensions, chartBounds) {
        const { left, top, plotWidth, plotHeight } = dimensions;
        const zeroRatio = (0 - chartBounds.minimum) / chartBounds.range;
        const zeroY = top + plotHeight - clamp(zeroRatio, 0, 1) * plotHeight;

        svg.appendChild(createSVGElement("line", {
            class: "terminal-chart-axis terminal-chart-axis-y",
            x1: left,
            y1: top,
            x2: left,
            y2: top + plotHeight
        }));

        svg.appendChild(createSVGElement("line", {
            class: "terminal-chart-axis terminal-chart-axis-x",
            x1: left,
            y1: zeroY,
            x2: left + plotWidth,
            y2: zeroY
        }));

        for (let index = 0; index <= 4; index += 1) {
            const ratio = index / 4;
            const y = top + plotHeight - ratio * plotHeight;
            const value = chartBounds.minimum + ratio * chartBounds.range;

            svg.appendChild(createSVGElement("line", {
                class: "terminal-chart-gridline",
                x1: left,
                y1: y,
                x2: left + plotWidth,
                y2: y
            }));

            const label = createSVGElement("text", {
                class: "terminal-chart-axis-label",
                x: left - 8,
                y: y + 4,
                "text-anchor": "end"
            });
            label.textContent = Number(value.toPrecision(4)).toLocaleString();
            svg.appendChild(label);
        }
    }

    function renderBar(svg, rows, options, dimensions, chartBounds) {
        const { left, top, plotWidth, plotHeight } = dimensions;
        const slot = plotWidth / Math.max(rows.length, 1);
        const barWidth = Math.max(2, slot * 0.72);
        const zeroY = top + plotHeight - clamp((0 - chartBounds.minimum) / chartBounds.range, 0, 1) * plotHeight;

        rows.forEach((row, index) => {
            const ratio = (row.value - chartBounds.minimum) / chartBounds.range;
            const valueY = top + plotHeight - ratio * plotHeight;
            const y = Math.min(valueY, zeroY);
            const height = Math.max(1, Math.abs(zeroY - valueY));
            const x = left + slot * index + (slot - barWidth) / 2;

            const group = createSVGElement("g", {
                class: "terminal-chart-datum terminal-chart-bar",
                tabindex: "0",
                role: "img",
                "aria-label": `${row.label}: ${row.value}`
            });

            const rect = createSVGElement("rect", {
                x,
                y,
                width: barWidth,
                height,
                rx: 1,
                "data-chart-label": row.label,
                "data-chart-value": row.value
            });
            group.appendChild(rect);

            const label = createSVGElement("text", {
                class: "terminal-chart-category-label",
                x: x + barWidth / 2,
                y: top + plotHeight + 18,
                "text-anchor": "middle"
            });
            label.textContent = row.label.length > 12 ? `${row.label.slice(0, 11)}…` : row.label;
            group.appendChild(label);

            if (options.showValues) {
                const valueLabel = createSVGElement("text", {
                    class: "terminal-chart-value-label",
                    x: x + barWidth / 2,
                    y: row.value >= 0 ? y - 5 : y + height + 13,
                    "text-anchor": "middle"
                });
                valueLabel.textContent = row.value.toLocaleString();
                group.appendChild(valueLabel);
            }

            svg.appendChild(group);
        });
    }

    function pointCoordinates(rows, dimensions, chartBounds) {
        const { left, top, plotWidth, plotHeight } = dimensions;
        const denominator = Math.max(rows.length - 1, 1);

        return rows.map((row, index) => ({
            row,
            x: left + (index / denominator) * plotWidth,
            y: top + plotHeight - ((row.value - chartBounds.minimum) / chartBounds.range) * plotHeight
        }));
    }

    function renderLine(svg, rows, options, dimensions, chartBounds) {
        const points = pointCoordinates(rows, dimensions, chartBounds);
        const coordinates = points.map(point => `${point.x},${point.y}`).join(" ");

        if (options.type === "area" && points.length) {
            const baseline = dimensions.top + dimensions.plotHeight;
            const area = createSVGElement("polygon", {
                class: "terminal-chart-area",
                points: `${points[0].x},${baseline} ${coordinates} ${points[points.length - 1].x},${baseline}`
            });
            svg.appendChild(area);
        }

        if (options.type !== "scatter") {
            svg.appendChild(createSVGElement("polyline", {
                class: "terminal-chart-line",
                points: coordinates,
                fill: "none"
            }));
        }

        points.forEach(point => {
            const group = createSVGElement("g", {
                class: "terminal-chart-datum terminal-chart-point",
                tabindex: "0",
                role: "img",
                "aria-label": `${point.row.label}: ${point.row.value}`
            });

            group.appendChild(createSVGElement("circle", {
                cx: point.x,
                cy: point.y,
                r: options.type === "scatter" ? 5 : 3,
                "data-chart-label": point.row.label,
                "data-chart-value": point.row.value
            }));

            const label = createSVGElement("text", {
                class: "terminal-chart-category-label",
                x: point.x,
                y: dimensions.top + dimensions.plotHeight + 18,
                "text-anchor": "middle"
            });
            label.textContent = point.row.label.length > 12
                ? `${point.row.label.slice(0, 11)}…`
                : point.row.label;
            group.appendChild(label);

            svg.appendChild(group);
        });
    }

    function appendLegend(
        container,
        rows,
        options
    ) {
        if (
            !options.showLegend
        ) {
            return;
        }

        const series =
            [
                ...new Set(
                    rows.map(
                        row =>
                            row.series
                    )
                )
            ];

        if (
            series.length <
            2
        ) {
            return;
        }

        const legend =
            document.createElement(
                "ul"
            );

        legend.className =
            "terminal-chart-legend";

        legend.setAttribute(
            "aria-label",
            "Chart series"
        );

        for (
            const value of
            series
        ) {
            const item =
                document.createElement(
                    "li"
                );

            item.className =
                "terminal-chart-legend-item";

            item.dataset.chartSeries =
                value;

            item.textContent =
                value;

            legend.appendChild(
                item
            );
        }

        container.appendChild(
            legend
        );
    }

    function ensureTooltip(
        container
    ) {
        let tooltip =
            container.querySelector(
                ".terminal-chart-tooltip"
            );

        if (tooltip) {
            return tooltip;
        }

        tooltip =
            document.createElement(
                "output"
            );

        tooltip.className =
            "terminal-chart-tooltip";

        tooltip.hidden =
            true;

        tooltip.setAttribute(
            "role",
            "status"
        );

        tooltip.setAttribute(
            "aria-live",
            "polite"
        );

        container.appendChild(
            tooltip
        );

        return tooltip;
    }

    function installInteractions(
        container,
        rows,
        options
    ) {
        if (
            !options.interactive
        ) {
            return;
        }

        const tooltip =
            options.tooltip
                ? ensureTooltip(
                    container
                )
                : null;

        const data =
            Array.from(
                container.querySelectorAll(
                    ".terminal-chart-datum"
                )
            );

        const selectDatum =
            (
                element,
                index,
                sourceEvent =
                    null
            ) => {
                for (
                    const item of
                    data
                ) {
                    item.setAttribute(
                        "aria-selected",
                        "false"
                    );
                }

                element.setAttribute(
                    "aria-selected",
                    "true"
                );

                const row =
                    rows[
                        index
                    ] ||
                    null;

                if (
                    tooltip &&
                    row
                ) {
                    tooltip.hidden =
                        false;

                    tooltip.textContent =
                        `${row.label}: ${
                            options.valueFormatter
                                ? options.valueFormatter(
                                    row.value,
                                    row
                                )
                                : row.value.toLocaleString()
                        }`;
                }

                dispatch(
                    container,
                    "speciedex:terminal-chart-select",
                    {
                        index,
                        row:
                            clone(
                                row
                            ),
                        sourceEvent
                    }
                );
            };

        data.forEach(
            (
                element,
                index
            ) => {
                element.dataset.chartIndex =
                    String(
                        index
                    );

                element.setAttribute(
                    "aria-selected",
                    options.selectedIndex ===
                        index
                        ? "true"
                        : "false"
                );

                element.addEventListener(
                    "click",
                    event =>
                        selectDatum(
                            element,
                            index,
                            event
                        )
                );

                element.addEventListener(
                    "focus",
                    () => {
                        const row =
                            rows[
                                index
                            ];

                        if (
                            tooltip &&
                            row
                        ) {
                            tooltip.hidden =
                                false;

                            tooltip.textContent =
                                `${row.label}: ${row.value.toLocaleString()}`;
                        }
                    }
                );

                element.addEventListener(
                    "blur",
                    () => {
                        if (
                            tooltip
                        ) {
                            tooltip.hidden =
                                true;
                        }
                    }
                );

                element.addEventListener(
                    "keydown",
                    event => {
                        if (
                            event.key ===
                                "Enter" ||
                            event.key ===
                                " "
                        ) {
                            event.preventDefault();

                            selectDatum(
                                element,
                                index,
                                event
                            );

                            return;
                        }

                        if (
                            ![
                                "ArrowRight",
                                "ArrowDown",
                                "ArrowLeft",
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

                        const next =
                            event.key ===
                                "Home"
                                ? 0
                                : event.key ===
                                    "End"
                                    ? data.length -
                                        1
                                    : event.key ===
                                        "ArrowRight" ||
                                      event.key ===
                                        "ArrowDown"
                                        ? Math.min(
                                            data.length -
                                                1,
                                            index +
                                                1
                                        )
                                        : Math.max(
                                            0,
                                            index -
                                                1
                                        );

                        data[
                            next
                        ]?.focus();
                    }
                );
            }
        );

        if (
            options.selectedIndex !==
                null
        ) {
            const selected =
                data[
                    Math.min(
                        options.selectedIndex,
                        data.length -
                            1
                    )
                ];

            if (selected) {
                selected.setAttribute(
                    "aria-selected",
                    "true"
                );
            }
        }
    }

    function appendTable(container, rows, options) {
        if (!options.showTable) return;

        const details = document.createElement("details");
        details.className = "terminal-chart-data";

        const summary = document.createElement("summary");
        summary.textContent = `Chart data (${rows.length})`;
        details.appendChild(summary);

        const table = document.createElement("table");
        table.className = "terminal-chart-table";

        const thead = document.createElement("thead");
        const headRow = document.createElement("tr");
        for (const label of ["Label", "Value", "Series"]) {
            const th = document.createElement("th");
            th.scope = "col";
            th.textContent = label;
            headRow.appendChild(th);
        }
        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = document.createElement("tbody");
        rows.forEach(row => {
            const tr = document.createElement("tr");
            [row.label, row.value.toLocaleString(), row.series].forEach(value => {
                const td = document.createElement("td");
                td.textContent = value;
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        details.appendChild(table);
        container.appendChild(details);
    }

    function buildChartElement(
        data,
        rawOptions =
            {}
    ) {
        const options = normalizeOptions(rawOptions);
        const rows = normalizeData(data, options);
        const container = document.createElement("figure");

        container.className = `terminal-renderer terminal-renderer-chart terminal-chart-${options.type}`;
        container.dataset.renderer = "chart";
        container.dataset.chartType = options.type;
        container.dataset.chartRows = String(rows.length);

        appendTitle(container, options);

        if (!rows.length) {
            const empty = document.createElement("p");
            empty.className = "terminal-chart-empty";
            empty.textContent = options.emptyText;
            container.appendChild(empty);
            return container;
        }

        const svg = createSVGElement("svg", {
            class: "terminal-chart-svg",
            viewBox: `0 0 ${options.width} ${options.height}`,
            width: options.width,
            height: options.height,
            role: "img",
            "aria-label": options.ariaLabel || options.title || `${titleCase(options.type)} chart`
        });

        const title = createSVGElement("title");
        title.textContent = options.ariaLabel || options.title || `${titleCase(options.type)} chart`;
        svg.appendChild(title);

        const dimensions = {
            left: 72,
            top: 28,
            plotWidth: options.width - 100,
            plotHeight: options.height - 82
        };
        const chartBounds = bounds(rows, options);

        appendAxis(svg, dimensions, chartBounds);

        if (options.type === "bar") {
            renderBar(svg, rows, options, dimensions, chartBounds);
        } else {
            renderLine(svg, rows, options, dimensions, chartBounds);
        }

        container.appendChild(
            svg
        );

        appendLegend(
            container,
            rows,
            options
        );

        appendTable(
            container,
            rows,
            options
        );

        installInteractions(
            container,
            rows,
            options
        );

        dispatch(container, "speciedex:terminal-chart-rendered", {
            container,
            rows,
            options
        });

        return container;
    }

    class ChartRenderer extends EventTarget {
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
                exports:
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
                    "Chart renderer has been destroyed."
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
                buildChartElement(
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
                selectedIndex:
                    options.selectedIndex ??
                    null,
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
                            ...nextOptions,
                            selectedIndex:
                                state.selectedIndex
                        };

                        const replacement =
                            buildChartElement(
                                state.data,
                                state.options
                            );

                        container.className =
                            replacement.className;

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
                            "speciedex:terminal-chart-refresh",
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

                setType:
                    type =>
                        instance.refresh(
                            state.data,
                            {
                                type
                            }
                        ),

                setSort:
                    sort =>
                        instance.refresh(
                            state.data,
                            {
                                sort
                            }
                        ),

                select:
                    index => {
                        const numeric =
                            clamp(
                                Math.floor(
                                    finiteNumber(
                                        index,
                                        0
                                    )
                                ),
                                0,
                                Math.max(
                                    0,
                                    Number(
                                        container.dataset.
                                            chartRows ||
                                        1
                                    ) -
                                    1
                                )
                            );

                        state.selectedIndex =
                            numeric;

                        state.options.selectedIndex =
                            numeric;

                        const item =
                            container.querySelector(
                                `[data-chart-index="${numeric}"]`
                            );

                        item?.dispatchEvent(
                            new MouseEvent(
                                "click",
                                {
                                    bubbles:
                                        true
                                }
                            )
                        );

                        return numeric;
                    },

                getData:
                    () =>
                        normalizeData(
                            state.data,
                            state.options
                        ).map(
                            clone
                        ),

                toJSON:
                    (
                        exportOptions =
                            {}
                    ) =>
                        JSON.stringify(
                            instance.getData(),
                            null,
                            exportOptions.compact ===
                                true
                                ? 0
                                : 2
                        ),

                toCSV:
                    () => {
                        const cell =
                            value =>
                                `"${String(value ?? "").replace(/"/g, '""')}"`;

                        return [
                            [
                                "label",
                                "value",
                                "series"
                            ].map(
                                cell
                            ).join(
                                ","
                            ),
                            ...instance.getData().
                                map(
                                    row =>
                                        [
                                            row.label,
                                            row.value,
                                            row.series
                                        ].map(
                                            cell
                                        ).join(
                                            ","
                                        )
                                )
                        ].join(
                            "\r\n"
                        );
                    },

                status:
                    () => ({
                        version:
                            VERSION,
                        type:
                            container.dataset.chartType ||
                            state.options.type ||
                            "bar",
                        rows:
                            Number(
                                container.dataset.chartRows ||
                                0
                            ),
                        selectedIndex:
                            state.selectedIndex,
                        width:
                            normalizeOptions(
                                state.options
                            ).width,
                        height:
                            normalizeOptions(
                                state.options
                            ).height,
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

                        delete container[
                            INSTANCE_SYMBOL
                        ];

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

            container.chartInstance =
                instance;

            container.update =
                instance.refresh;

            container.setData =
                instance.setData;

            container.destroy =
                instance.destroy;

            container.addEventListener(
                "speciedex:terminal-chart-select",
                event => {
                    state.selectedIndex =
                        event.detail?.
                            index ??
                        null;

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

        normalize(
            data,
            options =
                {}
        ) {
            return normalizeData(
                data,
                options
            );
        }

        types() {
            return Array.from(
                CHART_TYPES
            );
        }

        activeInstance() {
            const element =
                this.context.root?.
                    querySelector?.(
                        ".terminal-renderer-chart"
                    ) ||
                document.querySelector(
                    ".terminal-renderer-chart"
                );

            return (
                element?.[
                    INSTANCE_SYMBOL
                ] ||
                element?.
                    chartInstance ||
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
                types:
                    this.types(),
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
        return new ChartRenderer(
            {}
        ).render(
            data,
            options
        );
    }

    function initialize(
        context
    ) {
        if (
            !context ||
            typeof context !==
                "object"
        ) {
            throw new TypeError(
                "A terminal context is required to initialize Charts."
            );
        }

        const root =
            context.root;

        const existing =
            context.chartRenderer instanceof
                ChartRenderer
                ? context.chartRenderer
                : root?.[
                    RENDERER_SYMBOL
                ];

        if (
            existing instanceof
                ChartRenderer &&
            !existing.destroyed
        ) {
            context.chartRenderer =
                existing;

            context.registerRenderer?.(
                "chart",
                existing
            );

            context.registerRenderer?.(
                "charts",
                existing
            );

            context.registerService?.(
                "charts",
                existing
            );

            return existing;
        }

        const renderer =
            new ChartRenderer(
                context
            );

        root[
            RENDERER_SYMBOL
        ] =
            renderer;

        context.chartRenderer =
            renderer;

        context.registerRenderer?.(
            "chart",
            renderer
        );

        context.registerRenderer?.(
            "charts",
            renderer
        );

        context.registerVisualization?.(
            "chart",
            renderer
        );

        context.registerService?.(
            "charts",
            renderer
        );

        dispatch(
            document,
            "speciedex:terminal-charts-ready",
            {
                renderer,
                version:
                    VERSION
            }
        );

        return renderer;
    }

    function parseCommand(args) {
        const tokens = Array.isArray(args) ? [...args] : [];
        const options = {};
        const values = [];

        while (tokens.length) {
            const token = tokens.shift();

            if (token.startsWith("--")) {
                const raw = token.slice(2);
                const equals = raw.indexOf("=");
                const key = equals >= 0 ? raw.slice(0, equals) : raw;
                const value = equals >= 0 ? raw.slice(equals + 1) : tokens.shift();

                if (["table", "values", "legend"].includes(key)) {
                    options[`show${titleCase(key)}`] = !["0", "false", "no", "off"].includes(
                        text(value || "true").toLowerCase()
                    );
                } else {
                    options[key] = value ?? true;
                }
                continue;
            }

            values.push(token);
        }

        if (values.length && CHART_TYPES.has(values[0].toLowerCase())) {
            options.type = values.shift().toLowerCase();
        }

        if (
            options[
                "label-key"
            ] !==
            undefined
        ) {
            options.labelKey =
                options[
                    "label-key"
                ];
        }

        if (
            options[
                "value-key"
            ] !==
            undefined
        ) {
            options.valueKey =
                options[
                    "value-key"
                ];
        }

        if (
            options[
                "series-key"
            ] !==
            undefined
        ) {
            options.seriesKey =
                options[
                    "series-key"
                ];
        }

        if (
            options[
                "max-points"
            ] !==
            undefined
        ) {
            options.maxPoints =
                options[
                    "max-points"
                ];
        }

        if (
            options[
                "max-series"
            ] !==
            undefined
        ) {
            options.maxSeries =
                options[
                    "max-series"
                ];
        }

        return {
            options,
            source:
                values.join(
                    " "
                ).trim()
        };
    }

    const commands = [{
        name: "chart",
        aliases: ["charts", "plot"],
        category: "visualization",
        description: "Render terminal data as an accessible SVG chart.",
        usage: "chart [bar|line|area|scatter] <JSON|label:value|collection> [--title=TEXT] [--sort=asc|desc|label] [--label-key=FIELD] [--value-key=FIELD]",
        handler: ({ args, context, write }) => {
            const parsed = parseCommand(args);

            if (!parsed.source) {
                return write(
                    "Usage: chart [bar|line|area|scatter] <JSON|label:value ...> [--title=TEXT]",
                    "help"
                );
            }

            let data;

            const library =
                context.library ||
                context.services?.get?.(
                    "library"
                );

            if (
                !/[\s,:;\[\{]/.test(
                    parsed.source
                )
            ) {
                try {
                    const collection =
                        library?.get?.(
                            parsed.source
                        );

                    if (
                        collection !==
                            undefined &&
                        collection !==
                            null
                    ) {
                        data =
                            collection;
                    }
                } catch (_error) {
                    /* Continue with literal parsing. */
                }
            }

            if (
                data ===
                undefined
            ) {
                try {
                    data =
                        JSON.parse(
                            parsed.source
                        );
                } catch (_error) {
                    data =
                        parsed.source
                            .split(
                                /\s+/
                            )
                            .filter(
                                Boolean
                            )
                            .map(
                                (
                                    item,
                                    index
                                ) => {
                                    const separator =
                                        item.indexOf(
                                            ":"
                                        );

                                    return separator >=
                                        0
                                        ? [
                                            item.slice(
                                                0,
                                                separator
                                            ),
                                            item.slice(
                                                separator +
                                                1
                                            )
                                        ]
                                        : [
                                            String(
                                                index +
                                                1
                                            ),
                                            item
                                        ];
                                }
                            );
                }
            }

            const renderer = context.chartRenderer || context.getRenderer?.("chart");
            if (!renderer || typeof renderer.render !== "function") {
                throw new Error("The chart renderer is unavailable.");
            }

            const node = renderer.render(data, parsed.options);
            if (typeof context.app?.append === "function") {
                context.app.append(node);
                return node;
            }

            return write(node.textContent || "Chart rendered.", "output");
        }
    },
        {
            name:
                "chart-status",

            category:
                "visualization",

            description:
                "Display chart-renderer diagnostics.",

            usage:
                "chart-status",

            handler: ({
                context,
                writeJSON
            }) => {
                const renderer =
                    context.chartRenderer ||
                    initialize(
                        context
                    );

                const status =
                    renderer.status();

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
                "chart-type",

            category:
                "visualization",

            description:
                "Change the active chart type.",

            usage:
                "chart-type <bar|line|area|scatter>",

            handler: ({
                args = [],
                context,
                writeJSON
            }) => {
                const renderer =
                    context.chartRenderer ||
                    initialize(
                        context
                    );

                const instance =
                    renderer.activeInstance();

                if (!instance) {
                    throw new Error(
                        "No active chart renderer is available."
                    );
                }

                const type =
                    text(
                        args[0]
                    ).toLowerCase();

                if (
                    !CHART_TYPES.has(
                        type
                    )
                ) {
                    throw new Error(
                        "Use: chart-type bar|line|area|scatter"
                    );
                }

                instance.setType(
                    type
                );

                return typeof writeJSON ===
                    "function"
                        ? writeJSON(
                            instance.status()
                        )
                        : instance.status();
            }
        },

        {
            name:
                "chart-sort",

            category:
                "visualization",

            description:
                "Change the active chart sorting mode.",

            usage:
                "chart-sort <none|asc|desc|label>",

            handler: ({
                args = [],
                context,
                writeJSON
            }) => {
                const renderer =
                    context.chartRenderer ||
                    initialize(
                        context
                    );

                const instance =
                    renderer.activeInstance();

                if (!instance) {
                    throw new Error(
                        "No active chart renderer is available."
                    );
                }

                const sort =
                    text(
                        args[0] ||
                        "none"
                    ).toLowerCase();

                if (
                    ![
                        "none",
                        "asc",
                        "desc",
                        "label"
                    ].includes(
                        sort
                    )
                ) {
                    throw new Error(
                        "Use: chart-sort none|asc|desc|label"
                    );
                }

                instance.setSort(
                    sort
                );

                return typeof writeJSON ===
                    "function"
                        ? writeJSON(
                            instance.status()
                        )
                        : instance.status();
            }
        },

        {
            name:
                "chart-export",

            category:
                "visualization",

            description:
                "Export active chart data as CSV or JSON.",

            usage:
                "chart-export <csv|json> [filename]",

            handler: ({
                args = [],
                context,
                write
            }) => {
                const renderer =
                    context.chartRenderer ||
                    initialize(
                        context
                    );

                const instance =
                    renderer.activeInstance();

                if (!instance) {
                    throw new Error(
                        "No active chart renderer is available."
                    );
                }

                const format =
                    text(
                        args[0] ||
                        "csv"
                    ).toLowerCase();

                const filename =
                    args[1] ||
                    `speciedex-chart.${format === "json" ? "json" : "csv"}`;

                const content =
                    format ===
                        "json"
                        ? instance.toJSON()
                        : instance.toCSV();

                const exporter =
                    context.exporter ||
                    context.services?.get?.(
                        "export"
                    );

                if (
                    exporter &&
                    typeof exporter.text ===
                        "function"
                ) {
                    exporter.text(
                        content,
                        filename,
                        format ===
                            "json"
                            ? "application/json;charset=utf-8"
                            : "text/csv;charset=utf-8",
                        {
                            format
                        }
                    );
                } else {
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
                }

                renderer.metrics.exports +=
                    1;

                return typeof write ===
                    "function"
                        ? write(
                            `Chart data exported to ${filename}.`,
                            "success"
                        )
                        : {
                            filename,
                            format
                        };
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
        initialize,
        mount: initialize,
        init: initialize,
        setup:
            initialize,
        render,
        buildChartElement,
        normalizeOptions,
        normalizeData,
        bounds,
        appendLegend,
        installInteractions,
        clone,
        ChartRenderer,
        commands
    });

    window.SpeciedexTerminalCharts = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
