/*
========================================================================
Speciedex.org
Terminal Matrix Renderer
========================================================================

Reusable matrix renderer for SpeciedexTerminal.

This module provides the base matrix abstraction used by:

    • terminal-cmatrix.js
    • terminal-zmatrix.js
    • terminal-provider-matrix.js
    • terminal-heatmap.js
    • terminal-splash.js

Features:

    • Canvas-backed matrix rendering
    • Numeric, categorical, and boolean cells
    • Automatic value normalization
    • Row and column labels
    • Configurable cell sizing and spacing
    • Responsive resizing
    • Animated updates
    • Hover inspection
    • PNG export
    • Structured renderer lifecycle
    • Terminal commands

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME =
        "Matrix";

    const DEFAULT_OPTIONS =
        Object.freeze({
            width:
                960,

            height:
                540,

            minCellSize:
                8,

            maxCellSize:
                48,

            gap:
                1,

            padding:
                24,

            showLabels:
                true,

            showValues:
                false,

            animate:
                true,

            animationDuration:
                240,

            responsive:
                true,

            autoStart:
                true
        });

    /*
    ==========================================================================
    Utilities
    ==========================================================================
    */

    function clamp(
        value,
        minimum,
        maximum
    ) {
        return Math.min(
            maximum,
            Math.max(
                minimum,
                value
            )
        );
    }

    function isCanvas(value) {
        return (
            value instanceof
            HTMLCanvasElement
        );
    }

    function resolveCanvas(target) {
        if (isCanvas(target)) {
            return target;
        }

        if (
            target instanceof
            Element
        ) {
            const existing =
                target.querySelector(
                    "canvas"
                );

            if (existing) {
                return existing;
            }

            const canvas =
                document.createElement(
                    "canvas"
                );

            target.appendChild(
                canvas
            );

            return canvas;
        }

        throw new TypeError(
            "Matrix renderer requires a canvas or container element."
        );
    }

    function normalizeLabel(value) {
        return String(
            value ?? ""
        ).trim();
    }

    function flattenRows(data) {
        if (!Array.isArray(data)) {
            return [];
        }

        if (
            data.every(
                row =>
                    Array.isArray(row)
            )
        ) {
            return data.map(
                row =>
                    [...row]
            );
        }

        if (
            data.every(
                row =>
                    row &&
                    typeof row ===
                    "object"
            )
        ) {
            const columns =
                [...new Set(
                    data.flatMap(
                        row =>
                            Object.keys(row)
                    )
                )];

            return data.map(
                row =>
                    columns.map(
                        column =>
                            row[column]
                    )
            );
        }

        return [
            [...data]
        ];
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

    function normalizeMatrix(
        data,
        options = {}
    ) {
        const rows =
            flattenRows(data);

        const rowCount =
            rows.length;

        const columnCount =
            rows.reduce(
                (maximum, row) =>
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
                        value !== null
                );

        const minimum =
            numeric.length
                ? Math.min(
                    ...numeric
                )
                : 0;

        const maximum =
            numeric.length
                ? Math.max(
                    ...numeric
                )
                : 1;

        const range =
            maximum - minimum || 1;

        const rowLabels =
            Array.isArray(
                options.rowLabels
            )
                ? options.rowLabels
                : rows.map(
                    (_, index) =>
                        String(
                            index + 1
                        )
                );

        const columnLabels =
            Array.isArray(
                options.columnLabels
            )
                ? options.columnLabels
                : Array.from(
                    {
                        length:
                            columnCount
                    },
                    (_, index) =>
                        String(
                            index + 1
                        )
                );

        return {
            rows,
            rowCount,
            columnCount,
            minimum,
            maximum,
            range,
            rowLabels,
            columnLabels
        };
    }

    function cellIntensity(
        value,
        matrix
    ) {
        const numeric =
            numericValue(value);

        if (numeric !== null) {
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

        if (
            typeof value ===
            "string"
        ) {
            let hash = 0;

            for (
                let index = 0;
                index < value.length;
                index += 1
            ) {
                hash =
                    (
                        hash * 31 +
                        value.charCodeAt(
                            index
                        )
                    ) >>> 0;
            }

            return (
                hash % 1000
            ) / 1000;
        }

        return value
            ? 1
            : 0;
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

            this.canvas =
                resolveCanvas(
                    target
                );

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
                ...options
            };

            this.data =
                data;

            this.matrix =
                normalizeMatrix(
                    data,
                    this.options
                );

            this.hoveredCell =
                null;

            this.running =
                false;

            this.destroyed =
                false;

            this.animationFrame =
                0;

            this.animationStart =
                0;

            this.resizeObserver =
                null;

            this.boundPointerMove =
                event =>
                    this.handlePointerMove(
                        event
                    );

            this.boundPointerLeave =
                () =>
                    this.handlePointerLeave();

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

        installEvents() {
            this.canvas.addEventListener(
                "pointermove",
                this.boundPointerMove
            );

            this.canvas.addEventListener(
                "pointerleave",
                this.boundPointerLeave
            );
        }

        installResize() {
            if (
                !this.options.responsive
            ) {
                return;
            }

            if (
                "ResizeObserver" in
                window
            ) {
                this.resizeObserver =
                    new ResizeObserver(
                        () =>
                            this.resize()
                    );

                this.resizeObserver.observe(
                    this.canvas
                );

                return;
            }

            window.addEventListener(
                "resize",
                () =>
                    this.resize()
            );
        }

        resize() {
            if (this.destroyed) {
                return;
            }

            const rect =
                this.canvas.getBoundingClientRect();

            const cssWidth =
                Math.max(
                    1,
                    rect.width ||
                    Number(
                        this.options.width
                    ) ||
                    960
                );

            const cssHeight =
                Math.max(
                    1,
                    rect.height ||
                    Number(
                        this.options.height
                    ) ||
                    540
                );

            const ratio =
                Math.min(
                    window.devicePixelRatio ||
                    1,
                    2
                );

            this.canvas.width =
                Math.floor(
                    cssWidth *
                    ratio
                );

            this.canvas.height =
                Math.floor(
                    cssHeight *
                    ratio
                );

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
                    cssHeight
            };

            this.layout =
                this.calculateLayout();

            this.draw();
        }

        calculateLayout() {
            const {
                width,
                height
            } = this.viewport;

            const padding =
                Number(
                    this.options.padding
                ) || 0;

            const labelWidth =
                this.options.showLabels
                    ? 96
                    : 0;

            const labelHeight =
                this.options.showLabels
                    ? 28
                    : 0;

            const availableWidth =
                Math.max(
                    1,
                    width -
                    padding * 2 -
                    labelWidth
                );

            const availableHeight =
                Math.max(
                    1,
                    height -
                    padding * 2 -
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

            const cellSize =
                clamp(
                    Math.min(
                        rawCellWidth,
                        rawCellHeight
                    ),
                    Number(
                        this.options.minCellSize
                    ) || 1,
                    Number(
                        this.options.maxCellSize
                    ) || 48
                );

            const matrixWidth =
                cellSize *
                columns;

            const matrixHeight =
                cellSize *
                rows;

            return {
                x:
                    padding +
                    labelWidth,

                y:
                    padding +
                    labelHeight,

                cellSize,
                matrixWidth,
                matrixHeight,
                labelWidth,
                labelHeight
            };
        }

        start() {
            if (
                this.running ||
                this.destroyed
            ) {
                return;
            }

            this.running =
                true;

            this.animationStart =
                performance.now();

            this.animate();
        }

        stop() {
            this.running =
                false;

            if (
                this.animationFrame
            ) {
                window.cancelAnimationFrame(
                    this.animationFrame
                );
            }
        }

        animate(timestamp = performance.now()) {
            if (
                !this.running ||
                this.destroyed
            ) {
                return;
            }

            this.draw(
                timestamp
            );

            this.animationFrame =
                window.requestAnimationFrame(
                    next =>
                        this.animate(
                            next
                        )
                );
        }

        draw(timestamp = performance.now()) {
            if (this.destroyed) {
                return;
            }

            const {
                width,
                height
            } = this.viewport;

            this.context.clearRect(
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
                            ) || 240
                        ),
                        0,
                        1
                    )
                    : 1;

            this.drawLabels();
            this.drawCells(
                progress
            );
            this.drawHover();
        }

        drawLabels() {
            if (
                !this.options.showLabels
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
                "11px monospace";

            this.context.fillStyle =
                "rgba(216, 230, 219, 0.72)";

            this.context.textBaseline =
                "middle";

            this.context.textAlign =
                "right";

            this.matrix.rowLabels.forEach(
                (label, row) => {
                    this.context.fillText(
                        normalizeLabel(
                            label
                        ),
                        x - 8,
                        y +
                        row *
                        cellSize +
                        cellSize / 2
                    );
                }
            );

            this.context.textAlign =
                "center";

            this.context.textBaseline =
                "bottom";

            this.matrix.columnLabels.forEach(
                (label, column) => {
                    this.context.fillText(
                        normalizeLabel(
                            label
                        ),
                        x +
                        column *
                        cellSize +
                        cellSize / 2,
                        y - 6
                    );
                }
            );

            this.context.restore();
        }

        drawCells(progress) {
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
                    ) || 0
                );

            for (
                let row = 0;
                row <
                this.matrix.rowCount;
                row += 1
            ) {
                for (
                    let column = 0;
                    column <
                    this.matrix.columnCount;
                    column += 1
                ) {
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
                            0.08 +
                            intensity *
                            0.82
                        ) *
                        progress;

                    const cellX =
                        x +
                        column *
                        cellSize +
                        gap / 2;

                    const cellY =
                        y +
                        row *
                        cellSize +
                        gap / 2;

                    const size =
                        Math.max(
                            1,
                            cellSize -
                            gap
                        );

                    this.context.fillStyle =
                        `rgba(192, 214, 116, ${alpha})`;

                    this.context.fillRect(
                        cellX,
                        cellY,
                        size,
                        size
                    );

                    if (
                        this.options.showValues &&
                        cellSize >= 18
                    ) {
                        this.context.font =
                            `${Math.max(
                                8,
                                Math.floor(
                                    cellSize *
                                    0.28
                                )
                            )}px monospace`;

                        this.context.textAlign =
                            "center";

                        this.context.textBaseline =
                            "middle";

                        this.context.fillStyle =
                            intensity > 0.52
                                ? "rgba(5, 12, 7, 0.88)"
                                : "rgba(216, 230, 219, 0.82)";

                        this.context.fillText(
                            normalizeLabel(
                                value
                            ),
                            cellX +
                            size / 2,
                            cellY +
                            size / 2
                        );
                    }
                }
            }
        }

        drawHover() {
            if (!this.hoveredCell) {
                return;
            }

            const {
                row,
                column
            } = this.hoveredCell;

            const {
                x,
                y,
                cellSize
            } = this.layout;

            this.context.save();

            this.context.strokeStyle =
                "rgba(230, 164, 43, 0.96)";

            this.context.lineWidth =
                2;

            this.context.strokeRect(
                x +
                column *
                cellSize +
                1,
                y +
                row *
                cellSize +
                1,
                cellSize - 2,
                cellSize - 2
            );

            this.context.restore();
        }

        handlePointerMove(event) {
            const rect =
                this.canvas.getBoundingClientRect();

            const x =
                event.clientX -
                rect.left;

            const y =
                event.clientY -
                rect.top;

            const column =
                Math.floor(
                    (
                        x -
                        this.layout.x
                    ) /
                    this.layout.cellSize
                );

            const row =
                Math.floor(
                    (
                        y -
                        this.layout.y
                    ) /
                    this.layout.cellSize
                );

            if (
                row < 0 ||
                column < 0 ||
                row >=
                    this.matrix.rowCount ||
                column >=
                    this.matrix.columnCount
            ) {
                this.handlePointerLeave();
                return;
            }

            const value =
                this.matrix.rows[
                    row
                ]?.[
                    column
                ];

            this.hoveredCell = {
                row,
                column,
                value,
                rowLabel:
                    this.matrix.rowLabels[
                        row
                    ],
                columnLabel:
                    this.matrix.columnLabels[
                        column
                    ]
            };

            this.canvas.title =
                `${this.hoveredCell.rowLabel} / ` +
                `${this.hoveredCell.columnLabel}: ` +
                `${normalizeLabel(value)}`;

            this.dispatchEvent(
                new CustomEvent(
                    "cell-hover",
                    {
                        detail:
                            this.hoveredCell
                    }
                )
            );

            if (!this.running) {
                this.draw();
            }
        }

        handlePointerLeave() {
            this.hoveredCell =
                null;

            this.canvas.removeAttribute(
                "title"
            );

            if (!this.running) {
                this.draw();
            }
        }

        update(
            data = this.data,
            options = {}
        ) {
            this.data =
                data;

            this.options = {
                ...this.options,
                ...options
            };

            this.matrix =
                normalizeMatrix(
                    data,
                    this.options
                );

            this.animationStart =
                performance.now();

            this.layout =
                this.calculateLayout();

            this.draw();

            this.dispatchEvent(
                new CustomEvent(
                    "update",
                    {
                        detail: {
                            data,
                            options:
                                this.options,
                            matrix:
                                this.matrix
                        }
                    }
                )
            );

            return this;
        }

        exportPNG(
            filename =
                "speciedex-matrix.png"
        ) {
            const link =
                document.createElement(
                    "a"
                );

            link.href =
                this.canvas.toDataURL(
                    "image/png"
                );

            link.download =
                filename;

            link.click();

            return filename;
        }

        snapshot() {
            return {
                rows:
                    this.matrix.rowCount,

                columns:
                    this.matrix.columnCount,

                minimum:
                    this.matrix.minimum,

                maximum:
                    this.matrix.maximum,

                running:
                    this.running,

                options:
                    { ...this.options }
            };
        }

        destroy() {
            if (this.destroyed) {
                return;
            }

            this.stop();

            this.canvas.removeEventListener(
                "pointermove",
                this.boundPointerMove
            );

            this.canvas.removeEventListener(
                "pointerleave",
                this.boundPointerLeave
            );

            this.resizeObserver?.
                disconnect();

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
    Renderer API
    ==========================================================================
    */

    function mount(
        target,
        data = [],
        options = {}
    ) {
        return new MatrixController(
            target,
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
            "terminal-renderer terminal-renderer-matrix";

        container.dataset.renderer =
            "matrix";

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

        const canvas =
            document.createElement(
                "canvas"
            );

        canvas.className =
            "terminal-matrix-canvas";

        canvas.width =
            Number(
                options.width
            ) || DEFAULT_OPTIONS.width;

        canvas.height =
            Number(
                options.height
            ) || DEFAULT_OPTIONS.height;

        container.appendChild(
            canvas
        );

        const controller =
            mount(
                canvas,
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
    Initialize
    ==========================================================================
    */

    function initialize(context) {
        const renderer = {
            mount,
            render,
            Controller:
                MatrixController,
            normalizeMatrix,
            cellIntensity
        };

        context.registerRenderer?.(
            "matrix",
            renderer
        );

        context.matrixRenderer =
            renderer;

        context.matrix =
            renderer;

        return renderer;
    }

    /*
    ==========================================================================
    Commands
    ==========================================================================
    */

    const commands = [
        {
            name:
                "matrix",

            category:
                "visualization",

            description:
                "Render a matrix from a terminal library collection.",

            usage:
                "matrix [collection] [--values] [--no-labels]",

            handler: ({
                args,
                parsed,
                context
            }) => {
                const collection =
                    args[0] ||
                    "records";

                const data =
                    context.library?.
                        get?.(
                            collection
                        ) ||
                    [];

                return render(
                    data,
                    {
                        title:
                            `Matrix: ${collection}`,

                        showValues:
                            parsed.flags.values ===
                            true,

                        showLabels:
                            parsed.flags[
                                "no-labels"
                            ] !== true
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
                "Display matrix renderer availability and active splash state.",

            usage:
                "matrix-status",

            handler: ({
                context,
                writeJSON
            }) => {
                const controller =
                    context.terminalSplash?.
                        matrixController ||
                    null;

                return writeJSON({
                    available:
                        true,

                    controller:
                        controller?.
                            constructor?.
                            name ||
                        null,

                    active:
                        Boolean(
                            controller
                        ),

                    snapshot:
                        controller?.
                            snapshot?.() ||
                        null
                });
            }
        },

        {
            name:
                "matrix-export",

            category:
                "visualization",

            description:
                "Export the active matrix canvas as PNG.",

            usage:
                "matrix-export [filename]",

            handler: ({
                args,
                context,
                write
            }) => {
                const controller =
                    context.terminalSplash?.
                        matrixController;

                if (
                    !controller?.
                        exportPNG
                ) {
                    throw new Error(
                        "No exportable matrix visualization is active."
                    );
                }

                const filename =
                    controller.exportPNG(
                        args[0] ||
                        "speciedex-matrix.png"
                    );

                return write(
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

            MatrixController,
            normalizeMatrix,
            cellIntensity,
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
