/*
========================================================================
Speciedex.org
SpeciedexTerminal Bootstrap
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D

Licensed under the MIT License.

========================================================================
*/
(function (window, document) {
    "use strict";

    const BOOTSTRAP_NAME = "SpeciedexTerminalBootstrap";
    const TERMINAL_SELECTOR = "[data-speciedex-terminal], [data-terminal]";
    const INCLUDE_EVENTS = [
        "speciedex:include-loaded",
        "speciedex:includes-ready",
        "site:include-loaded",
        "site:includes-ready"
    ];

    let started = false;
    let observer = null;
    let initializationQueued = false;

    function emit(name, detail = {}) {
        document.dispatchEvent(new CustomEvent(name, { detail }));
    }

    function getLoader() {
        return window.SpeciedexTerminalLoader || null;
    }

    function getCore() {
        return window.SpeciedexTerminal || null;
    }

    function findTerminals(context = document) {
        const roots = [];

        if (context instanceof Element && context.matches(TERMINAL_SELECTOR)) {
            roots.push(context);
        }

        if (context.querySelectorAll) {
            roots.push(...context.querySelectorAll(TERMINAL_SELECTOR));
        }

        return [...new Set(roots)];
    }

    function setPendingState(context = document) {
        for (const root of findTerminals(context)) {
            if (!root.dataset.terminalReady) {
                root.dataset.terminalState = "loading";
            }

            const status = root.querySelector("[data-terminal-status]");

            if (status && root.dataset.terminalReady !== "true") {
                status.textContent = "Loading";
                status.dataset.state = "loading";
            }
        }
    }

    async function prepareDependencies() {
        const loader = getLoader();

        if (!loader) {
            return {
                state: "core-only",
                loadedModules: []
            };
        }

        return loader.load();
    }

    async function initialize(context = document) {
        const terminals = findTerminals(context);

        if (!terminals.length) {
            return [];
        }

        setPendingState(context);

        try {
            await prepareDependencies();
        } catch (error) {
            console.error("[SpeciedexTerminalBootstrap] Dependency load failed:", error);
            emit("speciedex:terminal-dependency-error", { error });
        }

        const core = getCore();

        if (!core || typeof core.initializeAll !== "function") {
            throw new Error("SpeciedexTerminal core is unavailable.");
        }

        const instances = core.initializeAll(context);

        emit("speciedex:terminals-initialized", {
            context,
            instances
        });

        return instances;
    }

    function queueInitialize(context = document) {
        if (initializationQueued) {
            return;
        }

        initializationQueued = true;

        window.requestAnimationFrame(async () => {
            initializationQueued = false;

            try {
                await initialize(context);
            } catch (error) {
                console.error("[SpeciedexTerminalBootstrap] Initialization failed:", error);
                emit("speciedex:terminal-bootstrap-error", { error });
            }
        });
    }

    function handleIncludeEvent(event) {
        const context =
            event.detail?.element ||
            event.detail?.target ||
            event.target ||
            document;

        queueInitialize(context instanceof Node ? context : document);
    }

    function observeDynamicTerminals() {
        if (observer || !document.documentElement) {
            return;
        }

        observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (!(node instanceof Element)) {
                        continue;
                    }

                    if (
                        node.matches(TERMINAL_SELECTOR) ||
                        node.querySelector(TERMINAL_SELECTOR)
                    ) {
                        queueInitialize(node);
                        return;
                    }
                }
            }
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });
    }

    function bindLifecycleEvents() {
        for (const eventName of INCLUDE_EVENTS) {
            document.addEventListener(eventName, handleIncludeEvent);
        }

        window.addEventListener("online", () => {
            for (const terminal of getCore()?.getInstances?.() || []) {
                terminal.updateFooter();
                terminal.setStatus("Online", "ready");
            }
        });

        window.addEventListener("offline", () => {
            for (const terminal of getCore()?.getInstances?.() || []) {
                terminal.updateFooter();
                terminal.setStatus("Offline", "warning");
            }
        });
    }

    async function start() {
        if (started) {
            return getCore()?.getInstances?.() || [];
        }

        started = true;
        bindLifecycleEvents();
        observeDynamicTerminals();

        try {
            const instances = await initialize(document);
            emit("speciedex:terminal-bootstrap-ready", {
                instances
            });
            return instances;
        } catch (error) {
            started = false;
            throw error;
        }
    }

    function stop() {
        observer?.disconnect();
        observer = null;

        for (const eventName of INCLUDE_EVENTS) {
            document.removeEventListener(eventName, handleIncludeEvent);
        }

        started = false;
    }

    window[BOOTSTRAP_NAME] = Object.freeze({
        start,
        stop,
        initialize,
        queueInitialize,
        findTerminals,
        get started() {
            return started;
        }
    });

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => {
            start().catch((error) => {
                console.error("[SpeciedexTerminalBootstrap] Start failed:", error);
            });
        }, { once: true });
    } else {
        start().catch((error) => {
            console.error("[SpeciedexTerminalBootstrap] Start failed:", error);
        });
    }
})(window, document);
