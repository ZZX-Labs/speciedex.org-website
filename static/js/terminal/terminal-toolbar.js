/*
========================================================================
Speciedex.org
Terminal Toolbar Controller
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Toolbar";
    const DEFAULT_SELECTOR = "[data-terminal-header] .terminal-actions";
    const DEFAULT_GROUP = "primary";
    const DEFAULT_PRIORITY = 100;
    const RESERVED_NAMES = new Set(["__proto__", "prototype", "constructor"]);

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

    function safeDispatch(target, name, detail) {
        try {
            target.dispatchEvent(new CustomEvent(name, { detail }));
        } catch (error) {
            /* Toolbar events must not interrupt UI operation. */
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

    function normalizeName(value) {
        const name = String(value ?? "")
            .trim()
            .replace(/\s+/g, "-")
            .replace(/[^a-zA-Z0-9._:-]/g, "-")
            .replace(/-+/g, "-")
            .replace(/^[-.]+|[-.]+$/g, "");

        if (!name) {
            throw new TypeError("Toolbar action name must be non-empty.");
        }

        if (RESERVED_NAMES.has(name)) {
            throw new TypeError("Reserved toolbar action name is not allowed.");
        }

        return name;
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

    class ToolbarController extends EventTarget {
        constructor(context = {}, options = {}) {
            super();

            this.context = context;
            this.root = options.root || context.root || document;
            this.selector = options.selector || DEFAULT_SELECTOR;
            this.element = options.element || this.root.querySelector?.(this.selector) || null;
            this.actions = new Map();
            this.groups = new Map();
            this.shortcuts = new Map();
            this.watchers = new Set();
            this.destroyed = false;
            this.lastError = null;
            this.metrics = {
                registered: 0,
                removed: 0,
                invoked: 0,
                failed: 0,
                refreshed: 0
            };

            this._boundKeydown = this._handleKeydown.bind(this);
            this._boundMutation = this._handleMutation.bind(this);
            this._observer = null;

            window.addEventListener("keydown", this._boundKeydown);

            if (options.observe !== false && typeof MutationObserver === "function") {
                this._observer = new MutationObserver(this._boundMutation);
                this._observer.observe(this.root === document ? document.documentElement : this.root, {
                    childList: true,
                    subtree: true
                });
            }

            this._discoverExistingActions();
            this._syncState();
        }

        _assertActive() {
            if (this.destroyed) {
                throw new Error("Toolbar controller has been destroyed.");
            }
        }

        _emit(type, detail = {}) {
            const event = {
                type,
                timestamp: iso(),
                ...detail
            };

            safeDispatch(this, type, event);
            safeDispatch(this, "change", event);

            for (const watcher of Array.from(this.watchers)) {
                try {
                    watcher(event, this);
                } catch (error) {
                    this._recordError(error);
                }
            }

            try {
                this.context.events?.emit?.(`toolbar:${type}`, event);
            } catch (error) {
                this._recordError(error);
            }

            return event;
        }

        _recordError(error) {
            this.lastError = error instanceof Error
                ? error
                : new Error(String(error));
            this.metrics.failed += 1;

            this._emit("error", {
                error: {
                    name: this.lastError.name,
                    message: this.lastError.message,
                    stack: this.lastError.stack || ""
                }
            });
        }

        _syncState() {
            const state = this.context.state || this.context.stateStore;

            try {
                state?.set?.("terminal.toolbar", {
                    available: Boolean(this.element),
                    actions: this.list(),
                    groups: Array.from(this.groups.keys()),
                    shortcuts: Array.from(this.shortcuts.keys()),
                    updatedAt: iso()
                });
            } catch (error) {
                /* State synchronization is advisory. */
            }
        }

        _ensureElement() {
            if (this.element?.isConnected) {
                return this.element;
            }

            this.element = this.root.querySelector?.(this.selector) || null;

            if (this.element) {
                this._renderAll();
            }

            return this.element;
        }

        _handleMutation() {
            const previous = this.element;
            const current = this._ensureElement();

            if (current && current !== previous) {
                this._emit("attach", {
                    element: current
                });
            }
        }

        _discoverExistingActions() {
            if (!this.element) {
                return;
            }

            for (const button of this.element.querySelectorAll("[data-terminal-action]")) {
                const name = button.dataset.terminalAction;

                if (!name || this.actions.has(name)) {
                    continue;
                }

                this.actions.set(name, {
                    name,
                    label: button.textContent?.trim() || name,
                    element: button,
                    handler: null,
                    group: button.dataset.terminalGroup || DEFAULT_GROUP,
                    priority: parseNumber(
                        button.dataset.terminalPriority,
                        DEFAULT_PRIORITY
                    ),
                    disabled: button.disabled,
                    hidden: button.hidden,
                    builtin: true,
                    shortcut: button.dataset.terminalShortcut || null,
                    createdAt: iso()
                });
            }

            this._rebuildGroups();
        }

        _rebuildGroups() {
            this.groups.clear();

            for (const action of this.actions.values()) {
                if (!this.groups.has(action.group)) {
                    this.groups.set(action.group, []);
                }

                this.groups.get(action.group).push(action.name);
            }

            for (const names of this.groups.values()) {
                names.sort((left, right) => {
                    const leftAction = this.actions.get(left);
                    const rightAction = this.actions.get(right);

                    return (
                        leftAction.priority - rightAction.priority ||
                        leftAction.name.localeCompare(rightAction.name)
                    );
                });
            }
        }

        _renderAll() {
            if (!this.element) {
                return;
            }

            const actions = Array.from(this.actions.values())
                .sort((left, right) => {
                    return (
                        left.group.localeCompare(right.group) ||
                        left.priority - right.priority ||
                        left.name.localeCompare(right.name)
                    );
                });

            for (const action of actions) {
                if (!action.element || !action.element.isConnected) {
                    action.element = this._createActionElement(action);
                }

                this.element.appendChild(action.element);
            }

            this.metrics.refreshed += 1;
            this._syncState();
        }

        _createActionElement(action) {
            const button = createElement(
                "button",
                `terminal-action${action.className ? ` ${action.className}` : ""}`
            );
            button.type = "button";
            button.dataset.terminalAction = action.name;
            button.dataset.terminalGroup = action.group;
            button.dataset.terminalPriority = String(action.priority);
            button.disabled = Boolean(action.disabled);
            button.hidden = Boolean(action.hidden);
            button.setAttribute("aria-label", action.ariaLabel || action.label || action.name);
            button.setAttribute("aria-disabled", button.disabled ? "true" : "false");

            if (action.title) {
                button.title = action.title;
            }

            if (action.shortcut) {
                button.dataset.terminalShortcut = action.shortcut;
                button.setAttribute("aria-keyshortcuts", action.shortcut);
            }

            if (action.pressed !== undefined) {
                button.setAttribute("aria-pressed", action.pressed ? "true" : "false");
            }

            if (action.icon) {
                const icon = createElement(
                    "span",
                    "terminal-action-icon",
                    action.icon
                );
                icon.setAttribute("aria-hidden", "true");
                button.appendChild(icon);
            }

            const label = createElement(
                "span",
                "terminal-action-label",
                action.label || action.name
            );
            button.appendChild(label);

            if (action.badge !== undefined && action.badge !== null) {
                const badge = createElement(
                    "span",
                    "terminal-action-badge",
                    String(action.badge)
                );
                badge.setAttribute("aria-label", `${action.badge} notifications`);
                button.appendChild(badge);
            }

            button.addEventListener("click", (event) => {
                this.invoke(action.name, {
                    event,
                    source: "pointer"
                }).catch((error) => this._recordError(error));
            });

            return button;
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

            if (editable) {
                return;
            }

            for (const [shortcut, name] of this.shortcuts) {
                if (this._matchesShortcut(event, shortcut)) {
                    event.preventDefault();

                    this.invoke(name, {
                        event,
                        source: "keyboard"
                    }).catch((error) => this._recordError(error));

                    return;
                }
            }
        }

        _matchesShortcut(event, shortcut) {
            const parts = String(shortcut)
                .toLowerCase()
                .split("+")
                .map((part) => part.trim())
                .filter(Boolean);
            const key = parts.pop();

            return (
                event.key.toLowerCase() === key &&
                event.ctrlKey === parts.includes("ctrl") &&
                event.metaKey === parts.includes("meta") &&
                event.shiftKey === parts.includes("shift") &&
                event.altKey === parts.includes("alt")
            );
        }

        addAction(name, label, handler, options = {}) {
            this._assertActive();

            if (isObject(label)) {
                options = label;
                label = options.label;
                handler = options.handler;
            } else if (isObject(handler)) {
                options = handler;
                handler = options.handler;
            }

            name = normalizeName(name);

            if (this.actions.has(name) && options.replace !== true) {
                throw new Error(`Toolbar action already exists: ${name}`);
            }

            const action = {
                name,
                label: String(label || options.label || name),
                handler: typeof handler === "function"
                    ? handler
                    : typeof options.handler === "function"
                        ? options.handler
                        : null,
                group: normalizeName(options.group || DEFAULT_GROUP),
                priority: parseNumber(
                    options.priority,
                    DEFAULT_PRIORITY,
                    -100000,
                    100000
                ),
                disabled: options.disabled === true,
                hidden: options.hidden === true,
                icon: options.icon !== undefined ? String(options.icon) : null,
                badge: options.badge ?? null,
                title: options.title ? String(options.title) : "",
                ariaLabel: options.ariaLabel ? String(options.ariaLabel) : "",
                className: options.className ? String(options.className) : "",
                shortcut: options.shortcut ? String(options.shortcut) : null,
                pressed: options.pressed,
                metadata: clone(options.metadata || {}),
                createdAt: iso(),
                updatedAt: iso(),
                element: null
            };

            if (this.actions.has(name)) {
                this.removeAction(name, {
                    silent: true
                });
            }

            action.element = this._createActionElement(action);
            this.actions.set(name, action);

            if (action.shortcut) {
                this.shortcuts.set(action.shortcut.toLowerCase(), name);
            }

            this._rebuildGroups();

            const element = this._ensureElement();

            if (element) {
                this._renderAll();
            }

            this.metrics.registered += 1;
            this._syncState();

            this._emit("add", {
                action: this.describe(name)
            });

            return action.element;
        }

        removeAction(name, options = {}) {
            this._assertActive();

            name = normalizeName(name);
            const action = this.actions.get(name);

            if (!action) {
                return false;
            }

            if (action.shortcut) {
                this.shortcuts.delete(action.shortcut.toLowerCase());
            }

            action.element?.remove();
            this.actions.delete(name);
            this._rebuildGroups();
            this.metrics.removed += 1;
            this._syncState();

            if (options.silent !== true) {
                this._emit("remove", {
                    name
                });
            }

            return true;
        }

        updateAction(name, update = {}) {
            this._assertActive();

            name = normalizeName(name);
            const action = this.actions.get(name);

            if (!action) {
                throw new Error(`Unknown toolbar action: ${name}`);
            }

            if (!isObject(update)) {
                throw new TypeError("Toolbar action update must be an object.");
            }

            if (update.shortcut !== undefined && action.shortcut) {
                this.shortcuts.delete(action.shortcut.toLowerCase());
            }

            Object.assign(action, {
                label: update.label !== undefined
                    ? String(update.label)
                    : action.label,
                handler: typeof update.handler === "function"
                    ? update.handler
                    : action.handler,
                group: update.group !== undefined
                    ? normalizeName(update.group)
                    : action.group,
                priority: update.priority !== undefined
                    ? parseNumber(update.priority, action.priority)
                    : action.priority,
                disabled: update.disabled !== undefined
                    ? Boolean(update.disabled)
                    : action.disabled,
                hidden: update.hidden !== undefined
                    ? Boolean(update.hidden)
                    : action.hidden,
                icon: update.icon !== undefined
                    ? String(update.icon)
                    : action.icon,
                badge: update.badge !== undefined
                    ? update.badge
                    : action.badge,
                title: update.title !== undefined
                    ? String(update.title)
                    : action.title,
                ariaLabel: update.ariaLabel !== undefined
                    ? String(update.ariaLabel)
                    : action.ariaLabel,
                className: update.className !== undefined
                    ? String(update.className)
                    : action.className,
                shortcut: update.shortcut !== undefined
                    ? String(update.shortcut)
                    : action.shortcut,
                pressed: update.pressed !== undefined
                    ? Boolean(update.pressed)
                    : action.pressed,
                metadata: update.metadata !== undefined
                    ? clone(update.metadata)
                    : action.metadata,
                updatedAt: iso()
            });

            if (action.shortcut) {
                this.shortcuts.set(action.shortcut.toLowerCase(), name);
            }

            action.element?.remove();
            action.element = this._createActionElement(action);
            this._rebuildGroups();
            this._renderAll();
            this._syncState();

            this._emit("update", {
                action: this.describe(name)
            });

            return action.element;
        }

        setDisabled(name, disabled = true) {
            const action = this.actions.get(normalizeName(name));

            if (!action) {
                return false;
            }

            action.disabled = Boolean(disabled);

            if (action.element) {
                action.element.disabled = action.disabled;
                action.element.setAttribute(
                    "aria-disabled",
                    action.disabled ? "true" : "false"
                );
            }

            this._syncState();
            return true;
        }

        setHidden(name, hidden = true) {
            const action = this.actions.get(normalizeName(name));

            if (!action) {
                return false;
            }

            action.hidden = Boolean(hidden);

            if (action.element) {
                action.element.hidden = action.hidden;
            }

            this._syncState();
            return true;
        }

        setPressed(name, pressed = true) {
            const action = this.actions.get(normalizeName(name));

            if (!action) {
                return false;
            }

            action.pressed = Boolean(pressed);
            action.element?.setAttribute(
                "aria-pressed",
                action.pressed ? "true" : "false"
            );
            this._syncState();
            return true;
        }

        setBadge(name, badge = null) {
            const action = this.actions.get(normalizeName(name));

            if (!action) {
                return false;
            }

            action.badge = badge;

            if (action.element) {
                const existing = action.element.querySelector(".terminal-action-badge");

                if (badge === null || badge === undefined || badge === "") {
                    existing?.remove();
                } else if (existing) {
                    existing.textContent = String(badge);
                } else {
                    const element = createElement(
                        "span",
                        "terminal-action-badge",
                        String(badge)
                    );
                    action.element.appendChild(element);
                }
            }

            this._syncState();
            return true;
        }

        async invoke(name, parameters = {}) {
            this._assertActive();

            name = normalizeName(name);
            const action = this.actions.get(name);

            if (!action) {
                throw new Error(`Unknown toolbar action: ${name}`);
            }

            if (action.disabled || action.hidden) {
                return {
                    invoked: false,
                    reason: action.disabled ? "disabled" : "hidden"
                };
            }

            this.metrics.invoked += 1;

            this._emit("invoke", {
                name,
                source: parameters.source || "api"
            });

            if (typeof action.handler !== "function") {
                return {
                    invoked: true,
                    result: null
                };
            }

            try {
                const result = await action.handler({
                    name,
                    action: this.describe(name),
                    context: this.context,
                    controller: this,
                    ...parameters
                });

                this._emit("complete", {
                    name,
                    result: clone(result)
                });

                return {
                    invoked: true,
                    result
                };
            } catch (error) {
                this._recordError(error);

                this._emit("failure", {
                    name,
                    error: {
                        name: error.name,
                        message: error.message
                    }
                });

                throw error;
            }
        }

        describe(name) {
            const action = this.actions.get(normalizeName(name));

            if (!action) {
                return null;
            }

            return {
                name: action.name,
                label: action.label,
                group: action.group,
                priority: action.priority,
                disabled: action.disabled,
                hidden: action.hidden,
                icon: action.icon,
                badge: action.badge,
                title: action.title,
                ariaLabel: action.ariaLabel,
                className: action.className,
                shortcut: action.shortcut,
                pressed: action.pressed,
                metadata: clone(action.metadata),
                createdAt: action.createdAt,
                updatedAt: action.updatedAt
            };
        }

        list(options = {}) {
            let actions = Array.from(this.actions.keys())
                .map((name) => this.describe(name))
                .filter(Boolean);

            if (options.group) {
                actions = actions.filter((action) => action.group === options.group);
            }

            if (options.visibleOnly === true) {
                actions = actions.filter((action) => !action.hidden);
            }

            if (options.enabledOnly === true) {
                actions = actions.filter((action) => !action.disabled);
            }

            return actions.sort((left, right) => {
                return (
                    left.group.localeCompare(right.group) ||
                    left.priority - right.priority ||
                    left.name.localeCompare(right.name)
                );
            });
        }

        clear(options = {}) {
            const names = Array.from(this.actions.keys());
            let removed = 0;

            for (const name of names) {
                const action = this.actions.get(name);

                if (options.preserveBuiltin === true && action?.builtin) {
                    continue;
                }

                if (this.removeAction(name, { silent: true })) {
                    removed += 1;
                }
            }

            this._emit("clear", {
                removed
            });

            return removed;
        }

        refresh() {
            this._assertActive();
            this._ensureElement();
            this._renderAll();

            this._emit("refresh", {
                available: Boolean(this.element),
                actions: this.actions.size
            });

            return this.element;
        }

        watch(callback, options = {}) {
            if (typeof callback !== "function") {
                throw new TypeError("Toolbar watcher must be a function.");
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
                name: "toolbar",
                module: MODULE_NAME,
                selector: this.selector,
                available: Boolean(this.element?.isConnected),
                actions: this.list(),
                groups: Array.from(this.groups.entries()).map(([name, actions]) => ({
                    name,
                    actions: [...actions]
                })),
                shortcuts: Array.from(this.shortcuts.entries()).map(([shortcut, name]) => ({
                    shortcut,
                    name
                })),
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

            window.removeEventListener("keydown", this._boundKeydown);
            this._observer?.disconnect();
            this._observer = null;
            this.watchers.clear();
            this.shortcuts.clear();
            this.actions.clear();
            this.groups.clear();
            this.destroyed = true;

            this._emit("destroy", {});
            return true;
        }
    }

    function initialize(context = {}) {
        const dataset = context.root?.dataset || {};
        const config = context.config?.toolbar || {};

        const controller = new ToolbarController(context, {
            root: context.root || document,
            selector:
                dataset.terminalToolbarSelector ||
                config.selector ||
                DEFAULT_SELECTOR,
            observe: parseBoolean(
                dataset.terminalToolbarObserve,
                config.observe !== false
            )
        });

        context.toolbar = controller;
        context.registerService?.("toolbar", controller);

        safeDispatch(document, "speciedex:terminal-toolbar-ready", {
            controller,
            status: controller.status()
        });

        return controller;
    }

    const commands = [{
        name: "toolbar",
        category: "interface",
        description: "Inspect and control terminal toolbar actions.",
        usage: "toolbar [status|list|invoke|enable|disable|show|hide|refresh] [action]",
        handler: async ({
            args = [],
            context,
            writeJSON,
            write,
            writeError
        }) => {
            const toolbar =
                context.toolbar ||
                context.services?.get?.("toolbar");

            if (!toolbar) {
                throw new Error("Toolbar service is unavailable.");
            }

            const action = String(args[0] || "status").toLowerCase();
            const name = args[1];

            try {
                switch (action) {
                    case "status":
                    case "show":
                    case "info":
                        return writeJSON(toolbar.status());

                    case "list":
                        return writeJSON({
                            actions: toolbar.list()
                        });

                    case "invoke":
                    case "run":
                        if (!name) {
                            throw new Error("Usage: toolbar invoke <action>");
                        }
                        return writeJSON(await toolbar.invoke(name, {
                            source: "command"
                        }));

                    case "enable":
                        if (!name) {
                            throw new Error("Usage: toolbar enable <action>");
                        }
                        toolbar.setDisabled(name, false);
                        return write(`Toolbar action enabled: ${name}`, "success");

                    case "disable":
                        if (!name) {
                            throw new Error("Usage: toolbar disable <action>");
                        }
                        toolbar.setDisabled(name, true);
                        return write(`Toolbar action disabled: ${name}`, "success");

                    case "hide":
                        if (!name) {
                            throw new Error("Usage: toolbar hide <action>");
                        }
                        toolbar.setHidden(name, true);
                        return write(`Toolbar action hidden: ${name}`, "success");

                    case "unhide":
                    case "reveal":
                        if (!name) {
                            throw new Error("Usage: toolbar unhide <action>");
                        }
                        toolbar.setHidden(name, false);
                        return write(`Toolbar action shown: ${name}`, "success");

                    case "refresh":
                        toolbar.refresh();
                        return write("Toolbar refreshed.", "success");

                    default:
                        throw new Error(
                            `Unknown toolbar action "${action}". Use status, list, ` +
                            "invoke, enable, disable, hide, unhide, or refresh."
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
        ToolbarController,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalToolbar = api;
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
