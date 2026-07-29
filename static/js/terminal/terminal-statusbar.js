/*
========================================================================
Speciedex.org
Terminal Status Bar
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Statusbar";
    const SERVICE_NAME = "statusbar";
    const VERSION = "2.2.1";

    const STATUSBAR_SYMBOL =
        Symbol.for(
            "speciedex.terminal.statusbar.instance"
        );

    const RESERVED_KEYS =
        new Set([
            "__proto__",
            "prototype",
            "constructor"
        ]);

    const activeDispatches =
        new WeakMap();

    const DEFAULT_VERSION = "unknown";
    const DEFAULT_PROVIDER = "local database index";
    const DEFAULT_NETWORK = "offline";
    const DEFAULT_RECORDS = 0;

    const ELEMENT_ALIASES = Object.freeze({
        root: ["statusbar", "statusBar", "terminalStatusbar", "terminalStatusBar"],
        provider: ["provider", "providerName", "activeProvider", "statusProvider"],
        records: ["recordCount", "records", "recordTotal", "statusRecords"],
        network: ["networkStatus", "network", "connectionStatus", "statusNetwork"],
        version: ["version", "appVersion", "terminalVersion", "statusVersion"],
        activity: ["activity", "statusActivity", "operation", "currentOperation"],
        latency: ["latency", "networkLatency", "statusLatency"],
        clock: ["clock", "statusClock", "terminalClock"],
        progress: ["progress", "statusProgress", "terminalProgress"]
    });

    const SELECTORS = Object.freeze({
        root: [
            "[data-terminal-statusbar]",
            "#terminal-statusbar",
            ".terminal-statusbar",
            ".statusbar"
        ],
        provider: [
            "[data-status-provider]",
            "#status-provider",
            "#provider-status",
            "[data-terminal-provider]"
        ],
        records: [
            "[data-status-records]",
            "#status-records",
            "#record-count",
            "[data-terminal-record-count]"
        ],
        network: [
            "[data-status-network]",
            "#status-network",
            "#network-status",
            "[data-terminal-network-status]"
        ],
        version: [
            "[data-status-version]",
            "#status-version",
            "#terminal-version",
            "[data-terminal-version]"
        ],
        activity: [
            "[data-status-activity]",
            "#status-activity",
            "#terminal-activity"
        ],
        latency: [
            "[data-status-latency]",
            "#status-latency",
            "#network-latency"
        ],
        clock: [
            "[data-status-clock]",
            "#status-clock",
            "#terminal-clock"
        ],
        progress: [
            "[data-status-progress]",
            "#status-progress",
            "progress[data-terminal-progress]"
        ]
    });

    const DEFAULT_STATE = Object.freeze({
        provider: DEFAULT_PROVIDER,
        records: DEFAULT_RECORDS,
        network: DEFAULT_NETWORK,
        version: DEFAULT_VERSION,
        activity: "idle",
        latency: null,
        progress: null,
        online: false,
        busy: false,
        updatedAt: null
    });

    function isObject(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    function clone(
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
            return new Date(
                value.getTime()
            );
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
                    clone(
                        item,
                        seen,
                        depth + 1
                    )
            );
        }

        if (value instanceof Map) {
            const output =
                new Map();

            for (
                const [key, item]
                of value
            ) {
                output.set(
                    clone(
                        key,
                        seen,
                        depth + 1
                    ),
                    clone(
                        item,
                        seen,
                        depth + 1
                    )
                );
            }

            return output;
        }

        if (value instanceof Set) {
            const output =
                new Set();

            for (const item of value) {
                output.add(
                    clone(
                        item,
                        seen,
                        depth + 1
                    )
                );
            }

            return output;
        }

        const output = {};

        for (
            const [key, item]
            of Object.entries(value)
        ) {
            if (RESERVED_KEYS.has(key)) {
                continue;
            }

            output[key] =
                clone(
                    item,
                    seen,
                    depth + 1
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

    function firstFinite(
        ...values
    ) {
        for (
            const value of
            values
        ) {
            const number =
                Number(
                    value
                );

            if (
                Number.isFinite(
                    number
                )
            ) {
                return number;
            }
        }

        return null;
    }

    function normalizeString(value, fallback = "") {
        if (value === null || value === undefined) {
            return fallback;
        }

        const text = String(value).trim();
        return text || fallback;
    }

    function normalizeNumber(value, fallback = 0) {
        const number = Number(value);
        return Number.isFinite(number) ? number : fallback;
    }

    function normalizeBoolean(value, fallback = false) {
        if (typeof value === "boolean") {
            return value;
        }

        if (typeof value === "number") {
            return value !== 0;
        }

        if (typeof value === "string") {
            const normalized = value.trim().toLowerCase();
            if (["true", "yes", "on", "online", "connected", "1"].includes(normalized)) {
                return true;
            }
            if (["false", "no", "off", "offline", "disconnected", "0"].includes(normalized)) {
                return false;
            }
        }

        return fallback;
    }

    function formatInteger(value) {
        const number = Math.max(0, Math.trunc(normalizeNumber(value, 0)));
        try {
            return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(number);
        } catch (error) {
            return String(number);
        }
    }

    function formatLatency(value) {
        if (value === null || value === undefined || value === "") {
            return "—";
        }

        const milliseconds = normalizeNumber(value, NaN);
        if (!Number.isFinite(milliseconds) || milliseconds < 0) {
            return "—";
        }

        if (milliseconds < 1) {
            return "<1 ms";
        }

        if (milliseconds >= 1000) {
            return `${(milliseconds / 1000).toFixed(milliseconds >= 10000 ? 0 : 1)} s`;
        }

        return `${Math.round(milliseconds)} ms`;
    }

    function formatClock(date = new Date()) {
        try {
            return new Intl.DateTimeFormat(undefined, {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hour12: false
            }).format(date);
        } catch (error) {
            return date.toLocaleTimeString();
        }
    }

    function clampProgress(value) {
        if (value === null || value === undefined || value === "") {
            return null;
        }

        const number = normalizeNumber(value, NaN);
        if (!Number.isFinite(number)) {
            return null;
        }

        return Math.min(100, Math.max(0, number));
    }

    function safeDispatch(
        target,
        name,
        detail,
        options = {}
    ) {
        if (
            !target ||
            typeof target.dispatchEvent !==
                "function" ||
            !name
        ) {
            return false;
        }

        let names =
            activeDispatches.get(
                target
            );

        if (!names) {
            names =
                new Set();

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
                            options.bubbles ===
                            true,
                        cancelable:
                            options.cancelable ===
                            true,
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

    class StatusBar extends EventTarget {
        constructor(context = {}, options = {}) {
            super();

            this.context =
                isObject(context)
                    ? context
                    : {};

            this.context.root =
                this.context.root &&
                typeof this.context.root.querySelector ===
                    "function"
                    ? this.context.root
                    : document.documentElement;

            this.options = Object.assign({
                autoBind: true,
                autoClock: true,
                clockInterval: 1000,
                observeDOM: true,
                renderOnInitialize: true,
                refreshInterval: 5000,
                autoHydrate: true
            }, isObject(options) ? options : {});

            this.state = Object.assign({}, DEFAULT_STATE, {
                online: typeof navigator !== "undefined" ? Boolean(navigator.onLine) : false,
                network: typeof navigator !== "undefined" && navigator.onLine ? "online" : "offline",
                version: this.resolveInitialVersion()
            });

            this.elements = Object.create(null);
            this.destroyed = false;
            this.bound = false;
            this.renderQueued = false;
            this.clockTimer = null;
            this.refreshTimer = null;
            this.observer = null;
            this.abortController =
                typeof AbortController ===
                    "function"
                    ? new AbortController()
                    : {
                        signal:
                            undefined,
                        abort() {}
                    };
            this.cleanup = [];
            this.stateUnsubscribers = [];
            this.lastRendered = Object.create(null);
            this.refreshing = false;
            this.hydrationPromise = null;

            /*
            --------------------------------------------------------------
            Guard status-bar fan-out by event name. This prevents same-event
            re-entry without suppressing unrelated nested lifecycle events.
            --------------------------------------------------------------
            */
            this.activeEmits = new Set();

            this.metrics = {
                updates: 0,
                renders: 0,
                refreshes: 0,
                stateEvents: 0,
                statsEvents: 0,
                providerEvents: 0,
                loadingEvents: 0,
                hydrationErrors: 0
            };

            this.handleOnline = this.handleOnline.bind(this);
            this.handleOffline = this.handleOffline.bind(this);
            this.handleVisibilityChange = this.handleVisibilityChange.bind(this);
            this.handleStateChange = this.handleStateChange.bind(this);
            this.handleStatsUpdated = this.handleStatsUpdated.bind(this);
            this.handleProviderChanged = this.handleProviderChanged.bind(this);
            this.handleLoadingChanged = this.handleLoadingChanged.bind(this);

            this.resolveElements();

            if (this.options.autoBind) {
                this.bind();
            }

            if (
                this.options.autoHydrate
            ) {
                this.hydrate();
            }

            if (this.options.renderOnInitialize) {
                this.render(true);
            }
        }

        addListener(
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

            const listenerOptions =
                this.abortController.signal
                    ? {
                        ...options,
                        signal:
                            this.abortController.signal
                    }
                    : options;

            try {
                target.addEventListener(
                    name,
                    handler,
                    listenerOptions
                );

                if (
                    !this.abortController.signal
                ) {
                    this.cleanup.push(
                        () =>
                            target.removeEventListener(
                                name,
                                handler,
                                listenerOptions
                            )
                    );
                }

                return true;
            } catch (_error) {
                target.addEventListener(
                    name,
                    handler,
                    options
                );

                this.cleanup.push(
                    () =>
                        target.removeEventListener(
                            name,
                            handler,
                            options
                        )
                );

                return true;
            }
        }

        watch(callback, options = {}) {
            if (typeof callback !== "function") {
                throw new TypeError(
                    "Status-bar watcher must be a function."
                );
            }

            const handler =
                event =>
                    callback(
                        event.detail,
                        this
                    );

            this.addEventListener(
                "change",
                handler
            );

            if (options.immediate === true) {
                callback(
                    {
                        changed: {},
                        state:
                            this.snapshot(),
                        source:
                            "immediate"
                    },
                    this
                );
            }

            return () =>
                this.removeEventListener(
                    "change",
                    handler
                );
        }

        resolveInitialVersion() {
            return normalizeString(
                this.context.version ||
                this.context.config?.version ||
                this.context.manifest?.version ||
                this.context.state?.get?.("runtime.version") ||
                this.context.stateStore?.get?.("runtime.version") ||
                window.SpeciedexTerminal?.version ||
                window.SpeciedexTerminalApp?.version ||
                VERSION,
                DEFAULT_VERSION
            );
        }

        findContextElement(name) {
            const sources = [
                this.context.elements,
                this.context.ui?.elements,
                this.context.dom,
                this.context.refs
            ];

            for (const source of sources) {
                if (!isObject(source)) {
                    continue;
                }

                for (const alias of ELEMENT_ALIASES[name] || []) {
                    const candidate = source[alias];
                    if (
                        isElement(
                            candidate
                        ) ||
                        (
                            typeof HTMLProgressElement ===
                                "function" &&
                            candidate instanceof
                                HTMLProgressElement
                        )
                    ) {
                        return candidate;
                    }
                }
            }

            return null;
        }

        findDocumentElement(name) {
            for (
                const selector
                of SELECTORS[name] ||
                []
            ) {
                const element =
                    this.context.root?.querySelector?.(
                        selector
                    ) ||
                    document.querySelector(
                        selector
                    );
                if (element) {
                    return element;
                }
            }
            return null;
        }

        resolveElements() {
            for (const name of Object.keys(SELECTORS)) {
                this.elements[name] = this.findContextElement(name) || this.findDocumentElement(name);
            }

            return this.elements;
        }

        bind() {
            if (
                this.bound ||
                this.destroyed
            ) {
                return this;
            }

            this.bound =
                true;

            this.addListener(
                window,
                "online",
                this.handleOnline
            );

            this.addListener(
                window,
                "offline",
                this.handleOffline
            );

            this.addListener(
                document,
                "visibilitychange",
                this.handleVisibilityChange
            );

            for (
                const eventName of
                [
                    "speciedex:stats-updated",
                    "speciedex:stats:loaded",
                    "speciedex:terminal-stats-loaded"
                ]
            ) {
                this.addListener(
                    document,
                    eventName,
                    this.handleStatsUpdated
                );
            }

            for (
                const eventName of
                [
                    "speciedex:provider-changed",
                    "speciedex:terminal-provider-manager-updated",
                    "speciedex:terminal-provider-manager-registered"
                ]
            ) {
                this.addListener(
                    document,
                    eventName,
                    this.handleProviderChanged
                );
            }

            for (
                const eventName of
                [
                    "speciedex:loading-changed",
                    "speciedex:terminal-loading-task-start",
                    "speciedex:terminal-loading-task-end",
                    "speciedex:terminal-loading-task-fail"
                ]
            ) {
                this.addListener(
                    document,
                    eventName,
                    this.handleLoadingChanged
                );
            }

            this.bindContextEvents();
            this.bindStateStore();

            if (
                this.options.autoClock
            ) {
                this.startClock();
            }

            if (
                this.options.autoHydrate
            ) {
                this.startRefreshTimer();
            }

            if (
                this.options.observeDOM &&
                typeof MutationObserver ===
                    "function"
            ) {
                this.observeDOM();
            }

            return this;
        }

        bindContextEvents() {
            const events = this.context.events;
            if (!events) {
                return;
            }

            const subscriptions = [
                ["stats:updated", this.handleStatsUpdated],
                ["stats:loaded", this.handleStatsUpdated],
                ["provider:changed", this.handleProviderChanged],
                ["loading:changed", this.handleLoadingChanged],
                ["terminal:busy", detail => this.update({ busy: true, activity: detail?.activity || "busy" })],
                ["terminal:idle", () => this.update({ busy: false, activity: "idle", progress: null })],
                ["network:latency", detail => this.update({ latency: detail?.latency ?? detail })]
            ];

            for (const [name, handler] of subscriptions) {
                if (typeof events.on === "function") {
                    const unsubscribe = events.on(name, handler);
                    if (typeof unsubscribe === "function") {
                        this.cleanup.push(unsubscribe);
                    } else if (typeof events.off === "function") {
                        this.cleanup.push(() => events.off(name, handler));
                    }
                } else if (typeof events.addEventListener === "function") {
                    events.addEventListener(name, handler);
                    this.cleanup.push(() => events.removeEventListener(name, handler));
                }
            }
        }

        bindStateStore() {
            const store = this.context.state || this.context.stateStore || this.context.services?.get?.("state");
            if (!store) {
                return;
            }

            if (typeof store.addEventListener === "function") {
                store.addEventListener("change", this.handleStateChange);
                this.stateUnsubscribers.push(() => store.removeEventListener("change", this.handleStateChange));
            }

            if (typeof store.watch === "function") {
                const watches = [
                    ["runtime.online", value => this.update({ online: value, network: value ? "online" : "offline" })],
                    ["runtime.version", value => this.update({ version: value })],
                    ["terminal.busy", value => this.update({ busy: value })],
                    ["terminal.activity", value => this.update({ activity: value })],
                    ["terminal.progress", value => this.update({ progress: value })],
                    ["statistics.records", value => this.update({ records: value })],
                    ["statistics.totalRecords", value => this.update({ records: value })],
                    ["statistics.records_archived", value => this.update({ records: value })],
                    ["statistics.species", value => this.update({ records: value })],
                    ["index.records", value => this.update({ records: value })],
                    ["index.count", value => this.update({ records: value })],
                    ["index.documents", value => this.update({ records: value })],
                    ["providers.active", value => this.update({ provider: value })],
                    ["providers.current", value => this.update({ provider: value })],
                    ["providers.selected", value => this.update({ provider: value })],
                    ["runtime.latency", value => this.update({ latency: value })]
                ];

                for (const [path, handler] of watches) {
                    const result = store.watch(path, handler);
                    if (typeof result === "function") {
                        this.stateUnsubscribers.push(result);
                    } else if (typeof store.unwatch === "function") {
                        this.stateUnsubscribers.push(() => store.unwatch(path, handler));
                    }
                }
            }

            this.refreshFromState(store);
        }

        refreshFromState(
            store =
                this.context.state ||
                this.context.stateStore ||
                this.context.services?.get?.(
                    "state"
                )
        ) {
            if (
                !store ||
                typeof store.get !==
                    "function"
            ) {
                return this;
            }

            const records =
                firstFinite(
                    store.get(
                        "statistics.records_archived"
                    ),
                    store.get(
                        "statistics.totalRecords"
                    ),
                    store.get(
                        "statistics.records"
                    ),
                    store.get(
                        "statistics.species"
                    ),
                    store.get(
                        "index.documents"
                    ),
                    store.get(
                        "index.records"
                    ),
                    store.get(
                        "index.count"
                    ),
                    this.state.records
                );

            const provider =
                store.get(
                    "providers.active"
                ) ??
                store.get(
                    "providers.current"
                ) ??
                store.get(
                    "providers.selected"
                ) ??
                store.get(
                    "library.active"
                ) ??
                this.state.provider;

            this.update({
                online:
                    store.get(
                        "runtime.online",
                        this.state.online
                    ),

                network:
                    store.get(
                        "runtime.online",
                        this.state.online
                    )
                        ? "online"
                        : "offline",

                version:
                    store.get(
                        "runtime.version",
                        this.state.version
                    ),

                busy:
                    store.get(
                        "terminal.busy",
                        this.state.busy
                    ),

                activity:
                    store.get(
                        "terminal.activity",
                        this.state.activity
                    ),

                progress:
                    store.get(
                        "terminal.progress",
                        this.state.progress
                    ),

                latency:
                    store.get(
                        "runtime.latency",
                        this.state.latency
                    ),

                records:
                    records ??
                    this.state.records,

                provider
            }, {
                source:
                    "state"
            });

            return this;
        }

        async hydrate() {
            if (this.destroyed) {
                return this.snapshot();
            }

            if (this.hydrationPromise) {
                return this.hydrationPromise;
            }

            /*
            --------------------------------------------------------------
            Schedule hydration on the promise queue before running the async
            body. The previous immediately-invoked async function referenced
            `pending` from its finally block before the const declaration had
            finished initializing, producing Firefox's TDZ ReferenceError:

                can't access lexical declaration 'pending'
                before initialization
            --------------------------------------------------------------
            */
            const hydration =
                Promise.resolve()
                    .then(
                        async () => {
                            this.refreshing =
                                true;

                            try {
                                this.refreshFromState();

                                const stats =
                                    this.context.stats ||
                                    this.context.services?.get?.(
                                        "stats"
                                    );

                                if (
                                    stats &&
                                    typeof stats.getRecordCount ===
                                        "function"
                                ) {
                                    try {
                                        const records =
                                            await stats.getRecordCount();

                                        this.update(
                                            {
                                                records
                                            },
                                            {
                                                source:
                                                    "stats"
                                            }
                                        );
                                    } catch (_error) {
                                        /* Continue with local services. */
                                    }
                                }

                                const index =
                                    this.context.index ||
                                    this.context.services?.get?.(
                                        "index"
                                    );

                                if (
                                    this.state.records <= 0 &&
                                    index
                                ) {
                                    try {
                                        const status =
                                            typeof index.status ===
                                                "function"
                                                ? await index.status()
                                                : index;

                                        const records =
                                            firstFinite(
                                                status?.documents,
                                                status?.records,
                                                status?.count,
                                                status?.total
                                            );

                                        if (records !== null) {
                                            this.update(
                                                {
                                                    records
                                                },
                                                {
                                                    source:
                                                        "index"
                                                }
                                            );
                                        }
                                    } catch (_error) {
                                        /* Optional service. */
                                    }
                                }

                                const manager =
                                    this.context.providerManager ||
                                    this.context.services?.get?.(
                                        "provider-manager"
                                    );

                                if (manager) {
                                    try {
                                        let active =
                                            manager.active?.() ||
                                            manager.current?.() ||
                                            null;

                                        if (
                                            active &&
                                            typeof active.then ===
                                                "function"
                                        ) {
                                            active =
                                                await active;
                                        }

                                        if (!active) {
                                            let listed =
                                                manager.list?.({
                                                    enabled:
                                                        true,
                                                    limit:
                                                        1
                                                }) ||
                                                [];

                                            if (
                                                listed &&
                                                typeof listed.then ===
                                                    "function"
                                            ) {
                                                listed =
                                                    await listed;
                                            }

                                            active =
                                                Array.isArray(listed)
                                                    ? listed[0] ||
                                                        null
                                                    : null;
                                        }

                                        if (active) {
                                            this.update(
                                                {
                                                    provider:
                                                        active.id ||
                                                        active.name ||
                                                        active.provider ||
                                                        this.state.provider
                                                },
                                                {
                                                    source:
                                                        "provider-manager"
                                                }
                                            );
                                        }
                                    } catch (_error) {
                                        /* Optional service. */
                                    }
                                }

                                this.metrics.refreshes +=
                                    1;

                                return this.snapshot();
                            } catch (_error) {
                                this.metrics.hydrationErrors +=
                                    1;

                                return this.snapshot();
                            } finally {
                                this.refreshing =
                                    false;
                            }
                        }
                    )
                    .finally(
                        () => {
                            if (
                                this.hydrationPromise ===
                                hydration
                            ) {
                                this.hydrationPromise =
                                    null;
                            }
                        }
                    );

            this.hydrationPromise =
                hydration;

            return hydration;
        }

        startRefreshTimer() {
            this.stopRefreshTimer();

            const interval =
                Math.max(
                    1000,
                    normalizeNumber(
                        this.options.refreshInterval,
                        5000
                    )
                );

            this.refreshTimer =
                window.setInterval(
                    () =>
                        this.hydrate(),
                    interval
                );

            return this;
        }

        stopRefreshTimer() {
            if (
                this.refreshTimer !==
                    null
            ) {
                window.clearInterval(
                    this.refreshTimer
                );

                this.refreshTimer =
                    null;
            }

            return this;
        }

        handleStateChange(event) {
            const detail = event?.detail || event || {};
            const path = normalizeString(detail.path);
            const value =
                detail.value ??
                detail.current ??
                detail.state;

            const mapping = {
                "runtime.online": () => ({ online: value, network: value ? "online" : "offline" }),
                "runtime.version": () => ({ version: value }),
                "runtime.latency": () => ({ latency: value }),
                "terminal.busy": () => ({ busy: value }),
                "terminal.activity": () => ({ activity: value }),
                "terminal.progress": () => ({ progress: value }),
                "statistics.records": () => ({ records: value }),
                "statistics.totalRecords": () => ({ records: value }),
                "statistics.records_archived": () => ({ records: value }),
                "statistics.species": () => ({ records: value }),
                "index.documents": () => ({ records: value }),
                "index.records": () => ({ records: value }),
                "index.count": () => ({ records: value }),
                "providers.active": () => ({ provider: value }),
                "providers.current": () => ({ provider: value }),
                "providers.selected": () => ({ provider: value }),
                "library.active": () => ({ provider: value })
            };

            this.metrics.stateEvents +=
                1;

            if (mapping[path]) {
                this.update(
                    mapping[path](),
                    {
                        source:
                            "state-event"
                    }
                );
            }
        }

        handleStatsUpdated(
            event
        ) {
            const detail =
                event?.detail ||
                event ||
                {};

            const records =
                firstFinite(
                    detail.records,
                    detail.totalRecords,
                    detail.records_archived,
                    detail.species,
                    detail.statistics?.records_archived,
                    detail.statistics?.records,
                    detail.statistics?.species,
                    detail.summary?.records_archived,
                    detail.summary?.records,
                    detail.summary?.species
                );

            this.metrics.statsEvents +=
                1;

            if (
                records !==
                    null
            ) {
                this.update({
                    records
                }, {
                    source:
                        "stats-event"
                });
            } else {
                this.hydrate();
            }
        }

        handleProviderChanged(event) {
            const detail =
                event?.detail ||
                event ||
                {};

            const provider =
                detail.provider?.id ||
                detail.provider?.name ||
                detail.provider ||
                detail.name ||
                detail.id ||
                detail.record?.provider ||
                null;

            this.metrics.providerEvents +=
                1;

            if (provider) {
                this.update({
                    provider
                }, {
                    source:
                        "provider-event"
                });
            }
        }

        handleLoadingChanged(event) {
            const detail =
                event?.detail ||
                event ||
                {};

            const task =
                detail.task ||
                detail;

            const ending =
                /(?:end|complete|fail|cancel)$/i.test(
                    event?.type ||
                    ""
                );

            this.metrics.loadingEvents +=
                1;

            this.update({
                busy:
                    ending
                        ? false
                        : task.busy ??
                            task.active ??
                            this.state.busy,

                activity:
                    ending
                        ? "idle"
                        : task.activity ??
                            task.label ??
                            task.message ??
                            this.state.activity,

                progress:
                    ending
                        ? null
                        : task.progress ??
                            task.percent ??
                            this.state.progress
            }, {
                source:
                    "loading-event"
            });
        }

        handleOnline() {
            this.update({ online: true, network: "online" });
        }

        handleOffline() {
            this.update({ online: false, network: "offline", latency: null });
        }

        handleVisibilityChange() {
            if (!document.hidden) {
                this.render(true);
            }
        }

        observeDOM() {
            if (this.observer || !document.documentElement) {
                return;
            }

            this.observer =
                new MutationObserver(
                    mutations => {
                        if (
                            this.renderQueued ||
                            this.destroyed
                        ) {
                            return;
                        }

                        const statusRoot =
                            this.elements.root;

                        const externalMutation =
                            mutations.some(
                                mutation =>
                                    !statusRoot ||
                                    !statusRoot.contains(
                                        mutation.target
                                    )
                            );

                        if (externalMutation) {
                            this.resolveElements();
                            this.scheduleRender();
                        }
                    }
                );

            this.observer.observe(document.documentElement, {
                childList: true,
                subtree: true
            });
        }

        startClock() {
            this.stopClock();

            const interval = Math.max(250, normalizeNumber(this.options.clockInterval, 1000));
            const tick = () => this.renderClock();

            tick();
            this.clockTimer = window.setInterval(tick, interval);
            return this;
        }

        stopClock() {
            if (this.clockTimer !== null) {
                window.clearInterval(this.clockTimer);
                this.clockTimer = null;
            }
            return this;
        }

        normalize(values = {}) {
            const normalized = {};

            if (Object.prototype.hasOwnProperty.call(values, "provider")) {
                normalized.provider = normalizeString(values.provider, DEFAULT_PROVIDER);
            }

            if (Object.prototype.hasOwnProperty.call(values, "records")) {
                normalized.records = Math.max(0, Math.trunc(normalizeNumber(values.records, 0)));
            }

            if (Object.prototype.hasOwnProperty.call(values, "network")) {
                normalized.network = normalizeString(values.network, DEFAULT_NETWORK).toLowerCase();
            }

            if (Object.prototype.hasOwnProperty.call(values, "version")) {
                normalized.version = normalizeString(values.version, DEFAULT_VERSION);
            }

            if (Object.prototype.hasOwnProperty.call(values, "activity")) {
                normalized.activity = normalizeString(values.activity, "idle");
            }

            if (Object.prototype.hasOwnProperty.call(values, "latency")) {
                const latency = normalizeNumber(values.latency, NaN);
                normalized.latency = Number.isFinite(latency) && latency >= 0 ? latency : null;
            }

            if (Object.prototype.hasOwnProperty.call(values, "progress")) {
                normalized.progress = clampProgress(values.progress);
            }

            if (Object.prototype.hasOwnProperty.call(values, "online")) {
                normalized.online = normalizeBoolean(values.online, false);
            }

            if (Object.prototype.hasOwnProperty.call(values, "busy")) {
                normalized.busy = normalizeBoolean(values.busy, false);
            }

            return normalized;
        }

        update(values = {}, options = {}) {
            if (this.destroyed || !isObject(values)) {
                return this.snapshot();
            }

            const normalized = this.normalize(values);
            const changed = {};

            for (const [key, value] of Object.entries(normalized)) {
                if (!Object.is(this.state[key], value)) {
                    changed[key] = {
                        previous: this.state[key],
                        value
                    };
                    this.state[key] = value;
                }
            }

            if (Object.keys(changed).length === 0) {
                return this.snapshot();
            }

            this.state.updatedAt =
                new Date().toISOString();

            this.metrics.updates +=
                1;

            if (!Object.prototype.hasOwnProperty.call(normalized, "network") &&
                Object.prototype.hasOwnProperty.call(normalized, "online")) {
                this.state.network = this.state.online ? "online" : "offline";
            }

            if (options.render !== false) {
                this.scheduleRender();
            }

            const detail = {
                changed: clone(changed),
                state: this.snapshot(),
                source: options.source || null
            };

            if (
                !this.activeEmits.has(
                    "change"
                )
            ) {
                this.activeEmits.add(
                    "change"
                );

                try {
                    safeDispatch(
                        this,
                        "change",
                        detail
                    );

                    safeDispatch(
                        this.context.root,
                        "speciedex:statusbar-updated",
                        detail,
                        {
                            bubbles:
                                true
                        }
                    );

                    /*
                    ------------------------------------------------------
                    A connected terminal root already bubbles this event to
                    document. Dispatch directly only for detached roots.
                    ------------------------------------------------------
                    */
                    if (
                        !this.context.root ||
                        !this.context.root.isConnected
                    ) {
                        safeDispatch(
                            document,
                            "speciedex:statusbar-updated",
                            detail
                        );
                    }

                    try {
                        this.context.events?.emit?.(
                            "statusbar:updated",
                            detail
                        );
                    } catch (_error) {
                        /* External event-bus failures are isolated. */
                    }
                } finally {
                    this.activeEmits.delete(
                        "change"
                    );
                }
            }

            return detail.state;
        }

        set(name, value, options = {}) {
            const key =
                normalizeString(name);

            if (
                !key ||
                RESERVED_KEYS.has(key)
            ) {
                throw new TypeError(
                    "A safe status-bar field name is required."
                );
            }

            return this.update(
                {
                    [key]:
                        value
                },
                options
            );
        }

        get(name, fallback) {
            const key =
                normalizeString(name);

            if (
                !key ||
                RESERVED_KEYS.has(key)
            ) {
                return fallback;
            }

            return Object.prototype.hasOwnProperty.call(this.state, key)
                ? this.state[key]
                : fallback;
        }

        snapshot() {
            return clone(this.state);
        }

        reset(options = {}) {
            const online = typeof navigator !== "undefined" ? Boolean(navigator.onLine) : false;
            this.state = Object.assign({}, DEFAULT_STATE, {
                online,
                network: online ? "online" : "offline",
                version: this.resolveInitialVersion(),
                updatedAt: new Date().toISOString()
            });

            if (options.render !== false) {
                this.render(true);
            }

            const detail = { state: this.snapshot() };
            safeDispatch(this, "reset", detail);
            safeDispatch(document, "speciedex:statusbar-reset", detail);

            return detail.state;
        }

        scheduleRender() {
            if (this.renderQueued || this.destroyed) {
                return;
            }

            this.renderQueued = true;
            const schedule = typeof window.requestAnimationFrame === "function"
                ? window.requestAnimationFrame.bind(window)
                : callback => window.setTimeout(callback, 0);

            schedule(() => {
                this.renderQueued = false;
                this.render();
            });
        }

        writeText(name, value, force = false) {
            const element = this.elements[name];
            if (!element) {
                return;
            }

            const text = String(value);
            if (!force && this.lastRendered[name] === text) {
                return;
            }

            element.textContent = text;
            this.lastRendered[name] = text;
        }

        renderProgress(force = false) {
            const element = this.elements.progress;
            if (!element) {
                return;
            }

            const progress = this.state.progress;
            const cacheValue = progress === null ? "indeterminate" : String(progress);
            if (!force && this.lastRendered.progress === cacheValue) {
                return;
            }

            if (
                typeof HTMLProgressElement ===
                    "function" &&
                element instanceof
                    HTMLProgressElement
            ) {
                if (progress === null) {
                    element.removeAttribute("value");
                } else {
                    element.max = 100;
                    element.value = progress;
                }
            } else {
                element.setAttribute("role", "progressbar");
                element.setAttribute("aria-valuemin", "0");
                element.setAttribute("aria-valuemax", "100");

                if (progress === null) {
                    element.removeAttribute(
                        "aria-valuenow"
                    );
                    element.dataset.indeterminate =
                        "true";
                    element.style.removeProperty(
                        "--status-progress"
                    );
                } else {
                    element.setAttribute("aria-valuenow", String(Math.round(progress)));
                    delete element.dataset.indeterminate;
                    element.style.setProperty("--status-progress", `${progress}%`);
                }
            }

            this.lastRendered.progress = cacheValue;
        }

        renderRoot(force = false) {
            const root = this.elements.root;
            if (!root) {
                return;
            }

            const status = [
                this.state.online ? "online" : "offline",
                this.state.busy ? "busy" : "idle"
            ].join(":");

            if (!force && this.lastRendered.root === status) {
                return;
            }

            root.dataset.network = this.state.network;
            root.dataset.online = String(this.state.online);
            root.dataset.busy = String(this.state.busy);
            root.dataset.activity = this.state.activity;
            root.setAttribute("aria-live", "polite");
            root.setAttribute("aria-atomic", "false");
            root.classList.toggle("is-online", this.state.online);
            root.classList.toggle("is-offline", !this.state.online);
            root.classList.toggle("is-busy", this.state.busy);
            root.classList.toggle("is-idle", !this.state.busy);

            this.lastRendered.root = status;
        }

        renderClock(force = false) {
            if (!this.elements.clock) {
                return;
            }
            this.writeText("clock", formatClock(), force);
        }

        render(force = false) {
            if (this.destroyed) {
                return this.snapshot();
            }

            if (!Object.values(this.elements).some(Boolean)) {
                this.resolveElements();
            }

            this.writeText("provider", this.state.provider, force);
            this.writeText("records", formatInteger(this.state.records), force);
            this.writeText("network", this.state.network, force);
            this.writeText("version", this.state.version, force);
            this.writeText("activity", this.state.activity, force);
            this.writeText("latency", formatLatency(this.state.latency), force);
            this.renderProgress(force);
            this.renderRoot(force);
            this.renderClock(force);

            this.metrics.renders +=
                1;

            const detail = {
                state:
                    this.snapshot(),
                elements:
                    this.elements
            };

            safeDispatch(
                this,
                "render",
                detail
            );

            return detail.state;
        }

        refresh() {
            this.resolveElements();
            this.refreshFromState();
            this.hydrate();

            return this.render(
                true
            );
        }

        status() {
            return {
                name: SERVICE_NAME,
                module: MODULE_NAME,
                bound: this.bound,
                destroyed: this.destroyed,
                clockRunning: this.clockTimer !== null,
                observingDOM:
                    this.observer !==
                    null,
                refreshTimer:
                    this.refreshTimer !==
                    null,
                refreshing:
                    this.refreshing,
                hydrationPending:
                    Boolean(
                        this.hydrationPromise
                    ),
                activeEmits:
                    this.activeEmits.size,
                metrics: {
                    ...this.metrics
                },
                elements: Object.fromEntries(
                    Object.entries(this.elements).map(([name, element]) => [name, Boolean(element)])
                ),
                state: this.snapshot()
            };
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            this.bound = false;

            this.stopClock();
            this.stopRefreshTimer();

            try {
                this.abortController.abort();
            } catch (_error) {
                /* Optional abort-controller implementation. */
            }

            if (this.observer) {
                this.observer.disconnect();
                this.observer = null;
            }

            for (
                const unsubscribe
                of this.stateUnsubscribers.splice(0)
            ) {
                try {
                    unsubscribe();
                } catch (_error) {
                    /* Continue cleanup. */
                }
            }

            for (
                const cleanup
                of this.cleanup.splice(0).reverse()
            ) {
                try {
                    cleanup();
                } catch (_error) {
                    /* Continue cleanup. */
                }
            }

            safeDispatch(
                this,
                "destroy",
                {
                    name:
                        SERVICE_NAME,
                    version:
                        VERSION
                }
            );

            if (
                this.context.root?.[
                    STATUSBAR_SYMBOL
                ] ===
                    this
            ) {
                delete this.context.root[
                    STATUSBAR_SYMBOL
                ];
            }

            if (
                this.context.statusbar ===
                    this
            ) {
                delete this.context.statusbar;
            }

            if (
                this.context.statusBar ===
                    this
            ) {
                delete this.context.statusBar;
            }

            this.hydrationPromise = null;
            this.activeEmits.clear();
            this.elements =
                Object.create(null);
            this.lastRendered =
                Object.create(null);
            this.destroyed = true;

            return true;
        }

    }

    function initialize(
        context = {},
        options = {}
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
            safeContext.statusbar instanceof
                StatusBar
                ? safeContext.statusbar
                : safeContext.statusBar instanceof
                    StatusBar
                    ? safeContext.statusBar
                    : safeContext.services?.get?.(
                        SERVICE_NAME
                    ) ||
                    root?.[
                        STATUSBAR_SYMBOL
                    ];

        if (
            existing instanceof StatusBar &&
            !existing.destroyed
        ) {
            safeContext.statusbar =
                existing;

            safeContext.statusBar =
                existing;

            safeContext.registerService?.(
                SERVICE_NAME,
                existing
            );

            existing.refresh();

            return existing;
        }

        const config =
            safeContext.config?.
                statusbar ||
            {};

        const dataset =
            root.dataset ||
            {};

        const resolvedOptions = {
            ...config,
            ...options,

            autoBind:
                options.autoBind ??
                config.autoBind ??
                normalizeBoolean(
                    dataset.
                        terminalStatusbarAutoBind,
                    true
                ),

            autoClock:
                options.autoClock ??
                config.autoClock ??
                normalizeBoolean(
                    dataset.
                        terminalStatusbarClock,
                    true
                ),

            observeDOM:
                options.observeDOM ??
                config.observeDOM ??
                normalizeBoolean(
                    dataset.
                        terminalStatusbarObserveDom,
                    true
                ),

            autoHydrate:
                options.autoHydrate ??
                config.autoHydrate ??
                normalizeBoolean(
                    dataset.
                        terminalStatusbarHydrate,
                    true
                ),

            refreshInterval:
                options.refreshInterval ??
                config.refreshInterval ??
                normalizeNumber(
                    dataset.
                        terminalStatusbarRefreshInterval,
                    5000
                )
        };

        const bar =
            new StatusBar(
                {
                    ...safeContext,
                    root
                },
                resolvedOptions
            );

        root[
            STATUSBAR_SYMBOL
        ] =
            bar;

        safeContext.statusbar =
            bar;

        safeContext.statusBar =
            bar;

        safeContext.registerService?.(
            SERVICE_NAME,
            bar
        );

        safeDispatch(
            document,
            "speciedex:statusbar-ready",
            {
                name:
                    MODULE_NAME,
                service:
                    bar
            }
        );

        try {
            safeContext.events?.emit?.(
                "statusbar:ready",
                bar
            );
        } catch (_error) {
            /* External event-bus failures are isolated. */
        }

        return bar;
    }

    function resolveCommandContext(
        payload = {}
    ) {
        return (
            payload.context ||
            payload.terminal?.context ||
            payload.app?.context ||
            payload
        );
    }

    function requireStatusbar(
        context = {}
    ) {
        const safeContext =
            isObject(context)
                ? context
                : {};

        const service =
            safeContext.statusbar ||
            safeContext.statusBar ||
            safeContext.services?.get?.(
                SERVICE_NAME
            ) ||
            initialize(
                safeContext
            );

        if (
            !(service instanceof StatusBar) ||
            service.destroyed
        ) {
            throw new Error(
                "Status-bar service is unavailable."
            );
        }

        return service;
    }

    function writeResult(
        payload,
        value,
        type = "data"
    ) {
        if (
            typeof payload.writeJSON ===
                "function" &&
            typeof value !==
                "string"
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
                typeof value ===
                    "string"
                    ? value
                    : JSON.stringify(
                        clone(value),
                        null,
                        2
                    ),
                type
            );
        }

        if (
            typeof payload.writeLine ===
                "function"
        ) {
            return payload.writeLine(
                typeof value ===
                    "string"
                    ? value
                    : JSON.stringify(
                        clone(value),
                        null,
                        2
                    )
            );
        }

        return value;
    }

    const commands = [
        {
            name:
                "statusbar-status",

            category:
                "system",

            description:
                "Display status-bar state and diagnostics.",

            usage:
                "statusbar-status",

            handler: ({
                context,
                writeJSON
            }) =>
                writeJSON(
                    context.statusbar?.
                        status?.() ||
                    null
                )
        },

        {
            name:
                "statusbar-refresh",

            category:
                "system",

            description:
                "Refresh status-bar values from live terminal services.",

            usage:
                "statusbar-refresh",

            handler: async ({
                context,
                writeJSON
            }) => {
                const bar =
                    context.statusbar;

                if (!bar) {
                    throw new Error(
                        "Status-bar service is unavailable."
                    );
                }

                await bar.hydrate();

                return writeJSON(
                    bar.status()
                );
            }
        }
    ];

    for (
        const command
        of commands
    ) {
        const handler =
            command.handler;

        command.handler =
            payload => {
                const safePayload =
                    isObject(payload)
                        ? payload
                        : {};

                safePayload.context =
                    resolveCommandContext(
                        safePayload
                    );

                const service =
                    requireStatusbar(
                        safePayload.context
                    );

                safePayload.context.statusbar =
                    service;

                safePayload.context.statusBar =
                    service;

                safePayload.args =
                    Array.isArray(
                        safePayload.args
                    )
                        ? [
                            ...safePayload.args
                        ]
                        : [];

                safePayload.writeJSON =
                    typeof safePayload.writeJSON ===
                        "function"
                        ? safePayload.writeJSON
                        : value =>
                            writeResult(
                                safePayload,
                                value
                            );

                safePayload.write =
                    typeof safePayload.write ===
                        "function"
                        ? safePayload.write
                        : (
                            value,
                            type
                        ) =>
                            writeResult(
                                safePayload,
                                value,
                                type
                            );

                return handler(
                    safePayload
                );
            };
    }

    const api = Object.freeze({
        name: MODULE_NAME,
        version: VERSION,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        STATUSBAR_SYMBOL,
        StatusBar,
        firstFinite,
        normalizeString,
        normalizeNumber,
        normalizeBoolean,
        formatInteger,
        formatLatency,
        formatClock,
        clampProgress,
        safeDispatch,
        resolveCommandContext,
        commands
    });

    window.SpeciedexTerminalStatusbar = api;
    window.SpeciedexTerminalStatusBar = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    safeDispatch(document, "speciedex:terminal-module-available", {
        name: MODULE_NAME,
        module: api
    });
})(window, document);