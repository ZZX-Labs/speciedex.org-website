/*
========================================================================
Speciedex.org
Terminal Stream Module
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Stream";
    const VERSION = "2.1.0";

    const STREAM_SYMBOL =
        Symbol.for(
            "speciedex.terminal.stream.service"
        );

    const DEFAULT_BUFFER_LIMIT = 1000;
    const DEFAULT_RECONNECT_DELAY = 1000;
    const DEFAULT_MAX_RECONNECT_DELAY = 30000;
    const DEFAULT_HEARTBEAT_TIMEOUT = 45000;
    const DEFAULT_TRANSPORT = "auto";
    const DEFAULT_PUBLISH_BATCH = 50;
    const DEFAULT_PUBLISH_INTERVAL = 100;
    const DEFAULT_MAX_SUBSCRIBER_ERRORS = 25;

    function now() {
        return Date.now();
    }

    function iso(timestamp = now()) {
        return new Date(timestamp).toISOString();
    }

    function clone(
        value,
        seen =
            new WeakMap()
    ) {
        if (
            value ===
                undefined ||
            value ===
                null ||
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
            value instanceof
                RegExp
        ) {
            return new RegExp(
                value.source,
                value.flags
            );
        }

        if (
            value instanceof
                Map
        ) {
            const output =
                new Map();

            seen.set(
                value,
                output
            );

            for (
                const [
                    key,
                    item
                ] of value
            ) {
                output.set(
                    clone(
                        key,
                        seen
                    ),
                    clone(
                        item,
                        seen
                    )
                );
            }

            return output;
        }

        if (
            value instanceof
                Set
        ) {
            const output =
                new Set();

            seen.set(
                value,
                output
            );

            for (
                const item of
                value
            ) {
                output.add(
                    clone(
                        item,
                        seen
                    )
                );
            }

            return output;
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

    function isObject(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value);
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

    function parseNumber(value, fallback = 0, minimum = -Infinity, maximum = Infinity) {
        const number = Number(value);

        if (!Number.isFinite(number)) {
            return fallback;
        }

        return Math.min(maximum, Math.max(minimum, number));
    }

    function parseDuration(value, fallback = 0) {
        if (typeof value === "number" && Number.isFinite(value)) {
            return Math.max(0, value);
        }

        if (value === undefined || value === null || value === "") {
            return fallback;
        }

        const match = String(value)
            .trim()
            .toLowerCase()
            .match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/);

        if (!match) {
            return fallback;
        }

        const amount = Number(match[1]);
        const multipliers = {
            ms: 1,
            s: 1000,
            m: 60000,
            h: 3600000
        };

        return Math.round(amount * multipliers[match[2] || "ms"]);
    }

    function safeDispatch(
        target,
        name,
        detail
    ) {
        if (
            !target ||
            typeof target.dispatchEvent !==
                "function"
        ) {
            return false;
        }

        try {
            target.dispatchEvent(
                new CustomEvent(
                    name,
                    {
                        detail
                    }
                )
            );

            return true;
        } catch (_error) {
            return false;
        }
    }

    function isAbortError(
        error
    ) {
        return Boolean(
            error &&
            (
                error.name ===
                    "AbortError" ||
                error.code ===
                    20
            )
        );
    }

    function normalizeTransport(value) {
        const transport = String(value || DEFAULT_TRANSPORT).trim().toLowerCase();

        if (["auto", "sse", "eventsource", "websocket", "ws", "fetch", "ndjson"].includes(transport)) {
            if (transport === "eventsource") {
                return "sse";
            }
            if (transport === "ws") {
                return "websocket";
            }
            if (transport === "ndjson") {
                return "fetch";
            }
            return transport;
        }

        return DEFAULT_TRANSPORT;
    }

    function normalizeURL(value, base = document.baseURI) {
        if (!value) {
            return "";
        }

        try {
            return new URL(String(value), base).href;
        } catch (error) {
            throw new TypeError(`Invalid stream URL: ${value}`);
        }
    }

    function parsePayload(value) {
        if (typeof value !== "string") {
            return value;
        }

        const text = value.trim();

        if (!text) {
            return null;
        }

        try {
            return JSON.parse(text);
        } catch (error) {
            return value;
        }
    }

    function flattenArguments(args = []) {
        const parsed = {
            action: "status",
            positional: [],
            options: {}
        };

        for (const argument of args) {
            const value = String(argument);

            if (value.startsWith("--")) {
                const [key, ...rest] = value.slice(2).split("=");
                parsed.options[key] = rest.length ? rest.join("=") : true;
            } else {
                parsed.positional.push(value);
            }
        }

        if (parsed.positional.length) {
            parsed.action = parsed.positional.shift().toLowerCase();
        }

        return parsed;
    }

    class RingBuffer {
        constructor(limit = DEFAULT_BUFFER_LIMIT) {
            this.limit = Math.max(1, Number(limit) || DEFAULT_BUFFER_LIMIT);
            this.items = [];
        }

        push(value) {
            this.items.push(value);

            if (this.items.length > this.limit) {
                this.items.splice(0, this.items.length - this.limit);
            }

            return value;
        }

        clear() {
            const count = this.items.length;
            this.items.length = 0;
            return count;
        }

        toArray() {
            return this.items.map(clone);
        }

        get length() {
            return this.items.length;
        }
    }

    class StreamService extends EventTarget {
        constructor(context = {}, options = {}) {
            super();

            this.context = context;
            this.options = {
                url: normalizeURL(options.url || "", document.baseURI),
                transport: normalizeTransport(options.transport),
                autoReconnect: options.autoReconnect !== false,
                reconnectDelay: parseDuration(
                    options.reconnectDelay,
                    DEFAULT_RECONNECT_DELAY
                ),
                maxReconnectDelay: parseDuration(
                    options.maxReconnectDelay,
                    DEFAULT_MAX_RECONNECT_DELAY
                ),
                heartbeatTimeout: parseDuration(
                    options.heartbeatTimeout,
                    DEFAULT_HEARTBEAT_TIMEOUT
                ),
                bufferLimit: parseNumber(
                    options.bufferLimit,
                    DEFAULT_BUFFER_LIMIT,
                    1,
                    100000
                ),
                credentials: options.credentials || "same-origin",
                headers: isObject(options.headers) ? { ...options.headers } : {},
                protocols: Array.isArray(options.protocols)
                    ? [...options.protocols]
                    : options.protocols
                        ? [String(options.protocols)]
                        : [],
                parse:
                    options.parse !==
                    false,

                publishBatch:
                    parseNumber(
                        options.publishBatch,
                        DEFAULT_PUBLISH_BATCH,
                        1,
                        10000
                    ),

                publishInterval:
                    parseDuration(
                        options.publishInterval,
                        DEFAULT_PUBLISH_INTERVAL
                    ),

                publishLibrary:
                    options.publishLibrary !==
                    false,

                publishSplash:
                    options.publishSplash !==
                    false,

                libraryCollection:
                    String(
                        options.libraryCollection ||
                        "stream-records"
                    ),

                maxSubscriberErrors:
                    parseNumber(
                        options.maxSubscriberErrors,
                        DEFAULT_MAX_SUBSCRIBER_ERRORS,
                        1,
                        100000
                    )
            };

            this.buffer = new RingBuffer(this.options.bufferLimit);
            this.subscribers = new Set();
            this.filters = new Map();
            this.transport = null;
            this.abortController = null;
            this.lifecycleAbortController =
                new AbortController();
            this.reconnectTimer = null;
            this.heartbeatTimer = null;
            this.destroyed = false;
            this.manualClose = false;
            this.reconnectAttempts = 0;
            this.lastError = null;
            this.lastRecord = null;
            this.lastMessageAt = null;
            this.startedAt = null;
            this.connectedAt = null;
            this.disconnectedAt = null;
            this.sequence = 0;
            this.connectionGeneration = 0;
            this.connectPromise = null;
            this.emitting = false;
            this.syncingState = false;
            this.pendingPublish = [];
            this.publishTimer = null;
            this.subscriberErrors = new Map();

            this.metrics = {
                received: 0,
                accepted: 0,
                rejected: 0,
                bytes: 0,
                reconnects: 0,
                errors: 0,
                opens: 0,
                closes: 0,
                rate: 0,
                peakRate: 0,
                published: 0,
                publishBatches: 0,
                subscriberErrors: 0,
                filterErrors: 0,
                staleConnections: 0,
                reconnectSuppressed: 0
            };

            this.rateWindow = [];
            this._boundOnline = this._handleOnline.bind(this);
            this._boundOffline = this._handleOffline.bind(this);

            window.addEventListener(
                "online",
                this._boundOnline,
                {
                    signal:
                        this.lifecycleAbortController.signal
                }
            );

            window.addEventListener(
                "offline",
                this._boundOffline,
                {
                    signal:
                        this.lifecycleAbortController.signal
                }
            );

            this._syncState();
        }

        _assertActive() {
            if (this.destroyed) {
                throw new Error("Stream service has been destroyed.");
            }
        }

        _emit(
            type,
            detail = {}
        ) {
            if (
                this.destroyed
            ) {
                return null;
            }

            const event = {
                type,
                timestamp:
                    iso(),
                ...detail
            };

            if (
                this.emitting
            ) {
                return event;
            }

            this.emitting =
                true;

            try {
                safeDispatch(
                    this,
                    type,
                    event
                );

                safeDispatch(
                    this,
                    "change",
                    event
                );

                safeDispatch(
                    document,
                    `speciedex:terminal-stream-${type}`,
                    event
                );

                this.context.events?.emit?.(
                    `stream:${type}`,
                    event
                );
            } catch (error) {
                this.lastError =
                    error instanceof
                        Error
                        ? error
                        : new Error(
                            String(
                                error
                            )
                        );

                this.metrics.errors +=
                    1;
            } finally {
                this.emitting =
                    false;
            }

            return event;
        }

        _recordError(error, phase = "runtime") {
            this.lastError = error instanceof Error
                ? error
                : new Error(String(error));
            this.metrics.errors += 1;

            this._emit("error", {
                phase,
                error: {
                    name: this.lastError.name,
                    message: this.lastError.message,
                    stack: this.lastError.stack || ""
                }
            });

            this._syncState();
        }

        _resolveTransport(url = this.options.url, requested = this.options.transport) {
            const transport = normalizeTransport(requested);

            if (transport !== "auto") {
                return transport;
            }

            const parsed = new URL(url, document.baseURI);

            if (["ws:", "wss:"].includes(parsed.protocol)) {
                return "websocket";
            }

            if (typeof EventSource === "function") {
                return "sse";
            }

            return "fetch";
        }

        _syncState() {
            if (
                this.syncingState ||
                this.destroyed
            ) {
                return false;
            }

            const state =
                this.context.state ||
                this.context.stateStore;

            if (
                !state?.set
            ) {
                return false;
            }

            this.syncingState =
                true;

            try {
                const snapshot =
                    this.status();

                state.set(
                    "stream",
                    {
                        ...(
                            state.get?.(
                                "stream",
                                {}
                            ) ||
                            {}
                        ),
                        connected:
                            snapshot.connected,
                        connecting:
                            snapshot.connecting,
                        state:
                            snapshot.state,
                        transport:
                            snapshot.transport,
                        url:
                            snapshot.url,
                        records:
                            snapshot.metrics.accepted,
                        received:
                            snapshot.metrics.received,
                        rejected:
                            snapshot.metrics.rejected,
                        rate:
                            snapshot.metrics.rate,
                        buffered:
                            snapshot.buffered,
                        reconnectAttempts:
                            snapshot.reconnectAttempts,
                        lastRecord:
                            clone(
                                snapshot.lastRecord
                            ),
                        lastMessageAt:
                            snapshot.lastMessageAt,
                        lastError:
                            snapshot.lastError
                    },
                    {
                        source:
                            "stream",
                        undoable:
                            false,
                        persist:
                            false,
                        broadcast:
                            false
                    }
                );

                return true;
            } catch (_error) {
                return false;
            } finally {
                this.syncingState =
                    false;
            }
        }

        _setHeartbeat() {
            clearTimeout(this.heartbeatTimer);
            this.heartbeatTimer = null;

            if (!this.options.heartbeatTimeout) {
                return;
            }

            this.heartbeatTimer = window.setTimeout(() => {
                this._recordError(
                    new Error("Stream heartbeat timeout."),
                    "heartbeat"
                );
                this._closeTransport();
                this._scheduleReconnect();
            }, this.options.heartbeatTimeout);
        }

        _recordRate() {
            const timestamp = now();
            this.rateWindow.push(timestamp);

            const cutoff = timestamp - 10000;
            while (this.rateWindow.length && this.rateWindow[0] < cutoff) {
                this.rateWindow.shift();
            }

            const elapsed = this.rateWindow.length > 1
                ? Math.max(1, timestamp - this.rateWindow[0])
                : 1000;

            this.metrics.rate = Number(
                ((this.rateWindow.length / elapsed) * 1000).toFixed(3)
            );
            this.metrics.peakRate = Math.max(
                this.metrics.peakRate,
                this.metrics.rate
            );
        }

        _applyFilters(record) {
            for (const [name, filter] of this.filters) {
                try {
                    if (!filter(record, this)) {
                        return {
                            accepted: false,
                            filter: name
                        };
                    }
                } catch (error) {
                    this.metrics.filterErrors +=
                        1;

                    this._recordError(
                        error,
                        `filter:${name}`
                    );
                    return {
                        accepted: false,
                        filter: name
                    };
                }
            }

            return {
                accepted: true,
                filter: null
            };
        }

        _queuePublish(
            entry
        ) {
            this.pendingPublish.push(
                clone(
                    entry
                )
            );

            if (
                this.pendingPublish.length >=
                this.options.publishBatch
            ) {
                this._flushPublish();

                return;
            }

            if (
                this.publishTimer ===
                    null
            ) {
                this.publishTimer =
                    window.setTimeout(
                        () => {
                            this.publishTimer =
                                null;

                            this._flushPublish();
                        },
                        this.options.publishInterval
                    );
            }
        }

        _flushPublish() {
            if (
                !this.pendingPublish.length ||
                this.destroyed
            ) {
                return 0;
            }

            window.clearTimeout(
                this.publishTimer
            );

            this.publishTimer =
                null;

            const entries =
                this.pendingPublish.splice(
                    0
                );

            if (
                this.options.publishLibrary
            ) {
                const library =
                    this.context.library ||
                    this.context.services?.get?.(
                        "library"
                    );

                try {
                    const current =
                        library?.get?.(
                            this.options.libraryCollection
                        ) ||
                        [];

                    const records =
                        Array.isArray(
                            current
                        )
                            ? current
                            : [];

                    library?.set?.(
                        this.options.libraryCollection,
                        [
                            ...records,
                            ...entries.map(
                                item =>
                                    item.record
                            )
                        ].slice(
                            -this.options.bufferLimit
                        ),
                        {
                            source:
                                "stream",
                            description:
                                "Recent records received from the live Speciedex stream."
                        }
                    );
                } catch (error) {
                    this._recordError(
                        error,
                        "library-publish"
                    );
                }
            }

            if (
                this.options.publishSplash
            ) {
                for (
                    const entry of
                    entries
                ) {
                    const record =
                        entry.record &&
                        typeof entry.record ===
                            "object"
                            ? entry.record
                            : {
                                value:
                                    entry.record
                            };

                    safeDispatch(
                        document,
                        "speciedex:terminal-splash-record",
                        {
                            source:
                                "stream",
                            sequence:
                                entry.sequence,
                            receivedAt:
                                entry.receivedAt,
                            speciedexId:
                                record.speciedex_id ??
                                record.speciedexId ??
                                record.id ??
                                record.key ??
                                "",
                            scientificName:
                                record.scientific_name ??
                                record.scientificName ??
                                record.canonical_name ??
                                record.name ??
                                "",
                            commonName:
                                record.common_name ??
                                record.commonName ??
                                record.vernacular_name ??
                                "",
                            provider:
                                record.provider ??
                                record.source ??
                                "",
                            record
                        }
                    );
                }
            }

            this.metrics.published +=
                entries.length;

            this.metrics.publishBatches +=
                1;

            this._emit(
                "batch",
                {
                    count:
                        entries.length,
                    entries
                }
            );

            return entries.length;
        }

        _ingest(payload, metadata = {}) {
            const raw = payload;
            const record = this.options.parse ? parsePayload(payload) : payload;
            let size =
                0;

            try {
                size =
                    typeof raw ===
                        "string"
                        ? new Blob([
                            raw
                        ]).size
                        : new Blob([
                            JSON.stringify(
                                raw ??
                                null
                            )
                        ]).size;
            } catch (_error) {
                size =
                    0;
            }

            this.metrics.received += 1;
            this.metrics.bytes += size;
            this.lastMessageAt = iso();
            this._setHeartbeat();
            this._recordRate();

            const decision = this._applyFilters(record);

            if (!decision.accepted) {
                this.metrics.rejected += 1;
                this._emit("reject", {
                    record: clone(record),
                    filter: decision.filter,
                    metadata: clone(metadata)
                });
                this._syncState();
                return null;
            }

            const entry = {
                sequence: ++this.sequence,
                receivedAt: this.lastMessageAt,
                record: clone(record),
                metadata: clone(metadata)
            };

            this.metrics.accepted += 1;
            this.lastRecord = entry;
            this.buffer.push(entry);

            for (const subscriber of Array.from(this.subscribers)) {
                try {
                    subscriber(clone(entry), this);
                } catch (error) {
                    const failures =
                        (
                            this.subscriberErrors.get(
                                subscriber
                            ) ||
                            0
                        ) +
                        1;

                    this.subscriberErrors.set(
                        subscriber,
                        failures
                    );

                    this.metrics.subscriberErrors +=
                        1;

                    this._recordError(
                        error,
                        "subscriber"
                    );

                    if (
                        failures >=
                        this.options.maxSubscriberErrors
                    ) {
                        this.subscribers.delete(
                            subscriber
                        );

                        this.subscriberErrors.delete(
                            subscriber
                        );
                    }
                }
            }

            this._emit(
                "record",
                clone(
                    entry
                )
            );

            this._queuePublish(
                entry
            );

            this._syncState();
            return entry;
        }

        async _openFetch(
            url,
            generation
        ) {
            this.abortController =
                new AbortController();

            const response = await fetch(url, {
                method: "GET",
                headers: {
                    Accept: "application/x-ndjson, application/json, text/event-stream, text/plain",
                    ...this.options.headers
                },
                credentials: this.options.credentials,
                cache: "no-store",
                signal: this.abortController.signal
            });

            if (
                generation !==
                    this.connectionGeneration
            ) {
                this.metrics.staleConnections +=
                    1;

                throw new DOMException(
                    "Stale stream connection.",
                    "AbortError"
                );
            }

            if (!response.ok) {
                throw new Error(
                    `Stream request failed with HTTP ${response.status}.`
                );
            }

            if (!response.body || typeof response.body.getReader !== "function") {
                const text = await response.text();
                for (const line of text.split(/\r?\n/)) {
                    if (line.trim()) {
                        this._ingest(line, {
                            transport: "fetch",
                            url
                        });
                    }
                }
                return;
            }

            this._handleOpen("fetch", url);

            const reader =
                response.body.getReader();

            const decoder =
                new TextDecoder();

            let pending =
                "";

            try {
                while (
                    !this.manualClose &&
                    !this.destroyed &&
                    generation ===
                        this.connectionGeneration
                ) {
                const result = await reader.read();

                if (result.done) {
                    break;
                }

                pending += decoder.decode(result.value, { stream: true });
                const lines = pending.split(/\r?\n/);
                pending = lines.pop() || "";

                for (let line of lines) {
                    line = line.trim();

                    if (!line || line.startsWith(":")) {
                        continue;
                    }

                    if (line.startsWith("data:")) {
                        line = line.slice(5).trim();
                    }

                    if (line) {
                        this._ingest(line, {
                            transport: "fetch",
                            url
                        });
                    }
                }
            }

                pending +=
                    decoder.decode();

                if (
                    pending.trim()
                ) {
                    this._ingest(
                        pending.trim(),
                        {
                            transport:
                                "fetch",
                            url
                        }
                    );
                }
            } finally {
                try {
                    await reader.cancel();
                } catch (_error) {
                    /* Reader may already be closed. */
                }

                try {
                    reader.releaseLock();
                } catch (_error) {
                    /* Ignore release failures. */
                }
            }

            if (
                !this.manualClose &&
                !this.destroyed &&
                generation ===
                    this.connectionGeneration
            ) {
                this._handleClose(
                    "fetch",
                    url
                );

                this._scheduleReconnect();
            }
        }

        _openSSE(
            url,
            generation
        ) {
            const source = new EventSource(url, {
                withCredentials: this.options.credentials === "include"
            });

            this.transport = source;

            source.onopen =
                () => {
                    if (
                        generation !==
                        this.connectionGeneration
                    ) {
                        source.close();

                        this.metrics.staleConnections +=
                            1;

                        return;
                    }

                    this._handleOpen(
                        "sse",
                        url
                    );
                };

            source.onmessage = (event) => {
                if (
                    generation !==
                    this.connectionGeneration
                ) {
                    return;
                }

                this._ingest(event.data, {
                    transport: "sse",
                    url,
                    eventId: event.lastEventId || null,
                    origin: event.origin || null
                });
            };

            source.onerror = () => {
                if (source.readyState === EventSource.CLOSED) {
                    this._handleClose("sse", url);
                    this._scheduleReconnect();
                } else {
                    this._recordError(
                        new Error("Server-Sent Events stream error."),
                        "sse"
                    );
                }
            };
        }

        _openWebSocket(
            url,
            generation
        ) {
            const protocols = this.options.protocols.length
                ? this.options.protocols
                : undefined;
            const socket = new WebSocket(url, protocols);

            this.transport = socket;

            socket.addEventListener(
                "open",
                () => {
                    if (
                        generation !==
                        this.connectionGeneration
                    ) {
                        socket.close();

                        this.metrics.staleConnections +=
                            1;

                        return;
                    }

                    this._handleOpen(
                        "websocket",
                        url
                    );
                }
            );

            socket.addEventListener("message", (event) => {
                if (
                    generation !==
                    this.connectionGeneration
                ) {
                    return;
                }

                if (event.data instanceof Blob) {
                    event.data.text()
                        .then((text) => this._ingest(text, {
                            transport: "websocket",
                            url,
                            binary: true
                        }))
                        .catch((error) => this._recordError(error, "websocket-blob"));
                    return;
                }

                this._ingest(event.data, {
                    transport: "websocket",
                    url,
                    binary: event.data instanceof ArrayBuffer
                });
            });

            socket.addEventListener("error", () => {
                this._recordError(
                    new Error("WebSocket stream error."),
                    "websocket"
                );
            });

            socket.addEventListener("close", (event) => {
                this._handleClose("websocket", url, {
                    code: event.code,
                    reason: event.reason,
                    clean: event.wasClean
                });

                if (!this.manualClose) {
                    this._scheduleReconnect();
                }
            });
        }

        _handleOpen(transport, url) {
            this.connectedAt = iso();
            this.disconnectedAt = null;
            this.reconnectAttempts = 0;
            this.metrics.opens += 1;
            this._setHeartbeat();

            this._emit("open", {
                transport,
                url
            });

            this._syncState();
        }

        _handleClose(transport, url, details = {}) {
            clearTimeout(this.heartbeatTimer);
            this.heartbeatTimer = null;
            this.disconnectedAt = iso();
            this.metrics.closes += 1;

            this._emit("close", {
                transport,
                url,
                ...details
            });

            this._syncState();
        }

        _closeTransport() {
            clearTimeout(this.heartbeatTimer);
            this.heartbeatTimer = null;

            if (this.abortController) {
                try {
                    this.abortController.abort();
                } catch (error) {
                    /* Ignore abort failures. */
                }
                this.abortController = null;
            }

            if (this.transport) {
                try {
                    this.transport.close();
                } catch (error) {
                    /* Ignore transport close failures. */
                }
                this.transport = null;
            }
        }

        _scheduleReconnect() {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;

            if (
                this.manualClose ||
                this.destroyed ||
                !this.options.autoReconnect ||
                navigator.onLine ===
                    false ||
                this.reconnectTimer
            ) {
                this.metrics.reconnectSuppressed +=
                    1;

                return false;
            }

            this.reconnectAttempts += 1;
            this.metrics.reconnects += 1;

            const exponential = this.options.reconnectDelay *
                Math.pow(2, Math.max(0, this.reconnectAttempts - 1));
            const delay = Math.min(
                this.options.maxReconnectDelay,
                exponential
            );
            const jitter = Math.round(delay * 0.2 * Math.random());
            const scheduledDelay = delay + jitter;

            this._emit("reconnect", {
                attempt: this.reconnectAttempts,
                delay: scheduledDelay
            });

            this.reconnectTimer =
                window.setTimeout(
                    () => {
                        this.reconnectTimer =
                            null;

                        this.connect().catch((error) => {
                    this._recordError(error, "reconnect");
                            this._scheduleReconnect();
                        });
                    },
                    scheduledDelay
                );

            this._syncState();

            return true;
        }

        _handleOnline() {
            this._emit("online", { online: true });

            if (!this.manualClose && !this.isConnected() && this.options.url) {
                this.connect().catch((error) => {
                    this._recordError(error, "online-reconnect");
                });
            }
        }

        _handleOffline() {
            this._emit("offline", { online: false });
            this._closeTransport();
            this._syncState();
        }

        isConnected() {
            if (this.abortController) {
                return Boolean(this.connectedAt && !this.disconnectedAt);
            }

            if (this.transport instanceof EventSource) {
                return this.transport.readyState === EventSource.OPEN;
            }

            if (this.transport instanceof WebSocket) {
                return this.transport.readyState === WebSocket.OPEN;
            }

            return false;
        }

        isConnecting() {
            if (this.transport instanceof EventSource) {
                return this.transport.readyState === EventSource.CONNECTING;
            }

            if (this.transport instanceof WebSocket) {
                return this.transport.readyState === WebSocket.CONNECTING;
            }

            return Boolean(this.abortController && !this.connectedAt);
        }

        async connect(
            options = {}
        ) {
            this._assertActive();

            if (
                isObject(
                    options
                )
            ) {
                if (
                    options.url !==
                    undefined
                ) {
                    this.options.url =
                        normalizeURL(
                            options.url,
                            document.baseURI
                        );
                }

                if (
                    options.transport !==
                    undefined
                ) {
                    this.options.transport =
                        normalizeTransport(
                            options.transport
                        );
                }

                if (
                    options.autoReconnect !==
                    undefined
                ) {
                    this.options.autoReconnect =
                        Boolean(
                            options.autoReconnect
                        );
                }

                if (
                    options.headers &&
                    isObject(
                        options.headers
                    )
                ) {
                    this.options.headers = {
                        ...this.options.headers,
                        ...options.headers
                    };
                }
            }

            if (
                !this.options.url
            ) {
                throw new Error(
                    "A stream URL is required."
                );
            }

            if (
                this.isConnected()
            ) {
                return this.status();
            }

            if (
                this.connectPromise
            ) {
                return this.connectPromise;
            }

            clearTimeout(
                this.reconnectTimer
            );

            this.reconnectTimer =
                null;

            this.manualClose =
                false;

            this.startedAt =
                this.startedAt ||
                iso();

            this.connectedAt =
                null;

            this.disconnectedAt =
                null;

            this.lastError =
                null;

            const generation =
                ++this.connectionGeneration;

            const transport =
                this._resolveTransport(
                    this.options.url,
                    this.options.transport
                );

            this._emit(
                "connecting",
                {
                    transport,
                    url:
                        this.options.url,
                    generation
                }
            );

            this._syncState();

            this.connectPromise =
                (async () => {
                    if (
                        transport ===
                            "sse"
                    ) {
                        this._openSSE(
                            this.options.url,
                            generation
                        );

                        return this.status();
                    }

                    if (
                        transport ===
                            "websocket"
                    ) {
                        this._openWebSocket(
                            this.options.url,
                            generation
                        );

                        return this.status();
                    }

                    try {
                        await this._openFetch(
                            this.options.url,
                            generation
                        );
                    } catch (error) {
                        if (
                            !isAbortError(
                                error
                            )
                        ) {
                            this._recordError(
                                error,
                                "fetch"
                            );

                            this._scheduleReconnect();

                            throw error;
                        }
                    }

                    return this.status();
                })();

            try {
                return await this.connectPromise;
            } finally {
                if (
                    generation ===
                    this.connectionGeneration
                ) {
                    this.connectPromise =
                        null;
                }
            }
        }

        disconnect(reason = "manual") {
            this._assertActive();

            this.manualClose =
                true;

            this.connectionGeneration +=
                1;

            clearTimeout(
                this.reconnectTimer
            );
            this.reconnectTimer = null;
            this._closeTransport();
            this._flushPublish();

            this.disconnectedAt =
                iso();

            this._emit("disconnect", {
                reason
            });

            this._syncState();
            return this.status();
        }

        reconnect() {
            this.disconnect("reconnect");
            this.manualClose = false;
            return this.connect();
        }

        send(payload) {
            this._assertActive();

            if (!(this.transport instanceof WebSocket)) {
                throw new Error("Sending is only supported for WebSocket streams.");
            }

            if (this.transport.readyState !== WebSocket.OPEN) {
                throw new Error("WebSocket stream is not connected.");
            }

            const data = typeof payload === "string"
                ? payload
                : JSON.stringify(payload);

            this.transport.send(data);

            this._emit("send", {
                bytes: new Blob([data]).size
            });

            return true;
        }

        subscribe(callback, options = {}) {
            if (typeof callback !== "function") {
                throw new TypeError("Stream subscriber must be a function.");
            }

            this.subscribers.add(callback);

            if (options.replay === true) {
                const count = parseNumber(
                    options.limit,
                    this.buffer.length,
                    0,
                    this.buffer.length
                );

                for (const entry of this.buffer.toArray().slice(-count)) {
                    callback(entry, this);
                }
            }

            return () => this.unsubscribe(callback);
        }

        unsubscribe(callback) {
            return this.subscribers.delete(callback);
        }

        addFilter(name, callback) {
            if (typeof callback !== "function") {
                throw new TypeError("Stream filter must be a function.");
            }

            this.filters.set(String(name || `filter-${this.filters.size + 1}`), callback);
            return this;
        }

        removeFilter(name) {
            return this.filters.delete(String(name));
        }

        clearFilters() {
            const count = this.filters.size;
            this.filters.clear();
            return count;
        }

        clearBuffer() {
            const count = this.buffer.clear();

            this._emit("bufferClear", {
                count
            });

            this._syncState();
            return count;
        }

        records(options = {}) {
            let records = this.buffer.toArray();

            if (options.since) {
                const since = new Date(options.since).getTime();
                records = records.filter((entry) => {
                    return new Date(entry.receivedAt).getTime() >= since;
                });
            }

            const limit = parseNumber(
                options.limit,
                records.length,
                0,
                records.length
            );

            return limit ? records.slice(-limit) : [];
        }

        inject(payload, metadata = {}) {
            this._assertActive();

            return this._ingest(payload, {
                transport: "injected",
                ...metadata
            });
        }

        configure(options = {}) {
            this._assertActive();

            if (!isObject(options)) {
                throw new TypeError("Stream configuration must be an object.");
            }

            if (options.url !== undefined) {
                this.options.url = normalizeURL(options.url, document.baseURI);
            }

            if (options.transport !== undefined) {
                this.options.transport = normalizeTransport(options.transport);
            }

            if (options.autoReconnect !== undefined) {
                this.options.autoReconnect = Boolean(options.autoReconnect);
            }

            if (options.reconnectDelay !== undefined) {
                this.options.reconnectDelay = parseDuration(
                    options.reconnectDelay,
                    this.options.reconnectDelay
                );
            }

            if (options.maxReconnectDelay !== undefined) {
                this.options.maxReconnectDelay = parseDuration(
                    options.maxReconnectDelay,
                    this.options.maxReconnectDelay
                );
            }

            if (options.heartbeatTimeout !== undefined) {
                this.options.heartbeatTimeout = parseDuration(
                    options.heartbeatTimeout,
                    this.options.heartbeatTimeout
                );
            }

            if (
                options.publishBatch !==
                    undefined
            ) {
                this.options.publishBatch =
                    parseNumber(
                        options.publishBatch,
                        this.options.publishBatch,
                        1,
                        10000
                    );
            }

            if (
                options.publishInterval !==
                    undefined
            ) {
                this.options.publishInterval =
                    parseDuration(
                        options.publishInterval,
                        this.options.publishInterval
                    );
            }

            if (options.headers && isObject(options.headers)) {
                this.options.headers = {
                    ...this.options.headers,
                    ...options.headers
                };
            }

            this._emit("configure", {
                options: clone(this.options)
            });

            this._syncState();
            return this.status();
        }

        resetMetrics() {
            this.metrics = {
                received: 0,
                accepted: 0,
                rejected: 0,
                bytes: 0,
                reconnects: 0,
                errors: 0,
                opens: 0,
                closes: 0,
                rate: 0,
                peakRate: 0,
                published: 0,
                publishBatches: 0,
                subscriberErrors: 0,
                filterErrors: 0,
                staleConnections: 0,
                reconnectSuppressed: 0
            };
            this.rateWindow.length = 0;
            this.sequence = 0;
            this.lastRecord = null;
            this.lastMessageAt = null;
            this.lastError = null;

            this._emit("metricsReset", {});
            this._syncState();
            return this.status();
        }

        status() {
            let state = "idle";

            if (this.destroyed) {
                state = "destroyed";
            } else if (this.isConnected()) {
                state = "connected";
            } else if (this.isConnecting()) {
                state = "connecting";
            } else if (this.reconnectTimer) {
                state = "reconnecting";
            } else if (this.disconnectedAt) {
                state = "disconnected";
            }

            return {
                name: "stream",
                module: MODULE_NAME,
                state,
                connected: state === "connected",
                connecting: state === "connecting",
                online: navigator.onLine !== false,
                url: this.options.url || null,
                transport: this.options.url
                    ? this._resolveTransport(
                        this.options.url,
                        this.options.transport
                    )
                    : this.options.transport,
                autoReconnect: this.options.autoReconnect,
                reconnectAttempts: this.reconnectAttempts,
                buffered: this.buffer.length,
                bufferLimit: this.buffer.limit,
                subscribers: this.subscribers.size,
                filters:
                    Array.from(
                        this.filters.keys()
                    ),
                pendingPublish:
                    this.pendingPublish.length,
                connectionGeneration:
                    this.connectionGeneration,
                connectPending:
                    Boolean(
                        this.connectPromise
                    ),
                startedAt: this.startedAt,
                connectedAt: this.connectedAt,
                disconnectedAt: this.disconnectedAt,
                lastMessageAt: this.lastMessageAt,
                lastRecord: clone(this.lastRecord),
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

        async run(parameters = {}) {
            const args = Array.isArray(parameters.args)
                ? parameters.args
                : [];
            const parsed = flattenArguments(args);

            switch (parsed.action) {
                case "connect":
                case "start":
                    return this.connect({
                        url: parsed.options.url || parsed.positional[0] || this.options.url,
                        transport: parsed.options.transport || this.options.transport,
                        autoReconnect: !parseBoolean(parsed.options["no-reconnect"], false)
                    });

                case "disconnect":
                case "stop":
                    return this.disconnect("command");

                case "reconnect":
                case "restart":
                    return this.reconnect();

                case "records":
                case "buffer":
                    return {
                        count: this.buffer.length,
                        records: this.records({
                            limit: parseNumber(
                                parsed.options.limit || parsed.positional[0],
                                this.buffer.length,
                                0,
                                this.buffer.length
                            ),
                            since: parsed.options.since
                        })
                    };

                case "clear":
                    return {
                        cleared: this.clearBuffer()
                    };

                case "inject":
                    return this.inject(
                        parsePayload(parsed.positional.join(" "))
                    );

                case "reset":
                    return this.resetMetrics();

                case "flush":
                    return {
                        published:
                            this._flushPublish()
                    };

                case "config":
                case "configure":
                    return this.configure({
                        url: parsed.options.url,
                        transport: parsed.options.transport,
                        autoReconnect: parsed.options.reconnect === undefined
                            ? undefined
                            : parseBoolean(parsed.options.reconnect, true),
                        reconnectDelay: parsed.options.delay,
                        maxReconnectDelay: parsed.options["max-delay"],
                        heartbeatTimeout:
                            parsed.options.heartbeat,
                        publishBatch:
                            parsed.options[
                                "publish-batch"
                            ],
                        publishInterval:
                            parsed.options[
                                "publish-interval"
                            ]
                    });

                case "status":
                case "show":
                case "info":
                default:
                    return this.status();
            }
        }

        destroy() {
            if (
                this.destroyed
            ) {
                return false;
            }

            this.manualClose =
                true;

            this.connectionGeneration +=
                1;

            clearTimeout(
                this.reconnectTimer
            );

            clearTimeout(
                this.heartbeatTimer
            );

            clearTimeout(
                this.publishTimer
            );

            this.reconnectTimer =
                null;

            this.heartbeatTimer =
                null;

            this.publishTimer =
                null;

            this._flushPublish();
            this._closeTransport();

            this.lifecycleAbortController.abort();

            window.removeEventListener(
                "online",
                this._boundOnline
            );

            window.removeEventListener(
                "offline",
                this._boundOffline
            );

            this.subscribers.clear();
            this.filters.clear();
            this.subscriberErrors.clear();
            this.rateWindow =
                [];
            this.pendingPublish =
                [];

            if (
                this.context.root?.[
                    STREAM_SYMBOL
                ] ===
                    this
            ) {
                delete this.context.root[
                    STREAM_SYMBOL
                ];
            }

            this.destroyed =
                true;

            safeDispatch(
                this,
                "destroy",
                {
                    version:
                        VERSION,
                    timestamp:
                        iso()
                }
            );

            return true;
        }

    }

    function getService(context) {
        return context?.stream ||
            context?.services?.get?.("stream") ||
            context?.services?.stream ||
            null;
    }

    function initialize(
        context = {}
    ) {
        const root =
            context.root;

        const existing =
            context.stream instanceof
                StreamService
                ? context.stream
                : context.services?.get?.(
                    "stream"
                ) ||
                root?.[
                    STREAM_SYMBOL
                ];

        if (
            existing instanceof
                StreamService &&
            !existing.destroyed
        ) {
            context.stream =
                existing;

            context.registerService?.(
                "stream",
                existing
            );

            return existing;
        }

        const dataset =
            root?.
                dataset ||
            {};

        const config =
            context.config?.
                stream ||
            {};

        const service =
            new StreamService(
                context,
                {
                    url:
                        dataset.terminalStreamUrl ||
                        dataset.streamUrl ||
                        config.url ||
                        "",

                    transport:
                        dataset.terminalStreamTransport ||
                        config.transport ||
                        DEFAULT_TRANSPORT,

                    autoReconnect:
                        parseBoolean(
                            dataset.terminalStreamReconnect,
                            config.autoReconnect !==
                            false
                        ),

                    reconnectDelay:
                        dataset.terminalStreamReconnectDelay ||
                        config.reconnectDelay ||
                        DEFAULT_RECONNECT_DELAY,

                    maxReconnectDelay:
                        dataset.terminalStreamMaxReconnectDelay ||
                        config.maxReconnectDelay ||
                        DEFAULT_MAX_RECONNECT_DELAY,

                    heartbeatTimeout:
                        dataset.terminalStreamHeartbeat ||
                        config.heartbeatTimeout ||
                        DEFAULT_HEARTBEAT_TIMEOUT,

                    bufferLimit:
                        dataset.terminalStreamBuffer ||
                        config.bufferLimit ||
                        DEFAULT_BUFFER_LIMIT,

                    credentials:
                        dataset.terminalStreamCredentials ||
                        config.credentials ||
                        "same-origin",

                    headers:
                        config.headers ||
                        {},

                    protocols:
                        config.protocols ||
                        [],

                    parse:
                        parseBoolean(
                            dataset.terminalStreamParse,
                            config.parse !==
                            false
                        ),

                    publishBatch:
                        dataset.terminalStreamPublishBatch ||
                        config.publishBatch ||
                        DEFAULT_PUBLISH_BATCH,

                    publishInterval:
                        dataset.terminalStreamPublishInterval ||
                        config.publishInterval ||
                        DEFAULT_PUBLISH_INTERVAL,

                    publishLibrary:
                        parseBoolean(
                            dataset.terminalStreamPublishLibrary,
                            config.publishLibrary !==
                            false
                        ),

                    publishSplash:
                        parseBoolean(
                            dataset.terminalStreamPublishSplash,
                            config.publishSplash !==
                            false
                        ),

                    libraryCollection:
                        dataset.terminalStreamLibraryCollection ||
                        config.libraryCollection ||
                        "stream-records",

                    maxSubscriberErrors:
                        dataset.terminalStreamMaxSubscriberErrors ||
                        config.maxSubscriberErrors ||
                        DEFAULT_MAX_SUBSCRIBER_ERRORS
                }
            );

        root[
            STREAM_SYMBOL
        ] =
            service;

        context.stream =
            service;

        context.registerService?.(
            "stream",
            service
        );

        safeDispatch(
            document,
            "speciedex:terminal-stream-ready",
            {
                service,
                status:
                    service.status(),
                version:
                    VERSION
            }
        );

        if (
            parseBoolean(
                dataset.terminalStreamAutostart,
                config.autostart ===
                true
            ) &&
            service.options.url
        ) {
            service.connect().catch(
                error => {
                    service._recordError(
                        error,
                        "autostart"
                    );
                }
            );
        }

        return service;
    }

    const commands = [{
        name: "stream",
        aliases: ["streams"],
        category: "data",
        description: "Consume, inspect, and manage incremental Speciedex data streams.",
        usage:
            "stream [status|connect|disconnect|reconnect|records|clear|inject|reset|config|flush] " +
            "[url] [--transport=auto|sse|websocket|fetch] [--limit=100]",
        handler: async ({
            args = [],
            context,
            writeJSON,
            write,
            writeError
        }) => {
            const service = getService(context);

            if (!service) {
                throw new Error("Stream service is unavailable.");
            }

            try {
                const result = await service.run({ args });

                if (
                    result &&
                    typeof result === "object" &&
                    typeof writeJSON === "function"
                ) {
                    return writeJSON(result);
                }

                if (typeof write === "function") {
                    return write(String(result ?? ""), "data");
                }

                return result;
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
        name:
            MODULE_NAME,
        version:
            VERSION,
        STREAM_SYMBOL,
        StreamService,
        RingBuffer,
        isAbortError,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalStream = api;
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
