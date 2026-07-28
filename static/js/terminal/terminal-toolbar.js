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
    const VERSION = "2.2.0";

    const TOOLBAR_SYMBOL =
        Symbol.for(
            "speciedex.terminal.toolbar.controller"
        );

    const DEFAULT_SELECTOR =
        "[data-terminal-header] .terminal-actions, .terminal-header .terminal-actions";
    const DEFAULT_GROUP = "primary";
    const DEFAULT_PRIORITY = 100;
    const RESERVED_NAMES =
        new Set([
            "__proto__",
            "prototype",
            "constructor"
        ]);

    const DEFAULT_MAX_ACTIONS = 256;
    const DEFAULT_MUTATION_DEBOUNCE = 50;
    let CONTROLLER_SEQUENCE = 0;

    const BUILTIN_ALIASES =
        Object.freeze({
            "?":
                "help",
            help:
                "help",
            copy:
                "copy",
            clear:
                "clear",
            restart:
                "restart",
            reload:
                "restart",
            fullscreen:
                "fullscreen",
            "full-screen":
                "fullscreen"
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
            if (
                RESERVED_NAMES.has(
                    key
                )
            ) {
                continue;
            }

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
            this.selector =
                options.selector ||
                DEFAULT_SELECTOR;

            this.element =
                options.element ||
                this.root.querySelector?.(
                    this.selector
                ) ||
                null;

            this.maxActions =
                parseNumber(
                    options.maxActions,
                    DEFAULT_MAX_ACTIONS,
                    1,
                    10000
                );

            this.mutationDebounce =
                parseNumber(
                    options.mutationDebounce,
                    DEFAULT_MUTATION_DEBOUNCE,
                    0,
                    5000
                );
            this.actions = new Map();
            this.groups = new Map();
            this.shortcuts = new Map();
            this.watchers = new Set();
            this.destroyed = false;
            this.lastError = null;
            this.emitting = false;
            this.syncingState = false;
            this.refreshTimer = null;
            this.abortController =
                new AbortController();
            this.bindingId =
                `toolbar-${++CONTROLLER_SEQUENCE}`;
            this.boundElements =
                new Map();
            this.observerTarget =
                null;
            this.metrics = {
                registered: 0,
                removed: 0,
                invoked: 0,
                failed: 0,
                refreshed: 0,
                discovered: 0,
                reattached: 0,
                shortcutConflicts: 0,
                builtinInvocations: 0,
                stateSyncs: 0
            };

            this._boundKeydown = this._handleKeydown.bind(this);
            this._boundMutation = this._handleMutation.bind(this);
            this._observer = null;

            window.addEventListener(
                "keydown",
                this._boundKeydown,
                {
                    signal:
                        this.abortController.signal
                }
            );

            if (
                options.observe !== false &&
                typeof MutationObserver === "function"
            ) {
                this._observer =
                    new MutationObserver(
                        this._boundMutation
                    );

                this.observerTarget =
                    this.element?.parentElement ||
                    (
                        this.root === document
                            ? document.querySelector(
                                "[data-terminal-header], .terminal-header"
                            ) || document.body || document.documentElement
                            : this.root
                    );

                this._observer.observe(
                    this.observerTarget,
                    {
                        childList: true,
                        subtree: true
                    }
                );
            }

            this._discoverExistingActions();
            this._syncState();
        }

        _assertActive() {
            if (this.destroyed) {
                throw new Error("Toolbar controller has been destroyed.");
            }
        }

        _emit(
            type,
            detail = {}
        ) {
            if (
                this.destroyed &&
                type !==
                    "destroy"
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

                for (
                    const watcher of
                    Array.from(
                        this.watchers
                    )
                ) {
                    try {
                        watcher(
                            event,
                            this
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

                        this.metrics.failed +=
                            1;
                    }
                }

                try {
                    this.context.events?.emit?.(
                        `toolbar:${type}`,
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

                    this.metrics.failed +=
                        1;
                }

                safeDispatch(
                    document,
                    `speciedex:terminal-toolbar-${type}`,
                    event
                );

                return event;
            } finally {
                this.emitting =
                    false;
            }
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
                state.set(
                    "terminal.toolbar",
                    {
                        available:
                            Boolean(
                                this.element
                            ),
                        actions:
                            this.list(),
                        groups:
                            Array.from(
                                this.groups.keys()
                            ),
                        shortcuts:
                            Array.from(
                                this.shortcuts.keys()
                            ),
                        updatedAt:
                            iso()
                    },
                    {
                        source:
                            "toolbar",
                        undoable:
                            false,
                        persist:
                            false,
                        broadcast:
                            false
                    }
                );

                this.metrics.stateSyncs +=
                    1;

                return true;
            } catch (_error) {
                return false;
            } finally {
                this.syncingState =
                    false;
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
            if (
                this.destroyed ||
                this.refreshTimer !==
                    null
            ) {
                return;
            }

            this.refreshTimer =
                window.setTimeout(
                    () => {
                        this.refreshTimer =
                            null;

                        const previous =
                            this.element;

                        const current =
                            this._ensureElement();

                        this._discoverExistingActions();

                        if (
                            current &&
                            current !==
                                previous
                        ) {
                            this.metrics.reattached +=
                                1;

                            this._emit(
                                "attach",
                                {
                                    element:
                                        current
                                }
                            );
                        }
                    },
                    this.mutationDebounce
                );
        }

        _discoverExistingActions() {
            const element =
                this._ensureElement();

            if (!element) {
                return 0;
            }

            let discovered =
                0;

            const buttons =
                element.querySelectorAll(
                    "[data-terminal-action], .terminal-action"
                );

            for (
                const button of
                buttons
            ) {
                const rawName =
                    button.dataset.terminalAction ||
                    button.getAttribute(
                        "aria-label"
                    ) ||
                    button.title ||
                    button.textContent ||
                    "";

                const alias =
                    BUILTIN_ALIASES[
                        String(
                            rawName
                        )
                            .trim()
                            .toLowerCase()
                    ];

                let name;

                try {
                    name =
                        normalizeName(
                            alias ||
                            rawName
                        );
                } catch (_error) {
                    continue;
                }

                const existing =
                    this.actions.get(
                        name
                    );

                if (existing) {
                    if (
                        existing.element &&
                        existing.element !==
                            button
                    ) {
                        this._unbindActionElement(
                            existing.element
                        );
                    }

                    existing.element =
                        button;

                    existing.disabled =
                        button.disabled;

                    existing.hidden =
                        button.hidden;

                    this._bindActionElement(
                        existing,
                        button
                    );

                    continue;
                }

                const action = {
                    name,
                    label:
                        button.textContent?.trim() ||
                        name,
                    element:
                        button,
                    handler:
                        this._builtinHandler(
                            name
                        ),
                    group:
                        button.dataset.terminalGroup ||
                        DEFAULT_GROUP,
                    priority:
                        parseNumber(
                            button.dataset.terminalPriority,
                            DEFAULT_PRIORITY
                        ),
                    disabled:
                        button.disabled,
                    hidden:
                        button.hidden,
                    builtin:
                        true,
                    shortcut:
                        button.dataset.terminalShortcut ||
                        null,
                    createdAt:
                        iso(),
                    updatedAt:
                        iso(),
                    metadata:
                        {}
                };

                this.actions.set(
                    name,
                    action
                );

                if (
                    action.shortcut
                ) {
                    this._registerShortcut(
                        action.shortcut,
                        name
                    );
                }

                this._bindActionElement(
                    action,
                    button
                );

                discovered +=
                    1;
            }

            this.metrics.discovered +=
                discovered;

            this._rebuildGroups();

            return discovered;
        }

        _registerShortcut(
            shortcut,
            name
        ) {
            if (!shortcut) {
                return false;
            }

            const normalized =
                String(
                    shortcut
                )
                    .trim()
                    .toLowerCase();

            if (!normalized) {
                return false;
            }

            const existing =
                this.shortcuts.get(
                    normalized
                );

            if (
                existing &&
                existing !==
                    name
            ) {
                this.metrics.shortcutConflicts +=
                    1;

                return false;
            }

            this.shortcuts.set(
                normalized,
                name
            );

            return true;
        }

        _unbindActionElement(
            button
        ) {
            if (!button) {
                return false;
            }

            const binding =
                this.boundElements.get(
                    button
                );

            if (binding) {
                button.removeEventListener(
                    "click",
                    binding.listener
                );

                this.boundElements.delete(
                    button
                );
            }

            if (
                button.dataset.toolbarBound ===
                    this.bindingId ||
                button.dataset.toolbarBound ===
                    "true"
            ) {
                delete button.dataset.toolbarBound;
            }

            return Boolean(
                binding
            );
        }

        _bindActionElement(
            action,
            button
        ) {
            if (!button) {
                return button;
            }

            const existing =
                this.boundElements.get(
                    button
                );

            if (
                existing &&
                existing.actionName ===
                    action.name
            ) {
                button.dataset.toolbarBound =
                    this.bindingId;

                return button;
            }

            if (existing) {
                this._unbindActionElement(
                    button
                );
            }

            const listener =
                event => {
                    this.invoke(
                        action.name,
                        {
                            event,
                            source:
                                "pointer"
                        }
                    ).catch(
                        error =>
                            this._recordError(
                                error
                            )
                    );
                };

            button.addEventListener(
                "click",
                listener,
                {
                    signal:
                        this.abortController.signal
                }
            );

            this.boundElements.set(
                button,
                {
                    actionName:
                        action.name,
                    listener
                }
            );

            button.dataset.toolbarBound =
                this.bindingId;

            return button;
        }

        _resolveCommandExecutor() {
            const context =
                this.context;

            const candidates = [
                [context, "execute"],
                [context, "runCommand"],
                [context.terminal, "execute"],
                [context.terminal, "runCommand"],
                [context.dispatcher, "execute"],
                [context.dispatcher, "dispatch"],
                [context.commandDispatcher, "execute"],
                [context.commandRegistry, "execute"],
                [context.registry, "execute"],
                [context.commands, "execute"],
                [context.commands, "run"],
                [context.services?.get?.("dispatcher"), "execute"],
                [context.services?.get?.("commands"), "execute"],
                [context.services?.get?.("command-registry"), "execute"]
            ];

            for (
                const [owner, method] of
                candidates
            ) {
                if (
                    owner &&
                    typeof owner[method] ===
                        "function"
                ) {
                    return owner[method].bind(
                        owner
                    );
                }
            }

            return null;
        }

        async _executeCommand(
            command
        ) {
            const execute =
                this._resolveCommandExecutor();

            if (
                typeof execute !==
                    "function"
            ) {
                throw new Error(
                    "Toolbar cannot locate the terminal command execution bridge."
                );
            }

            return execute(
                command
            );
        }

        _builtinHandler(
            name
        ) {
            const normalized =
                BUILTIN_ALIASES[
                    String(
                        name
                    ).toLowerCase()
                ] ||
                String(
                    name
                ).toLowerCase();

            const context =
                this.context;

            switch (
                normalized
            ) {
                case "help":
                    return async () => {
                        this.metrics.builtinInvocations +=
                            1;

                        const execute =
                            this._resolveCommandExecutor();

                        if (
                            typeof execute ===
                                "function"
                        ) {
                            return execute(
                                "help"
                            );
                        }

                        if (
                            typeof context.help?.show ===
                                "function"
                        ) {
                            return context.help.show();
                        }

                        throw new Error(
                            "Toolbar Help cannot locate the terminal command execution bridge."
                        );
                    };

                case "copy":
                    return async () => {
                        this.metrics.builtinInvocations +=
                            1;

                        const output =
                            context.root?.
                                querySelector?.(
                                    "[data-terminal-output], .terminal-output"
                                );

                        const text =
                            output?.innerText ||
                            output?.textContent ||
                            "";

                        if (
                            navigator.clipboard?.
                                writeText
                        ) {
                            await navigator.clipboard.writeText(
                                text
                            );

                            return {
                                copied:
                                    true,
                                characters:
                                    text.length
                            };
                        }

                        if (!output) {
                            throw new Error(
                                "Terminal output element is unavailable."
                            );
                        }

                        const selection =
                            window.getSelection();

                        if (!selection) {
                            throw new Error(
                                "Browser text selection is unavailable."
                            );
                        }

                        const range =
                            document.createRange();

                        range.selectNodeContents(
                            output
                        );

                        selection.removeAllRanges();
                        selection.addRange(
                            range
                        );

                        const copied =
                            document.execCommand(
                                "copy"
                            );

                        selection.removeAllRanges();

                        return {
                            copied,
                            characters:
                                text.length
                        };
                    };

                case "clear":
                    return async () => {
                        this.metrics.builtinInvocations +=
                            1;

                        if (
                            typeof context.clear ===
                                "function"
                        ) {
                            return context.clear();
                        }

                        const output =
                            context.root?.
                                querySelector?.(
                                    "[data-terminal-output], .terminal-output"
                                );

                        output?.replaceChildren?.();

                        return true;
                    };

                case "restart":
                    return async () => {
                        this.metrics.builtinInvocations +=
                            1;

                        if (
                            typeof context.restart ===
                                "function"
                        ) {
                            return context.restart();
                        }

                        if (
                            typeof context.reset ===
                                "function"
                        ) {
                            return context.reset();
                        }

                        const dispatched =
                            safeDispatch(
                                document,
                                "speciedex:terminal-restart-requested",
                                {
                                    source:
                                        "toolbar"
                                }
                            );

                        if (!dispatched) {
                            throw new Error(
                                "Unable to dispatch the terminal restart request."
                            );
                        }

                        return {
                            requested:
                                true
                        };
                    };

                case "fullscreen":
                    return async () => {
                        this.metrics.builtinInvocations +=
                            1;

                        const target =
                            context.root ||
                            document.documentElement;

                        if (
                            document.fullscreenElement
                        ) {
                            await document.exitFullscreen?.();

                            return {
                                fullscreen:
                                    false
                            };
                        }

                        if (
                            typeof target.requestFullscreen !==
                                "function"
                        ) {
                            throw new Error(
                                "Fullscreen mode is not supported by this browser."
                            );
                        }

                        await target.requestFullscreen();

                        return {
                            fullscreen:
                                Boolean(
                                    document.fullscreenElement
                                )
                        };
                    };

                default:
                    return null;
            }
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
                if (
                    !action.element ||
                    !action.element.isConnected
                ) {
                    action.element =
                        this._createActionElement(
                            action
                        );
                } else {
                    this._bindActionElement(
                        action,
                        action.element
                    );
                }

                this.element.appendChild(
                    action.element
                );
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

            this._bindActionElement(
                action,
                button
            );

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

            if (
                editable &&
                !event.ctrlKey &&
                !event.metaKey &&
                !event.altKey
            ) {
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

            if (
                this.actions.has(
                    name
                ) &&
                options.replace !==
                    true
            ) {
                throw new Error(
                    `Toolbar action already exists: ${name}`
                );
            }

            if (
                !this.actions.has(
                    name
                ) &&
                this.actions.size >=
                    this.maxActions
            ) {
                throw new RangeError(
                    `Toolbar action limit reached: ${this.maxActions}`
                );
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

            if (
                action.shortcut
            ) {
                this._registerShortcut(
                    action.shortcut,
                    name
                );
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

            this._unbindActionElement(
                action.element
            );
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

            if (
                action.shortcut
            ) {
                this._registerShortcut(
                    action.shortcut,
                    name
                );
            }

            this._unbindActionElement(
                action.element
            );
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
                    existing.setAttribute(
                        "aria-label",
                        `${badge} notifications`
                    );
                } else {
                    const element = createElement(
                        "span",
                        "terminal-action-badge",
                        String(badge)
                    );
                    element.setAttribute(
                        "aria-label",
                        `${badge} notifications`
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

            if (
                typeof action.handler !==
                    "function"
            ) {
                action.handler =
                    this._builtinHandler(
                        action.name
                    );
            }

            if (
                typeof action.handler !==
                    "function"
            ) {
                return {
                    invoked:
                        false,
                    reason:
                        "no-handler"
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
            this._assertActive();

            if (
                typeof callback !==
                    "function"
            ) {
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
                version:
                    VERSION,
                selector:
                    this.selector,
                available:
                    Boolean(
                        this.element?.
                            isConnected
                    ),
                maxActions:
                    this.maxActions,
                mutationDebounce:
                    this.mutationDebounce,
                bindingId:
                    this.bindingId,
                boundElements:
                    this.boundElements.size,
                observerTarget:
                    this.observerTarget?.nodeName ||
                    null,
                commandExecutor:
                    Boolean(
                        this._resolveCommandExecutor()
                    ),
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
            if (
                this.destroyed
            ) {
                return false;
            }

            window.clearTimeout(
                this.refreshTimer
            );

            this.refreshTimer =
                null;

            this._observer?.
                disconnect?.();

            this._observer =
                null;

            for (
                const button of
                Array.from(
                    this.boundElements.keys()
                )
            ) {
                this._unbindActionElement(
                    button
                );
            }

            this.boundElements.clear();
            this.abortController.abort();

            this._emit(
                "destroy",
                {
                    version:
                        VERSION
                }
            );

            this.watchers.clear();
            this.shortcuts.clear();
            this.actions.clear();
            this.groups.clear();

            if (
                this.context.root?.[
                    TOOLBAR_SYMBOL
                ] ===
                    this
            ) {
                delete this.context.root[
                    TOOLBAR_SYMBOL
                ];
            }

            this.destroyed =
                true;

            return true;
        }

    }

    function initialize(
        context =
            {}
    ) {
        const root =
            context.root ||
            document;

        const existing =
            context.toolbar instanceof
                ToolbarController
                ? context.toolbar
                : context.services?.get?.(
                    "toolbar"
                ) ||
                root?.[
                    TOOLBAR_SYMBOL
                ];

        if (
            existing instanceof
                ToolbarController &&
            !existing.destroyed
        ) {
            context.toolbar =
                existing;

            context.registerService?.(
                "toolbar",
                existing
            );

            existing.refresh();

            return existing;
        }

        const dataset =
            context.root?.
                dataset ||
            {};

        const config =
            context.config?.
                toolbar ||
            {};

        const controller =
            new ToolbarController(
                context,
                {
                    root,

                    selector:
                        dataset.terminalToolbarSelector ||
                        config.selector ||
                        DEFAULT_SELECTOR,

                    observe:
                        parseBoolean(
                            dataset.terminalToolbarObserve,
                            config.observe !==
                                false
                        ),

                    maxActions:
                        dataset.terminalToolbarMaxActions ||
                        config.maxActions ||
                        DEFAULT_MAX_ACTIONS,

                    mutationDebounce:
                        dataset.terminalToolbarMutationDebounce ||
                        config.mutationDebounce ||
                        DEFAULT_MUTATION_DEBOUNCE
                }
            );

        root[
            TOOLBAR_SYMBOL
        ] =
            controller;

        context.toolbar =
            controller;

        context.registerService?.(
            "toolbar",
            controller
        );

        safeDispatch(
            document,
            "speciedex:terminal-toolbar-ready",
            {
                controller,
                status:
                    controller.status(),
                version:
                    VERSION
            }
        );

        return controller;
    }

    const commands = [{
        name: "toolbar",
        category: "interface",
        description: "Inspect and control terminal toolbar actions.",
        usage: "toolbar [status|list|invoke|enable|disable|hide|unhide|refresh|help|copy|clear|restart|fullscreen] [action]",
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
                        return write(
                            "Toolbar refreshed.",
                            "success"
                        );

                    case "help":
                    case "copy":
                    case "clear":
                    case "restart":
                    case "fullscreen":
                        return writeJSON(
                            await toolbar.invoke(
                                action,
                                {
                                    source:
                                        "command"
                                }
                            )
                        );

                    default:
                        throw new Error(
                            `Unknown toolbar action "${action}". Use status, list, ` +
                            "invoke, enable, disable, hide, unhide, refresh, help, copy, clear, restart, or fullscreen."
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
        name:
            MODULE_NAME,
        version:
            VERSION,
        TOOLBAR_SYMBOL,
        BUILTIN_ALIASES,
        ToolbarController,
        normalizeName,
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
