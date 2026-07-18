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

    Speciedex.siteBootstrapLoaded = true;

    /*
    ==========================================================================
    Internal Modules
    ==========================================================================
    */

    const MODULES = [
        "includes.js",
        "data.js",
        "header.js",
        "splash.js",
        "nav.js",
        "footer.js",
        "statistics.js"
    ];

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
        return new URL(
            filename,
            getModuleRootURL()
        ).href;
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
        );
    }

    /*
    ==========================================================================
    Load One Module
    ==========================================================================
    */

    function loadModule(filename) {
        const url =
            getModuleURL(filename);

        const existing =
            findExistingScript(url);

        if (existing) {
            if (
                existing.dataset.speciedexLoaded ===
                "true"
            ) {
                return Promise.resolve(
                    existing
                );
            }

            return new Promise(
                (resolve, reject) => {
                    existing.addEventListener(
                        "load",
                        () => {
                            existing.dataset.speciedexLoaded =
                                "true";

                            resolve(existing);
                        },
                        {
                            once: true
                        }
                    );

                    existing.addEventListener(
                        "error",
                        () => {
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
                }
            );
        }

        return new Promise(
            (resolve, reject) => {
                const script =
                    document.createElement(
                        "script"
                    );

                script.src = url;
                script.async = false;

                script.dataset.speciedexModule =
                    filename;

                script.addEventListener(
                    "load",
                    () => {
                        script.dataset.speciedexLoaded =
                            "true";

                        resolve(script);
                    },
                    {
                        once: true
                    }
                );

                script.addEventListener(
                    "error",
                    () => {
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
        );
    }

    /*
    ==========================================================================
    Load All Modules
    ==========================================================================
    */

    async function loadModules() {
        for (const filename of MODULES) {
            await loadModule(
                filename
            );
        }
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
            return;
        }

        await fn();
    }

    /*
    ==========================================================================
    Initialize Site
    ==========================================================================
    */

    async function initializeSite() {
        if (Speciedex.siteInitialized) {
            return;
        }

        Speciedex.siteInitialized = true;

        try {
            /*
            ------------------------------------------------------------------
            Load HTML partials first.
            ------------------------------------------------------------------
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
            ------------------------------------------------------------------
            Initialize structural modules.
            ------------------------------------------------------------------
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
            ------------------------------------------------------------------
            Initialize shared data utilities.
            ------------------------------------------------------------------
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
            ------------------------------------------------------------------
            Initialize data-driven modules.
            ------------------------------------------------------------------
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
            ------------------------------------------------------------------
            Site ready.
            ------------------------------------------------------------------
            */

            document.dispatchEvent(
                new CustomEvent(
                    "speciedex:ready",
                    {
                        detail: {
                            Speciedex
                        }
                    }
                )
            );
        } catch (error) {
            Speciedex.siteInitialized =
                false;

            console.error(
                "Speciedex site initialization failed:",
                error
            );

            document.dispatchEvent(
                new CustomEvent(
                    "speciedex:error",
                    {
                        detail: {
                            phase:
                                "initialization",
                            error
                        }
                    }
                )
            );
        }
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
                        once: true
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

    async function bootstrap() {
        if (Speciedex.bootstrapRunning) {
            return;
        }

        Speciedex.bootstrapRunning = true;

        try {
            /*
            ------------------------------------------------------------------
            Load every internal module first.
            ------------------------------------------------------------------
            */

            await loadModules();

            /*
            ------------------------------------------------------------------
            Wait until the document can be safely initialized.
            ------------------------------------------------------------------
            */

            await waitForDOM();

            /*
            ------------------------------------------------------------------
            Initialize the complete site.
            ------------------------------------------------------------------
            */

            await initializeSite();
        } catch (error) {
            console.error(
                "Speciedex bootstrap failed:",
                error
            );

            document.dispatchEvent(
                new CustomEvent(
                    "speciedex:error",
                    {
                        detail: {
                            phase:
                                "bootstrap",
                            error
                        }
                    }
                )
            );
        } finally {
            Speciedex.bootstrapRunning =
                false;
        }
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

    Speciedex.loadModules =
        loadModules;

    Speciedex.initializeModule =
        initializeModule;

    Speciedex.initializeSite =
        initializeSite;

    Speciedex.bootstrap =
        bootstrap;

    /*
    ==========================================================================
    Start
    ==========================================================================
    */

    bootstrap();
})();
