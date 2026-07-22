/*
========================================================================
Speciedex.org
SpeciedexTerminal Loader
========================================================================

Manifest-driven terminal runtime loader with a complete built-in fallback
manifest.

The loader preserves:

    • manifest.json support
    • dependency ordering
    • optional modules
    • stylesheet loading
    • runtime module registration
    • worker URL registration
    • deterministic fallback loading

Required terminal-splash dependency order:

    terminal-cmatrix.js
    terminal-zmatrix.js
    terminal-wordcloud.js
    terminal-splash.js

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/
(function (window, document) {
    "use strict";

    const GLOBAL_NAME = "SpeciedexTerminalLoader";
    const VERSION = "2.2.0";
    const BASE_PATH = "/static/js/terminal/";
    const MANIFEST_URL = `${BASE_PATH}manifest.json`;

    const WORKERS = Object.freeze({
        filter: `${BASE_PATH}workers/filter-worker.js`,
        index: `${BASE_PATH}workers/index-worker.js`,
        library: `${BASE_PATH}workers/library-worker.js`,
        map: `${BASE_PATH}workers/map-worker.js`,
        provider: `${BASE_PATH}workers/provider-worker.js`,
        search: `${BASE_PATH}workers/search-worker.js`,
        statistics: `${BASE_PATH}workers/statistics-worker.js`,
        timeline: `${BASE_PATH}workers/timeline-worker.js`
    });

    const DEFAULT_MODULES = Object.freeze([
        /*
        ----------------------------------------------------------------------
        Foundation
        ----------------------------------------------------------------------
        */
        { name: "state", path: "terminal-state.js" },
        { name: "storage", path: "terminal-storage.js", dependencies: ["state"] },
        { name: "events", path: "terminal-events.js", dependencies: ["state"] },
        { name: "log", path: "terminal-log.js", dependencies: ["events"] },
        { name: "loading", path: "terminal-loading.js", dependencies: ["events"] },
        { name: "theme", path: "terminal-theme.js", dependencies: ["storage"] },
        { name: "settings", path: "terminal-settings.js", dependencies: ["storage", "events"] },
        { name: "library", path: "terminal-library.js", dependencies: ["storage", "events"] },
        { name: "index", path: "terminal-index.js", dependencies: ["library"] },

        /*
        ----------------------------------------------------------------------
        Interface
        ----------------------------------------------------------------------
        */
        { name: "layout", path: "terminal-layout.js", dependencies: ["state", "settings"] },
        { name: "windows", path: "terminal-windows.js", dependencies: ["layout", "events"] },
        { name: "toolbar", path: "terminal-toolbar.js", dependencies: ["layout"] },
        { name: "statusbar", path: "terminal-statusbar.js", dependencies: ["events"] },
        { name: "notifications", path: "terminal-notifications.js", dependencies: ["events"] },
        { name: "progress", path: "terminal-progress.js", dependencies: ["events"] },
        { name: "console", path: "terminal-console.js", dependencies: ["log", "events"] },
        { name: "keyboard", path: "terminal-keyboard.js", dependencies: ["events"] },
        { name: "contextmenu", path: "terminal-contextmenu.js", dependencies: ["events"] },
        { name: "history", path: "terminal-history.js", dependencies: ["storage", "events"] },
        { name: "bookmarks", path: "terminal-bookmarks.js", dependencies: ["storage", "events"] },
        { name: "recent", path: "terminal-recent.js", dependencies: ["events"] },

        /*
        ----------------------------------------------------------------------
        Renderers
        ----------------------------------------------------------------------
        */
        { name: "table", path: "terminal-table.js", dependencies: ["layout"] },
        { name: "lists", path: "terminal-lists.js", dependencies: ["layout"] },
        { name: "grid", path: "terminal-grid.js", dependencies: ["layout"] },
        { name: "tree", path: "terminal-tree.js", dependencies: ["layout"] },
        { name: "charts", path: "terminal-charts.js", dependencies: ["layout"] },
        { name: "graphs", path: "terminal-graphs.js", dependencies: ["layout"] },
        { name: "map", path: "terminal-map.js", dependencies: ["layout"] },
        { name: "heatmap", path: "terminal-heatmap.js", dependencies: ["layout"] },
        { name: "matrix", path: "terminal-matrix.js", dependencies: ["layout"] },
        { name: "timeline", path: "terminal-timeline.js", dependencies: ["layout"] },

        /*
        ----------------------------------------------------------------------
        Data and commands
        ----------------------------------------------------------------------
        */
        { name: "api", path: "terminal-api.js", dependencies: ["events", "loading"] },
        { name: "router", path: "terminal-router.js", dependencies: ["events"] },
        { name: "search", path: "terminal-search.js", dependencies: ["api", "library", "index"] },
        { name: "scan", path: "terminal-scan.js", dependencies: ["api", "events"] },
        { name: "stream", path: "terminal-stream.js", dependencies: ["api", "events"] },
        { name: "import", path: "terminal-import.js", dependencies: ["library", "events"] },
        { name: "export", path: "terminal-export.js", dependencies: ["library"] },
        { name: "stats", path: "terminal-stats.js", dependencies: ["library"] },
        { name: "tags", path: "terminal-tags.js", dependencies: ["library", "storage"] },
        { name: "provider-health", path: "terminal-provider-health.js", dependencies: ["api"] },
        { name: "provider-manager", path: "terminal-provider-manager.js", dependencies: ["api", "storage"] },

        /*
        ----------------------------------------------------------------------
        Archive
        ----------------------------------------------------------------------
        */
        { name: "checksums", path: "archive/terminal-checksums.js", dependencies: ["api"] },
        { name: "manifests", path: "archive/terminal-manifests.js", dependencies: ["api"] },
        { name: "releases", path: "archive/terminal-releases.js", dependencies: ["api"] },
        { name: "volumes", path: "archive/terminal-volumes.js", dependencies: ["api"] },
        { name: "records-archived", path: "archive/terminal-records-archived.js", dependencies: ["api"] },
        { name: "source-assertions", path: "archive/terminal-source-assertions.js", dependencies: ["api"] },
        { name: "synonyms", path: "archive/terminal-synonyms.js", dependencies: ["api", "search"] },
        { name: "unresolved-conflicts", path: "archive/terminal-unresolved-conflicts.js", dependencies: ["api"] },
        { name: "archive-history", path: "archive/terminal-archive-history.js", dependencies: ["api"] },
        { name: "last-updated", path: "archive/terminal-last-updated.js", dependencies: ["api"] },

        /*
        ----------------------------------------------------------------------
        Providers
        ----------------------------------------------------------------------
        */
        { name: "providers", path: "providers/terminal-providers.js", dependencies: ["api", "search"] },
        { name: "enabled-providers", path: "providers/terminal-enabled-providers.js", dependencies: ["providers"] },
        { name: "eligible-providers", path: "providers/terminal-eligible-providers.js", dependencies: ["providers"] },
        { name: "provider-assertions", path: "providers/terminal-provider-assertions.js", dependencies: ["providers"] },
        { name: "provider-documentation", path: "providers/terminal-provider-documentation.js", dependencies: ["providers"] },
        { name: "provider-errors", path: "providers/terminal-provider-errors.js", dependencies: ["providers"] },
        { name: "provider-latency", path: "providers/terminal-provider-latency.js", dependencies: ["providers"] },
        { name: "provider-overlap", path: "providers/terminal-provider-overlap.js", dependencies: ["providers"] },
        { name: "provider-species", path: "providers/terminal-provider-species.js", dependencies: ["providers", "search"] },
        { name: "provider-statistics", path: "providers/terminal-provider-statistics.js", dependencies: ["providers", "stats"] },

        /*
        ----------------------------------------------------------------------
        Taxonomy
        ----------------------------------------------------------------------
        */
        { name: "ranks", path: "taxa/terminal-ranks.js", dependencies: ["api", "search"] },
        { name: "domains", path: "taxa/terminal-domains.js", dependencies: ["ranks"] },
        { name: "kingdoms", path: "taxa/terminal-kingdoms.js", dependencies: ["ranks"] },
        { name: "phyla", path: "taxa/terminal-phyla.js", dependencies: ["ranks"] },
        { name: "classes", path: "taxa/terminal-classes.js", dependencies: ["ranks"] },
        { name: "orders", path: "taxa/terminal-orders.js", dependencies: ["ranks"] },
        { name: "families", path: "taxa/terminal-families.js", dependencies: ["ranks"] },
        { name: "tribes", path: "taxa/terminal-tribes.js", dependencies: ["ranks"] },
        { name: "genera", path: "taxa/terminal-genera.js", dependencies: ["ranks"] },
        { name: "species", path: "taxa/terminal-species.js", dependencies: ["ranks", "search"] },
        { name: "subspecies", path: "taxa/terminal-subspecies.js", dependencies: ["species"] },
        { name: "varieties", path: "taxa/terminal-varieties.js", dependencies: ["species"] },
        { name: "forms", path: "taxa/terminal-forms.js", dependencies: ["species"] },
        { name: "clades", path: "taxa/terminal-clades.js", dependencies: ["ranks"] },

        /*
        ----------------------------------------------------------------------
        General visualizations
        ----------------------------------------------------------------------
        */
        { name: "constellation", path: "visualization/terminal-constellation.js", dependencies: ["graphs"] },
        { name: "density", path: "visualization/terminal-density.js", dependencies: ["heatmap"] },
        { name: "forcegraph", path: "visualization/terminal-forcegraph.js", dependencies: ["graphs"] },
        { name: "globe", path: "visualization/terminal-globe.js", dependencies: ["map"] },
        { name: "heatmesh", path: "visualization/terminal-heatmesh.js", dependencies: ["heatmap"] },
        { name: "hexmap", path: "visualization/terminal-hexmap.js", dependencies: ["map"] },
        { name: "network", path: "visualization/terminal-network.js", dependencies: ["graphs"] },
        { name: "phylogeny", path: "visualization/terminal-phylogeny.js", dependencies: ["tree"] },
        { name: "provider-matrix", path: "visualization/terminal-provider-matrix.js", dependencies: ["matrix", "providers"] },
        { name: "radial", path: "visualization/terminal-radial.js", dependencies: ["charts"] },
        { name: "range-map", path: "visualization/terminal-range-map.js", dependencies: ["map"] },
        { name: "sankey", path: "visualization/terminal-sankey.js", dependencies: ["graphs"] },
        { name: "streamgraph", path: "visualization/terminal-streamgraph.js", dependencies: ["charts"] },
        { name: "taxonomy-tree", path: "visualization/terminal-taxonomy-tree.js", dependencies: ["tree", "ranks"] },
        { name: "time-slider", path: "visualization/terminal-time-slider.js", dependencies: ["timeline"] },

        /*
        ----------------------------------------------------------------------
        Terminal splash dependency chain.

        Do not alter this dependency order.
        ----------------------------------------------------------------------
        */
        { name: "cmatrix", path: "visualization/terminal-cmatrix.js", dependencies: ["matrix"] },
        { name: "zmatrix", path: "visualization/terminal-zmatrix.js", dependencies: ["cmatrix"] },
        { name: "wordcloud", path: "visualization/terminal-wordcloud.js", dependencies: ["charts"] },
        {
            name: "terminal-splash",
            path: "visualization/terminal-splash.js",
            dependencies: [
                "zmatrix",
                "wordcloud",
                "events",
                "settings"
            ]
        },

        /*
        ----------------------------------------------------------------------
        Help and application wrapper
        ----------------------------------------------------------------------
        */
        { name: "help", path: "terminal-help.js", dependencies: ["terminal-splash"] },
        {
            name: "application",
            path: "speciedex-terminal.js",
            dependencies: [
                "help",
                "console",
                "search",
                "terminal-splash"
            ]
        }
    ]);

    const DEFAULT_MANIFEST = Object.freeze({
        version: 2,
        basePath: BASE_PATH,
        styles: [],
        modules: DEFAULT_MODULES
    });

    const loadedURLs = new Set();
    const pendingURLs = new Map();
    const loadedModules = new Map();
    const failedModules = new Map();

    let state = "idle";
    let manifest = null;
    let loadPromise = null;

    function emit(name, detail = {}) {
        document.dispatchEvent(
            new CustomEvent(name, {
                detail
            })
        );
    }

    function normalizeURL(path, basePath = BASE_PATH) {
        if (!path) {
            throw new Error(
                "Terminal resource path cannot be empty."
            );
        }

        if (
            /^(?:https?:)?\/\//i.test(path) ||
            path.startsWith("/")
        ) {
            return new URL(
                path,
                window.location.origin
            ).href;
        }

        return new URL(
            path,
            new URL(
                basePath,
                window.location.origin
            )
        ).href;
    }

    function cloneDefaultModules() {
        return DEFAULT_MODULES.map(module => ({
            ...module,
            dependencies:
                [...(module.dependencies || [])],
            attributes:
                { ...(module.attributes || {}) }
        }));
    }

    function normalizeManifest(value) {
        const source =
            value &&
            typeof value === "object"
                ? value
                : {};

        const modules =
            Array.isArray(source.modules) &&
            source.modules.length
                ? source.modules
                : cloneDefaultModules();

        return {
            version:
                Number(source.version) || 2,
            basePath:
                source.basePath || BASE_PATH,
            styles:
                Array.isArray(source.styles)
                    ? source.styles
                    : [],
            modules
        };
    }

    async function fetchManifest(url = MANIFEST_URL) {
        try {
            const response =
                await fetch(
                    url,
                    {
                        method: "GET",
                        cache: "no-store",
                        credentials:
                            "same-origin",
                        headers: {
                            Accept:
                                "application/json"
                        }
                    }
                );

            if (!response.ok) {
                if (response.status === 404) {
                    console.warn(
                        "[SpeciedexTerminalLoader] " +
                        "manifest.json was not found; " +
                        "using the complete built-in manifest."
                    );

                    return normalizeManifest(
                        DEFAULT_MANIFEST
                    );
                }

                throw new Error(
                    `Terminal manifest request failed with HTTP ${response.status}.`
                );
            }

            return normalizeManifest(
                await response.json()
            );
        } catch (error) {
            console.warn(
                "[SpeciedexTerminalLoader] " +
                "Unable to load manifest.json; " +
                "using the complete built-in manifest.",
                error
            );

            return normalizeManifest(
                DEFAULT_MANIFEST
            );
        }
    }

    function findScript(url) {
        return Array.from(
            document.scripts
        ).find(
            script =>
                script.src === url
        ) || null;
    }

    function findStyle(url) {
        return Array.from(
            document.querySelectorAll(
                'link[rel="stylesheet"]'
            )
        ).find(
            link =>
                link.href === url
        ) || null;
    }

    function loadScript(url, attributes = {}) {
        const normalized =
            normalizeURL(url);

        if (loadedURLs.has(normalized)) {
            return Promise.resolve(
                normalized
            );
        }

        if (pendingURLs.has(normalized)) {
            return pendingURLs.get(
                normalized
            );
        }

        const promise =
            new Promise(
                (resolve, reject) => {
                    const existing =
                        findScript(
                            normalized
                        );

                    const script =
                        existing ||
                        document.createElement(
                            "script"
                        );

                    function cleanup() {
                        script.removeEventListener(
                            "load",
                            onLoad
                        );

                        script.removeEventListener(
                            "error",
                            onError
                        );

                        pendingURLs.delete(
                            normalized
                        );
                    }

                    function onLoad() {
                        script.dataset.speciedexTerminalLoaded =
                            "true";

                        loadedURLs.add(
                            normalized
                        );

                        cleanup();
                        resolve(normalized);
                    }

                    function onError() {
                        cleanup();

                        reject(
                            new Error(
                                `Unable to load terminal script: ${normalized}`
                            )
                        );
                    }

                    if (
                        existing &&
                        (
                            existing.dataset.speciedexTerminalLoaded ===
                            "true" ||
                            existing.readyState === "complete"
                        )
                    ) {
                        loadedURLs.add(
                            normalized
                        );

                        resolve(
                            normalized
                        );

                        return;
                    }

                    script.src =
                        normalized;

                    script.async =
                        false;

                    script.defer =
                        false;

                    script.dataset.speciedexTerminalResource =
                        "script";

                    for (
                        const [
                            name,
                            value
                        ] of Object.entries(
                            attributes
                        )
                    ) {
                        if (
                            value !== undefined &&
                            value !== null
                        ) {
                            script.setAttribute(
                                name,
                                String(value)
                            );
                        }
                    }

                    script.addEventListener(
                        "load",
                        onLoad,
                        {
                            once: true
                        }
                    );

                    script.addEventListener(
                        "error",
                        onError,
                        {
                            once: true
                        }
                    );

                    if (!existing) {
                        document.head.appendChild(
                            script
                        );
                    }
                }
            );

        pendingURLs.set(
            normalized,
            promise
        );

        return promise;
    }

    function loadStyle(url, attributes = {}) {
        const normalized =
            normalizeURL(url);

        if (loadedURLs.has(normalized)) {
            return Promise.resolve(
                normalized
            );
        }

        if (pendingURLs.has(normalized)) {
            return pendingURLs.get(
                normalized
            );
        }

        const promise =
            new Promise(
                (resolve, reject) => {
                    const existing =
                        findStyle(
                            normalized
                        );

                    if (existing) {
                        loadedURLs.add(
                            normalized
                        );

                        resolve(
                            normalized
                        );

                        return;
                    }

                    const link =
                        document.createElement(
                            "link"
                        );

                    link.rel =
                        "stylesheet";

                    link.href =
                        normalized;

                    link.dataset.speciedexTerminalResource =
                        "style";

                    for (
                        const [
                            name,
                            value
                        ] of Object.entries(
                            attributes
                        )
                    ) {
                        if (
                            value !== undefined &&
                            value !== null
                        ) {
                            link.setAttribute(
                                name,
                                String(value)
                            );
                        }
                    }

                    function cleanup() {
                        link.removeEventListener(
                            "load",
                            onLoad
                        );

                        link.removeEventListener(
                            "error",
                            onError
                        );

                        pendingURLs.delete(
                            normalized
                        );
                    }

                    function onLoad() {
                        loadedURLs.add(
                            normalized
                        );

                        cleanup();
                        resolve(normalized);
                    }

                    function onError() {
                        cleanup();

                        reject(
                            new Error(
                                `Unable to load terminal stylesheet: ${normalized}`
                            )
                        );
                    }

                    link.addEventListener(
                        "load",
                        onLoad,
                        {
                            once: true
                        }
                    );

                    link.addEventListener(
                        "error",
                        onError,
                        {
                            once: true
                        }
                    );

                    document.head.appendChild(
                        link
                    );
                }
            );

        pendingURLs.set(
            normalized,
            promise
        );

        return promise;
    }

    function normalizeModule(entry, index) {
        if (typeof entry === "string") {
            return {
                name:
                    entry
                        .replace(/^.*\//, "")
                        .replace(/\.js$/i, ""),
                path:
                    entry,
                enabled:
                    true,
                optional:
                    false,
                dependencies:
                    [],
                attributes:
                    {}
            };
        }

        if (
            !entry ||
            typeof entry !== "object"
        ) {
            throw new TypeError(
                `Invalid terminal module at index ${index}.`
            );
        }

        const path =
            entry.path ||
            entry.src ||
            entry.url;

        if (!path) {
            throw new Error(
                `Terminal module at index ${index} has no path.`
            );
        }

        return {
            name:
                String(
                    entry.name ||
                    path
                        .replace(/^.*\//, "")
                        .replace(/\.js$/i, "")
                ),
            path,
            enabled:
                entry.enabled !== false,
            optional:
                entry.optional === true,
            dependencies:
                Array.isArray(
                    entry.dependencies
                )
                    ? entry.dependencies.map(
                        String
                    )
                    : [],
            attributes:
                entry.attributes &&
                typeof entry.attributes === "object"
                    ? { ...entry.attributes }
                    : {}
        };
    }

    function orderModules(entries) {
        const modules =
            entries
                .map(normalizeModule)
                .filter(
                    module =>
                        module.enabled
                );

        const byName =
            new Map(
                modules.map(
                    module => [
                        module.name,
                        module
                    ]
                )
            );

        const ordered = [];
        const permanent = new Set();
        const temporary = new Set();

        function visit(module) {
            if (
                permanent.has(
                    module.name
                )
            ) {
                return;
            }

            if (
                temporary.has(
                    module.name
                )
            ) {
                throw new Error(
                    `Circular terminal module dependency involving "${module.name}".`
                );
            }

            temporary.add(
                module.name
            );

            for (
                const dependencyName of
                module.dependencies
            ) {
                const dependency =
                    byName.get(
                        dependencyName
                    );

                if (!dependency) {
                    throw new Error(
                        `Terminal module "${module.name}" requires missing dependency "${dependencyName}".`
                    );
                }

                visit(
                    dependency
                );
            }

            temporary.delete(
                module.name
            );

            permanent.add(
                module.name
            );

            ordered.push(
                module
            );
        }

        for (const module of modules) {
            visit(module);
        }

        return ordered;
    }

    async function loadStyles(entries, basePath) {
        for (const entry of entries) {
            const definition =
                typeof entry === "string"
                    ? {
                        path: entry,
                        optional: false,
                        attributes: {}
                    }
                    : {
                        path:
                            entry.path ||
                            entry.href ||
                            entry.url,
                        optional:
                            entry.optional === true,
                        attributes:
                            entry.attributes || {}
                    };

            try {
                await loadStyle(
                    normalizeURL(
                        definition.path,
                        basePath
                    ),
                    definition.attributes
                );
            } catch (error) {
                if (!definition.optional) {
                    throw error;
                }

                console.warn(
                    "[SpeciedexTerminalLoader] Optional style failed:",
                    error
                );
            }
        }
    }

    async function loadModules(entries, basePath) {
        const ordered =
            orderModules(entries);

        for (const module of ordered) {
            const url =
                normalizeURL(
                    module.path,
                    basePath
                );

            if (
                loadedModules.has(
                    module.name
                )
            ) {
                continue;
            }

            try {
                await loadScript(
                    url,
                    module.attributes
                );

                const record = {
                    name:
                        module.name,
                    path:
                        module.path,
                    url,
                    dependencies:
                        [...module.dependencies]
                };

                loadedModules.set(
                    module.name,
                    record
                );

                failedModules.delete(
                    module.name
                );

                emit(
                    "speciedex:terminal-module-loaded",
                    {
                        module:
                            module.name,
                        path:
                            module.path,
                        url
                    }
                );
            } catch (error) {
                const failure = {
                    name:
                        module.name,
                    path:
                        module.path,
                    url,
                    error
                };

                failedModules.set(
                    module.name,
                    failure
                );

                emit(
                    "speciedex:terminal-module-error",
                    failure
                );

                if (!module.optional) {
                    throw error;
                }

                console.warn(
                    `[SpeciedexTerminalLoader] Optional module "${module.name}" failed:`,
                    error
                );
            }
        }
    }

    async function performLoad(options = {}) {
        state = "loading";

        emit(
            "speciedex:terminal-loader-start",
            {
                options
            }
        );

        manifest =
            normalizeManifest(
                options.manifest ||
                await fetchManifest(
                    options.manifestURL ||
                    MANIFEST_URL
                )
            );

        const basePath =
            options.basePath ||
            manifest.basePath ||
            BASE_PATH;

        const styles =
            options.styles ||
            manifest.styles;

        const modules =
            options.modules ||
            manifest.modules;

        await loadStyles(
            styles,
            basePath
        );

        await loadModules(
            modules,
            basePath
        );

        state =
            "ready";

        const result =
            snapshot();

        emit(
            "speciedex:terminal-loader-ready",
            result
        );

        return result;
    }

    function load(options = {}) {
        if (
            state === "ready" &&
            !options.reload
        ) {
            return Promise.resolve(
                snapshot()
            );
        }

        if (
            loadPromise &&
            !options.reload
        ) {
            return loadPromise;
        }

        if (options.reload) {
            state =
                "idle";

            loadPromise =
                null;

            loadedModules.clear();
            failedModules.clear();

            /*
            ------------------------------------------------------------------
            Script elements remain loaded in the browser. Reload means that
            the manifest and loader state are rebuilt without injecting
            duplicate scripts.
            ------------------------------------------------------------------
            */
        }

        loadPromise =
            performLoad(options)
                .catch(error => {
                    state =
                        "error";

                    emit(
                        "speciedex:terminal-loader-error",
                        {
                            error,
                            failedModules:
                                [
                                    ...failedModules.values()
                                ]
                        }
                    );

                    loadPromise =
                        null;

                    throw error;
                });

        return loadPromise;
    }

    function registerModule(definition) {
        const current =
            manifest ||
            normalizeManifest(
                DEFAULT_MANIFEST
            );

        const normalized =
            normalizeModule(
                definition,
                current.modules.length
            );

        const existingIndex =
            current.modules.findIndex(
                module =>
                    normalizeModule(
                        module,
                        0
                    ).name ===
                    normalized.name
            );

        if (existingIndex >= 0) {
            current.modules[
                existingIndex
            ] = normalized;
        } else {
            current.modules.push(
                normalized
            );
        }

        manifest =
            current;

        emit(
            "speciedex:terminal-module-registered",
            {
                module:
                    normalized
            }
        );

        return normalized;
    }

    function createWorker(name, options = {}) {
        const url =
            WORKERS[name];

        if (!url) {
            throw new Error(
                `Unknown SpeciedexTerminal worker: ${name}`
            );
        }

        return new Worker(
            url,
            {
                name:
                    `speciedex-terminal-${name}`,
                ...options
            }
        );
    }

    function snapshot() {
        return {
            state,
            version:
                VERSION,
            manifest,
            loadedModules:
                [...loadedModules.values()],
            failedModules:
                [...failedModules.values()],
            workers:
                { ...WORKERS }
        };
    }

    window[GLOBAL_NAME] =
        Object.freeze({
            VERSION,
            BASE_PATH,
            MANIFEST_URL,
            DEFAULT_MANIFEST,
            WORKERS,
            load,
            loadScript,
            loadStyle,
            fetchManifest,
            registerModule,
            createWorker,
            normalizeURL,
            orderModules,
            snapshot,

            get state() {
                return state;
            },

            get manifest() {
                return manifest;
            },

            get loadedModules() {
                return [
                    ...loadedModules.values()
                ];
            },

            get failedModules() {
                return [
                    ...failedModules.values()
                ];
            }
        });

    emit(
        "speciedex:terminal-loader-available",
        {
            loader:
                window[GLOBAL_NAME]
        }
    );
})(window, document);
