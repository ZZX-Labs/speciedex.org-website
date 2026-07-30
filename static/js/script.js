"use strict";

/*
==============================================================================
Speciedex.org
Site Bootstrap
==============================================================================

Internal JavaScript wrapper.

Loaded only by:

    /static/script.js

Responsible for:

    • Loading internal JavaScript modules
    • Preserving dependency order
    • Waiting for DOM readiness
    • Loading HTML partials
    • Initializing site modules
    • Broadcasting lifecycle events

Contains NO page-specific logic.

==============================================================================
*/

(() => {
    const Speciedex =
        window.Speciedex =
        window.Speciedex || {};

    if (Speciedex.siteBootstrapLoaded) {
        return;
    }

    Speciedex.siteBootstrapVersion =
        "2.2.0";

    Speciedex.siteBootstrapLoaded =
        true;

    /*
    ==========================================================================
    Internal State
    ==========================================================================
    */

    const MODULE_LOAD_TIMEOUT_MS =
        60000;

    let bootstrapPromise =
        null;

    let initializePromise =
        null;

    let terminalPromise =
        null;

    const loadedModules =
        new Set();

    const modulePromises =
        Speciedex.moduleLoadPromises instanceof Map
            ? Speciedex.moduleLoadPromises
            : new Map();

    Speciedex.moduleLoadPromises =
        modulePromises;

    /*
    ==========================================================================
    Internal Modules
    ==========================================================================
    */

    const SITE_MODULES = [
        "includes.js",
        "data.js",
        "header.js",
        "splash.js",
        "nav.js",
        "footer.js",
        "statistics.js"
    ];

    /*
    --------------------------------------------------------------------------
    Terminal wrappers are intentionally loaded only after recursive partials
    have completed and a terminal root exists.

    Required dependency order:

        1. terminal-loader.js
        2. terminal.js
        3. terminal-bootstrap.js

    Loading these wrappers with the general site modules allowed terminal
    bootstrap code to run before _partials/terminal.html existed.
    --------------------------------------------------------------------------
    */

    const TERMINAL_MODULES = [
        "terminal-loader.js",
        "terminal.js",
        "terminal-bootstrap.js"
    ];

    const MODULES = [
        ...SITE_MODULES,
        ...TERMINAL_MODULES
    ];

    /*
    ==========================================================================
    Dispatch Lifecycle Event
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

    /*
    ==========================================================================
    Resolve Module Root
    ==========================================================================
    */

    function getModuleRootURL() {
        if (Speciedex.moduleRootURL instanceof URL) {
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
                .trim();

        if (!value) {
            throw new TypeError(
                "A JavaScript module filename is required."
            );
        }

        if (
            value.includes("\\") ||
            value.startsWith("/") ||
            value.split("/").some(
                (segment) =>
                    segment === "." ||
                    segment === ".." ||
                    !segment
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
            url.origin !== root.origin ||
            !url.pathname.startsWith(
                root.pathname
            )
        ) {
            throw new TypeError(
                `JavaScript module escapes the module root: ${filename}`
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
    Detect Completed Script Resource
    ==========================================================================
    */

    function hasCompletedResource(url) {
        try {
            return window.performance
                ?.getEntriesByName?.(
                    url,
                    "resource"
                )
                ?.some(
                    (entry) =>
                        entry.initiatorType ===
                            "script" &&
                        Number.isFinite(
                            entry.responseEnd
                        ) &&
                        entry.responseEnd > 0
                ) === true;
        } catch (_error) {
            return false;
        }
    }

    function isScriptLoaded(script, url) {
        if (
            script.dataset.speciedexLoaded ===
            "true"
        ) {
            return true;
        }

        if (
            script.readyState ===
                "loaded" ||
            script.readyState ===
                "complete"
        ) {
            return true;
        }

        return hasCompletedResource(
            url
        );
    }

    /*
    ==========================================================================
    Observe Existing Script
    ==========================================================================
    */

    function observeModule(
        script,
        filename,
        url
    ) {
        if (
            isScriptLoaded(
                script,
                url
            )
        ) {
            script.dataset.speciedexLoaded =
                "true";

            delete script.dataset
                .speciedexFailed;

            delete script.dataset
                .speciedexLoading;

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

        return new Promise(
            (resolve, reject) => {
                let settled =
                    false;

                let timer =
                    null;

                const cleanup =
                    () => {
                        script.removeEventListener(
                            "load",
                            handleLoad
                        );

                        script.removeEventListener(
                            "error",
                            handleError
                        );

                        if (timer !== null) {
                            window.clearTimeout(
                                timer
                            );

                            timer =
                                null;
                        }
                    };

                const finish =
                    (callback) =>
                        (value) => {
                            if (settled) {
                                return;
                            }

                            settled =
                                true;

                            cleanup();
                            callback(value);
                        };

                const resolveOnce =
                    finish(resolve);

                const rejectOnce =
                    finish(reject);

                const handleLoad =
                    () => {
                        script.dataset.speciedexLoaded =
                            "true";

                        delete script.dataset
                            .speciedexFailed;

                        delete script.dataset
                            .speciedexLoading;

                        loadedModules.add(
                            filename
                        );

                        resolveOnce(
                            script
                        );
                    };

                const handleError =
                    () => {
                        script.dataset.speciedexFailed =
                            "true";

                        delete script.dataset
                            .speciedexLoading;

                        rejectOnce(
                            new Error(
                                `Unable to load JavaScript module: ${url}`
                            )
                        );
                    };

                script.addEventListener(
                    "load",
                    handleLoad
                );

                script.addEventListener(
                    "error",
                    handleError
                );

                /*
                --------------------------------------------------------------
                Close the race where the script completes between the first
                state check and listener registration.
                --------------------------------------------------------------
                */

                if (
                    isScriptLoaded(
                        script,
                        url
                    )
                ) {
                    handleLoad();
                    return;
                }

                timer =
                    window.setTimeout(
                        () => {
                            rejectOnce(
                                new Error(
                                    `Timed out loading JavaScript module: ${url}`
                                )
                            );
                        },
                        MODULE_LOAD_TIMEOUT_MS
                    );
            }
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

        let existing =
            findExistingScript(
                url
            );

        if (
            existing?.dataset.speciedexFailed ===
            "true"
        ) {
            existing.remove();
            existing = null;
        }

        if (existing) {
            const existingPromise =
                observeModule(
                    existing,
                    filename,
                    url
                );

            modulePromises.set(
                url,
                existingPromise
            );

            existingPromise.catch(
                () => {
                    if (
                        modulePromises.get(url) ===
                        existingPromise
                    ) {
                        modulePromises.delete(
                            url
                        );
                    }
                }
            );

            return existingPromise;
        }

        const promise =
            new Promise(
                (resolve, reject) => {
                    const script =
                        document.createElement(
                            "script"
                        );

                    let settled =
                        false;

                    let timer =
                        null;

                    const cleanup =
                        () => {
                            script.removeEventListener(
                                "load",
                                handleLoad
                            );

                            script.removeEventListener(
                                "error",
                                handleError
                            );

                            if (timer !== null) {
                                window.clearTimeout(
                                    timer
                                );

                                timer =
                                    null;
                            }
                        };

                    const finish =
                        (callback) =>
                            (value) => {
                                if (settled) {
                                    return;
                                }

                                settled =
                                    true;

                                cleanup();
                                callback(value);
                            };

                    const resolveOnce =
                        finish(resolve);

                    const rejectOnce =
                        finish(reject);

                    const handleLoad =
                        () => {
                            script.dataset.speciedexLoaded =
                                "true";

                            delete script.dataset
                                .speciedexFailed;

                            delete script.dataset
                                .speciedexLoading;

                            loadedModules.add(
                                filename
                            );

                            dispatch(
                                "speciedex:module-loaded",
                                {
                                    filename,
                                    url,
                                    script
                                }
                            );

                            resolveOnce(
                                script
                            );
                        };

                    const handleError =
                        () => {
                            script.dataset.speciedexFailed =
                                "true";

                            delete script.dataset
                                .speciedexLoading;

                            script.remove();

                            rejectOnce(
                                new Error(
                                    `Unable to load JavaScript module: ${url}`
                                )
                            );
                        };

                    script.src =
                        url;

                    script.async =
                        false;

                    script.dataset.speciedexModule =
                        filename;

                    script.dataset.speciedexLoading =
                        "true";

                    script.addEventListener(
                        "load",
                        handleLoad
                    );

                    script.addEventListener(
                        "error",
                        handleError
                    );

                    timer =
                        window.setTimeout(
                            () => {
                                script.dataset.speciedexFailed =
                                    "true";

                                delete script.dataset
                                    .speciedexLoading;

                                script.remove();

                                rejectOnce(
                                    new Error(
                                        `Timed out loading JavaScript module: ${url}`
                                    )
                                );
                            },
                            MODULE_LOAD_TIMEOUT_MS
                        );

                    (
                        document.head ||
                        document.documentElement
                    ).appendChild(
                        script
                    );
                }
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
    Load Module Sequence
    ==========================================================================
    */

    async function loadModuleSequence(
        filenames
    ) {
        const scripts =
            [];

        for (
            const filename of
            filenames
        ) {
            scripts.push(
                await loadModule(
                    filename
                )
            );
        }

        return scripts;
    }

    /*
    ==========================================================================
    Load Site Modules
    ==========================================================================
    */

    function loadModules() {
        return loadModuleSequence(
            SITE_MODULES
        );
    }

    /*
    ==========================================================================
    Load Terminal Wrappers
    ==========================================================================
    */

    function loadTerminalModules() {
        return loadModuleSequence(
            TERMINAL_MODULES
        );
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
            return null;
        }

        return fn();
    }

    /*
    ==========================================================================
    Initialize SpeciedexTerminal
    ==========================================================================
    */

    function initializeTerminal() {
        if (terminalPromise) {
            return terminalPromise;
        }

        terminalPromise =
            (async () => {
                const roots =
                    document.querySelectorAll(
                        "[data-speciedex-terminal], [data-terminal-root]"
                    );

                /*
                --------------------------------------------------------------
                Pages without the terminal partial require no terminal
                wrappers and no terminal initialization.
                --------------------------------------------------------------
                */

                if (!roots.length) {
                    return [];
                }

                /*
                --------------------------------------------------------------
                Load terminal wrappers only now, after _partials/terminal.html
                has been inserted into the document.
                --------------------------------------------------------------
                */

                await loadTerminalModules();

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

                await loader.load();

                /*
                --------------------------------------------------------------
                The terminal bootstrap is the single lifecycle owner when it
                exists. The facade is only the compatibility fallback.
                --------------------------------------------------------------
                */

                const instances =
                    terminalBootstrap &&
                    typeof terminalBootstrap.initialize ===
                        "function"
                        ? await terminalBootstrap.initialize(
                            document
                        )
                        : await facade.initializeAll(
                            document
                        );

                dispatch(
                    "speciedex:terminal-ready",
                    {
                        instances,
                        loader,
                        facade,
                        bootstrap:
                            terminalBootstrap ||
                            null
                    }
                );

                return instances;
            })();

        terminalPromise.catch(
            () => {
                terminalPromise =
                    null;
            }
        );

        return terminalPromise;
    }

    /*
    ==========================================================================
    Initialize Site
    ==========================================================================
    */

    function initializeSite() {
        if (initializePromise) {
            return initializePromise;
        }

        if (Speciedex.siteInitialized) {
            return Promise.resolve(
                Speciedex
            );
        }

        initializePromise =
            (async () => {
                try {
                    /*
                    ----------------------------------------------------------
                    Load HTML partials first.
                    ----------------------------------------------------------
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
                    ----------------------------------------------------------
                    Initialize structural modules.
                    ----------------------------------------------------------
                    */

                    await initializeModule(
                        "Header"
                    );

                    await initializeModule(
                        "Splash"
                    );

                    await initializeModule(
                        "Navigation"
                    );

                    await initializeModule(
                        "Footer"
                    );

                    /*
                    ----------------------------------------------------------
                    Initialize shared data utilities.
                    ----------------------------------------------------------
                    */

                    await initializeModule(
                        "Data"
                    );

                    await initializeModule(
                        "CurrentYear"
                    );

                    await initializeModule(
                        "ExternalLinks"
                    );

                    /*
                    ----------------------------------------------------------
                    Initialize data-driven modules.
                    ----------------------------------------------------------
                    */

                    await initializeModule(
                        "Statistics"
                    );

                    await initializeModule(
                        "Releases"
                    );

                    await initializeModule(
                        "Status"
                    );

                    await initializeModule(
                        "Activity"
                    );

                    /*
                    ----------------------------------------------------------
                    Initialize SpeciedexTerminal only after recursive partials,
                    structural modules, and shared data utilities are ready.
                    ----------------------------------------------------------
                    */

                    await initializeTerminal();

                    Speciedex.siteInitialized =
                        true;

                    dispatch(
                        "speciedex:ready",
                        {
                            Speciedex
                        }
                    );

                    return Speciedex;
                } catch (error) {
                    Speciedex.siteInitialized =
                        false;

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
            })();

        initializePromise.finally(
            () => {
                initializePromise =
                    null;
            }
        );

        return initializePromise;
    }

    /*
    ==========================================================================
    Wait for DOM
    ==========================================================================
    */

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
                        once:
                            true
                    }
                );
            }
        );
    }

    /*
    ==========================================================================
    Bootstrap
    ==========================================================================
    */

    function bootstrap() {
        if (bootstrapPromise) {
            return bootstrapPromise;
        }

        bootstrapPromise =
            (async () => {
                Speciedex.bootstrapRunning =
                    true;

                try {
                    /*
                    ----------------------------------------------------------
                    Load non-terminal internal modules first.
                    ----------------------------------------------------------
                    */

                    await loadModules();

                    /*
                    ----------------------------------------------------------
                    Wait until the document can be safely initialized.
                    ----------------------------------------------------------
                    */

                    await waitForDOM();

                    /*
                    ----------------------------------------------------------
                    Initialize the complete site.
                    ----------------------------------------------------------
                    */

                    const result =
                        await initializeSite();

                    dispatch(
                        "speciedex:bootstrap-ready",
                        {
                            version:
                                Speciedex.siteBootstrapVersion,
                            Speciedex
                        }
                    );

                    return result;
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

        bootstrapPromise.catch(
            () => {
                bootstrapPromise =
                    null;
            }
        );

        return bootstrapPromise;
    }

    /*
    ==========================================================================
    Public Internal API
    ==========================================================================
    */

    Speciedex.getModuleURL =
        getModuleURL;

    Speciedex.loadModule =
        loadModule;

    Speciedex.loadModuleSequence =
        loadModuleSequence;

    Speciedex.loadModules =
        loadModules;

    Speciedex.loadTerminalModules =
        loadTerminalModules;

    Speciedex.initializeModule =
        initializeModule;

    Speciedex.initializeTerminal =
        initializeTerminal;

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
                [...loadedModules],

            pendingModules:
                [...modulePromises.keys()]
                    .filter(
                        (url) => {
                            const script =
                                findExistingScript(
                                    url
                                );

                            return (
                                script?.dataset.speciedexLoaded !==
                                "true"
                            );
                        }
                    ),

            terminalLoaded:
                TERMINAL_MODULES.every(
                    (filename) =>
                        loadedModules.has(
                            filename
                        )
                )
        });

    /*
    ==========================================================================
    Start
    ==========================================================================
    */

    Speciedex.siteBootstrapPromise =
        bootstrap();

    Speciedex.siteBootstrapPromise.catch(
        () => {
            /*
            ------------------------------------------------------------------
            The error has already been logged and dispatched. Keeping the
            rejection handled here prevents an unrelated unhandled-rejection
            report while preserving the rejected public promise.
            ------------------------------------------------------------------
            */
        }
    );
})();
