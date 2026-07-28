/*
========================================================================
Speciedex.org
Terminal Keyboard Shortcuts
========================================================================

Keyboard management service for SpeciedexTerminal.

Provides:

    • normalized keyboard shortcut registration
    • terminal-scoped and global shortcuts
    • input-aware event handling
    • command history navigation
    • command completion
    • terminal focus controls
    • output clearing
    • terminal, splash, and console visibility controls
    • fullscreen toggling
    • shortcut inspection and configuration
    • clean lifecycle teardown

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME =
        "Keyboard";

    const VERSION =
        "2.2.0";

    const KEYBOARD_SYMBOL =
        Symbol.for(
            "speciedex.terminal.keyboard.manager"
        );

    const MODIFIER_ORDER =
        Object.freeze([
            "ctrl",
            "alt",
            "shift",
            "meta"
        ]);

    const KEY_ALIASES =
        Object.freeze({
            " ":
                "space",

            spacebar:
                "space",

            esc:
                "escape",

            del:
                "delete",

            return:
                "enter",

            arrowup:
                "up",

            arrowdown:
                "down",

            arrowleft:
                "left",

            arrowright:
                "right",

            plus:
                "+",

            minus:
                "-"
        });

    const activeDispatches =
        new WeakMap();

    const DEFAULT_OPTIONS =
        Object.freeze({
            global:
                true,

            enabled:
                true,

            preventDefault:
                true,

            stopPropagation:
                false,

            inputAware:
                true,

            ignoreRepeat:
                true,

            persistBindings:
                true,

            storageKey:
                "speciedex:terminal:keyboard",

            allowBrowserShortcuts:
                false
        });

    const DEFAULT_SHORTCUTS =
        Object.freeze([
            {
                combo:
                    "ctrl+shift+k",

                action:
                    "clear",

                description:
                    "Clear terminal output."
            },

            {
                combo:
                    "ctrl+shift+f",

                action:
                    "focus",

                description:
                    "Focus the terminal command input."
            },

            {
                combo:
                    "ctrl+shift+r",

                action:
                    "restart",

                description:
                    "Restart the active terminal session."
            },

            {
                combo:
                    "ctrl+shift+s",

                action:
                    "toggle-splash",

                description:
                    "Show or hide the terminal splash."
            },

            {
                combo:
                    "ctrl+shift+c",

                action:
                    "toggle-console",

                description:
                    "Show or hide the interactive console."
            },

            {
                combo:
                    "ctrl+shift+t",

                action:
                    "toggle-terminal",

                description:
                    "Show or hide all terminal regions."
            },

            {
                combo:
                    "ctrl+shift+enter",

                action:
                    "fullscreen",

                description:
                    "Toggle terminal fullscreen mode."
            },

            {
                combo:
                    "ctrl+l",

                action:
                    "clear",

                description:
                    "Clear terminal output while the terminal is active."
            },

            {
                combo:
                    "escape",

                action:
                    "escape",

                description:
                    "Dismiss completion or clear the command input."
            },

            {
                combo:
                    "tab",

                action:
                    "complete",

                description:
                    "Complete the active command."
            },

            {
                combo:
                    "up",

                action:
                    "history-previous",

                description:
                    "Select the previous command from history."
            },

            {
                combo:
                    "down",

                action:
                    "history-next",

                description:
                    "Select the next command from history."
            }
        ]);

    /*
    ==========================================================================
    Utilities
    ==========================================================================
    */

    function isObject(value) {
        return (
            value !== null &&
            typeof value === "object" &&
            !Array.isArray(value)
        );
    }

    function dispatch(target, name, detail, options = {}) {
        if (
            !target ||
            typeof target.dispatchEvent !== "function" ||
            !name
        ) {
            return false;
        }

        let names =
            activeDispatches.get(target);

        if (!names) {
            names = new Set();
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
                            options.bubbles === true,
                        cancelable:
                            options.cancelable === true,
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

    function normalizeKey(
        key
    ) {
        const value =
            String(
                key ?? ""
            )
                .trim()
                .toLowerCase();

        return (
            KEY_ALIASES[
                value
            ] ||
            value
        );
    }

    function normalizeCombo(
        combo
    ) {
        const raw =
            String(combo ?? "")
                .trim()
                .toLowerCase();

        if (!raw) {
            throw new Error(
                "Keyboard shortcut is required."
            );
        }

        const parts =
            raw
                .split("+")
                .map(part =>
                    normalizeKey(part)
                )
                .filter(Boolean);

        const modifiers =
            MODIFIER_ORDER.filter(
                modifier =>
                    parts.includes(modifier)
            );

        const keys =
            [
                ...new Set(
                    parts.filter(
                        part =>
                            !MODIFIER_ORDER.includes(
                                part
                            )
                    )
                )
            ];

        if (keys.length !== 1) {
            throw new Error(
                `Keyboard shortcut requires exactly one non-modifier key: ${combo}`
            );
        }

        return [
            ...modifiers,
            keys[0]
        ].join("+");
    }

    function eventCombo(
        event
    ) {
        const parts = [];

        if (event.ctrlKey) {
            parts.push("ctrl");
        }

        if (event.altKey) {
            parts.push("alt");
        }

        if (event.shiftKey) {
            parts.push("shift");
        }

        if (event.metaKey) {
            parts.push("meta");
        }

        const key =
            normalizeKey(
                event.key
            );

        if (
            key &&
            !MODIFIER_ORDER.includes(key)
        ) {
            parts.push(key);
        }

        if (
            !parts.some(
                part =>
                    !MODIFIER_ORDER.includes(
                        part
                    )
            )
        ) {
            return "";
        }

        return normalizeCombo(
            parts.join("+")
        );
    }

    function isElement(
        value
    ) {
        return Boolean(
            value &&
            value.nodeType ===
                1 &&
            typeof value.matches ===
                "function"
        );
    }

    function isEditableTarget(
        target
    ) {
        if (
            !isElement(
                target
            )
        ) {
            return false;
        }

        if (
            target.matches(
                "input, textarea, select, [contenteditable]:not([contenteditable='false'])"
            )
        ) {
            return true;
        }

        return Boolean(
            target.closest(
                "input, textarea, select, [contenteditable]:not([contenteditable='false'])"
            )
        );
    }

    function parseBoolean(
        value,
        fallback = false
    ) {
        if (typeof value === "boolean") {
            return value;
        }

        if (
            value === undefined ||
            value === null ||
            value === ""
        ) {
            return fallback;
        }

        const normalized =
            String(value)
                .trim()
                .toLowerCase();

        if (
            ["1", "true", "yes", "on", "enabled"].includes(
                normalized
            )
        ) {
            return true;
        }

        if (
            ["0", "false", "no", "off", "disabled"].includes(
                normalized
            )
        ) {
            return false;
        }

        return fallback;
    }

    function safeStorage() {
        try {
            const storage =
                window.localStorage;

            const key =
                "__speciedex_keyboard_test__";

            storage.setItem(
                key,
                "1"
            );

            storage.removeItem(
                key
            );

            return storage;
        } catch (error) {
            return null;
        }
    }

    /*
    ==========================================================================
    Keyboard Manager
    ==========================================================================
    */

    class KeyboardManager
        extends EventTarget {
        constructor(
            context,
            options = {}
        ) {
            super();

            this.context =
                isObject(context)
                    ? context
                    : {};

            this.options = {
                global:
                    parseBoolean(
                        options.global,
                        DEFAULT_OPTIONS.global
                    ),

                enabled:
                    parseBoolean(
                        options.enabled,
                        DEFAULT_OPTIONS.enabled
                    ),

                preventDefault:
                    parseBoolean(
                        options.preventDefault,
                        DEFAULT_OPTIONS.preventDefault
                    ),

                stopPropagation:
                    parseBoolean(
                        options.stopPropagation,
                        DEFAULT_OPTIONS.stopPropagation
                    ),

                inputAware:
                    parseBoolean(
                        options.inputAware,
                        DEFAULT_OPTIONS.inputAware
                    ),

                ignoreRepeat:
                    parseBoolean(
                        options.ignoreRepeat,
                        DEFAULT_OPTIONS.ignoreRepeat
                    ),

                persistBindings:
                    parseBoolean(
                        options.persistBindings,
                        DEFAULT_OPTIONS.persistBindings
                    ),

                storageKey:
                    String(
                        options.storageKey ||
                        DEFAULT_OPTIONS.storageKey
                    ),

                allowBrowserShortcuts:
                    parseBoolean(
                        options.allowBrowserShortcuts,
                        DEFAULT_OPTIONS.allowBrowserShortcuts
                    )
            };

            this.shortcuts =
                new Map();

            this.actions =
                new Map();

            this.ready =
                true;

            this.destroyed =
                false;

            this.abortController =
                typeof AbortController ===
                    "function"
                    ? new AbortController()
                    : null;

            this.eventTarget =
                null;

            this.boundWithSignal =
                false;

            this.watchers =
                new Set();

            this.storage =
                safeStorage();

            this.executing =
                new Set();

            this.metrics = {
                keydowns:
                    0,
                matched:
                    0,
                executed:
                    0,
                errors:
                    0,
                ignoredRepeat:
                    0,
                ignoredInput:
                    0,
                ignoredInactive:
                    0
            };

            this.boundKeydown =
                event =>
                    this.onKeydown(
                        event
                    );

            this.installActions();
            this.installDefaults();
            this.restoreBindings();
            this.bind();
        }

        /*
        ======================================================================
        Action Registry
        ======================================================================
        */

        emit(name, detail = {}) {
            if (
                this.destroyed &&
                name !== "destroy"
            ) {
                return false;
            }

            dispatch(
                this,
                name,
                detail
            );

            for (
                const watcher
                of Array.from(
                    this.watchers
                )
            ) {
                try {
                    watcher(
                        {
                            type: name,
                            detail
                        },
                        this
                    );
                } catch (_error) {
                    /* Watcher failures are isolated. */
                }
            }

            try {
                this.context.events?.emit?.(
                    `keyboard:${name}`,
                    detail
                );
            } catch (_error) {
                /* External event failures are isolated. */
            }

            dispatch(
                this.context.root,
                `speciedex:terminal-keyboard-${name}`,
                detail,
                {
                    bubbles: true
                }
            );

            return true;
        }

        watch(callback, options = {}) {
            if (typeof callback !== "function") {
                throw new TypeError(
                    "Keyboard watcher must be a function."
                );
            }

            this.watchers.add(callback);

            if (options.immediate === true) {
                callback(
                    {
                        type: "initial",
                        status:
                            this.status()
                    },
                    this
                );
            }

            return () =>
                this.watchers.delete(
                    callback
                );
        }

        installActions() {
            this.registerAction(
                "clear",
                () =>
                    this.context.app?.
                        clear?.() ??
                    this.context.console?.
                        clear?.() ??
                    this.context.clear?.()
            );

            this.registerAction(
                "focus",
                () =>
                    this.context.app?.
                        focus?.() ??
                    this.context.elements?.
                        input?.
                        focus?.() ??
                    this.context.focus?.()
            );

            this.registerAction(
                "restart",
                () => {
                    const app =
                        this.context.app;

                    if (
                        typeof app?.restart ===
                        "function"
                    ) {
                        return app.restart();
                    }

                    this.context.clear?.();
                    app?.printWelcome?.();
                    return null;
                }
            );

            this.registerAction(
                "toggle-splash",
                () =>
                    this.context.toggleRegion?.(
                        "splash"
                    )
            );

            this.registerAction(
                "toggle-console",
                () =>
                    this.context.toggleRegion?.(
                        "console"
                    )
            );

            this.registerAction(
                "toggle-terminal",
                () =>
                    this.context.toggleRegion?.(
                        "terminal"
                    )
            );

            this.registerAction(
                "fullscreen",
                event => {
                    const button =
                        this.context.root?.
                            querySelector?.(
                                '[data-terminal-action="fullscreen"], ' +
                                "[data-terminal-fullscreen]"
                            );

                    return this.context.app?.
                        toggleFullscreen?.(
                            button ||
                            event.currentTarget ||
                            null
                        );
                }
            );

            this.registerAction(
                "escape",
                () => {
                    const app =
                        this.context.app;

                    const completion =
                        this.context.elements?.
                            completion;

                    const completionVisible =
                        Boolean(
                            completion &&
                            !completion.hidden
                        );

                    if (
                        completionVisible
                    ) {
                        app?.
                            hideCompletion?.();

                        return "completion";
                    }

                    const input =
                        this.context.elements?.
                            input;

                    if (
                        input &&
                        input.value
                    ) {
                        input.value =
                            "";

                        input.dispatchEvent(
                            new Event(
                                "input",
                                {
                                    bubbles:
                                        true
                                }
                            )
                        );

                        return "input";
                    }

                    return false;
                }
            );

            this.registerAction(
                "complete",
                () =>
                    this.context.app?.
                        completeInput?.() ??
                    this.context.complete?.()
            );

            this.registerAction(
                "history-previous",
                () =>
                    this.context.app?.
                        navigateHistory?.(
                            -1
                        ) ??
                    this.context.historyService?.
                        previous?.(
                            this.context.elements?.
                                input?.
                                value ||
                            ""
                        )
            );

            this.registerAction(
                "history-next",
                () =>
                    this.context.app?.
                        navigateHistory?.(
                            1
                        ) ??
                    this.context.historyService?.
                        next?.()
            );

            this.registerAction(
                "submit",
                () =>
                    this.context.app?.
                        execute?.(
                            this.context.elements?.
                                input?.
                                value ||
                            ""
                        )
            );

            this.registerAction(
                "help",
                () =>
                    this.context.app?.
                        execute?.(
                            "help"
                        )
            );

            this.registerAction(
                "copy",
                () =>
                    this.context.app?.
                        copyOutput?.()
            );
        }

        registerAction(
            name,
            handler
        ) {
            const normalized =
                String(
                    name ?? ""
                )
                    .trim()
                    .toLowerCase();

            if (!normalized) {
                throw new Error(
                    "Keyboard action name is required."
                );
            }

            if (
                typeof handler !==
                "function"
            ) {
                throw new TypeError(
                    `Keyboard action "${normalized}" requires a handler function.`
                );
            }

            this.actions.set(
                normalized,
                handler
            );

            return normalized;
        }

        unregisterAction(
            name
        ) {
            return this.actions.delete(
                String(
                    name ?? ""
                )
                    .trim()
                    .toLowerCase()
            );
        }

        persistBindings() {
            if (
                !this.options.persistBindings ||
                !this.storage
            ) {
                return false;
            }

            const runtime =
                [
                    ...this.shortcuts.values()
                ]
                    .filter(
                        definition =>
                            definition.source !==
                            "default" &&
                            typeof definition.action ===
                                "string"
                    )
                    .map(
                        definition => ({
                            combo:
                                definition.combo,
                            action:
                                definition.action,
                            description:
                                definition.description,
                            source:
                                definition.source,
                            allowInInput:
                                definition.allowInInput,
                            global:
                                definition.global,
                            enabled:
                                definition.enabled,
                            preventDefault:
                                definition.preventDefault,
                            stopPropagation:
                                definition.stopPropagation
                        })
                    );

            try {
                this.storage.setItem(
                    this.options.storageKey,
                    JSON.stringify({
                        version:
                            VERSION,
                        bindings:
                            runtime
                    })
                );

                return true;
            } catch (error) {
                return false;
            }
        }

        restoreBindings() {
            if (
                !this.options.persistBindings ||
                !this.storage
            ) {
                return 0;
            }

            try {
                const payload =
                    JSON.parse(
                        this.storage.getItem(
                            this.options.storageKey
                        ) ||
                        "null"
                    );

                const bindings =
                    Array.isArray(
                        payload?.bindings
                    )
                        ? payload.bindings
                        : [];

                let restored =
                    0;

                for (
                    const definition of
                    bindings
                ) {
                    if (
                        !definition?.combo ||
                        !definition?.action
                    ) {
                        continue;
                    }

                    this.register(
                        definition.combo,
                        definition.action,
                        {
                            ...definition,
                            source:
                                definition.source ||
                                "persisted",
                            persist:
                                false
                        }
                    );

                    restored +=
                        1;
                }

                return restored;
            } catch (error) {
                return 0;
            }
        }

        clearPersistedBindings() {
            if (
                !this.storage
            ) {
                return false;
            }

            try {
                this.storage.removeItem(
                    this.options.storageKey
                );

                return true;
            } catch (error) {
                return false;
            }
        }

        /*
        ======================================================================
        Shortcut Registry
        ======================================================================
        */

        installDefaults() {
            for (
                const definition of
                DEFAULT_SHORTCUTS
            ) {
                this.register(
                    definition.combo,
                    definition.action,
                    {
                        description:
                            definition.description,

                        source:
                            "default",

                        allowInInput:
                            [
                                "escape",
                                "complete",
                                "history-previous",
                                "history-next",
                                "clear"
                            ].includes(
                                definition.action
                            )
                    }
                );
            }
        }

        register(
            combo,
            handlerOrAction,
            options = {}
        ) {
            const normalizedCombo =
                normalizeCombo(
                    combo
                );

            const definition = {
                combo:
                    normalizedCombo,

                action:
                    typeof handlerOrAction ===
                    "string"
                        ? handlerOrAction
                        : null,

                handler:
                    typeof handlerOrAction ===
                    "function"
                        ? handlerOrAction
                        : null,

                description:
                    String(
                        options.description ||
                        ""
                    ),

                source:
                    String(
                        options.source ||
                        "runtime"
                    ),

                allowInInput:
                    parseBoolean(
                        options.allowInInput,
                        false
                    ),

                global:
                    parseBoolean(
                        options.global,
                        true
                    ),

                enabled:
                    parseBoolean(
                        options.enabled,
                        true
                    ),

                preventDefault:
                    options.preventDefault ??
                    this.options.preventDefault,

                stopPropagation:
                    options.stopPropagation ??
                    this.options.stopPropagation,

                persist:
                    parseBoolean(
                        options.persist,
                        true
                    )
            };

            if (
                !definition.handler &&
                !definition.action
            ) {
                throw new TypeError(
                    `Keyboard shortcut "${normalizedCombo}" requires an action or handler.`
                );
            }

            const previous =
                this.shortcuts.get(
                    normalizedCombo
                ) ||
                null;

            this.shortcuts.set(
                normalizedCombo,
                definition
            );

            if (
                definition.persist &&
                definition.source !==
                    "default"
            ) {
                this.persistBindings();
            }

            definition.replaced =
                previous
                    ? {
                        action:
                            previous.action,
                        source:
                            previous.source
                    }
                    : null;

            this.emit(
                "register",
                definition
            );

            return definition;
        }

        unregister(
            combo
        ) {
            const normalized =
                normalizeCombo(
                    combo
                );

            const removed =
                this.shortcuts.delete(
                    normalized
                );

            if (removed) {
                this.persistBindings();
            }

            this.emit(
                "unregister",
                {
                    combo:
                        normalized,
                    removed
                }
            );

            return removed;
        }

        enable(
            combo = null
        ) {
            if (!combo) {
                this.options.enabled =
                    true;

                this.emit(
                    "enable",
                    {
                        combo: null
                    }
                );

                return true;
            }

            const definition =
                this.shortcuts.get(
                    normalizeCombo(
                        combo
                    )
                );

            if (!definition) {
                return false;
            }

            definition.enabled =
                true;

            this.persistBindings();

            this.emit(
                "enable",
                {
                    combo:
                        definition.combo
                }
            );

            return true;
        }

        disable(
            combo = null
        ) {
            if (!combo) {
                this.options.enabled =
                    false;

                this.emit(
                    "disable",
                    {
                        combo: null
                    }
                );

                return true;
            }

            const definition =
                this.shortcuts.get(
                    normalizeCombo(
                        combo
                    )
                );

            if (!definition) {
                return false;
            }

            definition.enabled =
                false;

            this.persistBindings();

            this.emit(
                "disable",
                {
                    combo:
                        definition.combo
                }
            );

            return true;
        }

        /*
        ======================================================================
        Event Handling
        ======================================================================
        */

        bind() {
            const target =
                this.options.global
                    ? document
                    : this.context.root;

            if (
                !target ||
                typeof target.addEventListener !==
                    "function"
            ) {
                throw new Error(
                    "Keyboard event target is unavailable."
                );
            }

            const listenerOptions = {
                capture: true
            };

            if (
                this.abortController?.signal
            ) {
                listenerOptions.signal =
                    this.abortController.signal;
            }

            try {
                target.addEventListener(
                    "keydown",
                    this.boundKeydown,
                    listenerOptions
                );

                this.boundWithSignal =
                    Boolean(
                        listenerOptions.signal
                    );
            } catch (_error) {
                target.addEventListener(
                    "keydown",
                    this.boundKeydown,
                    true
                );

                this.boundWithSignal =
                    false;
            }

            this.eventTarget =
                target;
        }

        isTerminalActive(
            event
        ) {
            const root =
                this.context.root;

            if (
                !root ||
                typeof root.contains !==
                    "function"
            ) {
                return false;
            }

            if (
                root.contains(
                    event.target
                )
            ) {
                return true;
            }

            if (
                root.contains(
                    document.activeElement
                )
            ) {
                return true;
            }

            if (
                document.fullscreenElement &&
                root.contains(
                    document.fullscreenElement
                )
            ) {
                return true;
            }

            return false;
        }

        async executeDefinition(
            definition,
            event
        ) {
            let handler =
                definition.handler;

            if (
                !handler &&
                definition.action
            ) {
                handler =
                    this.actions.get(
                        definition.action
                    );
            }

            if (
                typeof handler !==
                    "function"
            ) {
                throw new Error(
                    `Keyboard action is unavailable for "${definition.combo}".`
                );
            }

            if (
                this.executing.has(
                    definition.combo
                )
            ) {
                return null;
            }

            this.executing.add(
                definition.combo
            );

            try {
                const result =
                    await handler(
                        event,
                        this.context,
                        definition
                    );

                this.metrics.executed +=
                    1;

                this.emit(
                    "execute",
                    {
                        combo:
                            definition.combo,
                        definition,
                        result
                    }
                );

                return result;
            } finally {
                this.executing.delete(
                    definition.combo
                );
            }
        }

        onKeydown(
            event
        ) {
            this.metrics.keydowns +=
                1;

            if (
                !this.options.enabled ||
                this.destroyed ||
                event.defaultPrevented
            ) {
                return;
            }

            if (
                this.options.ignoreRepeat &&
                event.repeat
            ) {
                this.metrics.ignoredRepeat +=
                    1;

                return;
            }

            if (
                event.isComposing ||
                event.keyCode ===
                    229
            ) {
                return;
            }

            let combo;

            try {
                combo =
                    eventCombo(
                        event
                    );
            } catch (error) {
                return;
            }

            if (!combo) {
                return;
            }

            const definition =
                this.shortcuts.get(
                    combo
                );

            if (
                !definition ||
                !definition.enabled
            ) {
                return;
            }

            this.metrics.matched +=
                1;

            if (
                !definition.global &&
                !this.isTerminalActive(
                    event
                )
            ) {
                this.metrics.ignoredInactive +=
                    1;

                return;
            }

            if (
                this.options.global &&
                !this.isTerminalActive(
                    event
                ) &&
                definition.source ===
                    "default"
            ) {
                this.metrics.ignoredInactive +=
                    1;

                return;
            }

            const editable =
                isEditableTarget(
                    event.target
                );

            if (
                this.options.inputAware &&
                editable &&
                !definition.allowInInput
            ) {
                this.metrics.ignoredInput +=
                    1;

                return;
            }

            if (
                !this.options.allowBrowserShortcuts &&
                (
                    combo ===
                        "ctrl+l" ||
                    combo ===
                        "ctrl+r" ||
                    combo ===
                        "ctrl+t" ||
                    combo ===
                        "ctrl+w"
                ) &&
                !this.isTerminalActive(
                    event
                )
            ) {
                return;
            }

            if (
                definition.preventDefault &&
                event.cancelable !== false
            ) {
                event.preventDefault();
            }

            if (
                definition.stopPropagation
            ) {
                event.stopPropagation?.();
            }

            Promise.resolve(
                this.executeDefinition(
                    definition,
                    event
                )
            ).catch(
                error => {
                    this.metrics.errors +=
                        1;

                    console.error(
                        "[SpeciedexTerminalKeyboard] Shortcut failed:",
                        error
                    );

                    const message =
                        error instanceof Error
                            ? error.message
                            : String(error);

                    (
                        this.context.write ||
                        this.context.writeLine ||
                        this.context.console?.write
                    )?.(
                        message,
                        "error"
                    );

                    this.emit(
                        "error",
                        {
                            combo,
                            error
                        }
                    );
                }
            );
        }

        /*
        ======================================================================
        Inspection
        ======================================================================
        */

        list() {
            return [
                ...this.shortcuts.values()
            ]
                .map(
                    definition => ({
                        combo:
                            definition.combo,

                        action:
                            definition.action,

                        description:
                            definition.description,

                        source:
                            definition.source,

                        allowInInput:
                            definition.allowInInput,

                        global:
                            definition.global,

                        enabled:
                            definition.enabled,

                        preventDefault:
                            definition.preventDefault,

                        stopPropagation:
                            definition.stopPropagation,

                        persist:
                            definition.persist,

                        replaced:
                            definition.replaced
                    })
                )
                .sort(
                    (
                        left,
                        right
                    ) =>
                        left.combo.localeCompare(
                            right.combo
                        )
                );
        }

        status() {
            return {
                version:
                    VERSION,

                ready:
                    this.ready,

                enabled:
                    this.options.enabled,

                global:
                    this.options.global,

                inputAware:
                    this.options.inputAware,

                shortcuts:
                    this.shortcuts.size,

                actions:
                    [
                        ...this.actions.keys()
                    ].sort(),

                executing:
                    [
                        ...this.executing
                    ],

                persisted:
                    this.options.persistBindings,

                storageAvailable:
                    Boolean(
                        this.storage
                    ),

                eventTarget:
                    this.eventTarget ===
                        document
                        ? "document"
                        : this.eventTarget
                            ? "terminal"
                            : null,

                metrics: {
                    ...this.metrics
                },

                destroyed:
                    this.destroyed
            };
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            try {
                this.abortController?.abort?.();
            } catch (_error) {
                /* Continue teardown. */
            }

            if (
                this.eventTarget &&
                !this.boundWithSignal
            ) {
                try {
                    this.eventTarget.removeEventListener(
                        "keydown",
                        this.boundKeydown,
                        true
                    );
                } catch (_error) {
                    /* Continue teardown. */
                }
            }

            this.shortcuts.clear();
            this.actions.clear();
            this.executing.clear();

            this.emit(
                "destroy",
                {
                    version:
                        VERSION
                }
            );

            this.watchers.clear();

            if (
                this.context.root?.[
                    KEYBOARD_SYMBOL
                ] ===
                    this
            ) {
                delete this.context.root[
                    KEYBOARD_SYMBOL
                ];
            }

            this.eventTarget =
                null;

            this.ready =
                false;

            this.destroyed =
                true;

            return true;
        }

    }

    /*
    ==========================================================================
    Initialization
    ==========================================================================
    */

    function initialize(
        context = {}
    ) {
        const safeContext =
            isObject(context)
                ? context
                : {};

        const root =
            isElement(safeContext.root)
                ? safeContext.root
                : document.documentElement;

        const existing =
            safeContext.keyboard instanceof
                KeyboardManager
                ? safeContext.keyboard
                : safeContext.services?.get?.(
                    "keyboard"
                ) ||
                root?.[KEYBOARD_SYMBOL];

        if (
            existing instanceof KeyboardManager &&
            !existing.destroyed
        ) {
            safeContext.keyboard =
                existing;

            safeContext.registerService?.(
                "keyboard",
                existing
            );

            return existing;
        }

        const dataset =
            root.dataset || {};

        const config =
            safeContext.config?.keyboard ||
            {};

        const manager =
            new KeyboardManager(
                {
                    ...safeContext,
                    root
                },
                {
                    global:
                        parseBoolean(
                            dataset.terminalKeyboardGlobal ??
                            config.global,
                            DEFAULT_OPTIONS.global
                        ),
                    enabled:
                        parseBoolean(
                            dataset.terminalKeyboard ??
                            config.enabled,
                            DEFAULT_OPTIONS.enabled
                        ),
                    inputAware:
                        parseBoolean(
                            dataset.terminalKeyboardInputAware ??
                            config.inputAware,
                            DEFAULT_OPTIONS.inputAware
                        ),
                    preventDefault:
                        parseBoolean(
                            dataset.terminalKeyboardPreventDefault ??
                            config.preventDefault,
                            DEFAULT_OPTIONS.preventDefault
                        ),
                    stopPropagation:
                        parseBoolean(
                            dataset.terminalKeyboardStopPropagation ??
                            config.stopPropagation,
                            DEFAULT_OPTIONS.stopPropagation
                        ),
                    ignoreRepeat:
                        parseBoolean(
                            dataset.terminalKeyboardIgnoreRepeat ??
                            config.ignoreRepeat,
                            DEFAULT_OPTIONS.ignoreRepeat
                        ),
                    persistBindings:
                        parseBoolean(
                            dataset.terminalKeyboardPersist ??
                            config.persistBindings,
                            DEFAULT_OPTIONS.persistBindings
                        ),
                    allowBrowserShortcuts:
                        parseBoolean(
                            dataset.terminalKeyboardAllowBrowserShortcuts ??
                            config.allowBrowserShortcuts,
                            DEFAULT_OPTIONS.allowBrowserShortcuts
                        ),
                    storageKey:
                        dataset.terminalKeyboardStorageKey ||
                        config.storageKey ||
                        DEFAULT_OPTIONS.storageKey
                }
            );

        root[KEYBOARD_SYMBOL] =
            manager;

        safeContext.keyboard =
            manager;

        safeContext.registerService?.(
            "keyboard",
            manager
        );

        dispatch(
            document,
            "speciedex:terminal-keyboard-ready",
            {
                context:
                    safeContext,
                keyboard:
                    manager,
                version:
                    VERSION
            }
        );

        return manager;
    }

    /*
    ==========================================================================
    Commands
    ==========================================================================
    */

    function resolveCommandContext(payload = {}) {
        return (
            payload.context ||
            payload.terminal?.context ||
            payload.app?.context ||
            payload
        );
    }

    function requireKeyboard(context) {
        const safeContext =
            isObject(context)
                ? context
                : {};

        const keyboard =
            safeContext.keyboard instanceof
                KeyboardManager
                ? safeContext.keyboard
                : safeContext.services?.get?.(
                    "keyboard"
                ) ||
                initialize(safeContext);

        if (
            !(keyboard instanceof KeyboardManager) ||
            keyboard.destroyed
        ) {
            throw new Error(
                "Terminal keyboard service is unavailable."
            );
        }

        return keyboard;
    }

    function writeResult(payload, value, type = "data") {
        if (
            typeof payload.writeJSON ===
                "function" &&
            typeof value !== "string"
        ) {
            return payload.writeJSON(value);
        }

        if (
            typeof payload.writeTable ===
                "function" &&
            value?.headers &&
            value?.rows
        ) {
            return payload.writeTable(
                value.headers,
                value.rows
            );
        }

        if (typeof payload.write === "function") {
            return payload.write(
                typeof value === "string"
                    ? value
                    : JSON.stringify(
                        value,
                        null,
                        2
                    ),
                type
            );
        }

        if (typeof payload.writeLine === "function") {
            return payload.writeLine(
                typeof value === "string"
                    ? value
                    : JSON.stringify(
                        value,
                        null,
                        2
                    )
            );
        }

        return value;
    }

    const commands =
        [
            {
                name: "keyboard",
                category: "system",
                description:
                    "Display keyboard service status.",
                usage: "keyboard",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    return writeResult(
                        payload,
                        requireKeyboard(
                            context
                        ).status()
                    );
                }
            },

            {
                name: "keyboard-shortcuts",
                category: "system",
                description:
                    "List registered terminal keyboard shortcuts.",
                usage:
                    "keyboard-shortcuts",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    const shortcuts =
                        requireKeyboard(
                            context
                        ).list();

                    return writeResult(
                        payload,
                        {
                            headers: [
                                "Shortcut",
                                "Action",
                                "Description",
                                "Enabled",
                                "Scope"
                            ],
                            rows:
                                shortcuts.map(
                                    shortcut => [
                                        shortcut.combo,
                                        shortcut.action ||
                                        "custom",
                                        shortcut.description,
                                        shortcut.enabled
                                            ? "yes"
                                            : "no",
                                        shortcut.global
                                            ? "global"
                                            : "terminal"
                                    ]
                                )
                        }
                    );
                }
            },

            {
                name: "keyboard-enable",
                category: "system",
                description:
                    "Enable all shortcuts or one specific shortcut.",
                usage:
                    "keyboard-enable [shortcut]",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    const args =
                        Array.isArray(payload.args)
                            ? payload.args
                            : [];

                    const combo =
                        args.join("+") ||
                        null;

                    const enabled =
                        requireKeyboard(
                            context
                        ).enable(
                            combo
                        );

                    if (!enabled) {
                        throw new Error(
                            `Unknown keyboard shortcut: ${combo}`
                        );
                    }

                    return writeResult(
                        payload,
                        combo
                            ? `Keyboard shortcut enabled: ${normalizeCombo(combo)}`
                            : "Keyboard shortcuts enabled.",
                        "success"
                    );
                }
            },

            {
                name: "keyboard-disable",
                category: "system",
                description:
                    "Disable all shortcuts or one specific shortcut.",
                usage:
                    "keyboard-disable [shortcut]",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    const args =
                        Array.isArray(payload.args)
                            ? payload.args
                            : [];

                    const combo =
                        args.join("+") ||
                        null;

                    const disabled =
                        requireKeyboard(
                            context
                        ).disable(
                            combo
                        );

                    if (!disabled) {
                        throw new Error(
                            `Unknown keyboard shortcut: ${combo}`
                        );
                    }

                    return writeResult(
                        payload,
                        combo
                            ? `Keyboard shortcut disabled: ${normalizeCombo(combo)}`
                            : "Keyboard shortcuts disabled.",
                        "success"
                    );
                }
            },

            {
                name: "keyboard-bind",
                category: "system",
                description:
                    "Bind a keyboard shortcut to an existing terminal command.",
                usage:
                    "keyboard-bind <shortcut> <command>",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    const args =
                        Array.isArray(payload.args)
                            ? [...payload.args]
                            : [];

                    if (args.length < 2) {
                        throw new Error(
                            "Usage: keyboard-bind <shortcut> <command>"
                        );
                    }

                    const combo =
                        args.shift();

                    const command =
                        args.join(" ").trim();

                    const keyboard =
                        requireKeyboard(context);

                    const definition =
                        keyboard.register(
                            combo,
                            () =>
                                context.app?.
                                    execute?.(
                                        command
                                    ) ??
                                context.execute?.(
                                    command
                                ),
                            {
                                description:
                                    `Run terminal command: ${command}`,
                                source:
                                    "command",
                                global:
                                    false,
                                allowInInput:
                                    false,
                                persist:
                                    true
                            }
                        );

                    return writeResult(
                        payload,
                        `Keyboard shortcut ${definition.combo} bound to: ${command}`,
                        "success"
                    );
                }
            },

            {
                name: "keyboard-test",
                category: "system",
                description:
                    "Normalize and inspect a keyboard shortcut.",
                usage:
                    "keyboard-test <shortcut>",
                handler: payload => {
                    const args =
                        Array.isArray(payload.args)
                            ? payload.args
                            : [];

                    const combo =
                        args.join("+");

                    if (!combo) {
                        throw new Error(
                            "A keyboard shortcut is required."
                        );
                    }

                    return writeResult(
                        payload,
                        {
                            input:
                                combo,
                            normalized:
                                normalizeCombo(
                                    combo
                                )
                        }
                    );
                }
            },

            {
                name: "keyboard-reset",
                category: "system",
                description:
                    "Remove runtime bindings and restore defaults.",
                usage:
                    "keyboard-reset",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    const keyboard =
                        requireKeyboard(context);

                    keyboard.shortcuts.clear();
                    keyboard.installDefaults();
                    keyboard.clearPersistedBindings();

                    return writeResult(
                        payload,
                        "Keyboard shortcuts reset to defaults.",
                        "success"
                    );
                }
            },

            {
                name: "keyboard-unbind",
                category: "system",
                description:
                    "Remove a registered keyboard shortcut.",
                usage:
                    "keyboard-unbind <shortcut>",
                handler: payload => {
                    const context =
                        resolveCommandContext(payload);

                    const args =
                        Array.isArray(payload.args)
                            ? payload.args
                            : [];

                    const combo =
                        args.join("+");

                    if (!combo) {
                        throw new Error(
                            "A keyboard shortcut is required."
                        );
                    }

                    const normalized =
                        normalizeCombo(combo);

                    if (
                        !requireKeyboard(
                            context
                        ).unregister(
                            normalized
                        )
                    ) {
                        throw new Error(
                            `Unknown keyboard shortcut: ${normalized}`
                        );
                    }

                    return writeResult(
                        payload,
                        `Keyboard shortcut removed: ${normalized}`,
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

            version:
                VERSION,

            KeyboardManager,
            KEYBOARD_SYMBOL,
            DEFAULT_OPTIONS,
            DEFAULT_SHORTCUTS,
            normalizeKey,
            normalizeCombo,
            eventCombo,
            isElement,
            isEditableTarget,
            parseBoolean,
            safeStorage,
            dispatch,
            resolveCommandContext,

            initialize,
            mount:
                initialize,
            init:
                initialize,
            setup:
                initialize,

            commands
        });

    window.SpeciedexTerminalKeyboard =
        api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules ||
        {};

    window.SpeciedexTerminalModules[
        MODULE_NAME
    ] = api;

    dispatch(
        document,
        "speciedex:terminal-module-available",
        {
            name:
                MODULE_NAME,
            module:
                api
        }
    );
})(window, document);
