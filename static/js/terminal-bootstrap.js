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
    /static/js/terminal/terminal-animation.js
        |
        v
    /static/js/terminal/terminal-loading.js
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
        "2.5.0";

    const RELEASE_CHANNEL =
        "System Prototype";

    const PRODUCT_LABEL =
        "SpeciedexTerminal System Prototype 0.0.0a";

    const TERMINAL_SELECTOR =
        "[data-speciedex-terminal], [data-terminal-root], #speciedex-terminal";

    const INCLUDE_EVENTS =
        Object.freeze([
            "speciedex:include-loaded",
            "speciedex:include-loaded-global",
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

    let dependencyPromise =
        null;

    let applicationPromise =
        null;

    const activeEvents =
        new Set();

    const APPLICATION_WAIT_TIMEOUT =
        15000;

    const pendingContexts =
        new Set();

    const initializedRoots =
        new WeakSet();

    const failedRoots =
        new WeakMap();

    const initializingRoots =
        new WeakMap();

    const metrics = {
        starts: 0,
        stops: 0,
        initializeCalls: 0,
        rootsInitialized: 0,
        rootsFailed: 0,
        rootsRemoved: 0,
        dependencyLoads: 0,
        mutationBatches: 0
    };

    /*
    ==========================================================================
    Utilities
    ==========================================================================
    */

    function emit(
        name,
        detail = {}
    ) {
        const eventName=String(name||"");
        if(activeEvents.has(eventName)){
            return false;
        }
        activeEvents.add(eventName);
        try{
            document.dispatchEvent(new CustomEvent(eventName,{detail}));
            return true;
        }finally{
            activeEvents.delete(eventName);
        }
    }

    function isNode(value) {
        return Boolean(
            value &&
            typeof value.nodeType === "number"
        );
    }

    function isElement(value) {
        return Boolean(
            value &&
            value.nodeType === 1 &&
            typeof value.matches === "function"
        );
    }

    function isTerminalRoot(value) {
        return Boolean(
            isElement(
                value
            ) &&
            value.matches(
                TERMINAL_SELECTOR
            )
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
            context?.nodeType === 9 ||
            context?.nodeType === 11 ||
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
            isTerminalRoot(
                context
            )
        ) {
            return true;
        }

        if (
            typeof context.querySelectorAll !==
                "function"
        ) {
            return false;
        }

        return Boolean(
            context.querySelector(
                TERMINAL_SELECTOR
            )
        );
    }

    function findTerminals(
        context = document
    ) {
        metrics.initializeCalls += 1;

        const normalizedContext =
            normalizeContext(
                context
            );

        const candidates =
            [];

        if (
            isTerminalRoot(
                normalizedContext
            )
        ) {
            candidates.push(
                normalizedContext
            );
        }

        if (
            typeof normalizedContext.querySelectorAll ===
                "function"
        ) {
            candidates.push(
                ...normalizedContext.querySelectorAll(
                    TERMINAL_SELECTOR
                )
            );
        }

        const roots =
            [
                ...new Set(
                    candidates
                )
            ].filter(
                isTerminalRoot
            );

        return roots.filter(
            root =>
                !roots.some(
                    candidate =>
                        candidate !==
                            root &&
                        candidate.contains(
                            root
                        )
                )
        );
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
            window.SpeciedexTerminal?.app ||
            null
        );
    }

    function waitForApplication(timeout = APPLICATION_WAIT_TIMEOUT) {
        const existing =
            getApplication();

        if (existing) {
            return Promise.resolve(
                existing
            );
        }

        if (applicationPromise) {
            return applicationPromise;
        }

        applicationPromise =
            new Promise((resolve, reject) => {
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
                    const application =
                        event.detail?.application ||
                        getApplication();

                    if (!application) {
                        return;
                    }

                    cleanup();
                    resolve(application);
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
            }).finally(() => {
                applicationPromise =
                    null;
            });

        return applicationPromise;
    }

    function hardenRoot(
        root
    ) {
        if (!isElement(root)) {
            return false;
        }

        const facade =
            getFacade();

        if (
            facade &&
            typeof facade.hardenRoot ===
                "function"
        ) {
            return facade.hardenRoot(
                root
            );
        }

        for (
            const form of
            root.querySelectorAll(
                "[data-terminal-form]"
            )
        ) {
            form.noValidate =
                true;

            form.onsubmit =
                () =>
                    false;
        }

        for (
            const control of
            root.querySelectorAll(
                "[data-terminal-action], " +
                "[data-terminal-command], " +
                "[data-terminal-submit]"
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
            }
        }

        return true;
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
            `Initialization failed: ${message}`
        );

        root.removeAttribute("aria-busy");

        const output = root.querySelector(
            "[data-terminal-output]"
        );

        if (output) {
            output
                .querySelectorAll(
                    "[data-terminal-bootstrap-error]"
                )
                .forEach(
                    node =>
                        node.remove()
                );

            const entry = document.createElement("div");
            entry.className =
                "terminal-entry terminal-entry-error";
            entry.dataset.terminalBootstrapError =
                "";
            entry.textContent =
                `Initialization failed: ${message}`;
            output.appendChild(entry);
        }
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

        if (!dependencyPromise || options.reload === true) {
            metrics.dependencyLoads += 1;

            dependencyPromise = Promise.resolve(
                loader.load(
                    {
                        ...(options.loader || {}),
                        reload:
                            options.reload === true ||
                            options.loader?.reload === true
                    }
                )
            ).catch(error => {
                dependencyPromise = null;
                throw error;
            });
        }

        const result =
            await dependencyPromise;

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

        let application =
            getApplication();

        if (!application) {
            application =
                await waitForApplication(
                    Number(options.applicationTimeout) ||
                    APPLICATION_WAIT_TIMEOUT
                );
        }

        if (
            application &&
            (
                typeof application.create ===
                    "function" ||
                typeof application.mount ===
                    "function" ||
                typeof application.initialize ===
                    "function"
            )
        ) {
            return application;
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

        hardenRoot(
            root
        );

        let existingInstance =
            application.getInstance?.(
                root
            ) ||
            getFacade()?.getInstance?.(
                root
            ) ||
            null;

        if (
            initializedRoots.has(
                root
            ) &&
            !existingInstance
        ) {
            initializedRoots.delete(
                root
            );
        }

        if (existingInstance) {
            /*
            ------------------------------------------------------------------
            The include system may replace the terminal root's descendants
            without replacing the root itself. In that case the existing
            application instance still points at the old detached form,
            input, output, and controls. Returning it here leaves the visible
            Run button and command input completely unwired.

            Detect detached or replaced hooks and rebuild the instance before
            treating the root as initialized.
            ------------------------------------------------------------------
            */
            const currentOutput =
                root.querySelector(
                    "[data-terminal-output]"
                );

            const currentForm =
                root.querySelector(
                    "[data-terminal-form]"
                );

            const currentInput =
                root.querySelector(
                    "[data-terminal-input]"
                );

            const staleInstance =
                Boolean(
                    existingInstance &&
                    (
                        existingInstance.destroyed ||
                        !existingInstance.elements ||
                        existingInstance.elements.output !==
                            currentOutput ||
                        existingInstance.elements.form !==
                            currentForm ||
                        existingInstance.elements.input !==
                            currentInput ||
                        !currentOutput?.isConnected ||
                        !currentForm?.isConnected ||
                        !currentInput?.isConnected
                    )
                );

            if (!staleInstance) {
                initializedRoots.add(
                    root
                );

                return existingInstance;
            }

            try {
                await existingInstance.destroy?.();
            } catch (error) {
                console.warn(
                    "[SpeciedexTerminalBootstrap] " +
                    "Unable to destroy stale terminal instance:",
                    error
                );
            }

            initializedRoots.delete(
                root
            );

            failedRoots.delete(
                root
            );

            initializingRoots.delete(
                root
            );

            delete root.dataset.terminalReady;
            delete root.dataset.terminalError;

            existingInstance =
                null;
        }

        if (
            root.dataset.terminalReady ===
                "true" &&
            !existingInstance
        ) {
            delete root.dataset.terminalReady;
        }

        const existingInitialization =
            initializingRoots.get(root);

        if (existingInitialization) {
            return existingInitialization;
        }

        const initialization = (async () => {
            try {
                setRootState(
                    root,
                    "initializing",
                    "Initializing"
                );

                hardenRoot(
                    root
                );

                const create =
                    application.create ||
                    application.mount ||
                    application.initialize;

                const instance =
                    await create.call(
                        application,
                        root,
                        options.application ||
                        {}
                    );

                if (!instance) {
                    throw new Error(
                        "SpeciedexTerminalApp returned no terminal instance."
                    );
                }

                root
                    .querySelectorAll(
                        "[data-terminal-bootstrap-error]"
                    )
                    .forEach(
                        node =>
                            node.remove()
                    );

                initializedRoots.add(
                    root
                );

            failedRoots.delete(
                root
            );

            root.dataset.terminalReady =
                "true";

            delete root.dataset.terminalError;

            const applicationState =
                root.dataset.terminalState;

            if (
                ![
                    "degraded",
                    "warning",
                    "error"
                ].includes(
                    applicationState
                )
            ) {
                setRootState(
                    root,
                    "ready",
                    "Ready"
                );
            }

            emit(
                "speciedex:terminal-initialized",
                {
                    root,
                    instance,
                    application,
                    productLabel:
                        PRODUCT_LABEL,
                    bootstrapVersion:
                        VERSION
                }
            );

                metrics.rootsInitialized += 1;
                return instance;
            } catch (error) {
                metrics.rootsFailed += 1;

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
            } finally {
                initializingRoots.delete(root);
            }
        })();

        initializingRoots.set(
            root,
            initialization
        );

        return initialization;
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

        for (const root of roots) {
            hardenRoot(
                root
            );
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
                application,
                productLabel:
                    PRODUCT_LABEL,
                bootstrapVersion:
                    VERSION
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

        const normalized =
            isNode(context)
                ? context
                : document;

        for (
            const root of
            findTerminals(
                normalized
            )
        ) {
            hardenRoot(
                root
            );
        }

        queueInitialize(
            normalized
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
                    metrics.mutationBatches += 1;

                    for (const mutation of mutations) {
                        for (const node of mutation.addedNodes) {
                            if (
                                isNode(node) &&
                                containsTerminal(node)
                            ) {
                                for (
                                    const root of
                                    findTerminals(
                                        node
                                    )
                                ) {
                                    hardenRoot(
                                        root
                                    );
                                }

                                queueInitialize(
                                    node
                                );
                            }
                        }

                        for (const node of mutation.removedNodes) {
                            if (!isNode(node)) {
                                continue;
                            }

                            for (const root of findTerminals(node)) {
                                const instance =
                                    getApplication()?.getInstance?.(root) ||
                                    getFacade()?.getInstance?.(root);

                                try {
                                    instance?.destroy?.();
                                    initializedRoots.delete?.(
                                        root
                                    );
                                    failedRoots.delete(
                                        root
                                    );
                                    initializingRoots.delete(
                                        root
                                    );
                                    metrics.rootsRemoved += 1;
                                } catch (error) {
                                    console.warn(
                                        "[SpeciedexTerminalBootstrap] " +
                                        "Unable to destroy removed terminal:",
                                        error
                                    );
                                }
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
                    isElement(
                        terminal.root
                    )
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
        if (startPromise) {
            return startPromise;
        }

        if (started) {
            return initialize(
                document,
                options
            );
        }

        metrics.starts += 1;

        bindLifecycleEvents();
        observeDynamicTerminals();

        startPromise =
            initialize(
                document,
                options
            )
                .then(
                    instances => {
                        started =
                            true;

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

        metrics.stops += 1;

        startPromise =
            null;

        applicationPromise =
            null;

        if (
            options.resetDependencies ===
                true
        ) {
            dependencyPromise =
                null;
        }

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

    async function retry(
        root,
        options = {}
    ) {
        if (!isElement(root)) {
            throw new TypeError(
                "retry() requires a terminal root Element."
            );
        }

        failedRoots.delete(root);
        initializedRoots.delete(
            root
        );
        initializingRoots.delete(
            root
        );

        const stale =
            getApplication()?.getInstance?.(
                root
            ) ||
            getFacade()?.getInstance?.(
                root
            );

        try {
            await stale?.destroy?.();
        } catch (error) {
            console.warn(
                "[SpeciedexTerminalBootstrap] Unable to destroy stale terminal before retry:",
                error
            );
        }

        delete root.dataset.terminalError;
        delete root.dataset.terminalReady;

        root
            .querySelectorAll(
                "[data-terminal-bootstrap-error]"
            )
            .forEach(
                node =>
                    node.remove()
            );

        const application =
            await requireApplication({
                ...options,
                reload:
                    options.reload === true
            });

        return initializeRoot(
            application,
            root,
            options
        );
    }

    let restartPromise=null;

    async function restart(
        options = {}
    ) {
        if(restartPromise){
            return restartPromise;
        }
        restartPromise=(async()=>{
        stop({
            destroyInstances:
                options.destroyInstances !== false
        });

        if (options.reload === true) {
            dependencyPromise =
                null;

            applicationPromise =
                null;
        }

        return start(options);
        })();

        try{
            return await restartPromise;
        }finally{
            restartPromise=null;
        }
    }

    function diagnostics() {
        return {
            ...status(),
            metrics: {
                ...metrics
            },
            terminals:
                findTerminals(document).map(root => ({
                    id:
                        root.id || null,
                    state:
                        root.dataset.terminalState || null,
                    ready:
                        root.dataset.terminalReady || null,
                    error:
                        root.dataset.terminalError || null,
                    connected:
                        root.isConnected
                })),
            loaderSnapshot:
                getLoader()?.snapshot?.() ||
                null
        };
    }

    function status() {
        return {
            version:
                VERSION,

            releaseChannel:
                RELEASE_CHANNEL,

            productLabel:
                PRODUCT_LABEL,

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
            RELEASE_CHANNEL,
            PRODUCT_LABEL,
            TERMINAL_SELECTOR,
            INCLUDE_EVENTS,

            start,
            stop,
            initialize,
            initializeRoot,
            queueInitialize,
            findTerminals,
            containsTerminal,
            isTerminalRoot,
            hardenRoot,
            prepareDependencies,
            waitForApplication,
            status,
            diagnostics,
            retry,
            restart,

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
                VERSION,

            releaseChannel:
                RELEASE_CHANNEL,

            productLabel:
                PRODUCT_LABEL
        }
    );

    /*
    ==========================================================================
    Automatic Startup
    ==========================================================================
    */

    function autoStart() {
        window.Speciedex = window.Speciedex || {};

        const ready =
            start();

        window.Speciedex.terminalReady =
            ready;

        ready.catch(
            error => {
                if (
                    window.Speciedex.terminalReady ===
                    ready
                ) {
                    window.Speciedex.terminalReady =
                        null;
                }

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