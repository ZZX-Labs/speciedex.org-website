/*
========================================================================
Speciedex.org
Terminal Context Menu
========================================================================

Accessible context-menu service for SpeciedexTerminal.

Provides:

    • Viewport-safe context-menu positioning
    • Copy, select, clear, focus, and paste actions
    • Keyboard navigation and escape handling
    • Clipboard API fallback support
    • Safe lifecycle cleanup
    • Terminal command integration

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Contextmenu";
    const VERSION = "2.2.0";

    const CONTEXTMENU_SYMBOL =
        Symbol.for(
            "speciedex.terminal.contextmenu.service"
        );

    const DEFAULT_LONG_PRESS_DELAY =
        650;

    const DEFAULT_TYPEAHEAD_TIMEOUT =
        700;

    const DEFAULT_MAX_ACTIONS =
        128;

    const RESERVED_ACTIONS =
        new Set([
            "__proto__",
            "prototype",
            "constructor"
        ]);

    const activeDispatches =
        new WeakMap();

    const SELECTORS = Object.freeze({
        menu: "[data-terminal-context-menu]",
        output:
            "[data-terminal-output], .terminal-output",
        input:
            "[data-terminal-input], input[type='text'], textarea"
    });

    function isObject(value) {
        return (
            value !== null &&
            typeof value === "object" &&
            !Array.isArray(value)
        );
    }

    function isElement(value) {
        return Boolean(
            value &&
            value.nodeType === 1 &&
            typeof value.querySelector === "function"
        );
    }

    function parseBoolean(value, fallback = false) {
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
            String(value).trim().toLowerCase();

        if (
            ["1", "true", "yes", "on", "enabled"].includes(normalized)
        ) {
            return true;
        }

        if (
            ["0", "false", "no", "off", "disabled"].includes(normalized)
        ) {
            return false;
        }

        return fallback;
    }

    function safeStringify(value, compact = false) {
        const seen = new WeakSet();

        return JSON.stringify(
            value,
            (_key, item) => {
                if (
                    item &&
                    typeof item === "object"
                ) {
                    if (seen.has(item)) {
                        return "[Circular]";
                    }

                    seen.add(item);
                }

                if (typeof item === "bigint") {
                    return String(item);
                }

                return item;
            },
            compact ? 0 : 2
        );
    }

    function normalizeActionId(
        value
    ) {
        const id =
            String(value ?? "")
                .normalize("NFKC")
                .trim()
                .toLowerCase()
                .replace(/\s+/g, "-")
                .replace(/[^a-z0-9:_-]/g, "-")
                .replace(/-+/g, "-")
                .replace(/^[-:]+|[-:]+$/g, "");

        if (
            !id ||
            RESERVED_ACTIONS.has(id)
        ) {
            throw new TypeError(
                "A valid context-menu action identifier is required."
            );
        }

        return id;
    }

    function isEditable(
        element
    ) {
        if (!element) {
            return false;
        }

        const tag =
            String(element.tagName || "")
                .toLowerCase();

        return (
            tag === "input" ||
            tag === "textarea" ||
            element.isContentEditable === true
        );
    }

    function insertText(
        element,
        text
    ) {
        if (
            !element ||
            !isEditable(
                element
            )
        ) {
            return false;
        }

        const value =
            String(
                text ??
                ""
            );

        if (
            element.isContentEditable
        ) {
            element.focus();

            try {
                return document.execCommand(
                    "insertText",
                    false,
                    value
                );
            } catch (_error) {
                element.textContent =
                    `${element.textContent || ""}${value}`;

                try {
                    element.dispatchEvent(
                        new InputEvent(
                            "input",
                            {
                                bubbles: true,
                                inputType: "insertText",
                                data: value
                            }
                        )
                    );
                } catch (_eventError) {
                    element.dispatchEvent(
                        new Event(
                            "input",
                            { bubbles: true }
                        )
                    );
                }

                return true;
            }
        }

        const start =
            element.selectionStart ??
            element.value.length;

        const end =
            element.selectionEnd ??
            start;

        if (
            typeof element.setRangeText ===
                "function"
        ) {
            element.setRangeText(
                value,
                start,
                end,
                "end"
            );
        } else {
            element.value =
                element.value.slice(
                    0,
                    start
                ) +
                value +
                element.value.slice(
                    end
                );

            const cursor =
                start +
                value.length;

            element.setSelectionRange?.(
                cursor,
                cursor
            );
        }

        try {
            element.dispatchEvent(
                new InputEvent(
                    "input",
                    {
                        bubbles: true,
                        inputType: "insertText",
                        data: value
                    }
                )
            );
        } catch (_eventError) {
            element.dispatchEvent(
                new Event(
                    "input",
                    { bubbles: true }
                )
            );
        }

        element.focus();

        return true;
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
            activeDispatches.set(target, names);
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

    function getTextSelection() {
        try {
            return String(
                window.getSelection?.() || ""
            );
        } catch (_error) {
            return "";
        }
    }

    async function copyText(text) {
        const value =
            String(text ?? "");

        if (!value) {
            return false;
        }

        try {
            if (
                navigator.clipboard &&
                typeof navigator.clipboard.writeText ===
                "function"
            ) {
                await navigator.clipboard.writeText(
                    value
                );

                return true;
            }
        } catch (_error) {
            /*
            ------------------------------------------------------------------
            Fall through to the legacy copy path.
            ------------------------------------------------------------------
            */
        }

        const textarea =
            document.createElement("textarea");

        textarea.value = value;
        textarea.readOnly = true;
        textarea.setAttribute(
            "aria-hidden",
            "true"
        );

        Object.assign(
            textarea.style,
            {
                position: "fixed",
                opacity: "0",
                pointerEvents: "none",
                left: "-9999px",
                top: "0"
            }
        );

        (document.body || document.documentElement)
            .appendChild(textarea);
        textarea.select();

        let copied = false;

        try {
            copied =
                document.execCommand("copy");
        } catch (_error) {
            copied = false;
        }

        textarea.remove();
        return copied;
    }

    async function readClipboardText() {
        try {
            if (
                navigator.clipboard &&
                typeof navigator.clipboard.readText ===
                "function"
            ) {
                return await navigator.clipboard.readText();
            }
        } catch (_error) {
            return "";
        }

        return "";
    }

    function writeStatus(context, message, type = "info") {
        if (
            context &&
            typeof context.write === "function"
        ) {
            return context.write(
                message,
                type
            );
        }

        return message;
    }

    class ContextMenu extends EventTarget {
        constructor(context = {}, options = {}) {
            super();

            this.context =
                isObject(context)
                    ? context
                    : {};

            this.root =
                isElement(this.context.root)
                    ? this.context.root
                    : document.documentElement;
            this.options = {
                enabled:
                    parseBoolean(
                        options.enabled,
                        true
                    ),

                includePaste:
                    parseBoolean(
                        options.includePaste,
                        true
                    ),

                longPress:
                    parseBoolean(
                        options.longPress,
                        true
                    ),

                longPressDelay:
                    Number.isFinite(
                        Number(
                            options.longPressDelay
                        )
                    )
                        ? Math.max(
                            250,
                            Math.min(
                                3000,
                                Number(
                                    options.longPressDelay
                                )
                            )
                        )
                        : DEFAULT_LONG_PRESS_DELAY,

                typeaheadTimeout:
                    Number.isFinite(
                        Number(
                            options.typeaheadTimeout
                        )
                    )
                        ? Math.max(
                            100,
                            Math.min(
                                3000,
                                Number(
                                    options.typeaheadTimeout
                                )
                            )
                        )
                        : DEFAULT_TYPEAHEAD_TIMEOUT,

                maxActions:
                    Number.isFinite(
                        Number(
                            options.maxActions
                        )
                    )
                        ? Math.max(
                            1,
                            Math.min(
                                1000,
                                Number(
                                    options.maxActions
                                )
                            )
                        )
                        : DEFAULT_MAX_ACTIONS
            };

            this.menu =
                this.root.querySelector(
                    SELECTORS.menu
                ) || null;

            this.previousFocus =
                null;

            this.opened =
                false;

            this.ready =
                true;

            this.destroyed =
                false;

            this.watchers =
                new Set();

            this.lastEvent =
                null;

            this.lastTarget =
                null;

            this.typeaheadBuffer =
                "";

            this.typeaheadTimer =
                null;

            this.longPressTimer =
                null;

            this.longPressStart =
                null;

            this.emitting =
                false;

            this.syncingState =
                false;

            this.actions =
                new Map();

            this.abortController =
                new AbortController();

            this.metrics = {
                opens:
                    0,
                closes:
                    0,
                actions:
                    0,
                failures:
                    0,
                copies:
                    0,
                pastes:
                    0,
                longPresses:
                    0,
                registrations:
                    0,
                unregistrations:
                    0
            };

            this.boundContextMenu =
                event => this.handleContextMenu(event);

            this.boundDocumentPointer =
                event => this.handleDocumentPointer(event);

            this.boundDocumentKeydown =
                event => this.handleDocumentKeydown(event);

            this.boundWindowBlur =
                () => this.close("window-blur");

            this.boundWindowResize =
                () =>
                    this.close(
                        "window-resize"
                    );

            this.boundPointerDown =
                event =>
                    this.handlePointerDown(
                        event
                    );

            this.boundPointerMove =
                event =>
                    this.handlePointerMove(
                        event
                    );

            this.boundPointerUp =
                () =>
                    this.cancelLongPress();

            this.ensureMenu();
            this.registerBuiltinActions();
            this.bind();
        }

        emit(
            name,
            detail =
                {}
        ) {
            if (
                this.destroyed &&
                name !==
                    "destroy"
            ) {
                return false;
            }

            if (
                this.emitting
            ) {
                return false;
            }

            this.emitting =
                true;

            try {
                dispatch(
                    this,
                    name,
                    detail
                );

                for (
                    const watcher
                    of Array.from(this.watchers)
                ) {
                    try {
                        watcher(
                            {
                                type: name,
                                timestamp:
                                    new Date().toISOString(),
                                detail
                            },
                            this
                        );
                    } catch (_error) {
                        /* Watcher failures must not break the menu. */
                    }
                }

                try {
                    this.context.events?.emit?.(
                        `contextmenu:${name}`,
                        detail
                    );
                } catch (_error) {
                    /* Observer failures must not break the menu. */
                }

                dispatch(
                    this.root,
                    `speciedex:terminal-context-${name}`,
                    detail,
                    {
                        bubbles:
                            true
                    }
                );

                return true;
            } finally {
                this.emitting =
                    false;
            }
        }

        syncState() {
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
                    "terminal.contextmenu",
                    {
                        enabled:
                            this.options.enabled,
                        opened:
                            this.opened,
                        actions:
                            this.actions.size,
                        updatedAt:
                            new Date().toISOString()
                    },
                    {
                        source:
                            "contextmenu",
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

        ensureMenu() {
            if (this.menu) {
                this.configureMenu();
                return this.menu;
            }

            const menu =
                document.createElement("div");

            menu.dataset.terminalContextMenu = "";
            menu.className =
                "terminal-context-menu";
            menu.hidden = true;

            this.root.appendChild(menu);
            this.menu = menu;

            this.configureMenu();
            return menu;
        }

        configureMenu() {
            if (!this.menu) {
                return;
            }

            this.menu.hidden = true;
            this.menu.setAttribute(
                "role",
                "menu"
            );
            this.menu.setAttribute(
                "aria-label",
                "Terminal context menu"
            );
            this.menu.tabIndex = -1;

            Object.assign(
                this.menu.style,
                {
                    position: "fixed",
                    zIndex: "2147483647"
                }
            );
        }

        bind() {
            if (this.bound) {
                return false;
            }

            this.root.addEventListener(
                "contextmenu",
                this.boundContextMenu
            );

            document.addEventListener(
                "pointerdown",
                this.boundDocumentPointer,
                true
            );

            document.addEventListener(
                "keydown",
                this.boundDocumentKeydown,
                true
            );

            window.addEventListener(
                "blur",
                this.boundWindowBlur
            );

            window.addEventListener(
                "resize",
                this.boundWindowResize
            );

            if (this.options.longPress) {
                this.root.addEventListener(
                    "pointerdown",
                    this.boundPointerDown,
                    { passive: true }
                );

                this.root.addEventListener(
                    "pointermove",
                    this.boundPointerMove,
                    { passive: true }
                );

                this.root.addEventListener(
                    "pointerup",
                    this.boundPointerUp
                );

                this.root.addEventListener(
                    "pointercancel",
                    this.boundPointerUp
                );
            }

            this.bound = true;

            return true;
        }

        unbind() {
            if (!this.bound) {
                return false;
            }

            this.root.removeEventListener(
                "contextmenu",
                this.boundContextMenu
            );

            document.removeEventListener(
                "pointerdown",
                this.boundDocumentPointer,
                true
            );

            document.removeEventListener(
                "keydown",
                this.boundDocumentKeydown,
                true
            );

            window.removeEventListener(
                "blur",
                this.boundWindowBlur
            );

            window.removeEventListener(
                "resize",
                this.boundWindowResize
            );

            this.root.removeEventListener(
                "pointerdown",
                this.boundPointerDown
            );

            this.root.removeEventListener(
                "pointermove",
                this.boundPointerMove
            );

            this.root.removeEventListener(
                "pointerup",
                this.boundPointerUp
            );

            this.root.removeEventListener(
                "pointercancel",
                this.boundPointerUp
            );

            this.cancelLongPress();

            window.clearTimeout(
                this.typeaheadTimer
            );

            this.typeaheadTimer = null;
            this.bound = false;

            return true;
        }

        isEnabled() {
            return (
                this.options.enabled &&
                !this.destroyed
            );
        }

        setEnabled(enabled) {
            this.options.enabled =
                parseBoolean(
                    enabled,
                    Boolean(enabled)
                );

            if (!this.options.enabled) {
                this.close("disabled");
            }

            return this.options.enabled;
        }

        getOutputElement() {
            return (
                this.context.elements?.output ||
                this.root.querySelector(
                    SELECTORS.output
                ) ||
                null
            );
        }

        getInputElement() {
            return (
                this.context.elements?.input ||
                this.root.querySelector(
                    SELECTORS.input
                ) ||
                null
            );
        }

        getOutputText() {
            const output =
                this.getOutputElement();

            return (
                output?.innerText ||
                output?.textContent ||
                ""
            );
        }

        registerAction(
            definition,
            options =
                {}
        ) {
            if (
                !definition ||
                typeof definition !==
                    "object"
            ) {
                throw new TypeError(
                    "A context-menu action definition is required."
                );
            }

            const id =
                normalizeActionId(
                    definition.id ||
                    definition.name
                );

            if (
                !this.actions.has(
                    id
                ) &&
                this.actions.size >=
                    this.options.maxActions
            ) {
                throw new RangeError(
                    `Context-menu action limit reached: ${this.options.maxActions}`
                );
            }

            if (
                this.actions.has(
                    id
                ) &&
                options.replace !==
                    true
            ) {
                throw new Error(
                    `Context-menu action already exists: ${id}`
                );
            }

            const action = {
                id,
                label:
                    String(
                        definition.label ||
                        id
                    ),
                order:
                    Number.isFinite(
                        Number(
                            definition.order
                        )
                    )
                        ? Number(
                            definition.order
                        )
                        : 100,
                group:
                    String(
                        definition.group ||
                        "general"
                    ),
                when:
                    typeof definition.when ===
                        "function"
                        ? definition.when
                        : () =>
                            true,
                disabled:
                    typeof definition.disabled ===
                        "function"
                        ? definition.disabled
                        : () =>
                            Boolean(
                                definition.disabled
                            ),
                run:
                    typeof definition.run ===
                        "function"
                        ? definition.run
                        : async () =>
                            null
            };

            this.actions.set(
                id,
                action
            );

            this.metrics.registrations +=
                1;

            this.syncState();

            return action;
        }

        unregisterAction(
            id
        ) {
            const normalized =
                normalizeActionId(
                    id
                );

            const removed =
                this.actions.delete(
                    normalized
                );

            if (removed) {
                this.metrics.unregistrations +=
                    1;

                this.syncState();
            }

            return removed;
        }

        registerBuiltinActions() {
            const definitions = [
                {
                    id:
                        "copy-selection",
                    label:
                        "Copy selection",
                    order:
                        10,
                    when:
                        scope =>
                            Boolean(
                                scope.selection.trim()
                            ),
                    run:
                        async scope => {
                            const copied =
                                await copyText(
                                    scope.selection
                                );

                            if (copied) {
                                this.metrics.copies +=
                                    1;
                            }

                            writeStatus(
                                this.context,
                                copied
                                    ? "Selection copied."
                                    : "Unable to copy selection.",
                                copied
                                    ? "success"
                                    : "warning"
                            );

                            return copied;
                        }
                },
                {
                    id:
                        "copy-record",
                    label:
                        "Copy record JSON",
                    order:
                        20,
                    when:
                        scope =>
                            Boolean(
                                scope.record
                            ),
                    run:
                        async scope => {
                            const copied =
                                await copyText(
                                    safeStringify(
                                        scope.record
                                    )
                                );

                            if (copied) {
                                this.metrics.copies +=
                                    1;
                            }

                            return copied;
                        }
                },
                {
                    id:
                        "copy-output",
                    label:
                        "Copy output",
                    order:
                        30,
                    when:
                        scope =>
                            Boolean(
                                scope.outputText.trim()
                            ),
                    run:
                        async scope => {
                            const copied =
                                await copyText(
                                    scope.outputText
                                );

                            if (copied) {
                                this.metrics.copies +=
                                    1;
                            }

                            writeStatus(
                                this.context,
                                copied
                                    ? "Terminal output copied."
                                    : "Unable to copy terminal output.",
                                copied
                                    ? "success"
                                    : "warning"
                            );

                            return copied;
                        }
                },
                {
                    id:
                        "paste-input",
                    label:
                        "Paste into input",
                    order:
                        40,
                    when:
                        scope =>
                            this.options.includePaste &&
                            Boolean(
                                scope.input
                            ),
                    disabled:
                        scope =>
                            !isEditable(
                                scope.input
                            ),
                    run:
                        async scope => {
                            const value =
                                await readClipboardText();

                            if (!value) {
                                writeStatus(
                                    this.context,
                                    "Clipboard text is unavailable.",
                                    "warning"
                                );

                                return false;
                            }

                            const inserted =
                                insertText(
                                    scope.input,
                                    value
                                );

                            if (inserted) {
                                this.metrics.pastes +=
                                    1;
                            }

                            return inserted;
                        }
                },
                {
                    id:
                        "select-output",
                    label:
                        "Select output",
                    order:
                        50,
                    when:
                        scope =>
                            Boolean(
                                scope.output
                            ),
                    run:
                        scope => {
                            const range =
                                document.createRange();

                            range.selectNodeContents(
                                scope.output
                            );

                            const selection =
                                window.getSelection?.();

                            selection?.removeAllRanges();
                            selection?.addRange(
                                range
                            );

                            return true;
                        }
                },
                {
                    id:
                        "clear-output",
                    label:
                        "Clear output",
                    order:
                        60,
                    when:
                        () =>
                            typeof this.context.clear ===
                            "function",
                    run:
                        () => {
                            this.context.clear();

                            writeStatus(
                                this.context,
                                "Terminal output cleared.",
                                "success"
                            );

                            return true;
                        }
                },
                {
                    id:
                        "focus-input",
                    label:
                        "Focus input",
                    order:
                        70,
                    when:
                        scope =>
                            Boolean(
                                scope.input
                            ) ||
                            typeof this.context.focus ===
                            "function",
                    run:
                        scope => {
                            if (
                                typeof this.context.focus ===
                                "function"
                            ) {
                                this.context.focus();
                            } else {
                                scope.input?.focus();
                            }

                            return true;
                        }
                },
                {
                    id:
                        "open-record",
                    label:
                        "Open record",
                    order:
                        80,
                    when:
                        scope =>
                            Boolean(
                                scope.recordId
                            ),
                    run:
                        scope => {
                            if (
                                typeof this.context.execute ===
                                "function"
                            ) {
                                return this.context.execute(
                                    `show ${scope.recordId}`
                                );
                            }

                            this.emit(
                                "record-open",
                                {
                                    id:
                                        scope.recordId,
                                    record:
                                        scope.record
                                }
                            );

                            return true;
                        }
                }
            ];

            for (
                const definition of
                definitions
            ) {
                this.registerAction(
                    definition,
                    {
                        replace:
                            true
                    }
                );
            }
        }

        resolveScope(
            event
        ) {
            const target =
                event?.target ||
                this.lastTarget ||
                null;

            const recordElement =
                target?.closest?.(
                    "[data-record-id], [data-row-id], [data-node-id], [data-event-id], [data-speciedex-id]"
                ) ||
                null;

            const recordId =
                recordElement?.
                    dataset.recordId ||
                recordElement?.
                    dataset.rowId ||
                recordElement?.
                    dataset.nodeId ||
                recordElement?.
                    dataset.eventId ||
                recordElement?.
                    dataset.speciedexId ||
                null;

            let record =
                null;

            try {
                if (
                    recordElement?.
                        dataset.record
                ) {
                    record =
                        JSON.parse(
                            recordElement.dataset.record
                        );
                } else if (
                    recordId
                ) {
                    record =
                        this.context.library?.
                            find?.(
                                recordId
                            ) ||
                        this.context.index?.
                            get?.(
                                recordId
                            ) ||
                        null;
                }
            } catch (_error) {
                record =
                    null;
            }

            const output =
                this.getOutputElement();

            const input =
                isEditable(
                    target
                )
                    ? target
                    : this.getInputElement();

            return {
                event,
                target,
                recordElement,
                recordId,
                record,
                output,
                outputText:
                    this.getOutputText(),
                input,
                selection:
                    getTextSelection(),
                context:
                    this.context,
                menu:
                    this
            };
        }

        getActions(
            event
        ) {
            const scope =
                this.resolveScope(
                    event
                );

            return [
                ...this.actions.values()
            ]
                .filter(
                    action => {
                        try {
                            return action.when(
                                scope
                            ) !==
                            false;
                        } catch (_error) {
                            return false;
                        }
                    }
                )
                .map(
                    action => ({
                        ...action,
                        disabled:
                            (() => {
                                try {
                                    return Boolean(
                                        action.disabled(
                                            scope
                                        )
                                    );
                                } catch (_error) {
                                    return true;
                                }
                            })(),
                        scope
                    })
                )
                .sort(
                    (
                        left,
                        right
                    ) =>
                        left.order -
                        right.order ||
                        left.label.localeCompare(
                            right.label
                        )
                );
        }

        createButton(action) {
            const button =
                document.createElement("button");

            button.type = "button";
            button.className =
                "terminal-context-menu-item";
            button.dataset.contextAction =
                action.id;
            button.setAttribute(
                "role",
                "menuitem"
            );
            button.tabIndex = -1;
            button.textContent =
                action.label;
            button.disabled =
                Boolean(action.disabled);

            button.addEventListener(
                "click",
                async event => {
                    event.preventDefault();
                    event.stopPropagation();

                    if (button.disabled) {
                        return;
                    }

                    try {
                        const result =
                            await action.run(
                                action.scope
                            );

                        this.metrics.actions +=
                            1;

                        this.emit(
                            "action",
                            {
                                id:
                                    action.id,
                                label:
                                    action.label,
                                result
                            }
                        );
                    } catch (error) {
                        this.metrics.failures +=
                            1;

                        writeStatus(
                            this.context,
                            `Context-menu action failed: ${error?.message || error}`,
                            "error"
                        );
                    } finally {
                        this.close("action");
                    }
                }
            );

            return button;
        }

        render(event) {
            if (!this.menu) {
                return;
            }

            this.menu.replaceChildren();

            for (
                const action of
                this.getActions(event)
            ) {
                this.menu.appendChild(
                    this.createButton(action)
                );
            }
        }

        position(clientX, clientY) {
            if (!this.menu) {
                return;
            }

            this.menu.style.left =
                "0px";
            this.menu.style.top =
                "0px";
            this.menu.hidden = false;

            const rect =
                this.menu.getBoundingClientRect();

            const padding = 8;

            const left =
                Math.max(
                    padding,
                    Math.min(
                        Number(clientX) || 0,
                        window.innerWidth -
                        rect.width -
                        padding
                    )
                );

            const top =
                Math.max(
                    padding,
                    Math.min(
                        Number(clientY) || 0,
                        window.innerHeight -
                        rect.height -
                        padding
                    )
                );

            this.menu.style.left =
                `${Math.round(left)}px`;
            this.menu.style.top =
                `${Math.round(top)}px`;
        }

        handleContextMenu(event) {
            if (!this.isEnabled()) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();

            this.open(
                event.clientX,
                event.clientY,
                event
            );
        }

        open(clientX, clientY, event = null) {
            if (
                !this.isEnabled() ||
                !this.menu
            ) {
                return false;
            }

            this.previousFocus =
                document.activeElement instanceof
                HTMLElement
                    ? document.activeElement
                    : null;

            this.lastEvent =
                event;

            this.lastTarget =
                event?.target ||
                null;

            this.render(event);

            if (
                !this.menu.querySelector(
                    '[role="menuitem"]'
                )
            ) {
                this.menu.hidden = true;
                return false;
            }

            this.position(
                clientX,
                clientY
            );

            this.opened =
                true;

            this.metrics.opens +=
                1;

            this.syncState();

            const firstEnabled =
                this.menu.querySelector(
                    '[role="menuitem"]:not(:disabled)'
                );

            firstEnabled?.focus();

            const detail = {
                x: clientX,
                y: clientY,
                event
            };

            this.emit(
                "open",
                detail
            );

            return true;
        }

        close(reason = "manual") {
            if (
                !this.menu ||
                this.menu.hidden
            ) {
                return false;
            }

            this.menu.hidden =
                true;

            this.opened =
                false;

            this.metrics.closes +=
                1;

            this.syncState();

            const previousFocus =
                this.previousFocus;

            this.previousFocus = null;

            if (
                previousFocus &&
                previousFocus.isConnected &&
                typeof previousFocus.focus ===
                "function"
            ) {
                try {
                    previousFocus.focus({
                        preventScroll: true
                    });
                } catch (_error) {
                    previousFocus.focus();
                }
            }

            const detail = {
                reason
            };

            this.emit(
                "close",
                detail
            );

            return true;
        }

        handlePointerDown(
            event
        ) {
            if (
                !this.options.longPress ||
                event.pointerType ===
                    "mouse" ||
                !this.isEnabled()
            ) {
                return;
            }

            this.cancelLongPress();

            this.longPressStart = {
                x:
                    event.clientX,
                y:
                    event.clientY,
                target:
                    event.target,
                pointerId:
                    event.pointerId
            };

            this.longPressTimer =
                window.setTimeout(
                    () => {
                        const start =
                            this.longPressStart;

                        this.longPressTimer =
                            null;

                        if (!start) {
                            return;
                        }

                        this.metrics.longPresses +=
                            1;

                        this.open(
                            start.x,
                            start.y,
                            {
                                target:
                                    start.target,
                                clientX:
                                    start.x,
                                clientY:
                                    start.y,
                                pointerType:
                                    "touch",
                                preventDefault:
                                    () => {},
                                stopPropagation:
                                    () => {}
                            }
                        );
                    },
                    this.options.longPressDelay
                );
        }

        handlePointerMove(
            event
        ) {
            if (
                !this.longPressStart
            ) {
                return;
            }

            const distance =
                Math.hypot(
                    event.clientX -
                    this.longPressStart.x,
                    event.clientY -
                    this.longPressStart.y
                );

            if (
                distance >
                12
            ) {
                this.cancelLongPress();
            }
        }

        cancelLongPress() {
            window.clearTimeout(
                this.longPressTimer
            );

            this.longPressTimer =
                null;

            this.longPressStart =
                null;
        }

        handleDocumentPointer(event) {
            if (
                !this.opened ||
                !this.menu
            ) {
                return;
            }

            if (
                !this.menu.contains(
                    event.target
                )
            ) {
                this.close(
                    "outside-pointer"
                );
            }
        }

        getMenuItems() {
            if (!this.menu) {
                return [];
            }

            return [
                ...this.menu.querySelectorAll(
                    '[role="menuitem"]:not(:disabled)'
                )
            ];
        }

        moveFocus(direction) {
            const items =
                this.getMenuItems();

            if (!items.length) {
                return;
            }

            const current =
                items.indexOf(
                    document.activeElement
                );

            const next =
                current < 0
                    ? 0
                    : (
                        current +
                        direction +
                        items.length
                    ) % items.length;

            items[next].focus();
        }

        handleDocumentKeydown(event) {
            if (!this.opened) {
                return;
            }

            if (event.key === "Escape") {
                event.preventDefault();
                this.close("escape");
                return;
            }

            if (
                event.key === "ArrowDown"
            ) {
                event.preventDefault();
                this.moveFocus(1);
                return;
            }

            if (
                event.key === "ArrowUp"
            ) {
                event.preventDefault();
                this.moveFocus(-1);
                return;
            }

            if (
                event.key === "Home"
            ) {
                event.preventDefault();
                this.getMenuItems()[0]?.focus();
                return;
            }

            if (
                event.key.length ===
                    1 &&
                !event.ctrlKey &&
                !event.metaKey &&
                !event.altKey
            ) {
                this.typeaheadBuffer +=
                    event.key.toLowerCase();

                window.clearTimeout(
                    this.typeaheadTimer
                );

                this.typeaheadTimer =
                    window.setTimeout(
                        () => {
                            this.typeaheadBuffer =
                                "";
                        },
                        this.options.typeaheadTimeout
                    );

                const match =
                    this.getMenuItems().
                        find(
                            item =>
                                item.textContent?.
                                    trim().
                                    toLowerCase().
                                    startsWith(
                                        this.typeaheadBuffer
                                    )
                        );

                if (match) {
                    event.preventDefault();
                    match.focus();
                }

                return;
            }

            if (
                event.key === "End"
            ) {
                event.preventDefault();

                const items =
                    this.getMenuItems();

                items[
                    items.length - 1
                ]?.focus();
            }
        }

        watch(callback, options = {}) {
            if (typeof callback !== "function") {
                throw new TypeError(
                    "Context-menu watcher must be a function."
                );
            }

            this.watchers.add(callback);

            if (options.immediate === true) {
                callback(
                    {
                        type: "initial",
                        timestamp:
                            new Date().toISOString(),
                        status:
                            this.status()
                    },
                    this
                );
            }

            return () =>
                this.watchers.delete(callback);
        }

        status() {
            return {
                version: VERSION,
                ready:
                    this.ready,
                enabled:
                    this.options.enabled,
                opened:
                    this.opened,
                includePaste:
                    this.options.includePaste,
                menuPresent:
                    Boolean(
                        this.menu
                    ),
                registeredActions:
                    this.actions.size,
                lastTarget:
                    this.lastTarget?.
                        nodeName ||
                    null,
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

            this.close(
                "destroy"
            );

            this.unbind();

            this.emit(
                "destroy",
                {
                    timestamp:
                        new Date().toISOString(),
                    version:
                        VERSION
                }
            );

            this.actions.clear();
            this.watchers.clear();

            if (
                this.menu &&
                this.menu.dataset.
                    terminalContextMenu !==
                    undefined
            ) {
                this.menu.remove();
            }

            if (
                this.context.root?.[
                    CONTEXTMENU_SYMBOL
                ] ===
                    this
            ) {
                delete this.context.root[
                    CONTEXTMENU_SYMBOL
                ];
            }

            this.menu =
                null;

            this.lastEvent =
                null;

            this.lastTarget =
                null;

            this.options.enabled =
                false;

            this.ready =
                false;

            this.destroyed =
                true;

            return true;
        }

    }

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
            safeContext.contextMenu instanceof
                ContextMenu
                ? safeContext.contextMenu
                : safeContext.services?.get?.(
                    "contextmenu"
                ) ||
                safeContext.services?.get?.(
                    "contextMenu"
                ) ||
                root?.[CONTEXTMENU_SYMBOL];

        if (
            existing instanceof ContextMenu &&
            !existing.destroyed
        ) {
            safeContext.contextMenu =
                existing;

            safeContext.registerService?.(
                "contextmenu",
                existing
            );

            safeContext.registerService?.(
                "contextMenu",
                existing
            );

            return existing;
        }

        const dataset =
            root.dataset || {};

        const config =
            safeContext.config?.contextmenu ||
            safeContext.config?.contextMenu ||
            {};

        const menu =
            new ContextMenu(
                {
                    ...safeContext,
                    root
                },
                {
                    enabled:
                        parseBoolean(
                            dataset.terminalContextMenu,
                            config.enabled !== false
                        ),
                    includePaste:
                        parseBoolean(
                            dataset.terminalContextMenuPaste,
                            config.includePaste !== false
                        ),
                    longPress:
                        parseBoolean(
                            dataset.terminalContextMenuLongPress,
                            config.longPress !== false
                        ),
                    longPressDelay:
                        dataset.terminalContextMenuLongPressDelay ||
                        config.longPressDelay,
                    typeaheadTimeout:
                        dataset.terminalContextMenuTypeaheadTimeout ||
                        config.typeaheadTimeout,
                    maxActions:
                        dataset.terminalContextMenuMaxActions ||
                        config.maxActions
                }
            );

        root[CONTEXTMENU_SYMBOL] =
            menu;

        safeContext.contextMenu =
            menu;

        safeContext.registerService?.(
            "contextmenu",
            menu
        );

        safeContext.registerService?.(
            "contextMenu",
            menu
        );

        dispatch(
            document,
            "speciedex:terminal-contextmenu-ready",
            {
                context:
                    safeContext,
                contextMenu:
                    menu,
                version:
                    VERSION
            }
        );

        return menu;
    }

    function resolveCommandContext(payload = {}) {
        return (
            payload.context ||
            payload.terminal?.context ||
            payload.app?.context ||
            payload
        );
    }

    function requireMenu(context) {
        const safeContext =
            isObject(context)
                ? context
                : {};

        const menu =
            safeContext.contextMenu instanceof
                ContextMenu
                ? safeContext.contextMenu
                : safeContext.services?.get?.(
                    "contextmenu"
                ) ||
                safeContext.services?.get?.(
                    "contextMenu"
                ) ||
                initialize(safeContext);

        if (
            !(menu instanceof ContextMenu) ||
            menu.destroyed
        ) {
            throw new Error(
                "Terminal context-menu service is unavailable."
            );
        }

        return menu;
    }

    function writeResult(payload, value, type = "data") {
        if (
            typeof payload.writeJSON ===
            "function" &&
            typeof value !== "string"
        ) {
            return payload.writeJSON(value);
        }

        if (typeof payload.write === "function") {
            return payload.write(
                typeof value === "string"
                    ? value
                    : safeStringify(value),
                type
            );
        }

        if (typeof payload.writeLine === "function") {
            return payload.writeLine(
                typeof value === "string"
                    ? value
                    : safeStringify(value)
            );
        }

        return value;
    }

    const commands = [
        {
            name: "contextmenu",
            aliases: [
                "context-menu",
                "ctxmenu"
            ],
            category: "system",
            description:
                "Inspect or configure the terminal context menu.",
            usage:
                "contextmenu [status|enable|disable|open|close|actions|invoke <id>]",
            handler: async payload => {
                const context =
                    resolveCommandContext(payload);

                const args =
                    Array.isArray(payload.args)
                        ? payload.args
                        : [];

                const menu =
                    requireMenu(context);

                const action =
                    String(args[0] || "status")
                        .toLowerCase();

                if (action === "enable") {
                    menu.setEnabled(true);

                    return writeResult(
                        payload,
                        "Context menu enabled.",
                        "success"
                    );
                }

                if (action === "disable") {
                    menu.setEnabled(false);

                    return writeResult(
                        payload,
                        "Context menu disabled.",
                        "success"
                    );
                }

                if (action === "open") {
                    const rect =
                        (
                            isElement(context.root)
                                ? context.root
                                : menu.root
                        ).getBoundingClientRect();

                    menu.open(
                        rect.left +
                        Math.min(
                            rect.width / 2,
                            240
                        ),
                        rect.top +
                        Math.min(
                            rect.height / 2,
                            160
                        )
                    );

                    return writeResult(
                        payload,
                        "Context menu opened.",
                        "success"
                    );
                }

                if (
                    action ===
                    "actions"
                ) {
                    const output =
                        [
                            ...menu.actions.values()
                        ].map(
                            item => ({
                                id:
                                    item.id,
                                label:
                                    item.label,
                                group:
                                    item.group,
                                order:
                                    item.order
                            })
                        );

                    return writeResult(
                        payload,
                        output
                    );
                }

                if (
                    action ===
                    "invoke"
                ) {
                    const id =
                        args[1];

                    if (!id) {
                        throw new Error(
                            "A context-menu action identifier is required."
                        );
                    }

                    const definition =
                        menu.actions.get(
                            normalizeActionId(
                                id
                            )
                        );

                    if (!definition) {
                        throw new Error(
                            `Unknown context-menu action: ${id}`
                        );
                    }

                    const scope =
                        menu.resolveScope(
                            menu.lastEvent
                        );

                    if (
                        definition.when(scope) === false ||
                        definition.disabled(scope) === true
                    ) {
                        throw new Error(
                            `Context-menu action is unavailable: ${definition.id}`
                        );
                    }

                    const result =
                        await definition.run(
                            scope
                        );

                    menu.metrics.actions += 1;

                    return writeResult(
                        payload,
                        {
                            id:
                                definition.id,
                            result
                        }
                    );
                }

                if (action === "close") {
                    menu.close("command");

                    return writeResult(
                        payload,
                        "Context menu closed.",
                        "success"
                    );
                }

                if (action !== "status") {
                    throw new Error(
                        `Unknown context-menu action: ${action}`
                    );
                }

                return writeResult(
                    payload,
                    menu.status()
                );
            }
        }
    ];

    const api = Object.freeze({
        name: MODULE_NAME,
        version:
            VERSION,
        CONTEXTMENU_SYMBOL,
        ContextMenu,
        normalizeActionId,
        isEditable,
        insertText,
        copyText,
        readClipboardText,
        safeStringify,
        parseBoolean,
        dispatch,
        resolveCommandContext,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalContextmenu =
        api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules || {};

    window.SpeciedexTerminalModules[
        MODULE_NAME
    ] = api;

    dispatch(
        document,
        "speciedex:terminal-module-available",
        {
            name: MODULE_NAME,
            module: api
        }
    );
})(window, document);
