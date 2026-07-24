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
        "2.1.0";

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
        const parts =
            String(
                combo ?? ""
            )
                .trim()
                .toLowerCase()
                .split("+")
                .map(
                    part =>
                        normalizeKey(
                            part
                        )
                )
                .filter(Boolean);

        const modifiers =
            MODIFIER_ORDER.filter(
                modifier =>
                    parts.includes(
                        modifier
                    )
            );

        const keys =
            parts.filter(
                part =>
                    !MODIFIER_ORDER.includes(
                        part
                    )
            );

        if (!keys.length) {
            throw new Error(
                `Keyboard shortcut requires a non-modifier key: ${combo}`
            );
        }

        return [
            ...modifiers,
            ...keys
        ].join("+");
    }

    function eventCombo(
        event
    ) {
        const parts =
            [];

        if (event.ctrlKey) {
            parts.push(
                "ctrl"
            );
        }

        if (event.altKey) {
            parts.push(
                "alt"
            );
        }

        if (event.shiftKey) {
            parts.push(
                "shift"
            );
        }

        if (event.metaKey) {
            parts.push(
                "meta"
            );
        }

        const key =
            normalizeKey(
                event.key
            );

        if (
            key &&
            !MODIFIER_ORDER.includes(
                key
            )
        ) {
            parts.push(
                key
            );
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
                "input, textarea, select, [contenteditable='true']"
            )
        ) {
            return true;
        }

        return Boolean(
            target.closest(
                "input, textarea, select, [contenteditable='true']"
            )
        );
    }

    function parseBoolean(
        value,
        fallback = false
    ) {
        if (
            value === undefined ||
            value === null ||
            value === ""
        ) {
            return fallback;
        }

        return ![
            "false",
            "0",
            "no",
            "off"
        ].includes(
            String(
                value
            )
                .trim()
                .toLowerCase()
        );
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
                context;

            this.options = {
                global:
                    options.global !==
                    false,

                enabled:
                    options.enabled !==
                    false,

                preventDefault:
                    options.preventDefault !==
                    false,

                stopPropagation:
                    options.stopPropagation ===
                    true,

                inputAware:
                    options.inputAware !==
                    false,

                ignoreRepeat:
                    options.ignoreRepeat !==
                    false,

                persistBindings:
                    options.persistBindings !==
                    false,

                storageKey:
                    String(
                        options.storageKey ||
                        DEFAULT_OPTIONS.storageKey
                    ),

                allowBrowserShortcuts:
                    options.allowBrowserShortcuts ===
                    true
            };

            this.shortcuts =
                new Map();

            this.actions =
                new Map();

            this.destroyed =
                false;

            this.abortController =
                new AbortController();

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

        installActions() {
            this.registerAction(
                "clear",
                () =>
                    this.context.app?.
                        clear?.() ??
                    this.context.clear?.()
            );

            this.registerAction(
                "focus",
                () =>
                    this.context.app?.
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
                        completeInput?.()
            );

            this.registerAction(
                "history-previous",
                () =>
                    this.context.app?.
                        navigateHistory?.(
                            -1
                        )
            );

            this.registerAction(
                "history-next",
                () =>
                    this.context.app?.
                        navigateHistory?.(
                            1
                        )
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
                    options.allowInInput ===
                    true,

                global:
                    options.global !==
                    false,

                enabled:
                    options.enabled !==
                    false,

                preventDefault:
                    options.preventDefault ??
                    this.options.preventDefault,

                stopPropagation:
                    options.stopPropagation ??
                    this.options.stopPropagation,

                persist:
                    options.persist !==
                    false
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

            this.dispatchEvent(
                new CustomEvent(
                    "register",
                    {
                        detail:
                            definition
                    }
                )
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

            this.dispatchEvent(
                new CustomEvent(
                    "unregister",
                    {
                        detail: {
                            combo:
                                normalized,

                            removed
                        }
                    }
                )
            );

            return removed;
        }

        enable(
            combo = null
        ) {
            if (!combo) {
                this.options.enabled =
                    true;

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

            return true;
        }

        disable(
            combo = null
        ) {
            if (!combo) {
                this.options.enabled =
                    false;

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

            target.addEventListener(
                "keydown",
                this.boundKeydown,
                {
                    signal:
                        this.abortController.signal,
                    capture:
                        true
                }
            );

            this.eventTarget =
                target;
        }

        isTerminalActive(
            event
        ) {
            const root =
                this.context.root;

            if (!root) {
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

                this.dispatchEvent(
                    new CustomEvent(
                        "execute",
                        {
                            detail: {
                                combo:
                                    definition.combo,

                                definition,

                                result
                            }
                        }
                    )
                );

                this.context.events?.emit?.(
                    "keyboard:execute",
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
                definition.preventDefault
            ) {
                event.preventDefault();
            }

            if (
                definition.stopPropagation
            ) {
                event.stopPropagation();
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

                    this.context.write?.(
                        error instanceof Error
                            ? error.message
                            : String(error),
                        "error"
                    );

                    this.dispatchEvent(
                        new CustomEvent(
                            "error",
                            {
                                detail: {
                                    combo,
                                    error
                                }
                            }
                        )
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

                metrics: {
                    ...this.metrics
                },

                destroyed:
                    this.destroyed
            };
        }

        destroy() {
            if (
                this.destroyed
            ) {
                return false;
            }

            this.abortController.abort();
            this.shortcuts.clear();
            this.actions.clear();
            this.executing.clear();

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

            this.destroyed =
                true;

            this.dispatchEvent(
                new CustomEvent(
                    "destroy",
                    {
                        detail: {
                            version:
                                VERSION
                        }
                    }
                )
            );

            return true;
        }

    }

    /*
    ==========================================================================
    Initialization
    ==========================================================================
    */

    function initialize(
        context
    ) {
        const root =
            context.root;

        const existing =
            context.keyboard instanceof
                KeyboardManager
                ? context.keyboard
                : root?.[
                    KEYBOARD_SYMBOL
                ];

        if (
            existing instanceof
                KeyboardManager &&
            !existing.destroyed
        ) {
            context.keyboard =
                existing;

            context.registerService?.(
                "keyboard",
                existing
            );

            return existing;
        }

        const manager =
            new KeyboardManager(
                context,
                {
                    global:
                        parseBoolean(
                            root?.
                                dataset.
                                terminalKeyboardGlobal,
                            DEFAULT_OPTIONS.global
                        ),

                    enabled:
                        parseBoolean(
                            root?.
                                dataset.
                                terminalKeyboard,
                            DEFAULT_OPTIONS.enabled
                        ),

                    inputAware:
                        parseBoolean(
                            root?.
                                dataset.
                                terminalKeyboardInputAware,
                            DEFAULT_OPTIONS.inputAware
                        ),

                    preventDefault:
                        parseBoolean(
                            root?.
                                dataset.
                                terminalKeyboardPreventDefault,
                            DEFAULT_OPTIONS.preventDefault
                        ),

                    stopPropagation:
                        parseBoolean(
                            root?.
                                dataset.
                                terminalKeyboardStopPropagation,
                            DEFAULT_OPTIONS.stopPropagation
                        ),

                    ignoreRepeat:
                        parseBoolean(
                            root?.
                                dataset.
                                terminalKeyboardIgnoreRepeat,
                            DEFAULT_OPTIONS.ignoreRepeat
                        ),

                    persistBindings:
                        parseBoolean(
                            root?.
                                dataset.
                                terminalKeyboardPersist,
                            DEFAULT_OPTIONS.persistBindings
                        ),

                    storageKey:
                        root?.
                            dataset.
                            terminalKeyboardStorageKey ||
                        DEFAULT_OPTIONS.storageKey
                }
            );

        root[
            KEYBOARD_SYMBOL
        ] =
            manager;

        context.keyboard =
            manager;

        context.registerService?.(
            "keyboard",
            manager
        );

        return manager;
    }

    /*
    ==========================================================================
    Commands
    ==========================================================================
    */

    const commands =
        [
            {
                name:
                    "keyboard",

                category:
                    "system",

                description:
                    "Display keyboard service status.",

                usage:
                    "keyboard",

                handler: ({
                    context,
                    writeJSON
                }) =>
                    writeJSON(
                        context.keyboard.status()
                    )
            },

            {
                name:
                    "keyboard-shortcuts",

                category:
                    "system",

                description:
                    "List registered terminal keyboard shortcuts.",

                usage:
                    "keyboard-shortcuts",

                handler: ({
                    context,
                    writeTable
                }) => {
                    const shortcuts =
                        context.keyboard.list();

                    return writeTable(
                        [
                            "Shortcut",
                            "Action",
                            "Description",
                            "Enabled",
                            "Scope"
                        ],
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
                    );
                }
            },

            {
                name:
                    "keyboard-enable",

                category:
                    "system",

                description:
                    "Enable all shortcuts or one specific shortcut.",

                usage:
                    "keyboard-enable [shortcut]",

                handler: ({
                    args,
                    context,
                    write
                }) => {
                    const combo =
                        args.join(
                            "+"
                        ) ||
                        null;

                    const enabled =
                        context.keyboard.enable(
                            combo
                        );

                    if (!enabled) {
                        throw new Error(
                            `Unknown keyboard shortcut: ${combo}`
                        );
                    }

                    return write(
                        combo
                            ? `Keyboard shortcut enabled: ${combo}`
                            : "Keyboard shortcuts enabled.",
                        "success"
                    );
                }
            },

            {
                name:
                    "keyboard-disable",

                category:
                    "system",

                description:
                    "Disable all shortcuts or one specific shortcut.",

                usage:
                    "keyboard-disable [shortcut]",

                handler: ({
                    args,
                    context,
                    write
                }) => {
                    const combo =
                        args.join(
                            "+"
                        ) ||
                        null;

                    const disabled =
                        context.keyboard.disable(
                            combo
                        );

                    if (!disabled) {
                        throw new Error(
                            `Unknown keyboard shortcut: ${combo}`
                        );
                    }

                    return write(
                        combo
                            ? `Keyboard shortcut disabled: ${combo}`
                            : "Keyboard shortcuts disabled.",
                        "success"
                    );
                }
            },

            {
                name:
                    "keyboard-bind",

                category:
                    "system",

                description:
                    "Bind a keyboard shortcut to an existing terminal command.",

                usage:
                    "keyboard-bind <shortcut> <command>",

                handler: ({
                    args,
                    context,
                    write
                }) => {
                    if (
                        args.length <
                        2
                    ) {
                        throw new Error(
                            "Usage: keyboard-bind <shortcut> <command>"
                        );
                    }

                    const combo =
                        args.shift();

                    const command =
                        args.join(
                            " "
                        );

                    context.keyboard.register(
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

                    return write(
                        `Keyboard shortcut ${combo} bound to: ${command}`,
                        "success"
                    );
                }
            },

            {
                name:
                    "keyboard-test",

                category:
                    "system",

                description:
                    "Normalize and inspect a keyboard shortcut.",

                usage:
                    "keyboard-test <shortcut>",

                handler: ({
                    args,
                    writeJSON
                }) => {
                    const combo =
                        args.join(
                            "+"
                        );

                    if (!combo) {
                        throw new Error(
                            "A keyboard shortcut is required."
                        );
                    }

                    return writeJSON({
                        input:
                            combo,
                        normalized:
                            normalizeCombo(
                                combo
                            )
                    });
                }
            },

            {
                name:
                    "keyboard-reset",

                category:
                    "system",

                description:
                    "Remove runtime bindings and restore defaults.",

                usage:
                    "keyboard-reset",

                handler: ({
                    context,
                    write
                }) => {
                    context.keyboard.shortcuts.clear();
                    context.keyboard.installDefaults();
                    context.keyboard.clearPersistedBindings();

                    return write(
                        "Keyboard shortcuts reset to defaults.",
                        "success"
                    );
                }
            },

            {
                name:
                    "keyboard-unbind",

                category:
                    "system",

                description:
                    "Remove a registered keyboard shortcut.",

                usage:
                    "keyboard-unbind <shortcut>",

                handler: ({
                    args,
                    context,
                    write
                }) => {
                    const combo =
                        args.join(
                            "+"
                        );

                    if (!combo) {
                        throw new Error(
                            "A keyboard shortcut is required."
                        );
                    }

                    if (
                        !context.keyboard.unregister(
                            combo
                        )
                    ) {
                        throw new Error(
                            `Unknown keyboard shortcut: ${combo}`
                        );
                    }

                    return write(
                        `Keyboard shortcut removed: ${combo}`,
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

    document.dispatchEvent(
        new CustomEvent(
            "speciedex:terminal-module-available",
            {
                detail: {
                    name:
                        MODULE_NAME,

                    module:
                        api
                }
            }
        )
    );
})(window, document);
