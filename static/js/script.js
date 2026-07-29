"use strict";

/*
==============================================================================
Speciedex.org
Site Bootstrap
==============================================================================

Internal JavaScript wrapper.

Loaded only by:

    /static/script.js

Responsibilities:

    • Load internal JavaScript modules
    • Preserve dependency order where required
    • Wait for DOM readiness
    • Load HTML partials
    • Initialize site modules
    • Initialize the terminal shell before optional terminal modules
    • Defer expensive terminal providers, archives, and visualizations
    • Broadcast deterministic lifecycle events

Contains no page-specific logic.

==============================================================================
*/

(() => {
    const Speciedex =
        window.Speciedex =
        window.Speciedex || {};

    if (Speciedex.siteBootstrapLoaded) {
        return;
    }

    Speciedex.siteBootstrapLoaded = true;
    Speciedex.siteBootstrapVersion = "2.2.0";

    /*
    ==========================================================================
    Configuration
    ==========================================================================
    */

    const MODULE_LOAD_TIMEOUT_MS = 20000;

    const SITE_MODULES = Object.freeze([
        "includes.js",
        "data.js",
        "header.js",
        "splash.js",
        "nav.js",
        "footer.js",
        "statistics.js"
    ]);

    const TERMINAL_WRAPPERS = Object.freeze([
        "terminal-loader.js",
        "terminal.js",
        "terminal-bootstrap.js"
    ]);

    /*
    --------------------------------------------------------------------------
    These modules are sufficient to create the terminal shell, register Help,
    mount command handling, and connect search/API services.

    Optional providers, archives, taxonomy modules, charts, maps, matrices,
    workers, and splash visualizations are deliberately not startup blockers.
    --------------------------------------------------------------------------
    */

    const TERMINAL_CRITICAL_MODULES = Object.freeze([
        "state",
        "events",
        "log",
        "storage",
        "settings",
        "theme",
        "console",
        "help",
        "api",
        "library",
        "index",
        "search",
        "application"
    ]);

    const loadedModules =
        Speciedex.loadedSiteModules instanceof Set
            ? Speciedex.loadedSiteModules
            : new Set();

    const modulePromises =
        Speciedex.siteModulePromises instanceof Map
            ? Speciedex.siteModulePromises
            : new Map();

    Speciedex.loadedSiteModules = loadedModules;
    Speciedex.siteModulePromises = modulePromises;

    let bootstrapPromise = null;
    let initializePromise = null;
    let terminalPromise = null;
    let deferredTerminalPromise = null;

    /*
    ==========================================================================
    Utilities
    ==========================================================================
    */

    function dispatch(name, detail = {}) {
        document.dispatchEvent(
            new CustomEvent(
                name,
                {
                    detail
                }
            )
        );
    }

    function createTimeoutError(url, timeout) {
        return new Error(
            `Timed out after ${timeout} ms while loading JavaScript module: ${url}`
        );
    }

    function withTimeout(promise, timeout, url) {
        let timer = null;

        const timeoutPromise =
            new Promise(
                (_resolve, reject) => {
                    timer =
                        window.setTimeout(
                            () => {
                                reject(
                                    createTimeoutError(
                                        url,
                                        timeout
                                    )
                                );
                            },
                            timeout
                        );
                }
            );

        return Promise.race([
            promise,
            timeoutPromise
        ]).finally(
            () => {
                if (timer !== null) {
                    window.clearTimeout(timer);
                }
            }
        );
    }

    function waitForDOM() {
        if (
            document.readyState !==
            "loading"
        ) {
            return Promise.resolve();
        }

        return new Promise(
            (resolve) => {
                document.addEventListener(
                    "DOMContentLoaded",
                    resolve,
                    {
                        once: true
                    }
                );
            }
        );
    }

    function scheduleIdle(callback, timeout = 2500) {
        if (
            typeof window.requestIdleCallback ===
            "function"
        ) {
            window.requestIdleCallback(
                callback,
                {
                    timeout
                }
            );

            return;
        }

        window.setTimeout(
            callback,
            100
        );
    }

    function waitUntilVisible() {
        if (
            document.visibilityState !==
            "hidden"
        ) {
            return Promise.resolve();
        }

        return new Promise(
            (resolve) => {
                const onVisibilityChange = () => {
                    if (
                        document.visibilityState ===
                        "hidden"
                    ) {
                        return;
                    }

                    document.removeEventListener(
                        "visibilitychange",
                        onVisibilityChange
                    );

                    resolve();
                };

                document.addEventListener(
                    "visibilitychange",
                    onVisibilityChange
                );
            }
        );
    }

    /*
    ==========================================================================
    Resolve Module Root
    ==========================================================================
    */

    function getModuleRootURL() {
        if (
            Speciedex.moduleRootURL instanceof
            URL
        ) {
            return Speciedex.moduleRootURL;
        }

        const currentScript =
            document.currentScript;

        if (currentScript?.src) {
            Speciedex.moduleRootURL =
                new URL(
                    "./",
                    currentScript.src
                );

            return Speciedex.moduleRootURL;
        }

        Speciedex.moduleRootURL =
            new URL(
                "/static/js/",
                window.location.origin
            );

        return Speciedex.moduleRootURL;
    }

    /*
    ==========================================================================
    Resolve Module URL
    ==========================================================================
    */

    function getModuleURL(filename) {
        const value =
            String(filename ?? "")
                .trim()
                .replace(/^\/+/, "");

        if (!value) {
            throw new TypeError(
                "A JavaScript module filename is required."
            );
        }

        if (
            value.includes("\\") ||
            value
                .split("/")
                .some(
                    (segment) =>
                        segment === "." ||
                        segment === ".."
                )
        ) {
            throw new TypeError(
                `Invalid JavaScript module filename: ${filename}`
            );
        }

        const root =
            getModuleRootURL();

        const url =
            new URL(
                value,
                root
            );

        if (
            url.origin !==
            root.origin
        ) {
            throw new TypeError(
                `Cross-origin JavaScript modules are not allowed: ${filename}`
            );
        }

        return url.href;
    }

    /*
    ==========================================================================
    Find Existing Script
    ==========================================================================
    */

    function findExistingScript(url) {
        return Array.from(
            document.scripts
        ).find(
            (script) =>
                script.src === url
        ) || null;
    }

    /*
    ==========================================================================
    Observe Existing Script
    ==========================================================================
    */

    function observeExistingScript(
        script,
        filename,
        url
    ) {
        if (
            script.dataset.speciedexLoaded ===
            "true"
        ) {
            loadedModules.add(
                filename
            );

            return Promise.resolve(
                script
            );
        }

        if (
            script.dataset.speciedexFailed ===
            "true"
        ) {
            return Promise.reject(
                new Error(
                    `Unable to load JavaScript module: ${url}`
                )
            );
        }

        /*
        ----------------------------------------------------------------------
        A script may already have completed before this bootstrap observes it
        but may not carry our data marker. Check document readiness and the
        browser's readyState extension where available before attaching only
        future event listeners.
        ----------------------------------------------------------------------
        */

        if (
            script.readyState === "loaded" ||
            script.readyState === "complete"
        ) {
            script.dataset.speciedexLoaded =
                "true";

            loadedModules.add(
                filename
            );

            return Promise.resolve(
                script
            );
        }

        return withTimeout(
            new Promise(
                (resolve, reject) => {
                    const handleLoad = () => {
                        cleanup();

                        script.dataset.speciedexLoaded =
                            "true";

                        delete script.dataset
                            .speciedexFailed;

                        loadedModules.add(
                            filename
                        );

                        resolve(script);
                    };

                    const handleError = () => {
                        cleanup();

                        script.dataset.speciedexFailed =
                            "true";

                        reject(
                            new Error(
                                `Unable to load JavaScript module: ${url}`
                            )
                        );
                    };

                    const cleanup = () => {
                        script.removeEventListener(
                            "load",
                            handleLoad
                        );

                        script.removeEventListener(
                            "error",
                            handleError
                        );
                    };

                    script.addEventListener(
                        "load",
                        handleLoad,
                        {
                            once: true
                        }
                    );

                    script.addEventListener(
                        "error",
                        handleError,
                        {
                            once: true
                        }
                    );
                }
            ),
            MODULE_LOAD_TIMEOUT_MS,
            url
        );
    }

    /*
    ==========================================================================
    Load One Module
    ==========================================================================
    */

    function loadModule(filename) {
        let url;

        try {
            url =
                getModuleURL(
                    filename
                );
        } catch (error) {
            return Promise.reject(
                error
            );
        }

        const pending =
            modulePromises.get(
                url
            );

        if (pending) {
            return pending;
        }

        const existing =
            findExistingScript(
                url
            );

        const promise =
            existing
                ? observeExistingScript(
                    existing,
                    filename,
                    url
                )
                : withTimeout(
                    new Promise(
                        (resolve, reject) => {
                            const script =
                                document.createElement(
                                    "script"
                                );

                            script.src =
                                url;

                            /*
                            --------------------------------------------------
                            Dynamically inserted classic scripts execute in
                            insertion order only when async is explicitly
                            false. The bootstrap itself still controls order
                            by awaiting required groups.
                            --------------------------------------------------
                            */

                            script.async =
                                false;

                            script.dataset.speciedexModule =
                                filename;

                            script.addEventListener(
                                "load",
                                () => {
                                    script.dataset.speciedexLoaded =
                                        "true";

                                    loadedModules.add(
                                        filename
                                    );

                                    dispatch(
                                        "speciedex:site-module-loaded",
                                        {
                                            filename,
                                            url,
                                            script
                                        }
                                    );

                                    resolve(
                                        script
                                    );
                                },
                                {
                                    once: true
                                }
                            );

                            script.addEventListener(
                                "error",
                                () => {
                                    script.dataset.speciedexFailed =
                                        "true";

                                    script.remove();

                                    reject(
                                        new Error(
                                            `Unable to load JavaScript module: ${url}`
                                        )
                                    );
                                },
                                {
                                    once: true
                                }
                            );

                            document.head.appendChild(
                                script
                            );
                        }
                    ),
                    MODULE_LOAD_TIMEOUT_MS,
                    url
                );

        modulePromises.set(
            url,
            promise
        );

        promise.catch(
            () => {
                if (
                    modulePromises.get(url) ===
                    promise
                ) {
                    modulePromises.delete(
                        url
                    );
                }
            }
        );

        return promise;
    }

    /*
    ==========================================================================
    Load Module Groups
    ==========================================================================
    */

    async function loadSiteModules() {
        /*
        ----------------------------------------------------------------------
        includes.js must be available first because it supplies partial
        loading. The remaining independent site modules can download and
        evaluate without a serial network waterfall.
        ----------------------------------------------------------------------
        */

        await loadModule(
            SITE_MODULES[0]
        );

        await Promise.all(
            SITE_MODULES
                .slice(1)
                .map(
                    (filename) =>
                        loadModule(
                            filename
                        )
                )
        );
    }

    async function loadTerminalWrappers() {
        /*
        ----------------------------------------------------------------------
        Wrapper order is mandatory.
        ----------------------------------------------------------------------
        */

        for (
            const filename
            of TERMINAL_WRAPPERS
        ) {
            await loadModule(
                filename
            );
        }
    }

    async function loadModules() {
        await Promise.all([
            loadSiteModules(),
            loadTerminalWrappers()
        ]);
    }

    /*
    ==========================================================================
    Initialize One Module
    ==========================================================================
    */

    async function initializeModule(name) {
        const fn =
            Speciedex[
                `initialize${name}`
            ];

        if (
            typeof fn !==
            "function"
        ) {
            return undefined;
        }

        try {
            return await fn();
        } catch (error) {
            dispatch(
                "speciedex:module-initialization-error",
                {
                    name,
                    error
                }
            );

            console.error(
                `Speciedex ${name} initialization failed:`,
                error
            );

            /*
            ------------------------------------------------------------------
            Shared page modules are isolated from each other. A footer or
            statistics failure must not prevent the terminal from mounting.
            ------------------------------------------------------------------
            */

            return undefined;
        }
    }

    /*
    ==========================================================================
    Initialize SpeciedexTerminal
    ==========================================================================
    */

    async function initializeTerminal() {
        if (terminalPromise) {
            return terminalPromise;
        }

        terminalPromise =
            (async () => {
                const roots =
                    document.querySelectorAll(
                        [
                            "[data-speciedex-terminal]",
                            "[data-terminal-root]",
                            "[data-terminal]"
                        ].join(",")
                    );

                if (!roots.length) {
                    return [];
                }

                const loader =
                    window.SpeciedexTerminalLoader;

                const facade =
                    window.SpeciedexTerminal;

                const terminalBootstrap =
                    window.SpeciedexTerminalBootstrap;

                if (
                    !loader ||
                    typeof loader.load !==
                    "function"
                ) {
                    throw new Error(
                        "SpeciedexTerminalLoader is unavailable."
                    );
                }

                if (
                    !facade ||
                    typeof facade.initializeAll !==
                    "function"
                ) {
                    throw new Error(
                        "SpeciedexTerminal facade is unavailable."
                    );
                }

                dispatch(
                    "speciedex:terminal-initialization-start",
                    {
                        roots:
                            Array.from(
                                roots
                            ),
                        criticalModules:
                            Array.from(
                                TERMINAL_CRITICAL_MODULES
                            )
                    }
                );

                /*
                ----------------------------------------------------------------
                Load only the terminal shell and essential command services.
                This is the central correction: loader.load() without options
                loads the entire provider/archive/taxonomy/visualization graph
                and previously kept Help and commands inaccessible.
                ----------------------------------------------------------------
                */

                await loader.load(
                    {
                        modules:
                            Array.from(
                                TERMINAL_CRITICAL_MODULES
                            ),
                        phase:
                            "critical"
                    }
                );

                let instances;

                if (
                    terminalBootstrap &&
                    typeof terminalBootstrap.initialize ===
                    "function"
                ) {
                    instances =
                        await terminalBootstrap.initialize(
                            document
                        );
                } else {
                    instances =
                        await facade.initializeAll(
                            document
                        );
                }

                dispatch(
                    "speciedex:terminal-ready",
                    {
                        instances,
                        loader,
                        facade,
                        bootstrap:
                            terminalBootstrap ||
                            null,
                        phase:
                            "critical"
                    }
                );

                scheduleDeferredTerminalLoad();

                return instances;
            })();

        try {
            return await terminalPromise;
        } catch (error) {
            terminalPromise =
                null;

            dispatch(
                "speciedex:terminal-error",
                {
                    phase:
                        "critical-initialization",
                    error
                }
            );

            throw error;
        }
    }

    /*
    ==========================================================================
    Deferred Terminal Modules
    ==========================================================================
    */

    function scheduleDeferredTerminalLoad() {
        if (deferredTerminalPromise) {
            return deferredTerminalPromise;
        }

        deferredTerminalPromise =
            new Promise(
                (resolve) => {
                    scheduleIdle(
                        () => {
                            resolve(
                                loadDeferredTerminalModules()
                            );
                        }
                    );
                }
            ).then(
                (value) => value
            );

        return deferredTerminalPromise;
    }

    async function loadDeferredTerminalModules() {
        await waitUntilVisible();

        const loader =
            window.SpeciedexTerminalLoader;

        if (
            !loader ||
            typeof loader.load !==
            "function"
        ) {
            return null;
        }

        dispatch(
            "speciedex:terminal-deferred-start",
            {
                loader
            }
        );

        try {
            const result =
                await loader.load(
                    {
                        phase:
                            "deferred"
                    }
                );

            dispatch(
                "speciedex:terminal-deferred-ready",
                {
                    loader,
                    result
                }
            );

            return result;
        } catch (error) {
            /*
            ------------------------------------------------------------------
            Optional module failures remain visible in diagnostics but never
            invalidate the already-mounted command shell.
            ------------------------------------------------------------------
            */

            console.warn(
                "Speciedex deferred terminal modules completed with errors:",
                error
            );

            dispatch(
                "speciedex:terminal-deferred-error",
                {
                    loader,
                    error
                }
            );

            return null;
        }
    }

    /*
    ==========================================================================
    Initialize Site
    ==========================================================================
    */

    async function initializeSite() {
        if (initializePromise) {
            return initializePromise;
        }

        initializePromise =
            (async () => {
                if (
                    Speciedex.siteInitialized
                ) {
                    return Speciedex.siteInstances ||
                        [];
                }

                await waitForDOM();

                /*
                ----------------------------------------------------------------
                Includes must finish before terminal roots are queried.
                ----------------------------------------------------------------
                */

                if (
                    typeof Speciedex.loadIncludes ===
                    "function"
                ) {
                    await Speciedex.loadIncludes(
                        document
                    );
                }

                /*
                ----------------------------------------------------------------
                Initialize page modules in isolated groups. No non-terminal
                page component is allowed to stop terminal initialization.
                ----------------------------------------------------------------
                */

                await Promise.all([
                    initializeModule(
                        "Header"
                    ),
                    initializeModule(
                        "Splash"
                    ),
                    initializeModule(
                        "Navigation"
                    ),
                    initializeModule(
                        "Footer"
                    )
                ]);

                await Promise.all([
                    initializeModule(
                        "Data"
                    ),
                    initializeModule(
                        "CurrentYear"
                    ),
                    initializeModule(
                        "ExternalLinks"
                    )
                ]);

                /*
                ----------------------------------------------------------------
                Mount the terminal before potentially expensive statistics,
                release, status, and activity hydration.
                ----------------------------------------------------------------
                */

                let terminalInstances =
                    [];

                try {
                    terminalInstances =
                        await initializeTerminal();
                } catch (error) {
                    console.error(
                        "Speciedex terminal initialization failed:",
                        error
                    );
                }

                /*
                ----------------------------------------------------------------
                Data-driven page modules run after the interactive shell exists.
                ----------------------------------------------------------------
                */

                await Promise.all([
                    initializeModule(
                        "Statistics"
                    ),
                    initializeModule(
                        "Releases"
                    ),
                    initializeModule(
                        "Status"
                    ),
                    initializeModule(
                        "Activity"
                    )
                ]);

                Speciedex.siteInstances =
                    terminalInstances;

                Speciedex.siteInitialized =
                    true;

                dispatch(
                    "speciedex:ready",
                    {
                        Speciedex,
                        terminalInstances
                    }
                );

                return terminalInstances;
            })();

        try {
            return await initializePromise;
        } catch (error) {
            Speciedex.siteInitialized =
                false;

            initializePromise =
                null;

            console.error(
                "Speciedex site initialization failed:",
                error
            );

            dispatch(
                "speciedex:error",
                {
                    phase:
                        "initialization",
                    error
                }
            );

            throw error;
        }
    }

    /*
    ==========================================================================
    Bootstrap
    ==========================================================================
    */

    async function bootstrap() {
        if (bootstrapPromise) {
            return bootstrapPromise;
        }

        bootstrapPromise =
            (async () => {
                if (
                    Speciedex.bootstrapRunning
                ) {
                    return undefined;
                }

                Speciedex.bootstrapRunning =
                    true;

                dispatch(
                    "speciedex:bootstrap-start",
                    {
                        version:
                            Speciedex
                                .siteBootstrapVersion
                    }
                );

                try {
                    await loadModules();
                    await initializeSite();

                    dispatch(
                        "speciedex:bootstrap-ready",
                        {
                            version:
                                Speciedex
                                    .siteBootstrapVersion
                        }
                    );
                } catch (error) {
                    console.error(
                        "Speciedex bootstrap failed:",
                        error
                    );

                    dispatch(
                        "speciedex:error",
                        {
                            phase:
                                "bootstrap",
                            error
                        }
                    );

                    throw error;
                } finally {
                    Speciedex.bootstrapRunning =
                        false;
                }
            })();

        try {
            return await bootstrapPromise;
        } finally {
            /*
            ------------------------------------------------------------------
            Preserve the completed promise for duplicate callers. Reset only
            after failure, which is handled by the catch below.
            ------------------------------------------------------------------
            */
        }
    }

    /*
    ==========================================================================
    Public Internal API
    ==========================================================================
    */

    Speciedex.getModuleRootURL =
        getModuleRootURL;

    Speciedex.getModuleURL =
        getModuleURL;

    Speciedex.loadModule =
        loadModule;

    Speciedex.loadSiteModules =
        loadSiteModules;

    Speciedex.loadTerminalWrappers =
        loadTerminalWrappers;

    Speciedex.loadModules =
        loadModules;

    Speciedex.initializeModule =
        initializeModule;

    Speciedex.initializeTerminal =
        initializeTerminal;

    Speciedex.loadDeferredTerminalModules =
        loadDeferredTerminalModules;

    Speciedex.initializeSite =
        initializeSite;

    Speciedex.bootstrap =
        bootstrap;

    Speciedex.bootstrapStatus =
        () => ({
            version:
                Speciedex.siteBootstrapVersion,
            bootstrapRunning:
                Boolean(
                    Speciedex.bootstrapRunning
                ),
            siteInitialized:
                Boolean(
                    Speciedex.siteInitialized
                ),
            loadedModules:
                Array.from(
                    loadedModules
                ),
            terminalCriticalModules:
                Array.from(
                    TERMINAL_CRITICAL_MODULES
                ),
            deferredTerminalScheduled:
                Boolean(
                    deferredTerminalPromise
                )
        });

    /*
    ==========================================================================
    Start
    ==========================================================================
    */

    Speciedex.bootstrapPromise =
        bootstrap();

    Speciedex.bootstrapPromise.catch(
        (error) => {
            bootstrapPromise =
                null;

            console.error(
                "Speciedex bootstrap promise rejected:",
                error
            );
        }
    );
})();
