"use strict";

/*
==============================================================================
Speciedex.org
Public JavaScript Entry Point
==============================================================================

This is the only JavaScript file loaded directly by site pages.

It loads all internal JavaScript modules in dependency order and then loads:

    /static/js/script.js

The final script is the internal site bootstrap.

==============================================================================
*/

(() => {
    const Speciedex =
        window.Speciedex =
        window.Speciedex || {};

    if (Speciedex.publicEntryPointLoaded) {
        return;
    }

    Speciedex.publicEntryPointLoaded = true;

    /*
    --------------------------------------------------------------------------
    Internal scripts.

    The bootstrap must load last because it initializes the modules registered
    by the preceding files.
    --------------------------------------------------------------------------
    */

    const MODULES = [
        "data.js",
        "includes.js",
        "header.js",
        "splash.js",
        "nav.js",
        "footer.js",
        "statistics.js",
        "script.js"
    ];

    /*
    --------------------------------------------------------------------------
    Resolve /static/ from this public entry point.
    --------------------------------------------------------------------------
    */

    function getStaticRootURL() {
        if (
            Speciedex.staticRootURL
            instanceof URL
        ) {
            return Speciedex.staticRootURL;
        }

        const currentScript =
            document.currentScript;

        Speciedex.staticRootURL =
            currentScript?.src
                ? new URL(
                    "./",
                    currentScript.src
                )
                : new URL(
                    "/static/",
                    window.location.origin
                );

        return Speciedex.staticRootURL;
    }

    /*
    --------------------------------------------------------------------------
    Resolve an internal JavaScript file.
    --------------------------------------------------------------------------
    */

    function getModuleURL(filename) {
        return new URL(
            `js/${filename}`,
            getStaticRootURL()
        ).href;
    }

    /*
    --------------------------------------------------------------------------
    Find an existing script element.
    --------------------------------------------------------------------------
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
    --------------------------------------------------------------------------
    Load one script.
    --------------------------------------------------------------------------
    */

    function loadModule(filename) {
        const url =
            getModuleURL(filename);

        const existing =
            findExistingScript(url);

        if (existing) {
            if (
                existing.dataset
                    .speciedexLoaded ===
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
                            existing.dataset
                                .speciedexLoaded =
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

                script.dataset
                    .speciedexModule =
                    filename;

                script.addEventListener(
                    "load",
                    () => {
                        script.dataset
                            .speciedexLoaded =
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
        );
    }

    /*
    --------------------------------------------------------------------------
    Load all modules sequentially.
    --------------------------------------------------------------------------
    */

    async function loadModules() {
        for (const filename of MODULES) {
            await loadModule(filename);
        }
    }

    /*
    --------------------------------------------------------------------------
    Begin loading.
    --------------------------------------------------------------------------
    */

    loadModules().catch((error) => {
        console.error(
            "Speciedex JavaScript loading failed:",
            error
        );

        document.dispatchEvent(
            new CustomEvent(
                "speciedex:error",
                {
                    detail: {
                        phase:
                            "module-loading",

                        error
                    }
                }
            )
        );
    });

    /*
    --------------------------------------------------------------------------
    Public entry-point API.
    --------------------------------------------------------------------------
    */

    Speciedex.getStaticRootURL =
        getStaticRootURL;

    Speciedex.getModuleURL =
        getModuleURL;

    Speciedex.loadModule =
        loadModule;

    Speciedex.loadModules =
        loadModules;
})();
