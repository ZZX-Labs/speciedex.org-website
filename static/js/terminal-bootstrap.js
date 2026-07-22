/*
========================================================================
Speciedex.org
SpeciedexTerminal Bootstrap
========================================================================

Coordinates terminal startup after the site partial loader inserts terminal
markup into the document.

Responsibilities:

    • Wait for the modular terminal loader
    • Resolve SpeciedexTerminalApp
    • Initialize terminals already present in the document
    • Initialize terminals inserted later by the include system
    • Observe dynamically added terminal roots
    • Prevent duplicate initialization
    • Update mounted terminals when network state changes
    • Expose an idempotent public bootstrap API

Dependency order:

    /static/js/terminal-loader.js
        |
        v
    /static/js/terminal.js
        |
        v
    /static/js/terminal-bootstrap.js
        |
        v
    /static/js/terminal/speciedex-terminal.js

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const BOOTSTRAP_NAME =
        "SpeciedexTerminalBootstrap";

    const VERSION =
        "2.0.0";

    const TERMINAL_SELECTOR =
        "[data-speciedex-terminal], [data-terminal]";

    const INCLUDE_EVENTS =
        Object.freeze([
            "speciedex:include-loaded",
            "speciedex:includes-ready",
            "site:include-loaded",
            "site:includes-ready"
        ]);

    /*
    ==========================================================================
    Internal State
    ==========================================================================
    */

    let started =
        false;

    let startPromise =
        null;

    let observer =
        null;

    let initializationFrame =
        0;

    let bound =
        false;

    const pendingContexts =
        new Set();

    const initializedRoots =
        new WeakSet();

    const failedRoots =
        new WeakMap();

    /*
    ==========================================================================
    Utilities
    ==========================================================================
    */

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

    function isNode(value) {
        return (
            value instanceof
            Node
        );
    }

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

        return document;
    }

    function containsTerminal(
        context
    ) {
        if (!isNode(context)) {
            return false;
        }

        if (
            isElement(context) &&
            context.matches(
                TERMINAL_SELECTOR
            )
        ) {
            return true;
        }

        return (
            typeof context.querySelector ===
                "function" &&
            Boolean(
                context.querySelector(
                    TERMINAL_SELECTOR
                )
            )
        );
    }

    function findTerminals(
        context = document
    ) {
        const normalizedContext =
            normalizeContext(
                context
            );

        const roots =
            [];

        if (
            isElement(
                normalizedContext
            ) &&
            normalizedContext.matches(
                TERMINAL_SELECTOR
            )
        ) {
            roots.push(
                normalizedContext
            );
        }

        if (
            typeof normalizedContext.querySelectorAll ===
            "function"
        ) {
            roots.push(
                ...normalizedContext.querySelectorAll(
                    TERMINAL_SELECTOR
                )
            );
        }

        return [
            ...new Set(
                roots
            )
        ];
    }

    function getLoader() {
        return (
            window.SpeciedexTerminalLoader ||
            null
        );
    }

    function getFacade() {
        return (
            window.SpeciedexTerminal ||
            null
        );
    }

    function getApplication() {
        return (
            window.SpeciedexTerminalApp ||
            null
        );
    }

    /*
    ==========================================================================
    Root State
    ==========================================================================
    */

    function setRootState(
        root,
        state,
        message = ""
    ) {
        if (!isElement(root)) {
            return;
        }

        root.dataset.terminalState =
            state;

        const status =
            root.querySelector(
                "[data-terminal-status]"
            );

        const indicator =
            root.querySelector(
                "[data-terminal-status-indicator]"
            );

        if (status) {
            status.dataset.state =
                state;

            if (message) {
                status.textContent =
                    message;
            }
        }

        if (indicator) {
            indicator.dataset.state =
                state;
        }
    }

    function setPendingState(
        roots
    ) {
        for (const root of roots) {
            if (
                root.dataset.terminalReady ===
                "true"
            ) {
                continue;
            }

            setRootState(
                root,
                "loading",
                "Loading modules"
            );
        }
    }

    function setErrorState(
        root,
        error
    ) {
        const message =
            error instanceof Error
                ? error.message
                : String(error);

        root.dataset.terminalReady =
            "error";

        root.dataset.terminalError =
            message;

        failedRoots.set(
            root,
            error
        );

        setRootState(
            root,
            "error",
            "Initialization failed"
        );
    }

    /*
    ==========================================================================
    Dependency Resolution
    ==========================================================================
    */

    async function prepareDependencies(
        options = {}
    ) {
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
                "/static/js/terminal-bootstrap.js."
            );
        }

        const result =
            await loader.load(
                options.loader ||
                {}
            );

        emit(
            "speciedex:terminal-dependencies-ready",
            {
                loader,
                result
            }
        );

        return result;
    }

    async function requireApplication(
        options = {}
    ) {
        await prepareDependencies(
            options
        );

        const application =
            getApplication();

        if (
            application &&
            typeof application.initializeAll ===
                "function" &&
            typeof application.create ===
                "function"
        ) {
            return application;
        }

        const facade =
            getFacade();

        if (
            facade &&
            facade.app &&
            typeof facade.app.initializeAll ===
                "function"
        ) {
            return facade.app;
        }

        throw new Error(
            "SpeciedexTerminalApp is unavailable after dependency loading. " +
            "Verify that terminal/speciedex-terminal.js is present in the " +
            "terminal manifest and loaded without errors."
        );
    }

    /*
    ==========================================================================
    Initialization
    ==========================================================================
    */

    async function initializeRoot(
        application,
        root,
        options = {}
    ) {
        if (!isElement(root)) {
            return null;
        }

        if (
            initializedRoots.has(
                root
            ) ||
            root.dataset.terminalReady ===
                "true"
        ) {
            return (
                application.getInstance?.(
                    root
                ) ||
                getFacade()?.getInstance?.(
                    root
                ) ||
                null
            );
        }

        try {
            setRootState(
                root,
                "initializing",
                "Initializing"
            );

            const instance =
                await application.create(
                    root,
                    options.application ||
                    {}
                );

            if (!instance) {
                throw new Error(
                    "SpeciedexTerminalApp.create() returned no terminal instance."
                );
            }

            initializedRoots.add(
                root
            );

            failedRoots.delete(
                root
            );

            root.dataset.terminalReady =
                "true";

            delete root.dataset.terminalError;

            setRootState(
                root,
                "ready",
                "Ready"
            );

            emit(
                "speciedex:terminal-initialized",
                {
                    root,
                    instance,
                    application
                }
            );

            return instance;
        } catch (error) {
            setErrorState(
                root,
                error
            );

            emit(
                "speciedex:terminal-initialization-error",
                {
                    root,
                    error,
                    application
                }
            );

            throw error;
        }
    }

    async function initialize(
        context = document,
        options = {}
    ) {
        const normalizedContext =
            normalizeContext(
                context
            );

        const roots =
            findTerminals(
                normalizedContext
            );

        if (!roots.length) {
            return [];
        }

        setPendingState(
            roots
        );

        const application =
            await requireApplication(
                options
            );

        const instances =
            [];

        const failures =
            [];

        for (const root of roots) {
            try {
                const instance =
                    await initializeRoot(
                        application,
                        root,
                        options
                    );

                if (instance) {
                    instances.push(
                        instance
                    );
                }
            } catch (error) {
                failures.push({
                    root,
                    error
                });

                if (
                    options.continueOnError ===
                    false
                ) {
                    throw error;
                }
            }
        }

        emit(
            "speciedex:terminals-initialized",
            {
                context:
                    normalizedContext,
                roots,
                instances,
                failures,
                application
            }
        );

        return instances;
    }

    /*
    ==========================================================================
    Queued Initialization
    ==========================================================================
    */

    function queueInitialize(
        context = document,
        options = {}
    ) {
        const normalizedContext =
            normalizeContext(
                context
            );

        pendingContexts.add(
            normalizedContext
        );

        if (initializationFrame) {
            return;
        }

        initializationFrame =
            window.requestAnimationFrame(
                async () => {
                    initializationFrame =
                        0;

                    const contexts =
                        [
                            ...pendingContexts
                        ];

                    pendingContexts.clear();

                    for (
                        const current of
                        contexts
                    ) {
                        if (
                            current !== document &&
                            !containsTerminal(
                                current
                            )
                        ) {
                            continue;
                        }

                        try {
                            await initialize(
                                current,
                                options
                            );
                        } catch (error) {
                            console.error(
                                "[SpeciedexTerminalBootstrap] " +
                                "Queued initialization failed:",
                                error
                            );

                            emit(
                                "speciedex:terminal-bootstrap-error",
                                {
                                    context:
                                        current,
                                    error
                                }
                            );
                        }
                    }
                }
            );
    }

    /*
    ==========================================================================
    Include Loader Integration
    ==========================================================================
    */

    function handleIncludeEvent(
        event
    ) {
        const context =
            event.detail?.element ||
            event.detail?.target ||
            event.detail?.container ||
            event.target ||
            document;

        queueInitialize(
            isNode(context)
                ? context
                : document
        );
    }

    /*
    ==========================================================================
    Dynamic Terminal Observation
    ==========================================================================
    */

    function observeDynamicTerminals() {
        if (
            observer ||
            !document.documentElement
        ) {
            return;
        }

        observer =
            new MutationObserver(
                mutations => {
                    for (
                        const mutation of
                        mutations
                    ) {
                        for (
                            const node of
                            mutation.addedNodes
                        ) {
                            if (
                                !isNode(node)
                            ) {
                                continue;
                            }

                            if (
                                containsTerminal(
                                    node
                                )
                            ) {
                                queueInitialize(
                                    node
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
    }

    /*
    ==========================================================================
    Network Lifecycle
    ==========================================================================
    */

    function getInstances() {
        const application =
            getApplication();

        if (
            application &&
            typeof application.getInstances ===
                "function"
        ) {
            return application.getInstances();
        }

        const facade =
            getFacade();

        if (
            facade &&
            typeof facade.getInstances ===
                "function"
        ) {
            return facade.getInstances();
        }

        return [];
    }

    function updateNetworkState(
        online
    ) {
        const state =
            online
                ? "ready"
                : "warning";

        const message =
            online
                ? "Online"
                : "Offline";

        for (
            const terminal of
            getInstances()
        ) {
            try {
                terminal.updateFooter?.();
                terminal.setStatus?.(
                    message,
                    state
                );

                if (
                    terminal.root instanceof
                    Element
                ) {
                    const networkStatus =
                        terminal.root.querySelector(
                            "[data-terminal-network-status]"
                        );

                    if (networkStatus) {
                        networkStatus.textContent =
                            online
                                ? "Network: online"
                                : "Network: offline";
                    }
                }
            } catch (error) {
                console.warn(
                    "[SpeciedexTerminalBootstrap] " +
                    "Unable to update terminal network state:",
                    error
                );
            }
        }

        emit(
            "speciedex:terminal-network-state",
            {
                online,
                state,
                instances:
                    getInstances()
            }
        );
    }

    function handleOnline() {
        updateNetworkState(
            true
        );
    }

    function handleOffline() {
        updateNetworkState(
            false
        );
    }

    /*
    ==========================================================================
    Lifecycle Binding
    ==========================================================================
    */

    function bindLifecycleEvents() {
        if (bound) {
            return;
        }

        bound =
            true;

        for (
            const eventName of
            INCLUDE_EVENTS
        ) {
            document.addEventListener(
                eventName,
                handleIncludeEvent
            );
        }

        window.addEventListener(
            "online",
            handleOnline
        );

        window.addEventListener(
            "offline",
            handleOffline
        );
    }

    function unbindLifecycleEvents() {
        if (!bound) {
            return;
        }

        bound =
            false;

        for (
            const eventName of
            INCLUDE_EVENTS
        ) {
            document.removeEventListener(
                eventName,
                handleIncludeEvent
            );
        }

        window.removeEventListener(
            "online",
            handleOnline
        );

        window.removeEventListener(
            "offline",
            handleOffline
        );
    }

    /*
    ==========================================================================
    Start / Stop
    ==========================================================================
    */

    async function start(
        options = {}
    ) {
        if (
            started &&
            startPromise
        ) {
            return startPromise;
        }

        if (started) {
            return getInstances();
        }

        started =
            true;

        bindLifecycleEvents();
        observeDynamicTerminals();

        startPromise =
            initialize(
                document,
                options
            )
                .then(
                    instances => {
                        updateNetworkState(
                            navigator.onLine
                        );

                        emit(
                            "speciedex:terminal-bootstrap-ready",
                            {
                                bootstrap:
                                    window[
                                        BOOTSTRAP_NAME
                                    ],

                                instances
                            }
                        );

                        return instances;
                    }
                )
                .catch(
                    error => {
                        started =
                            false;

                        startPromise =
                            null;

                        emit(
                            "speciedex:terminal-bootstrap-error",
                            {
                                context:
                                    document,

                                error
                            }
                        );

                        throw error;
                    }
                );

        return startPromise;
    }

    function stop(
        options = {}
    ) {
        observer?.disconnect();

        observer =
            null;

        unbindLifecycleEvents();

        if (
            initializationFrame
        ) {
            window.cancelAnimationFrame(
                initializationFrame
            );

            initializationFrame =
                0;
        }

        pendingContexts.clear();

        if (
            options.destroyInstances ===
            true
        ) {
            for (
                const instance of
                getInstances()
            ) {
                try {
                    instance.destroy?.();
                } catch (error) {
                    console.warn(
                        "[SpeciedexTerminalBootstrap] " +
                        "Unable to destroy terminal instance:",
                        error
                    );
                }
            }
        }

        started =
            false;

        startPromise =
            null;

        emit(
            "speciedex:terminal-bootstrap-stopped",
            {
                destroyInstances:
                    options.destroyInstances ===
                    true
            }
        );
    }

    /*
    ==========================================================================
    Diagnostics
    ==========================================================================
    */

    function status() {
        return {
            version:
                VERSION,

            started,

            bound,

            observing:
                Boolean(
                    observer
                ),

            queuedContexts:
                pendingContexts.size,

            loader:
                getLoader()?.state ||
                "unavailable",

            application:
                Boolean(
                    getApplication()
                ),

            instances:
                getInstances().length,

            failedRoots:
                findTerminals(
                    document
                ).filter(
                    root =>
                        failedRoots.has(
                            root
                        )
                ).length
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
            TERMINAL_SELECTOR,
            INCLUDE_EVENTS,

            start,
            stop,
            initialize,
            initializeRoot,
            queueInitialize,
            findTerminals,
            containsTerminal,
            prepareDependencies,
            status,

            get started() {
                return started;
            },

            get observer() {
                return observer;
            },

            get instances() {
                return getInstances();
            }
        });

    window[BOOTSTRAP_NAME] =
        api;

    emit(
        "speciedex:terminal-bootstrap-available",
        {
            bootstrap:
                api,

            version:
                VERSION
        }
    );

    /*
    ==========================================================================
    Automatic Startup
    ==========================================================================
    */

    function autoStart() {
        start().catch(
            error => {
                console.error(
                    "[SpeciedexTerminalBootstrap] Start failed:",
                    error
                );
            }
        );
    }

    if (
        document.readyState ===
        "loading"
    ) {
        document.addEventListener(
            "DOMContentLoaded",
            autoStart,
            {
                once:
                    true
            }
        );
    } else {
        autoStart();
    }
})(window, document);
