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
        "2.2.0";

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
        const loader =
            await requireLoader();

        await loader.load();

        const application =
            getApplication();

        if (
            !application ||
            typeof application.initializeAll !==
            "function" ||
            typeof application.create !==
            "function"
        ) {
            throw new Error(
                "SpeciedexTerminalApp is unavailable after module loading. " +
                "Verify that /static/js/terminal/speciedex-terminal.js " +
                "is present in manifest.json and loaded successfully."
            );
        }

        return application;
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

        const instance =
            await application.create(
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

        const instances =
            await application.initializeAll(
                normalizedContext,
                options
            );

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
            !application ||
            typeof application.use !==
            "function"
        ) {
            throw new Error(
                "SpeciedexTerminalApp is not loaded yet."
            );
        }

        return application.use(
            plugin
        );
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

            if (
                !registry ||
                typeof registry.values !==
                "function"
            ) {
                continue;
            }

            for (
                const definition of
                registry.values()
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

        throw new Error(
            "Commands must be exported by modular files under " +
            "/static/js/terminal/ or registered after " +
            "SpeciedexTerminalApp has loaded."
        );
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

        return false;
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
            typeof application.getInstances === "function"
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
