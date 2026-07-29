/*
========================================================================
Speciedex.org
SpeciedexTerminal Public Facade
========================================================================

This file intentionally does not implement an independent terminal runtime.

It delegates every terminal lifecycle operation to:

    /static/js/terminal/speciedex-terminal.js
    window.SpeciedexTerminalApp

The facade also installs an early, document-level command guard so terminal
forms and command controls can never perform native browser navigation while
the modular application is still loading.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const GLOBAL_NAME =
        "SpeciedexTerminal";

    const VERSION =
        "0.0.0a";

    const RELEASE_CHANNEL =
        "System Prototype";

    const PRODUCT_LABEL =
        `SpeciedexTerminal ${RELEASE_CHANNEL} ${VERSION}`;

    const DEFAULT_SELECTOR =
        "[data-speciedex-terminal], " +
        "[data-terminal-root], " +
        "#speciedex-terminal";

    const FORM_SELECTOR =
        "[data-terminal-form]";

    const INPUT_SELECTOR =
        "[data-terminal-input]";

    const COMMAND_CONTROL_SELECTOR =
        "[data-terminal-action], " +
        "[data-terminal-command], " +
        "[data-terminal-submit]";

    const FACADE_SYMBOL =
        Symbol.for(
            "speciedex.terminal.facade"
        );

    const GUARD_SYMBOL =
        Symbol.for(
            "speciedex.terminal.facade.command-guard"
        );

    const activeEvents =
        new Set();

    const pendingCommands =
        new Map();

    const pendingPlugins =
        [];

    let applicationPromise =
        null;

    let bootstrapPromise =
        null;

    let commandGuardInstalled =
        false;

    /*
    ==========================================================================
    Utilities
    ==========================================================================
    */

    function isElement(value) {
        return Boolean(
            value &&
            value.nodeType === 1 &&
            typeof value.querySelector ===
                "function"
        );
    }

    function isDocument(value) {
        return Boolean(
            value &&
            value.nodeType === 9
        );
    }

    function isDocumentFragment(value) {
        return Boolean(
            value &&
            value.nodeType === 11
        );
    }

    function isObject(value) {
        return (
            value !== null &&
            typeof value === "object" &&
            !Array.isArray(value)
        );
    }

    function normalizeContext(context) {
        if (
            context === undefined ||
            context === null
        ) {
            return document;
        }

        if (
            isDocument(context) ||
            isDocumentFragment(context) ||
            isElement(context)
        ) {
            return context;
        }

        throw new TypeError(
            "SpeciedexTerminal context must be a Document, " +
            "DocumentFragment, or Element."
        );
    }

    function normalizeCommandName(value) {
        return String(
            value ||
            ""
        )
            .trim()
            .toLowerCase();
    }

    function errorMessage(error) {
        if (
            error instanceof Error
        ) {
            return error.message;
        }

        if (
            isObject(error) &&
            error.message
        ) {
            return String(
                error.message
            );
        }

        return String(
            error ||
            "Unknown terminal error."
        );
    }

    function emit(
        name,
        detail =
            {}
    ) {
        const eventName =
            String(
                name ||
                ""
            ).trim();

        if (
            !eventName ||
            activeEvents.has(
                eventName
            )
        ) {
            return false;
        }

        activeEvents.add(
            eventName
        );

        try {
            return document.dispatchEvent(
                new CustomEvent(
                    eventName,
                    {
                        detail
                    }
                )
            );
        } catch (error) {
            console.warn(
                `[SpeciedexTerminal] Unable to dispatch "${eventName}":`,
                error
            );

            return false;
        } finally {
            activeEvents.delete(
                eventName
            );
        }
    }

    function findTerminalRoot(value) {
        if (!value) {
            return null;
        }

        if (
            isElement(value) &&
            value.matches(
                DEFAULT_SELECTOR
            )
        ) {
            return value;
        }

        const root =
            value.closest?.(
                DEFAULT_SELECTOR
            ) ||
            null;

        return isElement(root)
            ? root
            : null;
    }

    function collectRoots(context = document) {
        const normalizedContext =
            normalizeContext(
                context
            );

        const candidates =
            [];

        if (
            isElement(normalizedContext) &&
            normalizedContext.matches(
                DEFAULT_SELECTOR
            )
        ) {
            candidates.push(
                normalizedContext
            );
        }

        candidates.push(
            ...(
                normalizedContext.querySelectorAll?.(
                    DEFAULT_SELECTOR
                ) ||
                []
            )
        );

        return [
            ...new Set(
                candidates
            )
        ].filter(
            root =>
                !candidates.some(
                    candidate =>
                        candidate !== root &&
                        candidate.contains?.(
                            root
                        ) &&
                        candidate.matches?.(
                            DEFAULT_SELECTOR
                        )
                )
        );
    }

    function getInput(root) {
        return (
            root?.querySelector?.(
                INPUT_SELECTOR
            ) ||
            null
        );
    }

    function hardenRoot(root) {
        if (!isElement(root)) {
            return false;
        }

        for (
            const form of
            root.querySelectorAll(
                FORM_SELECTOR
            )
        ) {
            form.noValidate =
                true;

            form.setAttribute(
                "autocomplete",
                "off"
            );

            /*
            Property-level cancellation blocks native navigation even before
            the application wrapper has attached delegated event handlers.
            */
            form.onsubmit =
                () =>
                    false;
        }

        for (
            const control of
            root.querySelectorAll(
                COMMAND_CONTROL_SELECTOR
            )
        ) {
            if (
                control.tagName ===
                    "BUTTON"
            ) {
                control.type =
                    control.hasAttribute(
                        "data-terminal-submit"
                    )
                        ? "submit"
                        : "button";
            }

            if (
                control.tagName ===
                    "A"
            ) {
                control.removeAttribute(
                    "href"
                );

                control.setAttribute(
                    "role",
                    "button"
                );

                if (
                    !control.hasAttribute(
                        "tabindex"
                    )
                ) {
                    control.tabIndex =
                        0;
                }
            }
        }

        return true;
    }

    /*
    ==========================================================================
    Loader and Application Resolution
    ==========================================================================
    */

    function getLoader() {
        return (
            window.SpeciedexTerminalLoader ||
            null
        );
    }

    function getApplication() {
        return (
            window.SpeciedexTerminalApp ||
            null
        );
    }

    async function requireLoader() {
        const loader =
            getLoader();

        if (
            !loader ||
            typeof loader.load !==
                "function"
        ) {
            throw new Error(
                "SpeciedexTerminalLoader is unavailable. " +
                "Load /static/js/terminal-loader.js before " +
                "/static/js/terminal.js."
            );
        }

        return loader;
    }

    function waitForApplication(
        timeout =
            15000
    ) {
        const existing =
            getApplication();

        if (existing) {
            return Promise.resolve(
                existing
            );
        }

        return new Promise(
            (
                resolve,
                reject
            ) => {
                let timer =
                    0;

                const cleanup =
                    () => {
                        document.removeEventListener(
                            "speciedex:terminal-application-available",
                            onAvailable
                        );

                        window.clearTimeout(
                            timer
                        );
                    };

                const onAvailable =
                    event => {
                        const application =
                            event.detail?.
                                application ||
                            getApplication();

                        if (!application) {
                            return;
                        }

                        cleanup();
                        resolve(
                            application
                        );
                    };

                document.addEventListener(
                    "speciedex:terminal-application-available",
                    onAvailable
                );

                timer =
                    window.setTimeout(
                        () => {
                            cleanup();

                            reject(
                                new Error(
                                    "Timed out waiting for SpeciedexTerminalApp."
                                )
                            );
                        },
                        timeout
                    );
            }
        );
    }

    async function flushPendingRegistrations(
        application
    ) {
        for (
            const definition of
            pendingCommands.values()
        ) {
            application.registerCommand?.(
                definition
            );
        }

        pendingCommands.clear();

        for (
            const plugin of
            pendingPlugins.splice(
                0
            )
        ) {
            application.use?.(
                plugin
            );
        }

        return application;
    }

    async function requireApplication() {
        if (
            applicationPromise
        ) {
            return applicationPromise;
        }

        applicationPromise =
            (
                async () => {
                    const loader =
                        await requireLoader();

                    await loader.load();

                    const application =
                        getApplication() ||
                        await waitForApplication();

                    if (
                        !application ||
                        (
                            typeof application.create !==
                                "function" &&
                            typeof application.mount !==
                                "function" &&
                            typeof application.initialize !==
                                "function"
                        )
                    ) {
                        throw new Error(
                            "SpeciedexTerminalApp is unavailable after module loading. " +
                            "Verify /static/js/terminal/speciedex-terminal.js " +
                            "and the loader manifest."
                        );
                    }

                    await flushPendingRegistrations(
                        application
                    );

                    return application;
                }
            )().catch(
                error => {
                    applicationPromise =
                        null;

                    throw error;
                }
            );

        return applicationPromise;
    }

    /*
    ==========================================================================
    Early Command Guard
    ==========================================================================
    */

    async function executeFromRoot(
        root,
        command
    ) {
        const value =
            String(
                command ||
                ""
            ).trim();

        if (!value) {
            return null;
        }

        hardenRoot(
            root
        );

        const application =
            await requireApplication();

        let instance =
            application.getInstance?.(
                root
            ) ||
            null;

        if (!instance) {
            const createApplication =
                application.create ||
                application.mount ||
                application.initialize;

            instance =
                await createApplication.call(
                    application,
                    root,
                    {}
                );
        }

        if (
            !instance ||
            typeof instance.execute !==
                "function"
        ) {
            throw new Error(
                "The terminal instance cannot execute commands."
            );
        }

        return instance.execute(
            value
        );
    }

    function installCommandGuard() {
        if (
            commandGuardInstalled ||
            document[
                GUARD_SYMBOL
            ]
        ) {
            commandGuardInstalled =
                true;

            return false;
        }

        commandGuardInstalled =
            true;

        document[
            GUARD_SYMBOL
        ] =
            true;

        document.addEventListener(
            "submit",
            event => {
                const form =
                    event.target?.closest?.(
                        FORM_SELECTOR
                    );

                const root =
                    findTerminalRoot(
                        form
                    );

                if (
                    !form ||
                    !root
                ) {
                    return;
                }

                event.preventDefault();
                event.stopPropagation();

                const input =
                    form.querySelector(
                        INPUT_SELECTOR
                    ) ||
                    getInput(
                        root
                    );

                void executeFromRoot(
                    root,
                    input?.value ||
                    ""
                ).catch(
                    error => {
                        console.error(
                            "[SpeciedexTerminal] Guarded command execution failed:",
                            error
                        );

                        emit(
                            "speciedex:terminal-facade-error",
                            {
                                phase:
                                    "command-submit",

                                root,

                                error
                            }
                        );
                    }
                );
            },
            {
                capture:
                    true
            }
        );

        document.addEventListener(
            "click",
            event => {
                const control =
                    event.target?.closest?.(
                        COMMAND_CONTROL_SELECTOR
                    );

                const root =
                    findTerminalRoot(
                        control
                    );

                if (
                    !control ||
                    !root
                ) {
                    return;
                }

                hardenRoot(
                    root
                );

                if (
                    control.tagName ===
                        "A" ||
                    control.hasAttribute(
                        "data-terminal-submit"
                    )
                ) {
                    event.preventDefault();
                }

                if (
                    control.hasAttribute(
                        "data-terminal-submit"
                    )
                ) {
                    event.stopPropagation();

                    const form =
                        control.closest(
                            FORM_SELECTOR
                        );

                    const input =
                        form?.querySelector(
                            INPUT_SELECTOR
                        ) ||
                        getInput(
                            root
                        );

                    void executeFromRoot(
                        root,
                        input?.value ||
                        ""
                    ).catch(
                        error => {
                            console.error(
                                "[SpeciedexTerminal] Guarded submit control failed:",
                                error
                            );
                        }
                    );

                    return;
                }

                const command =
                    String(
                        control.dataset.
                            terminalCommand ||
                        ""
                    ).trim();

                if (
                    command &&
                    control.tagName ===
                        "A"
                ) {
                    event.stopPropagation();

                    void executeFromRoot(
                        root,
                        command
                    ).catch(
                        error => {
                            console.error(
                                "[SpeciedexTerminal] Guarded command control failed:",
                                error
                            );
                        }
                    );
                }
            },
            {
                capture:
                    true
            }
        );

        document.addEventListener(
            "keydown",
            event => {
                const control =
                    event.target?.closest?.(
                        COMMAND_CONTROL_SELECTOR
                    );

                const root =
                    findTerminalRoot(
                        control
                    );

                if (
                    !control ||
                    !root ||
                    ![
                        "Enter",
                        " "
                    ].includes(
                        event.key
                    ) ||
                    control.tagName !==
                        "A"
                ) {
                    return;
                }

                event.preventDefault();

                control.click();
            },
            {
                capture:
                    true
            }
        );

        if (
            typeof MutationObserver ===
                "function"
        ) {
            const observer =
                new MutationObserver(
                    records => {
                        for (
                            const record of
                            records
                        ) {
                            for (
                                const node of
                                record.addedNodes
                            ) {
                                if (
                                    !isElement(
                                        node
                                    )
                                ) {
                                    continue;
                                }

                                const root =
                                    findTerminalRoot(
                                        node
                                    );

                                if (root) {
                                    hardenRoot(
                                        root
                                    );
                                }

                                for (
                                    const nestedRoot of
                                    node.querySelectorAll?.(
                                        DEFAULT_SELECTOR
                                    ) ||
                                    []
                                ) {
                                    hardenRoot(
                                        nestedRoot
                                    );
                                }
                            }
                        }
                    }
                );

            observer.observe(
                document.documentElement,
                {
                    childList:
                        true,
                    subtree:
                        true
                }
            );

            document[
                FACADE_SYMBOL
            ] = {
                observer
            };
        }

        for (
            const root of
            collectRoots(
                document
            )
        ) {
            hardenRoot(
                root
            );
        }

        return true;
    }

    /*
    ==========================================================================
    Lifecycle Delegates
    ==========================================================================
    */

    async function create(
        root,
        options =
            {}
    ) {
        if (
            !isElement(
                root
            )
        ) {
            throw new TypeError(
                "SpeciedexTerminal.create() requires a valid root Element."
            );
        }

        hardenRoot(
            root
        );

        const application =
            await requireApplication();

        const createApplication =
            application.create ||
            application.mount ||
            application.initialize;

        const instance =
            await createApplication.call(
                application,
                root,
                options
            );

        emit(
            "speciedex:terminal-facade-created",
            {
                root,
                instance,
                application,
                productLabel:
                    PRODUCT_LABEL
            }
        );

        return instance;
    }

    async function mount(
        root,
        options =
            {}
    ) {
        return create(
            root,
            options
        );
    }

    async function initialize(
        root,
        options =
            {}
    ) {
        return create(
            root,
            options
        );
    }

    async function initializeAll(
        context =
            document,
        options =
            {}
    ) {
        const normalizedContext =
            normalizeContext(
                context
            );

        for (
            const root of
            collectRoots(
                normalizedContext
            )
        ) {
            hardenRoot(
                root
            );
        }

        const application =
            await requireApplication();

        let instances;

        if (
            typeof application.initializeAll ===
                "function"
        ) {
            instances =
                await application.initializeAll(
                    normalizedContext,
                    options
                );
        } else {
            instances =
                [];

            for (
                const root of
                collectRoots(
                    normalizedContext
                )
            ) {
                instances.push(
                    await create(
                        root,
                        options
                    )
                );
            }
        }

        emit(
            "speciedex:terminal-facade-initialized",
            {
                context:
                    normalizedContext,

                instances,

                application,

                productLabel:
                    PRODUCT_LABEL
            }
        );

        return instances;
    }

    async function bootstrap(
        context =
            document,
        options =
            {}
    ) {
        if (
            bootstrapPromise
        ) {
            return bootstrapPromise;
        }

        bootstrapPromise =
            (
                async () => {
                    const normalizedContext =
                        normalizeContext(
                            context
                        );

                    for (
                        const root of
                        collectRoots(
                            normalizedContext
                        )
                    ) {
                        hardenRoot(
                            root
                        );
                    }

                    const bootstrapper =
                        window.SpeciedexTerminalBootstrap;

                    if (
                        bootstrapper &&
                        typeof bootstrapper.initialize ===
                            "function"
                    ) {
                        return bootstrapper.initialize(
                            normalizedContext,
                            options
                        );
                    }

                    return initializeAll(
                        normalizedContext,
                        options
                    );
                }
            )();

        try {
            return await bootstrapPromise;
        } catch (error) {
            emit(
                "speciedex:terminal-facade-error",
                {
                    phase:
                        "bootstrap",

                    error
                }
            );

            throw error;
        } finally {
            bootstrapPromise =
                null;
        }
    }

    /*
    ==========================================================================
    Application Delegates
    ==========================================================================
    */

    function use(plugin) {
        if (!plugin) {
            throw new TypeError(
                "A terminal plugin is required."
            );
        }

        const application =
            getApplication();

        if (
            application &&
            typeof application.use ===
                "function"
        ) {
            return application.use(
                plugin
            );
        }

        pendingPlugins.push(
            plugin
        );

        void requireApplication().catch(
            error => {
                console.error(
                    "[SpeciedexTerminal] Deferred plugin registration failed:",
                    error
                );
            }
        );

        return () => {
            const index =
                pendingPlugins.indexOf(
                    plugin
                );

            if (
                index < 0
            ) {
                return false;
            }

            pendingPlugins.splice(
                index,
                1
            );

            return true;
        };
    }

    function getInstances() {
        const application =
            getApplication();

        if (
            !application ||
            typeof application.getInstances !==
                "function"
        ) {
            return [];
        }

        return application.getInstances();
    }

    function getInstance(root) {
        if (
            !isElement(
                root
            )
        ) {
            return null;
        }

        const application =
            getApplication();

        if (
            application &&
            typeof application.getInstance ===
                "function"
        ) {
            return (
                application.getInstance(
                    root
                ) ||
                null
            );
        }

        return (
            getInstances().find(
                instance =>
                    instance?.root ===
                    root
            ) ||
            null
        );
    }

    function getCommands() {
        const commands =
            new Map();

        for (
            const instance of
            getInstances()
        ) {
            const registry =
                instance?.
                    commandRegistry;

            if (!registry) {
                continue;
            }

            const definitions =
                typeof registry.list ===
                    "function"
                    ? registry.list({
                        includeHidden:
                            true
                    })
                    : registry.commands instanceof
                        Map
                        ? [
                            ...registry.commands.
                                values()
                        ]
                        : [];

            for (
                const definition of
                definitions
            ) {
                if (
                    definition?.
                        name
                ) {
                    commands.set(
                        definition.name,
                        definition
                    );
                }
            }
        }

        return [
            ...commands.values()
        ];
    }

    function execute(
        root,
        command
    ) {
        if (
            !isElement(
                root
            )
        ) {
            throw new TypeError(
                "SpeciedexTerminal.execute() requires a terminal root Element."
            );
        }

        return executeFromRoot(
            root,
            command
        );
    }

    /*
    ==========================================================================
    Compatibility Registration
    ==========================================================================
    */

    function registerCommand(definition) {
        const application =
            getApplication();

        if (
            application &&
            typeof application.registerCommand ===
                "function"
        ) {
            return application.registerCommand(
                definition
            );
        }

        if (
            !definition ||
            typeof definition !==
                "object"
        ) {
            throw new TypeError(
                "A command definition object is required."
            );
        }

        const name =
            normalizeCommandName(
                definition.name
            );

        if (!name) {
            throw new Error(
                "A command name is required."
            );
        }

        pendingCommands.set(
            name,
            definition
        );

        void requireApplication().catch(
            error => {
                console.error(
                    "[SpeciedexTerminal] Deferred command registration failed:",
                    error
                );
            }
        );

        return definition;
    }

    function unregisterCommand(name) {
        const normalized =
            normalizeCommandName(
                name
            );

        const application =
            getApplication();

        if (
            application &&
            typeof application.unregisterCommand ===
                "function"
        ) {
            return application.unregisterCommand(
                normalized
            );
        }

        return pendingCommands.delete(
            normalized
        );
    }

    /*
    ==========================================================================
    Diagnostics
    ==========================================================================
    */

    function isReady() {
        const application =
            getApplication();

        return Boolean(
            application &&
            typeof application.getInstances ===
                "function" &&
            application.getInstances().some(
                instance =>
                    instance?.
                        mounted ===
                    true
            )
        );
    }

    function ready() {
        return requireApplication();
    }

    function status() {
        const loader =
            getLoader();

        const application =
            getApplication();

        const instances =
            getInstances();

        return {
            facade:
                true,

            version:
                VERSION,

            releaseChannel:
                RELEASE_CHANNEL,

            productLabel:
                PRODUCT_LABEL,

            selector:
                DEFAULT_SELECTOR,

            commandGuard:
                commandGuardInstalled,

            loader:
                loader
                    ? {
                        available:
                            true,

                        state:
                            loader.state ||
                            "unknown",

                        loadedModules:
                            loader.loadedModules?.
                                length ||
                            0,

                        failedModules:
                            loader.failedModules?.
                                length ||
                            loader.failures?.
                                length ||
                            0
                    }
                    : {
                        available:
                            false
                    },

            application:
                application
                    ? {
                        available:
                            true,

                        version:
                            application.VERSION ||
                            null,

                        releaseChannel:
                            application.RELEASE_CHANNEL ||
                            null,

                        productLabel:
                            application.PRODUCT_LABEL ||
                            null
                    }
                    : {
                        available:
                            false
                    },

            instances:
                instances.length,

            pendingCommands:
                pendingCommands.size,

            pendingPlugins:
                pendingPlugins.length,

            commands:
                getCommands()
                    .map(
                        command =>
                            command.name
                    )
                    .sort()
        };
    }

    function diagnostics() {
        const application =
            getApplication();

        return {
            ...status(),

            ready:
                isReady(),

            pendingCommandNames:
                [
                    ...pendingCommands.keys()
                ].sort(),

            loaderSnapshot:
                getLoader()?.snapshot?.() ||
                null,

            applicationDiagnostics:
                application?.
                    getInstances?.()
                    ?.map(
                        instance =>
                            instance.diagnostics?.() ||
                            instance.status?.() ||
                            null
                    ) ||
                []
        };
    }

    /*
    ==========================================================================
    Public API
    ==========================================================================
    */

    installCommandGuard();

    const api =
        Object.freeze({
            VERSION,
            RELEASE_CHANNEL,
            PRODUCT_LABEL,
            DEFAULT_SELECTOR,
            FORM_SELECTOR,
            INPUT_SELECTOR,
            COMMAND_CONTROL_SELECTOR,

            create,
            mount,
            initialize,
            initializeAll,
            bootstrap,
            execute,

            use,

            getInstances,
            getInstance,
            getCommands,

            registerCommand,
            unregisterCommand,

            hardenRoot,
            installCommandGuard,
            collectRoots,

            status,
            diagnostics,
            ready,
            isReady,

            get loader() {
                return getLoader();
            },

            get app() {
                return getApplication();
            },

            get Application() {
                return (
                    getApplication()?.
                        Application ||
                    null
                );
            }
        });

    window[
        GLOBAL_NAME
    ] =
        api;

    emit(
        "speciedex:terminal-facade-available",
        {
            terminal:
                api,

            version:
                VERSION,

            releaseChannel:
                RELEASE_CHANNEL,

            productLabel:
                PRODUCT_LABEL
        }
    );
})(window, document);
