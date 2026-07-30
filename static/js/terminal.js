/*
========================================================================
Speciedex.org
SpeciedexTerminal Public Facade
========================================================================

Thin public facade for the modular terminal application implemented by:

    /static/js/terminal/speciedex-terminal.js
    window.SpeciedexTerminalApp

The facade prevents native terminal-form navigation before an application
instance exists, but it does not consume events that belong to a mounted
terminal instance.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const GLOBAL_NAME = "SpeciedexTerminal";
    const VERSION = "0.0.0a";
    const RELEASE_CHANNEL = "System Prototype";
    const PRODUCT_LABEL =
        `SpeciedexTerminal ${RELEASE_CHANNEL} ${VERSION}`;

    const DEFAULT_SELECTOR =
        "[data-speciedex-terminal], [data-terminal-root], #speciedex-terminal";
    const FORM_SELECTOR = "[data-terminal-form]";
    const INPUT_SELECTOR = "[data-terminal-input]";
    const COMMAND_CONTROL_SELECTOR =
        "[data-terminal-action], [data-terminal-command], [data-terminal-submit]";

    const INSTALL_SYMBOL =
        Symbol.for("speciedex.terminal.facade.installed");
    const GUARD_SYMBOL =
        Symbol.for("speciedex.terminal.facade.command-guard");
    const FALLBACK_SYMBOL =
        Symbol.for("speciedex.terminal.facade.fallback-command");

    if (
        window[GLOBAL_NAME] &&
        window[GLOBAL_NAME][INSTALL_SYMBOL] === true
    ) {
        document.dispatchEvent(
            new CustomEvent("speciedex:terminal-facade-available", {
                detail: {
                    terminal: window[GLOBAL_NAME],
                    version: window[GLOBAL_NAME].VERSION || null,
                    reused: true
                }
            })
        );
        return;
    }

    const activeEvents = new Set();
    const pendingCommands = new Map();
    const pendingPlugins = [];
    const bootstrapByContext = new WeakMap();

    let applicationPromise = null;
    let commandGuardInstalled = false;

    function isElement(value) {
        return Boolean(
            value &&
            value.nodeType === 1 &&
            typeof value.querySelector === "function"
        );
    }

    function isDocument(value) {
        return Boolean(value && value.nodeType === 9);
    }

    function isDocumentFragment(value) {
        return Boolean(value && value.nodeType === 11);
    }

    function isObject(value) {
        return (
            value !== null &&
            typeof value === "object" &&
            !Array.isArray(value)
        );
    }

    function normalizeContext(context) {
        if (context === undefined || context === null) {
            return document;
        }

        if (
            isDocument(context) ||
            isDocumentFragment(context) ||
            isElement(context)
        ) {
            return context;
        }

        throw new TypeError(
            "SpeciedexTerminal context must be a Document, DocumentFragment, or Element."
        );
    }

    function normalizeCommandName(value) {
        return String(value || "").trim().toLowerCase();
    }

    function emit(name, detail = {}) {
        const eventName = String(name || "").trim();

        if (!eventName || activeEvents.has(eventName)) {
            return false;
        }

        activeEvents.add(eventName);

        try {
            return document.dispatchEvent(
                new CustomEvent(eventName, { detail })
            );
        } catch (error) {
            console.warn(
                `[SpeciedexTerminal] Unable to dispatch "${eventName}":`,
                error
            );
            return false;
        } finally {
            activeEvents.delete(eventName);
        }
    }

    function findTerminalRoot(value) {
        if (!value) {
            return null;
        }

        if (isElement(value) && value.matches(DEFAULT_SELECTOR)) {
            return value;
        }

        const root = value.closest?.(DEFAULT_SELECTOR) || null;
        return isElement(root) ? root : null;
    }

    function collectRoots(context = document) {
        const normalizedContext = normalizeContext(context);
        const candidates = [];

        if (
            isElement(normalizedContext) &&
            normalizedContext.matches(DEFAULT_SELECTOR)
        ) {
            candidates.push(normalizedContext);
        }

        candidates.push(
            ...(normalizedContext.querySelectorAll?.(DEFAULT_SELECTOR) || [])
        );

        const unique = [...new Set(candidates)];

        /*
         * Only discard a candidate when another candidate is an actual
         * terminal ancestor. Repeated selectors matching the same element are
         * already removed by Set.
         */
        return unique.filter(
            root =>
                !unique.some(
                    candidate =>
                        candidate !== root &&
                        candidate.contains(root) &&
                        candidate.matches(DEFAULT_SELECTOR)
                )
        );
    }

    function getInput(root) {
        return root?.querySelector?.(INPUT_SELECTOR) || null;
    }

    function getLoader() {
        return window.SpeciedexTerminalLoader || null;
    }

    function getApplication() {
        return window.SpeciedexTerminalApp || null;
    }

    function getInstance(root) {
        if (!isElement(root)) {
            return null;
        }

        const application = getApplication();

        if (
            application &&
            typeof application.getInstance === "function"
        ) {
            return application.getInstance(root) || null;
        }

        const instances =
            application &&
            typeof application.getInstances === "function"
                ? application.getInstances()
                : [];

        return (
            instances.find(instance => instance?.root === root) ||
            null
        );
    }

    function instanceIsMounted(instance) {
        return Boolean(
            instance &&
            (
                instance.mounted === true ||
                instance.ready === true ||
                instance.state === "ready"
            )
        );
    }

    function hardenRoot(root) {
        if (!isElement(root)) {
            return false;
        }

        for (const form of root.querySelectorAll(FORM_SELECTOR)) {
            form.noValidate = true;
            form.setAttribute("autocomplete", "off");

            /*
             * Never assign form.onsubmit here. The application may use that
             * property, and replacing it is enough to make all commands dead.
             */
            if (!form.getAttribute("action")) {
                form.setAttribute("action", "#");
            }
        }

        for (const control of root.querySelectorAll(COMMAND_CONTROL_SELECTOR)) {
            if (control.tagName === "BUTTON") {
                control.type =
                    control.hasAttribute("data-terminal-submit")
                        ? "submit"
                        : "button";
            }

            if (control.tagName === "A") {
                control.setAttribute("role", "button");

                if (!control.hasAttribute("tabindex")) {
                    control.tabIndex = 0;
                }
            }
        }

        return true;
    }

    async function requireLoader() {
        const loader = getLoader();

        if (!loader || typeof loader.load !== "function") {
            throw new Error(
                "SpeciedexTerminalLoader is unavailable. Load " +
                "/static/js/terminal-loader.js before /static/js/terminal.js."
            );
        }

        return loader;
    }

    function waitForApplication(timeout = 15000) {
        const existing = getApplication();

        if (existing) {
            return Promise.resolve(existing);
        }

        return new Promise((resolve, reject) => {
            let timer = 0;

            const cleanup = () => {
                document.removeEventListener(
                    "speciedex:terminal-application-available",
                    onAvailable
                );
                window.clearTimeout(timer);
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

            timer = window.setTimeout(() => {
                cleanup();
                reject(
                    new Error(
                        "Timed out waiting for SpeciedexTerminalApp."
                    )
                );
            }, timeout);
        });
    }

    async function flushPendingRegistrations(application) {
        for (const definition of pendingCommands.values()) {
            application.registerCommand?.(definition);
        }
        pendingCommands.clear();

        for (const plugin of pendingPlugins.splice(0)) {
            application.use?.(plugin);
        }

        return application;
    }

    function requireApplication() {
        if (applicationPromise) {
            return applicationPromise;
        }

        applicationPromise = (async () => {
            const loader = await requireLoader();
            await loader.load();

            const application =
                getApplication() ||
                await waitForApplication();

            if (
                !application ||
                (
                    typeof application.create !== "function" &&
                    typeof application.mount !== "function" &&
                    typeof application.initialize !== "function"
                )
            ) {
                throw new Error(
                    "SpeciedexTerminalApp is unavailable after module loading."
                );
            }

            await flushPendingRegistrations(application);
            return application;
        })().catch(error => {
            applicationPromise = null;
            throw error;
        });

        return applicationPromise;
    }

    async function create(root, options = {}) {
        if (!isElement(root)) {
            throw new TypeError(
                "SpeciedexTerminal.create() requires a valid root Element."
            );
        }

        hardenRoot(root);

        const application = await requireApplication();
        const existing = getInstance(root);

        if (existing) {
            return existing;
        }

        const factory =
            application.create ||
            application.mount ||
            application.initialize;

        const instance =
            await factory.call(application, root, options);

        emit("speciedex:terminal-facade-created", {
            root,
            instance,
            application,
            productLabel: PRODUCT_LABEL
        });

        return instance;
    }

    function mount(root, options = {}) {
        return create(root, options);
    }

    function initialize(root, options = {}) {
        return create(root, options);
    }

    async function initializeAll(context = document, options = {}) {
        const normalizedContext = normalizeContext(context);
        const roots = collectRoots(normalizedContext);

        for (const root of roots) {
            hardenRoot(root);
        }

        const application = await requireApplication();
        let instances = [];

        if (typeof application.initializeAll === "function") {
            instances =
                await application.initializeAll(
                    normalizedContext,
                    options
                );
        } else {
            for (const root of roots) {
                instances.push(await create(root, options));
            }
        }

        emit("speciedex:terminal-facade-initialized", {
            context: normalizedContext,
            instances,
            application,
            productLabel: PRODUCT_LABEL
        });

        return instances;
    }

    function bootstrap(context = document, options = {}) {
        const normalizedContext = normalizeContext(context);
        const existing = bootstrapByContext.get(normalizedContext);

        if (existing) {
            return existing;
        }

        const promise = (async () => {
            for (const root of collectRoots(normalizedContext)) {
                hardenRoot(root);
            }

            const bootstrapper = window.SpeciedexTerminalBootstrap;

            if (
                bootstrapper &&
                typeof bootstrapper.initialize === "function"
            ) {
                return bootstrapper.initialize(
                    normalizedContext,
                    options
                );
            }

            return initializeAll(normalizedContext, options);
        })().catch(error => {
            bootstrapByContext.delete(normalizedContext);

            emit("speciedex:terminal-facade-error", {
                phase: "bootstrap",
                error
            });

            throw error;
        });

        /*
         * Keep successful bootstrap promises cached. Releasing this promise in
         * finally caused every later caller to initialize the same roots again.
         */
        bootstrapByContext.set(normalizedContext, promise);
        return promise;
    }

    async function executeFromRoot(root, command) {
        const value = String(command || "").trim();

        if (!value) {
            return null;
        }

        hardenRoot(root);

        let instance = getInstance(root);

        if (!instance) {
            instance = await create(root, {});
        }

        if (!instance || typeof instance.execute !== "function") {
            throw new Error(
                "The terminal instance cannot execute commands."
            );
        }

        return instance.execute(value);
    }

    function reportGuardError(phase, root, error) {
        console.error(
            `[SpeciedexTerminal] ${phase} failed:`,
            error
        );

        emit("speciedex:terminal-facade-error", {
            phase,
            root,
            error
        });
    }

    function installCommandGuard() {
        if (
            commandGuardInstalled ||
            document[GUARD_SYMBOL] === true
        ) {
            commandGuardInstalled = true;
            return false;
        }

        commandGuardInstalled = true;
        document[GUARD_SYMBOL] = true;

        /*
         * A mounted application owns its events. The facade only consumes a
         * submit while no mounted instance exists, preventing native
         * navigation during startup without blocking the real command handler.
         */
        document.addEventListener(
            "submit",
            event => {
                const form = event.target?.closest?.(FORM_SELECTOR);
                const root = findTerminalRoot(form);

                if (!form || !root) {
                    return;
                }

                event.preventDefault();
                hardenRoot(root);

                const instance = getInstance(root);

                if (instanceIsMounted(instance)) {
                    return;
                }

                event.stopPropagation();

                if (event[FALLBACK_SYMBOL]) {
                    return;
                }

                event[FALLBACK_SYMBOL] = true;

                const input =
                    form.querySelector(INPUT_SELECTOR) ||
                    getInput(root);

                void executeFromRoot(
                    root,
                    input?.value || ""
                ).catch(error => {
                    reportGuardError(
                        "command-submit",
                        root,
                        error
                    );
                });
            },
            { capture: true }
        );

        /*
         * Do not intercept normal buttons. Toolbar, context-menu, completion,
         * visualization and submit controls must reach the mounted app.
         * Only command anchors need native-navigation suppression.
         */
        document.addEventListener(
            "click",
            event => {
                const control =
                    event.target?.closest?.(COMMAND_CONTROL_SELECTOR);
                const root = findTerminalRoot(control);

                if (!control || !root) {
                    return;
                }

                hardenRoot(root);

                if (control.tagName !== "A") {
                    return;
                }

                const command =
                    String(control.dataset.terminalCommand || "").trim();

                if (!command) {
                    if (control.hasAttribute("href")) {
                        event.preventDefault();
                    }
                    return;
                }

                event.preventDefault();

                const instance = getInstance(root);

                if (instanceIsMounted(instance)) {
                    return;
                }

                event.stopPropagation();

                void executeFromRoot(root, command).catch(error => {
                    reportGuardError(
                        "command-control",
                        root,
                        error
                    );
                });
            },
            { capture: true }
        );

        document.addEventListener(
            "keydown",
            event => {
                if (!["Enter", " "].includes(event.key)) {
                    return;
                }

                const control =
                    event.target?.closest?.("a[data-terminal-command]");

                if (!control || !findTerminalRoot(control)) {
                    return;
                }

                event.preventDefault();
                control.click();
            },
            { capture: true }
        );

        for (const root of collectRoots(document)) {
            hardenRoot(root);
        }

        return true;
    }

    function use(plugin) {
        if (!plugin) {
            throw new TypeError("A terminal plugin is required.");
        }

        const application = getApplication();

        if (
            application &&
            typeof application.use === "function"
        ) {
            return application.use(plugin);
        }

        pendingPlugins.push(plugin);

        void requireApplication().catch(error => {
            console.error(
                "[SpeciedexTerminal] Deferred plugin registration failed:",
                error
            );
        });

        return () => {
            const index = pendingPlugins.indexOf(plugin);

            if (index < 0) {
                return false;
            }

            pendingPlugins.splice(index, 1);
            return true;
        };
    }

    function getInstances() {
        const application = getApplication();

        if (
            !application ||
            typeof application.getInstances !== "function"
        ) {
            return [];
        }

        return application.getInstances();
    }

    function getCommands() {
        const commands = new Map();

        for (const instance of getInstances()) {
            const registry = instance?.commandRegistry;

            if (!registry) {
                continue;
            }

            const definitions =
                typeof registry.list === "function"
                    ? registry.list({ includeHidden: true })
                    : registry.commands instanceof Map
                        ? [...registry.commands.values()]
                        : [];

            for (const definition of definitions) {
                if (definition?.name) {
                    commands.set(definition.name, definition);
                }
            }
        }

        return [...commands.values()];
    }

    function execute(root, command) {
        if (!isElement(root)) {
            throw new TypeError(
                "SpeciedexTerminal.execute() requires a terminal root Element."
            );
        }

        return executeFromRoot(root, command);
    }

    function registerCommand(definition) {
        const application = getApplication();

        if (
            application &&
            typeof application.registerCommand === "function"
        ) {
            return application.registerCommand(definition);
        }

        if (!definition || typeof definition !== "object") {
            throw new TypeError(
                "A command definition object is required."
            );
        }

        const name = normalizeCommandName(definition.name);

        if (!name) {
            throw new Error("A command name is required.");
        }

        pendingCommands.set(name, definition);

        void requireApplication().catch(error => {
            console.error(
                "[SpeciedexTerminal] Deferred command registration failed:",
                error
            );
        });

        return definition;
    }

    function unregisterCommand(name) {
        const normalized = normalizeCommandName(name);
        const application = getApplication();

        if (
            application &&
            typeof application.unregisterCommand === "function"
        ) {
            return application.unregisterCommand(normalized);
        }

        return pendingCommands.delete(normalized);
    }

    function isReady() {
        return getInstances().some(instanceIsMounted);
    }

    function ready() {
        return requireApplication();
    }

    function status() {
        const loader = getLoader();
        const application = getApplication();
        const instances = getInstances();

        return {
            facade: true,
            version: VERSION,
            releaseChannel: RELEASE_CHANNEL,
            productLabel: PRODUCT_LABEL,
            selector: DEFAULT_SELECTOR,
            commandGuard: commandGuardInstalled,

            loader: loader
                ? {
                    available: true,
                    state: loader.state || "unknown",
                    loadedModules:
                        loader.loadedModules?.length || 0,
                    failedModules:
                        loader.failedModules?.length ||
                        loader.failures?.length ||
                        0
                }
                : {
                    available: false
                },

            application: application
                ? {
                    available: true,
                    version: application.VERSION || null,
                    releaseChannel:
                        application.RELEASE_CHANNEL || null,
                    productLabel:
                        application.PRODUCT_LABEL || null
                }
                : {
                    available: false
                },

            instances: instances.length,
            pendingCommands: pendingCommands.size,
            pendingPlugins: pendingPlugins.length,
            commands: getCommands()
                .map(command => command.name)
                .sort()
        };
    }

    function diagnostics() {
        const application = getApplication();

        return {
            ...status(),
            ready: isReady(),
            pendingCommandNames:
                [...pendingCommands.keys()].sort(),
            loaderSnapshot:
                getLoader()?.snapshot?.() || null,
            applicationDiagnostics:
                application?.getInstances?.()
                    ?.map(instance =>
                        instance.diagnostics?.() ||
                        instance.status?.() ||
                        null
                    ) || []
        };
    }

    installCommandGuard();

    const api = Object.freeze({
        [INSTALL_SYMBOL]: true,

        VERSION,
        RELEASE_CHANNEL,
        PRODUCT_LABEL,
        DEFAULT_SELECTOR,
        FORM_SELECTOR,
        INPUT_SELECTOR,
        COMMAND_CONTROL_SELECTOR,

        create,
        mount,
        initialize,
        initializeAll,
        bootstrap,
        execute,
        use,

        getInstances,
        getInstance,
        getCommands,

        registerCommand,
        unregisterCommand,

        hardenRoot,
        installCommandGuard,
        collectRoots,

        status,
        diagnostics,
        ready,
        isReady,

        get loader() {
            return getLoader();
        },

        get app() {
            return getApplication();
        },

        get Application() {
            return getApplication()?.Application || null;
        }
    });

    window[GLOBAL_NAME] = api;

    emit("speciedex:terminal-facade-available", {
        terminal: api,
        version: VERSION,
        releaseChannel: RELEASE_CHANNEL,
        productLabel: PRODUCT_LABEL
    });
})(window, document);
