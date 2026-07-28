/*
========================================================================
Speciedex.org
Terminal Matrix Renderer
========================================================================

Reusable canvas-backed matrix renderer for SpeciedexTerminal.

This module is the shared matrix foundation used by:

    • terminal-cmatrix.js
    • terminal-zmatrix.js
    • terminal-provider-matrix.js
    • terminal-heatmap.js
    • terminal-splash.js

Capabilities:

    • Numeric, categorical, boolean, and null cells
    • Automatic normalization and field discovery
    • Row and column labels
    • Configurable cell sizing, spacing, padding, and typography
    • Dark Speciedex tactical rendering with #c0d674 accents
    • Responsive canvas resizing
    • Animated entry and value transitions
    • Hover and keyboard inspection
    • Cell selection
    • Viewport panning and wheel zoom
    • PNG, JSON, and CSV export
    • Lifecycle and renderer events
    • Terminal commands
    • Clean teardown

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME =
        "Matrix";

    const VERSION =
        "2.2.0";

    const REGISTRY_SYMBOL =
        Symbol.for(
            "speciedex.terminal.matrix.registry"
        );

    const CONTROLLER_SYMBOL =
        Symbol.for(
            "speciedex.terminal.matrix.controller"
        );

    const RENDERER_SYMBOL =
        Symbol.for(
            "speciedex.terminal.matrix.renderer"
        );

    const RESERVED_KEYS =
        new Set([
            "__proto__",
            "prototype",
            "constructor"
        ]);

    const activeDispatches =
        new WeakMap();

    const PRIMARY_COLOR =
        "#c0d674";

    const ACCENT_COLOR =
        "#e6a42b";

    const BACKGROUND_COLOR =
        "#07100a";

    const DEFAULT_OPTIONS =
        Object.freeze({
            width:
                960,

            height:
                540,

            minHeight:
                320,

            minCellSize:
                7,

            maxCellSize:
                56,

            gap:
                1,

            padding:
                24,

            labelWidth:
                112,

            labelHeight:
                32,

            showLabels:
                true,

            showValues:
                false,

            showGrid:
                true,

            showLegend:
                false,

            animate:
                true,

            animationDuration:
                320,

            responsive:
                true,

            autoStart:
                true,

            interactive:
                true,

            selectable:
                true,

            keyboard:
                true,

            pan:
                true,

            zoom:
                true,

            zoomMinimum:
                0.4,

            zoomMaximum:
                4,

            zoomStep:
                0.12,

            alphaMinimum:
                0.08,

            alphaMaximum:
                0.92,

            background:
                BACKGROUND_COLOR,

            primaryColor:
                PRIMARY_COLOR,

            accentColor:
                ACCENT_COLOR,

            nullColor:
                "rgba(216, 230, 219, 0.055)",

            gridColor:
                "rgba(192, 214, 116, 0.09)",

            labelColor:
                "rgba(216, 230, 219, 0.74)",

            valueColor:
                "rgba(216, 230, 219, 0.86)",

            fontFamily:
                '"IBM Plex Mono", ui-monospace, SFMono-Regular, Consolas, monospace',

            fontSize:
                11,

            valueFormatter:
                null,

            colorResolver:
                null,

            rowLabels:
                null,

            columnLabels:
                null,

            maximumRows:
                5000,

            maximumColumns:
                128,

            reducedMotion:
                window.matchMedia?.(
                    "(prefers-reduced-motion: reduce)"
                )?.matches ===
                    true,

            autoFit:
                true
        });

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

    function monotonicNow() {
        return (
            typeof performance !== "undefined" &&
            typeof performance.now === "function"
        )
            ? monotonicNow()
            : Date.now();
    }

    function requestFrame(callback) {
        return typeof window.requestAnimationFrame ===
            "function"
                ? requestFrame(callback)
                : window.setTimeout(
                    () =>
                        callback(
                            monotonicNow()
                        ),
                    16
                );
    }

    function cancelFrame(handle) {
        if (!handle) {
            return;
        }

        if (
            typeof window.cancelAnimationFrame ===
                "function"
        ) {
            cancelFrame(handle);
        } else {
            window.clearTimeout(handle);
        }
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

    function safeClone(
        value,
        seen = new WeakMap(),
        depth = 0
    ) {
        if (
            value === null ||
            value === undefined ||
            typeof value !== "object"
        ) {
            return typeof value === "bigint"
                ? String(value)
                : value;
        }

        if (depth > 24) {
            return "[Truncated]";
        }

        if (seen.has(value)) {
            return "[Circular]";
        }

        seen.set(value, true);

        if (value instanceof Date) {
            return Number.isFinite(
                value.getTime()
            )
                ? value.toISOString()
                : "Invalid Date";
        }

        if (value instanceof Error) {
            return {
                name:
                    value.name,
                message:
                    value.message,
                stack:
                    value.stack ||
                    null
            };
        }

        if (Array.isArray(value)) {
            return value.map(
                item =>
                    safeClone(
                        item,
                        seen,
                        depth + 1
                    )
            );
        }

        const output =
            {};

        for (
            const [key, item]
            of Object.entries(value)
        ) {
            if (RESERVED_KEYS.has(key)) {
                continue;
            }

            output[key] =
                safeClone(
                    item,
                    seen,
                    depth + 1
                );
        }

        return output;
    }

    function safeStringify(
        value,
        compact = false
    ) {
        return JSON.stringify(
            safeClone(value),
            null,
            compact
                ? 0
                : 2
        );
    }

    function clamp(
        value,
        minimum,
        maximum
    ) {
        const numeric =
            Number(value);

        const lower =
            Math.min(
                Number(minimum),
                Number(maximum)
            );

        const upper =
            Math.max(
                Number(minimum),
                Number(maximum)
            );

        if (!Number.isFinite(numeric)) {
            return Number.isFinite(lower)
                ? lower
                : 0;
        }

        return Math.min(
            upper,
            Math.max(
                lower,
                numeric
            )
        );
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

    function parseBoolean(
        value,
        fallback = false
    ) {
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

    function normalizeLabel(value) {
        return String(
            value ?? ""
        ).trim();
    }

    function isCanvas(value) {
        return Boolean(
            value &&
            String(
                value.tagName ||
                ""
            ).toLowerCase() ===
                "canvas" &&
            typeof value.getContext ===
                "function"
        );
    }

    function isElement(value) {
        return Boolean(
            value &&
            value.nodeType ===
                1 &&
            typeof value.querySelector ===
                "function"
        );
    }

    function resolveCanvas(target) {
        if (isCanvas(target)) {
            return target;
        }

        if (
            isElement(
                target
            )
        ) {
            const existing =
                target.querySelector(
                    "canvas[data-terminal-matrix-canvas], canvas"
                );

            if (existing) {
                return existing;
            }

            const canvas =
                document.createElement(
                    "canvas"
                );

            canvas.dataset.terminalMatrixCanvas =
                "";

            target.appendChild(
                canvas
            );

            return canvas;
        }

        throw new TypeError(
            "Matrix renderer requires a canvas or container element."
        );
    }

    function flattenRows(
        data,
        options = {}
    ) {
        if (!Array.isArray(data)) {
            return {
                rows:
                    [],
                columns:
                    []
            };
        }

        const maximumRows =
            clampInteger(
                options.maximumRows,
                DEFAULT_OPTIONS.maximumRows,
                1,
                1000000
            );

        const source =
            data.slice(
                0,
                maximumRows
            );

        if (
            source.every(
                row =>
                    Array.isArray(
                        row
                    )
            )
        ) {
            const maximum =
                source.reduce(
                    (
                        value,
                        row
                    ) =>
                        Math.max(
                            value,
                            row.length
                        ),
                    0
                );

            const maximumColumns =
                clampInteger(
                    options.maximumColumns,
                    DEFAULT_OPTIONS.maximumColumns,
                    1,
                    10000
                );

            const columnCount =
                Math.min(
                    maximum,
                    maximumColumns
                );

            return {
                rows:
                    source.map(
                        row =>
                            row.slice(
                                0,
                                columnCount
                            )
                    ),
                columns:
                    Array.from(
                        {
                            length:
                                columnCount
                        },
                        (
                            _,
                            index
                        ) =>
                            String(
                                index +
                                1
                            )
                    )
            };
        }

        if (
            source.every(
                row =>
                    row &&
                    typeof row ===
                        "object" &&
                    !Array.isArray(
                        row
                    )
            )
        ) {
            const requested =
                Array.isArray(
                    options.columns
                )
                    ? options.columns
                        .map(
                            normalizeLabel
                        )
                        .filter(
                            Boolean
                        )
                    : [];

            const preferred = [
                "scientific_name",
                "scientificName",
                "canonical_name",
                "canonicalName",
                "common_name",
                "commonName",
                "rank",
                "provider",
                "source",
                "kingdom",
                "phylum",
                "class",
                "order",
                "family",
                "genus",
                "species",
                "speciedex_id",
                "speciedexId",
                "taxon_id",
                "taxonId",
                "id"
            ];

            const discovered =
                [
                    ...new Set(
                        source.flatMap(
                            row =>
                                Object.keys(
                                    row
                                ).filter(
                                    key =>
                                        !RESERVED_KEYS.has(
                                            key
                                        )
                                )
                        )
                    )
                ];

            const ordered =
                [
                    ...preferred.filter(
                        field =>
                            discovered.includes(
                                field
                            )
                    ),
                    ...discovered.filter(
                        field =>
                            !preferred.includes(
                                field
                            )
                    )
                ];

            const maximumColumns =
                clampInteger(
                    options.maximumColumns,
                    DEFAULT_OPTIONS.maximumColumns,
                    1,
                    10000
                );

            const columns =
                (
                    requested.length
                        ? requested
                        : ordered
                ).slice(
                    0,
                    maximumColumns
                );

            return {
                rows:
                    source.map(
                        row =>
                            columns.map(
                                column =>
                                    row[
                                        column
                                    ]
                            )
                    ),
                columns
            };
        }

        return {
            rows:
                [
                    source
                ],
            columns:
                source.map(
                    (
                        _,
                        index
                    ) =>
                        String(
                            index +
                                1
                        )
                )
        };
    }

    function numericValue(value) {
        if (
            value === null ||
            value === undefined ||
            value === ""
        ) {
            return null;
        }

        if (
            typeof value ===
            "boolean"
        ) {
            return value
                ? 1
                : 0;
        }

        const parsed =
            Number(value);

        return Number.isFinite(
            parsed
        )
            ? parsed
            : null;
    }

    function hashString(value) {
        const text =
            String(
                value ?? ""
            );

        let hash =
            2166136261;

        for (
            let index = 0;
            index < text.length;
            index += 1
        ) {
            hash ^=
                text.charCodeAt(
                    index
                );

            hash =
                Math.imul(
                    hash,
                    16777619
                );
        }

        return hash >>>
            0;
    }

    function normalizeMatrix(
        data,
        options = {}
    ) {
        const flattened =
            flattenRows(
                data,
                options
            );

        const rows =
            flattened.rows;

        const rowCount =
            rows.length;

        const columnCount =
            rows.reduce(
                (
                    maximum,
                    row
                ) =>
                    Math.max(
                        maximum,
                        row.length
                    ),
                0
            );

        const values =
            rows.flat();

        const numeric =
            values
                .map(
                    numericValue
                )
                .filter(
                    value =>
                        value !==
                        null
                );

        let minimum =
            0;

        let maximum =
            1;

        if (
            numeric.length
        ) {
            minimum =
                Infinity;

            maximum =
                -Infinity;

            for (
                const value of
                numeric
            ) {
                if (
                    value <
                    minimum
                ) {
                    minimum =
                        value;
                }

                if (
                    value >
                    maximum
                ) {
                    maximum =
                        value;
                }
            }
        }

        const range =
            maximum -
            minimum ||
            1;

        const categorical =
            [
                ...new Set(
                    values
                        .filter(
                            value =>
                                value !==
                                    null &&
                                value !==
                                    undefined &&
                                numericValue(
                                    value
                                ) ===
                                    null
                        )
                        .map(
                            value =>
                                normalizeLabel(
                                    value
                                )
                        )
                )
            ];

        const rowLabels =
            Array.isArray(
                options.rowLabels
            )
                ? options.rowLabels.map(
                    normalizeLabel
                )
                : rows.map(
                    (
                        _,
                        index
                    ) =>
                        String(
                            index +
                            1
                        )
                );

        const columnLabels =
            Array.isArray(
                options.columnLabels
            )
                ? options.columnLabels.map(
                    normalizeLabel
                )
                : flattened.columns.length
                    ? flattened.columns.map(
                        normalizeLabel
                    )
                    : Array.from(
                        {
                            length:
                                columnCount
                        },
                        (
                            _,
                            index
                        ) =>
                            String(
                                index +
                                1
                            )
                    );

        return {
            rows,
            rowCount,
            columnCount,
            minimum,
            maximum,
            range,
            numericCount:
                numeric.length,
            categorical,
            rowLabels,
            columnLabels
        };
    }

    function cellIntensity(
        value,
        matrix
    ) {
        if (
            value === null ||
            value === undefined ||
            value === ""
        ) {
            return 0;
        }

        const numeric =
            numericValue(
                value
            );

        if (
            numeric !==
            null
        ) {
            return clamp(
                (
                    numeric -
                    matrix.minimum
                ) /
                matrix.range,
                0,
                1
            );
        }

        return (
            hashString(
                value
            ) %
            1000
        ) /
        1000;
    }

    function rgbaFromHex(
        hex,
        alpha
    ) {
        const normalized =
            String(
                hex ||
                PRIMARY_COLOR
            )
                .replace(
                    "#",
                    ""
                )
                .trim();

        if (
            !/^[0-9a-f]{6}$/i.test(
                normalized
            )
        ) {
            return `rgba(192, 214, 116, ${alpha})`;
        }

        const integer =
            Number.parseInt(
                normalized,
                16
            );

        const red =
            (
                integer >>
                16
            ) &
            255;

        const green =
            (
                integer >>
                8
            ) &
            255;

        const blue =
            integer &
            255;

        return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
    }

    function escapeCSV(value) {
        const text =
            String(
                value ?? ""
            );

        if (
            /[",\n\r]/.test(
                text
            )
        ) {
            return `"${text.replace(/"/g, '""')}"`;
        }

        return text;
    }

    function injectMatrixStyles() {
        if (
            document.getElementById(
                "speciedex-terminal-matrix-styles"
            )
        ) {
            return;
        }

        const style =
            document.createElement(
                "style"
            );

        style.id =
            "speciedex-terminal-matrix-styles";

        style.textContent = `
            .terminal-renderer-matrix {
                position: relative;
                display: grid;
                grid-template-rows: auto minmax(20rem, 1fr) auto;
                min-height: 24rem;
                overflow: hidden;
                border: 1px solid rgba(192, 214, 116, 0.22);
                background: ${BACKGROUND_COLOR};
                color: ${PRIMARY_COLOR};
                font-family:
                    "IBM Plex Mono",
                    ui-monospace,
                    SFMono-Regular,
                    Consolas,
                    monospace;
            }

            .terminal-matrix-header,
            .terminal-matrix-footer {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 1rem;
                padding: 0.65rem 0.8rem;
                background: rgba(4, 10, 6, 0.94);
            }

            .terminal-matrix-header {
                border-bottom: 1px solid rgba(192, 214, 116, 0.16);
            }

            .terminal-matrix-footer {
                border-top: 1px solid rgba(192, 214, 116, 0.16);
                color: rgba(216, 230, 219, 0.7);
                font-size: 0.7rem;
            }

            .terminal-matrix-title {
                margin: 0;
                color: ${PRIMARY_COLOR};
                font-size: 0.9rem;
                letter-spacing: 0.05em;
                text-transform: uppercase;
            }

            .terminal-matrix-actions {
                display: flex;
                flex-wrap: wrap;
                gap: 0.4rem;
            }

            .terminal-matrix-actions button {
                border: 1px solid rgba(192, 214, 116, 0.28);
                background: rgba(4, 10, 6, 0.88);
                color: ${PRIMARY_COLOR};
                padding: 0.28rem 0.46rem;
                font: inherit;
                font-size: 0.68rem;
                cursor: pointer;
            }

            .terminal-matrix-actions button:hover,
            .terminal-matrix-actions button:focus-visible {
                background: rgba(192, 214, 116, 0.12);
                outline: none;
            }

            .terminal-matrix-stage {
                position: relative;
                min-height: 20rem;
                overflow: hidden;
                background:
                    radial-gradient(
                        circle at 50% 50%,
                        rgba(192, 214, 116, 0.04),
                        transparent 58%
                    ),
                    ${BACKGROUND_COLOR};
            }

            .terminal-matrix-canvas {
                display: block;
                width: 100%;
                height: 100%;
                min-height: 20rem;
                outline: none;
                touch-action: none;
            }

            .terminal-matrix-tooltip {
                position: absolute;
                z-index: 20;
                max-width: 22rem;
                padding: 0.5rem 0.6rem;
                border: 1px solid rgba(230, 164, 43, 0.62);
                background: rgba(4, 10, 6, 0.97);
                color: rgba(216, 230, 219, 0.92);
                font-size: 0.68rem;
                line-height: 1.45;
                pointer-events: none;
                box-shadow: 0 0 1rem rgba(0, 0, 0, 0.48);
            }

            .terminal-matrix-tooltip strong {
                color: ${PRIMARY_COLOR};
            }

            .terminal-matrix-tooltip[hidden] {
                display: none;
            }
        `;

        (
            document.head ||
            document.documentElement
        ).appendChild(
            style
        );
    }

    /*
    ==========================================================================
    Matrix Controller
    ==========================================================================
    */

    class MatrixController
        extends EventTarget {
        constructor(
            target,
            data = [],
            options = {}
        ) {
            super();

            injectMatrixStyles();

            this.canvas =
                resolveCanvas(
                    target
                );

            const existing =
                this.canvas[
                    CONTROLLER_SYMBOL
                ];

            if (
                existing instanceof
                    MatrixController &&
                !existing.destroyed
            ) {
                existing.update(
                    data,
                    options
                );

                return existing;
            }

            this.context =
                this.canvas.getContext(
                    "2d",
                    {
                        alpha:
                            true,

                        desynchronized:
                            true
                    }
                );

            if (!this.context) {
                throw new Error(
                    "Canvas 2D rendering context is unavailable."
                );
            }

            this.options = {
                ...DEFAULT_OPTIONS,
                ...options,
                width:
                    clampInteger(
                        options.width,
                        DEFAULT_OPTIONS.width,
                        1,
                        32768
                    ),
                height:
                    clampInteger(
                        options.height,
                        DEFAULT_OPTIONS.height,
                        1,
                        32768
                    ),
                minHeight:
                    clampInteger(
                        options.minHeight,
                        DEFAULT_OPTIONS.minHeight,
                        1,
                        32768
                    ),
                minCellSize:
                    clamp(
                        Number(
                            options.minCellSize ??
                            DEFAULT_OPTIONS.minCellSize
                        ),
                        1,
                        1024
                    ),
                maxCellSize:
                    clamp(
                        Number(
                            options.maxCellSize ??
                            DEFAULT_OPTIONS.maxCellSize
                        ),
                        1,
                        4096
                    ),
                maximumRows:
                    clampInteger(
                        options.maximumRows,
                        DEFAULT_OPTIONS.maximumRows,
                        1,
                        1000000
                    ),
                maximumColumns:
                    clampInteger(
                        options.maximumColumns,
                        DEFAULT_OPTIONS.maximumColumns,
                        1,
                        10000
                    ),
                zoomMinimum:
                    clamp(
                        Number(
                            options.zoomMinimum ??
                            DEFAULT_OPTIONS.zoomMinimum
                        ),
                        0.05,
                        100
                    ),
                zoomMaximum:
                    clamp(
                        Number(
                            options.zoomMaximum ??
                            DEFAULT_OPTIONS.zoomMaximum
                        ),
                        0.05,
                        100
                    ),
                responsive:
                    parseBoolean(
                        options.responsive,
                        DEFAULT_OPTIONS.responsive
                    ),
                autoStart:
                    parseBoolean(
                        options.autoStart,
                        DEFAULT_OPTIONS.autoStart
                    ),
                interactive:
                    parseBoolean(
                        options.interactive,
                        DEFAULT_OPTIONS.interactive
                    ),
                selectable:
                    parseBoolean(
                        options.selectable,
                        DEFAULT_OPTIONS.selectable
                    ),
                keyboard:
                    parseBoolean(
                        options.keyboard,
                        DEFAULT_OPTIONS.keyboard
                    ),
                pan:
                    parseBoolean(
                        options.pan,
                        DEFAULT_OPTIONS.pan
                    ),
                zoom:
                    parseBoolean(
                        options.zoom,
                        DEFAULT_OPTIONS.zoom
                    ),
                animate:
                    parseBoolean(
                        options.animate,
                        DEFAULT_OPTIONS.animate
                    )
            };

            if (
                this.options.maxCellSize <
                this.options.minCellSize
            ) {
                const temporary =
                    this.options.maxCellSize;

                this.options.maxCellSize =
                    this.options.minCellSize;

                this.options.minCellSize =
                    temporary;
            }

            if (
                this.options.zoomMaximum <
                this.options.zoomMinimum
            ) {
                const temporary =
                    this.options.zoomMaximum;

                this.options.zoomMaximum =
                    this.options.zoomMinimum;

                this.options.zoomMinimum =
                    temporary;
            }

            if (
                this.options.reducedMotion
            ) {
                this.options.animate =
                    false;
            }

            this.data =
                data;

            this.previousMatrix =
                null;

            this.matrix =
                normalizeMatrix(
                    data,
                    this.options
                );

            this.viewport = {
                width:
                    Number(
                        this.options.width
                    ) ||
                    DEFAULT_OPTIONS.width,

                height:
                    Number(
                        this.options.height
                    ) ||
                    DEFAULT_OPTIONS.height
            };

            this.view = {
                offsetX:
                    0,

                offsetY:
                    0,

                scale:
                    1
            };

            this.hoveredCell =
                null;

            this.selectedCell =
                null;

            this.focusedCell = {
                row:
                    0,

                column:
                    0
            };

            this.dragging =
                false;

            this.dragStart =
                null;

            this.running =
                false;

            this.destroyed =
                false;

            this.animationFrame =
                0;

            this.animationStart =
                monotonicNow();

            this.resizeObserver =
                null;

            this.resizeFrame =
                0;

            this.abortController =
                typeof AbortController ===
                    "function"
                    ? new AbortController()
                    : null;

            this.boundListeners =
                [];

            this.watchers =
                new Set();

            this.emitting =
                false;

            this.canvas[
                CONTROLLER_SYMBOL
            ] =
                this;

            this.boundWindowResize =
                () =>
                    this.resize();

            this.boundPointerMove =
                event =>
                    this.handlePointerMove(
                        event
                    );

            this.boundPointerLeave =
                () =>
                    this.handlePointerLeave();

            this.boundPointerDown =
                event =>
                    this.handlePointerDown(
                        event
                    );

            this.boundPointerUp =
                event =>
                    this.handlePointerUp(
                        event
                    );

            this.boundWheel =
                event =>
                    this.handleWheel(
                        event
                    );

            this.boundKeydown =
                event =>
                    this.handleKeydown(
                        event
                    );

            this.installEvents();
            this.installResize();
            this.resize();

            if (
                this.options.autoStart !==
                false
            ) {
                this.start();
            }
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
                                type:
                                    name,
                                timestamp:
                                    new Date().toISOString(),
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
            if (typeof callback !== "function") {
                throw new TypeError(
                    "Matrix watcher must be a function."
                );
            }

            this.watchers.add(
                callback
            );

            if (options.immediate === true) {
                callback(
                    {
                        type:
                            "initial",
                        timestamp:
                            new Date().toISOString(),
                        snapshot:
                            this.snapshot()
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

        /*
        ======================================================================
        Setup
        ======================================================================
        */

        installEvents() {
            if (!this.options.interactive) {
                return;
            }

            this.canvas.tabIndex = 0;

            this.canvas.setAttribute(
                "role",
                "grid"
            );

            this.canvas.setAttribute(
                "aria-label",
                this.options.title ||
                "Speciedex data matrix"
            );

            this.canvas.setAttribute(
                "aria-rowcount",
                String(
                    this.matrix.rowCount
                )
            );

            this.canvas.setAttribute(
                "aria-colcount",
                String(
                    this.matrix.columnCount
                )
            );

            this.addManagedListener(
                this.canvas,
                "pointermove",
                this.boundPointerMove
            );

            this.addManagedListener(
                this.canvas,
                "pointerleave",
                this.boundPointerLeave
            );

            this.addManagedListener(
                this.canvas,
                "pointerdown",
                this.boundPointerDown
            );

            this.addManagedListener(
                this.canvas,
                "pointerup",
                this.boundPointerUp
            );

            this.addManagedListener(
                this.canvas,
                "pointercancel",
                this.boundPointerUp
            );

            this.addManagedListener(
                this.canvas,
                "wheel",
                this.boundWheel,
                {
                    passive: false
                }
            );

            this.addManagedListener(
                this.canvas,
                "keydown",
                this.boundKeydown
            );
        }

        installResize() {
            if (
                !this.options.responsive
            ) {
                return;
            }

            const observed =
                this.canvas.parentElement ||
                this.canvas;

            if (
                typeof window.ResizeObserver ===
                    "function"
            ) {
                this.resizeObserver =
                    new window.ResizeObserver(
                        () =>
                            this.scheduleResize()
                    );

                this.resizeObserver.observe(
                    observed
                );

                return;
            }

            this.addManagedListener(
                window,
                "resize",
                this.boundWindowResize
            );
        }

        scheduleResize() {
            if (
                this.destroyed ||
                this.resizeFrame
            ) {
                return;
            }

            this.resizeFrame =
                requestFrame(
                    () => {
                        this.resizeFrame =
                            0;

                        this.resize();
                    }
                );
        }

        /*
        ======================================================================
        Layout and Resize
        ======================================================================
        */

        resize() {
            if (this.destroyed) {
                return;
            }

            const host =
                this.canvas.parentElement ||
                this.canvas;

            const rect =
                host.getBoundingClientRect();

            const cssWidth =
                Math.max(
                    1,
                    rect.width ||
                    Number(
                        this.options.width
                    ) ||
                    DEFAULT_OPTIONS.width
                );

            const cssHeight =
                Math.max(
                    Number(
                        this.options.minHeight
                    ) ||
                    DEFAULT_OPTIONS.minHeight,
                    rect.height ||
                    Number(
                        this.options.height
                    ) ||
                    DEFAULT_OPTIONS.height
                );

            const ratio =
                Math.min(
                    window.devicePixelRatio ||
                    1,
                    2
                );

            const pixelWidth =
                Math.max(
                    1,
                    Math.floor(
                        cssWidth *
                        ratio
                    )
                );

            const pixelHeight =
                Math.max(
                    1,
                    Math.floor(
                        cssHeight *
                        ratio
                    )
                );

            this.canvas.style.width =
                `${cssWidth}px`;

            this.canvas.style.height =
                `${cssHeight}px`;

            if (
                this.canvas.width !==
                pixelWidth
            ) {
                this.canvas.width =
                    pixelWidth;
            }

            if (
                this.canvas.height !==
                pixelHeight
            ) {
                this.canvas.height =
                    pixelHeight;
            }

            this.context.setTransform(
                ratio,
                0,
                0,
                ratio,
                0,
                0
            );

            this.viewport = {
                width:
                    cssWidth,

                height:
                    cssHeight,

                ratio
            };

            this.layout =
                this.calculateLayout();

            this.draw();

            this.emit(
                "resize",
                {
                    viewport:
                        safeClone(
                            this.viewport
                        ),
                    layout:
                        safeClone(
                            this.layout
                        )
                }
            );
        }

        calculateLayout() {
            const {
                width,
                height
            } = this.viewport;

            const padding =
                Number(
                    this.options.padding
                ) ||
                0;

            const labelWidth =
                this.options.showLabels
                    ? Number(
                        this.options.labelWidth
                    ) ||
                    DEFAULT_OPTIONS.labelWidth
                    : 0;

            const labelHeight =
                this.options.showLabels
                    ? Number(
                        this.options.labelHeight
                    ) ||
                    DEFAULT_OPTIONS.labelHeight
                    : 0;

            const availableWidth =
                Math.max(
                    1,
                    width -
                    padding *
                    2 -
                    labelWidth
                );

            const availableHeight =
                Math.max(
                    1,
                    height -
                    padding *
                    2 -
                    labelHeight
                );

            const columns =
                Math.max(
                    1,
                    this.matrix.columnCount
                );

            const rows =
                Math.max(
                    1,
                    this.matrix.rowCount
                );

            const rawCellWidth =
                availableWidth /
                columns;

            const rawCellHeight =
                availableHeight /
                rows;

            const baseCellSize =
                clamp(
                    Math.min(
                        rawCellWidth,
                        rawCellHeight
                    ),
                    Number(
                        this.options.minCellSize
                    ) ||
                    1,
                    Number(
                        this.options.maxCellSize
                    ) ||
                    DEFAULT_OPTIONS.maxCellSize
                );

            const fitScale =
                this.options.autoFit
                    ? Math.min(
                        1,
                        availableWidth /
                            Math.max(
                                1,
                                baseCellSize *
                                columns
                            ),
                        availableHeight /
                            Math.max(
                                1,
                                baseCellSize *
                                rows
                            )
                    )
                    : 1;

            const cellSize =
                baseCellSize *
                fitScale *
                this.view.scale;

            return {
                x:
                    padding +
                    labelWidth +
                    this.view.offsetX,

                y:
                    padding +
                    labelHeight +
                    this.view.offsetY,

                cellSize,
                baseCellSize,
                fitScale,

                matrixWidth:
                    cellSize *
                    columns,

                matrixHeight:
                    cellSize *
                    rows,

                labelWidth,
                labelHeight,
                padding
            };
        }

        resetView() {
            this.view = {
                offsetX:
                    0,

                offsetY:
                    0,

                scale:
                    1
            };

            this.layout =
                this.calculateLayout();

            this.draw();

            return {
                ...this.view
            };
        }

        /*
        ======================================================================
        Animation
        ======================================================================
        */

        start() {
            if (
                this.running ||
                this.destroyed
            ) {
                return false;
            }

            this.running =
                true;

            this.animationStart =
                monotonicNow();

            this.animate();

            return true;
        }

        stop() {
            this.running =
                false;

            if (
                this.animationFrame
            ) {
                cancelFrame(
                    this.animationFrame
                );

                this.animationFrame =
                    0;
            }

            return true;
        }

        animate(
            timestamp =
                monotonicNow()
        ) {
            if (
                !this.running ||
                this.destroyed
            ) {
                return;
            }

            this.draw(
                timestamp
            );

            const duration =
                Math.max(
                    1,
                    Number(
                        this.options.animationDuration
                    ) ||
                    DEFAULT_OPTIONS.animationDuration
                );

            const transitionComplete =
                !this.options.animate ||
                timestamp -
                    this.animationStart >=
                    duration;

            if (
                transitionComplete &&
                !this.dragging
            ) {
                this.running =
                    false;
                this.animationFrame =
                    0;

                return;
            }

            this.animationFrame =
                requestFrame(
                    next =>
                        this.animate(
                            next
                        )
                );
        }

        /*
        ======================================================================
        Drawing
        ======================================================================
        */

        draw(
            timestamp =
                monotonicNow()
        ) {
            if (this.destroyed) {
                return;
            }

            const {
                width,
                height
            } = this.viewport;

            this.context.save();

            this.context.setTransform(
                this.viewport.ratio,
                0,
                0,
                this.viewport.ratio,
                0,
                0
            );

            this.context.clearRect(
                0,
                0,
                width,
                height
            );

            this.context.fillStyle =
                this.options.background;

            this.context.fillRect(
                0,
                0,
                width,
                height
            );

            const progress =
                this.options.animate
                    ? clamp(
                        (
                            timestamp -
                            this.animationStart
                        ) /
                        Math.max(
                            1,
                            Number(
                                this.options.animationDuration
                            ) ||
                            DEFAULT_OPTIONS.animationDuration
                        ),
                        0,
                        1
                    )
                    : 1;

            if (
                this.options.showGrid
            ) {
                this.drawBackgroundGrid();
            }

            this.drawLabels();
            this.drawCells(
                progress
            );
            this.drawSelection();
            this.drawHover();

            this.context.restore();
        }

        drawBackgroundGrid() {
            const {
                width,
                height
            } = this.viewport;

            const size =
                Math.max(
                    24,
                    Math.round(
                        this.layout.baseCellSize *
                        4
                    )
                );

            this.context.save();

            this.context.strokeStyle =
                this.options.gridColor;

            this.context.lineWidth =
                1;

            this.context.beginPath();

            for (
                let x = 0;
                x <= width;
                x += size
            ) {
                this.context.moveTo(
                    x +
                    0.5,
                    0
                );

                this.context.lineTo(
                    x +
                    0.5,
                    height
                );
            }

            for (
                let y = 0;
                y <= height;
                y += size
            ) {
                this.context.moveTo(
                    0,
                    y +
                    0.5
                );

                this.context.lineTo(
                    width,
                    y +
                    0.5
                );
            }

            this.context.stroke();
            this.context.restore();
        }

        drawLabels() {
            if (
                !this.options.showLabels ||
                !this.matrix.rowCount ||
                !this.matrix.columnCount
            ) {
                return;
            }

            const {
                x,
                y,
                cellSize
            } = this.layout;

            this.context.save();

            this.context.font =
                `${this.options.fontSize}px ${this.options.fontFamily}`;

            this.context.fillStyle =
                this.options.labelColor;

            this.context.textBaseline =
                "middle";

            this.context.textAlign =
                "right";

            for (
                let row = 0;
                row <
                this.matrix.rowCount;
                row += 1
            ) {
                const center =
                    y +
                    row *
                    cellSize +
                    cellSize /
                    2;

                if (
                    center <
                        -cellSize ||
                    center >
                        this.viewport.height +
                        cellSize
                ) {
                    continue;
                }

                this.context.fillText(
                    normalizeLabel(
                        this.matrix.rowLabels[
                            row
                        ]
                    ),
                    x -
                    8,
                    center
                );
            }

            this.context.textAlign =
                "center";

            this.context.textBaseline =
                "bottom";

            for (
                let column = 0;
                column <
                this.matrix.columnCount;
                column += 1
            ) {
                const center =
                    x +
                    column *
                    cellSize +
                    cellSize /
                    2;

                if (
                    center <
                        -cellSize ||
                    center >
                        this.viewport.width +
                        cellSize
                ) {
                    continue;
                }

                this.context.fillText(
                    normalizeLabel(
                        this.matrix.columnLabels[
                            column
                        ]
                    ),
                    center,
                    y -
                    6
                );
            }

            this.context.restore();
        }

        resolveCellColor(
            value,
            row,
            column,
            intensity,
            alpha
        ) {
            if (
                typeof this.options.colorResolver ===
                "function"
            ) {
                const resolved =
                    this.options.colorResolver({
                        value,
                        row,
                        column,
                        intensity,
                        alpha,
                        matrix:
                            this.matrix,
                        controller:
                            this
                    });

                if (resolved) {
                    return resolved;
                }
            }

            if (
                value === null ||
                value === undefined ||
                value === ""
            ) {
                return this.options.nullColor;
            }

            return rgbaFromHex(
                this.options.primaryColor,
                alpha
            );
        }

        drawCells(
            progress
        ) {
            const {
                x,
                y,
                cellSize
            } = this.layout;

            const gap =
                Math.max(
                    0,
                    Number(
                        this.options.gap
                    ) ||
                    0
                );

            const firstVisibleRow =
                Math.max(
                    0,
                    Math.floor(
                        -y /
                        Math.max(
                            1,
                            cellSize
                        )
                    )
                );

            const lastVisibleRow =
                Math.min(
                    this.matrix.rowCount,
                    Math.ceil(
                        (
                            this.viewport.height -
                            y
                        ) /
                        Math.max(
                            1,
                            cellSize
                        )
                    ) +
                    1
                );

            const firstVisibleColumn =
                Math.max(
                    0,
                    Math.floor(
                        -x /
                        Math.max(
                            1,
                            cellSize
                        )
                    )
                );

            const lastVisibleColumn =
                Math.min(
                    this.matrix.columnCount,
                    Math.ceil(
                        (
                            this.viewport.width -
                            x
                        ) /
                        Math.max(
                            1,
                            cellSize
                        )
                    ) +
                    1
                );

            for (
                let row =
                    firstVisibleRow;
                row <
                    lastVisibleRow;
                row += 1
            ) {
                const cellY =
                    y +
                    row *
                    cellSize +
                    gap /
                    2;

                if (
                    cellY +
                        cellSize <
                        0 ||
                    cellY >
                        this.viewport.height
                ) {
                    continue;
                }

                for (
                    let column =
                        firstVisibleColumn;
                    column <
                        lastVisibleColumn;
                    column += 1
                ) {
                    const cellX =
                        x +
                        column *
                        cellSize +
                        gap /
                        2;

                    if (
                        cellX +
                            cellSize <
                            0 ||
                        cellX >
                            this.viewport.width
                    ) {
                        continue;
                    }

                    const value =
                        this.matrix.rows[
                            row
                        ]?.[
                            column
                        ];

                    const intensity =
                        cellIntensity(
                            value,
                            this.matrix
                        );

                    const alpha =
                        (
                            Number(
                                this.options.alphaMinimum
                            ) +
                            intensity *
                            (
                                Number(
                                    this.options.alphaMaximum
                                ) -
                                Number(
                                    this.options.alphaMinimum
                                )
                            )
                        ) *
                        progress;

                    const size =
                        Math.max(
                            1,
                            cellSize -
                            gap
                        );

                    this.context.fillStyle =
                        this.resolveCellColor(
                            value,
                            row,
                            column,
                            intensity,
                            alpha
                        );

                    this.context.fillRect(
                        cellX,
                        cellY,
                        size,
                        size
                    );

                    if (
                        this.options.showValues &&
                        cellSize >=
                            18
                    ) {
                        this.drawCellValue(
                            value,
                            cellX,
                            cellY,
                            size,
                            intensity
                        );
                    }
                }
            }
        }

        drawCellValue(
            value,
            x,
            y,
            size,
            intensity
        ) {
            const formatter =
                typeof this.options.valueFormatter ===
                "function"
                    ? this.options.valueFormatter
                    : normalizeLabel;

            this.context.save();

            this.context.font =
                `${Math.max(
                    8,
                    Math.floor(
                        size *
                        0.28
                    )
                )}px ${this.options.fontFamily}`;

            this.context.textAlign =
                "center";

            this.context.textBaseline =
                "middle";

            this.context.fillStyle =
                intensity >
                    0.52
                    ? "rgba(4, 10, 6, 0.88)"
                    : this.options.valueColor;

            const text =
                formatter(
                    value
                );

            this.context.fillText(
                String(text).slice(
                    0,
                    18
                ),
                x +
                size /
                2,
                y +
                size /
                2
            );

            this.context.restore();
        }

        drawSelection() {
            if (!this.selectedCell) {
                return;
            }

            this.drawCellOutline(
                this.selectedCell,
                this.options.accentColor,
                3
            );
        }

        drawHover() {
            if (!this.hoveredCell) {
                return;
            }

            this.drawCellOutline(
                this.hoveredCell,
                "rgba(255, 255, 255, 0.92)",
                1.5
            );
        }

        drawCellOutline(
            cell,
            color,
            width
        ) {
            const {
                x,
                y,
                cellSize
            } = this.layout;

            this.context.save();

            this.context.strokeStyle =
                color;

            this.context.lineWidth =
                width;

            this.context.strokeRect(
                x +
                cell.column *
                cellSize +
                1,
                y +
                cell.row *
                cellSize +
                1,
                Math.max(
                    1,
                    cellSize -
                    2
                ),
                Math.max(
                    1,
                    cellSize -
                    2
                )
            );

            this.context.restore();
        }

        /*
        ======================================================================
        Interaction
        ======================================================================
        */

        eventPoint(event) {
            const rect =
                this.canvas.getBoundingClientRect();

            return {
                x:
                    event.clientX -
                    rect.left,

                y:
                    event.clientY -
                    rect.top
            };
        }

        cellAtPoint(
            x,
            y
        ) {
            const column =
                Math.floor(
                    (
                        x -
                        this.layout.x
                    ) /
                    Math.max(
                        0.0001,
                        this.layout.cellSize
                    )
                );

            const row =
                Math.floor(
                    (
                        y -
                        this.layout.y
                    ) /
                    Math.max(
                        0.0001,
                        this.layout.cellSize
                    )
                );

            if (
                row <
                    0 ||
                column <
                    0 ||
                row >=
                    this.matrix.rowCount ||
                column >=
                    this.matrix.columnCount
            ) {
                return null;
            }

            return {
                row,
                column,

                value:
                    this.matrix.rows[
                        row
                    ]?.[
                        column
                    ],

                rowLabel:
                    this.matrix.rowLabels[
                        row
                    ],

                columnLabel:
                    this.matrix.columnLabels[
                        column
                    ]
            };
        }

        handlePointerMove(event) {
            const point =
                this.eventPoint(
                    event
                );

            if (
                this.dragging &&
                this.dragStart &&
                this.options.pan
            ) {
                this.view.offsetX =
                    this.dragStart.offsetX +
                    (
                        point.x -
                        this.dragStart.x
                    );

                this.view.offsetY =
                    this.dragStart.offsetY +
                    (
                        point.y -
                        this.dragStart.y
                    );

                this.layout =
                    this.calculateLayout();

                this.draw();

                return;
            }

            const cell =
                this.cellAtPoint(
                    point.x,
                    point.y
                );

            const changed =
                (
                    !cell &&
                    this.hoveredCell
                ) ||
                (
                    cell &&
                    (
                        !this.hoveredCell ||
                        cell.row !==
                            this.hoveredCell.row ||
                        cell.column !==
                            this.hoveredCell.column
                    )
                );

            this.hoveredCell =
                cell;

            if (cell) {
                this.canvas.title =
                    `${normalizeLabel(cell.rowLabel)} / ` +
                    `${normalizeLabel(cell.columnLabel)}: ` +
                    `${normalizeLabel(cell.value)}`;
            } else {
                this.canvas.removeAttribute(
                    "title"
                );
            }

            if (changed) {
                this.emit(
                    "cell-hover",
                    safeClone(cell)
                );
            }

            if (!this.running) {
                this.draw();
            }
        }

        handlePointerLeave() {
            if (this.dragging) {
                return;
            }

            this.hoveredCell =
                null;

            this.canvas.removeAttribute(
                "title"
            );

            if (!this.running) {
                this.draw();
            }
        }

        handlePointerDown(event) {
            if (
                event.button !==
                    0 &&
                event.button !==
                    1
            ) {
                return;
            }

            try {
                this.canvas.focus({
                    preventScroll:
                        true
                });
            } catch (_error) {
                this.canvas.focus?.();
            }

            const point =
                this.eventPoint(
                    event
                );

            const cell =
                this.cellAtPoint(
                    point.x,
                    point.y
                );

            if (
                cell &&
                this.options.selectable
            ) {
                this.selectCell(
                    cell.row,
                    cell.column
                );
            }

            if (
                this.options.pan &&
                (
                    event.button ===
                        1 ||
                    event.shiftKey
                )
            ) {
                this.dragging =
                    true;

                this.dragStart = {
                    x:
                        point.x,

                    y:
                        point.y,

                    offsetX:
                        this.view.offsetX,

                    offsetY:
                        this.view.offsetY,

                    pointerId:
                        event.pointerId
                };

                event.preventDefault();

                this.canvas.setPointerCapture?.(
                    event.pointerId
                );
            }
        }

        handlePointerUp(event) {
            if (
                this.dragging
            ) {
                this.canvas.releasePointerCapture?.(
                    event.pointerId
                );
            }

            this.dragging =
                false;

            this.dragStart =
                null;
        }

        handleWheel(event) {
            if (
                !this.options.zoom
            ) {
                return;
            }

            event.preventDefault();

            const point =
                this.eventPoint(
                    event
                );

            const beforeScale =
                this.view.scale;

            const direction =
                event.deltaY <
                    0
                    ? 1
                    : -1;

            const nextScale =
                clamp(
                    beforeScale +
                    direction *
                    Number(
                        this.options.zoomStep
                    ),
                    Number(
                        this.options.zoomMinimum
                    ),
                    Number(
                        this.options.zoomMaximum
                    )
                );

            if (
                nextScale ===
                    beforeScale
            ) {
                return;
            }

            const oldLayout = {
                ...this.layout
            };

            const worldX =
                (
                    point.x -
                    oldLayout.x
                ) /
                Math.max(
                    0.0001,
                    oldLayout.cellSize
                );

            const worldY =
                (
                    point.y -
                    oldLayout.y
                ) /
                Math.max(
                    0.0001,
                    oldLayout.cellSize
                );

            this.view.scale =
                nextScale;

            this.layout =
                this.calculateLayout();

            this.view.offsetX +=
                point.x -
                (
                    this.layout.x +
                    worldX *
                    this.layout.cellSize
                );

            this.view.offsetY +=
                point.y -
                (
                    this.layout.y +
                    worldY *
                    this.layout.cellSize
                );

            this.layout =
                this.calculateLayout();

            this.draw();

            this.emit(
                "zoom",
                {
                    scale:
                        this.view.scale,
                    point:
                        safeClone(point),
                    world: {
                        x:
                            worldX,
                        y:
                            worldY
                    }
                }
            );
        }

        handleKeydown(event) {
            if (
                !this.options.keyboard
            ) {
                return;
            }

            let handled =
                true;

            switch (event.key) {
                case "ArrowUp":
                    this.moveFocus(
                        -1,
                        0
                    );
                    break;

                case "ArrowDown":
                    this.moveFocus(
                        1,
                        0
                    );
                    break;

                case "ArrowLeft":
                    this.moveFocus(
                        0,
                        -1
                    );
                    break;

                case "ArrowRight":
                    this.moveFocus(
                        0,
                        1
                    );
                    break;

                case "Enter":
                case " ":
                    this.selectCell(
                        this.focusedCell.row,
                        this.focusedCell.column
                    );
                    break;

                case "+":
                case "=":
                    this.setZoom(
                        this.view.scale +
                        Number(
                            this.options.zoomStep
                        )
                    );
                    break;

                case "-":
                case "_":
                    this.setZoom(
                        this.view.scale -
                        Number(
                            this.options.zoomStep
                        )
                    );
                    break;

                case "0":
                    this.resetView();
                    break;

                default:
                    handled =
                        false;
            }

            if (handled) {
                event.preventDefault();
            }
        }

        moveFocus(
            rowDelta,
            columnDelta
        ) {
            this.focusedCell = {
                row:
                    clampInteger(
                        this.focusedCell.row +
                        rowDelta,
                        0,
                        0,
                        Math.max(
                            0,
                            this.matrix.rowCount -
                            1
                        )
                    ),

                column:
                    clampInteger(
                        this.focusedCell.column +
                        columnDelta,
                        0,
                        0,
                        Math.max(
                            0,
                            this.matrix.columnCount -
                            1
                        )
                    )
            };

            this.hoveredCell =
                this.cell(
                    this.focusedCell.row,
                    this.focusedCell.column
                );

            this.draw();

            return {
                ...this.focusedCell
            };
        }

        setZoom(value) {
            this.view.scale =
                clamp(
                    Number(value) ||
                    1,
                    Number(
                        this.options.zoomMinimum
                    ),
                    Number(
                        this.options.zoomMaximum
                    )
                );

            this.layout =
                this.calculateLayout();

            this.draw();

            return this.view.scale;
        }

        cell(
            row,
            column
        ) {
            if (
                row <
                    0 ||
                column <
                    0 ||
                row >=
                    this.matrix.rowCount ||
                column >=
                    this.matrix.columnCount
            ) {
                return null;
            }

            return {
                row,
                column,

                value:
                    this.matrix.rows[
                        row
                    ]?.[
                        column
                    ],

                rowLabel:
                    this.matrix.rowLabels[
                        row
                    ],

                columnLabel:
                    this.matrix.columnLabels[
                        column
                    ]
            };
        }

        selectCell(
            row,
            column
        ) {
            const cell =
                this.cell(
                    row,
                    column
                );

            if (!cell) {
                return null;
            }

            this.selectedCell =
                cell;

            this.focusedCell = {
                row,
                column
            };

            this.draw();

            this.emit(
                "cell-select",
                safeClone(cell)
            );

            return cell;
        }

        clearSelection() {
            this.selectedCell =
                null;

            this.draw();
        }

        /*
        ======================================================================
        Data Updates
        ======================================================================
        */

        update(
            data =
                this.data,
            options = {}
        ) {
            this.previousMatrix =
                this.matrix;

            this.data =
                data;

            this.options = {
                ...this.options,
                ...options,
                maximumRows:
                    clampInteger(
                        options.maximumRows,
                        this.options.maximumRows,
                        1,
                        1000000
                    ),
                maximumColumns:
                    clampInteger(
                        options.maximumColumns,
                        this.options.maximumColumns,
                        1,
                        10000
                    ),
                animate:
                    options.animate !==
                        undefined
                        ? parseBoolean(
                            options.animate,
                            this.options.animate
                        )
                        : this.options.animate
            };

            this.matrix =
                normalizeMatrix(
                    data,
                    this.options
                );

            this.animationStart =
                monotonicNow();

            this.layout =
                this.calculateLayout();

            this.hoveredCell =
                null;

            this.selectedCell =
                null;

            this.focusedCell = {
                row:
                    0,

                column:
                    0
            };

            this.canvas.setAttribute(
                "aria-rowcount",
                String(
                    this.matrix.rowCount
                )
            );

            this.canvas.setAttribute(
                "aria-colcount",
                String(
                    this.matrix.columnCount
                )
            );

            if (
                this.options.animate
            ) {
                this.stop();
                this.start();
            } else {
                this.draw();
            }

            this.emit(
                "update",
                {
                    data:
                        safeClone(data),
                    options:
                        safeClone(
                            this.options
                        ),
                    matrix:
                        safeClone(
                            this.matrix
                        )
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

        appendRow(
            row,
            label = null
        ) {
            const next =
                [
                    ...this.matrix.rows.map(
                        item =>
                            [
                                ...item
                            ]
                    ),
                    Array.isArray(row)
                        ? [
                            ...row
                        ]
                        : [
                            row
                        ]
                ];

            const labels =
                [
                    ...this.matrix.rowLabels,
                    label ||
                    String(
                        next.length
                    )
                ];

            return this.update(
                next,
                {
                    rowLabels:
                        labels,

                    columnLabels:
                        this.matrix.columnLabels
                }
            );
        }

        /*
        ======================================================================
        Export
        ======================================================================
        */

        exportPNG(
            filename =
                "speciedex-matrix.png"
        ) {
            const anchor =
                document.createElement(
                    "a"
                );

            anchor.href =
                this.canvas.toDataURL(
                    "image/png"
                );

            anchor.download =
                filename;

            (
                document.body ||
                document.documentElement
            ).appendChild(anchor);

            try {
                anchor.click();
            } finally {
                anchor.remove();
            }

            return filename;
        }

        exportJSON(
            filename =
                "speciedex-matrix.json"
        ) {
            const payload =
                safeStringify(
                    {
                        version:
                            VERSION,

                        generatedAt:
                            new Date().toISOString(),

                        matrix:
                            this.snapshot(),

                        rows:
                            this.matrix.rows
                    },
                    null,
                    2
                );

            this.downloadText(
                payload,
                filename,
                "application/json"
            );

            return filename;
        }

        exportCSV(
            filename =
                "speciedex-matrix.csv"
        ) {
            const header = [
                "",
                ...this.matrix.columnLabels
            ]
                .map(
                    escapeCSV
                )
                .join(",");

            const rows =
                this.matrix.rows.map(
                    (
                        row,
                        index
                    ) => [
                        this.matrix.rowLabels[
                            index
                        ],
                        ...row
                    ]
                        .map(
                            escapeCSV
                        )
                        .join(",")
                );

            const payload =
                [
                    header,
                    ...rows
                ].join("\n");

            this.downloadText(
                payload,
                filename,
                "text/csv"
            );

            return filename;
        }

        downloadText(
            content,
            filename,
            type
        ) {
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
                    [content],
                    {
                        type:
                            `${type};charset=utf-8`
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

            (
                document.body ||
                document.documentElement
            ).appendChild(anchor);

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

        snapshot() {
            return {
                version:
                    VERSION,

                rows:
                    this.matrix.rowCount,

                columns:
                    this.matrix.columnCount,

                minimum:
                    this.matrix.minimum,

                maximum:
                    this.matrix.maximum,

                numericCount:
                    this.matrix.numericCount,

                categoricalValues:
                    this.matrix.categorical.length,

                dataRows:
                    Array.isArray(
                        this.data
                    )
                        ? this.data.length
                        : 0,

                truncatedRows:
                    Array.isArray(
                        this.data
                    )
                        ? Math.max(
                            0,
                            this.data.length -
                            this.matrix.rowCount
                        )
                        : 0,

                running:
                    this.running,

                selectedCell:
                    safeClone(
                        this.selectedCell
                    ),

                hoveredCell:
                    safeClone(
                        this.hoveredCell
                    ),

                view:
                    {
                        ...this.view
                    },

                viewport:
                    {
                        ...this.viewport
                    },

                options:
                    {
                        ...this.options,

                        valueFormatter:
                            Boolean(
                                this.options.valueFormatter
                            ),

                        colorResolver:
                            Boolean(
                                this.options.colorResolver
                            )
                    }
            };
        }

        /*
        ======================================================================
        Teardown
        ======================================================================
        */

        destroy() {
            if (this.destroyed) {
                return false;
            }

            this.stop();

            if (this.resizeFrame) {
                cancelFrame(
                    this.resizeFrame
                );

                this.resizeFrame = 0;
            }

            this.resizeObserver?.disconnect?.();

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

            if (this.dragging) {
                try {
                    this.canvas.releasePointerCapture?.(
                        this.dragStart?.pointerId
                    );
                } catch (_error) {
                    /* Pointer capture may already be released. */
                }
            }

            this.dragging = false;
            this.dragStart = null;
            this.running = false;

            this.emit(
                "destroy",
                {
                    version:
                        VERSION
                }
            );

            this.watchers.clear();

            if (
                this.canvas[
                    CONTROLLER_SYMBOL
                ] ===
                    this
            ) {
                delete this.canvas[
                    CONTROLLER_SYMBOL
                ];
            }

            registry().delete(
                this
            );

            this.destroyed = true;

            return true;
        }

    }

    /*
    ==========================================================================
    Renderer API
    ==========================================================================
    */

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

    function mount(
        target,
        data = [],
        options = {}
    ) {
        const controller =
            new MatrixController(
                target,
                data,
                options
            );

        registry().add(
            controller
        );

        controller.addEventListener(
            "destroy",
            () => {
                registry().delete(
                    controller
                );
            },
            {
                once:
                    true
            }
        );

        return controller;
    }

    function render(
        data,
        options = {}
    ) {
        injectMatrixStyles();

        const container =
            document.createElement(
                "section"
            );

        container.className =
            "terminal-renderer terminal-renderer-matrix";

        container.dataset.renderer =
            "matrix";

        const header =
            document.createElement(
                "header"
            );

        header.className =
            "terminal-matrix-header";

        const heading =
            document.createElement(
                "h3"
            );

        heading.className =
            "terminal-matrix-title";

        heading.textContent =
            options.title ||
            "Speciedex Matrix";

        const actions =
            document.createElement(
                "div"
            );

        actions.className =
            "terminal-matrix-actions";

        header.append(
            heading,
            actions
        );

        const stage =
            document.createElement(
                "div"
            );

        stage.className =
            "terminal-matrix-stage";

        const canvas =
            document.createElement(
                "canvas"
            );

        canvas.className =
            "terminal-matrix-canvas";

        canvas.dataset.terminalMatrixCanvas =
            "";

        stage.appendChild(
            canvas
        );

        const footer =
            document.createElement(
                "footer"
            );

        footer.className =
            "terminal-matrix-footer";

        const dimensions =
            document.createElement(
                "span"
            );

        const selection =
            document.createElement(
                "span"
            );

        selection.textContent =
            "No cell selected";

        footer.append(
            dimensions,
            selection
        );

        container.append(
            header,
            stage,
            footer
        );

        const controller =
            mount(
                canvas,
                data,
                {
                    ...options,

                    width:
                        options.width ||
                        DEFAULT_OPTIONS.width,

                    height:
                        options.height ||
                        DEFAULT_OPTIONS.height
                }
            );

        dimensions.textContent =
            `${controller.matrix.rowCount} × ${controller.matrix.columnCount}`;

        controller.addEventListener(
            "cell-select",
            event => {
                const cell =
                    event.detail;

                selection.textContent =
                    `${cell.rowLabel} / ${cell.columnLabel}: ${normalizeLabel(cell.value)}`;
            }
        );

        const makeAction =
            (
                label,
                handler,
                title
            ) => {
                const button =
                    document.createElement(
                        "button"
                    );

                button.type =
                    "button";

                button.textContent =
                    label;

                button.title =
                    title ||
                    label;

                button.addEventListener(
                    "click",
                    handler
                );

                actions.appendChild(
                    button
                );

                return button;
            };

        makeAction(
            "Reset",
            () =>
                controller.resetView(),
            "Reset matrix viewport"
        );

        makeAction(
            "Values",
            () => {
                controller.options.showValues =
                    !controller.options.showValues;

                controller.draw();
            },
            "Toggle cell values"
        );

        makeAction(
            "PNG",
            () =>
                controller.exportPNG(),
            "Export matrix as PNG"
        );

        makeAction(
            "JSON",
            () =>
                controller.exportJSON(),
            "Export matrix as JSON"
        );

        makeAction(
            "CSV",
            () =>
                controller.exportCSV(),
            "Export matrix as CSV"
        );

        container.controller =
            controller;

        container.update =
            (
                nextData,
                nextOptions
            ) => {
                controller.update(
                    nextData,
                    nextOptions
                );

                dimensions.textContent =
                    `${controller.matrix.rowCount} × ${controller.matrix.columnCount}`;

                return container;
            };

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

        const root =
            safeContext.root &&
            typeof safeContext.root.querySelector ===
                "function"
                ? safeContext.root
                : document.documentElement;

        const existing =
            safeContext.matrixRenderer?.
                Controller ===
                    MatrixController
                ? safeContext.matrixRenderer
                : safeContext.services?.get?.(
                    "matrix"
                ) ||
                root?.[RENDERER_SYMBOL];

        if (
            existing &&
            existing.Controller ===
                MatrixController
        ) {
            safeContext.matrixRenderer =
                existing;

            safeContext.matrix =
                existing;

            safeContext.registerRenderer?.(
                "matrix",
                existing
            );

            safeContext.registerVisualization?.(
                "matrix",
                existing
            );

            safeContext.registerService?.(
                "matrix",
                existing
            );

            return existing;
        }

        const renderer = {
            version:
                VERSION,
            mount,
            render,
            registry,
            Controller:
                MatrixController,
            normalizeMatrix,
            cellIntensity,
            flattenRows,
            setRecords(
                records,
                options = {}
            ) {
                const active =
                    [
                        ...registry()
                    ].filter(
                        controller =>
                            !controller.destroyed
                    );

                for (
                    const controller
                    of active
                ) {
                    controller.setRecords(
                        records,
                        options
                    );
                }

                return active.length;
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
                    [
                        ...registry()
                    ].filter(
                        controller =>
                            !controller.destroyed
                    );

                return {
                    version:
                        VERSION,
                    controllers:
                        controllers.length,
                    snapshots:
                        controllers.map(
                            controller =>
                                controller.snapshot()
                        )
                };
            }
        };

        root[RENDERER_SYMBOL] =
            renderer;

        safeContext.registerRenderer?.(
            "matrix",
            renderer
        );

        safeContext.registerVisualization?.(
            "matrix",
            renderer
        );

        safeContext.registerService?.(
            "matrix",
            renderer
        );

        safeContext.matrixRenderer =
            renderer;

        safeContext.matrix =
            renderer;

        dispatch(
            document,
            "speciedex:terminal-matrix-ready",
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

    function activeMatrix(context = {}) {
        const safeContext =
            isObject(context)
                ? context
                : {};

        return (
            safeContext.root?.
                querySelector?.(
                    ".terminal-renderer-matrix"
                )?.
                controller ||
            safeContext.terminalSplash?.
                matrixController ||
            [
                ...registry()
            ]
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

    function requireRenderer(context = {}) {
        const safeContext =
            isObject(context)
                ? context
                : {};

        return (
            safeContext.matrixRenderer ||
            safeContext.services?.get?.(
                "matrix"
            ) ||
            initialize(safeContext)
        );
    }

    function writeResult(
        payload,
        value,
        type = "data"
    ) {
        if (
            typeof payload.writeJSON ===
                "function" &&
            typeof value !== "string"
        ) {
            return payload.writeJSON(
                value
            );
        }

        if (
            typeof payload.write ===
                "function"
        ) {
            return payload.write(
                typeof value === "string"
                    ? value
                    : safeStringify(
                        value
                    ),
                type
            );
        }

        if (
            typeof payload.writeLine ===
                "function"
        ) {
            return payload.writeLine(
                typeof value === "string"
                    ? value
                    : safeStringify(
                        value
                    )
            );
        }

        return value;
    }

    const commands =
        [
            {
                name:
                    "matrix",
                category:
                    "visualization",
                description:
                    "Render a matrix from a terminal library collection.",
                usage:
                    "matrix [collection] [--values] [--no-labels] [--columns a,b,c]",
                handler: async payload => {
                    const context =
                        resolveCommandContext(
                            payload
                        );

                    requireRenderer(
                        context
                    );

                    const args =
                        Array.isArray(
                            payload.args
                        )
                            ? payload.args
                            : [];

                    const parsed =
                        isObject(
                            payload.parsed
                        )
                            ? payload.parsed
                            : {
                                flags: {},
                                options: {}
                            };

                    const collection =
                        args[0] ||
                        "records";

                    const library =
                        context.library ||
                        context.services?.get?.(
                            "library"
                        );

                    const result =
                        library?.get?.(
                            collection
                        );

                    const data =
                        result &&
                        typeof result.then ===
                            "function"
                            ? await result
                            : result ||
                            [];

                    return render(
                        data,
                        {
                            title:
                                `Matrix: ${collection}`,
                            showValues:
                                parseBoolean(
                                    parsed.flags?.values,
                                    false
                                ),
                            showLabels:
                                !parseBoolean(
                                    parsed.flags?.[
                                        "no-labels"
                                    ],
                                    false
                                ),
                            columns:
                                parsed.options?.columns
                                    ? String(
                                        parsed.options.columns
                                    )
                                        .split(",")
                                        .map(
                                            field =>
                                                field.trim()
                                        )
                                        .filter(Boolean)
                                    : [
                                        "scientific_name",
                                        "common_name",
                                        "rank",
                                        "provider",
                                        "speciedex_id"
                                    ],
                            maximumRows:
                                clampInteger(
                                    parsed.options?.limit,
                                    DEFAULT_OPTIONS.maximumRows,
                                    1,
                                    100000
                                )
                        }
                    );
                }
            },

            {
                name:
                    "matrix-status",
                category:
                    "visualization",
                description:
                    "Display active matrix status.",
                usage:
                    "matrix-status",
                handler: payload => {
                    const context =
                        resolveCommandContext(
                            payload
                        );

                    const renderer =
                        requireRenderer(
                            context
                        );

                    const controller =
                        activeMatrix(
                            context
                        );

                    return writeResult(
                        payload,
                        {
                            version:
                                VERSION,
                            available:
                                true,
                            active:
                                Boolean(
                                    controller
                                ),
                            snapshot:
                                controller?.
                                    snapshot?.() ||
                                null,
                            renderer:
                                renderer.status?.() ||
                                null
                        }
                    );
                }
            },

            {
                name:
                    "matrix-cell",
                category:
                    "visualization",
                description:
                    "Inspect one matrix cell by row and column index.",
                usage:
                    "matrix-cell <row> <column>",
                handler: payload => {
                    const context =
                        resolveCommandContext(
                            payload
                        );

                    const args =
                        Array.isArray(
                            payload.args
                        )
                            ? payload.args
                            : [];

                    const controller =
                        activeMatrix(
                            context
                        );

                    if (!controller) {
                        throw new Error(
                            "No active matrix visualization is available."
                        );
                    }

                    const row =
                        Number.parseInt(
                            args[0],
                            10
                        );

                    const column =
                        Number.parseInt(
                            args[1],
                            10
                        );

                    if (
                        !Number.isInteger(
                            row
                        ) ||
                        !Number.isInteger(
                            column
                        )
                    ) {
                        throw new Error(
                            "Usage: matrix-cell <row> <column>"
                        );
                    }

                    const cell =
                        controller.cell(
                            row,
                            column
                        );

                    if (!cell) {
                        throw new Error(
                            "Matrix cell is outside the current matrix bounds."
                        );
                    }

                    controller.selectCell(
                        row,
                        column
                    );

                    return writeResult(
                        payload,
                        cell
                    );
                }
            },

            {
                name:
                    "matrix-reset",
                category:
                    "visualization",
                description:
                    "Reset the active matrix viewport.",
                usage:
                    "matrix-reset",
                handler: payload => {
                    const context =
                        resolveCommandContext(
                            payload
                        );

                    const controller =
                        activeMatrix(
                            context
                        );

                    if (!controller) {
                        throw new Error(
                            "No active matrix visualization is available."
                        );
                    }

                    controller.resetView();

                    return writeResult(
                        payload,
                        "Matrix viewport reset.",
                        "success"
                    );
                }
            },

            {
                name:
                    "matrix-export",
                category:
                    "visualization",
                description:
                    "Export the active matrix as PNG, JSON, or CSV.",
                usage:
                    "matrix-export [png|json|csv] [filename]",
                handler: payload => {
                    const context =
                        resolveCommandContext(
                            payload
                        );

                    const args =
                        Array.isArray(
                            payload.args
                        )
                            ? payload.args
                            : [];

                    const controller =
                        activeMatrix(
                            context
                        );

                    if (!controller) {
                        throw new Error(
                            "No exportable matrix visualization is active."
                        );
                    }

                    const format =
                        String(
                            args[0] ||
                            "png"
                        ).toLowerCase();

                    let filename;

                    if (format === "json") {
                        filename =
                            controller.exportJSON(
                                args[1] ||
                                "speciedex-matrix.json"
                            );
                    } else if (
                        format === "csv"
                    ) {
                        filename =
                            controller.exportCSV(
                                args[1] ||
                                "speciedex-matrix.csv"
                            );
                    } else if (
                        format === "png"
                    ) {
                        filename =
                            controller.exportPNG(
                                args[1] ||
                                "speciedex-matrix.png"
                            );
                    } else {
                        throw new Error(
                            "Use: matrix-export png|json|csv [filename]"
                        );
                    }

                    return writeResult(
                        payload,
                        `Matrix exported to ${filename}.`,
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

            PRIMARY_COLOR,
            ACCENT_COLOR,
            BACKGROUND_COLOR,
            DEFAULT_OPTIONS,
            REGISTRY_SYMBOL,
            CONTROLLER_SYMBOL,
            RENDERER_SYMBOL,

            MatrixController,

            clamp,
            clampInteger,
            parseBoolean,
            normalizeLabel,
            flattenRows,
            normalizeMatrix,
            numericValue,
            cellIntensity,
            hashString,
            rgbaFromHex,
            injectMatrixStyles,
            registry,
            dispatch,
            safeClone,
            safeStringify,
            resolveCommandContext,

            mount,
            render,

            initialize,
            init:
                initialize,
            setup:
                initialize,

            commands
        });

    window.SpeciedexTerminalMatrix =
        api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules ||
        {};

    window.SpeciedexTerminalModules[
        MODULE_NAME
    ] =
        api;

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
