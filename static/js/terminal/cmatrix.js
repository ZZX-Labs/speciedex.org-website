/*
========================================================================
Speciedex.org
cmatrix transport client
========================================================================

Browser transport for the native upstream cmatrix PTY service.
Upstream: https://github.com/abishekvashok/cmatrix

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/
(function (window, document) {
    "use strict";

    const MODULE_NAME = "cmatrix-client";
    const VERSION = "1.1.0";
    const PROTOCOL_VERSION = "speciedex-cmatrix-pty-v1";
    const DEFAULT_ENDPOINT = "/api/terminal/cmatrix";
    const DEFAULT_RECONNECT_DELAY = 1000;
    const DEFAULT_MAX_RECONNECT_DELAY = 30000;
    const DEFAULT_HEARTBEAT = 15000;
    const DEFAULT_HEARTBEAT_TIMEOUT = 45000;
    const DEFAULT_CONNECT_TIMEOUT = 15000;

    function now() { return Date.now(); }
    function iso(value = now()) { return new Date(value).toISOString(); }
    function clampNumber(value, fallback, minimum, maximum) {
        const number = Number(value);
        return Number.isFinite(number)
            ? Math.min(maximum, Math.max(minimum, number))
            : fallback;
    }
    function dispatch(target, type, detail = {}) {
        try {
            target.dispatchEvent(new CustomEvent(type, {
                detail: { type, timestamp: iso(), ...detail }
            }));
        } catch (_error) {
            /* Transport observers must never break the socket. */
        }
    }
    function websocketURL(value) {
        const url = new URL(value || DEFAULT_ENDPOINT, document.baseURI);
        if (url.protocol === "http:") url.protocol = "ws:";
        if (url.protocol === "https:") url.protocol = "wss:";
        if (url.protocol !== "ws:" && url.protocol !== "wss:") {
            throw new TypeError(`cmatrix endpoint must use ws or wss: ${url.href}`);
        }
        return url.href;
    }
    function sameArray(left, right) {
        return Array.isArray(left) && Array.isArray(right) &&
            left.length === right.length && left.every((value, index) => value === right[index]);
    }

    class CmatrixClient extends EventTarget {
        constructor(options = {}) {
            super();
            this.options = {
                endpoint: options.endpoint || options.socketURL || DEFAULT_ENDPOINT,
                args: Array.isArray(options.args) ? [...options.args] : [],
                columns: clampNumber(options.columns, 120, 20, 1000),
                rows: clampNumber(options.rows, 40, 10, 500),
                autoReconnect: options.autoReconnect !== false,
                reconnectDelay: clampNumber(options.reconnectDelay, DEFAULT_RECONNECT_DELAY, 100, 60000),
                maxReconnectDelay: clampNumber(options.maxReconnectDelay, DEFAULT_MAX_RECONNECT_DELAY, 1000, 300000),
                heartbeat: clampNumber(options.heartbeat, DEFAULT_HEARTBEAT, 1000, 120000),
                heartbeatTimeout: clampNumber(options.heartbeatTimeout, DEFAULT_HEARTBEAT_TIMEOUT, 3000, 300000),
                connectTimeout: clampNumber(options.connectTimeout, DEFAULT_CONNECT_TIMEOUT, 1000, 120000),
                protocols: Array.isArray(options.protocols) ? [...options.protocols] : undefined
            };
            this.socket = null;
            this.decoder = new TextDecoder("utf-8", { fatal: false });
            this.destroyed = false;
            this.manualClose = false;
            this.generation = 0;
            this.reconnectAttempts = 0;
            this.reconnectTimer = 0;
            this.heartbeatTimer = 0;
            this.connectTimer = 0;
            this.connectedAt = null;
            this.lastMessageAt = null;
            this.lastPongAt = null;
            this.lastError = null;
            this.state = "idle";
            this.sessionId = null;
            this.serverStatus = null;
            this.bytesReceived = 0;
            this.framesReceived = 0;
            this.bytesSent = 0;
            this.framesSent = 0;
        }

        _url() {
            const url = new URL(websocketURL(this.options.endpoint));
            url.searchParams.set("columns", String(this.options.columns));
            url.searchParams.set("rows", String(this.options.rows));
            if (this.options.args.length) {
                url.searchParams.set("args", JSON.stringify(this.options.args));
            }
            return url.href;
        }

        _setState(state, detail = {}) {
            if (this.state === state && !Object.keys(detail).length) return;
            this.state = state;
            dispatch(this, "state", { state, ...detail });
        }

        connect() {
            if (this.destroyed) throw new Error("cmatrix client has been destroyed.");
            if (this.socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(this.socket.readyState)) {
                return false;
            }

            this.manualClose = false;
            this._clearReconnect();
            const generation = ++this.generation;
            let socket;

            try {
                socket = this.options.protocols
                    ? new WebSocket(this._url(), this.options.protocols)
                    : new WebSocket(this._url());
            } catch (error) {
                this.lastError = error instanceof Error ? error : new Error(String(error));
                this._setState("error", { error: this.lastError.message });
                dispatch(this, "error", { error: this.lastError.message });
                this._scheduleReconnect();
                return false;
            }

            this.socket = socket;
            this.socket.binaryType = "arraybuffer";
            this._setState("connecting");
            this.connectTimer = window.setTimeout(() => {
                if (generation === this.generation && socket.readyState === WebSocket.CONNECTING) {
                    socket.close(4000, "connect timeout");
                }
            }, this.options.connectTimeout);

            socket.addEventListener("open", () => {
                if (!this._current(socket, generation)) return;
                this._clearConnectTimer();
                this.connectedAt = iso();
                this.lastMessageAt = this.connectedAt;
                this.lastPongAt = this.connectedAt;
                this.lastError = null;
                this.reconnectAttempts = 0;
                this._setState("open", { url: socket.url });
                this.send({
                    type: "start",
                    protocol: PROTOCOL_VERSION,
                    program: "cmatrix",
                    args: this.options.args,
                    columns: this.options.columns,
                    rows: this.options.rows
                });
                this.resize(this.options.columns, this.options.rows);
                this._startHeartbeat();
                dispatch(this, "open", { url: socket.url });
            });

            socket.addEventListener("message", async (event) => {
                if (!this._current(socket, generation)) return;
                this.lastMessageAt = iso();
                this.framesReceived += 1;
                if (typeof event.data === "string") this.bytesReceived += new TextEncoder().encode(event.data).byteLength;
                else if (event.data instanceof ArrayBuffer) this.bytesReceived += event.data.byteLength;
                else if (typeof Blob !== "undefined" && event.data instanceof Blob) this.bytesReceived += event.data.size;
                try {
                    await this._handleMessage(event.data);
                } catch (error) {
                    this.lastError = error instanceof Error ? error : new Error(String(error));
                    dispatch(this, "error", { error: this.lastError.message });
                }
            });

            socket.addEventListener("error", () => {
                if (!this._current(socket, generation)) return;
                this.lastError = new Error("cmatrix WebSocket connection failed.");
                this._setState("error", { error: this.lastError.message });
                dispatch(this, "error", { error: this.lastError.message });
            });

            socket.addEventListener("close", (event) => {
                if (generation !== this.generation || socket !== this.socket) return;
                this._clearConnectTimer();
                this._stopHeartbeat();
                this.socket = null;
                this.decoder = new TextDecoder("utf-8", { fatal: false });
                this._setState("closed", {
                    code: event.code,
                    reason: event.reason,
                    clean: event.wasClean
                });
                dispatch(this, "close", {
                    code: event.code,
                    reason: event.reason,
                    clean: event.wasClean
                });
                if (!this.manualClose && !this.destroyed && this.options.autoReconnect) {
                    this._scheduleReconnect();
                }
            });
            return true;
        }

        _current(socket, generation) {
            if (this.destroyed || generation !== this.generation || socket !== this.socket) {
                try { socket.close(1000, "stale connection"); } catch (_error) { /* noop */ }
                return false;
            }
            return true;
        }

        async _handleMessage(data) {
            let text;
            if (data instanceof ArrayBuffer) {
                text = this.decoder.decode(new Uint8Array(data), { stream: true });
                if (text) dispatch(this, "data", { data: text, binary: true });
                return;
            }
            if (typeof Blob !== "undefined" && data instanceof Blob) {
                const bytes = new Uint8Array(await data.arrayBuffer());
                text = this.decoder.decode(bytes, { stream: true });
                if (text) dispatch(this, "data", { data: text, binary: true });
                return;
            }

            text = String(data);
            let message;
            try { message = JSON.parse(text); } catch (_error) {
                dispatch(this, "data", { data: text, binary: false });
                return;
            }

            switch (message.type) {
                case "data":
                    dispatch(this, "data", { data: String(message.data || ""), binary: false });
                    break;
                case "ready":
                    this.sessionId = message.sessionId || message.session_id || this.sessionId;
                    dispatch(this, "ready", message);
                    break;
                case "started":
                    dispatch(this, "started", message);
                    break;
                case "exit":
                    dispatch(this, "exit", message);
                    break;
                case "error":
                    this.lastError = new Error(message.message || "cmatrix PTY error.");
                    dispatch(this, "error", { error: this.lastError.message, remote: true });
                    break;
                case "pong":
                    this.lastPongAt = iso();
                    dispatch(this, "pong", message);
                    break;
                case "status":
                    this.serverStatus = { ...message };
                    dispatch(this, "status", message);
                    break;
                default:
                    dispatch(this, "message", { message });
                    break;
            }
        }

        send(message) {
            if (this.socket?.readyState !== WebSocket.OPEN) return false;
            const payload = typeof message === "string" ? message : JSON.stringify(message);
            this.socket.send(payload);
            this.framesSent += 1;
            this.bytesSent += new TextEncoder().encode(payload).byteLength;
            return true;
        }

        resize(columns, rows) {
            this.options.columns = clampNumber(columns, this.options.columns, 20, 1000);
            this.options.rows = clampNumber(rows, this.options.rows, 10, 500);
            return this.send({
                type: "resize",
                columns: this.options.columns,
                rows: this.options.rows
            });
        }

        input(data) { return this.send({ type: "input", data: String(data) }); }
        signal(signal = "SIGTERM") { return this.send({ type: "signal", signal }); }
        requestStatus() { return this.send({ type: "status" }); }

        configure(options = {}) {
            const previousEndpoint = this.options.endpoint;
            const previousArgs = [...this.options.args];
            if (options.endpoint !== undefined || options.socketURL !== undefined) {
                this.options.endpoint = options.endpoint || options.socketURL || DEFAULT_ENDPOINT;
            }
            if (options.args !== undefined) {
                this.options.args = Array.isArray(options.args) ? [...options.args] : [];
            }
            for (const key of ["autoReconnect", "protocols"]) {
                if (options[key] !== undefined) this.options[key] = options[key];
            }
            const numeric = {
                reconnectDelay: [100, 60000],
                maxReconnectDelay: [1000, 300000],
                heartbeat: [1000, 120000],
                heartbeatTimeout: [3000, 300000],
                connectTimeout: [1000, 120000]
            };
            for (const [key, limits] of Object.entries(numeric)) {
                if (options[key] !== undefined) {
                    this.options[key] = clampNumber(options[key], this.options[key], limits[0], limits[1]);
                }
            }
            const reconnectRequired = previousEndpoint !== this.options.endpoint ||
                !sameArray(previousArgs, this.options.args);
            if (reconnectRequired && ["open", "connecting"].includes(this.state)) this.restart();
            return this.status();
        }

        restart() {
            this.disconnect(1000, "restart");
            this.manualClose = false;
            return this.connect();
        }

        disconnect(code = 1000, reason = "cmatrix stopped") {
            this.manualClose = true;
            this.generation += 1;
            this._clearReconnect();
            this._clearConnectTimer();
            this._stopHeartbeat();
            const socket = this.socket;
            this.socket = null;
            if (socket) {
                try {
                    if (socket.readyState === WebSocket.OPEN) {
                        socket.send(JSON.stringify({ type: "signal", signal: "SIGTERM" }));
                    }
                    socket.close(code, reason);
                } catch (_error) { /* noop */ }
            }
            this._setState("closed", { code, reason, manual: true });
        }

        _scheduleReconnect() {
            if (this.destroyed || this.manualClose || !this.options.autoReconnect) return;
            this._clearReconnect();
            this.reconnectAttempts += 1;
            const delay = Math.min(
                this.options.maxReconnectDelay,
                this.options.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1)
            );
            const jittered = Math.round(delay * (0.8 + Math.random() * 0.4));
            this.reconnectTimer = window.setTimeout(() => this.connect(), jittered);
            this._setState("reconnecting", { attempt: this.reconnectAttempts, delay: jittered });
            dispatch(this, "reconnect", { attempt: this.reconnectAttempts, delay: jittered });
        }

        _startHeartbeat() {
            this._stopHeartbeat();
            this.heartbeatTimer = window.setInterval(() => {
                const lastPong = this.lastPongAt ? Date.parse(this.lastPongAt) : 0;
                if (lastPong && now() - lastPong > this.options.heartbeatTimeout) {
                    this.lastError = new Error("cmatrix heartbeat timed out.");
                    dispatch(this, "error", { error: this.lastError.message });
                    try { this.socket?.close(4001, "heartbeat timeout"); } catch (_error) { /* noop */ }
                    return;
                }
                this.send({ type: "ping", timestamp: now() });
            }, this.options.heartbeat);
        }

        _stopHeartbeat() {
            if (this.heartbeatTimer) window.clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = 0;
        }
        _clearReconnect() {
            if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
            this.reconnectTimer = 0;
        }
        _clearConnectTimer() {
            if (this.connectTimer) window.clearTimeout(this.connectTimer);
            this.connectTimer = 0;
        }

        status() {
            return {
                name: "cmatrix-client",
                version: VERSION,
                state: this.state,
                connected: this.socket?.readyState === WebSocket.OPEN,
                connecting: this.socket?.readyState === WebSocket.CONNECTING,
                endpoint: this.options.endpoint,
                args: [...this.options.args],
                dimensions: { columns: this.options.columns, rows: this.options.rows },
                connectedAt: this.connectedAt,
                lastMessageAt: this.lastMessageAt,
                lastPongAt: this.lastPongAt,
                reconnectAttempts: this.reconnectAttempts,
                lastError: this.lastError?.message || null,
                protocol: PROTOCOL_VERSION,
                sessionId: this.sessionId,
                serverStatus: this.serverStatus ? { ...this.serverStatus } : null,
                traffic: {
                    framesReceived: this.framesReceived,
                    framesSent: this.framesSent,
                    bytesReceived: this.bytesReceived,
                    bytesSent: this.bytesSent
                },
                destroyed: this.destroyed
            };
        }

        destroy() {
            if (this.destroyed) return false;
            this.destroyed = true;
            this.disconnect(1000, "destroyed");
            dispatch(this, "destroy", {});
            return true;
        }
    }

    const api = Object.freeze({
        name: MODULE_NAME,
        version: VERSION,
        protocol: PROTOCOL_VERSION,
        CmatrixClient,
        websocketURL,
        create(options) { return new CmatrixClient(options); }
    });

    window.SpeciedexTerminalCmatrixClient = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;
    document.dispatchEvent(new CustomEvent("speciedex:terminal-module-available", {
        detail: { name: MODULE_NAME, module: api }
    }));
})(window, document);
