"use strict";

/*
==============================================================================
Speciedex.org
Internal JavaScript Wrapper
==============================================================================

Loaded by:

    /static/script.js

This file loads the individual site modules in dependency order, waits for the
DOM, loads HTML partials, and then initializes the site functionality.

It contains no header, splash, navigation, footer, statistics, or page-specific
implementation logic.
==============================================================================
*/

(() => {
    const Speciedex = window.Speciedex = window.Speciedex || {};

    if (Speciedex.internalWrapperLoaded) {
        return;
    }

    Speciedex.internalWrapperLoaded = true;

    const MODULES = [
        "includes.js",
        "header.js",
        "splash.js",
        "nav.js",
        "footer.js",
        "statistics.js"
    ];

    function getStaticRootURL() {
        if (Speciedex.staticRootURL instanceof URL) {
            return Speciedex.staticRootURL;
        }

        const currentScript = document.currentScript;

        if (currentScript?.src) {
            return new URL("../", currentScript.src);
        }

        return new URL("/static/", window.location.origin);
    }

    function getModuleURL(filename) {
        return new URL(
            `js/${filename}`,
            getStaticRootURL()
        ).href;
    }

    function findExistingScript(url) {
        return Array.from(document.scripts).find(
            (script) => script.src === url
        );
    }

    function loadModule(filename) {
        const url = getModuleURL(filename);
        const existing = findExistingScript(url);

        if (existing) {
            if (
                existing.dataset.loaded === "true" ||
                existing.readyState === "complete"
            ) {
                return Promise.resolve(existing);
            }

            return new Promise((resolve, reject) => {
                existing.addEventListener(
                    "load",
                    () => resolve(existing),
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
            });
        }

        return new Promise((resolve, reject) => {
            const script = document.createElement("script");

            script.src = url;
            script.defer = true;
            script.dataset.speciedexModule = filename;

            script.addEventListener(
                "load",
                () => {
                    script.dataset.loaded = "true";
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

            document.head.appendChild(script);
        });
    }

    async function loadModules() {
        for (const filename of MODULES) {
            await loadModule(filename);
        }
    }

    async function initializeModule(name) {
        const initializer = Speciedex[name];

        if (typeof initializer !== "function") {
            return;
        }

        await initializer();
    }

    async function initializeSite() {
        if (Speciedex.siteInitialized) {
            return;
        }

        Speciedex.siteInitialized = true;

        try {
            await initializeModule("loadIncludes");

            await initializeModule("initializeHeader");
            await initializeModule("initializeSplash");
            await initializeModule("initializeNavigation");
            await initializeModule("initializeFooter");
            await initializeModule("initializeStatistics");

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
            Speciedex.siteInitialized = false;

            console.error(
                "Speciedex site initialization failed:",
                error
            );

            document.dispatchEvent(
                new CustomEvent(
                    "speciedex:error",
                    {
                        detail: {
                            error
                        }
                    }
                )
            );
        }
    }

    async function bootstrap() {
        try {
            await loadModules();

            if (document.readyState === "loading") {
                document.addEventListener(
                    "DOMContentLoaded",
                    initializeSite,
                    {
                        once: true
                    }
                );

                return;
            }

            await initializeSite();
        } catch (error) {
            console.error(
                "Speciedex module loading failed:",
                error
            );

            document.dispatchEvent(
                new CustomEvent(
                    "speciedex:error",
                    {
                        detail: {
                            error
                        }
                    }
                )
            );
        }
    }

    Speciedex.loadModule = loadModule;
    Speciedex.loadModules = loadModules;
    Speciedex.initializeSite = initializeSite;

    bootstrap();
})();
