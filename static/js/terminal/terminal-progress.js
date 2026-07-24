/*
========================================================================
Speciedex.org
Terminal Progress Renderer
========================================================================

Progress rendering and coordination service for SpeciedexTerminal.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Progress";
    const VERSION = "2.2.0";
    const COORDINATOR_SYMBOL =
        Symbol.for(
            "speciedex.terminal.progress.coordinator"
        );

    const PRIMARY_COLOR = "#c0d674";
    const ACCENT_COLOR = "#e6a42b";
    const TERMINAL_STATES = new Set([
        "success",
        "warning",
        "error",
        "cancelled"
    ]);
    const ACTIVE_STATES = new Set([
        "running",
        "paused"
    ]);
    const STATES = Object.freeze([
        "idle",
        "running",
        "paused",
        "success",
        "warning",
        "error",
        "cancelled"
    ]);
    const DEFAULT_OPTIONS = Object.freeze({
        minimum: 0,
        maximum: 100,
        value: 0,
        label: "Progress",
        description: "",
        indeterminate: false,
        cancellable: false,
        showValue: true,
        showPercent: true,
        showElapsed: true,
        showRemaining: true,
        showDescription: true,
        animated: true,
        striped: false,
        compact: false,
        weight: 1,
        historyLimit: 500,
        integrateLoading: true,
        injectStyles: true,
        tickerInterval: 250,
        maximumTasks: 5000,
        retainCompletedTasks: true
    });

    function clamp(value, minimum, maximum) {
        return Math.min(maximum, Math.max(minimum, value));
    }

    function clampInteger(
        value,
        fallback,
        minimum = Number.MIN_SAFE_INTEGER,
        maximum = Number.MAX_SAFE_INTEGER
    ) {
        const parsed = Number.parseInt(value, 10);

        if (!Number.isFinite(parsed)) {
            return clamp(
                Number.parseInt(fallback, 10) || 0,
                minimum,
                maximum
            );
        }

        return clamp(parsed, minimum, maximum);
    }

    function parseNumber(value, fallback = 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function parseBoolean(value, fallback = false) {
        if (typeof value === "boolean") {
            return value;
        }

        if (value === undefined || value === null || value === "") {
            return fallback;
        }

        const normalized = String(value).trim().toLowerCase();

        if (["1", "true", "yes", "on", "enabled"].includes(normalized)) {
            return true;
        }

        if (["0", "false", "no", "off", "disabled"].includes(normalized)) {
            return false;
        }

        return fallback;
    }

    function normalizeState(value, fallback = "idle") {
        const normalized = String(value ?? "")
            .trim()
            .toLowerCase();

        return STATES.includes(normalized)
            ? normalized
            : fallback;
    }

    function normalizeID(value) {
        const id = String(value ?? "").trim();

        if (!id) {
            throw new Error("Progress task ID is required.");
        }

        return id;
    }

    function makeID() {
        if (typeof window.crypto?.randomUUID === "function") {
            return window.crypto.randomUUID();
        }

        return `progress:${Date.now()}:${Math.random()
            .toString(16)
            .slice(2)}`;
    }

    function timestamp() {
        return new Date().toISOString();
    }

    function formatDuration(milliseconds) {
        const value = Math.max(0, Number(milliseconds) || 0);

        if (value < 1000) {
            return `${Math.round(value)}ms`;
        }

        const totalSeconds = Math.floor(value / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        if (hours) {
            return [
                hours,
                String(minutes).padStart(2, "0"),
                String(seconds).padStart(2, "0")
            ].join(":");
        }

        return [
            minutes,
            String(seconds).padStart(2, "0")
        ].join(":");
    }

    function estimateRemaining(
        minimum,
        maximum,
        value,
        elapsed
    ) {
        const range = maximum - minimum;

        if (range <= 0 || elapsed <= 0) {
            return null;
        }

        const completed = value - minimum;

        if (completed <= 0) {
            return null;
        }

        const ratio = completed / range;

        if (ratio >= 1) {
            return 0;
        }

        if (ratio <= 0) {
            return null;
        }

        return Math.max(0, elapsed / ratio - elapsed);
    }

    function serializeTask(task) {
        return {
            id: task.id,
            label: task.label,
            description: task.description,
            minimum: task.minimum,
            maximum: task.maximum,
            value: task.value,
            percent: task.percent,
            state: task.state,
            indeterminate: task.indeterminate,
            cancellable: task.cancellable,
            weight: task.weight,
            startedAt: task.startedAt,
            startedAtISO: task.startedAtISO,
            updatedAt: task.updatedAt,
            updatedAtISO: task.updatedAtISO,
            completedAt: task.completedAt,
            completedAtISO: task.completedAtISO,
            elapsed: task.elapsed,
            remaining: task.remaining,
            metadata: { ...task.metadata },
            error: task.error ? { ...task.error } : null
        };
    }

    function safeDispatch(target, name, detail, options = {}) {
        if (!target || typeof target.dispatchEvent !== "function") {
            return false;
        }

        try {
            return target.dispatchEvent(new CustomEvent(name, {
                bubbles: options.bubbles === true,
                cancelable: options.cancelable === true,
                detail
            }));
        } catch (_error) {
            return false;
        }
    }

    function writeJSONValue(writeJSON, value) {
        return typeof writeJSON === "function"
            ? writeJSON(value)
            : value;
    }

    function writeValue(write, value, type = "data") {
        return typeof write === "function"
            ? write(value, type)
            : value;
    }

    function injectProgressStyles() {
        if (document.getElementById("speciedex-terminal-progress-styles")) {
            return false;
        }

        const style = document.createElement("style");
        style.id = "speciedex-terminal-progress-styles";
        style.textContent = `
            .terminal-progress {
                --progress-color: ${PRIMARY_COLOR};
                --progress-accent: ${ACCENT_COLOR};
                background: rgba(4, 10, 6, 0.9);
                border: 1px solid rgba(192, 214, 116, 0.2);
                color: #d8e6db;
                display: grid;
                font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular,
                    Consolas, monospace;
                gap: 0.42rem;
                padding: 0.7rem 0.8rem;
                width: 100%;
            }

            .terminal-progress[data-compact="true"] {
                gap: 0.28rem;
                padding: 0.48rem 0.58rem;
            }

            .terminal-progress-header {
                align-items: center;
                display: flex;
                gap: 1rem;
                justify-content: space-between;
            }

            .terminal-progress-title {
                color: var(--progress-color);
                font-size: 0.76rem;
                letter-spacing: 0.04em;
                overflow-wrap: anywhere;
            }

            .terminal-progress-value {
                color: rgba(216, 230, 219, 0.75);
                font-size: 0.7rem;
                white-space: nowrap;
            }

            .terminal-progress-track {
                background: rgba(216, 230, 219, 0.055);
                border: 1px solid rgba(192, 214, 116, 0.16);
                height: 0.72rem;
                overflow: hidden;
                position: relative;
            }

            .terminal-progress-bar {
                background: linear-gradient(
                    90deg,
                    rgba(192, 214, 116, 0.72),
                    var(--progress-color)
                );
                box-shadow: 0 0 0.7rem rgba(192, 214, 116, 0.32);
                display: block;
                height: 100%;
                transition: width 160ms ease;
                width: 0;
            }

            .terminal-progress[data-animated="true"]
            .terminal-progress-bar {
                animation: speciedex-terminal-progress-shift
                    1.25s linear infinite;
                background-size: 200% 100%;
            }

            .terminal-progress[data-striped="true"]
            .terminal-progress-bar {
                background-image:
                    linear-gradient(
                        135deg,
                        rgba(255, 255, 255, 0.18) 25%,
                        transparent 25%,
                        transparent 50%,
                        rgba(255, 255, 255, 0.18) 50%,
                        rgba(255, 255, 255, 0.18) 75%,
                        transparent 75%,
                        transparent
                    ),
                    linear-gradient(
                        90deg,
                        rgba(192, 214, 116, 0.72),
                        var(--progress-color)
                    );
                background-size: 1rem 1rem, 200% 100%;
            }

            .terminal-progress[data-indeterminate="true"]
            .terminal-progress-bar {
                animation: speciedex-terminal-progress-indeterminate
                    1.15s ease-in-out infinite;
                width: 36% !important;
            }

            .terminal-progress[data-state="success"] {
                --progress-color: #c0d674;
            }

            .terminal-progress[data-state="warning"] {
                --progress-color: #e6a42b;
            }

            .terminal-progress[data-state="error"] {
                --progress-color: #ff7d73;
            }

            .terminal-progress[data-state="cancelled"] {
                --progress-color: #9ca3af;
            }

            .terminal-progress[data-state="paused"] {
                --progress-color: #7fc8ff;
            }

            .terminal-progress-description {
                color: rgba(216, 230, 219, 0.68);
                font-size: 0.67rem;
                line-height: 1.45;
                margin: 0;
            }

            .terminal-progress-meta {
                color: rgba(216, 230, 219, 0.56);
                display: flex;
                flex-wrap: wrap;
                font-size: 0.64rem;
                gap: 0.65rem;
            }

            .terminal-progress-actions {
                display: flex;
                gap: 0.4rem;
                justify-content: flex-end;
            }

            .terminal-progress-cancel {
                background: rgba(4, 10, 6, 0.8);
                border: 1px solid rgba(230, 164, 43, 0.42);
                color: var(--progress-accent);
                cursor: pointer;
                font: inherit;
                font-size: 0.65rem;
                padding: 0.28rem 0.46rem;
            }

            .terminal-progress-list {
                display: grid;
                gap: 0.6rem;
            }

            @keyframes speciedex-terminal-progress-shift {
                to { background-position: -200% 0; }
            }

            @keyframes speciedex-terminal-progress-indeterminate {
                0% { transform: translateX(-120%); }
                50% { transform: translateX(90%); }
                100% { transform: translateX(300%); }
            }

            @media (prefers-reduced-motion: reduce) {
                .terminal-progress-bar {
                    transition: none;
                }

                .terminal-progress[data-animated="true"]
                .terminal-progress-bar,
                .terminal-progress[data-indeterminate="true"]
                .terminal-progress-bar {
                    animation-duration: 3s;
                }
            }
        `;

        document.head.appendChild(style);
        return true;
    }

    class ProgressView extends EventTarget {
        constructor(task, options = {}) {
            super();

            this.task = task;
            this.options = {
                ...DEFAULT_OPTIONS,
                ...options
            };
            this.destroyed = false;
            this.abortController =
                new AbortController();

            if (this.options.injectStyles) {
                injectProgressStyles();
            }

            this.element = this.build();
            this.update(task);
        }

        build() {
            const wrapper = document.createElement("section");
            wrapper.className = "terminal-progress";
            wrapper.dataset.progressId = this.task.id;
            wrapper.dataset.compact = String(this.options.compact === true);
            wrapper.dataset.animated = String(this.options.animated !== false);
            wrapper.dataset.striped = String(this.options.striped === true);
            wrapper.setAttribute("role", "progressbar");

            const header = document.createElement("header");
            header.className = "terminal-progress-header";

            const title = document.createElement("span");
            title.className = "terminal-progress-title";
            title.dataset.progressTitle = "";

            const value = document.createElement("span");
            value.className = "terminal-progress-value";
            value.dataset.progressValue = "";

            header.append(title, value);

            const track = document.createElement("div");
            track.className = "terminal-progress-track";

            const bar = document.createElement("span");
            bar.className = "terminal-progress-bar";
            bar.dataset.progressBar = "";
            track.appendChild(bar);

            const description = document.createElement("p");
            description.className = "terminal-progress-description";
            description.dataset.progressDescription = "";

            const meta = document.createElement("div");
            meta.className = "terminal-progress-meta";

            const elapsed = document.createElement("span");
            elapsed.dataset.progressElapsed = "";

            const remaining = document.createElement("span");
            remaining.dataset.progressRemaining = "";

            const state = document.createElement("span");
            state.dataset.progressState = "";

            meta.append(elapsed, remaining, state);

            const actions = document.createElement("div");
            actions.className = "terminal-progress-actions";

            const cancel = document.createElement("button");
            cancel.type = "button";
            cancel.className = "terminal-progress-cancel";
            cancel.dataset.progressCancel = "";
            cancel.textContent = "Cancel";
            cancel.addEventListener(
                "click",
                () => {
                    safeDispatch(
                        this,
                        "cancel",
                        {
                            task:
                                serializeTask(
                                    this.task
                                )
                        }
                    );
                },
                {
                    signal:
                        this.abortController.signal
                }
            );
            actions.appendChild(cancel);

            wrapper.append(
                header,
                track,
                description,
                meta,
                actions
            );

            this.elements = {
                wrapper,
                title,
                value,
                bar,
                description,
                elapsed,
                remaining,
                state,
                actions,
                cancel
            };

            return wrapper;
        }

        update(task = this.task) {
            if (this.destroyed) {
                return this;
            }

            this.task = task;

            const {
                wrapper,
                title,
                value,
                bar,
                description,
                elapsed,
                remaining,
                state,
                actions,
                cancel
            } = this.elements;

            wrapper.dataset.state = task.state;
            wrapper.dataset.indeterminate = String(task.indeterminate);
            wrapper.setAttribute("aria-valuemin", String(task.minimum));
            wrapper.setAttribute("aria-valuemax", String(task.maximum));

            if (task.indeterminate) {
                wrapper.removeAttribute("aria-valuenow");
                wrapper.setAttribute(
                    "aria-valuetext",
                    `${task.label}: indeterminate`
                );
            } else {
                wrapper.setAttribute("aria-valuenow", String(task.value));
                wrapper.setAttribute(
                    "aria-valuetext",
                    `${task.label}: ${Math.round(task.percent)}%`
                );
            }

            title.textContent = task.label;
            value.hidden = !this.options.showValue;
            value.textContent = task.indeterminate
                ? task.state
                : this.options.showPercent
                    ? `${Math.round(task.percent)}%`
                    : `${task.value} / ${task.maximum}`;

            bar.style.width = task.indeterminate
                ? "36%"
                : `${clamp(task.percent, 0, 100)}%`;

            description.hidden =
                !this.options.showDescription ||
                !task.description;
            description.textContent = task.description;

            elapsed.hidden = !this.options.showElapsed;
            elapsed.textContent =
                `Elapsed: ${formatDuration(task.elapsed)}`;

            remaining.hidden =
                !this.options.showRemaining ||
                task.remaining === null;
            remaining.textContent =
                task.remaining === null
                    ? ""
                    : `Remaining: ${formatDuration(task.remaining)}`;

            state.textContent = `State: ${task.state}`;
            actions.hidden =
                !task.cancellable ||
                !ACTIVE_STATES.has(task.state);
            cancel.disabled = actions.hidden;

            return this;
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            this.abortController.abort();
            this.element.remove();
            this.destroyed = true;
            safeDispatch(this, "destroy", {});
            return true;
        }
    }

    class ProgressCoordinator extends EventTarget {
        constructor(context, options = {}) {
            super();

            if (!context || typeof context !== "object") {
                throw new TypeError(
                    "ProgressCoordinator requires a terminal context."
                );
            }

            this.context = context;
            this.options = {
                ...DEFAULT_OPTIONS,
                ...options,
                historyLimit: clampInteger(
                    options.historyLimit,
                    DEFAULT_OPTIONS.historyLimit,
                    10,
                    10000
                ),

                tickerInterval:
                    clampInteger(
                        options.tickerInterval,
                        DEFAULT_OPTIONS.tickerInterval,
                        50,
                        5000
                    ),

                maximumTasks:
                    clampInteger(
                        options.maximumTasks,
                        DEFAULT_OPTIONS.maximumTasks,
                        1,
                        100000
                    ),

                retainCompletedTasks:
                    parseBoolean(
                        options.retainCompletedTasks,
                        DEFAULT_OPTIONS.retainCompletedTasks
                    )
            };
            this.tasks = new Map();
            this.history = [];
            this.archived = new Set();
            this.views = new Map();
            this.ticker = 0;
            this.lastTick = 0;
            this.destroyed = false;
            this.loadingIntegrationDepth = 0;
            this.metrics = {
                created: 0,
                updated: 0,
                completed: 0,
                failed: 0,
                cancelled: 0,
                removed: 0,
                loadingCalls: 0,
                loadingErrors: 0,
                tickerFrames: 0,
                tickerUpdates: 0
            };

            if (this.options.injectStyles) {
                injectProgressStyles();
            }
        }

        assertAvailable() {
            if (this.destroyed) {
                throw new Error(
                    "Progress coordinator has been destroyed."
                );
            }
        }

        create(id = makeID(), label = DEFAULT_OPTIONS.label, options = {}) {
            this.assertAvailable();

            const taskID = normalizeID(id);

            if (this.tasks.has(taskID)) {
                throw new Error(
                    `Progress task already exists: ${taskID}`
                );
            }

            if (
                this.tasks.size >=
                this.options.maximumTasks
            ) {
                throw new Error(
                    `Progress task limit reached: ${this.options.maximumTasks}`
                );
            }

            const minimum = parseNumber(
                options.minimum,
                DEFAULT_OPTIONS.minimum
            );
            const maximum = parseNumber(
                options.maximum,
                DEFAULT_OPTIONS.maximum
            );

            if (maximum <= minimum) {
                throw new RangeError(
                    "Progress maximum must be greater than minimum."
                );
            }

            const current = performance.now();
            const initialValue = clamp(
                parseNumber(options.value, minimum),
                minimum,
                maximum
            );
            const state = normalizeState(
                options.state || "running",
                "running"
            );

            const task = {
                id: taskID,
                label: String(label || taskID),
                description: String(options.description || ""),
                minimum,
                maximum,
                value: initialValue,
                percent:
                    ((initialValue - minimum) /
                    (maximum - minimum)) * 100,
                state,
                indeterminate: parseBoolean(
                    options.indeterminate,
                    false
                ),
                cancellable: parseBoolean(
                    options.cancellable,
                    false
                ),
                weight: Math.max(
                    0,
                    parseNumber(
                        options.weight,
                        DEFAULT_OPTIONS.weight
                    )
                ),
                startedAt: current,
                startedAtISO: timestamp(),
                updatedAt: current,
                updatedAtISO: timestamp(),
                completedAt: null,
                completedAtISO: null,
                pausedAt: null,
                pausedDuration: 0,
                elapsed: 0,
                remaining: null,
                metadata:
                    options.metadata &&
                    typeof options.metadata === "object"
                        ? { ...options.metadata }
                        : {},
                error: null,
                abortController: options.abortController || null
            };

            this.tasks.set(taskID, task);
            this.archived.delete(taskID);
            this.metrics.created += 1;
            this.updateTiming(task);

            if (TERMINAL_STATES.has(task.state)) {
                task.completedAt = current;
                task.completedAtISO = timestamp();
                this.archive(task);
            } else {
                this.ensureTicker();
            }

            this.integrateLoadingBegin(task);
            this.emit("create", task);
            this.updateAggregate();

            return task;
        }

        begin(id, label = id, options = {}) {
            return this.create(id, label, {
                ...options,
                state: "running"
            });
        }

        get(id) {
            return this.tasks.get(normalizeID(id)) || null;
        }

        set(id, value, options = {}) {
            const task = this.get(id);

            if (!task) {
                throw new Error(`Unknown progress task: ${id}`);
            }

            if (TERMINAL_STATES.has(task.state)) {
                return task;
            }

            if (options.indeterminate !== undefined) {
                task.indeterminate = parseBoolean(
                    options.indeterminate,
                    task.indeterminate
                );
            }

            if (value !== undefined && value !== null) {
                task.value = clamp(
                    parseNumber(value, task.value),
                    task.minimum,
                    task.maximum
                );
                task.indeterminate = false;
            }

            if (options.label !== undefined) {
                task.label = String(options.label);
            }

            if (options.description !== undefined) {
                task.description = String(options.description);
            }

            if (options.state !== undefined) {
                task.state = normalizeState(
                    options.state,
                    task.state
                );
            }

            if (
                options.metadata &&
                typeof options.metadata === "object"
            ) {
                task.metadata = {
                    ...task.metadata,
                    ...options.metadata
                };
            }

            task.percent =
                ((task.value - task.minimum) /
                (task.maximum - task.minimum)) * 100;
            task.updatedAt = performance.now();
            task.updatedAtISO = timestamp();
            this.updateTiming(task);

            if (
                task.value >= task.maximum &&
                options.complete !== false
            ) {
                return this.complete(id, options.result);
            }

            if (TERMINAL_STATES.has(task.state)) {
                return this.finish(
                    task,
                    task.state,
                    options.result
                );
            }

            this.metrics.updated += 1;
            this.ensureTicker();
            this.updateView(task);
            this.integrateLoadingUpdate(task);
            this.emit("update", task);
            this.updateAggregate();

            return task;
        }

        increment(id, amount = 1, options = {}) {
            const task = this.get(id);

            if (!task) {
                throw new Error(`Unknown progress task: ${id}`);
            }

            return this.set(
                id,
                task.value + parseNumber(amount, 1),
                options
            );
        }

        pause(id) {
            const task = this.get(id);

            if (!task || task.state !== "running") {
                return false;
            }

            task.state = "paused";
            task.pausedAt = performance.now();
            task.updatedAt = task.pausedAt;
            task.updatedAtISO = timestamp();

            this.updateTiming(task);
            this.updateView(task);
            this.emit("pause", task);
            this.updateAggregate();

            return true;
        }

        resume(id) {
            const task = this.get(id);

            if (!task || task.state !== "paused") {
                return false;
            }

            const current = performance.now();

            if (task.pausedAt !== null) {
                task.pausedDuration += current - task.pausedAt;
            }

            task.pausedAt = null;
            task.state = "running";
            task.updatedAt = current;
            task.updatedAtISO = timestamp();

            this.updateTiming(task);
            this.updateView(task);
            this.ensureTicker();
            this.emit("resume", task);
            this.updateAggregate();

            return true;
        }

        finish(task, state, result = null, error = null) {
            if (TERMINAL_STATES.has(task.state) && task.completedAt !== null) {
                return task;
            }

            const current = performance.now();

            task.state = state;
            task.completedAt = current;
            task.completedAtISO = timestamp();
            task.updatedAt = current;
            task.updatedAtISO = task.completedAtISO;

            if (state === "success") {
                task.value = task.maximum;
                task.percent = 100;
                task.remaining = 0;
            }

            if (result !== undefined) {
                task.metadata = {
                    ...task.metadata,
                    result
                };
            }

            if (error !== null) {
                const normalized =
                    error instanceof Error
                        ? error
                        : new Error(String(error));

                task.error = {
                    name: normalized.name,
                    message: normalized.message,
                    stack: normalized.stack || null
                };
            }

            this.updateTiming(task);
            this.updateView(task);
            this.archive(task);

            if (state === "success") {
                this.metrics.completed += 1;
                this.integrateLoadingEnd(task);
                this.emit("complete", task);
            } else if (state === "error") {
                this.metrics.failed += 1;
                this.integrateLoadingFail(task, error);
                this.emit("fail", task);
            } else if (state === "cancelled") {
                this.metrics.cancelled += 1;
                this.integrateLoadingCancel(task);
                this.emit("cancel", task);
            } else {
                this.integrateLoadingEnd(task);
                this.emit(state, task);
            }

            this.updateAggregate();

            if (
                !this.options.retainCompletedTasks
            ) {
                window.queueMicrotask(
                    () => {
                        if (!this.destroyed) {
                            this.remove(
                                task.id
                            );
                        }
                    }
                );
            }

            return task;
        }

        complete(id, result = null) {
            const task = this.get(id);
            return task
                ? this.finish(task, "success", result)
                : null;
        }

        warn(id, message = "") {
            const task = this.get(id);

            if (!task) {
                return null;
            }

            if (message) {
                task.description = String(message);
            }

            return this.finish(task, "warning");
        }

        fail(id, error) {
            const task = this.get(id);
            return task
                ? this.finish(task, "error", null, error)
                : null;
        }

        cancel(id, reason = "cancelled") {
            const task = this.get(id);

            if (!task) {
                return null;
            }

            try {
                task.abortController?.abort?.(reason);
            } catch (_error) {
                task.abortController?.abort?.();
            }

            task.metadata = {
                ...task.metadata,
                reason
            };

            return this.finish(task, "cancelled");
        }

        remove(id) {
            const taskID = normalizeID(id);
            const task = this.tasks.get(taskID);

            if (!task) {
                return false;
            }

            this.tasks.delete(taskID);
            this.archived.delete(taskID);

            const taskViews =
                this.views.get(
                    taskID
                );

            if (
                taskViews instanceof
                    Set
            ) {
                for (
                    const view of
                    taskViews
                ) {
                    view.destroy?.();
                }
            } else {
                taskViews?.destroy?.();
            }

            this.views.delete(taskID);
            this.metrics.removed += 1;

            this.emit("remove", task);
            this.updateAggregate();
            return true;
        }

        clear(options = {}) {
            const includeRunning = options.includeRunning === true;
            const ids = [...this.tasks.values()]
                .filter((task) =>
                    includeRunning ||
                    !ACTIVE_STATES.has(task.state)
                )
                .map((task) => task.id);

            for (const id of ids) {
                this.remove(id);
            }

            return ids.length;
        }

        updateTiming(task) {
            const current =
                task.completedAt ??
                performance.now();

            let paused = task.pausedDuration;

            if (
                task.state === "paused" &&
                task.pausedAt !== null
            ) {
                paused += current - task.pausedAt;
            }

            task.elapsed = Math.max(
                0,
                current - task.startedAt - paused
            );
            task.remaining = task.indeterminate
                ? null
                : estimateRemaining(
                    task.minimum,
                    task.maximum,
                    task.value,
                    task.elapsed
                );
        }

        ensureTicker() {
            if (
                this.ticker ||
                this.destroyed
            ) {
                return;
            }

            this.lastTick =
                performance.now();

            const tick =
                now => {
                    this.metrics.tickerFrames +=
                        1;

                    if (this.destroyed) {
                        this.ticker =
                            0;

                        return;
                    }

                    let active =
                        false;

                    const elapsed =
                        now -
                        this.lastTick;

                    if (
                        elapsed >=
                        this.options.tickerInterval
                    ) {
                        this.lastTick =
                            now;

                        for (
                            const task of
                            this.tasks.values()
                        ) {
                            if (
                                ACTIVE_STATES.has(
                                    task.state
                                )
                            ) {
                                active =
                                    true;

                                this.updateTiming(
                                    task
                                );

                                this.updateView(
                                    task
                                );
                            }
                        }

                        this.metrics.tickerUpdates +=
                            1;
                    } else {
                        active =
                            Array.from(
                                this.tasks.values()
                            ).some(
                                task =>
                                    ACTIVE_STATES.has(
                                        task.state
                                    )
                            );
                    }

                    this.ticker =
                        active
                            ? window.requestAnimationFrame(
                                tick
                            )
                            : 0;
                };

            this.ticker =
                window.requestAnimationFrame(
                    tick
                );
        }

        createView(
            id,
            options = {}
        ) {
            const task =
                this.get(
                    id
                );

            if (!task) {
                throw new Error(
                    `Unknown progress task: ${id}`
                );
            }

            const view =
                new ProgressView(
                    task,
                    {
                        ...this.options,
                        ...options
                    }
                );

            view.addEventListener(
                "cancel",
                () => {
                    this.cancel(
                        task.id,
                        "user"
                    );
                }
            );

            if (
                !this.views.has(
                    task.id
                )
            ) {
                this.views.set(
                    task.id,
                    new Set()
                );
            }

            this.views.get(
                task.id
            ).add(
                view
            );

            view.addEventListener(
                "destroy",
                () => {
                    const collection =
                        this.views.get(
                            task.id
                        );

                    collection?.delete(
                        view
                    );

                    if (
                        collection?.size ===
                            0
                    ) {
                        this.views.delete(
                            task.id
                        );
                    }
                },
                {
                    once:
                        true
                }
            );

            return view;
        }

        updateView(task) {
            const taskViews =
                this.views.get(
                    task.id
                );

            if (
                taskViews instanceof
                    Set
            ) {
                for (
                    const view of
                    taskViews
                ) {
                    view.update?.(
                        task
                    );
                }
            } else {
                taskViews?.update?.(
                    task
                );
            }
        }

        renderList(options = {}) {
            const container = document.createElement("div");
            container.className = "terminal-progress-list";

            const stateFilter = Array.isArray(options.states)
                ? new Set(options.states.map((state) =>
                    normalizeState(state)
                ))
                : null;

            const tasks = [...this.tasks.values()]
                .filter((task) =>
                    !stateFilter ||
                    stateFilter.has(task.state)
                )
                .sort((left, right) =>
                    left.startedAt - right.startedAt
                );

            for (const task of tasks) {
                container.appendChild(
                    this.createView(task.id, options).element
                );
            }

            Object.defineProperty(container, "controller", {
                configurable: false,
                enumerable: false,
                value: this
            });

            return container;
        }

        aggregate() {
            const active = [...this.tasks.values()]
                .filter((task) => ACTIVE_STATES.has(task.state));
            const determinate = active.filter(
                (task) => !task.indeterminate
            );
            const totalWeight = determinate.reduce(
                (total, task) => total + task.weight,
                0
            );
            const percent = totalWeight > 0
                ? determinate.reduce(
                    (total, task) =>
                        total + task.percent * task.weight,
                    0
                ) / totalWeight
                : null;

            return {
                active: active.length,
                determinate: determinate.length,
                indeterminate:
                    active.length - determinate.length,
                percent,
                tasks: active.map(serializeTask)
            };
        }

        updateAggregate() {
            const aggregate = this.aggregate();

            this.context.root?.classList?.toggle?.(
                "terminal-has-progress",
                aggregate.active > 0
            );

            this.emit("aggregate", aggregate);
            return aggregate;
        }

        withLoadingIntegration(
            callback
        ) {
            if (
                !this.options.integrateLoading ||
                !this.context.loading ||
                this.loadingIntegrationDepth >
                    0
            ) {
                return false;
            }

            this.loadingIntegrationDepth +=
                1;

            try {
                callback(
                    this.context.loading
                );

                this.metrics.loadingCalls +=
                    1;

                return true;
            } catch (_error) {
                this.metrics.loadingErrors +=
                    1;

                return false;
            } finally {
                this.loadingIntegrationDepth -=
                    1;
            }
        }

        integrateLoadingBegin(task) {
            return this.withLoadingIntegration(
                loading => {
                    const id =
                        `progress:${task.id}`;

                    if (
                        typeof loading.begin ===
                            "function"
                    ) {
                        loading.begin(
                            id,
                            task.label,
                            {
                                progress:
                                    task.indeterminate
                                        ? null
                                        : task.percent,
                                metadata: {
                                    source:
                                        "progress"
                                }
                            }
                        );
                    } else {
                        loading.start?.(
                            id,
                            task.label
                        );
                    }
                }
            );
        }

        integrateLoadingUpdate(task) {
            return this.withLoadingIntegration(
                loading => {
                    const id =
                        `progress:${task.id}`;

                    if (
                        typeof loading.setProgress ===
                            "function"
                    ) {
                        loading.setProgress(
                            id,
                            task.indeterminate
                                ? null
                                : task.percent,
                            task.label
                        );
                    } else {
                        loading.update?.(
                            id,
                            {
                                progress:
                                    task.indeterminate
                                        ? null
                                        : task.percent,
                                label:
                                    task.label
                            }
                        );
                    }
                }
            );
        }

        integrateLoadingEnd(task) {
            return this.withLoadingIntegration(
                loading => {
                    const id =
                        `progress:${task.id}`;

                    if (
                        typeof loading.end ===
                            "function"
                    ) {
                        loading.end(
                            id,
                            task.metadata?.result
                        );
                    } else {
                        loading.complete?.(
                            id,
                            task.metadata?.result
                        );
                    }
                }
            );
        }

        integrateLoadingFail(
            task,
            error
        ) {
            return this.withLoadingIntegration(
                loading => {
                    const id =
                        `progress:${task.id}`;

                    loading.fail?.(
                        id,
                        error
                    );
                }
            );
        }

        integrateLoadingCancel(task) {
            return this.withLoadingIntegration(
                loading => {
                    const id =
                        `progress:${task.id}`;

                    if (
                        typeof loading.cancel ===
                            "function"
                    ) {
                        loading.cancel(
                            id
                        );
                    } else {
                        loading.end?.(
                            id
                        );
                    }
                }
            );
        }

        archive(task) {
            if (this.archived.has(task.id)) {
                return serializeTask(task);
            }

            const serialized = serializeTask(task);
            this.history.push(serialized);
            this.history = this.history.slice(
                -this.options.historyLimit
            );
            this.archived.add(task.id);

            return serialized;
        }

        list(options = {}) {
            const requestedState = options.state
                ? normalizeState(options.state)
                : null;
            const activeOnly = options.active === true;

            return [...this.tasks.values()]
                .filter((task) =>
                    (!requestedState || task.state === requestedState) &&
                    (!activeOnly || ACTIVE_STATES.has(task.state))
                )
                .map(serializeTask);
        }

        status() {
            return {
                version: VERSION,
                tasks: this.tasks.size,
                views: this.views.size,
                history: this.history.length,
                aggregate: this.aggregate(),
                integrateLoading:
                    this.options.integrateLoading,
                loadingIntegrationDepth:
                    this.loadingIntegrationDepth,
                tickerInterval:
                    this.options.tickerInterval,
                maximumTasks:
                    this.options.maximumTasks,
                retainCompletedTasks:
                    this.options.retainCompletedTasks,
                metrics: {
                    ...this.metrics
                },
                destroyed:
                    this.destroyed
            };
        }

        export() {
            return {
                version: VERSION,
                generatedAt: timestamp(),
                status: this.status(),
                tasks: this.list(),
                history: [...this.history]
            };
        }

        emit(type, detail) {
            const payload =
                detail && detail.id
                    ? serializeTask(detail)
                    : detail;

            safeDispatch(this, type, payload);

            try {
                this.context.events?.emit?.(
                    `progress:${type}`,
                    payload
                );
            } catch (_error) {
                /* Event-bus observers are isolated. */
            }

            safeDispatch(
                this.context.root,
                `speciedex:terminal-progress-${type}`,
                payload,
                { bubbles: true }
            );

            safeDispatch(
                document,
                `speciedex:terminal-progress-${type}`,
                payload
            );
        }

        destroy() {
            if (
                this.destroyed
            ) {
                return false;
            }

            if (this.ticker) {
                window.cancelAnimationFrame(
                    this.ticker
                );

                this.ticker =
                    0;
            }

            for (
                const collection of
                this.views.values()
            ) {
                if (
                    collection instanceof
                        Set
                ) {
                    for (
                        const view of
                        collection
                    ) {
                        view.destroy?.();
                    }
                } else {
                    collection?.destroy?.();
                }
            }

            for (
                const task of
                this.tasks.values()
            ) {
                if (
                    ACTIVE_STATES.has(
                        task.state
                    )
                ) {
                    try {
                        task.abortController?.
                            abort?.(
                                "progress-coordinator-destroyed"
                            );
                    } catch (_error) {
                        task.abortController?.
                            abort?.();
                    }
                }
            }

            this.views.clear();
            this.tasks.clear();
            this.archived.clear();

            this.context.root?.
                classList?.
                remove?.(
                    "terminal-has-progress"
                );

            if (
                this.context.root?.[
                    COORDINATOR_SYMBOL
                ] ===
                    this
            ) {
                delete this.context.root[
                    COORDINATOR_SYMBOL
                ];
            }

            this.destroyed =
                true;

            safeDispatch(
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

    function createProgress(
        label = "Progress",
        value = 0,
        options = {}
    ) {
        const minimum = parseNumber(
            options.minimum,
            DEFAULT_OPTIONS.minimum
        );
        const maximum = parseNumber(
            options.maximum,
            DEFAULT_OPTIONS.maximum
        );

        if (maximum <= minimum) {
            throw new RangeError(
                "Progress maximum must be greater than minimum."
            );
        }

        const current = performance.now();
        const initialValue = clamp(
            parseNumber(value, minimum),
            minimum,
            maximum
        );

        const task = {
            id: String(options.id || makeID()),
            label: String(label),
            description: String(options.description || ""),
            minimum,
            maximum,
            value: initialValue,
            percent:
                ((initialValue - minimum) /
                (maximum - minimum)) * 100,
            state: normalizeState(
                options.state || "running",
                "running"
            ),
            indeterminate: parseBoolean(
                options.indeterminate,
                false
            ),
            cancellable: parseBoolean(
                options.cancellable,
                false
            ),
            weight: Math.max(
                0,
                parseNumber(options.weight, 1)
            ),
            startedAt: current,
            startedAtISO: timestamp(),
            updatedAt: current,
            updatedAtISO: timestamp(),
            completedAt: null,
            completedAtISO: null,
            pausedAt: null,
            pausedDuration: 0,
            elapsed: 0,
            remaining: null,
            metadata: {},
            error: null
        };

        const view = new ProgressView(task, options);
        const wrapper = view.element;

        Object.defineProperty(wrapper, "controller", {
            configurable: false,
            enumerable: false,
            value: view
        });

        wrapper.update = (
            next,
            updateOptions = {}
        ) => {
            task.value = clamp(
                parseNumber(next, task.value),
                task.minimum,
                task.maximum
            );
            task.percent =
                ((task.value - task.minimum) /
                (task.maximum - task.minimum)) * 100;
            task.state = updateOptions.state
                ? normalizeState(
                    updateOptions.state,
                    task.state
                )
                : task.value >= task.maximum
                    ? "success"
                    : task.state;
            task.description =
                updateOptions.description ??
                task.description;
            task.indeterminate =
                updateOptions.indeterminate ??
                task.indeterminate;
            task.updatedAt = performance.now();
            task.updatedAtISO = timestamp();
            task.elapsed =
                task.updatedAt - task.startedAt;
            task.remaining = estimateRemaining(
                task.minimum,
                task.maximum,
                task.value,
                task.elapsed
            );

            if (
                task.value >= task.maximum &&
                task.completedAt === null
            ) {
                task.completedAt = task.updatedAt;
                task.completedAtISO = task.updatedAtISO;
            }

            view.update(task);
            return wrapper;
        };

        wrapper.setState = (state) => {
            task.state = normalizeState(state, task.state);
            view.update(task);
            return wrapper;
        };

        wrapper.destroy = () => view.destroy();

        return wrapper;
    }

    function initialize(
        context
    ) {
        const root =
            context.root;

        const existing =
            context.progress instanceof
                ProgressCoordinator
                ? context.progress
                : root?.[
                    COORDINATOR_SYMBOL
                ];

        if (
            existing instanceof
                ProgressCoordinator &&
            !existing.destroyed
        ) {
            context.progress =
                existing;

            context.createProgress =
                createProgress;

            context.registerService?.(
                "progress",
                existing
            );

            return existing;
        }

        const coordinator =
            new ProgressCoordinator(
                context,
                {
                    historyLimit:
                        root?.
                            dataset?.
                            terminalProgressHistoryLimit,

                    integrateLoading:
                        parseBoolean(
                            root?.
                                dataset?.
                                terminalProgressLoading,
                            true
                        ),

                    injectStyles:
                        parseBoolean(
                            root?.
                                dataset?.
                                terminalProgressInjectStyles,
                            true
                        ),

                    tickerInterval:
                        root?.
                            dataset?.
                            terminalProgressTickerInterval,

                    maximumTasks:
                        root?.
                            dataset?.
                            terminalProgressMaximumTasks,

                    retainCompletedTasks:
                        parseBoolean(
                            root?.
                                dataset?.
                                terminalProgressRetainCompleted,
                            true
                        )
                }
            );

        root[
            COORDINATOR_SYMBOL
        ] =
            coordinator;

        context.progress =
            coordinator;

        context.createProgress =
            createProgress;

        context.registerService?.(
            "progress",
            coordinator
        );

        context.registerRenderer?.(
            "progress",
            {
                create:
                    createProgress,
                render:
                    createProgress,
                Coordinator:
                    ProgressCoordinator,
                View:
                    ProgressView
            }
        );

        safeDispatch(
            document,
            "speciedex:terminal-progress-ready",
            {
                coordinator,
                status:
                    coordinator.status()
            }
        );

        return coordinator;
    }

    function requireProgress(context) {
        const progress =
            context?.progress ||
            context?.services?.get?.("progress");

        if (!(progress instanceof ProgressCoordinator)) {
            throw new Error(
                "Progress coordinator is unavailable."
            );
        }

        return progress;
    }

    function downloadJSON(data, filename) {
        const blob = new Blob(
            [JSON.stringify(data, null, 2)],
            { type: "application/json" }
        );
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        anchor.click();

        window.setTimeout(() => {
            URL.revokeObjectURL(url);
        }, 1000);

        return filename;
    }

    const commands = [
        {
            name: "progress",
            category: "system",
            description: "Display progress coordinator status.",
            usage: "progress",
            handler: ({ context, writeJSON }) =>
                writeJSONValue(
                    writeJSON,
                    requireProgress(context).status()
                )
        },
        {
            name: "progress-list",
            category: "system",
            description: "List progress tasks.",
            usage: "progress-list [state]",
            handler: ({ args = [], context, writeJSON }) =>
                writeJSONValue(
                    writeJSON,
                    requireProgress(context).list({
                        state: args[0] || null
                    })
                )
        },
        {
            name: "progress-begin",
            category: "system",
            description: "Create a progress task.",
            usage:
                "progress-begin <id> [label] [--max N] " +
                "[--indeterminate] [--cancellable]",
            handler: ({
                args = [],
                parsed = { options: {}, flags: {} },
                context,
                writeJSON
            }) => {
                const copy = [...args];
                const id = copy.shift();

                if (!id) {
                    throw new Error(
                        "A progress task ID is required."
                    );
                }

                const options = parsed.options || {};
                const flags = parsed.flags || {};

                return writeJSONValue(
                    writeJSON,
                    serializeTask(
                        requireProgress(context).begin(
                            id,
                            copy.join(" ") || id,
                            {
                                maximum:
                                    options.max ??
                                    options.maximum ??
                                    100,
                                minimum:
                                    options.min ??
                                    options.minimum ??
                                    0,
                                indeterminate:
                                    flags.indeterminate === true,
                                cancellable:
                                    flags.cancellable === true,
                                description:
                                    options.description || ""
                            }
                        )
                    )
                );
            }
        },
        {
            name: "progress-set",
            category: "system",
            description: "Set progress task value.",
            usage: "progress-set <id> <value> [label]",
            handler: ({
                args = [],
                context,
                writeJSON
            }) => {
                const copy = [...args];
                const id = copy.shift();
                const value = copy.shift();

                if (!id || value === undefined) {
                    throw new Error(
                        "Usage: progress-set <id> <value> [label]"
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    serializeTask(
                        requireProgress(context).set(
                            id,
                            value,
                            {
                                label:
                                    copy.join(" ") ||
                                    undefined
                            }
                        )
                    )
                );
            }
        },
        {
            name: "progress-increment",
            category: "system",
            description: "Increment a progress task.",
            usage: "progress-increment <id> [amount]",
            handler: ({
                args = [],
                context,
                writeJSON
            }) => {
                if (!args[0]) {
                    throw new Error(
                        "A progress task ID is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    serializeTask(
                        requireProgress(context).increment(
                            args[0],
                            args[1] ?? 1
                        )
                    )
                );
            }
        },
        {
            name: "progress-pause",
            category: "system",
            description: "Pause a progress task.",
            usage: "progress-pause <id>",
            handler: ({ args = [], context, writeJSON }) =>
                writeJSONValue(writeJSON, {
                    paused:
                        requireProgress(context).pause(args[0])
                })
        },
        {
            name: "progress-resume",
            category: "system",
            description: "Resume a progress task.",
            usage: "progress-resume <id>",
            handler: ({ args = [], context, writeJSON }) =>
                writeJSONValue(writeJSON, {
                    resumed:
                        requireProgress(context).resume(args[0])
                })
        },
        {
            name: "progress-complete",
            category: "system",
            description: "Complete a progress task.",
            usage: "progress-complete <id>",
            handler: ({ args = [], context, writeJSON }) => {
                const task =
                    requireProgress(context).complete(args[0]);

                if (!task) {
                    throw new Error(
                        `Unknown progress task: ${args[0]}`
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    serializeTask(task)
                );
            }
        },
        {
            name: "progress-fail",
            category: "system",
            description: "Fail a progress task.",
            usage: "progress-fail <id> <message>",
            handler: ({ args = [], context, writeJSON }) => {
                const copy = [...args];
                const id = copy.shift();

                if (!id) {
                    throw new Error(
                        "A progress task ID is required."
                    );
                }

                const task = requireProgress(context).fail(
                    id,
                    new Error(
                        copy.join(" ") ||
                        "Progress task failed."
                    )
                );

                if (!task) {
                    throw new Error(
                        `Unknown progress task: ${id}`
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    serializeTask(task)
                );
            }
        },
        {
            name: "progress-cancel",
            category: "system",
            description: "Cancel a progress task.",
            usage: "progress-cancel <id>",
            handler: ({ args = [], context, writeJSON }) => {
                const task = requireProgress(context).cancel(
                    args[0],
                    "command"
                );

                if (!task) {
                    throw new Error(
                        `Unknown progress task: ${args[0]}`
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    serializeTask(task)
                );
            }
        },
        {
            name: "progress-render",
            category: "system",
            description:
                "Render progress tasks in the terminal.",
            usage: "progress-render",
            handler: ({ context }) =>
                requireProgress(context).renderList()
        },
        {
            name: "progress-clear",
            category: "system",
            description: "Remove completed progress tasks.",
            usage: "progress-clear [--all]",
            handler: ({
                parsed = { flags: {} },
                context,
                writeJSON
            }) =>
                writeJSONValue(writeJSON, {
                    cleared:
                        requireProgress(context).clear({
                            includeRunning:
                                parsed.flags?.all === true
                        })
                })
        },
        {
            name: "progress-demo",
            category: "system",
            description:
                "Run a progress demonstration.",
            usage: "progress-demo [seconds]",
            handler: async ({
                args = [],
                context,
                write
            }) => {
                const seconds = clamp(
                    parseNumber(args[0], 5),
                    1,
                    60
                );
                const progress = requireProgress(context);
                const id = `demo:${Date.now()}`;

                progress.begin(
                    id,
                    "Speciedex progress demonstration",
                    {
                        maximum: 100,
                        cancellable: true,
                        description:
                            "Demonstrating coordinated progress " +
                            "and loading state."
                    }
                );

                const started = performance.now();

                while (
                    performance.now() - started <
                    seconds * 1000
                ) {
                    const task = progress.get(id);

                    if (!task || task.state === "cancelled") {
                        return writeValue(
                            write,
                            "Progress demonstration cancelled.",
                            "warning"
                        );
                    }

                    const elapsed =
                        performance.now() - started;

                    progress.set(
                        id,
                        clamp(
                            elapsed / (seconds * 1000) * 100,
                            0,
                            100
                        ),
                        { complete: false }
                    );

                    await new Promise((resolve) => {
                        window.setTimeout(resolve, 80);
                    });
                }

                progress.complete(id);

                return writeValue(
                    write,
                    "Progress demonstration complete.",
                    "success"
                );
            }
        },
        {
            name: "progress-remove",
            category: "system",
            description: "Remove a progress task.",
            usage: "progress-remove <id>",
            handler: ({ args = [], context, writeJSON }) => {
                if (!args[0]) {
                    throw new Error(
                        "A progress task ID is required."
                    );
                }

                return writeJSONValue(
                    writeJSON,
                    {
                        removed:
                            requireProgress(
                                context
                            ).remove(
                                args[0]
                            )
                    }
                );
            }
        },
        {
            name: "progress-history",
            category: "system",
            description: "Display completed progress-task history.",
            usage: "progress-history [count]",
            handler: ({ args = [], context, writeJSON }) => {
                const progress =
                    requireProgress(
                        context
                    );

                const limit =
                    clampInteger(
                        args[0],
                        50,
                        1,
                        progress.options.historyLimit
                    );

                return writeJSONValue(
                    writeJSON,
                    progress.history.slice(
                        -limit
                    )
                );
            }
        },
        {
            name: "progress-export",
            category: "system",
            description:
                "Export progress tasks and history as JSON.",
            usage: "progress-export [filename]",
            handler: ({ args = [], context, write }) => {
                const filename =
                    args[0] ||
                    "speciedex-terminal-progress.json";

                downloadJSON(
                    requireProgress(context).export(),
                    filename
                );

                return writeValue(
                    write,
                    `Progress exported to ${filename}.`,
                    "success"
                );
            }
        }
    ];

    const api = Object.freeze({
        name: MODULE_NAME,
        version: VERSION,
        PRIMARY_COLOR,
        ACCENT_COLOR,
        DEFAULT_OPTIONS,
        COORDINATOR_SYMBOL,
        STATES,
        ProgressView,
        ProgressCoordinator,
        clamp,
        clampInteger,
        parseNumber,
        parseBoolean,
        normalizeState,
        normalizeID,
        formatDuration,
        estimateRemaining,
        serializeTask,
        injectProgressStyles,
        createProgress,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalProgress = api;
    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    safeDispatch(
        document,
        "speciedex:terminal-module-available",
        {
            name: MODULE_NAME,
            module: api
        }
    );
})(window, document);
