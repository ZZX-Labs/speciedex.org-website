"use strict";

/*
==============================================================================
Speciedex.org
Public JavaScript Entry Point
==============================================================================

This is the only JavaScript file loaded directly by site pages.

It loads:

    /static/js/script.js

The internal wrapper is responsible for loading all remaining modules.

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

    const INTERNAL_WRAPPER_URL =
        new URL(
            "js/script.js",
            document.currentScript?.src ||
            new URL(
                "/static/script.js",
                window.location.origin
            )
        ).href;

    function findExistingScript() {
        return Array.from(
            document.scripts
        ).find(
            (script) =>
                script.src ===
                INTERNAL_WRAPPER_URL
        );
    }

    function loadInternalWrapper() {
        const existing =
            findExistingScript();

        if (existing) {
            return;
        }

        const script =
            document.createElement(
                "script"
            );

        script.src =
            INTERNAL_WRAPPER_URL;

        script.defer = true;

        script.dataset.speciedexWrapper =
            "internal";

        script.addEventListener(
            "error",
            () => {
                const error =
                    new Error(
                        `Unable to load internal JavaScript wrapper: ${INTERNAL_WRAPPER_URL}`
                    );

                console.error(error);

                document.dispatchEvent(
                    new CustomEvent(
                        "speciedex:error",
                        {
                            detail: {
                                phase:
                                    "entry-point",

                                error
                            }
                        }
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

    loadInternalWrapper();
})();
