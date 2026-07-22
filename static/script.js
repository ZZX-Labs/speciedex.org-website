"use strict";

/*
==============================================================================
Speciedex.org
Public JavaScript Entry Point
==============================================================================

This is the only JavaScript file loaded directly by site pages.

Responsibilities:

    • Resolve the /static/ asset root
    • Load the internal site bootstrap
    • Expose minimal public loader helpers
    • Dispatch loader lifecycle events and errors

The internal bootstrap:

    /static/js/script.js

is responsible for loading and initializing all remaining JavaScript modules.

Dependency flow:

    HTML
        |
        v
    /static/script.js
        |
        v
    /static/js/script.js
        |
        +--> includes.js
        +--> data.js
        +--> header.js
        +--> splash.js
        +--> nav.js
        +--> footer.js
        +--> statistics.js
        +--> terminal wrappers
        +--> future modules

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
    ==========================================================================
    Configuration
    ==========================================================================
    */

    const BOOTSTRAP_FILE =
        "js/script.js";

    const ENTRY_SCRIPT_URL =
        document.currentScript?.src ||
        new URL(
            "/static/script.js",
            window.location.origin
        ).href;

    const scriptPromises =
        Speciedex.scriptLoadPromises instanceof Map
            ? Speciedex.scriptLoadPromises
            : new Map();

    Speciedex.scriptLoadPromises =
        scriptPromises;

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
    Resolve Static Root
    ==========================================================================
    */

    function getStaticRootURL() {
        if (Speciedex.staticRootURL instanceof URL) {
            return Speciedex.staticRootURL;
        }

        Speciedex.staticRootURL =
            new URL(
                "./",
                ENTRY_SCRIPT_URL
            );

        return Speciedex.staticRootURL;
    }

    /*
    ==========================================================================
    Resolve Static Asset
    ==========================================================================
    */

    function getStaticURL(path) {
        const value =
            String(path ?? "")
                .trim()
                .replace(/^\/+/, "");

        if (!value) {
            throw new TypeError(
                "A static asset path is required."
            );
        }

        const segments =
            value.split("/");

        if (
            value.includes("\\") ||
            segments.some(
                (segment) =>
                    segment === ".." ||
                    segment === "."
            )
        ) {
            throw new TypeError(
                `Invalid static asset path: ${path}`
            );
        }

        const url =
            new URL(
                value,
                getStaticRootURL()
            );

        if (
            url.origin !==
            getStaticRootURL().origin
        ) {
            throw new TypeError(
                `Cross-origin static asset paths are not allowed: ${path}`
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

    function observeScript(script, url) {
        if (
            script.dataset.speciedexLoaded ===
            "true"
        ) {
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
                    `Unable to load JavaScript file: ${url}`
                )
            );
        }

        return new Promise(
            (resolve, reject) => {
                const handleLoad = () => {
                    script.dataset.speciedexLoaded =
                        "true";

                    delete script.dataset
                        .speciedexFailed;

                    resolve(script);
                };

                const handleError = () => {
                    script.dataset.speciedexFailed =
                        "true";

                    reject(
                        new Error(
                            `Unable to load JavaScript file: ${url}`
                        )
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
        );
    }

    /*
    ==========================================================================
    Load Script
    ==========================================================================
    */

    function loadScript(path) {
        let url;

        try {
            url = getStaticURL(path);
        } catch (error) {
            return Promise.reject(error);
        }

        const pending =
            scriptPromises.get(url);

        if (pending) {
            return pending;
        }

        const existing =
            findExistingScript(url);

        if (existing) {
            const existingPromise =
                observeScript(
                    existing,
                    url
                );

            scriptPromises.set(
                url,
                existingPromise
            );

            existingPromise.catch(
                () => {
                    if (
                        scriptPromises.get(url) ===
                        existingPromise
                    ) {
                        scriptPromises.delete(url);
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

                    script.src = url;
                    script.async = false;
                    script.dataset.speciedexEntry =
                        String(path);

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
                            script.dataset.speciedexFailed =
                                "true";

                            script.remove();

                            reject(
                                new Error(
                                    `Unable to load JavaScript file: ${url}`
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

        scriptPromises.set(
            url,
            promise
        );

        promise.catch(
            () => {
                if (
                    scriptPromises.get(url) ===
                    promise
                ) {
                    scriptPromises.delete(url);
                }
            }
        );

        return promise;
    }

    /*
    ==========================================================================
    Load Bootstrap
    ==========================================================================
    */

    function loadBootstrap() {
        if (Speciedex.bootstrapEntryPromise) {
            return Speciedex.bootstrapEntryPromise;
        }

        const bootstrapURL =
            getStaticURL(
                BOOTSTRAP_FILE
            );

        Speciedex.bootstrapEntryLoaded =
            false;

        Speciedex.bootstrapEntryPromise =
            loadScript(
                BOOTSTRAP_FILE
            )
                .then(
                    (script) => {
                        Speciedex.bootstrapEntryLoaded =
                            true;

                        dispatch(
                            "speciedex:bootstrap-loaded",
                            {
                                url:
                                    bootstrapURL,
                                script
                            }
                        );

                        return script;
                    }
                )
                .catch(
                    (error) => {
                        Speciedex.bootstrapEntryLoaded =
                            false;

                        Speciedex.bootstrapEntryPromise =
                            null;

                        console.error(
                            "Speciedex JavaScript bootstrap loading failed:",
                            error
                        );

                        dispatch(
                            "speciedex:error",
                            {
                                phase:
                                    "bootstrap-loading",
                                url:
                                    bootstrapURL,
                                error
                            }
                        );

                        throw error;
                    }
                );

        return Speciedex.bootstrapEntryPromise;
    }

    /*
    ==========================================================================
    Public Entry-Point API
    ==========================================================================
    */

    Speciedex.getStaticRootURL =
        getStaticRootURL;

    Speciedex.getStaticURL =
        getStaticURL;

    Speciedex.loadScript =
        loadScript;

    Speciedex.loadBootstrap =
        loadBootstrap;

    /*
    ==========================================================================
    Start
    ==========================================================================
    */

    Speciedex.publicEntryPromise =
        loadBootstrap();

    Speciedex.publicEntryPromise.catch(
        () => {
            /* Error already reported and dispatched by loadBootstrap(). */
        }
    );
})();
