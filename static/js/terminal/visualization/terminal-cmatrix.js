/*
========================================================================
Speciedex.org
Terminal CMatrix Visualization Adapter
========================================================================

Integrates the real CMatrix program:
    https://github.com/abishekvashok/cmatrix

The browser cannot execute the native ncurses binary directly. This module
therefore supports two legitimate CMatrix execution paths:

1. A WebAssembly build of the upstream CMatrix source exposed through an
   Emscripten-compatible runtime.
2. A PTY/WebSocket bridge that launches the installed `cmatrix` executable
   server-side and forwards its ANSI terminal stream to the browser.

No synthetic "matrix rain" fallback is included. If neither runtime is
available, the controller reports a clear configuration error.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "CMatrix";
    const DEFAULT_BACKEND = "auto";
    const DEFAULT_SOCKET_PATH = "/api/terminal/cmatrix";
    const DEFAULT_COLUMNS = 120;
    const DEFAULT_ROWS = 40;
    const DEFAULT_FONT_SIZE = 14;
    const DEFAULT_FOREGROUND = "#c0d674";
    const DEFAULT_BACKGROUND = "#020a05";
    const DEFAULT_RECONNECT_DELAY = 1000;
    const DEFAULT_MAX_RECONNECT_DELAY = 30000;
    const DEFAULT_HEARTBEAT = 20000;
    const MAX_SCROLLBACK = 2000;

    const ANSI_COLORS = Object.freeze({
        30: "#000000",
        31: "#aa0000",
        32: "#00aa00",
        33: "#aa5500",
        34: "#0000aa",
        35: "#aa00aa",
        36: "#00aaaa",
        37: "#aaaaaa",
        90: "#555555",
        91: "#ff5555",
        92: "#55ff55",
        93: "#ffff55",
        94: "#5555ff",
        95: "#ff55ff",
        96: "#55ffff",
        97: "#ffffff"
    });

    function now() {
        return Date.now();
    }

    function iso(timestamp = now()) {
        return new Date(timestamp).toISOString();
    }

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

    function safeDispatch(target, name, detail) {
        try {
            target.dispatchEvent(new CustomEvent(name, { detail }));
        } catch (error) {
            /* Visualization events must not interrupt runtime control. */
        }
    }

    function normalizeBackend(value) {
        const backend = String(value || DEFAULT_BACKEND).trim().toLowerCase();

        if (["auto", "wasm", "websocket", "pty"].includes(backend)) {
            return backend === "pty" ? "websocket" : backend;
        }

        throw new TypeError(`Unsupported CMatrix backend: ${value}`);
    }

    function resolveCanvas(target) {
        if (target instanceof HTMLCanvasElement) {
            return target;
        }

        if (target instanceof Element) {
            const existing = target.querySelector("canvas");

            if (existing) {
                return existing;
            }

            const canvas = document.createElement("canvas");
            target.appendChild(canvas);
            return canvas;
        }

        throw new TypeError("CMatrix requires a canvas or container element.");
    }

    function toWebSocketURL(value) {
        const url = new URL(value || DEFAULT_SOCKET_PATH, document.baseURI);

        if (url.protocol === "http:") {
            url.protocol = "ws:";
        } else if (url.protocol === "https:") {
            url.protocol = "wss:";
        }

        if (!["ws:", "wss:"].includes(url.protocol)) {
            throw new TypeError(`CMatrix PTY endpoint must use ws or wss: ${url.href}`);
        }

        return url.href;
    }

    function createResizeObserver(element, callback) {
        if (typeof ResizeObserver === "function") {
            const observer = new ResizeObserver(callback);
            observer.observe(element);
            return () => observer.disconnect();
        }

        window.addEventListener("resize", callback);
        return () => window.removeEventListener("resize", callback);
    }

    function findWasmRuntime() {
        const candidates = [
            window.SpeciedexCMatrixWasm,
            window.CMatrixWasm,
            window.CMatrixModule,
            window.createCMatrixModule
        ];

        return candidates.find((candidate) =>
            typeof candidate === "function" ||
            (candidate && typeof candidate === "object")
        ) || null;
    }

    class AnsiTerminalCanvas {
        constructor(canvas, options = {}) {
            this.canvas = canvas;
            this.context = canvas.getContext("2d", {
                alpha: false,
                desynchronized: true
            });

            if (!this.context) {
                throw new Error("Unable to acquire 2D canvas context.");
            }

            this.options = {
                columns: parseNumber(
                    options.columns,
                    DEFAULT_COLUMNS,
                    20,
                    1000
                ),
                rows: parseNumber(
                    options.rows,
                    DEFAULT_ROWS,
                    10,
                    500
                ),
                fontSize: parseNumber(
                    options.fontSize,
                    DEFAULT_FONT_SIZE,
                    8,
                    48
                ),
                fontFamily:
                    options.fontFamily ||
                    '"IBM Plex Mono", "Cascadia Mono", Consolas, monospace',
                foreground: options.foreground || DEFAULT_FOREGROUND,
                background: options.background || DEFAULT_BACKGROUND,
                lineHeight: parseNumber(options.lineHeight, 1.15, 1, 2),
                cursorVisible: options.cursorVisible !== false
            };

            this.cells = [];
            this.cursor = {
                row: 0,
                column: 0,
                visible: true
            };
            this.savedCursor = {
                row: 0,
                column: 0
            };
            this.style = {
                foreground: this.options.foreground,
                background: this.options.background,
                bold: false,
                faint: false,
                inverse: false
            };
            this.scrollback = [];
            this.parserBuffer = "";
            this.destroyed = false;
            this.cleanupResize = createResizeObserver(
                canvas,
                () => this.resize()
            );

            this.reset();
            this.resize();
        }

        _blankCell() {
            return {
                character: " ",
                foreground: this.options.foreground,
                background: this.options.background,
                bold: false,
                faint: false,
                inverse: false
            };
        }

        _blankRow() {
            return Array.from(
                { length: this.options.columns },
                () => this._blankCell()
            );
        }

        reset() {
            this.cells = Array.from(
                { length: this.options.rows },
                () => this._blankRow()
            );
            this.cursor.row = 0;
            this.cursor.column = 0;
            this.cursor.visible = true;
            this.style = {
                foreground: this.options.foreground,
                background: this.options.background,
                bold: false,
                faint: false,
                inverse: false
            };
            this.render();
        }

        resize() {
            const rect = this.canvas.getBoundingClientRect();
            const ratio = Math.min(window.devicePixelRatio || 1, 2);
            const width = Math.max(1, Math.floor(rect.width * ratio));
            const height = Math.max(1, Math.floor(rect.height * ratio));

            if (
                this.canvas.width !== width ||
                this.canvas.height !== height
            ) {
                this.canvas.width = width;
                this.canvas.height = height;
            }

            this.context.setTransform(ratio, 0, 0, ratio, 0, 0);

            const logicalWidth = Math.max(1, rect.width);
            const logicalHeight = Math.max(1, rect.height);
            const cellHeight =
                this.options.fontSize * this.options.lineHeight;
            const measuredColumns = Math.max(
                20,
                Math.floor(logicalWidth / (this.options.fontSize * 0.62))
            );
            const measuredRows = Math.max(
                10,
                Math.floor(logicalHeight / cellHeight)
            );

            this.setDimensions(measuredColumns, measuredRows, {
                preserve: true,
                render: false
            });
            this.render();
        }

        setDimensions(columns, rows, options = {}) {
            columns = parseNumber(columns, this.options.columns, 20, 1000);
            rows = parseNumber(rows, this.options.rows, 10, 500);

            const oldCells = this.cells;
            const oldRows = this.options.rows;
            const oldColumns = this.options.columns;

            this.options.columns = columns;
            this.options.rows = rows;
            this.cells = Array.from(
                { length: rows },
                () => this._blankRow()
            );

            if (options.preserve !== false && oldCells.length) {
                const rowsToCopy = Math.min(oldRows, rows);
                const columnsToCopy = Math.min(oldColumns, columns);

                for (let row = 0; row < rowsToCopy; row += 1) {
                    for (let column = 0; column < columnsToCopy; column += 1) {
                        this.cells[row][column] = oldCells[row][column];
                    }
                }
            }

            this.cursor.row = Math.min(this.cursor.row, rows - 1);
            this.cursor.column = Math.min(this.cursor.column, columns - 1);

            if (options.render !== false) {
                this.render();
            }

            return {
                columns,
                rows
            };
        }

        _scroll() {
            const removed = this.cells.shift();

            if (removed) {
                this.scrollback.push(removed);

                if (this.scrollback.length > MAX_SCROLLBACK) {
                    this.scrollback.shift();
                }
            }

            this.cells.push(this._blankRow());
            this.cursor.row = this.options.rows - 1;
        }

        _newline() {
            this.cursor.column = 0;
            this.cursor.row += 1;

            if (this.cursor.row >= this.options.rows) {
                this._scroll();
            }
        }

        _putCharacter(character) {
            if (character === "\n") {
                this._newline();
                return;
            }

            if (character === "\r") {
                this.cursor.column = 0;
                return;
            }

            if (character === "\b") {
                this.cursor.column = Math.max(0, this.cursor.column - 1);
                return;
            }

            if (character === "\t") {
                const next = Math.min(
                    this.options.columns - 1,
                    (Math.floor(this.cursor.column / 8) + 1) * 8
                );
                this.cursor.column = next;
                return;
            }

            if (character < " ") {
                return;
            }

            if (this.cursor.column >= this.options.columns) {
                this._newline();
            }

            let foreground = this.style.foreground;
            let background = this.style.background;

            if (this.style.inverse) {
                [foreground, background] = [background, foreground];
            }

            this.cells[this.cursor.row][this.cursor.column] = {
                character,
                foreground,
                background,
                bold: this.style.bold,
                faint: this.style.faint,
                inverse: this.style.inverse
            };

            this.cursor.column += 1;
        }

        _executeCSI(parameters, command) {
            const values = parameters.length
                ? parameters.split(";").map((value) => {
                    return value === "" ? 0 : Number(value);
                })
                : [0];
            const first = values[0] || 0;

            switch (command) {
                case "A":
                    this.cursor.row = Math.max(
                        0,
                        this.cursor.row - (first || 1)
                    );
                    break;

                case "B":
                    this.cursor.row = Math.min(
                        this.options.rows - 1,
                        this.cursor.row + (first || 1)
                    );
                    break;

                case "C":
                    this.cursor.column = Math.min(
                        this.options.columns - 1,
                        this.cursor.column + (first || 1)
                    );
                    break;

                case "D":
                    this.cursor.column = Math.max(
                        0,
                        this.cursor.column - (first || 1)
                    );
                    break;

                case "E":
                    this.cursor.row = Math.min(
                        this.options.rows - 1,
                        this.cursor.row + (first || 1)
                    );
                    this.cursor.column = 0;
                    break;

                case "F":
                    this.cursor.row = Math.max(
                        0,
                        this.cursor.row - (first || 1)
                    );
                    this.cursor.column = 0;
                    break;

                case "G":
                    this.cursor.column = Math.min(
                        this.options.columns - 1,
                        Math.max(0, (first || 1) - 1)
                    );
                    break;

                case "H":
                case "f": {
                    const row = (values[0] || 1) - 1;
                    const column = (values[1] || 1) - 1;
                    this.cursor.row = Math.min(
                        this.options.rows - 1,
                        Math.max(0, row)
                    );
                    this.cursor.column = Math.min(
                        this.options.columns - 1,
                        Math.max(0, column)
                    );
                    break;
                }

                case "J":
                    if (first === 2 || first === 3) {
                        this.reset();
                    } else if (first === 0) {
                        for (
                            let column = this.cursor.column;
                            column < this.options.columns;
                            column += 1
                        ) {
                            this.cells[this.cursor.row][column] =
                                this._blankCell();
                        }

                        for (
                            let row = this.cursor.row + 1;
                            row < this.options.rows;
                            row += 1
                        ) {
                            this.cells[row] = this._blankRow();
                        }
                    }
                    break;

                case "K":
                    if (first === 2) {
                        this.cells[this.cursor.row] = this._blankRow();
                    } else if (first === 1) {
                        for (
                            let column = 0;
                            column <= this.cursor.column;
                            column += 1
                        ) {
                            this.cells[this.cursor.row][column] =
                                this._blankCell();
                        }
                    } else {
                        for (
                            let column = this.cursor.column;
                            column < this.options.columns;
                            column += 1
                        ) {
                            this.cells[this.cursor.row][column] =
                                this._blankCell();
                        }
                    }
                    break;

                case "m":
                    this._setGraphicsRendition(values);
                    break;

                case "s":
                    this.savedCursor = {
                        row: this.cursor.row,
                        column: this.cursor.column
                    };
                    break;

                case "u":
                    this.cursor.row = this.savedCursor.row;
                    this.cursor.column = this.savedCursor.column;
                    break;

                case "h":
                    if (parameters === "?25") {
                        this.cursor.visible = true;
                    }
                    break;

                case "l":
                    if (parameters === "?25") {
                        this.cursor.visible = false;
                    }
                    break;

                default:
                    break;
            }
        }

        _setGraphicsRendition(values) {
            if (!values.length) {
                values = [0];
            }

            for (let index = 0; index < values.length; index += 1) {
                const value = values[index];

                if (value === 0) {
                    this.style = {
                        foreground: this.options.foreground,
                        background: this.options.background,
                        bold: false,
                        faint: false,
                        inverse: false
                    };
                } else if (value === 1) {
                    this.style.bold = true;
                } else if (value === 2) {
                    this.style.faint = true;
                } else if (value === 7) {
                    this.style.inverse = true;
                } else if (value === 22) {
                    this.style.bold = false;
                    this.style.faint = false;
                } else if (value === 27) {
                    this.style.inverse = false;
                } else if (ANSI_COLORS[value]) {
                    this.style.foreground = ANSI_COLORS[value];
                } else if (value >= 40 && value <= 47) {
                    this.style.background =
                        ANSI_COLORS[value - 10] || this.options.background;
                } else if (value >= 100 && value <= 107) {
                    this.style.background =
                        ANSI_COLORS[value - 10] || this.options.background;
                } else if (
                    (value === 38 || value === 48) &&
                    values[index + 1] === 5
                ) {
                    const colorIndex = values[index + 2];
                    const color = this._ansi256(colorIndex);

                    if (value === 38) {
                        this.style.foreground = color;
                    } else {
                        this.style.background = color;
                    }

                    index += 2;
                }
            }
        }

        _ansi256(index) {
            index = Number(index);

            if (index < 16) {
                const standard = [
                    "#000000", "#800000", "#008000", "#808000",
                    "#000080", "#800080", "#008080", "#c0c0c0",
                    "#808080", "#ff0000", "#00ff00", "#ffff00",
                    "#0000ff", "#ff00ff", "#00ffff", "#ffffff"
                ];
                return standard[index] || this.options.foreground;
            }

            if (index >= 232) {
                const level = 8 + (index - 232) * 10;
                return `rgb(${level}, ${level}, ${level})`;
            }

            const adjusted = index - 16;
            const red = Math.floor(adjusted / 36);
            const green = Math.floor((adjusted % 36) / 6);
            const blue = adjusted % 6;
            const scale = (value) => value === 0 ? 0 : 55 + value * 40;

            return `rgb(${scale(red)}, ${scale(green)}, ${scale(blue)})`;
        }

        write(data) {
            if (this.destroyed || data === undefined || data === null) {
                return;
            }

            const text = this.parserBuffer + String(data);
            this.parserBuffer = "";
            let index = 0;

            while (index < text.length) {
                const character = text[index];

                if (character !== "\u001b") {
                    this._putCharacter(character);
                    index += 1;
                    continue;
                }

                if (index + 1 >= text.length) {
                    this.parserBuffer = text.slice(index);
                    break;
                }

                const next = text[index + 1];

                if (next === "[") {
                    let end = index + 2;

                    while (
                        end < text.length &&
                        !/[A-Za-z@`~]/.test(text[end])
                    ) {
                        end += 1;
                    }

                    if (end >= text.length) {
                        this.parserBuffer = text.slice(index);
                        break;
                    }

                    const parameters = text.slice(index + 2, end);
                    const command = text[end];
                    this._executeCSI(parameters, command);
                    index = end + 1;
                    continue;
                }

                if (next === "7") {
                    this.savedCursor = {
                        row: this.cursor.row,
                        column: this.cursor.column
                    };
                    index += 2;
                    continue;
                }

                if (next === "8") {
                    this.cursor.row = this.savedCursor.row;
                    this.cursor.column = this.savedCursor.column;
                    index += 2;
                    continue;
                }

                if (next === "c") {
                    this.reset();
                    index += 2;
                    continue;
                }

                index += 2;
            }

            this.render();
        }

        render() {
            if (this.destroyed) {
                return;
            }

            const rect = this.canvas.getBoundingClientRect();
            const width = Math.max(1, rect.width);
            const height = Math.max(1, rect.height);
            const cellWidth = width / this.options.columns;
            const cellHeight = height / this.options.rows;
            const fontSize = Math.min(
                this.options.fontSize,
                cellHeight / this.options.lineHeight
            );

            this.context.fillStyle = this.options.background;
            this.context.fillRect(0, 0, width, height);
            this.context.textBaseline = "top";
            this.context.font =
                `${fontSize}px ${this.options.fontFamily}`;

            for (let row = 0; row < this.options.rows; row += 1) {
                for (
                    let column = 0;
                    column < this.options.columns;
                    column += 1
                ) {
                    const cell = this.cells[row][column];

                    if (cell.background !== this.options.background) {
                        this.context.fillStyle = cell.background;
                        this.context.fillRect(
                            column * cellWidth,
                            row * cellHeight,
                            cellWidth + 1,
                            cellHeight + 1
                        );
                    }

                    if (cell.character !== " ") {
                        this.context.globalAlpha = cell.faint ? 0.5 : 1;
                        this.context.fillStyle = cell.foreground;
                        this.context.font =
                            `${cell.bold ? "700" : "400"} ` +
                            `${fontSize}px ${this.options.fontFamily}`;
                        this.context.fillText(
                            cell.character,
                            column * cellWidth,
                            row * cellHeight
                        );
                    }
                }
            }

            this.context.globalAlpha = 1;

            if (
                this.options.cursorVisible &&
                this.cursor.visible &&
                this.cursor.row < this.options.rows &&
                this.cursor.column < this.options.columns
            ) {
                this.context.fillStyle = this.options.foreground;
                this.context.globalAlpha = 0.45;
                this.context.fillRect(
                    this.cursor.column * cellWidth,
                    this.cursor.row * cellHeight,
                    cellWidth,
                    cellHeight
                );
                this.context.globalAlpha = 1;
            }
        }

        configure(options = {}) {
            Object.assign(this.options, {
                fontSize: options.fontSize !== undefined
                    ? parseNumber(options.fontSize, this.options.fontSize, 8, 48)
                    : this.options.fontSize,
                fontFamily: options.fontFamily || this.options.fontFamily,
                foreground: options.foreground || this.options.foreground,
                background: options.background || this.options.background,
                lineHeight: options.lineHeight !== undefined
                    ? parseNumber(options.lineHeight, this.options.lineHeight, 1, 2)
                    : this.options.lineHeight,
                cursorVisible: options.cursorVisible !== undefined
                    ? Boolean(options.cursorVisible)
                    : this.options.cursorVisible
            });

            if (
                options.columns !== undefined ||
                options.rows !== undefined
            ) {
                this.setDimensions(
                    options.columns || this.options.columns,
                    options.rows || this.options.rows,
                    {
                        preserve: true
                    }
                );
            } else {
                this.render();
            }
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            this.cleanupResize?.();
            this.destroyed = true;
            this.cells = [];
            this.scrollback = [];
            return true;
        }
    }

    class WebSocketCMatrixRuntime extends EventTarget {
        constructor(controller, options = {}) {
            super();

            this.controller = controller;
            this.options = options;
            this.socket = null;
            this.reconnectTimer = 0;
            this.heartbeatTimer = 0;
            this.reconnectAttempts = 0;
            this.manualClose = false;
            this.destroyed = false;
            this.connectedAt = null;
            this.lastMessageAt = null;
            this.lastError = null;
        }

        _emit(type, detail = {}) {
            safeDispatch(this, type, {
                type,
                timestamp: iso(),
                ...detail
            });
        }

        _socketURL() {
            const url = new URL(
                toWebSocketURL(this.options.socketURL)
            );

            url.searchParams.set(
                "columns",
                String(this.controller.terminal.options.columns)
            );
            url.searchParams.set(
                "rows",
                String(this.controller.terminal.options.rows)
            );

            if (this.options.args?.length) {
                url.searchParams.set(
                    "args",
                    JSON.stringify(this.options.args)
                );
            }

            return url.href;
        }

        connect() {
            if (this.destroyed) {
                throw new Error("CMatrix WebSocket runtime has been destroyed.");
            }

            if (
                this.socket &&
                [
                    WebSocket.OPEN,
                    WebSocket.CONNECTING
                ].includes(this.socket.readyState)
            ) {
                return;
            }

            this.manualClose = false;
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = 0;

            const socket = new WebSocket(this._socketURL());
            socket.binaryType = "arraybuffer";
            this.socket = socket;

            socket.addEventListener("open", () => {
                this.connectedAt = iso();
                this.lastError = null;
                this.reconnectAttempts = 0;
                this._send({
                    type: "start",
                    program: "cmatrix",
                    args: this.options.args || []
                });
                this.resize(
                    this.controller.terminal.options.columns,
                    this.controller.terminal.options.rows
                );
                this._startHeartbeat();
                this._emit("open", {
                    url: socket.url
                });
            });

            socket.addEventListener("message", (event) => {
                this.lastMessageAt = iso();
                this._handleMessage(event.data);
            });

            socket.addEventListener("error", () => {
                this.lastError = new Error(
                    "CMatrix PTY WebSocket connection failed."
                );
                this._emit("error", {
                    error: this.lastError.message
                });
            });

            socket.addEventListener("close", (event) => {
                this._stopHeartbeat();
                this._emit("close", {
                    code: event.code,
                    reason: event.reason,
                    clean: event.wasClean
                });

                if (
                    !this.manualClose &&
                    !this.destroyed &&
                    this.options.autoReconnect !== false
                ) {
                    this._scheduleReconnect();
                }
            });
        }

        _handleMessage(data) {
            if (data instanceof ArrayBuffer) {
                this.controller.terminal.write(
                    new TextDecoder().decode(data)
                );
                return;
            }

            const text = String(data);

            try {
                const message = JSON.parse(text);

                if (message.type === "data") {
                    this.controller.terminal.write(
                        message.data || ""
                    );
                } else if (message.type === "exit") {
                    this._emit("exit", {
                        code: message.code,
                        signal: message.signal || null
                    });
                } else if (message.type === "error") {
                    this.lastError = new Error(
                        message.message || "CMatrix PTY error."
                    );
                    this._emit("error", {
                        error: this.lastError.message
                    });
                } else if (message.type === "pong") {
                    /* Heartbeat response. */
                }
            } catch (error) {
                this.controller.terminal.write(text);
            }
        }

        _send(message) {
            if (this.socket?.readyState === WebSocket.OPEN) {
                this.socket.send(
                    typeof message === "string"
                        ? message
                        : JSON.stringify(message)
                );
                return true;
            }

            return false;
        }

        _scheduleReconnect() {
            clearTimeout(this.reconnectTimer);
            this.reconnectAttempts += 1;

            const base = parseNumber(
                this.options.reconnectDelay,
                DEFAULT_RECONNECT_DELAY,
                100,
                60000
            );
            const maximum = parseNumber(
                this.options.maxReconnectDelay,
                DEFAULT_MAX_RECONNECT_DELAY,
                base,
                300000
            );
            const delay = Math.min(
                maximum,
                base * Math.pow(2, this.reconnectAttempts - 1)
            );
            const jitter = Math.round(delay * 0.2 * Math.random());

            this.reconnectTimer = window.setTimeout(
                () => this.connect(),
                delay + jitter
            );

            this._emit("reconnect", {
                attempt: this.reconnectAttempts,
                delay: delay + jitter
            });
        }

        _startHeartbeat() {
            this._stopHeartbeat();

            const interval = parseNumber(
                this.options.heartbeat,
                DEFAULT_HEARTBEAT,
                1000,
                120000
            );

            this.heartbeatTimer = window.setInterval(() => {
                this._send({
                    type: "ping",
                    timestamp: now()
                });
            }, interval);
        }

        _stopHeartbeat() {
            if (this.heartbeatTimer) {
                window.clearInterval(this.heartbeatTimer);
                this.heartbeatTimer = 0;
            }
        }

        resize(columns, rows) {
            this._send({
                type: "resize",
                columns,
                rows
            });
        }

        start() {
            this.connect();
        }

        stop() {
            this.manualClose = true;
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = 0;
            this._stopHeartbeat();

            if (this.socket) {
                try {
                    this._send({
                        type: "signal",
                        signal: "SIGTERM"
                    });
                    this.socket.close(1000, "CMatrix stopped");
                } catch (error) {
                    /* Ignore close failures. */
                }
            }

            this.socket = null;
        }

        sendKey(key) {
            this._send({
                type: "input",
                data: String(key)
            });
        }

        configure(options = {}) {
            Object.assign(this.options, options);

            if (options.args) {
                this.restart();
            }
        }

        restart() {
            this.stop();
            this.manualClose = false;
            this.connect();
        }

        status() {
            return {
                backend: "websocket",
                connected:
                    this.socket?.readyState === WebSocket.OPEN,
                connecting:
                    this.socket?.readyState === WebSocket.CONNECTING,
                reconnectAttempts: this.reconnectAttempts,
                connectedAt: this.connectedAt,
                lastMessageAt: this.lastMessageAt,
                lastError: this.lastError
                    ? this.lastError.message
                    : null
            };
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            this.stop();
            this.destroyed = true;
            return true;
        }
    }

    class WasmCMatrixRuntime extends EventTarget {
        constructor(controller, options = {}) {
            super();

            this.controller = controller;
            this.options = options;
            this.module = null;
            this.runtime = null;
            this.running = false;
            this.destroyed = false;
            this.lastError = null;
        }

        async initialize() {
            const factory =
                this.options.wasmFactory ||
                findWasmRuntime();

            if (!factory) {
                throw new Error(
                    "A CMatrix WebAssembly runtime was requested but no " +
                    "CMatrix Emscripten factory is available."
                );
            }

            const print = (text) => {
                this.controller.terminal.write(`${text}\n`);
            };
            const printErr = (text) => {
                this.controller.terminal.write(`${text}\n`);
            };

            const configuration = {
                noInitialRun: true,
                print,
                printErr,
                canvas: this.controller.canvas,
                arguments: this.options.args || [],
                onRuntimeInitialized: () => {
                    safeDispatch(this, "ready", {
                        timestamp: iso()
                    });
                }
            };

            if (typeof factory === "function") {
                const result = factory(configuration);
                this.module = result?.then
                    ? await result
                    : result;
            } else if (typeof factory.create === "function") {
                this.module = await factory.create(configuration);
            } else {
                this.module = factory;
            }

            if (!this.module) {
                throw new Error(
                    "CMatrix WebAssembly factory returned no module."
                );
            }

            this.runtime =
                this.module.cmatrix ||
                this.module.runtime ||
                this.module;
        }

        async start() {
            if (this.destroyed) {
                throw new Error("CMatrix WebAssembly runtime has been destroyed.");
            }

            if (!this.module) {
                await this.initialize();
            }

            const args = this.options.args || [];

            if (typeof this.runtime.start === "function") {
                await this.runtime.start(args, {
                    columns: this.controller.terminal.options.columns,
                    rows: this.controller.terminal.options.rows,
                    write: (data) => this.controller.terminal.write(data)
                });
            } else if (typeof this.module.callMain === "function") {
                this.module.callMain(args);
            } else if (typeof this.module._main === "function") {
                this.module._main(args.length, 0);
            } else {
                throw new Error(
                    "Unsupported CMatrix WebAssembly runtime API."
                );
            }

            this.running = true;
            safeDispatch(this, "start", {
                timestamp: iso()
            });
        }

        stop() {
            if (typeof this.runtime?.stop === "function") {
                this.runtime.stop();
            } else if (typeof this.runtime?.signal === "function") {
                this.runtime.signal("SIGTERM");
            }

            this.running = false;
            safeDispatch(this, "stop", {
                timestamp: iso()
            });
        }

        resize(columns, rows) {
            if (typeof this.runtime?.resize === "function") {
                this.runtime.resize(columns, rows);
            }
        }

        sendKey(key) {
            if (typeof this.runtime?.input === "function") {
                this.runtime.input(String(key));
            } else if (typeof this.runtime?.writeInput === "function") {
                this.runtime.writeInput(String(key));
            }
        }

        configure(options = {}) {
            Object.assign(this.options, options);

            if (typeof this.runtime?.configure === "function") {
                this.runtime.configure(options);
            }
        }

        restart() {
            this.stop();
            return this.start();
        }

        status() {
            return {
                backend: "wasm",
                running: this.running,
                loaded: Boolean(this.module),
                lastError: this.lastError
                    ? this.lastError.message
                    : null
            };
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            this.stop();

            if (typeof this.runtime?.destroy === "function") {
                this.runtime.destroy();
            }

            this.module = null;
            this.runtime = null;
            this.destroyed = true;
            return true;
        }
    }

    class CMatrixController extends EventTarget {
        constructor(target, options = {}) {
            super();

            this.canvas = resolveCanvas(target);
            this.options = {
                backend: normalizeBackend(options.backend),
                socketURL:
                    options.socketURL ||
                    options.endpoint ||
                    DEFAULT_SOCKET_PATH,
                wasmFactory: options.wasmFactory || null,
                args: Array.isArray(options.args)
                    ? [...options.args]
                    : [],
                autoStart: options.autoStart !== false,
                autoReconnect: options.autoReconnect !== false,
                reconnectDelay: parseNumber(
                    options.reconnectDelay,
                    DEFAULT_RECONNECT_DELAY,
                    100,
                    60000
                ),
                maxReconnectDelay: parseNumber(
                    options.maxReconnectDelay,
                    DEFAULT_MAX_RECONNECT_DELAY,
                    1000,
                    300000
                ),
                heartbeat: parseNumber(
                    options.heartbeat,
                    DEFAULT_HEARTBEAT,
                    1000,
                    120000
                ),
                columns: parseNumber(
                    options.columns,
                    DEFAULT_COLUMNS,
                    20,
                    1000
                ),
                rows: parseNumber(
                    options.rows,
                    DEFAULT_ROWS,
                    10,
                    500
                ),
                fontSize: parseNumber(
                    options.fontSize,
                    DEFAULT_FONT_SIZE,
                    8,
                    48
                ),
                fontFamily: options.fontFamily,
                foreground: options.foreground || DEFAULT_FOREGROUND,
                background: options.background || DEFAULT_BACKGROUND,
                cursorVisible: options.cursorVisible !== false,
                keyboard: options.keyboard !== false
            };

            this.context = options.context || null;
            this.terminal = new AnsiTerminalCanvas(
                this.canvas,
                this.options
            );
            this.runtime = null;
            this.backend = null;
            this.running = false;
            this.destroyed = false;
            this.startedAt = null;
            this.lastError = null;
            this.metrics = {
                starts: 0,
                stops: 0,
                restarts: 0,
                resizes: 0,
                keys: 0,
                errors: 0
            };

            this._boundKeydown = this._handleKeydown.bind(this);
            this._cleanupResize = createResizeObserver(
                this.canvas,
                () => this._handleResize()
            );

            if (this.options.keyboard) {
                this.canvas.tabIndex = this.canvas.tabIndex >= 0
                    ? this.canvas.tabIndex
                    : 0;
                this.canvas.setAttribute(
                    "aria-label",
                    "Interactive CMatrix terminal visualization"
                );
                this.canvas.addEventListener(
                    "keydown",
                    this._boundKeydown
                );
            }

            this._createRuntime();

            if (this.options.autoStart) {
                Promise.resolve(this.start()).catch((error) => {
                    this._recordError(error);
                });
            }
        }

        _emit(type, detail = {}) {
            const event = {
                type,
                timestamp: iso(),
                backend: this.backend,
                ...detail
            };

            safeDispatch(this, type, event);

            try {
                this.context?.events?.emit?.(`cmatrix:${type}`, event);
            } catch (error) {
                this._recordError(error);
            }

            return event;
        }

        _recordError(error) {
            this.lastError = error instanceof Error
                ? error
                : new Error(String(error));
            this.metrics.errors += 1;

            this._emit("error", {
                error: {
                    name: this.lastError.name,
                    message: this.lastError.message,
                    stack: this.lastError.stack || ""
                }
            });
        }

        _selectBackend() {
            if (this.options.backend !== "auto") {
                return this.options.backend;
            }

            if (
                this.options.wasmFactory ||
                findWasmRuntime()
            ) {
                return "wasm";
            }

            return "websocket";
        }

        _createRuntime() {
            this.backend = this._selectBackend();

            if (this.backend === "wasm") {
                this.runtime = new WasmCMatrixRuntime(
                    this,
                    this.options
                );
            } else {
                this.runtime = new WebSocketCMatrixRuntime(
                    this,
                    this.options
                );
            }

            for (const eventName of [
                "open",
                "close",
                "ready",
                "exit",
                "reconnect",
                "error"
            ]) {
                this.runtime.addEventListener?.(
                    eventName,
                    (event) => this._emit(
                        `runtime:${eventName}`,
                        clone(event.detail || {})
                    )
                );
            }
        }

        _handleResize() {
            const dimensions = {
                columns: this.terminal.options.columns,
                rows: this.terminal.options.rows
            };

            this.runtime?.resize?.(
                dimensions.columns,
                dimensions.rows
            );
            this.metrics.resizes += 1;
            this._emit("resize", dimensions);
        }

        _handleKeydown(event) {
            const mappings = {
                ArrowUp: "\u001b[A",
                ArrowDown: "\u001b[B",
                ArrowRight: "\u001b[C",
                ArrowLeft: "\u001b[D",
                Escape: "\u001b",
                Enter: "\r",
                Backspace: "\u007f",
                Tab: "\t"
            };

            let data = mappings[event.key];

            if (!data && event.key.length === 1) {
                data = event.key;
            }

            if (!data) {
                return;
            }

            event.preventDefault();
            this.runtime?.sendKey?.(data);
            this.metrics.keys += 1;
        }

        async start() {
            if (this.destroyed) {
                throw new Error("CMatrix controller has been destroyed.");
            }

            if (this.running) {
                return this;
            }

            await this.runtime.start();
            this.running = true;
            this.startedAt = this.startedAt || iso();
            this.metrics.starts += 1;
            this._emit("start", {
                args: [...this.options.args]
            });
            return this;
        }

        stop() {
            if (!this.running) {
                return this;
            }

            this.runtime?.stop?.();
            this.running = false;
            this.metrics.stops += 1;
            this._emit("stop", {});
            return this;
        }

        async restart() {
            this.metrics.restarts += 1;
            this.running = false;
            await this.runtime?.restart?.();
            this.running = true;
            this._emit("restart", {
                args: [...this.options.args]
            });
            return this;
        }

        pause() {
            return this.stop();
        }

        resume() {
            return this.start();
        }

        clear() {
            this.terminal.reset();
            this._emit("clear", {});
            return this;
        }

        update(options = {}) {
            if (!isObject(options)) {
                throw new TypeError("CMatrix configuration must be an object.");
            }

            if (options.backend !== undefined) {
                const backend = normalizeBackend(options.backend);

                if (backend !== this.options.backend) {
                    this.stop();
                    this.runtime?.destroy?.();
                    this.options.backend = backend;
                    this._createRuntime();
                }
            }

            if (options.args !== undefined) {
                this.options.args = Array.isArray(options.args)
                    ? [...options.args]
                    : [];
            }

            Object.assign(this.options, {
                socketURL:
                    options.socketURL ||
                    options.endpoint ||
                    this.options.socketURL,
                autoReconnect: options.autoReconnect !== undefined
                    ? Boolean(options.autoReconnect)
                    : this.options.autoReconnect,
                foreground:
                    options.foreground ||
                    this.options.foreground,
                background:
                    options.background ||
                    this.options.background
            });

            this.terminal.configure(options);
            this.runtime?.configure?.({
                ...options,
                args: this.options.args,
                socketURL: this.options.socketURL
            });

            this._emit("update", {
                options: clone(this.options)
            });

            return this;
        }

        setArgs(args = []) {
            this.options.args = Array.isArray(args)
                ? [...args]
                : [];

            this.runtime?.configure?.({
                args: this.options.args
            });

            return [...this.options.args];
        }

        sendKey(key) {
            this.runtime?.sendKey?.(key);
            this.metrics.keys += 1;
            return true;
        }

        inject() {
            throw new Error(
                "CMatrix input injection is unsupported. This adapter displays " +
                "output from the real upstream cmatrix process only."
            );
        }

        status() {
            return {
                name: "cmatrix",
                module: MODULE_NAME,
                backend: this.backend,
                running: this.running,
                startedAt: this.startedAt,
                args: [...this.options.args],
                dimensions: {
                    columns: this.terminal.options.columns,
                    rows: this.terminal.options.rows
                },
                runtime: this.runtime?.status?.() || null,
                metrics: { ...this.metrics },
                lastError: this.lastError
                    ? {
                        name: this.lastError.name,
                        message: this.lastError.message
                    }
                    : null,
                destroyed: this.destroyed
            };
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            this.stop();
            this.canvas.removeEventListener(
                "keydown",
                this._boundKeydown
            );
            this._cleanupResize?.();
            this.runtime?.destroy?.();
            this.terminal.destroy();
            this.runtime = null;
            this.destroyed = true;
            this._emit("destroy", {});
            return true;
        }
    }

    function mount(target, options = {}) {
        return new CMatrixController(target, options);
    }

    function render(data, options = {}) {
        const container = document.createElement("section");
        container.className =
            "terminal-visualization terminal-visualization-cmatrix";
        container.dataset.visualization = "cmatrix";

        const canvas = document.createElement("canvas");
        canvas.className = "terminal-cmatrix-canvas";
        canvas.setAttribute(
            "aria-label",
            "CMatrix terminal visualization"
        );

        const status = document.createElement("div");
        status.className = "terminal-cmatrix-status";
        status.setAttribute("aria-live", "polite");

        container.append(canvas, status);

        const controller = mount(canvas, {
            ...options,
            data
        });

        const updateStatus = () => {
            const snapshot = controller.status();

            status.textContent = snapshot.lastError
                ? `CMatrix error: ${snapshot.lastError.message}`
                : snapshot.running
                    ? `CMatrix running through ${snapshot.backend}`
                    : `CMatrix stopped (${snapshot.backend})`;
        };

        for (const eventName of [
            "start",
            "stop",
            "error",
            "runtime:open",
            "runtime:close"
        ]) {
            controller.addEventListener(eventName, updateStatus);
        }

        updateStatus();

        container.controller = controller;
        container.destroy = () => controller.destroy();

        return container;
    }

    function initialize(context = {}) {
        const dataset = context.root?.dataset || {};
        const config = context.config?.cmatrix || {};

        const defaults = {
            context,
            backend:
                dataset.terminalCmatrixBackend ||
                config.backend ||
                DEFAULT_BACKEND,
            socketURL:
                dataset.terminalCmatrixSocket ||
                config.socketURL ||
                DEFAULT_SOCKET_PATH,
            args:
                config.args ||
                [],
            autoReconnect: parseBoolean(
                dataset.terminalCmatrixReconnect,
                config.autoReconnect !== false
            ),
            foreground:
                dataset.terminalCmatrixForeground ||
                config.foreground ||
                DEFAULT_FOREGROUND,
            background:
                dataset.terminalCmatrixBackground ||
                config.background ||
                DEFAULT_BACKGROUND
        };

        const visualization = {
            mount(target, options = {}) {
                return mount(target, {
                    ...defaults,
                    ...options,
                    context
                });
            },
            render(data, options = {}) {
                return render(data, {
                    ...defaults,
                    ...options,
                    context
                });
            },
            Controller: CMatrixController,
            AnsiTerminalCanvas,
            hasWasmRuntime: Boolean(findWasmRuntime()),
            defaultBackend: defaults.backend,
            upstream:
                "https://github.com/abishekvashok/cmatrix"
        };

        context.registerVisualization?.(
            "cmatrix",
            visualization
        );
        context.registerRenderer?.(
            "cmatrix",
            visualization
        );
        context.cmatrix = visualization;

        safeDispatch(document, "speciedex:terminal-cmatrix-ready", {
            visualization,
            backend: defaults.backend,
            hasWasmRuntime: visualization.hasWasmRuntime
        });

        return visualization;
    }

    const commands = [{
        name: "cmatrix",
        category: "visualization",
        description:
            "Control the real upstream CMatrix runtime through WASM or a PTY bridge.",
        usage:
            "cmatrix [status|start|stop|restart|clear|args|backend|key]",
        handler: async ({
            args = [],
            context,
            writeJSON,
            write,
            writeError
        }) => {
            const action = String(args[0] || "status").toLowerCase();
            const splash = context.terminalSplash;
            const controller =
                splash?.matrixController ||
                splash?.cmatrixController ||
                context.cmatrixController;

            if (!controller) {
                throw new Error(
                    "No mounted CMatrix controller is available."
                );
            }

            try {
                switch (action) {
                    case "status":
                    case "show":
                    case "info":
                        return writeJSON(controller.status());

                    case "start":
                        await controller.start();
                        return write(
                            "CMatrix runtime started.",
                            "success"
                        );

                    case "stop":
                        controller.stop();
                        return write(
                            "CMatrix runtime stopped.",
                            "success"
                        );

                    case "restart":
                        await controller.restart();
                        return write(
                            "CMatrix runtime restarted.",
                            "success"
                        );

                    case "clear":
                        controller.clear();
                        return write(
                            "CMatrix terminal cleared.",
                            "success"
                        );

                    case "args":
                        if (args.length === 1) {
                            return writeJSON({
                                args: controller.options.args
                            });
                        }

                        return writeJSON({
                            args: controller.setArgs(args.slice(1))
                        });

                    case "backend":
                        if (!args[1]) {
                            return writeJSON({
                                backend: controller.backend
                            });
                        }

                        controller.update({
                            backend: args[1]
                        });

                        return writeJSON({
                            backend: controller.backend
                        });

                    case "key":
                        if (!args[1]) {
                            throw new Error(
                                "Usage: cmatrix key <character-or-sequence>"
                            );
                        }

                        controller.sendKey(args.slice(1).join(" "));
                        return write(
                            "Input sent to CMatrix.",
                            "success"
                        );

                    default:
                        throw new Error(
                            `Unknown cmatrix action "${action}". Use status, ` +
                            "start, stop, restart, clear, args, backend, or key."
                        );
                }
            } catch (error) {
                if (typeof writeError === "function") {
                    writeError(error.message);
                    return null;
                }

                throw error;
            }
        }
    }];

    const api = Object.freeze({
        name: MODULE_NAME,
        CMatrixController,
        AnsiTerminalCanvas,
        WebSocketCMatrixRuntime,
        WasmCMatrixRuntime,
        mount,
        render,
        initialize,
        init: initialize,
        setup: initialize,
        commands,
        upstream:
            "https://github.com/abishekvashok/cmatrix"
    });

    window.SpeciedexTerminalCMatrix = api;
    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(
        new CustomEvent(
            "speciedex:terminal-module-available",
            {
                detail: {
                    name: MODULE_NAME,
                    module: api
                }
            }
        )
    );
})(window, document);
