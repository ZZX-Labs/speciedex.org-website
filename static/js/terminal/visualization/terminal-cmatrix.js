/*
========================================================================
Speciedex.org
Terminal cmatrix Visualization Adapter
========================================================================

Renders the real upstream cmatrix program:
    https://github.com/abishekvashok/cmatrix

The native executable runs inside a server-side PTY. Its ANSI stream is
forwarded over WebSocket and rendered here. No synthetic matrix fallback is
included.

Requires:
    /static/js/terminal/cmatrix.js

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/
(function (window, document) {
    "use strict";

    const MODULE_NAME = "cmatrix";
    const VERSION = "3.1.0";
    const SYMBOL = Symbol.for("speciedex.terminal.cmatrix.visualization");
    const CONTROLLER_SYMBOL = Symbol.for("speciedex.terminal.cmatrix.controller");
    const DEFAULT_FOREGROUND = "#c0d674";
    const DEFAULT_BACKGROUND = "#020a05";
    const DEFAULT_FONT_SIZE = 14;
    const DEFAULT_COLUMNS = 120;
    const DEFAULT_ROWS = 40;

    const ANSI16 = [
        "#000000", "#aa0000", "#00aa00", "#aa5500",
        "#0000aa", "#aa00aa", "#00aaaa", "#aaaaaa",
        "#555555", "#ff5555", "#55ff55", "#ffff55",
        "#5555ff", "#ff55ff", "#55ffff", "#ffffff"
    ];

    function now() { return Date.now(); }
    function iso(value = now()) { return new Date(value).toISOString(); }
    function number(value, fallback, min, max) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
    }
    function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
    function dispatch(target, type, detail = {}) {
        try { target.dispatchEvent(new CustomEvent(type, { detail: { type, timestamp: iso(), ...detail } })); }
        catch (_error) { /* observer failures are isolated */ }
    }
    function resolveCanvas(target) {
        if (target instanceof HTMLCanvasElement) return target;
        if (target instanceof Element) {
            const existing = target.querySelector("canvas");
            if (existing) return existing;
            const canvas = document.createElement("canvas");
            target.appendChild(canvas);
            return canvas;
        }
        throw new TypeError("cmatrix requires a canvas or container element.");
    }
    function resizeObserver(element, callback) {
        let frame = 0;
        const schedule = () => {
            if (frame) return;
            frame = requestAnimationFrame(() => { frame = 0; callback(); });
        };
        if (typeof ResizeObserver === "function") {
            const observer = new ResizeObserver(schedule);
            observer.observe(element);
            return () => { observer.disconnect(); if (frame) cancelAnimationFrame(frame); };
        }
        addEventListener("resize", schedule);
        return () => { removeEventListener("resize", schedule); if (frame) cancelAnimationFrame(frame); };
    }
    function unicodeWidth(character) {
        const cp = character.codePointAt(0);
        if (cp === undefined) return 0;
        if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x1ab0 && cp <= 0x1aff) ||
            (cp >= 0x1dc0 && cp <= 0x1dff) || (cp >= 0x20d0 && cp <= 0x20ff) ||
            (cp >= 0xfe20 && cp <= 0xfe2f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
        if (cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
            (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
            (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
            (cp >= 0xfe10 && cp <= 0xfe19) || (cp >= 0xfe30 && cp <= 0xfe6f) ||
            (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
            (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd))) return 2;
        return 1;
    }
    function ansi256(index) {
        index = number(index, 7, 0, 255);
        if (index < 16) return ANSI16[index];
        if (index >= 232) {
            const level = 8 + (index - 232) * 10;
            return `rgb(${level},${level},${level})`;
        }
        const value = index - 16;
        const scale = component => component === 0 ? 0 : 55 + component * 40;
        return `rgb(${scale(Math.floor(value / 36))},${scale(Math.floor((value % 36) / 6))},${scale(value % 6)})`;
    }

    class AnsiCanvasTerminal {
        constructor(canvas, options = {}) {
            this.canvas = canvas;
            this.context = canvas.getContext("2d", { alpha: false, desynchronized: true });
            if (!this.context) throw new Error("Unable to acquire cmatrix canvas context.");
            this.options = {
                columns: number(options.columns, DEFAULT_COLUMNS, 20, 1000),
                rows: number(options.rows, DEFAULT_ROWS, 10, 500),
                fontSize: number(options.fontSize, DEFAULT_FONT_SIZE, 8, 48),
                lineHeight: number(options.lineHeight, 1.1, 1, 2),
                fontFamily: options.fontFamily || '"IBM Plex Mono", "Cascadia Mono", Consolas, monospace',
                foreground: options.foreground || DEFAULT_FOREGROUND,
                background: options.background || DEFAULT_BACKGROUND,
                cursorVisible: options.cursorVisible !== false
            };
            this.destroyed = false;
            this.frame = 0;
            this.parser = "";
            this.mode = { origin: false, wrap: true, alternate: false };
            this.scrollTop = 0;
            this.scrollBottom = this.options.rows - 1;
            this.cursor = { row: 0, column: 0, visible: true, pendingWrap: false };
            this.savedCursor = { row: 0, column: 0 };
            this.style = this._defaultStyle();
            this.primary = this._createBuffer();
            this.alternate = this._createBuffer();
            this.cells = this.primary;
            this.lastDimensions = null;
            this.cleanupResize = resizeObserver(canvas, () => this.resize());
            this.resize();
        }
        _defaultStyle() {
            return { foreground: this.options.foreground, background: this.options.background, bold: false, faint: false, inverse: false };
        }
        _blankCell() { return { character: " ", width: 1, continuation: false, ...this._defaultStyle() }; }
        _blankRow() { return Array.from({ length: this.options.columns }, () => this._blankCell()); }
        _createBuffer() { return Array.from({ length: this.options.rows }, () => this._blankRow()); }
        reset(render = true) {
            this.primary = this._createBuffer();
            this.alternate = this._createBuffer();
            this.cells = this.primary;
            this.mode = { origin: false, wrap: true, alternate: false };
            this.scrollTop = 0;
            this.scrollBottom = this.options.rows - 1;
            this.cursor = { row: 0, column: 0, visible: true, pendingWrap: false };
            this.savedCursor = { row: 0, column: 0 };
            this.style = this._defaultStyle();
            if (render) this.scheduleRender();
        }
        resize() {
            if (this.destroyed) return null;
            const rect = this.canvas.getBoundingClientRect();
            const ratio = Math.min(devicePixelRatio || 1, 2);
            const pixelWidth = Math.max(1, Math.floor(rect.width * ratio));
            const pixelHeight = Math.max(1, Math.floor(rect.height * ratio));
            if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
                this.canvas.width = pixelWidth;
                this.canvas.height = pixelHeight;
            }
            this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
            const columns = Math.max(20, Math.floor(Math.max(1, rect.width) / (this.options.fontSize * 0.62)));
            const rows = Math.max(10, Math.floor(Math.max(1, rect.height) / (this.options.fontSize * this.options.lineHeight)));
            const changed = !this.lastDimensions || this.lastDimensions.columns !== columns || this.lastDimensions.rows !== rows;
            if (changed) {
                this.setDimensions(columns, rows, false);
                this.lastDimensions = { columns, rows };
                dispatch(this.canvas, "cmatrix:dimensions", this.lastDimensions);
            }
            this.scheduleRender();
            return { columns: this.options.columns, rows: this.options.rows };
        }
        setDimensions(columns, rows, render = true) {
            columns = Math.floor(number(columns, this.options.columns, 20, 1000));
            rows = Math.floor(number(rows, this.options.rows, 10, 500));
            const resizeBuffer = buffer => {
                const next = Array.from({ length: rows }, () => Array.from({ length: columns }, () => this._blankCell()));
                for (let row = 0; row < Math.min(rows, buffer.length); row += 1) {
                    for (let column = 0; column < Math.min(columns, buffer[row]?.length || 0); column += 1) next[row][column] = buffer[row][column];
                }
                return next;
            };
            this.primary = resizeBuffer(this.primary || []);
            this.alternate = resizeBuffer(this.alternate || []);
            this.options.columns = columns;
            this.options.rows = rows;
            this.cells = this.mode.alternate ? this.alternate : this.primary;
            this.scrollTop = Math.min(this.scrollTop, rows - 1);
            this.scrollBottom = Math.max(this.scrollTop, Math.min(this.scrollBottom, rows - 1));
            this.cursor.row = Math.min(this.cursor.row, rows - 1);
            this.cursor.column = Math.min(this.cursor.column, columns - 1);
            if (render) this.scheduleRender();
        }
        _regionScrollUp(count = 1) {
            count = Math.max(1, count);
            while (count-- > 0) {
                this.cells.splice(this.scrollTop, 1);
                this.cells.splice(this.scrollBottom, 0, this._blankRow());
            }
        }
        _regionScrollDown(count = 1) {
            count = Math.max(1, count);
            while (count-- > 0) {
                this.cells.splice(this.scrollBottom, 1);
                this.cells.splice(this.scrollTop, 0, this._blankRow());
            }
        }
        _lineFeed() {
            this.cursor.pendingWrap = false;
            if (this.cursor.row === this.scrollBottom) this._regionScrollUp(1);
            else this.cursor.row = Math.min(this.options.rows - 1, this.cursor.row + 1);
        }
        _reverseIndex() {
            if (this.cursor.row === this.scrollTop) this._regionScrollDown(1);
            else this.cursor.row = Math.max(0, this.cursor.row - 1);
        }
        _put(character) {
            if (character === "\n") { this._lineFeed(); return; }
            if (character === "\r") { this.cursor.column = 0; this.cursor.pendingWrap = false; return; }
            if (character === "\b") { this.cursor.column = Math.max(0, this.cursor.column - 1); this.cursor.pendingWrap = false; return; }
            if (character === "\t") { this.cursor.column = Math.min(this.options.columns - 1, (Math.floor(this.cursor.column / 8) + 1) * 8); return; }
            if (character.codePointAt(0) < 0x20 || character === "\u007f") return;

            const width = unicodeWidth(character);
            if (width === 0) {
                const column = Math.max(0, this.cursor.column - 1);
                const cell = this.cells[this.cursor.row][column];
                if (cell && !cell.continuation) cell.character += character;
                return;
            }
            if (this.cursor.pendingWrap) {
                if (this.mode.wrap) { this.cursor.column = 0; this._lineFeed(); }
                else this.cursor.pendingWrap = false;
            }
            if (width === 2 && this.cursor.column === this.options.columns - 1) {
                if (this.mode.wrap) { this.cursor.column = 0; this._lineFeed(); }
                else return;
            }
            let foreground = this.style.foreground;
            let background = this.style.background;
            if (this.style.inverse) [foreground, background] = [background, foreground];
            this.cells[this.cursor.row][this.cursor.column] = {
                character, width, continuation: false, foreground, background,
                bold: this.style.bold, faint: this.style.faint, inverse: this.style.inverse
            };
            if (width === 2 && this.cursor.column + 1 < this.options.columns) {
                this.cells[this.cursor.row][this.cursor.column + 1] = { ...this._blankCell(), width: 0, continuation: true };
            }
            const next = this.cursor.column + width;
            if (next >= this.options.columns) {
                this.cursor.column = this.options.columns - 1;
                this.cursor.pendingWrap = true;
            } else this.cursor.column = next;
        }
        _eraseDisplay(mode) {
            if (mode === 2 || mode === 3) {
                for (let row = 0; row < this.options.rows; row += 1) this.cells[row] = this._blankRow();
                return;
            }
            if (mode === 1) {
                for (let row = 0; row < this.cursor.row; row += 1) this.cells[row] = this._blankRow();
                for (let col = 0; col <= this.cursor.column; col += 1) this.cells[this.cursor.row][col] = this._blankCell();
                return;
            }
            for (let col = this.cursor.column; col < this.options.columns; col += 1) this.cells[this.cursor.row][col] = this._blankCell();
            for (let row = this.cursor.row + 1; row < this.options.rows; row += 1) this.cells[row] = this._blankRow();
        }
        _eraseLine(mode) {
            if (mode === 2) { this.cells[this.cursor.row] = this._blankRow(); return; }
            const start = mode === 1 ? 0 : this.cursor.column;
            const end = mode === 1 ? this.cursor.column : this.options.columns - 1;
            for (let col = start; col <= end; col += 1) this.cells[this.cursor.row][col] = this._blankCell();
        }
        _sgr(values) {
            if (!values.length) values = [0];
            for (let index = 0; index < values.length; index += 1) {
                const value = Number.isFinite(values[index]) ? values[index] : 0;
                if (value === 0) this.style = this._defaultStyle();
                else if (value === 1) this.style.bold = true;
                else if (value === 2) this.style.faint = true;
                else if (value === 7) this.style.inverse = true;
                else if (value === 22) { this.style.bold = false; this.style.faint = false; }
                else if (value === 27) this.style.inverse = false;
                else if (value === 39) this.style.foreground = this.options.foreground;
                else if (value === 49) this.style.background = this.options.background;
                else if (value >= 30 && value <= 37) this.style.foreground = ANSI16[value - 30];
                else if (value >= 90 && value <= 97) this.style.foreground = ANSI16[value - 90 + 8];
                else if (value >= 40 && value <= 47) this.style.background = ANSI16[value - 40];
                else if (value >= 100 && value <= 107) this.style.background = ANSI16[value - 100 + 8];
                else if ((value === 38 || value === 48) && values[index + 1] === 5) {
                    const color = ansi256(values[index + 2]);
                    if (value === 38) this.style.foreground = color; else this.style.background = color;
                    index += 2;
                } else if ((value === 38 || value === 48) && values[index + 1] === 2) {
                    const color = `rgb(${number(values[index + 2], 0, 0, 255)},${number(values[index + 3], 0, 0, 255)},${number(values[index + 4], 0, 0, 255)})`;
                    if (value === 38) this.style.foreground = color; else this.style.background = color;
                    index += 4;
                }
            }
        }
        _setPrivateMode(parameters, enabled) {
            for (const code of parameters.replace(/^\?/, "").split(";").map(Number)) {
                if (code === 6) this.mode.origin = enabled;
                else if (code === 7) this.mode.wrap = enabled;
                else if (code === 25) this.cursor.visible = enabled;
                else if ([47, 1047, 1049].includes(code)) {
                    if (enabled && !this.mode.alternate) {
                        this.savedCursor = { row: this.cursor.row, column: this.cursor.column };
                        this.mode.alternate = true;
                        this.alternate = this._createBuffer();
                        this.cells = this.alternate;
                        this.cursor.row = 0;
                        this.cursor.column = 0;
                    } else if (!enabled && this.mode.alternate) {
                        this.mode.alternate = false;
                        this.cells = this.primary;
                        this.cursor = { ...this.cursor, ...this.savedCursor, pendingWrap: false };
                    }
                }
            }
        }
        _csi(parameters, command) {
            const privateMode = parameters.startsWith("?");
            const clean = privateMode ? parameters.slice(1) : parameters;
            const values = clean === "" ? [0] : clean.split(";").map(value => value === "" ? 0 : Number(value));
            const first = values[0] || 0;
            const top = this.mode.origin ? this.scrollTop : 0;
            const bottom = this.mode.origin ? this.scrollBottom : this.options.rows - 1;
            switch (command) {
                case "A": this.cursor.row = Math.max(top, this.cursor.row - (first || 1)); break;
                case "B": this.cursor.row = Math.min(bottom, this.cursor.row + (first || 1)); break;
                case "C": this.cursor.column = Math.min(this.options.columns - 1, this.cursor.column + (first || 1)); break;
                case "D": this.cursor.column = Math.max(0, this.cursor.column - (first || 1)); break;
                case "E": this.cursor.row = Math.min(bottom, this.cursor.row + (first || 1)); this.cursor.column = 0; break;
                case "F": this.cursor.row = Math.max(top, this.cursor.row - (first || 1)); this.cursor.column = 0; break;
                case "G": this.cursor.column = Math.min(this.options.columns - 1, Math.max(0, (first || 1) - 1)); break;
                case "H": case "f":
                    this.cursor.row = Math.min(bottom, Math.max(top, top + (values[0] || 1) - 1));
                    this.cursor.column = Math.min(this.options.columns - 1, Math.max(0, (values[1] || 1) - 1));
                    break;
                case "J": this._eraseDisplay(first); break;
                case "K": this._eraseLine(first); break;
                case "m": this._sgr(values); break;
                case "s": this.savedCursor = { row: this.cursor.row, column: this.cursor.column }; break;
                case "u": this.cursor.row = this.savedCursor.row; this.cursor.column = this.savedCursor.column; break;
                case "r": {
                    const start = Math.max(0, (values[0] || 1) - 1);
                    const end = Math.min(this.options.rows - 1, (values[1] || this.options.rows) - 1);
                    if (start < end) { this.scrollTop = start; this.scrollBottom = end; this.cursor.row = this.mode.origin ? start : 0; this.cursor.column = 0; }
                    break;
                }
                case "S": this._regionScrollUp(first || 1); break;
                case "T": this._regionScrollDown(first || 1); break;
                case "L": {
                    const count = Math.min(first || 1, this.scrollBottom - this.cursor.row + 1);
                    for (let index = 0; index < count; index += 1) { this.cells.splice(this.cursor.row, 0, this._blankRow()); this.cells.splice(this.scrollBottom + 1, 1); }
                    break;
                }
                case "M": {
                    const count = Math.min(first || 1, this.scrollBottom - this.cursor.row + 1);
                    for (let index = 0; index < count; index += 1) { this.cells.splice(this.cursor.row, 1); this.cells.splice(this.scrollBottom, 0, this._blankRow()); }
                    break;
                }
                case "P": {
                    const count = Math.min(first || 1, this.options.columns - this.cursor.column);
                    const row = this.cells[this.cursor.row];
                    row.splice(this.cursor.column, count);
                    row.push(...Array.from({ length: count }, () => this._blankCell()));
                    break;
                }
                case "@": {
                    const count = Math.min(first || 1, this.options.columns - this.cursor.column);
                    const row = this.cells[this.cursor.row];
                    row.splice(this.cursor.column, 0, ...Array.from({ length: count }, () => this._blankCell()));
                    row.length = this.options.columns;
                    break;
                }
                case "X": {
                    const count = Math.min(first || 1, this.options.columns - this.cursor.column);
                    for (let col = this.cursor.column; col < this.cursor.column + count; col += 1) this.cells[this.cursor.row][col] = this._blankCell();
                    break;
                }
                case "h": if (privateMode) this._setPrivateMode(parameters, true); break;
                case "l": if (privateMode) this._setPrivateMode(parameters, false); break;
                default: break;
            }
            this.cursor.pendingWrap = false;
        }
        write(data) {
            if (this.destroyed || data === null || data === undefined) return;
            const text = this.parser + String(data);
            this.parser = "";
            for (let index = 0; index < text.length;) {
                const cp = text.codePointAt(index);
                const character = String.fromCodePoint(cp);
                if (character !== "\u001b") { this._put(character); index += character.length; continue; }
                if (index + 1 >= text.length) { this.parser = text.slice(index); break; }
                const next = text[index + 1];
                if (next === "[") {
                    let end = index + 2;
                    while (end < text.length && !/[\x40-\x7e]/.test(text[end])) end += 1;
                    if (end >= text.length) { this.parser = text.slice(index); break; }
                    this._csi(text.slice(index + 2, end), text[end]);
                    index = end + 1;
                } else if (next === "7") { this.savedCursor = { row: this.cursor.row, column: this.cursor.column }; index += 2; }
                else if (next === "8") { this.cursor.row = this.savedCursor.row; this.cursor.column = this.savedCursor.column; index += 2; }
                else if (next === "D") { this._lineFeed(); index += 2; }
                else if (next === "M") { this._reverseIndex(); index += 2; }
                else if (next === "E") { this.cursor.column = 0; this._lineFeed(); index += 2; }
                else if (next === "c") { this.reset(false); index += 2; }
                else { index += 2; }
            }
            this.scheduleRender();
        }
        scheduleRender() {
            if (this.destroyed || this.frame) return;
            this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(); });
        }
        render() {
            if (this.destroyed) return;
            const rect = this.canvas.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return;
            const width = rect.width;
            const height = rect.height;
            const cellWidth = width / this.options.columns;
            const cellHeight = height / this.options.rows;
            const fontSize = Math.min(this.options.fontSize, cellHeight / this.options.lineHeight);
            const normalFont = `400 ${fontSize}px ${this.options.fontFamily}`;
            const boldFont = `700 ${fontSize}px ${this.options.fontFamily}`;
            const context = this.context;
            context.globalAlpha = 1;
            context.fillStyle = this.options.background;
            context.fillRect(0, 0, width, height);
            context.textBaseline = "top";
            let currentFont = "";
            for (let row = 0; row < this.options.rows; row += 1) {
                for (let col = 0; col < this.options.columns; col += 1) {
                    const cell = this.cells[row][col];
                    if (!cell || cell.continuation) continue;
                    if (cell.background !== this.options.background) {
                        context.globalAlpha = 1;
                        context.fillStyle = cell.background;
                        context.fillRect(col * cellWidth, row * cellHeight, cellWidth * (cell.width || 1) + 1, cellHeight + 1);
                    }
                    if (cell.character !== " ") {
                        const font = cell.bold ? boldFont : normalFont;
                        if (font !== currentFont) { context.font = font; currentFont = font; }
                        context.globalAlpha = cell.faint ? 0.5 : 1;
                        context.fillStyle = cell.foreground;
                        context.fillText(cell.character, col * cellWidth, row * cellHeight);
                    }
                }
            }
            context.globalAlpha = 1;
            if (this.options.cursorVisible && this.cursor.visible) {
                context.fillStyle = this.options.foreground;
                context.globalAlpha = 0.35;
                context.fillRect(this.cursor.column * cellWidth, this.cursor.row * cellHeight, cellWidth, cellHeight);
                context.globalAlpha = 1;
            }
        }
        configure(options = {}) {
            if (options.fontSize !== undefined) this.options.fontSize = number(options.fontSize, this.options.fontSize, 8, 48);
            if (options.lineHeight !== undefined) this.options.lineHeight = number(options.lineHeight, this.options.lineHeight, 1, 2);
            if (options.fontFamily) this.options.fontFamily = options.fontFamily;
            if (options.foreground) this.options.foreground = options.foreground;
            if (options.background) this.options.background = options.background;
            if (options.cursorVisible !== undefined) this.options.cursorVisible = Boolean(options.cursorVisible);
            if (options.columns !== undefined || options.rows !== undefined) this.setDimensions(options.columns || this.options.columns, options.rows || this.options.rows);
            else this.resize();
        }
        destroy() {
            if (this.destroyed) return false;
            this.destroyed = true;
            this.cleanupResize?.();
            if (this.frame) cancelAnimationFrame(this.frame);
            this.cells = [];
            return true;
        }
    }

    class CmatrixController extends EventTarget {
        constructor(target, options = {}) {
            super();
            const Client = window.SpeciedexTerminalCmatrixClient?.CmatrixClient;
            if (!Client) throw new Error("cmatrix.js must load before terminal-cmatrix.js.");
            this.canvas = resolveCanvas(target);
            this.context = options.context || null;
            this.options = {
                endpoint: options.endpoint || options.socketURL || "/api/terminal/cmatrix",
                args: Array.isArray(options.args) ? [...options.args] : [],
                autoStart: options.autoStart !== false,
                autoReconnect: options.autoReconnect !== false,
                keyboard: options.keyboard !== false,
                columns: number(options.columns, DEFAULT_COLUMNS, 20, 1000),
                rows: number(options.rows, DEFAULT_ROWS, 10, 500),
                fontSize: number(options.fontSize, DEFAULT_FONT_SIZE, 8, 48),
                fontFamily: options.fontFamily,
                lineHeight: number(options.lineHeight, 1.1, 1, 2),
                foreground: options.foreground || DEFAULT_FOREGROUND,
                background: options.background || DEFAULT_BACKGROUND,
                cursorVisible: options.cursorVisible !== false,
                reconnectDelay: options.reconnectDelay,
                maxReconnectDelay: options.maxReconnectDelay,
                heartbeat: options.heartbeat,
                heartbeatTimeout: options.heartbeatTimeout,
                connectTimeout: options.connectTimeout
            };
            this.terminal = new AnsiCanvasTerminal(this.canvas, this.options);
            this.client = new Client({ ...this.options, columns: this.terminal.options.columns, rows: this.terminal.options.rows });
            this.running = false;
            this.destroyed = false;
            this.startedAt = null;
            this.lastError = null;
            this.disposers = [];
            this.metrics = { starts: 0, stops: 0, restarts: 0, resizes: 0, keys: 0, bytes: 0, errors: 0 };
            this._keydown = event => this._handleKeydown(event);
            this._dimensions = event => this._handleDimensions(event.detail);
            this.canvas.addEventListener("cmatrix:dimensions", this._dimensions);
            if (this.options.keyboard) {
                if (this.canvas.tabIndex < 0) this.canvas.tabIndex = 0;
                this.canvas.setAttribute("aria-label", "Interactive cmatrix terminal visualization");
                this.canvas.addEventListener("keydown", this._keydown);
            }
            this._bindClient();
            this.canvas[CONTROLLER_SYMBOL] = this;
            this.canvas.cmatrixController = this;
            if (this.context) this.context.cmatrixController = this;
            if (this.options.autoStart) this.start();
        }
        _bindClient() {
            const bind = (name, handler) => {
                this.client.addEventListener(name, handler);
                this.disposers.push(() => this.client.removeEventListener(name, handler));
            };
            bind("data", event => {
                const data = String(event.detail?.data || "");
                this.metrics.bytes += new TextEncoder().encode(data).byteLength;
                this.terminal.write(data);
            });
            bind("open", event => { this.running = true; this.startedAt ||= iso(); dispatch(this, "runtime:open", event.detail); });
            bind("close", event => { this.running = false; dispatch(this, "runtime:close", event.detail); });
            bind("ready", event => dispatch(this, "runtime:ready", event.detail));
            bind("started", event => dispatch(this, "runtime:started", event.detail));
            bind("exit", event => { this.running = false; dispatch(this, "runtime:exit", event.detail); });
            bind("reconnect", event => dispatch(this, "runtime:reconnect", event.detail));
            bind("error", event => {
                this.lastError = new Error(event.detail?.error || "cmatrix runtime error.");
                this.metrics.errors += 1;
                dispatch(this, "error", { error: this.lastError.message });
            });
            bind("state", event => dispatch(this, "runtime:state", event.detail));
        }
        _handleDimensions(dimensions) {
            if (!dimensions || this.destroyed) return;
            this.options.columns = dimensions.columns;
            this.options.rows = dimensions.rows;
            this.client.resize(dimensions.columns, dimensions.rows);
            this.metrics.resizes += 1;
            dispatch(this, "resize", dimensions);
        }
        _handleKeydown(event) {
            const special = {
                ArrowUp: "\u001b[A", ArrowDown: "\u001b[B", ArrowRight: "\u001b[C", ArrowLeft: "\u001b[D",
                Home: "\u001b[H", End: "\u001b[F", PageUp: "\u001b[5~", PageDown: "\u001b[6~",
                Insert: "\u001b[2~", Delete: "\u001b[3~", Escape: "\u001b", Enter: "\r", Backspace: "\u007f", Tab: "\t"
            };
            let data = special[event.key];
            if (!data && event.ctrlKey && event.key.length === 1) {
                const code = event.key.toUpperCase().charCodeAt(0);
                if (code >= 64 && code <= 95) data = String.fromCharCode(code - 64);
            }
            if (!data && !event.metaKey && !event.altKey && event.key.length === 1) data = event.key;
            if (!data) return;
            event.preventDefault();
            this.sendKey(data);
        }
        start() {
            if (this.destroyed) throw new Error("cmatrix controller has been destroyed.");
            if (this.client.status().connected || this.client.status().connecting) return this;
            this.client.connect();
            this.metrics.starts += 1;
            dispatch(this, "start", { args: [...this.options.args] });
            return this;
        }
        stop() {
            if (this.destroyed) return this;
            this.client.disconnect(1000, "cmatrix stopped");
            this.running = false;
            this.metrics.stops += 1;
            dispatch(this, "stop", {});
            return this;
        }
        restart() {
            if (this.destroyed) throw new Error("cmatrix controller has been destroyed.");
            this.client.restart();
            this.metrics.restarts += 1;
            dispatch(this, "restart", { args: [...this.options.args] });
            return this;
        }
        clear() { this.terminal.reset(); dispatch(this, "clear", {}); return this; }
        update(options = {}) {
            if (!object(options)) throw new TypeError("cmatrix configuration must be an object.");
            if (options.args !== undefined) this.options.args = Array.isArray(options.args) ? [...options.args] : [];
            if (options.endpoint !== undefined || options.socketURL !== undefined) this.options.endpoint = options.endpoint || options.socketURL;
            for (const key of ["foreground", "background", "fontFamily", "cursorVisible", "autoReconnect", "keyboard"]) {
                if (options[key] !== undefined) this.options[key] = options[key];
            }
            this.terminal.configure(options);
            this.client.configure({ ...options, endpoint: this.options.endpoint, args: this.options.args });
            dispatch(this, "update", { options: { ...this.options, args: [...this.options.args] } });
            return this;
        }
        setArgs(args = [], restart = false) {
            this.options.args = Array.isArray(args) ? [...args] : [];
            this.client.configure({ args: this.options.args });
            if (restart) this.restart();
            return [...this.options.args];
        }
        sendKey(key) { const sent = this.client.input(String(key)); if (sent) this.metrics.keys += 1; return sent; }
        status() {
            return {
                name: "cmatrix", module: MODULE_NAME, version: VERSION, running: this.running,
                startedAt: this.startedAt, endpoint: this.options.endpoint, args: [...this.options.args],
                dimensions: { columns: this.terminal.options.columns, rows: this.terminal.options.rows },
                runtime: this.client.status(), metrics: { ...this.metrics },
                lastError: this.lastError ? { name: this.lastError.name, message: this.lastError.message } : null,
                destroyed: this.destroyed,
                upstream: "https://github.com/abishekvashok/cmatrix"
            };
        }
        destroy() {
            if (this.destroyed) return false;
            this.destroyed = true;
            this.canvas.removeEventListener("keydown", this._keydown);
            this.canvas.removeEventListener("cmatrix:dimensions", this._dimensions);
            for (const dispose of this.disposers.splice(0)) { try { dispose(); } catch (_error) { /* noop */ } }
            this.client.destroy();
            this.terminal.destroy();
            if (this.canvas[CONTROLLER_SYMBOL] === this) delete this.canvas[CONTROLLER_SYMBOL];
            if (this.canvas.cmatrixController === this) delete this.canvas.cmatrixController;
            if (this.context?.cmatrixController === this) delete this.context.cmatrixController;
            dispatch(this, "destroy", {});
            return true;
        }
    }

    function mount(target, options = {}) { return new CmatrixController(target, options); }
    function render(_data, options = {}) {
        const container = document.createElement("section");
        container.className = "terminal-visualization terminal-visualization-cmatrix";
        container.dataset.visualization = "cmatrix";
        const canvas = document.createElement("canvas");
        canvas.className = "terminal-cmatrix-canvas";
        const status = document.createElement("div");
        status.className = "terminal-cmatrix-status";
        status.setAttribute("aria-live", "polite");
        container.append(canvas, status);
        const controller = mount(canvas, options);
        const refresh = () => {
            const snapshot = controller.status();
            status.textContent = snapshot.lastError
                ? `cmatrix error: ${snapshot.lastError.message}`
                : snapshot.runtime.connecting ? "cmatrix connecting"
                    : snapshot.running ? "cmatrix running" : "cmatrix stopped";
        };
        for (const eventName of ["start", "stop", "error", "runtime:open", "runtime:close", "runtime:state"]) controller.addEventListener(eventName, refresh);
        refresh();
        container.controller = controller;
        container.cmatrixController = controller;
        container[CONTROLLER_SYMBOL] = controller;
        container.update = options => controller.update(options);
        container.status = () => controller.status();
        container.destroy = () => controller.destroy();
        return container;
    }
    function initialize(context = {}) {
        const root = context.root || document;
        const existing = context.cmatrix || root[SYMBOL];
        if (existing?.Controller === CmatrixController) return existing;
        const dataset = context.root?.dataset || {};
        const config = context.config?.cmatrix || {};
        const defaults = {
            context,
            endpoint: dataset.terminalCmatrixSocket || config.endpoint || config.socketURL || "/api/terminal/cmatrix",
            args: Array.isArray(config.args) ? [...config.args] : [],
            autoReconnect: dataset.terminalCmatrixReconnect !== "false" && config.autoReconnect !== false,
            foreground: dataset.terminalCmatrixForeground || config.foreground || DEFAULT_FOREGROUND,
            background: dataset.terminalCmatrixBackground || config.background || DEFAULT_BACKGROUND
        };
        const controllers = new Set();
        const visualization = {
            name: "cmatrix", version: VERSION,
            mount(target, options = {}) {
                const controller = mount(target, { ...defaults, ...options, context });
                controllers.add(controller);
                controller.addEventListener("destroy", () => controllers.delete(controller), { once: true });
                return controller;
            },
            render(data, options = {}) {
                const element = render(data, { ...defaults, ...options, context });
                controllers.add(element.controller);
                element.controller.addEventListener("destroy", () => controllers.delete(element.controller), { once: true });
                return element;
            },
            activeController() {
                return context.cmatrixController || context.terminalSplash?.cmatrixController || context.terminalSplash?.matrixController || Array.from(controllers).at(-1) || null;
            },
            status() { return { name: "cmatrix", version: VERSION, controllers: controllers.size, active: this.activeController()?.status() || null }; },
            destroy() {
                for (const controller of Array.from(controllers)) controller.destroy();
                controllers.clear();
                if (root[SYMBOL] === visualization) delete root[SYMBOL];
                if (context.cmatrix === visualization) delete context.cmatrix;
                return true;
            },
            Controller: CmatrixController,
            AnsiCanvasTerminal,
            upstream: "https://github.com/abishekvashok/cmatrix"
        };
        root[SYMBOL] = visualization;
        context.cmatrix = visualization;
        context.registerVisualization?.("cmatrix", visualization);
        context.registerRenderer?.("cmatrix", visualization);
        dispatch(document, "speciedex:terminal-cmatrix-ready", { visualization, version: VERSION });
        return visualization;
    }

    const commands = [{
        name: "cmatrix",
        category: "visualization",
        description: "Control the native upstream cmatrix PTY visualization.",
        usage: "cmatrix [status|start|stop|restart|clear|args|key|config]",
        handler: async ({ args = [], context, writeJSON, write, writeError }) => {
            const action = String(args[0] || "status").toLowerCase();
            const visualization = context.cmatrix || initialize(context);
            const controller = context.terminalSplash?.cmatrixController || context.terminalSplash?.matrixController || context.cmatrixController || visualization.activeController();
            if (!controller) throw new Error("No mounted cmatrix controller is available.");
            try {
                if (["status", "show", "info"].includes(action)) return writeJSON ? writeJSON(controller.status()) : controller.status();
                if (action === "start") { controller.start(); return write ? write("cmatrix started.", "success") : controller.status(); }
                if (action === "stop") { controller.stop(); return write ? write("cmatrix stopped.", "success") : controller.status(); }
                if (action === "restart") { controller.restart(); return write ? write("cmatrix restarted.", "success") : controller.status(); }
                if (action === "clear") { controller.clear(); return write ? write("cmatrix terminal cleared.", "success") : controller.status(); }
                if (action === "args") {
                    const output = args.length === 1 ? { args: controller.options.args } : { args: controller.setArgs(args.slice(1), false) };
                    return writeJSON ? writeJSON(output) : output;
                }
                if (action === "key") {
                    if (!args[1]) throw new Error("Usage: cmatrix key <character-or-sequence>");
                    controller.sendKey(args.slice(1).join(" "));
                    return write ? write("Input sent to cmatrix.", "success") : true;
                }
                if (action === "config") return writeJSON ? writeJSON(controller.status()) : controller.status();
                throw new Error(`Unknown cmatrix action "${action}".`);
            } catch (error) {
                if (writeError) { writeError(error.message); return null; }
                throw error;
            }
        }
    }];

    const api = Object.freeze({
        name: MODULE_NAME, version: VERSION, SYMBOL, CONTROLLER_SYMBOL,
        CmatrixController, AnsiCanvasTerminal, mount, render, initialize,
        init: initialize, setup: initialize, commands,
        upstream: "https://github.com/abishekvashok/cmatrix"
    });
    window.SpeciedexTerminalCmatrix = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;
    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", { detail: { name: MODULE_NAME, module: api } }));
})(window, document);
