/*
========================================================================
Speciedex.org
SpeciedexTerminal Public Facade
========================================================================

This file intentionally does not implement an independent terminal runtime.

It delegates all terminal lifecycle operations to:

    /static/js/terminal/speciedex-terminal.js
    window.SpeciedexTerminalApp

This prevents the legacy monolithic terminal core from mounting first and
blocking modular command registration, search initialization, visualization
registration, and the live terminal splash.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const GLOBAL_NAME =
        "SpeciedexTerminal";

    const VERSION =
        "2.3.0";

    const DEFAULT_SELECTOR =
        "[data-speciedex-terminal], [data-terminal]";

    let applicationPromise = null;

    const pendingCommands = new Map();
    const pendingPlugins = [];

    /*
    ==========================================================================
    Utilities
    ==========================================================================
    */

    function isElement(value) {
        return (
            value instanceof
            Element
        );
    }

    function normalizeContext(
        context
    ) {
        if (
            context === undefined ||
            context === null
        ) {
            return document;
        }

        if (
            context === document ||
            context instanceof
            Document ||
            context instanceof
            DocumentFragment ||
            isElement(context)
        ) {
            return context;
        }

        throw new TypeError(
            "SpeciedexTerminal context must be a Document, " +
            "DocumentFragment, or Element."
        );
    }

    function emit(
        name,
        detail = {}
    ) {
        document.dispatchEvent(
            new CustomEvent(
                name,
                {
                    detail
                }
            )
        );
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

    async function requireApplication() {
        if (applicationPromise) {
            return applicationPromise;
        }

        applicationPromise = (async () => {
            const loader =
                await requireLoader();

            await loader.load();

            let application =
                getApplication();

            if (!application) {
                application =
                    await new Promise(
                        (
                            resolve,
                            reject
                        ) => {
                            let timer = 0;

                            const cleanup = () => {
                                document.removeEventListener(
                                    "speciedex:terminal-application-available",
                                    onAvailable
                                );

                                window.clearTimeout(
                                    timer
                                );
                            };

                            const onAvailable = event => {
                                const candidate =
                                    event.detail?.application ||
                                    getApplication();

                                if (!candidate) {
                                    return;
                                }

                                cleanup();
                                resolve(candidate);
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
                                    10000
                                );
                        }
                    );
            }

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
                    "Verify that /static/js/terminal/speciedex-terminal.js " +
                    "is present in manifest.json and loaded successfully."
                );
            }

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
        })().catch(error => {
            applicationPromise =
                null;

            throw error;
        });

        return applicationPromise;
    }

    /*
    ==========================================================================
    Lifecycle Delegates
    ==========================================================================
    */

    async function create(
        root,
        options = {}
    ) {
        if (!isElement(root)) {
            throw new TypeError(
                "SpeciedexTerminal.create() requires a valid root Element."
            );
        }

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
                application
            }
        );

        return instance;
    }

    async function mount(
        root,
        options = {}
    ) {
        return create(
            root,
            options
        );
    }

    async function initialize(
        root,
        options = {}
    ) {
        return create(
            root,
            options
        );
    }

    async function initializeAll(
        context = document,
        options = {}
    ) {
        const normalizedContext =
            normalizeContext(
                context
            );

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
            const roots = [];

            if (
                isElement(normalizedContext) &&
                normalizedContext.matches(
                    DEFAULT_SELECTOR
                )
            ) {
                roots.push(
                    normalizedContext
                );
            }

            roots.push(
                ...normalizedContext.querySelectorAll?.(
                    DEFAULT_SELECTOR
                ) ||
                []
            );

            instances = [];

            for (const root of new Set(roots)) {
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
                application
            }
        );

        return instances;
    }

    async function bootstrap(
        context = document,
        options = {}
    ) {
        const bootstrapper =
            window.SpeciedexTerminalBootstrap;

        if (
            bootstrapper &&
            typeof bootstrapper.initialize ===
            "function"
        ) {
            return bootstrapper.initialize(
                normalizeContext(context),
                options
            );
        }

        return initializeAll(
            context,
            options
        );
    }

    /*
    ==========================================================================
    Application Delegates
    ==========================================================================
    */

    function use(plugin) {
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

        requireApplication().catch(
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

            if (index >= 0) {
                pendingPlugins.splice(
                    index,
                    1
                );

                return true;
            }

            return false;
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

    function getInstance(
        root
    ) {
        if (!isElement(root)) {
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
                instance?.commandRegistry;

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
                            ...registry.commands.values()
                        ]
                        : [];

            for (
                const definition of
                definitions
            ) {
                if (
                    definition?.name
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

    /*
    ==========================================================================
    Compatibility Registration
    ==========================================================================
    */

    function registerCommand(
        definition
    ) {
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
            String(
                definition.name ||
                ""
            )
                .trim()
                .toLowerCase();

        if (!name) {
            throw new Error(
                "A command name is required."
            );
        }

        pendingCommands.set(
            name,
            definition
        );

        requireApplication().catch(
            error => {
                console.error(
                    "[SpeciedexTerminal] Deferred command registration failed:",
                    error
                );
            }
        );

        return definition;
    }

    function unregisterCommand(
        name
    ) {
        const application =
            getApplication();

        if (
            application &&
            typeof application.unregisterCommand ===
            "function"
        ) {
            return application.unregisterCommand(
                name
            );
        }

        return pendingCommands.delete(
            String(
                name ||
                ""
            )
                .trim()
                .toLowerCase()
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
                    instance?.mounted ===
                        true
            )
        );
    }

    function ready() {
        return requireApplication();
    }

    function diagnostics() {
        const application =
            getApplication();

        return {
            ...status(),
            ready:
                isReady(),
            pendingCommands:
                [...pendingCommands.keys()].sort(),
            pendingPlugins:
                pendingPlugins.length,
            loaderSnapshot:
                getLoader()?.snapshot?.() ||
                null,
            applicationDiagnostics:
                application?.getInstances?.()
                    ?.map(instance =>
                        instance.diagnostics?.() ||
                        instance.status?.() ||
                        null
                    ) ||
                []
        };
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

            selector:
                DEFAULT_SELECTOR,

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
                            null
                    }
                    : {
                        available:
                            false
                    },

            instances:
                instances.length,

            commands:
                getCommands()
                    .map(
                        command =>
                            command.name
                    )
                    .sort()
        };
    }

    /*
    ==========================================================================
    Public API
    ==========================================================================
    */

    const api =
        Object.freeze({
            VERSION,
            DEFAULT_SELECTOR,

            create,
            mount,
            initialize,
            initializeAll,
            bootstrap,

            use,

            getInstances,
            getInstance,
            getCommands,

            registerCommand,
            unregisterCommand,

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
                    getApplication()?.Application ||
                    null
                );
            }
        });

    window[GLOBAL_NAME] =
        api;

    /*
    ==========================================================================
    Availability Event
    ==========================================================================
    */

    emit(
        "speciedex:terminal-facade-available",
        {
            terminal:
                api,

            version:
                VERSION
        }
    );
})(window, document);
