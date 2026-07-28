/*
========================================================================
Speciedex.org
Terminal Window Manager
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Windows";
    const VERSION = "2.1.0";
    const MANAGER_SYMBOL = Symbol.for(
        "speciedex.terminal.windows.manager"
    );
    const DEFAULT_MIN_WIDTH = 240;
    const DEFAULT_MIN_HEIGHT = 120;
    const DEFAULT_WIDTH = 640;
    const DEFAULT_HEIGHT = 420;
    const DEFAULT_OFFSET = 24;
    const DEFAULT_Z_INDEX = 1000;
    const RESERVED_IDS = new Set(["__proto__", "prototype", "constructor"]);

    function now() {
        return Date.now();
    }

    function iso(timestamp = now()) {
        return new Date(timestamp).toISOString();
    }

    function isObject(value) {
        return value !== null &&
            typeof value === "object" &&
            !Array.isArray(value);
    }

    function isNode(value) {
        return Boolean(
            value &&
            typeof value.nodeType === "number" &&
            typeof value.cloneNode === "function"
        );
    }

    function clone(value, seen = new WeakMap()) {
        if (value === undefined || value === null || typeof value !== "object") {
            return value;
        }

        if (typeof structuredClone === "function") {
            try {
                return structuredClone(value);
            } catch (_error) {
                /* Continue with deterministic fallback. */
            }
        }

        if (seen.has(value)) {
            return seen.get(value);
        }

        if (value instanceof Date) {
            return new Date(value.getTime());
        }

        if (value instanceof RegExp) {
            return new RegExp(value.source, value.flags);
        }

        if (value instanceof Map) {
            const output = new Map();
            seen.set(value, output);
            for (const [key, item] of value) {
                output.set(clone(key, seen), clone(item, seen));
            }
            return output;
        }

        if (value instanceof Set) {
            const output = new Set();
            seen.set(value, output);
            for (const item of value) {
                output.add(clone(item, seen));
            }
            return output;
        }

        if (Array.isArray(value)) {
            const output = [];
            seen.set(value, output);
            for (const item of value) {
                output.push(clone(item, seen));
            }
            return output;
        }

        if (isNode(value)) {
            return value;
        }

        const output = {};
        seen.set(value, output);

        for (const [key, item] of Object.entries(value)) {
            if (RESERVED_IDS.has(key)) {
                continue;
            }
            output[key] = clone(item, seen);
        }

        return output;
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

    function normalizeId(value) {
        const id = String(value ?? "")
            .trim()
            .replace(/\s+/g, "-")
            .replace(/[^a-zA-Z0-9._:-]/g, "-")
            .replace(/-+/g, "-")
            .replace(/^[-.]+|[-.]+$/g, "");

        if (!id) {
            throw new TypeError("Window identifier must be non-empty.");
        }

        if (RESERVED_IDS.has(id)) {
            throw new TypeError("Reserved window identifier is not allowed.");
        }

        return id;
    }

    function safeDispatch(target, name, detail) {
        try {
            target.dispatchEvent(new CustomEvent(name, { detail }));
        } catch (error) {
            /* Window events must never interrupt UI operations. */
        }
    }

    function createElement(tagName, className, text) {
        const element = document.createElement(tagName);

        if (className) {
            element.className = className;
        }

        if (text !== undefined) {
            element.textContent = text;
        }

        return element;
    }

    function clamp(value, minimum, maximum) {
        return Math.min(maximum, Math.max(minimum, value));
    }

    class WindowManager extends EventTarget {
        constructor(context = {}, options = {}) {
            super();

            this.context = context;
            this.root =
                options.root ||
                context.root ||
                document.body;

            if (
                !this.root ||
                typeof this.root.appendChild !==
                    "function"
            ) {
                throw new TypeError(
                    "WindowManager requires a valid root element."
                );
            }

            this.windows = new Map();
            this.order = [];
            this.activeId = null;
            this.zIndex = parseNumber(
                options.baseZIndex,
                DEFAULT_Z_INDEX,
                1,
                2147483000
            );
            this.offset = parseNumber(
                options.offset,
                DEFAULT_OFFSET,
                0,
                500
            );
            this.watchers = new Set();
            this.destroyed = false;
            this.lastError = null;
            this.abortController = new AbortController();
            this.activeInteraction = null;
            this.emitting = false;
            this.emittingError = false;
            this.ownsLayer = false;
            this.previousFocus = new Map();
            this.layer = this._ensureLayer();
            this.metrics = {
                opened: 0,
                closed: 0,
                focused: 0,
                minimized: 0,
                maximized: 0,
                restored: 0,
                moved: 0,
                resized: 0,
                errors: 0
            };

            this._boundKeydown =
                this._handleKeydown.bind(this);

            this._boundResize =
                this._handleViewportResize.bind(this);

            window.addEventListener(
                "keydown",
                this._boundKeydown,
                {
                    signal:
                        this.abortController.signal
                }
            );

            window.addEventListener(
                "resize",
                this._boundResize,
                {
                    signal:
                        this.abortController.signal
                }
            );

            this._syncState();
        }

        _ensureLayer() {
            let layer =
                this.root.querySelector?.(
                    ":scope > [data-terminal-window-layer]"
                ) ||
                null;

            if (!layer) {
                this.ownsLayer = true;
                layer =
                    createElement(
                        "div",
                        "terminal-window-layer"
                    );

                layer.dataset.terminalWindowLayer =
                    "";

                layer.setAttribute(
                    "aria-live",
                    "off"
                );

                this.root.appendChild(
                    layer
                );
            }

            const style =
                window.getComputedStyle?.(
                    this.root
                );

            if (
                style &&
                style.position ===
                    "static"
            ) {
                this.root.style.position =
                    "relative";
            }

            return layer;
        }

        _rootSize() {
            const rect =
                this.layer.getBoundingClientRect?.() ||
                this.root.getBoundingClientRect?.() ||
                {
                    width:
                        window.innerWidth,
                    height:
                        window.innerHeight
                };

            return {
                width:
                    Math.max(
                        0,
                        rect.width ||
                        window.innerWidth
                    ),
                height:
                    Math.max(
                        0,
                        rect.height ||
                        window.innerHeight
                    )
            };
        }

        _cancelInteraction() {
            const interaction =
                this.activeInteraction;

            if (!interaction) {
                return;
            }

            try {
                interaction.release?.();
            } catch (error) {
                /* Pointer release is best effort. */
            }

            interaction.cleanup?.();
            this.activeInteraction =
                null;
        }

        _assertActive() {
            if (this.destroyed) {
                throw new Error("Window manager has been destroyed.");
            }
        }

        _recordError(error, options = {}) {
            this.lastError = error instanceof Error
                ? error
                : new Error(String(error));
            this.metrics.errors += 1;

            if (
                options.emit !== false &&
                !this.emittingError &&
                !this.destroyed
            ) {
                this.emittingError = true;
                try {
                    this._emit("error", {
                        error: {
                            name: this.lastError.name,
                            message: this.lastError.message,
                            stack: this.lastError.stack || ""
                        }
                    }, {
                        suppressErrors: true
                    });
                } finally {
                    this.emittingError = false;
                }
            }

            return this.lastError;
        }

        _emit(type, detail = {}, options = {}) {
            if (this.destroyed && type !== "destroy") {
                return null;
            }

            const event = {
                type,
                timestamp: iso(),
                activeId: this.activeId,
                ...detail
            };

            if (this.emitting && type !== "error") {
                return event;
            }

            const wasEmitting = this.emitting;
            this.emitting = true;

            try {
                safeDispatch(this, type, event);
                safeDispatch(this, "change", event);

                for (const watcher of Array.from(this.watchers)) {
                    try {
                        watcher(event, this);
                    } catch (error) {
                        this._recordError(error, { emit: false });
                    }
                }

                try {
                    this.context.events?.emit?.(`windows:${type}`, event);
                } catch (error) {
                    this._recordError(error, { emit: false });
                }

                return event;
            } finally {
                this.emitting = wasEmitting;
            }
        }

        _syncState() {
            const state = this.context.state || this.context.stateStore;

            try {
                state?.set?.("terminal.windows", {
                    activeId: this.activeId,
                    count: this.windows.size,
                    order: [...this.order],
                    windows: this.list(),
                    updatedAt: iso()
                });
            } catch (error) {
                /* State synchronization is advisory. */
            }
        }

        _handleKeydown(event) {
            if (this.destroyed || event.defaultPrevented) {
                return;
            }

            const target = event.target;
            const editable =
                target instanceof HTMLInputElement ||
                target instanceof HTMLTextAreaElement ||
                target instanceof HTMLSelectElement ||
                target?.isContentEditable;

            if (editable && event.key !== "Escape") {
                return;
            }

            if (event.key === "Escape" && this.activeId) {
                const entry = this.windows.get(this.activeId);

                if (entry?.options.closeOnEscape !== false) {
                    event.preventDefault();
                    this.close(this.activeId, "escape");
                }
                return;
            }

            if ((event.ctrlKey || event.metaKey) && event.key === "`") {
                event.preventDefault();
                this.cycle(event.shiftKey ? -1 : 1);
                return;
            }

            if (
                this.context.config?.windows?.captureAltF4 === true &&
                event.altKey &&
                event.key === "F4" &&
                this.activeId
            ) {
                event.preventDefault();
                this.close(this.activeId, "keyboard");
            }
        }

        _handleViewportResize() {
            for (const entry of this.windows.values()) {
                if (entry.state.maximized) {
                    this._applyMaximizedGeometry(entry);
                    continue;
                }

                if (entry.options.keepInViewport !== false) {
                    this._constrainToViewport(entry);
                }
            }
        }

        _nextPosition(width, height) {
            const index = this.windows.size;
            const rootRect =
                this._rootSize();
            const offset = (index * this.offset) % Math.max(this.offset, 240);
            const x = clamp(
                24 + offset,
                0,
                Math.max(0, rootRect.width - width)
            );
            const y = clamp(
                24 + offset,
                0,
                Math.max(0, rootRect.height - height)
            );

            return { x, y };
        }

        _createWindow(id, options) {
            const panel = createElement(
                "section",
                `terminal-window${options.className ? ` ${options.className}` : ""}`
            );
            panel.id =
                `terminal-window-${id}`;
            panel.dataset.terminalWindow = id;
            panel.dataset.windowState = "normal";
            panel.setAttribute("role", options.role || "dialog");
            panel.setAttribute("aria-modal", options.modal ? "true" : "false");
            panel.tabIndex = -1;

            const header = createElement(
                "header",
                "terminal-window-header"
            );
            header.dataset.windowDragHandle = "true";

            const titleWrap = createElement(
                "div",
                "terminal-window-title-wrap"
            );

            if (options.icon) {
                const icon = createElement(
                    "span",
                    "terminal-window-icon",
                    String(options.icon)
                );
                icon.setAttribute("aria-hidden", "true");
                titleWrap.appendChild(icon);
            }

            const title = createElement(
                "h3",
                "terminal-window-title",
                options.title || id
            );
            title.id = `terminal-window-title-${id}`;
            panel.setAttribute("aria-labelledby", title.id);
            titleWrap.appendChild(title);

            const controls = createElement(
                "div",
                "terminal-window-controls"
            );

            let minimizeButton = null;
            let maximizeButton = null;

            if (options.minimizable !== false) {
                minimizeButton = createElement(
                    "button",
                    "terminal-window-control terminal-window-minimize",
                    options.minimizeLabel || "Minimize"
                );
                minimizeButton.type = "button";
                minimizeButton.dataset.terminalWindowMinimize = id;
                minimizeButton.setAttribute(
                    "aria-label",
                    `Minimize ${options.title || id}`
                );
                minimizeButton.title =
                    `Minimize ${options.title || id}`;
                minimizeButton.setAttribute(
                    "aria-pressed",
                    "false"
                );
                controls.appendChild(minimizeButton);
            }

            if (options.maximizable !== false) {
                maximizeButton = createElement(
                    "button",
                    "terminal-window-control terminal-window-maximize",
                    options.maximizeLabel || "Maximize"
                );
                maximizeButton.type = "button";
                maximizeButton.dataset.terminalWindowMaximize = id;
                maximizeButton.setAttribute(
                    "aria-label",
                    `Maximize ${options.title || id}`
                );
                maximizeButton.title =
                    `Maximize ${options.title || id}`;
                maximizeButton.setAttribute(
                    "aria-pressed",
                    "false"
                );
                controls.appendChild(maximizeButton);
            }

            const closeButton = createElement(
                "button",
                "terminal-window-control terminal-window-close",
                options.closeLabel || "Close"
            );
            closeButton.type = "button";
            closeButton.dataset.terminalWindowClose = id;
            closeButton.setAttribute(
                "aria-label",
                `Close ${options.title || id}`
            );
            closeButton.title =
                `Close ${options.title || id}`;
            controls.appendChild(closeButton);

            header.append(titleWrap, controls);

            const body = createElement(
                "div",
                "terminal-window-body"
            );
            body.dataset.terminalWindowBody = id;

            if (isNode(options.content)) {
                body.appendChild(options.content);
            } else if (options.content !== undefined && options.content !== null) {
                body.textContent = String(options.content);
            }

            const footer = createElement(
                "footer",
                "terminal-window-footer"
            );
            footer.dataset.terminalWindowFooter = id;

            if (isNode(options.footer)) {
                footer.appendChild(options.footer);
            } else if (options.footer !== undefined && options.footer !== null) {
                footer.textContent = String(options.footer);
            } else {
                footer.hidden = true;
            }

            panel.append(header, body, footer);

            if (options.resizable !== false) {
                for (const direction of [
                    "n", "e", "s", "w",
                    "ne", "nw", "se", "sw"
                ]) {
                    const handle = createElement(
                        "span",
                        `terminal-window-resize terminal-window-resize-${direction}`
                    );
                    handle.dataset.windowResize = direction;
                    handle.setAttribute("aria-hidden", "true");
                    panel.appendChild(handle);
                }
            }

            return {
                panel,
                header,
                title,
                body,
                footer,
                controls,
                closeButton,
                minimizeButton,
                maximizeButton
            };
        }

        _bindWindow(entry) {
            const {
                panel,
                header,
                closeButton,
                minimizeButton,
                maximizeButton
            } = entry.elements;

            const signal =
                entry.abortController.signal;

            panel.addEventListener(
                "pointerdown",
                () => {
                    this.focus(
                        entry.id
                    );
                },
                {
                    signal
                }
            );

            panel.addEventListener(
                "focusin",
                () => {
                    this.focus(
                        entry.id,
                        {
                            focusElement:
                                false
                        }
                    );
                },
                {
                    signal
                }
            );

            closeButton.addEventListener(
                "click",
                event => {
                    event.preventDefault();
                    event.stopPropagation();

                    this.close(
                        entry.id,
                        "button"
                    );
                },
                {
                    signal
                }
            );

            minimizeButton?.addEventListener(
                "click",
                event => {
                    event.preventDefault();
                    event.stopPropagation();

                    if (
                        entry.state.minimized
                    ) {
                        this.restore(
                            entry.id
                        );
                    } else {
                        this.minimize(
                            entry.id
                        );
                    }
                },
                {
                    signal
                }
            );

            maximizeButton?.addEventListener(
                "click",
                event => {
                    event.preventDefault();
                    event.stopPropagation();

                    if (
                        entry.state.maximized
                    ) {
                        this.restore(
                            entry.id
                        );
                    } else {
                        this.maximize(
                            entry.id
                        );
                    }
                },
                {
                    signal
                }
            );

            if (
                entry.options.draggable !==
                    false
            ) {
                header.addEventListener(
                    "pointerdown",
                    event => {
                        if (
                            event.button !==
                                0 ||
                            event.target.closest(
                                "button"
                            )
                        ) {
                            return;
                        }

                        this._beginDrag(
                            entry,
                            event
                        );
                    },
                    {
                        signal
                    }
                );
            }

            if (
                entry.options.maximizable !==
                    false
            ) {
                header.addEventListener(
                    "dblclick",
                    event => {
                        if (
                            event.target.closest(
                                "button"
                            )
                        ) {
                            return;
                        }

                        event.preventDefault();

                        if (
                            entry.state.maximized
                        ) {
                            this.restore(
                                entry.id
                            );
                        } else {
                            this.maximize(
                                entry.id
                            );
                        }
                    },
                    {
                        signal
                    }
                );
            }

            if (
                entry.options.resizable !==
                    false
            ) {
                for (
                    const handle of
                    panel.querySelectorAll(
                        "[data-window-resize]"
                    )
                ) {
                    handle.addEventListener(
                        "pointerdown",
                        event => {
                            if (
                                event.button !==
                                    0
                            ) {
                                return;
                            }

                            this._beginResize(
                                entry,
                                event,
                                handle.dataset.windowResize
                            );
                        },
                        {
                            signal
                        }
                    );
                }
            }
        }

        _beginDrag(entry, event) {
            if (
                entry.state.maximized ||
                entry.state.minimized
            ) {
                return;
            }

            event.preventDefault();

            this._cancelInteraction();
            this.focus(
                entry.id
            );

            const startX =
                event.clientX;
            const startY =
                event.clientY;
            const startLeft =
                entry.geometry.x;
            const startTop =
                entry.geometry.y;
            const pointerId =
                event.pointerId;

            entry.elements.header.setPointerCapture?.(
                pointerId
            );

            entry.elements.panel.classList.add(
                "is-dragging"
            );

            const controller =
                new AbortController();

            const move =
                moveEvent => {
                    const x =
                        startLeft +
                        (
                            moveEvent.clientX -
                            startX
                        );

                    const y =
                        startTop +
                        (
                            moveEvent.clientY -
                            startY
                        );

                    this.move(
                        entry.id,
                        x,
                        y,
                        {
                            silent:
                                true
                        }
                    );
                };

            const finish =
                () => {
                    controller.abort();

                    entry.elements.header.
                        releasePointerCapture?.(
                            pointerId
                        );

                    entry.elements.panel.classList.remove(
                        "is-dragging"
                    );

                    this.activeInteraction =
                        null;

                    this.metrics.moved +=
                        1;

                    this._syncState();

                    this._emit(
                        "move",
                        {
                            id:
                                entry.id,
                            geometry:
                                clone(
                                    entry.geometry
                                )
                        }
                    );
                };

            window.addEventListener(
                "pointermove",
                move,
                {
                    signal:
                        controller.signal
                }
            );

            window.addEventListener(
                "pointerup",
                finish,
                {
                    once:
                        true,
                    signal:
                        controller.signal
                }
            );

            window.addEventListener(
                "pointercancel",
                finish,
                {
                    once:
                        true,
                    signal:
                        controller.signal
                }
            );

            this.activeInteraction = {
                cleanup:
                    () =>
                        controller.abort(),
                release:
                    () =>
                        entry.elements.header.
                            releasePointerCapture?.(
                                pointerId
                            )
            };
        }

        _beginResize(
            entry,
            event,
            direction
        ) {
            if (
                entry.state.maximized ||
                entry.state.minimized
            ) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            this._cancelInteraction();
            this.focus(
                entry.id
            );

            const startX =
                event.clientX;
            const startY =
                event.clientY;
            const start =
                clone(
                    entry.geometry
                );
            const pointerId =
                event.pointerId;
            const handle =
                event.currentTarget;

            handle.setPointerCapture?.(
                pointerId
            );

            entry.elements.panel.classList.add(
                "is-resizing"
            );

            const controller =
                new AbortController();

            const move =
                moveEvent => {
                    const dx =
                        moveEvent.clientX -
                        startX;

                    const dy =
                        moveEvent.clientY -
                        startY;

                    let {
                        x,
                        y,
                        width,
                        height
                    } = start;

                    if (
                        direction.includes(
                            "e"
                        )
                    ) {
                        width =
                            start.width +
                            dx;
                    }

                    if (
                        direction.includes(
                            "s"
                        )
                    ) {
                        height =
                            start.height +
                            dy;
                    }

                    if (direction.includes("w")) {
                        const right = start.x + start.width;
                        width = Math.max(
                            entry.options.minWidth,
                            start.width - dx
                        );
                        x = right - width;
                    }

                    if (direction.includes("n")) {
                        const bottom = start.y + start.height;
                        height = Math.max(
                            entry.options.minHeight,
                            start.height - dy
                        );
                        y = bottom - height;
                    }

                    this.resize(
                        entry.id,
                        width,
                        height,
                        {
                            x,
                            y,
                            silent:
                                true
                        }
                    );
                };

            const finish =
                () => {
                    controller.abort();

                    handle.releasePointerCapture?.(
                        pointerId
                    );

                    entry.elements.panel.classList.remove(
                        "is-resizing"
                    );

                    this.activeInteraction =
                        null;

                    this.metrics.resized +=
                        1;

                    this._syncState();

                    this._emit(
                        "resize",
                        {
                            id:
                                entry.id,
                            geometry:
                                clone(
                                    entry.geometry
                                )
                        }
                    );
                };

            window.addEventListener(
                "pointermove",
                move,
                {
                    signal:
                        controller.signal
                }
            );

            window.addEventListener(
                "pointerup",
                finish,
                {
                    once:
                        true,
                    signal:
                        controller.signal
                }
            );

            window.addEventListener(
                "pointercancel",
                finish,
                {
                    once:
                        true,
                    signal:
                        controller.signal
                }
            );

            this.activeInteraction = {
                cleanup:
                    () =>
                        controller.abort(),
                release:
                    () =>
                        handle.releasePointerCapture?.(
                            pointerId
                        )
            };
        }

        _applyGeometry(entry) {
            const { panel } = entry.elements;
            const { x, y, width, height } = entry.geometry;

            panel.style.left = `${Math.round(x)}px`;
            panel.style.top = `${Math.round(y)}px`;
            panel.style.width = `${Math.round(width)}px`;
            panel.style.height = `${Math.round(height)}px`;
            panel.style.zIndex = String(entry.zIndex);
        }

        _applyMaximizedGeometry(entry) {
            const rect =
                this._rootSize();

            entry.geometry = {
                x: 0,
                y: 0,
                width: rect.width,
                height: rect.height
            };

            this._applyGeometry(entry);
        }

        _constrainToViewport(entry) {
            const rect =
                this._rootSize();

            entry.geometry.width = clamp(
                entry.geometry.width,
                entry.options.minWidth,
                Math.max(entry.options.minWidth, rect.width)
            );
            entry.geometry.height = clamp(
                entry.geometry.height,
                entry.options.minHeight,
                Math.max(entry.options.minHeight, rect.height)
            );
            entry.geometry.x = clamp(
                entry.geometry.x,
                0,
                Math.max(0, rect.width - entry.geometry.width)
            );
            entry.geometry.y = clamp(
                entry.geometry.y,
                0,
                Math.max(0, rect.height - entry.geometry.height)
            );

            this._applyGeometry(entry);
        }

        open(id, options = {}) {
            this._assertActive();

            id = normalizeId(id);

            if (this.windows.has(id)) {
                if (options.replace === true) {
                    this.close(id, "replace");
                } else {
                    this.focus(id);
                    return this.windows.get(id).elements.panel;
                }
            }

            const normalizedOptions = {
                title: options.title || id,
                content: options.content ?? "",
                footer: options.footer ?? null,
                icon: options.icon ?? null,
                className: options.className || "",
                role: options.role || "dialog",
                modal: options.modal === true,
                draggable: options.draggable !== false,
                resizable: options.resizable !== false,
                minimizable: options.minimizable !== false,
                maximizable: options.maximizable !== false,
                closeOnEscape: options.closeOnEscape !== false,
                keepInViewport: options.keepInViewport !== false,
                minWidth: parseNumber(
                    options.minWidth,
                    DEFAULT_MIN_WIDTH,
                    80,
                    10000
                ),
                minHeight: parseNumber(
                    options.minHeight,
                    DEFAULT_MIN_HEIGHT,
                    60,
                    10000
                ),
                width: parseNumber(
                    options.width,
                    DEFAULT_WIDTH,
                    80,
                    10000
                ),
                height: parseNumber(
                    options.height,
                    DEFAULT_HEIGHT,
                    60,
                    10000
                ),
                x: options.x,
                y: options.y,
                focus: options.focus !== false,
                closeLabel: options.closeLabel || "Close",
                minimizeLabel: options.minimizeLabel || "Minimize",
                maximizeLabel: options.maximizeLabel || "Maximize",
                metadata: clone(options.metadata || {})
            };

            const position = this._nextPosition(
                normalizedOptions.width,
                normalizedOptions.height
            );
            const geometry = {
                x: parseNumber(
                    normalizedOptions.x,
                    position.x
                ),
                y: parseNumber(
                    normalizedOptions.y,
                    position.y
                ),
                width: Math.max(
                    normalizedOptions.minWidth,
                    normalizedOptions.width
                ),
                height: Math.max(
                    normalizedOptions.minHeight,
                    normalizedOptions.height
                )
            };

            const elements = this._createWindow(id, normalizedOptions);
            const entry = {
                id,
                options: normalizedOptions,
                elements,
                geometry,
                restoreGeometry: clone(geometry),
                state: {
                    minimized: false,
                    maximized: false,
                    active: false
                },
                abortController:
                    new AbortController(),
                previousFocus:
                    document.activeElement instanceof Element
                        ? document.activeElement
                        : null,
                backdrop:
                    null,
                visibilityBeforeMinimize:
                    null,
                zIndex: ++this.zIndex,
                openedAt: iso(),
                updatedAt: iso()
            };

            this.windows.set(id, entry);
            this.order.push(id);
            this._bindWindow(entry);

            if (normalizedOptions.modal) {
                const backdrop = createElement(
                    "div",
                    "terminal-window-overlay"
                );
                backdrop.dataset.terminalWindowBackdrop = id;
                backdrop.style.zIndex = String(entry.zIndex - 1);
                backdrop.addEventListener("pointerdown", event => {
                    event.preventDefault();
                    this.focus(id);
                }, {
                    signal: entry.abortController.signal
                });
                entry.backdrop = backdrop;
                this.layer.appendChild(backdrop);
            }

            this.layer.appendChild(
                elements.panel
            );
            this._applyGeometry(entry);

            if (normalizedOptions.keepInViewport) {
                this._constrainToViewport(entry);
            }

            this.metrics.opened += 1;

            if (normalizedOptions.focus) {
                this.focus(id);
            }

            this._syncState();

            this._emit("open", {
                id,
                window: this.describe(id)
            });

            return elements.panel;
        }

        close(id, reason = "api") {
            this._assertActive();

            id = normalizeId(id);
            const entry = this.windows.get(id);

            if (!entry) {
                return false;
            }

            entry.abortController.abort();

            if (
                this.activeInteraction &&
                (
                    entry.elements.panel.classList.contains(
                        "is-dragging"
                    ) ||
                    entry.elements.panel.classList.contains(
                        "is-resizing"
                    )
                )
            ) {
                this._cancelInteraction();
            }

            entry.elements.panel.remove();
            entry.backdrop?.remove();
            this.windows.delete(id);
            this.order = this.order.filter((item) => item !== id);

            if (this.activeId === id) {
                this.activeId = null;
                const next = this.order[this.order.length - 1];

                if (next) {
                    this.focus(next);
                }
            }

            this.metrics.closed += 1;
            this._syncState();

            this._emit("close", {
                id,
                reason
            });

            if (
                entry.previousFocus?.isConnected &&
                typeof entry.previousFocus.focus === "function"
            ) {
                try {
                    entry.previousFocus.focus({ preventScroll: true });
                } catch (_error) {
                    entry.previousFocus.focus();
                }
            }

            return true;
        }

        closeAll(reason = "api") {
            const ids = [...this.order];

            for (const id of ids) {
                this.close(id, reason);
            }

            return ids.length;
        }

        focus(
            id,
            options = {}
        ) {
            this._assertActive();

            id =
                normalizeId(
                    id
                );

            const entry =
                this.windows.get(
                    id
                );

            if (!entry) {
                return false;
            }

            if (entry.state.minimized) {
                this.restore(id);
            }

            if (
                this.activeId === id &&
                entry.state.active &&
                options.raise !== true
            ) {
                if (options.focusElement !== false) {
                    entry.elements.panel.focus({ preventScroll: true });
                }
                return true;
            }

            for (
                const current of
                this.windows.values()
            ) {
                current.state.active =
                    current.id ===
                    id;

                current.elements.panel.classList.toggle(
                    "is-active",
                    current.id ===
                        id
                );

                /*
                --------------------------------------------------------------
                Inactive windows remain visible and available to assistive
                technology. Only minimized windows are aria-hidden.
                --------------------------------------------------------------
                */
                current.elements.panel.setAttribute(
                    "aria-hidden",
                    String(
                        current.state.minimized
                    )
                );
            }

            this.activeId =
                id;

            entry.zIndex =
                ++this.zIndex;

            entry.updatedAt =
                iso();

            entry.elements.panel.style.zIndex =
                String(
                    entry.zIndex
                );

            if (entry.backdrop) {
                entry.backdrop.style.zIndex = String(entry.zIndex - 1);
            }

            if (
                options.focusElement !==
                    false
            ) {
                entry.elements.panel.focus({
                    preventScroll:
                        true
                });
            }

            this.order =
                this.order.filter(
                    item =>
                        item !==
                        id
                );

            this.order.push(
                id
            );

            this.metrics.focused +=
                1;

            this._syncState();

            this._emit(
                "focus",
                {
                    id
                }
            );

            return true;
        }

        blur(id = this.activeId) {
            if (!id) {
                return false;
            }

            const entry = this.windows.get(normalizeId(id));

            if (!entry) {
                return false;
            }

            entry.state.active = false;
            entry.elements.panel.classList.remove("is-active");

            if (this.activeId === entry.id) {
                this.activeId = null;
            }

            this._syncState();
            return true;
        }

        minimize(id) {
            this._assertActive();

            id = normalizeId(id);
            const entry = this.windows.get(id);

            if (!entry || entry.state.minimized) {
                return false;
            }

            entry.visibilityBeforeMinimize = {
                bodyHidden: entry.elements.body.hidden,
                footerHidden: entry.elements.footer.hidden
            };
            entry.state.minimized = true;
            entry.state.maximized = false;
            entry.elements.panel.classList.add("is-minimized");
            entry.elements.panel.classList.remove("is-maximized");
            entry.elements.panel.dataset.windowState = "minimized";
            entry.elements.body.hidden = true;
            entry.elements.footer.hidden = true;
            entry.elements.panel.setAttribute(
                "aria-hidden",
                "true"
            );
            entry.elements.minimizeButton?.setAttribute(
                "aria-pressed",
                "true"
            );
            entry.elements.maximizeButton?.setAttribute(
                "aria-pressed",
                "false"
            );
            entry.updatedAt = iso();
            this.metrics.minimized += 1;

            if (this.activeId === id) {
                this.activeId = null;
                const next = [...this.order]
                    .reverse()
                    .find((candidate) => {
                        const value = this.windows.get(candidate);
                        return value && !value.state.minimized && candidate !== id;
                    });

                if (next) {
                    this.focus(next);
                }
            }

            this._syncState();

            this._emit("minimize", {
                id
            });

            return true;
        }

        maximize(id) {
            this._assertActive();

            id = normalizeId(id);
            const entry = this.windows.get(id);

            if (!entry || entry.state.maximized) {
                return false;
            }

            entry.restoreGeometry = clone(entry.geometry);
            entry.state.maximized = true;
            entry.state.minimized = false;
            entry.elements.panel.classList.add("is-maximized");
            entry.elements.panel.classList.remove("is-minimized");
            entry.elements.panel.dataset.windowState = "maximized";
            entry.elements.body.hidden =
                entry.visibilityBeforeMinimize?.bodyHidden ?? false;
            entry.elements.panel.setAttribute(
                "aria-hidden",
                "false"
            );
            entry.elements.minimizeButton?.setAttribute(
                "aria-pressed",
                "false"
            );
            entry.elements.maximizeButton?.setAttribute(
                "aria-pressed",
                "true"
            );

            if (entry.options.footer !== null) {
                entry.elements.footer.hidden = false;
            }

            this._applyMaximizedGeometry(entry);
            this.focus(id);
            entry.updatedAt = iso();
            this.metrics.maximized += 1;
            this._syncState();

            this._emit("maximize", {
                id
            });

            return true;
        }

        restore(id) {
            this._assertActive();

            id = normalizeId(id);
            const entry = this.windows.get(id);

            if (!entry) {
                return false;
            }

            const changed = entry.state.minimized || entry.state.maximized;

            entry.state.minimized = false;
            entry.state.maximized = false;
            entry.elements.panel.classList.remove(
                "is-minimized",
                "is-maximized"
            );
            entry.elements.panel.dataset.windowState = "normal";
            entry.elements.body.hidden =
                entry.visibilityBeforeMinimize?.bodyHidden ?? false;
            entry.elements.panel.setAttribute(
                "aria-hidden",
                "false"
            );
            entry.elements.minimizeButton?.setAttribute(
                "aria-pressed",
                "false"
            );
            entry.elements.maximizeButton?.setAttribute(
                "aria-pressed",
                "false"
            );

            if (entry.options.footer !== null) {
                entry.elements.footer.hidden =
                    entry.visibilityBeforeMinimize?.footerHidden ?? false;
            }

            entry.visibilityBeforeMinimize = null;

            if (entry.restoreGeometry) {
                entry.geometry = clone(entry.restoreGeometry);
            }

            this._applyGeometry(entry);

            if (entry.options.keepInViewport) {
                this._constrainToViewport(entry);
            }

            if (changed) {
                this.focus(id);
            }
            entry.updatedAt = iso();

            if (changed) {
                this.metrics.restored += 1;
                this._syncState();

                this._emit("restore", {
                    id
                });
            }

            return changed;
        }

        move(id, x, y, options = {}) {
            this._assertActive();

            id = normalizeId(id);
            const entry = this.windows.get(id);

            if (!entry || entry.state.maximized) {
                return false;
            }

            entry.geometry.x = parseNumber(x, entry.geometry.x);
            entry.geometry.y = parseNumber(y, entry.geometry.y);

            if (entry.options.keepInViewport) {
                this._constrainToViewport(entry);
            } else {
                this._applyGeometry(entry);
            }

            entry.updatedAt = iso();

            if (options.silent !== true) {
                this.metrics.moved += 1;
                this._syncState();

                this._emit("move", {
                    id,
                    geometry: clone(entry.geometry)
                });
            }

            return clone(entry.geometry);
        }

        resize(id, width, height, options = {}) {
            this._assertActive();

            id = normalizeId(id);
            const entry = this.windows.get(id);

            if (!entry || entry.state.maximized) {
                return false;
            }

            entry.geometry.width = Math.max(
                entry.options.minWidth,
                parseNumber(width, entry.geometry.width)
            );
            entry.geometry.height = Math.max(
                entry.options.minHeight,
                parseNumber(height, entry.geometry.height)
            );

            if (options.x !== undefined) {
                entry.geometry.x = parseNumber(
                    options.x,
                    entry.geometry.x
                );
            }

            if (options.y !== undefined) {
                entry.geometry.y = parseNumber(
                    options.y,
                    entry.geometry.y
                );
            }

            if (entry.options.keepInViewport) {
                this._constrainToViewport(entry);
            } else {
                this._applyGeometry(entry);
            }

            entry.updatedAt = iso();

            if (options.silent !== true) {
                this.metrics.resized += 1;
                this._syncState();

                this._emit("resize", {
                    id,
                    geometry: clone(entry.geometry)
                });
            }

            return clone(entry.geometry);
        }

        setTitle(id, title) {
            const entry = this.windows.get(normalizeId(id));

            if (!entry) {
                return false;
            }

            entry.options.title = String(title);
            entry.elements.title.textContent = entry.options.title;
            entry.updatedAt = iso();
            this._syncState();
            return true;
        }

        setContent(id, content, options = {}) {
            const entry = this.windows.get(normalizeId(id));

            if (!entry) {
                return false;
            }

            if (options.append !== true) {
                entry.elements.body.replaceChildren();
            }

            if (isNode(content)) {
                entry.elements.body.appendChild(content);
            } else {
                entry.elements.body.appendChild(
                    document.createTextNode(String(content ?? ""))
                );
            }

            entry.options.content = content;
            entry.updatedAt = iso();
            this._syncState();

            this._emit("content", {
                id,
                append: options.append === true
            });

            return entry.elements.body;
        }

        setFooter(id, footer) {
            const entry = this.windows.get(normalizeId(id));

            if (!entry) {
                return false;
            }

            entry.elements.footer.replaceChildren();

            if (isNode(footer)) {
                entry.elements.footer.appendChild(footer);
            } else if (footer !== null && footer !== undefined) {
                entry.elements.footer.textContent = String(footer);
            }

            entry.elements.footer.hidden =
                footer === null || footer === undefined;
            entry.options.footer = footer;
            entry.updatedAt = iso();
            this._syncState();
            return entry.elements.footer;
        }

        get(id) {
            const entry = this.windows.get(normalizeId(id));
            return entry?.elements.panel || null;
        }

        getEntry(id) {
            const entry = this.windows.get(normalizeId(id));
            return entry || null;
        }

        has(id) {
            return this.windows.has(normalizeId(id));
        }

        describe(id) {
            const entry = this.windows.get(normalizeId(id));

            if (!entry) {
                return null;
            }

            return {
                id: entry.id,
                title: entry.options.title,
                state: {
                    ...entry.state
                },
                geometry: clone(entry.geometry),
                restoreGeometry: clone(entry.restoreGeometry),
                zIndex: entry.zIndex,
                openedAt: entry.openedAt,
                updatedAt: entry.updatedAt,
                metadata: clone(entry.options.metadata)
            };
        }

        list() {
            return this.order
                .map((id) => this.describe(id))
                .filter(Boolean);
        }

        cycle(direction = 1) {
            const candidates = this.order.filter((id) => {
                const entry = this.windows.get(id);
                return entry && !entry.state.minimized;
            });

            if (!candidates.length) {
                return null;
            }

            const currentIndex = this.activeId
                ? candidates.indexOf(this.activeId)
                : -1;
            const step = direction < 0 ? -1 : 1;
            const nextIndex =
                (currentIndex + step + candidates.length) %
                candidates.length;
            const next = candidates[nextIndex];

            this.focus(next);
            return next;
        }

        cascade() {
            let index = 0;

            for (const id of this.order) {
                const entry = this.windows.get(id);

                if (!entry || entry.state.maximized || entry.state.minimized) {
                    continue;
                }

                entry.geometry.x = 24 + index * this.offset;
                entry.geometry.y = 24 + index * this.offset;
                this._constrainToViewport(entry);
                index += 1;
            }

            this._syncState();

            this._emit("cascade", {
                count: index
            });

            return index;
        }

        tile() {
            const entries = this.order
                .map((id) => this.windows.get(id))
                .filter((entry) => entry && !entry.state.minimized);
            const count = entries.length;

            if (!count) {
                return 0;
            }

            const rect =
                this._rootSize();
            let columns = Math.ceil(Math.sqrt(count));
            let rows = Math.ceil(count / columns);

            while (
                columns > 1 &&
                entries.some(entry => rect.width / columns < entry.options.minWidth)
            ) {
                columns -= 1;
                rows = Math.ceil(count / columns);
            }

            const width = rect.width / columns;
            const height = rect.height / rows;

            entries.forEach((entry, index) => {
                const column = index % columns;
                const row = Math.floor(index / columns);

                entry.state.maximized = false;
                entry.state.minimized = false;
                entry.elements.panel.classList.remove(
                    "is-maximized",
                    "is-minimized"
                );
                entry.elements.panel.dataset.windowState =
                    "normal";
                entry.elements.panel.setAttribute(
                    "aria-hidden",
                    "false"
                );
                entry.elements.minimizeButton?.setAttribute(
                    "aria-pressed",
                    "false"
                );
                entry.elements.maximizeButton?.setAttribute(
                    "aria-pressed",
                    "false"
                );
                entry.elements.body.hidden = false;
                entry.elements.footer.hidden = entry.options.footer === null;
                entry.geometry = {
                    x: column * width,
                    y: row * height,
                    width: Math.max(entry.options.minWidth, width),
                    height: Math.max(entry.options.minHeight, height)
                };
                entry.restoreGeometry = clone(entry.geometry);
                entry.updatedAt = iso();
                this._applyGeometry(entry);
                if (entry.options.keepInViewport) {
                    this._constrainToViewport(entry);
                }
            });

            this._syncState();

            this._emit("tile", {
                count,
                columns,
                rows
            });

            return count;
        }

        watch(callback, options = {}) {
            if (typeof callback !== "function") {
                throw new TypeError("Window watcher must be a function.");
            }

            this.watchers.add(callback);

            if (options.immediate === true) {
                callback({
                    type: "initial",
                    timestamp: iso(),
                    status: this.status()
                }, this);
            }

            return () => this.watchers.delete(callback);
        }

        status() {
            return {
                name: "windows",
                module: MODULE_NAME,
                version: VERSION,
                count: this.windows.size,
                layerConnected:
                    this.layer.isConnected,
                activeId: this.activeId,
                order: [...this.order],
                windows: this.list(),
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

            this._cancelInteraction();
            this.abortController.abort();
            this.closeAll("destroy");

            this._emit("destroy", {
                version: VERSION
            });

            this.watchers.clear();

            if (
                this.ownsLayer &&
                this.layer.childElementCount === 0
            ) {
                this.layer.remove();
            }

            if (this.root[MANAGER_SYMBOL] === this) {
                delete this.root[MANAGER_SYMBOL];
            }

            this.destroyed = true;
            return true;
        }
    }

    function initialize(
        context = {}
    ) {
        const root =
            context.root ||
            document.body ||
            document.documentElement;

        const existing =
            context.windows instanceof
                WindowManager
                ? context.windows
                : root[MANAGER_SYMBOL];

        if (
            existing instanceof
                WindowManager &&
            !existing.destroyed
        ) {
            context.windows =
                existing;

            context.registerService?.(
                "windows",
                existing
            );

            return existing;
        }

        const dataset =
            root?.dataset ||
            {};

        const config =
            context.config?.windows ||
            {};

        const manager =
            new WindowManager(
                context,
                {
                    root,
                    baseZIndex:
                        dataset.terminalWindowZIndex ||
                        config.baseZIndex ||
                        DEFAULT_Z_INDEX,
                    offset:
                        dataset.terminalWindowOffset ||
                        config.offset ||
                        DEFAULT_OFFSET
                }
            );

        root[MANAGER_SYMBOL] =
            manager;

        context.windows =
            manager;

        context.registerService?.(
            "windows",
            manager
        );

        safeDispatch(
            document,
            "speciedex:terminal-windows-ready",
            {
                manager,
                status:
                    manager.status()
            }
        );

        return manager;
    }

    const commands = [{
        name: "windows",
        aliases: ["window", "win"],
        category: "interface",
        description: "Inspect and control terminal windows.",
        usage:
            "windows [status|list|open|focus|close|close-all|minimize|" +
            "maximize|restore|cascade|tile] [id] [title]",
        handler: async ({
            args = [],
            context,
            writeJSON,
            write
        }) => {
            const manager =
                context.windows ||
                context.services?.get?.("windows");

            if (!manager) {
                throw new Error("Window manager is unavailable.");
            }

            const action = String(args[0] || "status").toLowerCase();
            const id = args[1];

            try {
                switch (action) {
                    case "status":
                    case "show":
                    case "info":
                        return writeJSON(manager.status());

                    case "list":
                        return writeJSON({
                            windows: manager.list()
                        });

                    case "open": {
                        const windowId =
                            id ||
                            `window-${Date.now()}`;

                        const title =
                            args.slice(2).join(" ") ||
                            windowId;

                        manager.open(
                            windowId,
                            {
                                title,
                                content:
                                    `Speciedex terminal window: ${title}`
                            }
                        );

                        return write(
                            `Window opened: ${windowId}`,
                            "success"
                        );
                    }

                    case "focus":
                        if (!id) {
                            throw new Error("Usage: windows focus <id>");
                        }
                        if (!manager.focus(id)) {
                            throw new Error(`Window not found: ${id}`);
                        }
                        return write(`Window focused: ${id}`, "success");

                    case "close":
                        if (!id) {
                            throw new Error("Usage: windows close <id>");
                        }
                        if (!manager.close(id, "command")) {
                            throw new Error(`Window not found: ${id}`);
                        }
                        return write(`Window closed: ${id}`, "success");

                    case "close-all":
                        return writeJSON({
                            closed: manager.closeAll("command")
                        });

                    case "minimize":
                        if (!id) {
                            throw new Error("Usage: windows minimize <id>");
                        }
                        if (!manager.minimize(id)) {
                            throw new Error(`Unable to minimize window: ${id}`);
                        }
                        return write(`Window minimized: ${id}`, "success");

                    case "maximize":
                        if (!id) {
                            throw new Error("Usage: windows maximize <id>");
                        }
                        if (!manager.maximize(id)) {
                            throw new Error(`Unable to maximize window: ${id}`);
                        }
                        return write(`Window maximized: ${id}`, "success");

                    case "restore":
                        if (!id) {
                            throw new Error("Usage: windows restore <id>");
                        }
                        if (!manager.has(id)) {
                            throw new Error(`Window not found: ${id}`);
                        }
                        manager.restore(id);
                        return write(`Window restored: ${id}`, "success");

                    case "cascade":
                        return writeJSON({
                            cascaded: manager.cascade()
                        });

                    case "tile":
                        return writeJSON({
                            tiled: manager.tile()
                        });

                    default:
                        throw new Error(
                            `Unknown windows action "${action}". Use status, list, open, focus, ` +
                            "close, close-all, minimize, maximize, restore, cascade, or tile."
                        );
                }
            } catch (error) {
                throw error;
            }
        }
    }];

    const api = Object.freeze({
        name: MODULE_NAME,
        version: VERSION,
        MANAGER_SYMBOL,
        WindowManager,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalWindows = api;
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
